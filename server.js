const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// ==========================================
// MÓDULO 1: GESTOR DE CARTAS
// ==========================================
const GestorCartas = {
    obtenerCarta: () => {
        return {
            id: 'caca_manu',
            titulo: "Manu te tiró caca",
            descripcion: "Retrocedés 2 casilleros."
        };
    },
    aplicarEfecto: (jugador, idCarta) => {
        if (idCarta === 'caca_manu') {
            jugador.casillero = Math.max(0, jugador.casillero - 2); 
        }
    }
};

// ==========================================
// MÓDULO 2: MOTOR DE TA-TE-TI DINÁMICO
// ==========================================
const MotorTaTeTi = {
    crearInstancia: (p1, p2) => {
        return {
            tipo: 'tateti',
            jugadores: { X: p1, O: p2 },
            turno: 'X',
            fase: 'COLOCAR',
            tablero: [null, null, null, null, null, null, null, null, null],
            fichasPuestas: { X: 0, O: 0 },
            seleccionado: null
        };
    },
    verificarGanador: (t) => {
        const lineas = [
            [0, 1, 2], [3, 4, 5], [6, 7, 8], 
            [0, 3, 6], [1, 4, 7], [2, 5, 8], 
            [0, 4, 8], [2, 4, 6]             
        ];
        for (let l of lineas) {
            if (t[l[0]] && t[l[0]] === t[l[1]] && t[l[0]] === t[l[2]]) return t[l[0]];
        }
        return null;
    }
};

// ==========================================
// ESTADO CENTRAL DEL JUEGO
// ==========================================
let partida = {
    creada: false,
    hostId: null,
    maxJugadores: 0,
    estado: 'ESPERANDO_HOST',
    jugadores: {},
    turnoActual: null,
    ordenTurnos: [],
    minijuegoActivo: null
};

function avanzarTurno() {
    let indexActual = partida.ordenTurnos.indexOf(partida.turnoActual);
    let nextIndex = (indexActual + 1) % partida.ordenTurnos.length;
    partida.turnoActual = partida.ordenTurnos[nextIndex];
}

