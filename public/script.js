import { DiscordSDK } from "@discord/embedded-app-sdk";
import { io } from "socket.io-client";

const CLIENT_ID = '1476881728755994656';
let discordSdk, discordAccessToken = null, playerName = 'Player';

// UI
const lobbyScreen = document.getElementById('lobby');
const gameScreen = document.getElementById('gameScreen');
const playBtn = document.getElementById('playBtn');
const lobbyStatus = document.getElementById('lobbyStatus');
const playerNameEl = document.getElementById('playerName');
const avatarEl = document.getElementById('avatar');
const hudName1 = document.getElementById('hudName1');
const hudName2 = document.getElementById('hudName2');
const hudHp1 = document.getElementById('hudHp1');
const hudHp2 = document.getElementById('hudHp2');
const hudScore1 = document.getElementById('hudScore1');
const hudScore2 = document.getElementById('hudScore2');
const roundText = document.getElementById('roundText');
const gameOverlay = document.getElementById('gameOverlay');
const overlayText = document.getElementById('overlayText');

// State
let socket = null, myId = null, myIndex = 0;
let GC = null; // gameConstants
let serverState = null;
let canvas = null, ctx = null, animFrameId = null;
let inputState = { left: false, right: false, jump: false, shoot: false, mouseX: 400, mouseY: 250 };

// Client-side prediction
let localPlayer = null;   // Our player - locally simulated
let remotePlayer = null;  // Opponent - interpolated
let remotePrev = null;    // Previous server state for opponent
let remoteTarget = null;  // Target server state for opponent
let interpT = 0;          // Interpolation progress (0 to 1)
let localBullets = [];    // Server bullets (we just render these)
let localScores = {};
let localGameState = 'waiting';
let localLoserId = null;

// Physics constants (duplicated from server for client prediction)
const GRAVITY = 0.45;
const MAX_FALL = 12;

