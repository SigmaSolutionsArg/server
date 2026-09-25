const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Servidor activo')); // health check

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingInterval: 10000,
    pingTimeout: 20000
});

// ==========================================
// CONFIG
// ==========================================
const META = 59;                                   // índice del último casillero (número 60)
const AVATARES = ['😎', '👻', '👾', '🤖'];

const T = {
    TURNO_INACTIVO: 90_000,        
    DESCONECTADO_TURNO: 20_000,    
    CARTA: 20_000,                 
    CIERRE_MINIJUEGO: 4_000,       
    LOBBY_GRACIA: 60_000,          
    PARTIDA_ABANDONADA: 10 * 60_000 
};

// ==========================================
// MÓDULO 1: GESTOR DE CARTAS
// ==========================================
const CARTAS = {
    caca_manu: { titulo: 'Manu te tiró caca', descripcion: 'Retrocedés 2 casilleros.', efecto: (j) => { j.casillero = Math.max(0, j.casillero - 2); } },
    mama_gg: { titulo: 'La mamá de GG te bendijo', descripcion: 'Avanzás 2 casilleros.', efecto: (j) => { j.casillero = Math.min(META, j.casillero + 2); } },
    huevo_oro: { titulo: 'Te salió el huevo de oro', descripcion: 'Avanzás 6 casilleros.', efecto: (j) => { j.casillero = Math.min(META, j.casillero + 6); } },
    viento_favor: { titulo: 'Viento a favor', descripcion: 'Avanzás 3 casilleros.', efecto: (j) => { j.casillero = Math.min(META, j.casillero + 3); } },
    piso_resbaloso: { titulo: 'Piso resbaloso', descripcion: 'Retrocedés 3 casilleros.', efecto: (j) => { j.casillero = Math.max(0, j.casillero - 3); } }
};

const GestorCartas = {
    obtenerCarta: () => {
        const ids = Object.keys(CARTAS);
        const id = ids[Math.floor(Math.random() * ids.length)];
        return { id, titulo: CARTAS[id].titulo, descripcion: CARTAS[id].descripcion };
    },
    aplicarEfecto: (jugador, idCarta) => {
        if (CARTAS[idCarta]) CARTAS[idCarta].efecto(jugador);
    }
};

// ==========================================
// ESTADO CENTRAL Y VARIABLES GLOBALES
// ==========================================
function estadoInicial() {
    return {
        creada: false, hostId: null, maxJugadores: 0, estado: 'ESPERANDO_HOST', jugadores: {}, ordenTurnos: [], turnoActual: null,
        ultimoDado: null, cartaActiva: null, minijuegoActivo: null, ganadorId: null, cascadaUsada: false
    };
}

let partida = estadoInicial();
let contadorCartas = 0;            
let timer = null;                 
let timerAbandono = null;
const sockets = new Map();        
const timersLobby = new Map();    

const emitirEstado = () => io.emit('sync', partida);

function limpiarTimer() { if (timer) { clearTimeout(timer); timer = null; } }
function armarTimer(ms, fn) { limpiarTimer(); timer = setTimeout(() => { timer = null; fn(); }, ms); }
function jugadoresConectados() { return Object.values(partida.jugadores).filter(j => j.conectado); }

// ==========================================
// MÓDULO 4: MOTOR DE MEMORIA (SE REQUIERE Y SE INSTANCIA)
// ==========================================
const crearMotorMemoria = require('./memoria-servidor');
const MotorMemoria = crearMotorMemoria({
    io,
    obtenerPartida: () => partida,
    armarWatchdog: armarWatchdog,
    emitirEstado,
    META
});

// ==========================================
// MÓDULO 5: MOTOR DE RAPIDEZ (SE REQUIERE Y SE INSTANCIA)
// ==========================================
const crearMotorRapidez = require('./rapidez-servidor');
const MotorRapidez = crearMotorRapidez({
    io,
    obtenerPartida: () => partida,
    armarWatchdog: armarWatchdog,
    emitirEstado,
    META
});