io.on('connection', (socket) => {

    socket.on('pedir_estado', (jugadorId) => {
        if (!partida.creada) return socket.emit('estado_sistema', { tipo: 'CREAR', partida });
        
        if (partida.jugadores[jugadorId]) {
            partida.jugadores[jugadorId].conectado = true;
            socket.jugadorId = jugadorId;
            socket.emit('estado_sistema', { tipo: 'RECONECTAR', partida, miId: jugadorId });
            io.emit('actualizar_lobby', partida);
        } else {
            socket.emit('estado_sistema', { tipo: 'UNIRSE', partida });
        }
    });

    socket.on('crear_partida', (datos) => {
        if (!partida.creada) {
            partida.creada = true;
            partida.hostId = datos.id;
            partida.maxJugadores = datos.maxJugadores;
            partida.estado = 'LOBBY';
            partida.jugadores[datos.id] = { id: datos.id, nombre: datos.nombre, avatar: datos.avatar, listo: true, conectado: true, casillero: 0 };
            socket.jugadorId = datos.id;
            io.emit('estado_sistema', { tipo: 'UNIRSE', partida });
            io.emit('actualizar_lobby', partida);
        }
    });

    socket.on('unirse_partida', (datos) => {
        const cantidadActual = Object.keys(partida.jugadores).length;
        if (cantidadActual >= partida.maxJugadores && !partida.jugadores[datos.id]) return socket.emit('error_ingreso', 'La sala está llena');

        partida.jugadores[datos.id] = { id: datos.id, nombre: datos.nombre, avatar: datos.avatar, listo: false, conectado: true, casillero: 0 };
        socket.jugadorId = datos.id;
        io.emit('actualizar_lobby', partida);
    });

    socket.on('estoy_listo', (jugadorId) => {
        if (partida.jugadores[jugadorId]) {
            partida.jugadores[jugadorId].listo = true;
            io.emit('actualizar_lobby', partida);
        }
    });

    socket.on('iniciar_juego', (jugadorId) => {
        if (jugadorId === partida.hostId) {
            partida.estado = 'JUGANDO';
            partida.ordenTurnos = Object.keys(partida.jugadores);
            partida.turnoActual = partida.ordenTurnos[0]; 
            io.emit('juego_iniciado', partida);
        }
    });

    socket.on('tirar_dado', (jugadorId) => {
        if (partida.estado === 'JUGANDO' && jugadorId === partida.turnoActual) {
            const dado = Math.floor(Math.random() * 6) + 1;
            const jugador = partida.jugadores[jugadorId];
            
            jugador.casillero += dado;
            if (jugador.casillero > 59) jugador.casillero = 59; 

            let numeroCasillero = jugador.casillero + 1; 
            let mod7 = numeroCasillero % 7;
            let consecuencia = null;

            if (mod7 === 0) {
                partida.estado = 'CARTA_ACTIVA'; 
                const carta = GestorCartas.obtenerCarta();
                consecuencia = { tipo: 'CARTA', data: carta, afectado: jugadorId }; 
            } else if (mod7 === 3) {
                partida.estado = 'MINIJUEGO';
                let oponentes = Object.values(partida.jugadores)
                                      .filter(j => j.id !== jugadorId)
                                      .map(j => ({ id: j.id, nombre: j.nombre, avatar: j.avatar }));
                
                consecuencia = { tipo: 'RETO_SELECCION', oponentes: oponentes, afectado: jugadorId };
            } else {
                avanzarTurno();
            }

            io.emit('resultado_dado', { dado: dado, partida: partida, idTiro: jugadorId, consecuencia: consecuencia });
        }
    });

    socket.on('cerrar_carta', ({ jugadorId, idCarta }) => {
        if (partida.estado === 'CARTA_ACTIVA' && partida.turnoActual === jugadorId) {
            GestorCartas.aplicarEfecto(partida.jugadores[jugadorId], idCarta);
            partida.estado = 'JUGANDO';
            avanzarTurno(); 
            io.emit('actualizar_tablero_post_evento', partida);
        }
    });

    socket.on('seleccionar_oponente_reto', ({ atacanteId, defensorId }) => {
        partida.minijuegoActivo = MotorTaTeTi.crearInstancia(atacanteId, defensorId);
        io.emit('iniciar_tateti', {
            estadoTateti: partida.minijuegoActivo,
            nombres: { 
                X: partida.jugadores[atacanteId].nombre, 
                O: partida.jugadores[defensorId].nombre 
            }
        });
    });

    socket.on('accion_tateti', ({ jugadorId, indexBoton }) => {
        let mj = partida.minijuegoActivo;
        if (!mj || partida.estado !== 'MINIJUEGO') return;
        
        let simboloJugador = (mj.jugadores.X === jugadorId) ? 'X' : (mj.jugadores.O === jugadorId) ? 'O' : null;
        if (simboloJugador !== mj.turno) return;

        // Evitar que sigan moviendo si alguien ya ganó
        if (MotorTaTeTi.verificarGanador(mj.tablero)) return;

        if (mj.fase === 'COLOCAR') {
            if (mj.tablero[indexBoton] === null) {
                mj.tablero[indexBoton] = simboloJugador;
                mj.fichasPuestas[simboloJugador]++;
                
                if (mj.fichasPuestas.X === 3 && mj.fichasPuestas.O === 3) mj.fase = 'MOVER';
                mj.turno = (mj.turno === 'X') ? 'O' : 'X';
            }
        } else if (mj.fase === 'MOVER') {
            if (mj.seleccionado === null) {
                if (mj.tablero[indexBoton] === simboloJugador) mj.seleccionado = indexBoton;
            } else {
                if (mj.tablero[indexBoton] === simboloJugador) {
                    mj.seleccionado = indexBoton;
                } 
                else if (mj.tablero[indexBoton] === null) {
                    mj.tablero[indexBoton] = simboloJugador;
                    mj.tablero[mj.seleccionado] = null;
                    mj.seleccionado = null;
                    mj.turno = (mj.turno === 'X') ? 'O' : 'X';
                }
            }
        }

        let ganador = MotorTaTeTi.verificarGanador(mj.tablero);
        let mensajeFinal = null;

        if (ganador) {
            let jugadorAtacante = partida.jugadores[mj.jugadores.X];
            let nombreGanador = partida.jugadores[mj.jugadores[ganador]].nombre;
            
            if (ganador === 'X') {
                jugadorAtacante.casillero = Math.min(59, jugadorAtacante.casillero + 2);
                mensajeFinal = `¡GANÓ ${nombreGanador}! EL ATACANTE AVANZA 2.`;
            } else {
                jugadorAtacante.casillero = Math.max(0, jugadorAtacante.casillero - 2);
                mensajeFinal = `¡GANÓ ${nombreGanador}! EL ATACANTE RETROCEDE 2.`;
            }
        }

        io.emit('actualizar_tateti', { estadoTateti: mj, ganador: ganador, mensaje: mensajeFinal });

        if (ganador) {
            setTimeout(() => {
                partida.estado = 'JUGANDO';
                partida.minijuegoActivo = null;
                avanzarTurno();
                io.emit('actualizar_tablero_post_evento', partida);
                io.emit('fin_minijuego', partida);
            }, 4000); 
        }
    });

    socket.on('disconnect', () => {
        if (socket.jugadorId && partida.jugadores[socket.jugadorId]) {
            partida.jugadores[socket.jugadorId].conectado = false;
            io.emit('actualizar_lobby', partida);
        }
    });
});

server.listen(3000, () => console.log(`Servidor local activo`));