import C from './constants.js';

export default class GameEngine {
    constructor() {
        this.players = {};
        this.bullets = [];
        this.scores = {};
        this.state = 'waiting'; // waiting, playing, roundEnd, gameOver
        this.loserId = null;
        this.bulletIdCounter = 0;
        this.isCpuGame = true; // Always solo vs CPU for now
    }

    init() {
        this.addPlayer('me', 'Player');
        this.addPlayer('cpu', 'Bot');
        this.state = 'playing';
    }

    addPlayer(id, name) {
        const index = Object.keys(this.players).length;
        const spawn = C.SPAWN_POINTS[index] || { x: 400, y: 300 };
        this.players[id] = {
            id,
            x: spawn.x, y: spawn.y,
            vx: 0, vy: 0,
            hp: C.PLAYER_HP,
            maxHp: C.PLAYER_HP,
            name, playerIndex: index,
            facingRight: index === 0,
            lastShot: 0,
            grounded: false
        };
        this.scores[id] = 0;
    }

    // This runs every frame
    update(dt, input) {
        if (this.state !== 'playing') return;

        this.updateLocalPlayer(dt, input);
        this.updateCpuBot(dt);
        this.updateBullets(dt);
    }

    updateLocalPlayer(dt, input) {
        const me = this.players['me'];
        if (!me || me.hp <= 0) return;

        me.vx = 0;
        if (input.left) me.vx = -C.PLAYER_SPEED;
        if (input.right) me.vx = C.PLAYER_SPEED;
        me.facingRight = input.mouseX > me.x + C.PLAYER_WIDTH / 2;

        if (input.jump && me.grounded) {
            me.vy = C.JUMP_FORCE;
            me.grounded = false;
        }

        // Apply physics
        this.applyPhysics(me, dt);

        // Shooting
        if (input.shoot && performance.now() - me.lastShot >= C.FIRE_RATE) {
            me.lastShot = performance.now();
            this.fireBullet(me, input.mouseX, input.mouseY);
        }
    }

    updateCpuBot(dt) {
        const cpu = this.players['cpu'];
        const target = this.players['me'];
        if (!cpu || cpu.hp <= 0 || !target || target.hp <= 0) return;

        const dx = target.x - cpu.x;
        const dy = target.y - cpu.y;

        const now = performance.now();

        // Randomized Movement State Machine
        if (!cpu.lastMoveChange || now - cpu.lastMoveChange > cpu.moveDuration) {
            cpu.lastMoveChange = now;
            cpu.moveDuration = 400 + Math.random() * 1100;

            const r = Math.random();
            if (r < 0.15) {
                cpu.targetVx = 0;
            } else if (r < 0.4) {
                cpu.targetVx = Math.random() < 0.5 ? 4 : -4;
            } else {
                cpu.targetVx = dx > 0 ? 4 : -4;
            }
        }

        cpu.vx = cpu.targetVx || 0;
        if (cpu.vx > 0) cpu.facingRight = true;
        if (cpu.vx < 0) cpu.facingRight = false;

        this.applyPhysics(cpu, dt);

        // Jump logic
        if (cpu.grounded) {
            const shouldJumpEvade = Math.random() < 0.03;
            const shouldJumpPursue = dy < -30 && Math.abs(dx) < 200 && Math.random() < 0.1;
            const isStuck = Math.abs(dx) > 50 && cpu.vx === 0 && Math.random() < 0.1;

            if (shouldJumpEvade || shouldJumpPursue || isStuck) {
                cpu.vy = C.JUMP_FORCE;
            }
        }

        // Shooting logic 
        if (!cpu.nextShotDelay) cpu.nextShotDelay = 400 + Math.random() * 800;

        if (now - cpu.lastShot > cpu.nextShotDelay) {
            cpu.lastShot = now;
            cpu.nextShotDelay = 300 + Math.random() * 900;

            const spread = 80;
            const tcx = target.x + C.PLAYER_WIDTH / 2 + (Math.random() - 0.5) * spread;
            const tcy = target.y + C.PLAYER_HEIGHT / 2 + (Math.random() - 0.5) * 60;

            this.fireBullet(cpu, tcx, tcy);
        }
    }

    applyPhysics(p, dt) {
        p.vy = (p.vy || 0) + C.GRAVITY * dt;
        if (p.vy > C.MAX_FALL_SPEED) p.vy = C.MAX_FALL_SPEED;

        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.grounded = false;

        // Fallback
        if (p.y > 600) { p.y = 100; p.vy = 0; }

        for (const plat of C.PLATFORMS) {
            if (this.rectCol(p.x, p.y, C.PLAYER_WIDTH, C.PLAYER_HEIGHT, plat.x, plat.y, plat.w, plat.h)) {
                const oL = (p.x + C.PLAYER_WIDTH) - plat.x;
                const oR = (plat.x + plat.w) - p.x;
                const oT = (p.y + C.PLAYER_HEIGHT) - plat.y;
                const oB = (plat.y + plat.h) - p.y;
                const min = Math.min(oL, oR, oT, oB);

                if (min === oT && p.vy >= 0) {
                    p.y = plat.y - C.PLAYER_HEIGHT;
                    p.vy = 0;
                    p.grounded = true;
                }
                else if (min === oB && p.vy < 0) { p.y = plat.y + plat.h; p.vy = 0; }
                else if (min === oL) { p.x = plat.x - C.PLAYER_WIDTH; p.vx = 0; }
                else if (min === oR) { p.x = plat.x + plat.w; p.vx = 0; }
            }
        }
    }

    fireBullet(owner, targetX, targetY) {
        const cx = owner.x + C.PLAYER_WIDTH / 2;
        const cy = owner.y + C.PLAYER_HEIGHT / 2;
        const dx = targetX - cx;
        const dy = targetY - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

        this.bullets.push({
            id: this.bulletIdCounter++,
            x: cx,
            y: cy,
            vx: (dx / dist) * C.BULLET_SPEED,
            vy: (dy / dist) * C.BULLET_SPEED,
            radius: C.BULLET_RADIUS,
            ownerId: owner.id,
            life: 120, // Frames
        });
    }

    updateBullets(dt) {
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.life -= dt;

            // Bounds check
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
            let hitPlayer = false;
            for (const id in this.players) {
                if (id === b.ownerId) continue;
                const p = this.players[id];
                if (p.hp > 0 && b.x > p.x && b.x < p.x + C.PLAYER_WIDTH && b.y > p.y && b.y < p.y + C.PLAYER_HEIGHT) {
                    p.hp -= C.BULLET_DAMAGE;
                    hitPlayer = true;
                    if (p.hp <= 0) this.onPlayerKilled(id);
                    break;
                }
            }
            if (hitPlayer) { this.bullets.splice(i, 1); continue; }
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
        Object.values(this.players).forEach(p => {
            const sp = C.SPAWN_POINTS[p.playerIndex] || { x: 400, y: 300 };
            p.x = sp.x;
            p.y = sp.y;
            p.hp = C.PLAYER_HP;
            p.vx = 0;
            p.vy = 0;
            p.grounded = false;
        });
        this.bullets = [];
        this.state = 'playing';
    }

    rectCol(x1, y1, w1, h1, x2, y2, w2, h2) {
        return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
    }
}