// ================== DISCORD ==================
async function initDiscord() {
    try {
        discordSdk = new DiscordSDK(CLIENT_ID);
        await discordSdk.ready();
        const { code } = await discordSdk.commands.authorize({
            client_id: CLIENT_ID, response_type: 'code', state: '', prompt: 'none',
            scope: ['identify', 'rpc.activities.write']
        });
        const res = await fetch('/.proxy/api/token', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        discordAccessToken = d.access_token;
        await discordSdk.commands.authenticate({ access_token: discordAccessToken });
        const u = await (await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${discordAccessToken}` }
        })).json();
        playerName = u.global_name || u.username;
        playerNameEl.textContent = playerName;
        if (u.avatar) avatarEl.style.background = `url(https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png) center/cover`;
    } catch (e) {
        console.warn('Discord skipped:', e.message);
        playerName = 'TestPlayer';
        playerNameEl.textContent = playerName;
    }
    playBtn.disabled = false;
    playBtn.querySelector('span').textContent = 'PLAY';
}

// ================== SOCKET ==================
function connectSocket() {
    const isDiscord = window.location.hostname.includes('discordsays.com');
    const url = isDiscord ? `wss://${window.location.hostname}` : window.location.origin;
    const path = isDiscord ? '/.proxy/socket.io/' : '/socket.io/';
    socket = io(url, { path, transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
        socket.emit('joinGame', { name: playerName });
        lobbyStatus.textContent = 'Connected! Finding opponent...';
    });
    socket.on('joined', (d) => { myId = d.playerId; myIndex = d.playerIndex; GC = d.constants; });
    socket.on('waiting', (d) => { lobbyStatus.textContent = d.message; });
    socket.on('gameStart', (state) => {
        lobbyScreen.classList.remove('active');
        gameScreen.classList.add('active');
        initGame(state);
    });
    socket.on('gameState', onServerState);
    socket.on('opponentLeft', () => {
        showMsg('OPPONENT LEFT');
        setTimeout(() => {
            gameScreen.classList.remove('active');
            lobbyScreen.classList.add('active');
            lobbyStatus.textContent = '';
            playBtn.disabled = false;
            playBtn.querySelector('span').textContent = 'PLAY';
            if (animFrameId) cancelAnimationFrame(animFrameId);
        }, 2000);
    });
}

// ================== SERVER STATE ==================
let lastInputJson = '';

function onServerState(state) {
    serverState = state;
    localScores = state.scores;
    localGameState = state.state;
    localLoserId = state.loserId;

    // Client-side bullet interpolation: store velocity so we can simulate between updates
    const newBullets = state.bullets || [];
    localBullets = newBullets.map(b => {
        return { ...b }; // includes vx, vy from server
    });

    const ids = Object.keys(state.players);
    for (const id of ids) {
        const sp = state.players[id];
        if (id === myId) {
            if (localPlayer) {
                // Respawn snap
                if (localPlayer.hp <= 0 && sp.hp > 0) {
                    localPlayer.x = sp.x;
                    localPlayer.y = sp.y;
                    localPlayer.vx = 0;
                    localPlayer.vy = 0;
                } else {
                    // Gentle reconciliation - keeps both players in sync
                    const dx = sp.x - localPlayer.x;
                    const dy = sp.y - localPlayer.y;
                    if (Math.abs(dx) > 80 || Math.abs(dy) > 80) {
                        // Large desync = snap
                        localPlayer.x = sp.x;
                        localPlayer.y = sp.y;
                    } else if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
                        // Small desync = blend 5%
                        localPlayer.x += dx * 0.05;
                        localPlayer.y += dy * 0.05;
                    }
                }
                localPlayer.hp = sp.hp;
                localPlayer.maxHp = sp.maxHp || 100;
            } else {
                localPlayer = { ...sp };
            }
            localPlayer.name = sp.name;
            localPlayer.playerIndex = sp.playerIndex;
            localPlayer.moveSpeed = sp.moveSpeed;
            localPlayer.jumpForce = sp.jumpForce;
        } else {
            // Opponent: set up interpolation
            remotePrev = remoteTarget ? { ...remoteTarget } : { ...sp };
            remoteTarget = { ...sp };
            interpT = 0;
            if (!remotePlayer) remotePlayer = { ...sp };
        }
    }

    updateHUD();
    handleOverlay();
}

// ================== GAME INIT ==================
function initGame(state) {
    const container = document.getElementById('gameContainer');
    container.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.width = GC.CANVAS_WIDTH;
    canvas.height = GC.CANVAS_HEIGHT;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);
    ctx = canvas.getContext('2d');
    setupInput();
    onServerState(state);
    lastFrameTime = performance.now();
    renderLoop();
}

let lastFrameTime = 0;
const INTERP_SPEED = 1 / 2; // reach target in ~2 client frames per server frame (30fps server, 60fps client)

// ================== GAME LOOP (60fps client) ==================
function renderLoop() {
    const now = performance.now();
    const dt = Math.min((now - lastFrameTime) / 16.67, 2);
    lastFrameTime = now;

    // 1. Client-side prediction (own player)
    if (localPlayer && localGameState === 'playing') {
        predictLocal(dt);
    }

    // 2. Interpolate opponent
    if (remotePlayer && remotePrev && remoteTarget) {
        interpT = Math.min(1, interpT + INTERP_SPEED * dt);
        remotePlayer.x = lerp(remotePrev.x, remoteTarget.x, interpT);
        remotePlayer.y = lerp(remotePrev.y, remoteTarget.y, interpT);
        remotePlayer.hp = remoteTarget.hp;
        remotePlayer.maxHp = remoteTarget.maxHp || 100;
        remotePlayer.facingRight = remoteTarget.facingRight;
        remotePlayer.name = remoteTarget.name;
        remotePlayer.playerIndex = remoteTarget.playerIndex;
    }

    // 3. Simulate bullets client-side (smooth movement between server updates)
    for (const b of localBullets) {
        b.x += (b.vx || 0) * dt;
        b.y += (b.vy || 0) * dt;
    }

    // 4. Render
    render();

    // 5. Send input
    sendInput();

    animFrameId = requestAnimationFrame(renderLoop);
}

function predictLocal(dt) {
    const p = localPlayer;
    // Apply input locally
    p.vx = 0;
    if (inputState.left) p.vx = -(p.moveSpeed || 4.5);
    if (inputState.right) p.vx = (p.moveSpeed || 4.5);

    // Facing
    p.facingRight = inputState.mouseX > p.x + GC.PLAYER_WIDTH / 2;

    // Jump
    if (inputState.jump && p.grounded) {
        p.vy = p.jumpForce || -10;
        p.grounded = false;
    }

    // Gravity
    p.vy = (p.vy || 0) + GRAVITY * dt;
    if (p.vy > MAX_FALL) p.vy = MAX_FALL;

    // Move
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.grounded = false;

    // Platform collision (local)
    for (const plat of GC.PLATFORMS) {
        if (rectCol(p.x, p.y, GC.PLAYER_WIDTH, GC.PLAYER_HEIGHT, plat.x, plat.y, plat.w, plat.h)) {
            const oL = (p.x + GC.PLAYER_WIDTH) - plat.x;
            const oR = (plat.x + plat.w) - p.x;
            const oT = (p.y + GC.PLAYER_HEIGHT) - plat.y;
            const oB = (plat.y + plat.h) - p.y;
            const min = Math.min(oL, oR, oT, oB);
            if (min === oT && p.vy >= 0) { p.y = plat.y - GC.PLAYER_HEIGHT; p.vy = 0; p.grounded = true; }
            else if (min === oB && p.vy < 0) { p.y = plat.y + plat.h; p.vy = 0; }
            else if (min === oL) { p.x = plat.x - GC.PLAYER_WIDTH; }
            else if (min === oR) { p.x = plat.x + plat.w; }
        }
    }
}

function rectCol(x1, y1, w1, h1, x2, y2, w2, h2) {
    return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ================== RENDER ==================
function render() {
    if (!ctx) return;
    const W = GC.CANVAS_WIDTH, H = GC.CANVAS_HEIGHT;

    // BG
    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.02)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // Platforms
    for (const p of GC.PLATFORMS) {
        ctx.fillStyle = 'rgba(30,41,59,0.6)';
        ctx.fillRect(p.x - 1, p.y - 1, p.w + 2, p.h + 2);
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(p.x, p.y, p.w, p.h);
        if (p.h <= 20) { ctx.fillStyle = '#334155'; ctx.fillRect(p.x + 1, p.y, p.w - 2, 2); }
    }

    // Bullets (from server)
    for (const b of localBullets) {
        const owner = serverState?.players?.[b.ownerId];
        const color = owner ? (owner.playerIndex === 0 ? '#38bdf8' : '#f87171') : '#fbbf24';
        ctx.beginPath(); ctx.arc(b.x, b.y, b.radius + 4, 0, Math.PI * 2);
        ctx.fillStyle = color + '40'; ctx.fill();
        ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.beginPath(); ctx.arc(b.x, b.y, b.radius - 1, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
    }

    // Players
    if (localPlayer) drawPlayer(localPlayer);
    if (remotePlayer) drawPlayer(remotePlayer);
}

function drawPlayer(p) {
    const PW = GC.PLAYER_WIDTH, PH = GC.PLAYER_HEIGHT;
    const isP1 = p.playerIndex === 0;
    const main = isP1 ? '#1d4ed8' : '#b91c1c';
    const accent = isP1 ? '#38bdf8' : '#f87171';

    // Glow
    ctx.beginPath(); ctx.arc(p.x + PW / 2, p.y + PH / 2, 26, 0, Math.PI * 2);
    ctx.fillStyle = accent + '18'; ctx.fill();

    // Body
    rr(ctx, p.x, p.y, PW, PH, 4); ctx.fillStyle = main; ctx.fill();
    rr(ctx, p.x + 2, p.y + 2, PW - 4, PH / 2 - 2, 3); ctx.fillStyle = accent + '66'; ctx.fill();

    // Eyes
    const ey = p.y + 12, eo = p.facingRight ? 4 : -4, ex = p.x + PW / 2 + eo;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(ex - 5, ey, 4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + 5, ey, 4, 0, Math.PI * 2); ctx.fill();
    const po = p.facingRight ? 1.5 : -1.5;
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(ex - 5 + po, ey, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + 5 + po, ey, 2, 0, Math.PI * 2); ctx.fill();

    // Gun
    const gx = p.facingRight ? p.x + PW : p.x, gy = p.y + PH / 2 + 2, gd = p.facingRight ? 1 : -1;
    ctx.fillStyle = '#475569'; ctx.fillRect(gx, gy - 3, 14 * gd, 6);
    ctx.fillStyle = '#64748b'; ctx.fillRect(gx + 10 * gd, gy - 4, 5 * gd, 8);

    // HP bar
    const hw = 32, hr = Math.max(0, p.hp / (p.maxHp || 100));
    ctx.fillStyle = '#1e293b'; ctx.fillRect(p.x - 2, p.y - 10, hw, 5);
    ctx.fillStyle = hr > 0.3 ? accent : '#ef4444'; ctx.fillRect(p.x - 2, p.y - 10, hw * hr, 5);

    // Name tag
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name || '', p.x + PW / 2, p.y - 14);
}

function rr(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y); c.closePath();
}

