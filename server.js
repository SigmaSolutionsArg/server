const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors()); // Permite peticiones de otros dominios

const server = http.createServer(app);
// Configuramos Socket.io con CORS para que acepte a Vercel
const io = new Server(server, {
    cors: {
        origin: "*", // Cuando subas a Vercel, acá podés poner "https://tu-proyecto.vercel.app"
        methods: ["GET", "POST"]
    }
});

// Nuestro "JSON" en memoria que guarda el estado
const estadoJuego = {
    estadoPartida: 'LOBBY',
    jugadores: {}
};

io.on('connection', (socket) => {
    console.log('Nuevo usuario conectado:', socket.id);

    // 1. Recibir a un nuevo jugador (Login)
    socket.on('nuevo_jugador', (data) => {
        estadoJuego.jugadores[socket.id] = {
            nombre: data.nombre,
            casillero: 0
        };
        // Le avisamos a todos que se actualizó el lobby
        io.emit('actualizar_lobby', estadoJuego.jugadores);
    });

    // 2. Alguien apretó "Comenzar"
    socket.on('iniciar_juego', () => {
        estadoJuego.estadoPartida = 'ESPERANDO';
        // Obligamos a todos los clientes a cambiar de pantalla
        io.emit('ir_a_espera');
    });

    // 3. Se desconecta alguien (cierra la pestaña o pierde internet)
    socket.on('disconnect', () => {
        console.log('Se desconectó:', socket.id);
        delete estadoJuego.jugadores[socket.id];
        io.emit('actualizar_lobby', estadoJuego.jugadores); // Actualizamos la lista
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});