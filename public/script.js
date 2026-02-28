import C from './game/constants.js';
import GameEngine from './game/Engine.js';

let playerName = 'Player';

// UI
const lobbyScreen = document.getElementById('lobby');
const gameScreen = document.getElementById('gameScreen');
const playBtn = document.getElementById('playBtn');
const playCpuBtn = document.getElementById('playCpuBtn');
const nameInput = document.getElementById('nameInput');
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
let engine = null;
let canvas = null, ctx = null, animFrameId = null;
let input = { left: false, right: false, jump: false, shoot: false, mouseX: 400, mouseY: 250 };
let lastFrame = 0;

// ================== INIT ==================
function startGame() {
    const val = nameInput.value.trim();
    playerName = val ? val : 'Player' + Math.floor(Math.random() * 1000);

    lobbyScreen.classList.remove('active');
    gameScreen.classList.add('active');

    initGame();
}

playBtn.addEventListener('click', startGame);
playCpuBtn.addEventListener('click', startGame);

// ================== GAME INIT ==================
function initGame() {
    const container = document.getElementById('gameContainer');
    container.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.width = C.CANVAS_WIDTH;
    canvas.height = C.CANVAS_HEIGHT;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);
    ctx = canvas.getContext('2d');

    setupInput();

    // Initialize Local Engine
    engine = new GameEngine();
    engine.init();
    engine.players['me'].name = playerName;

    lastFrame = performance.now();
    loop();
}

// ================== GAME LOOP ==================
function loop() {
    const now = performance.now();
    const dt = Math.min((now - lastFrame) / 16.67, 2); // Cap at 2 frames of time delta to prevent huge jumps
    lastFrame = now;

    // 1. Process physics and AI
    if (engine) engine.update(dt, input);

    // 2. Update UI
    updateHUD();
    handleOverlay();

    // 3. Render
    render();

    animFrameId = requestAnimationFrame(loop);
}

// ================== RENDER ==================
function render() {
    if (!ctx || !engine) return;
    const W = C.CANVAS_WIDTH, H = C.CANVAS_HEIGHT;

    // Background
    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.02)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // Platforms
    for (const p of C.PLATFORMS) {
        ctx.fillStyle = 'rgba(30,41,59,0.6)';
        ctx.fillRect(p.x - 1, p.y - 1, p.w + 2, p.h + 2);
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(p.x, p.y, p.w, p.h);
        if (p.h <= 20) { ctx.fillStyle = '#334155'; ctx.fillRect(p.x + 1, p.y, p.w - 2, 2); }
    }

    // Bullets
    for (const b of engine.bullets) {
        const owner = engine.players[b.ownerId];
        const color = owner ? (owner.playerIndex === 0 ? '#38bdf8' : '#f87171') : '#fbbf24';

        ctx.beginPath(); ctx.arc(b.x, b.y, b.radius + 4, 0, Math.PI * 2);
        ctx.fillStyle = color + '40'; ctx.fill();
        ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.beginPath(); ctx.arc(b.x, b.y, b.radius - 1, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
    }

    // Players
    for (const id in engine.players) {
        drawPlayer(engine.players[id]);
    }
}

function drawPlayer(p) {
    if (p.hp <= 0) return; // Don't draw dead players

    const PW = C.PLAYER_WIDTH, PH = C.PLAYER_HEIGHT;
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
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    input.mouseX = (e.clientX - r.left) * (C.CANVAS_WIDTH / r.width);
    input.mouseY = (e.clientY - r.top) * (C.CANVAS_HEIGHT / r.height);
}

// ================== HUD ==================
function updateHUD() {
    if (!engine) return;

    const p1 = engine.players['me'];
    const p2 = engine.players['cpu'];

    if (!p1 || !p2) return;

    hudName1.textContent = p1.name;
    hudName2.textContent = p2.name;
    hudHp1.style.width = `${Math.max(0, (p1.hp / (p1.maxHp || 100)) * 100)}%`;
    hudHp2.style.width = `${Math.max(0, (p2.hp / (p2.maxHp || 100)) * 100)}%`;
    hudScore1.textContent = engine.scores['me'] || 0;
    hudScore2.textContent = engine.scores['cpu'] || 0;

    const totalRounds = (engine.scores['me'] || 0) + (engine.scores['cpu'] || 0) + 1;
    roundTextEl.textContent = `ROUND ${totalRounds}`;
}

function handleOverlay() {
    if (!engine) return;

    if (engine.state === 'roundEnd') {
        const wId = Object.keys(engine.players).find(id => id !== engine.loserId);
        showMsg(`${engine.players[wId]?.name || 'Player'} WINS THE ROUND!`);
    } else if (engine.state === 'gameOver') {
        const ids = Object.keys(engine.scores);
        let wId = ids[0];
        for (const id of ids) { if ((engine.scores[id] || 0) > (engine.scores[wId] || 0)) wId = id; }
        showMsg(`🏆 ${engine.players[wId]?.name || 'Player'} WINS! 🏆`);
    } else if (engine.state === 'playing') {
        gameOverlay.classList.add('hidden');
    }
}

function showMsg(m) {
    overlayText.textContent = m;
    gameOverlay.classList.remove('hidden');
}
