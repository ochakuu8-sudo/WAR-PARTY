const C = require('./constants');

class GameServer {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = {};
        this.bullets = [];
        this.scores = {};
        this.state = 'waiting'; // waiting, playing, roundEnd, gameOver
        this.loserId = null;
        this.bulletIdCounter = 0;
    }

    addPlayer(socketId, name) {
        const index = Object.keys(this.players).length;
        const spawn = C.SPAWN_POINTS[index] || { x: 400, y: 300 };
        this.players[socketId] = {
            x: spawn.x, y: spawn.y,
            vx: 0, vy: 0,
            hp: C.PLAYER_HP,
            maxHp: C.PLAYER_HP,
            name, playerIndex: index,
            facingRight: index === 0,
            lastShot: 0,
        };
        this.scores[socketId] = 0;
        return index;
    }

    addCpuPlayer() {
        this.isCpuGame = true;
        this.addPlayer('CPU', 'Bot');
    }

    updateCpuBot() {
        if (this.state !== 'playing' || !this.isCpuGame) return;
        const cpu = this.players['CPU'];
        if (!cpu || cpu.hp <= 0) return;

        // Find target
        const targetId = Object.keys(this.players).find(id => id !== 'CPU' && this.players[id].hp > 0);
        if (!targetId) return;
        const target = this.players[targetId];

        const dx = target.x - cpu.x;
        const dy = target.y - cpu.y;

        // Movement
        if (dx > 30) { cpu.vx = 4; cpu.facingRight = true; }
        else if (dx < -30) { cpu.vx = -4; cpu.facingRight = false; }
        else cpu.vx = 0;

        // Physics (Gravity & Collision for Bot)
        cpu.vy += C.GRAVITY || 0.45;
        if (cpu.vy > (C.MAX_FALL || 12)) cpu.vy = C.MAX_FALL || 12;

        cpu.x += cpu.vx;
        cpu.y += cpu.vy;

        let onGround = false;
        if (cpu.y > 600) { cpu.y = 100; cpu.vy = 0; } // Fallback reset

        for (const plat of C.PLATFORMS) {
            // Very simple AABB collision for bot floor
            if (cpu.x < plat.x + plat.w && cpu.x + C.PLAYER_WIDTH > plat.x &&
                cpu.y + C.PLAYER_HEIGHT >= plat.y && cpu.y + C.PLAYER_HEIGHT <= plat.y + 16 && cpu.vy >= 0) {
                cpu.y = plat.y - C.PLAYER_HEIGHT;
                cpu.vy = 0;
                onGround = true;
            }
        }

        // Jump logic: Jump if target is higher or if stuck
        if (onGround && (dy < -50 || (Math.abs(dx) > 50 && cpu.vx === 0))) {
            if (Math.random() < 0.1) cpu.vy = -(12); // Jump force
        }

        // Shooting logic (simulate client emit)
        if (Date.now() - cpu.lastShot > 600) { // Bot shoots every 600ms
            cpu.lastShot = Date.now();
            const cx = cpu.x + C.PLAYER_WIDTH / 2;
            const cy = cpu.y + C.PLAYER_HEIGHT / 2;

            // Aim at target with some imperfection
            const tcx = target.x + C.PLAYER_WIDTH / 2 + (Math.random() - 0.5) * 60;
            const tcy = target.y + C.PLAYER_HEIGHT / 2 + (Math.random() - 0.5) * 60;

            const adx = tcx - cx;
            const ady = tcy - cy;
            const dist = Math.sqrt(adx * adx + ady * ady) || 1;
            const vx = (adx / dist) * C.BULLET_SPEED;
            const vy = (ady / dist) * C.BULLET_SPEED;

            const b = {
                id: this.bulletIdCounter++,
                x: cx, y: cy, vx, vy,
                radius: C.BULLET_RADIUS,
                ownerId: 'CPU',
                life: 120, // 2 seconds at 60Hz
            };
            this.bullets.push(b);
            if (this.io) this.io.to(this.roomId).emit('bulletFired', b);
        }
    }

    removePlayer(socketId) {
        delete this.players[socketId];
        delete this.scores[socketId];
    }

    playerCount() { return Object.keys(this.players).length; }

    start() { this.state = 'playing'; }

    // Client sends its own position - server trusts it
    updatePlayerPosition(socketId, data) {
        const p = this.players[socketId];
        if (!p || this.state !== 'playing') return;

        // Update position from client
        p.x = data.x;
        p.y = data.y;
        p.vx = data.vx || 0;
        p.vy = data.vy || 0;
        p.facingRight = data.facingRight;

        // Handle shooting (server creates bullets for fairness)
        if (data.shoot && Date.now() - p.lastShot >= C.FIRE_RATE) {
            p.lastShot = Date.now();
            const cx = p.x + C.PLAYER_WIDTH / 2;
            const cy = p.y + C.PLAYER_HEIGHT / 2;
            const dx = data.mouseX - cx;
            const dy = data.mouseY - cy;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const vx = (dx / dist) * C.BULLET_SPEED;
            const vy = (dy / dist) * C.BULLET_SPEED;

            // Apply Projectile Lag Compensation (Fast-Forward)
            // The client shot at a target they saw in the "extrapolated present" based on their ping.
            // By fast-forwarding the bullet on the server by half their ping, the server's bullet 
            // exactly matches the bullet the client is seeing on their screen.
            const headStartMs = Math.min(200, (data.ping || 0) / 2); // Cap at 200ms
            const headStartFrames = headStartMs / 16.67; // 60Hz physics frames

            const b = {
                id: this.bulletIdCounter++,
                x: cx + (vx * headStartFrames),
                y: cy + (vy * headStartFrames),
                vx: vx,
                vy: vy,
                radius: C.BULLET_RADIUS,
                ownerId: socketId,
                life: 120 - headStartFrames,
            };
            this.bullets.push(b);

            // Emit bullet creation event to clients so they can simulate it
            if (this.io) {
                this.io.to(this.roomId).emit('bulletFired', b);
            }
        }
    }

    // Server only simulates bullets + damage
    updateBullets() {
        if (this.state !== 'playing') return;

        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];
            b.x += b.vx;
            b.y += b.vy;
            b.life--;

            // Remove if out of bounds or expired
            if (b.x < -20 || b.x > C.CANVAS_WIDTH + 20 || b.y < -20 || b.y > C.CANVAS_HEIGHT + 20 || b.life <= 0) {
                this.bullets.splice(i, 1);
                continue;
            }

            // Platform collision
            let hitWall = false;
            for (const plat of C.PLATFORMS) {
                if (b.x > plat.x && b.x < plat.x + plat.w && b.y > plat.y && b.y < plat.y + plat.h) {
                    hitWall = true; break;
                }
            }
            if (hitWall) { this.bullets.splice(i, 1); continue; }

            // Player collision
            for (const id in this.players) {
                if (id === b.ownerId) continue;
                const p = this.players[id];
                if (b.x > p.x && b.x < p.x + C.PLAYER_WIDTH &&
                    b.y > p.y && b.y < p.y + C.PLAYER_HEIGHT) {
                    p.hp -= C.BULLET_DAMAGE;
                    this.bullets.splice(i, 1);
                    if (p.hp <= 0) this.onPlayerKilled(id);
                    break;
                }
            }
        }
    }

    onPlayerKilled(deadId) {
        const killerId = Object.keys(this.players).find(id => id !== deadId);
        if (killerId) this.scores[killerId]++;

        if (this.scores[killerId] >= C.ROUNDS_TO_WIN) {
            this.state = 'gameOver';
            this.loserId = deadId;
        } else {
            this.state = 'roundEnd';
            this.loserId = deadId;
            setTimeout(() => this.respawnPlayers(), C.RESPAWN_DELAY);
        }
    }

    respawnPlayers() {
        const ids = Object.keys(this.players);
        ids.forEach((id, i) => {
            const sp = C.SPAWN_POINTS[i] || { x: 400, y: 300 };
            this.players[id].x = sp.x;
            this.players[id].y = sp.y;
            this.players[id].hp = C.PLAYER_HP;
            this.players[id].vx = 0;
            this.players[id].vy = 0;
        });
        this.bullets = [];
        this.state = 'playing';
    }

    getState() {
        return {
            t: Date.now(),
            players: this.players,
            // bullets: this.bullets, // Removed: clients now simulate bullets based on bulletFired events
            scores: this.scores,
            state: this.state,
            loserId: this.loserId,
        };
    }
}

module.exports = GameServer;
