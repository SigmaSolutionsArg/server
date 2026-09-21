const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Servidor activo')); // health check (sirve para UptimeRobot / keep-alive)

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
const MAX_JUGADAS_MOVER = 30;                      // tope de movimientos en fase MOVER del ta-te-ti => empate

const T = {
    TURNO_INACTIVO: 90_000,        // jugador conectado que no tira: se tira solo
    DESCONECTADO_TURNO: 20_000,    // jugador desconectado con el turno: se saltea
    CARTA: 20_000,                 // carta abierta sin cerrar: se cierra sola
    ELEGIR_RIVAL: 25_000,          // reto sin rival elegido: se sortea
    TURNO_MINIJUEGO: 30_000,       // jugada de minijuego (ta-te-ti o 4 en línea): si vence, pierde el que debía mover
    CIERRE_MINIJUEGO: 4_000,       // tiempo que se muestra el resultado
    LOBBY_GRACIA: 60_000,          // desconectado en lobby: se lo saca de la sala
    PARTIDA_ABANDONADA: 10 * 60_000 // nadie conectado en partida: se resetea todo
};

// ==========================================
// MÓDULO 1: GESTOR DE CARTAS
// ==========================================
const CARTAS = {
    caca_manu: {
        titulo: 'Manu te tiró caca',
        descripcion: 'Retrocedés 2 casilleros.',
        efecto: (j) => { j.casillero = Math.max(0, j.casillero - 2); }
    },
    mama_gg: {
        titulo: 'La mamá de GG te bendijo',
        descripcion: 'Avanzás 2 casilleros.',
        efecto: (j) => { j.casillero = Math.min(META, j.casillero + 2); }
    },
    huevo_oro: {
        titulo: 'Te salió el huevo de oro',
        descripcion: 'Avanzás 6 casilleros.',
        efecto: (j) => { j.casillero = Math.min(META, j.casillero + 6); }
    },
    viento_favor: {
        titulo: 'Viento a favor',
        descripcion: 'Avanzás 3 casilleros.',
        efecto: (j) => { j.casillero = Math.min(META, j.casillero + 3); }
    },
    piso_resbaloso: {
        titulo: 'Piso resbaloso',
        descripcion: 'Retrocedés 3 casilleros.',
        efecto: (j) => { j.casillero = Math.max(0, j.casillero - 3); }
    }
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
// MÓDULO 2: MOTOR DE TA-TE-TI
// ==========================================
const MotorTaTeTi = {
    crearInstancia: (idX, idO, nombres) => ({
        tipo: 'tateti',
        jugadores: { X: idX, O: idO },
        nombres,                       // viaja en el snapshot: sirve para reconectar en medio del reto
        turno: 'X',
        fase: 'COLOCAR',
        tablero: Array(9).fill(null),
        fichasPuestas: { X: 0, O: 0 },
        seleccionado: null,
        jugadas: 0,                    // movimientos hechos en fase MOVER
        terminado: false,
        ganador: null,                 // 'X' | 'O' | 'EMPATE'
        mensaje: null
    }),
    verificarGanador: (t) => {
        const lineas = [
            [0, 1, 2], [3, 4, 5], [6, 7, 8],
            [0, 3, 6], [1, 4, 7], [2, 5, 8],
            [0, 4, 8], [2, 4, 6]
        ];
        for (const l of lineas) {
            if (t[l[0]] && t[l[0]] === t[l[1]] && t[l[0]] === t[l[2]]) return t[l[0]];
        }
        return null;
    }
};

// ==========================================
// MÓDULO 3: MOTOR DE 4 EN LÍNEA (CONECTA 4)
// ==========================================
const CONECTA4_FILAS = 6;
const CONECTA4_COLS = 7;

const MotorConecta4 = {
    crearInstancia: (idX, idO, nombres) => ({
        tipo: 'conecta4',
        jugadores: { X: idX, O: idO },
        nombres,
        turno: 'X',
        tablero: Array(CONECTA4_FILAS * CONECTA4_COLS).fill(null), // fila 0 = arriba, fila 5 = abajo
        terminado: false,
        ganador: null,                 // 'X' | 'O' | 'EMPATE'
        mensaje: null
    }),
    // Fila donde cae la ficha en esa columna (la más baja libre), o -1 si la columna está llena
    filaDisponible: (tablero, col) => {
        for (let f = CONECTA4_FILAS - 1; f >= 0; f--) {
            if (tablero[f * CONECTA4_COLS + col] === null) return f;
        }
        return -1;
    },
    tableroLleno: (tablero) => tablero.every(c => c !== null),
    verificarGanador: (t) => {
        const get = (f, c) => (f < 0 || f >= CONECTA4_FILAS || c < 0 || c >= CONECTA4_COLS) ? null : t[f * CONECTA4_COLS + c];
        const direcciones = [[0, 1], [1, 0], [1, 1], [1, -1]]; // horizontal, vertical, 2 diagonales
        for (let f = 0; f < CONECTA4_FILAS; f++) {
            for (let c = 0; c < CONECTA4_COLS; c++) {
                const s = get(f, c);
                if (!s) continue;
                for (const [df, dc] of direcciones) {
                    if (s === get(f + df, c + dc) && s === get(f + df * 2, c + dc * 2) && s === get(f + df * 3, c + dc * 3)) {
                        return s;
                    }
                }
            }
        }
        return null;
    }
};

// ==========================================
// MÓDULO 4: MOTOR DE RAPIDEZ VISUAL
//
// El servidor genera TODA la secuencia de objetos por adelantado y la manda
// una sola vez en el snapshot. Cada cliente la dibuja usando el reloj del
// servidor (mj.inicio), así todos ven lo mismo y una recarga retoma en el
// punto exacto. Los clicks se validan contra esa misma secuencia.
// ==========================================
const RAPIDEZ = {
    META_PUNTOS: 10,
    CUENTA_REGRESIVA: 3200,   // ms de "3, 2, 1, ¡YA!" antes del primer objeto
    DURACION: 60_000,         // si nadie llega a 10, gana el que tenga más
    INTERVALO_MIN: 190,
    INTERVALO_MAX: 430,
    TOLERANCIA: 400           // margen de latencia al validar un click
};

// bueno = suma 1 | malo = resta 1
const TIPOS_BUENOS = [
    { tipo: 'verde', peso: 58, dura: [850, 1450] },
    { tipo: 'verde_multi', peso: 20, dura: [2000, 2800], clicks: 5 },
    { tipo: 'verde_hold', peso: 22, dura: [2000, 2800], hold: 900 }
];
const TIPOS_MALOS = [
    { tipo: 'turquesa', peso: 18, dura: [700, 1250] },  // casi verde
    { tipo: 'lima', peso: 16, dura: [700, 1250] },      // verde amarillento
    { tipo: 'cuadrado', peso: 14, dura: [800, 1400] },  // verde, pero cuadrado
    { tipo: 'rombo', peso: 11, dura: [800, 1400] },     // verde, pero rombo
    { tipo: 'cruz', peso: 11, dura: [900, 1500] },      // verde con una X encima
    { tipo: 'rojo', peso: 12, dura: [800, 1400] },
    { tipo: 'emoji', peso: 18, dura: [800, 1500] }
];
const EMOJIS_TRAMPA = ['🥑', '🐸', '🍀', '🟩', '🥦', '🫒', '🍏', '🐍', '🌲', '🦖', '🧪', '🍐', '🥝'];

const azar = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function elegirPonderado(lista) {
    const total = lista.reduce((s, x) => s + x.peso, 0);
    let r = Math.random() * total;
    for (const x of lista) { if ((r -= x.peso) <= 0) return x; }
    return lista[lista.length - 1];
}

// La dificultad sube: hacia el final aparecen más seguido y duran menos
function generarObjetosRapidez() {
    const objetos = [];
    let t = 0, id = 0;
    while (t < RAPIDEZ.DURACION) {
        const progreso = t / RAPIDEZ.DURACION;
        const escala = 1 - 0.35 * progreso;

        t += Math.round(azar(RAPIDEZ.INTERVALO_MIN, RAPIDEZ.INTERVALO_MAX) * escala);
        const bueno = Math.random() < 0.38;
        const plantilla = elegirPonderado(bueno ? TIPOS_BUENOS : TIPOS_MALOS);

        const o = {
            id: id++,
            tipo: plantilla.tipo,
            bueno,
            x: azar(8, 92),                 // % dentro de la arena
            y: azar(10, 90),
            tam: azar(38, 66),              // px
            aparece: t,
            dura: Math.round(azar(plantilla.dura[0], plantilla.dura[1]) * escala)
        };
        if (plantilla.clicks) o.clicks = plantilla.clicks;
        if (plantilla.hold) o.hold = plantilla.hold;
        if (plantilla.tipo === 'emoji') o.emoji = EMOJIS_TRAMPA[azar(0, EMOJIS_TRAMPA.length - 1)];
        if (Math.random() < 0.3) { o.dx = azar(-22, 22); o.dy = azar(-22, 22); } // se desplaza mientras vive

        objetos.push(o);
    }
    return objetos;
}

const MotorRapidez = {
    crearInstancia: (idX, idO, nombres) => {
        const inicio = Date.now() + RAPIDEZ.CUENTA_REGRESIVA;
        return {
            tipo: 'rapidez',
            jugadores: { X: idX, O: idO },
            nombres,
            inicio,                          // reloj del SERVIDOR
            fin: inicio + RAPIDEZ.DURACION,
            meta: RAPIDEZ.META_PUNTOS,
            objetos: generarObjetosRapidez(),
            puntos: { X: 0, O: 0 },
            tomados: {},                     // idObjeto -> 'X' | 'O'  (ya no lo puede agarrar nadie)
            golpes: {},                      // idObjeto -> { X, O }   (para los de 5 toques)
            errores: {},                     // idObjeto -> { X, O }   (para no penalizar dos veces lo mismo)
            terminado: false,
            ganador: null,
            mensaje: null
        };
    },
    buscar: (mj, id) => mj.objetos.find(o => o.id === id) || null
};

// ==========================================
// ESTADO CENTRAL
//
// estado: ESPERANDO_HOST -> LOBBY -> JUGANDO <-> CARTA_ACTIVA
//                                           <-> MINIJUEGO (reto | minijuegoActivo)
//                                    JUGANDO -> FIN -> LOBBY
//
// TODO lo que el cliente necesita para "arrancar del último punto"
// vive dentro de `partida` (cartaActiva, reto, minijuegoActivo, ultimoDado, ganadorId).
// ==========================================
function estadoInicial() {
    return {
        creada: false,
        hostId: null,
        maxJugadores: 0,
        estado: 'ESPERANDO_HOST',
        jugadores: {},
        ordenTurnos: [],
        turnoActual: null,
        ultimoDado: null,       // { valor, jugadorId }
        cartaActiva: null,      // { jugadorId, carta }
        reto: null,             // { atacanteId, oponentes: [{id,nombre,avatar}], juego: 'tateti'|'conecta4'|'rapidez' }
        minijuegoActivo: null,  // instancia de MotorTaTeTi, MotorConecta4 o MotorRapidez
        ganadorId: null,
        cascadaUsada: false     // permite re-ejecutar UN solo especial en cadena por turno (ver evaluarCasillero)
    };
}

let partida = estadoInicial();
let contadorCartas = 0;            // id incremental: distingue cada carta aunque se repita el mismo tipo
let timer = null;                 // un único watchdog activo a la vez
let timerAbandono = null;
const sockets = new Map();        // jugadorId -> socket.id vigente
const timersLobby = new Map();    // jugadorId -> timeout de expulsión del lobby

const emitirEstado = () => io.emit('sync', partida);

function limpiarTimer() {
    if (timer) { clearTimeout(timer); timer = null; }
}
function armarTimer(ms, fn) {
    limpiarTimer();
    timer = setTimeout(() => { timer = null; fn(); }, ms);
}
function jugadoresConectados() {
    return Object.values(partida.jugadores).filter(j => j.conectado);
}

// Avanza al próximo jugador CONECTADO. Si no hay ninguno, deja el siguiente en orden.
function avanzarTurno() {
    const orden = partida.ordenTurnos;
    if (!orden.length) return;
    const idx = orden.indexOf(partida.turnoActual);
    for (let i = 1; i <= orden.length; i++) {
        const cand = orden[(idx + i) % orden.length];
        if (partida.jugadores[cand] && partida.jugadores[cand].conectado) {
            partida.turnoActual = cand;
            return;
        }
    }
    partida.turnoActual = orden[(idx + 1) % orden.length];
}

function volverAJugar() {
    partida.estado = 'JUGANDO';
    partida.cartaActiva = null;
    partida.reto = null;
    partida.minijuegoActivo = null;
    armarWatchdog();
    emitirEstado();
}

function marcarFin(ganadorId) {
    limpiarTimer();
    partida.estado = 'FIN';
    partida.ganadorId = ganadorId;
    partida.cartaActiva = null;
    partida.reto = null;
    partida.minijuegoActivo = null;
}

function reiniciarTodo() {
    limpiarTimer();
    clearTimeout(timerAbandono);
    timersLobby.forEach(clearTimeout);
    timersLobby.clear();
    partida = estadoInicial();
    emitirEstado();
}

// ==========================================
// WATCHDOG: cada estado que espera a alguien tiene un vencimiento.
// Nada puede quedar esperando para siempre.
// ==========================================
function armarWatchdog() {
    limpiarTimer();
    switch (partida.estado) {
        case 'JUGANDO': {
            const j = partida.jugadores[partida.turnoActual];
            if (!j || !jugadoresConectados().length) return; // nadie conectado: pausa
            if (!j.conectado) {
                armarTimer(T.DESCONECTADO_TURNO, () => {
                    if (partida.estado !== 'JUGANDO') return;
                    avanzarTurno();
                    volverAJugar();
                });
            } else {
                armarTimer(T.TURNO_INACTIVO, () => tirarDado(partida.turnoActual));
            }
            break;
        }
        case 'CARTA_ACTIVA':
            armarTimer(T.CARTA, () => {
                if (partida.cartaActiva) cerrarCarta(partida.cartaActiva.jugadorId);
            });
            break;
        case 'MINIJUEGO': {
            const mj = partida.minijuegoActivo;
            if (partida.reto) {
                armarTimer(T.ELEGIR_RIVAL, retoAutomatico);
            } else if (mj && mj.terminado) {
                armarTimer(T.CIERRE_MINIJUEGO, cerrarMinijuego);
            } else if (mj && mj.tipo === 'rapidez') {
                // no hay turnos: el reloj es el fin de la ronda
                armarTimer(Math.max(1000, mj.fin - Date.now() + 500), cerrarRapidezPorTiempo);
            } else if (mj) {
                armarTimer(T.TURNO_MINIJUEGO, () => {
                    const m = partida.minijuegoActivo;
                    if (m && !m.terminado) finalizarMinijuego(m.turno === 'X' ? 'O' : 'X', 'POR TIEMPO');
                });
            }
            break;
        }
        default:
            break;
    }
}

// ==========================================
// ACCIONES DE JUEGO (todas validan estado + jugador y devuelven boolean)
// ==========================================

// Casilleros especiales dentro de cada decena: reto en el 3 y el 5, carta en el 7 y el 9
// (números de casillero, 1 a 60. Ej: 3, 5, 13, 15... son reto; 7, 9, 17, 19... son carta)
function tipoCasillero(numero) {
    const resto = numero % 10;
    if (resto === 3 || resto === 5) return 'reto';
    if (resto === 7 || resto === 9) return 'carta';
    return null;
}

// Evalúa dónde quedó el jugador después de CUALQUIER movimiento (dado, carta o minijuego)
// y decide qué pasa. Devuelve true si se generó un evento (fin de partida, carta o reto) que
// hay que resolver antes de pasar el turno; false si hay que pasar el turno con normalidad.
// `permitirEspecial` controla si en este punto todavía se puede disparar un casillero especial
// (se usa para la regla de "cadena": solo se permite UNA re-ejecución en cadena por turno).
function evaluarCasillero(jugadorId, permitirEspecial) {
    const jugador = partida.jugadores[jugadorId];

    if (jugador.casillero >= META) {
        marcarFin(jugadorId);
        return true;
    }

    if (!permitirEspecial) return false;

    const tipo = tipoCasillero(jugador.casillero + 1);

    if (tipo === 'carta') {
        partida.estado = 'CARTA_ACTIVA';
        // el id es lo que le permite al cliente distinguir "sigo mostrando esta" de
        // "es una carta nueva encadenada, hay que volver a abrir el modal"
        partida.cartaActiva = { jugadorId, carta: GestorCartas.obtenerCarta(), id: ++contadorCartas };
        return true;
    }

    if (tipo === 'reto') {
        const oponentes = Object.values(partida.jugadores)
            .filter(j => j.id !== jugadorId && j.conectado)
            .map(j => ({ id: j.id, nombre: j.nombre, avatar: j.avatar }));
        if (oponentes.length) {
            partida.estado = 'MINIJUEGO';
            // se sortea qué minijuego toca: ta-te-ti, 4 en línea o rapidez visual
            const JUEGOS = ['tateti', 'conecta4', 'rapidez'];
            partida.reto = { atacanteId: jugadorId, oponentes, juego: JUEGOS[Math.floor(Math.random() * JUEGOS.length)] };
            return true;
        }
        // no hay rival disponible: el reto se saltea, se trata como casillero normal
    }

    return false;
}

function tirarDado(jugadorId) {
    if (partida.estado !== 'JUGANDO' || jugadorId !== partida.turnoActual) return false;

    const dado = Math.floor(Math.random() * 6) + 1;
    const jugador = partida.jugadores[jugadorId];
    jugador.casillero = Math.min(META, jugador.casillero + dado);
    partida.ultimoDado = { valor: dado, jugadorId };

    partida.cascadaUsada = false; // arranca un turno nuevo: se habilita una re-ejecución en cadena

    if (!evaluarCasillero(jugadorId, true)) {
        avanzarTurno();
    }

    armarWatchdog();
    io.emit('resultado_dado', { dado, idTiro: jugadorId, partida });
    return true;
}

function cerrarCarta(jugadorId) {
    const c = partida.cartaActiva;
    if (partida.estado !== 'CARTA_ACTIVA' || !c || c.jugadorId !== jugadorId) return false;

    // el efecto sale de la carta guardada en el servidor, nunca de lo que mande el cliente
    const jugador = partida.jugadores[jugadorId];
    GestorCartas.aplicarEfecto(jugador, c.carta.id);

    // si la carta lo movió a otro casillero especial, se re-ejecuta una sola vez por turno
    const permitirEspecial = !partida.cascadaUsada;
    const generoEvento = evaluarCasillero(jugadorId, permitirEspecial);

    if (partida.estado === 'FIN') {
        emitirEstado();
        return true;
    }
    if (generoEvento) {
        partida.cascadaUsada = true; // se consumió la única re-ejecución en cadena de este turno
        armarWatchdog();
        emitirEstado();
        return true;
    }

    avanzarTurno();
    volverAJugar();
    return true;
}

function iniciarReto(atacanteId, defensorId) {
    const r = partida.reto;
    if (partida.estado !== 'MINIJUEGO' || !r || r.atacanteId !== atacanteId) return false;
    if (!r.oponentes.some(o => o.id === defensorId) || !partida.jugadores[defensorId]) return false;

    const nombres = {
        X: partida.jugadores[atacanteId].nombre,
        O: partida.jugadores[defensorId].nombre
    };

    partida.reto = null;
    partida.minijuegoActivo =
        r.juego === 'conecta4' ? MotorConecta4.crearInstancia(atacanteId, defensorId, nombres) :
        r.juego === 'rapidez' ? MotorRapidez.crearInstancia(atacanteId, defensorId, nombres) :
            MotorTaTeTi.crearInstancia(atacanteId, defensorId, nombres);

    armarWatchdog();
    emitirEstado();
    return true;
}

function retoAutomatico() {
    const r = partida.reto;
    if (partida.estado !== 'MINIJUEGO' || !r) return;
    const vivos = r.oponentes.filter(o => partida.jugadores[o.id] && partida.jugadores[o.id].conectado);
    if (!vivos.length) {
        avanzarTurno();
        return volverAJugar();
    }
    iniciarReto(r.atacanteId, vivos[Math.floor(Math.random() * vivos.length)].id);
}

function accionTateti(jugadorId, idx) {
    const mj = partida.minijuegoActivo;
    if (partida.estado !== 'MINIJUEGO' || !mj || mj.tipo !== 'tateti' || mj.terminado) return false;
    if (!Number.isInteger(idx) || idx < 0 || idx > 8) return false;

    const simbolo = mj.jugadores.X === jugadorId ? 'X' : mj.jugadores.O === jugadorId ? 'O' : null;
    if (!simbolo || simbolo !== mj.turno) return false;

    let cambioTurno = false;
    const otro = simbolo === 'X' ? 'O' : 'X';

    if (mj.fase === 'COLOCAR') {
        if (mj.tablero[idx] !== null) return false;
        mj.tablero[idx] = simbolo;
        mj.fichasPuestas[simbolo]++;
        if (mj.fichasPuestas.X === 3 && mj.fichasPuestas.O === 3) mj.fase = 'MOVER';
        mj.turno = otro;
        cambioTurno = true;
    } else {
        if (mj.tablero[idx] === simbolo) {
            mj.seleccionado = idx;                       // seleccionar / cambiar de ficha
        } else if (mj.seleccionado !== null && mj.tablero[idx] === null) {
            mj.tablero[idx] = simbolo;
            mj.tablero[mj.seleccionado] = null;
            mj.seleccionado = null;
            mj.jugadas++;
            mj.turno = otro;
            cambioTurno = true;
        } else {
            return false;
        }
    }

    const ganador = MotorTaTeTi.verificarGanador(mj.tablero);
    if (ganador) {
        finalizarMinijuego(ganador);
    } else if (mj.jugadas >= MAX_JUGADAS_MOVER) {
        finalizarMinijuego('EMPATE');
    } else {
        if (cambioTurno) armarWatchdog(); // solo se reinicia el reloj cuando cambia el turno
        emitirEstado();
    }
    return true;
}

function accionConecta4(jugadorId, columna) {
    const mj = partida.minijuegoActivo;
    if (partida.estado !== 'MINIJUEGO' || !mj || mj.tipo !== 'conecta4' || mj.terminado) return false;
    if (!Number.isInteger(columna) || columna < 0 || columna >= CONECTA4_COLS) return false;

    const simbolo = mj.jugadores.X === jugadorId ? 'X' : mj.jugadores.O === jugadorId ? 'O' : null;
    if (!simbolo || simbolo !== mj.turno) return false;

    const fila = MotorConecta4.filaDisponible(mj.tablero, columna);
    if (fila === -1) return false; // columna llena: jugada inválida, no cambia nada

    mj.tablero[fila * CONECTA4_COLS + columna] = simbolo;
    mj.turno = simbolo === 'X' ? 'O' : 'X';

    const ganador = MotorConecta4.verificarGanador(mj.tablero);
    if (ganador) {
        finalizarMinijuego(ganador);
    } else if (MotorConecta4.tableroLleno(mj.tablero)) {
        finalizarMinijuego('EMPATE');
    } else {
        armarWatchdog(); // el turno siempre cambia acá, así que siempre se reinicia el reloj
        emitirEstado();
    }
    return true;
}

// No hay turnos: ambos jugadores clickean libremente. Cada click se valida contra
// la secuencia (ya generada) verificando que el objeto esté vivo en ESTE instante.
function accionRapidez(jugadorId, datos) {
    const mj = partida.minijuegoActivo;
    if (partida.estado !== 'MINIJUEGO' || !mj || mj.tipo !== 'rapidez' || mj.terminado) return false;

    const simbolo = mj.jugadores.X === jugadorId ? 'X' : mj.jugadores.O === jugadorId ? 'O' : null;
    if (!simbolo) return false; // los que miran no juegan

    const idObjeto = datos && datos.idObjeto;
    if (!Number.isInteger(idObjeto)) return false;

    const o = MotorRapidez.buscar(mj, idObjeto);
    if (!o || mj.tomados[idObjeto]) return false;

    // el objeto tiene que estar vivo AHORA (con margen por la latencia)
    const t = Date.now() - mj.inicio;
    if (t < -RAPIDEZ.TOLERANCIA) return false;
    if (t < o.aparece - RAPIDEZ.TOLERANCIA || t > o.aparece + o.dura + RAPIDEZ.TOLERANCIA) return false;

    let resultado;

    if (!o.bueno) {
        const err = mj.errores[idObjeto] || (mj.errores[idObjeto] = {});
        if (err[simbolo]) return false;                       // ya pagó por este
        err[simbolo] = true;
        mj.puntos[simbolo] = Math.max(0, mj.puntos[simbolo] - 1);
        resultado = 'fallo';
    } else if (o.hold) {
        if (!datos || datos.accion !== 'hold') return false;  // un toque suelto no alcanza
        mj.tomados[idObjeto] = simbolo;
        mj.puntos[simbolo]++;
        resultado = 'punto';
    } else if (o.clicks) {
        const g = mj.golpes[idObjeto] || (mj.golpes[idObjeto] = { X: 0, O: 0 });
        g[simbolo]++;
        if (g[simbolo] >= o.clicks) {
            mj.tomados[idObjeto] = simbolo;
            mj.puntos[simbolo]++;
            resultado = 'punto';
        } else {
            resultado = 'progreso';
        }
    } else {
        mj.tomados[idObjeto] = simbolo;
        mj.puntos[simbolo]++;
        resultado = 'punto';
    }

    // evento liviano: mandar el snapshot entero en cada click sería carísimo
    io.emit('rapidez_tick', {
        idObjeto, simbolo, resultado,
        golpes: mj.golpes[idObjeto] || null,
        puntos: mj.puntos
    });

    if (mj.puntos[simbolo] >= mj.meta) finalizarMinijuego(simbolo, `${mj.puntos.X}-${mj.puntos.O}`);
    return true;
}

function cerrarRapidezPorTiempo() {
    const mj = partida.minijuegoActivo;
    if (partida.estado !== 'MINIJUEGO' || !mj || mj.tipo !== 'rapidez' || mj.terminado) return;
    const { X, O } = mj.puntos;
    finalizarMinijuego(X === O ? 'EMPATE' : (X > O ? 'X' : 'O'), `SE ACABÓ EL TIEMPO ${X}-${O}`);
}

function finalizarMinijuego(resultado, nota) {
    const mj = partida.minijuegoActivo;
    if (!mj || mj.terminado) return;

    const atacante = partida.jugadores[mj.jugadores.X];
    const sufijo = nota ? ` (${nota})` : '';
    mj.terminado = true;
    mj.ganador = resultado;

    if (resultado === 'X') {
        atacante.casillero = Math.min(META, atacante.casillero + 2);
        mj.mensaje = `¡GANÓ ${mj.nombres.X}! EL ATACANTE AVANZA 2.${sufijo}`;
    } else if (resultado === 'O') {
        atacante.casillero = Math.max(0, atacante.casillero - 2);
        mj.mensaje = `¡GANÓ ${mj.nombres.O}! EL ATACANTE RETROCEDE 2.${sufijo}`;
    } else {
        mj.mensaje = `EMPATE. NADIE SE MUEVE.${sufijo}`;
    }

    armarWatchdog(); // arma el cierre a los 4s
    emitirEstado();
}

function cerrarMinijuego() {
    const mj = partida.minijuegoActivo;
    if (partida.estado !== 'MINIJUEGO' || !mj) return;
    const atacanteId = mj.jugadores.X;

    // se limpia el minijuego actual antes de evaluar, para no pisar un posible nuevo evento
    partida.minijuegoActivo = null;
    partida.reto = null;

    // si el resultado del minijuego lo dejó en otro casillero especial, se re-ejecuta una sola vez por turno
    const permitirEspecial = !partida.cascadaUsada;
    const generoEvento = evaluarCasillero(atacanteId, permitirEspecial);

    if (partida.estado === 'FIN') {
        emitirEstado();
        return;
    }
    if (generoEvento) {
        partida.cascadaUsada = true; // se consumió la única re-ejecución en cadena de este turno
        armarWatchdog();
        emitirEstado();
        return;
    }

    avanzarTurno();
    volverAJugar();
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

function nuevoJugador(perfil, listo) {
    return { id: perfil.id, nombre: perfil.nombre, avatar: perfil.avatar, listo, conectado: true, casillero: 0 };
}

// Asocia socket <-> jugador (alta o reconexión)
function vincular(socket, jugador) {
    socket.jugadorId = jugador.id;
    sockets.set(jugador.id, socket.id);
    jugador.conectado = true;
    clearTimeout(timersLobby.get(jugador.id));
    timersLobby.delete(jugador.id);
    clearTimeout(timerAbandono);
    if (partida.estado === 'JUGANDO' && (jugador.id === partida.turnoActual || !timer)) armarWatchdog();
}

function quitarDelLobby(id) {
    timersLobby.delete(id);
    const j = partida.jugadores[id];
    if (partida.estado !== 'LOBBY' || !j || j.conectado) return;

    delete partida.jugadores[id];
    const restantes = Object.keys(partida.jugadores);
    if (!restantes.length) {
        partida = estadoInicial();
    } else if (partida.hostId === id) {
        partida.hostId = restantes.find(r => partida.jugadores[r].conectado) || restantes[0];
        partida.jugadores[partida.hostId].listo = true;
    }
    emitirEstado();
}

io.on('connection', (socket) => {
    const resync = () => socket.emit('sync', partida);

    socket.on('pedir_estado', (id) => {
        const j = typeof id === 'string' ? partida.jugadores[id] : null;
        if (j) { vincular(socket, j); emitirEstado(); }
        else resync();
    });

    socket.on('crear_partida', (d) => {
        if (partida.creada) return resync();
        const perfil = limpiarPerfil(d);
        if (!perfil) return socket.emit('error_ingreso', 'Nombre o avatar inválido');

        partida.creada = true;
        partida.hostId = perfil.id;
        partida.maxJugadores = [2, 3, 4].includes(d.maxJugadores) ? d.maxJugadores : 4;
        partida.estado = 'LOBBY';
        partida.jugadores[perfil.id] = nuevoJugador(perfil, true);
        vincular(socket, partida.jugadores[perfil.id]);
        emitirEstado();
    });

    socket.on('unirse_partida', (d) => {
        const perfil = limpiarPerfil(d);
        if (!perfil) return socket.emit('error_ingreso', 'Nombre o avatar inválido');
        if (!partida.creada) return resync();

        // Si ya existe, es una reconexión: NO se pisa el jugador (antes se le reseteaba el casillero)
        const existente = partida.jugadores[perfil.id];
        if (existente) { vincular(socket, existente); return emitirEstado(); }

        if (partida.estado !== 'LOBBY') return socket.emit('error_ingreso', 'La partida ya empezó');
        if (Object.keys(partida.jugadores).length >= partida.maxJugadores) return socket.emit('error_ingreso', 'La sala está llena');
        if (Object.values(partida.jugadores).some(j => j.avatar === perfil.avatar)) return socket.emit('error_ingreso', 'Ese avatar ya está elegido');

        partida.jugadores[perfil.id] = nuevoJugador(perfil, false);
        vincular(socket, partida.jugadores[perfil.id]);
        emitirEstado();
    });

    socket.on('estoy_listo', () => {
        const j = partida.jugadores[socket.jugadorId];
        if (!j || partida.estado !== 'LOBBY') return resync();
        j.listo = true;
        emitirEstado();
    });

    socket.on('iniciar_juego', () => {
        if (socket.jugadorId !== partida.hostId || partida.estado !== 'LOBBY') return resync();
        const lista = Object.values(partida.jugadores);
        if (lista.length < 2) return socket.emit('error_accion', 'Tienen que ser al menos 2 jugadores');
        if (!lista.every(j => j.listo && j.conectado)) return socket.emit('error_accion', 'Todos tienen que estar listos y conectados');

        lista.forEach(j => { j.casillero = 0; });
        partida.ordenTurnos = lista.map(j => j.id);
        partida.turnoActual = partida.ordenTurnos[0];
        partida.ultimoDado = null;
        partida.ganadorId = null;
        partida.estado = 'JUGANDO';
        armarWatchdog();
        emitirEstado();
    });

    socket.on('tirar_dado', () => {
        if (!tirarDado(socket.jugadorId)) resync();
    });

    socket.on('cerrar_carta', () => {
        if (!cerrarCarta(socket.jugadorId)) resync();
    });

    socket.on('seleccionar_oponente_reto', (d) => {
        if (!iniciarReto(socket.jugadorId, d && d.defensorId)) resync();
    });

    socket.on('accion_tateti', (d) => {
        if (!accionTateti(socket.jugadorId, d && d.indexBoton)) resync();
    });

    socket.on('accion_conecta4', (d) => {
        if (!accionConecta4(socket.jugadorId, d && d.columna)) resync();
    });

    // no se hace resync si devuelve false: pasa todo el tiempo (clicks a cosas ya muertas
    // o ya tomadas por el rival) y reenviar el snapshot completo en cada fallo sería un
    // desperdicio brutal — el cliente ya se corrige solo con el próximo 'rapidez_tick'/'sync'
    socket.on('accion_rapidez', (d) => { accionRapidez(socket.jugadorId, d); });

    // sincronización de reloj: el cliente mide el RTT y calcula su offset contra el servidor
    socket.on('pedir_tiempo', (cb) => { if (typeof cb === 'function') cb(Date.now()); });

    // Fin de partida: el host vuelve al lobby con todos los jugadores
    socket.on('reiniciar_partida', () => {
        if (socket.jugadorId !== partida.hostId || partida.estado !== 'FIN') return resync();
        Object.values(partida.jugadores).forEach(j => { j.casillero = 0; j.listo = j.id === partida.hostId; });
        partida.estado = 'LOBBY';
        partida.turnoActual = null;
        partida.ordenTurnos = [];
        partida.ultimoDado = null;
        partida.ganadorId = null;
        partida.cascadaUsada = false;
        limpiarTimer();
        emitirEstado();
    });

    socket.on('disconnect', () => {
        const id = socket.jugadorId;
        const j = id && partida.jugadores[id];
        // si el jugador ya se reconectó con otro socket, este cierre no cuenta
        if (!j || sockets.get(id) !== socket.id) return;

        sockets.delete(id);
        j.conectado = false;

        if (partida.estado === 'LOBBY') {
            timersLobby.set(id, setTimeout(() => quitarDelLobby(id), T.LOBBY_GRACIA));
        } else {
            if (partida.estado === 'JUGANDO' && id === partida.turnoActual) armarWatchdog();
            if (!jugadoresConectados().length) {
                clearTimeout(timerAbandono);
                timerAbandono = setTimeout(reiniciarTodo, T.PARTIDA_ABANDONADA);
            }
        }
        emitirEstado();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));