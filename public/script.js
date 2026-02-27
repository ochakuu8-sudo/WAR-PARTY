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
const roundTextEl = document.getElementById('roundText');
const gameOverlay = document.getElementById('gameOverlay');
const overlayText = document.getElementById('overlayText');

// State
let socket = null, myId = null;
let GC = null;
let canvas = null, ctx = null, animFrameId = null;
let input = { left: false, right: false, jump: false, shoot: false, mouseX: 400, mouseY: 250 };

// Local player (fully client-controlled)
let me = null;
// Remote player (buffered entity interpolation - Source Engine style)
let remotePlayer = null;
let remoteBuffer = []; // [{t, x, y, hp, maxHp, facingRight, name, playerIndex}, ...]
const RENDER_DELAY = 66; // ms - render remote player 66ms in the past for smoothness
// Server data
let serverBullets = [];
let scores = {};
let gamePhase = 'waiting';
let loserId = null;
let allPlayers = {};

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
        lobbyStatus.textContent = 'Finding opponent...';
    });
    socket.on('joined', (d) => { myId = d.playerId; GC = d.constants; });
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
            playBtn.disabled = false;
            playBtn.querySelector('span').textContent = 'PLAY';
            if (animFrameId) cancelAnimationFrame(animFrameId);
        }, 2000);
    });
}