// ==========================================
// LÓGICA DE TURNOS Y WATCHDOG
// ==========================================
function avanzarTurno() {
    const orden = partida.ordenTurnos;
    if (!orden.length) return;
    const idx = orden.indexOf(partida.turnoActual);
    for (let i = 1; i <= orden.length; i++) {
        const cand = orden[(idx + i) % orden.length];
        if (partida.jugadores[cand] && partida.jugadores[cand].conectado) {
            partida.turnoActual = cand; return;
        }
    }
    partida.turnoActual = orden[(idx + 1) % orden.length];
}

function volverAJugar() {
    partida.estado = 'JUGANDO'; partida.cartaActiva = null; partida.minijuegoActivo = null;
    armarWatchdog(); emitirEstado();
}

function marcarFin(ganadorId) {
    limpiarTimer(); partida.estado = 'FIN'; partida.ganadorId = ganadorId; partida.cartaActiva = null; partida.minijuegoActivo = null;
}

function reiniciarTodo() {
    limpiarTimer(); clearTimeout(timerAbandono); timersLobby.forEach(clearTimeout); timersLobby.clear();
    partida = estadoInicial(); emitirEstado();
}

function armarWatchdog() {
    limpiarTimer();
    switch (partida.estado) {
        case 'JUGANDO': {
            const j = partida.jugadores[partida.turnoActual];
            if (!j || !jugadoresConectados().length) return;
            if (!j.conectado) {
                armarTimer(T.DESCONECTADO_TURNO, () => { if (partida.estado !== 'JUGANDO') return; avanzarTurno(); volverAJugar(); });
            } else {
                armarTimer(T.TURNO_INACTIVO, () => tirarDado(partida.turnoActual));
            }
            break;
        }
        case 'CARTA_ACTIVA': armarTimer(T.CARTA, () => { if (partida.cartaActiva) cerrarCarta(partida.cartaActiva.jugadorId); }); break;
        case 'MINIJUEGO': {
            const mj = partida.minijuegoActivo;
            if (mj && mj.terminado) {
                // IMPORTANTE: este chequeo va ANTES que los de tipo específico.
                // Si no, un minijuego ya terminado vuelve a caer en su propia rama
                // de "en curso" y nunca se llega a cerrarMinijuego(): el modal
                // queda trabado y las posiciones no se actualizan nunca.
                armarTimer(T.CIERRE_MINIJUEGO, cerrarMinijuego);
            } else if (mj && mj.tipo === 'memoria') {
                armarTimer(MotorMemoria.msHastaVencer(), () => MotorMemoria.vencio());
            } else if (mj && mj.tipo === 'rapidez') {
                armarTimer(MotorRapidez.msHastaVencer(), () => MotorRapidez.vencio());
            }
            break;
        }
    }
}

// ==========================================
// ACCIONES DE JUEGO (EVALUACIÓN DE CASILLEROS Y RULETA DE MINIJUEGOS)
// ==========================================
function tipoCasillero(numero) {
    const resto = numero % 10;
    if (resto === 3 || resto === 5) return 'reto';
    if (resto === 7 || resto === 9) return 'carta';
    return null;
}

function evaluarCasillero(jugadorId, permitirEspecial) {
    const jugador = partida.jugadores[jugadorId];
    if (jugador.casillero >= META) { marcarFin(jugadorId); return true; }
    if (!permitirEspecial) return false;

    const tipo = tipoCasillero(jugador.casillero + 1);

    if (tipo === 'carta') {
        partida.estado = 'CARTA_ACTIVA';
        partida.cartaActiva = { jugadorId, carta: GestorCartas.obtenerCarta(), id: ++contadorCartas };
        return true;
    }

    if (tipo === 'reto') {
        // Los dos minijuegos activos los juegan TODOS los conectados a la vez:
        // arrancan directo, sin elegir rival ni esperar a nadie más que a que
        // el propio motor esté listo.
        partida.estado = 'MINIJUEGO';
        partida.minijuegoActivo = Math.random() < 0.5
            ? MotorMemoria.crear(jugadorId)
            : MotorRapidez.crear(jugadorId);
        return true;
    }
    return false;
}

