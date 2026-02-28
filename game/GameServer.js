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
