const GameServer = require('./game/GameServer');
const C = require('./game/constants');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Middleware
app.use(helmet({ frameguard: false, contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// Discord OAuth token exchange
app.post('/api/token', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Missing code' });
    try {
        const params = new URLSearchParams({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: `https://${process.env.CLIENT_ID}.discordsays.com`,
        });
        const r = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        });
        const data = await r.json();
        if (data.error) return res.status(400).json(data);
        res.json({ access_token: data.access_token });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rooms
const rooms = {};
let waitingRoom = null;

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('joinGame', (data) => {
        let roomId;
        if (waitingRoom && rooms[waitingRoom] && rooms[waitingRoom].playerCount() < 2) {
            roomId = waitingRoom;
        } else {
            roomId = 'room_' + Date.now();
            rooms[roomId] = new GameServer(roomId);
            waitingRoom = roomId;
        }
        socket.join(roomId);
        socket.roomId = roomId;
        const room = rooms[roomId];
        const pIndex = room.addPlayer(socket.id, data.name || 'Player');
        socket.emit('joined', { playerId: socket.id, playerIndex: pIndex, constants: C });

        if (room.playerCount() === 2) {
            waitingRoom = null;
            room.start();
            io.to(roomId).emit('gameStart', room.getState());
            startGameLoop(room);
        } else {
            socket.emit('waiting', { message: 'Waiting for opponent...' });
        }
    });

    // Client sends its own position + shoot intent
    socket.on('playerUpdate', (data) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        room.updatePlayerPosition(socket.id, data);
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        const room = rooms[socket.roomId];
        if (room) {
            room.removePlayer(socket.id);
            io.to(room.roomId).emit('opponentLeft');
            if (Object.keys(room.players).length === 0) {
                delete rooms[socket.roomId];
                if (waitingRoom === socket.roomId) waitingRoom = null;
            }
        }
    });
});

function startGameLoop(room) {
    // Server physics at 60fps (bullets only)
    const physicsInterval = setInterval(() => {
        if (!rooms[room.roomId] || Object.keys(room.players).length < 2) {
            clearInterval(physicsInterval);
            clearInterval(sendInterval);
            return;
        }
        room.updateBullets();
    }, 1000 / 60);

    // Network sends at 40fps (positions + opponent bullets)
    const sendInterval = setInterval(() => {
        if (!rooms[room.roomId] || Object.keys(room.players).length < 2) return;
        io.to(room.roomId).emit('gameState', room.getState());
    }, 1000 / 40);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ROUNDS server running on http://localhost:${PORT}`));