function tirarDado(jugadorId) {
    if (partida.estado !== 'JUGANDO' || jugadorId !== partida.turnoActual) return false;

    const dado = Math.floor(Math.random() * 6) + 1;
    const jugador = partida.jugadores[jugadorId];
    jugador.casillero = Math.min(META, jugador.casillero + dado);
    partida.ultimoDado = { valor: dado, jugadorId };
    partida.cascadaUsada = false; 

    if (!evaluarCasillero(jugadorId, true)) avanzarTurno();

    armarWatchdog();
    io.emit('resultado_dado', { dado, idTiro: jugadorId, partida });
    return true;
}

function cerrarCarta(jugadorId) {
    const c = partida.cartaActiva;
    if (partida.estado !== 'CARTA_ACTIVA' || !c || c.jugadorId !== jugadorId) return false;

    GestorCartas.aplicarEfecto(partida.jugadores[jugadorId], c.carta.id);
    const generoEvento = evaluarCasillero(jugadorId, !partida.cascadaUsada);

    if (partida.estado === 'FIN') { emitirEstado(); return true; }
    if (generoEvento) { partida.cascadaUsada = true; armarWatchdog(); emitirEstado(); return true; }

    avanzarTurno(); volverAJugar(); return true;
}

function cerrarMinijuego() {
    const mj = partida.minijuegoActivo;
    if (partida.estado !== 'MINIJUEGO' || !mj) return;

    const atacanteId = mj.atacanteId;
    partida.minijuegoActivo = null;

    // Memoria y Rapidez pueden mover a varios jugadores a la vez (no solo al
    // atacante que disparó el reto): si alguno llegó justo a la meta con el
    // premio, hay que reconocerlo como ganador aunque no sea el atacante.
    const participantes = mj.jugadores;
    for (const id of participantes) {
        if (id !== atacanteId && partida.jugadores[id] && partida.jugadores[id].casillero >= META) {
            marcarFin(id);
            emitirEstado();
            return;
        }
    }

    const generoEvento = evaluarCasillero(atacanteId, !partida.cascadaUsada);

    if (partida.estado === 'FIN') { emitirEstado(); return; }
    if (generoEvento) { partida.cascadaUsada = true; armarWatchdog(); emitirEstado(); return; }

    avanzarTurno(); volverAJugar();
}