// ================== SERVER STATE (just relay) ==================
function onServerState(state) {
    allPlayers = state.players;
    scores = state.scores;
    gamePhase = state.state;
    loserId = state.loserId;
    serverBullets = state.bullets || [];

    // Update my HP from server (damage is server-authoritative)
    if (me && allPlayers[myId]) {
        const sp = allPlayers[myId];
        if (me.hp <= 0 && sp.hp > 0) {
            me.x = sp.x; me.y = sp.y; me.vx = 0; me.vy = 0;
        }
        me.hp = sp.hp;
        me.maxHp = sp.maxHp || 100;
    }

    // Buffer remote player snapshots (timestamped)
    for (const id in state.players) {
        if (id === myId) continue;
        const sp = state.players[id];
        remoteBuffer.push({
            t: performance.now(),
            x: sp.x, y: sp.y,
            hp: sp.hp, maxHp: sp.maxHp || 100,
            facingRight: sp.facingRight,
            name: sp.name, playerIndex: sp.playerIndex,
        });
        // Keep only last 1 second of data
        const cutoff = performance.now() - 1000;
        while (remoteBuffer.length > 2 && remoteBuffer[0].t < cutoff) remoteBuffer.shift();
        if (!remotePlayer) remotePlayer = { ...sp };
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

    // Initialize my player from server state
    const myData = state.players[myId];
    me = { ...myData };
    me.grounded = false;
    me.lastShot = 0;

    setupInput();
    onServerState(state);
    lastFrame = performance.now();
    lastSendTime = 0;
    loop();
}

let lastFrame = 0;
let lastSendTime = 0;
const SEND_INTERVAL = 1000 / 20; // Send position at 20fps (every 50ms)
let localBullets = []; // Client-predicted bullets for instant feedback
let localBulletId = 0;

// ================== GAME LOOP ==================
function loop() {
    const now = performance.now();
    const dt = Math.min((now - lastFrame) / 16.67, 2);
    lastFrame = now;

    // 1. My physics (fully local - zero lag)
    if (me && gamePhase === 'playing') {
        runPhysics(dt);

        // Client-side bullet creation (instant feedback)
        if (input.shoot && now - me.lastShot >= GC.FIRE_RATE) {
            me.lastShot = now;
            const cx = me.x + GC.PLAYER_WIDTH / 2;
            const cy = me.y + GC.PLAYER_HEIGHT / 2;
            const ddx = input.mouseX - cx;
            const ddy = input.mouseY - cy;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
            localBullets.push({
                id: 'local_' + (localBulletId++),
                x: cx, y: cy,
                vx: (ddx / dist) * GC.BULLET_SPEED,
                vy: (ddy / dist) * GC.BULLET_SPEED,
                radius: GC.BULLET_RADIUS,
                ownerId: myId,
                life: 120,
            });
        }

        // Throttled position send (20fps)
        if (now - lastSendTime >= SEND_INTERVAL) {
            lastSendTime = now;
            socket.emit('playerUpdate', {
                x: me.x, y: me.y,
                vx: me.vx, vy: me.vy,
                facingRight: me.facingRight,
                shoot: input.shoot,
                mouseX: input.mouseX,
                mouseY: input.mouseY,
            });
        }
    }

    // 2. Simulate local bullets
    for (let i = localBullets.length - 1; i >= 0; i--) {
        const b = localBullets[i];
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life--;
        if (b.x < -20 || b.x > GC.CANVAS_WIDTH + 20 || b.y < -20 || b.y > GC.CANVAS_HEIGHT + 20 || b.life <= 0) {
            localBullets.splice(i, 1);
        }
    }

    // 3. Buffered entity interpolation (Source Engine style)
    if (remotePlayer && remoteBuffer.length >= 2) {
        const renderTime = performance.now() - RENDER_DELAY;
        // Find the two snapshots surrounding renderTime
        let from = remoteBuffer[0], to = remoteBuffer[1];
        for (let i = 0; i < remoteBuffer.length - 1; i++) {
            if (remoteBuffer[i].t <= renderTime && remoteBuffer[i + 1].t >= renderTime) {
                from = remoteBuffer[i];
                to = remoteBuffer[i + 1];
                break;
            }
        }
        // If renderTime is past all snapshots, use the latest
        if (renderTime > remoteBuffer[remoteBuffer.length - 1].t) {
            from = remoteBuffer[remoteBuffer.length - 2] || remoteBuffer[0];
            to = remoteBuffer[remoteBuffer.length - 1];
        }
        const range = to.t - from.t;
        const t = range > 0 ? Math.max(0, Math.min(1, (renderTime - from.t) / range)) : 1;
        remotePlayer.x = lerp(from.x, to.x, t);
        remotePlayer.y = lerp(from.y, to.y, t);
        remotePlayer.hp = to.hp;
        remotePlayer.maxHp = to.maxHp;
        remotePlayer.facingRight = to.facingRight;
        remotePlayer.name = to.name;
        remotePlayer.playerIndex = to.playerIndex;
    }

    // 3. Render
    render();

    animFrameId = requestAnimationFrame(loop);
}

function runPhysics(dt) {
    me.vx = 0;
    if (input.left) me.vx = -(me.moveSpeed || GC.PLAYER_SPEED);
    if (input.right) me.vx = (me.moveSpeed || GC.PLAYER_SPEED);
    me.facingRight = input.mouseX > me.x + GC.PLAYER_WIDTH / 2;

    if (input.jump && me.grounded) {
        me.vy = me.jumpForce || GC.JUMP_FORCE;
        me.grounded = false;
    }

    me.vy = (me.vy || 0) + GRAVITY * dt;
    if (me.vy > MAX_FALL) me.vy = MAX_FALL;

    me.x += me.vx * dt;
    me.y += me.vy * dt;
    me.grounded = false;

    for (const plat of GC.PLATFORMS) {
        if (rectCol(me.x, me.y, GC.PLAYER_WIDTH, GC.PLAYER_HEIGHT, plat.x, plat.y, plat.w, plat.h)) {
            const oL = (me.x + GC.PLAYER_WIDTH) - plat.x;
            const oR = (plat.x + plat.w) - me.x;
            const oT = (me.y + GC.PLAYER_HEIGHT) - plat.y;
            const oB = (plat.y + plat.h) - me.y;
            const min = Math.min(oL, oR, oT, oB);
            if (min === oT && me.vy >= 0) { me.y = plat.y - GC.PLAYER_HEIGHT; me.vy = 0; me.grounded = true; }
            else if (min === oB && me.vy < 0) { me.y = plat.y + plat.h; me.vy = 0; }
            else if (min === oL) { me.x = plat.x - GC.PLAYER_WIDTH; }
            else if (min === oR) { me.x = plat.x + plat.w; }
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

    // Bullets: show local bullets (own, instant) + server bullets (opponent's)
    // Filter server bullets to only show opponent's (avoid duplicate own bullets)
    const opponentBullets = serverBullets.filter(b => b.ownerId !== myId);
    const allBullets = [...localBullets, ...opponentBullets];
    for (const b of allBullets) {
        const owner = allPlayers[b.ownerId];
        const color = owner ? (owner.playerIndex === 0 ? '#38bdf8' : '#f87171') : '#fbbf24';
        ctx.beginPath(); ctx.arc(b.x, b.y, b.radius + 4, 0, Math.PI * 2);
        ctx.fillStyle = color + '40'; ctx.fill();
        ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.beginPath(); ctx.arc(b.x, b.y, b.radius - 1, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
    }

    // Players
    if (me) drawPlayer(me);
    if (remotePlayer) drawPlayer(remotePlayer);
}

function drawPlayer(p) {
    const PW = GC.PLAYER_WIDTH, PH = GC.PLAYER_HEIGHT;
    const isP1 = p.playerIndex === 0;
    const main = isP1 ? '#1d4ed8' : '#b91c1c';
    const accent = isP1 ? '#38bdf8' : '#f87171';

    ctx.beginPath(); ctx.arc(p.x + PW / 2, p.y + PH / 2, 26, 0, Math.PI * 2);
    ctx.fillStyle = accent + '18'; ctx.fill();

    rr(ctx, p.x, p.y, PW, PH, 4); ctx.fillStyle = main; ctx.fill();
    rr(ctx, p.x + 2, p.y + 2, PW - 4, PH / 2 - 2, 3); ctx.fillStyle = accent + '66'; ctx.fill();

    const ey = p.y + 12, eo = p.facingRight ? 4 : -4, ex = p.x + PW / 2 + eo;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(ex - 5, ey, 4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + 5, ey, 4, 0, Math.PI * 2); ctx.fill();
    const po = p.facingRight ? 1.5 : -1.5;
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(ex - 5 + po, ey, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + 5 + po, ey, 2, 0, Math.PI * 2); ctx.fill();

    const gx = p.facingRight ? p.x + PW : p.x, gy = p.y + PH / 2 + 2, gd = p.facingRight ? 1 : -1;
    ctx.fillStyle = '#475569'; ctx.fillRect(gx, gy - 3, 14 * gd, 6);
    ctx.fillStyle = '#64748b'; ctx.fillRect(gx + 10 * gd, gy - 4, 5 * gd, 8);

    const hw = 32, hr = Math.max(0, p.hp / (p.maxHp || 100));
    ctx.fillStyle = '#1e293b'; ctx.fillRect(p.x - 2, p.y - 10, hw, 5);
    ctx.fillStyle = hr > 0.3 ? accent : '#ef4444'; ctx.fillRect(p.x - 2, p.y - 10, hw * hr, 5);

    ctx.fillStyle = '#94a3b8'; ctx.font = '10px Outfit, sans-serif'; ctx.textAlign = 'center';
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
            case 'a': case 'arrowleft': input.left = true; break;
            case 'd': case 'arrowright': input.right = true; break;
            case 'w': case 'arrowup': case ' ': input.jump = true; e.preventDefault(); break;
        }
    });
    document.addEventListener('keyup', (e) => {
        switch (e.key.toLowerCase()) {
            case 'a': case 'arrowleft': input.left = false; break;
            case 'd': case 'arrowright': input.right = false; break;
            case 'w': case 'arrowup': case ' ': input.jump = false; break;
        }
    });
    canvas.addEventListener('mousedown', (e) => { input.shoot = true; updMouse(e); });
    canvas.addEventListener('mouseup', () => { input.shoot = false; });
    canvas.addEventListener('mousemove', (e) => { updMouse(e); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}
function updMouse(e) {
    const r = canvas.getBoundingClientRect();
    input.mouseX = (e.clientX - r.left) * (GC.CANVAS_WIDTH / r.width);
    input.mouseY = (e.clientY - r.top) * (GC.CANVAS_HEIGHT / r.height);
}

// ================== HUD ==================
function updateHUD() {
    const ids = Object.keys(allPlayers);
    if (ids.length < 2) return;
    const sorted = ids.sort((a, b) => allPlayers[a].playerIndex - allPlayers[b].playerIndex);
    const p1 = allPlayers[sorted[0]], p2 = allPlayers[sorted[1]];
    hudName1.textContent = p1.name; hudName2.textContent = p2.name;
    hudHp1.style.width = `${Math.max(0, (p1.hp / (p1.maxHp || 100)) * 100)}%`;
    hudHp2.style.width = `${Math.max(0, (p2.hp / (p2.maxHp || 100)) * 100)}%`;
    hudScore1.textContent = scores[sorted[0]] || 0;
    hudScore2.textContent = scores[sorted[1]] || 0;
    roundTextEl.textContent = `ROUND ${(scores[sorted[0]] || 0) + (scores[sorted[1]] || 0) + 1}`;
}
function handleOverlay() {
    if (gamePhase === 'roundEnd') {
        const wId = Object.keys(allPlayers).find(id => id !== loserId);
        showMsg(`${allPlayers[wId]?.name || 'Player'} WINS THE ROUND!`);
    } else if (gamePhase === 'gameOver') {
        const ids = Object.keys(scores);
        let wId = ids[0]; for (const id of ids) { if ((scores[id] || 0) > (scores[wId] || 0)) wId = id; }
        showMsg(`🏆 ${allPlayers[wId]?.name || 'Player'} WINS! 🏆`);
    } else if (gamePhase === 'playing') { gameOverlay.classList.add('hidden'); }
}
function showMsg(m) { overlayText.textContent = m; gameOverlay.classList.remove('hidden'); }

// ================== START ==================
playBtn.addEventListener('click', () => {
    playBtn.disabled = true;
    playBtn.querySelector('span').textContent = 'SEARCHING...';
    connectSocket();
});
initDiscord();