// ================== INPUT ==================
function setupInput() {
    document.addEventListener('keydown', (e) => {
        switch (e.key.toLowerCase()) {
            case 'a': case 'arrowleft': inputState.left = true; break;
            case 'd': case 'arrowright': inputState.right = true; break;
            case 'w': case 'arrowup': case ' ': inputState.jump = true; e.preventDefault(); break;
        }
    });
    document.addEventListener('keyup', (e) => {
        switch (e.key.toLowerCase()) {
            case 'a': case 'arrowleft': inputState.left = false; break;
            case 'd': case 'arrowright': inputState.right = false; break;
            case 'w': case 'arrowup': case ' ': inputState.jump = false; break;
        }
    });
    canvas.addEventListener('mousedown', (e) => { inputState.shoot = true; updMouse(e); });
    canvas.addEventListener('mouseup', () => { inputState.shoot = false; });
    canvas.addEventListener('mousemove', (e) => { updMouse(e); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}
function updMouse(e) {
    const r = canvas.getBoundingClientRect();
    inputState.mouseX = (e.clientX - r.left) * (GC.CANVAS_WIDTH / r.width);
    inputState.mouseY = (e.clientY - r.top) * (GC.CANVAS_HEIGHT / r.height);
}
function sendInput() {
    if (!socket?.connected) return;
    const json = JSON.stringify(inputState);
    if (json !== lastInputJson) {
        lastInputJson = json;
        socket.emit('input', inputState);
    }
}

// ================== HUD ==================
function updateHUD() {
    if (!serverState) return;
    const ids = Object.keys(serverState.players);
    if (ids.length < 2) return;
    const sorted = ids.sort((a, b) => serverState.players[a].playerIndex - serverState.players[b].playerIndex);
    const p1 = serverState.players[sorted[0]], p2 = serverState.players[sorted[1]];
    hudName1.textContent = p1.name; hudName2.textContent = p2.name;
    hudHp1.style.width = `${Math.max(0, (p1.hp / (p1.maxHp || 100)) * 100)}%`;
    hudHp2.style.width = `${Math.max(0, (p2.hp / (p2.maxHp || 100)) * 100)}%`;
    hudScore1.textContent = localScores[sorted[0]] || 0;
    hudScore2.textContent = localScores[sorted[1]] || 0;
    roundText.textContent = `ROUND ${(localScores[sorted[0]] || 0) + (localScores[sorted[1]] || 0) + 1}`;
}
function handleOverlay() {
    if (localGameState === 'roundEnd') {
        const wId = Object.keys(serverState.players).find(id => id !== localLoserId);
        showMsg(`${serverState.players[wId]?.name || 'Player'} WINS THE ROUND!`);
    } else if (localGameState === 'gameOver') {
        const ids = Object.keys(localScores);
        let wId = ids[0]; for (const id of ids) { if ((localScores[id] || 0) > (localScores[wId] || 0)) wId = id; }
        showMsg(`🏆 ${serverState.players[wId]?.name || 'Player'} WINS! 🏆`);
    } else if (localGameState === 'playing') { gameOverlay.classList.add('hidden'); }
}
function showMsg(m) { overlayText.textContent = m; gameOverlay.classList.remove('hidden'); }

// ================== START ==================
playBtn.addEventListener('click', () => {
    playBtn.disabled = true;
    playBtn.querySelector('span').textContent = 'SEARCHING...';
    connectSocket();
});
initDiscord();
