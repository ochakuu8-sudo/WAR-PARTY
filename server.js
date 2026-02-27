require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');
const GameRoom = require('./game/GameServer');
const C = require('./game/constants');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https://cdn.discordapp.com"],
            connectSrc: ["'self'", "wss:", "ws:", "https://discord.com", "https://*.discordsays.com"],
            frameAncestors: ["'self'", "https://discord.com", "https://*.discordsays.com"],
        },
    },
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// --- OAuth2 Token Exchange (for Discord SDK) ---
app.post('/api/token', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code provided' });

    try {
        const response = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: `https://${process.env.CLIENT_ID}.discordsays.com/.proxy/api/token`,
            }),
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error_description || data.error);
        res.json({ access_token: data.access_token });
    } catch (error) {
        console.error('Token exchange error:', error);
        res.status(500).json({ error: 'Failed to fetch token' });
    }
});

// --- Game Rooms ---
const rooms = {};
let waitingRoom = null;

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('joinGame', (data) => {
        const playerName = data.name || 'Player';

        // Find or create a room
        let room;
        if (waitingRoom && Object.keys(rooms[waitingRoom]?.players || {}).length < 2) {
            room = rooms[waitingRoom];
        } else {
            const roomId = `room_${Date.now()}`;
            room = new GameRoom(roomId);
            rooms[roomId] = room;
            waitingRoom = roomId;
        }

        socket.roomId = room.roomId;
        socket.join(room.roomId);
        const player = room.addPlayer(socket.id, playerName);

        socket.emit('joined', {
            playerId: socket.id,
            playerIndex: player.playerIndex,
            constants: {
                CANVAS_WIDTH: C.CANVAS_WIDTH,
                CANVAS_HEIGHT: C.CANVAS_HEIGHT,
                PLAYER_WIDTH: C.PLAYER_WIDTH,
                PLAYER_HEIGHT: C.PLAYER_HEIGHT,
                PLATFORMS: C.PLATFORMS,
            }
        });

        if (room.state === 'playing') {
            waitingRoom = null;
            io.to(room.roomId).emit('gameStart', room.getState());
            startGameLoop(room);
        } else {
            socket.emit('waiting', { message: 'Waiting for opponent...' });
        }
    });

    socket.on('input', (input) => {
        const room = rooms[socket.roomId];
        if (room) room.handleInput(socket.id, input);
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
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
    // Physics runs at 60fps for accuracy (matches client prediction)
    const physicsInterval = setInterval(() => {
        if (!rooms[room.roomId] || Object.keys(room.players).length < 2) {
            clearInterval(physicsInterval);
            clearInterval(sendInterval);
            return;
        }
        room.update();
    }, 1000 / 60);

    // Network sends at 20fps to save bandwidth
    const sendInterval = setInterval(() => {
        if (!rooms[room.roomId] || Object.keys(room.players).length < 2) {
            return;
        }
        io.to(room.roomId).emit('gameState', room.getState());
    }, 1000 / C.TICK_RATE);
}

// Start
server.listen(PORT, () => {
    console.log(`ROUNDS server running on http://localhost:${PORT}`);
});