// ==========================================
// CONEXIONES
// ==========================================
function limpiarPerfil(d) {
    if (!d || typeof d.id !== 'string' || d.id.length < 4 || d.id.length > 40) return null;
    const nombre = String(d.nombre || '').replace(/[<>&"']/g, '').trim().slice(0, 16);
    if (!nombre || !AVATARES.includes(d.avatar)) return null;
    return { id: d.id, nombre, avatar: d.avatar };
}

function nuevoJugador(perfil, listo) { return { id: perfil.id, nombre: perfil.nombre, avatar: perfil.avatar, listo, conectado: true, casillero: 0 }; }

function vincular(socket, jugador) {
    socket.jugadorId = jugador.id; sockets.set(jugador.id, socket.id); jugador.conectado = true;
    clearTimeout(timersLobby.get(jugador.id)); timersLobby.delete(jugador.id); clearTimeout(timerAbandono);
    if (partida.estado === 'JUGANDO' && (jugador.id === partida.turnoActual || !timer)) armarWatchdog();
}

function quitarDelLobby(id) {
    timersLobby.delete(id); const j = partida.jugadores[id];
    if (partida.estado !== 'LOBBY' || !j || j.conectado) return;
    delete partida.jugadores[id]; const restantes = Object.keys(partida.jugadores);
    if (!restantes.length) { partida = estadoInicial(); } 
    else if (partida.hostId === id) { partida.hostId = restantes.find(r => partida.jugadores[r].conectado) || restantes[0]; partida.jugadores[partida.hostId].listo = true; }
    emitirEstado();
}

io.on('connection', (socket) => {
    const resync = () => socket.emit('sync', partida);

    socket.on('pedir_estado', (id) => { const j = typeof id === 'string' ? partida.jugadores[id] : null; if (j) { vincular(socket, j); emitirEstado(); } else resync(); });
    socket.on('crear_partida', (d) => { if (partida.creada) return resync(); const perfil = limpiarPerfil(d); if (!perfil) return socket.emit('error_ingreso', 'Invalido'); partida.creada = true; partida.hostId = perfil.id; partida.maxJugadores = [2, 3, 4].includes(d.maxJugadores) ? d.maxJugadores : 4; partida.estado = 'LOBBY'; partida.jugadores[perfil.id] = nuevoJugador(perfil, true); vincular(socket, partida.jugadores[perfil.id]); emitirEstado(); });
    socket.on('unirse_partida', (d) => { const perfil = limpiarPerfil(d); if (!perfil) return socket.emit('error_ingreso', 'Invalido'); if (!partida.creada) return resync(); const existente = partida.jugadores[perfil.id]; if (existente) { vincular(socket, existente); return emitirEstado(); } if (partida.estado !== 'LOBBY') return socket.emit('error_ingreso', 'Ya empezó'); if (Object.keys(partida.jugadores).length >= partida.maxJugadores) return socket.emit('error_ingreso', 'Llena'); if (Object.values(partida.jugadores).some(j => j.avatar === perfil.avatar)) return socket.emit('error_ingreso', 'Avatar en uso'); partida.jugadores[perfil.id] = nuevoJugador(perfil, false); vincular(socket, partida.jugadores[perfil.id]); emitirEstado(); });
    socket.on('estoy_listo', () => { const j = partida.jugadores[socket.jugadorId]; if (!j || partida.estado !== 'LOBBY') return resync(); j.listo = true; emitirEstado(); });
    socket.on('iniciar_juego', () => { if (socket.jugadorId !== partida.hostId || partida.estado !== 'LOBBY') return resync(); const lista = Object.values(partida.jugadores); if (lista.length < 2) return socket.emit('error_accion', 'Mínimo 2'); if (!lista.every(j => j.listo && j.conectado)) return socket.emit('error_accion', 'Todos listos'); lista.forEach(j => { j.casillero = 0; }); partida.ordenTurnos = lista.map(j => j.id); partida.turnoActual = partida.ordenTurnos[0]; partida.ultimoDado = null; partida.ganadorId = null; partida.estado = 'JUGANDO'; armarWatchdog(); emitirEstado(); });
    socket.on('tirar_dado', () => { if (!tirarDado(socket.jugadorId)) resync(); });
    socket.on('cerrar_carta', () => { if (!cerrarCarta(socket.jugadorId)) resync(); });
    socket.on('accion_rapidez', (d) => { MotorRapidez.accion(socket.jugadorId, d); });

    // EVENTOS DE MEMORIA
    socket.on('memoria_listo', () => { MotorMemoria.listo(socket.jugadorId); });
    socket.on('memoria_ronda', (d) => { MotorMemoria.accion(socket.jugadorId, d, (ev, data) => socket.emit(ev, data)); });

    socket.on('pedir_tiempo', (cb) => { if (typeof cb === 'function') cb(Date.now()); });
    socket.on('reiniciar_partida', () => { if (socket.jugadorId !== partida.hostId || partida.estado !== 'FIN') return resync(); Object.values(partida.jugadores).forEach(j => { j.casillero = 0; j.listo = j.id === partida.hostId; }); partida.estado = 'LOBBY'; partida.turnoActual = null; partida.ordenTurnos = []; partida.ultimoDado = null; partida.ganadorId = null; partida.cascadaUsada = false; limpiarTimer(); emitirEstado(); });
    socket.on('disconnect', () => { const id = socket.jugadorId; const j = id && partida.jugadores[id]; if (!j || sockets.get(id) !== socket.id) return; sockets.delete(id); j.conectado = false; if (partida.estado === 'LOBBY') { timersLobby.set(id, setTimeout(() => quitarDelLobby(id), T.LOBBY_GRACIA)); } else { if (partida.estado === 'JUGANDO' && id === partida.turnoActual) armarWatchdog(); if (!jugadoresConectados().length) { clearTimeout(timerAbandono); timerAbandono = setTimeout(reiniciarTodo, T.PARTIDA_ABANDONADA); } } emitirEstado(); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));