const C = require('./constants');

class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = {};
        this.bullets = [];
        this.scores = {};
        this.state = 'waiting'; // waiting, playing, roundEnd, gameOver
        this.bulletIdCounter = 0;
        this.roundEndTimer = null;
    }

    addPlayer(socketId, name) {
        const playerIndex = Object.keys(this.players).length;
        const spawn = C.SPAWN_POINTS[playerIndex] || C.SPAWN_POINTS[0];

        this.players[socketId] = {
            id: socketId,
            name: name || `Player ${playerIndex + 1}`,
            x: spawn.x,
            y: spawn.y,
            vx: 0,
            vy: 0,
            hp: C.PLAYER_HP,
            facingRight: playerIndex === 0,
            grounded: false,
            lastFireTime: 0,
            color: playerIndex === 0 ? '#38bdf8' : '#f87171',
            playerIndex: playerIndex,
            cards: [],
            // Card-modified stats
            bulletDamage: C.BULLET_DAMAGE,
            bulletSpeed: C.BULLET_SPEED,
            bulletRadius: C.BULLET_RADIUS,
            fireRate: C.FIRE_RATE,
            maxHp: C.PLAYER_HP,
            moveSpeed: C.PLAYER_SPEED,
            jumpForce: C.JUMP_FORCE,
            bulletCount: 1,
            bulletBounce: false,
        };
        this.scores[socketId] = 0;

        if (Object.keys(this.players).length === 2) {
            this.state = 'playing';
        }
        return this.players[socketId];
    }

    removePlayer(socketId) {
        delete this.players[socketId];
        delete this.scores[socketId];
    }

    handleInput(socketId, input) {
        const player = this.players[socketId];
        if (!player || this.state !== 'playing') return;

        // Horizontal movement
        player.vx = 0;
        if (input.left) player.vx = -player.moveSpeed;
        if (input.right) player.vx = player.moveSpeed;

        // Facing direction
        if (input.mouseX !== undefined) {
            player.facingRight = input.mouseX > player.x + C.PLAYER_WIDTH / 2;
        }

        // Jump
        if (input.jump && player.grounded) {
            player.vy = player.jumpForce;
            player.grounded = false;
        }

        // Shoot
        if (input.shoot) {
            const now = Date.now();
            if (now - player.lastFireTime >= player.fireRate) {
                player.lastFireTime = now;
                this.spawnBullets(player, input.mouseX, input.mouseY);
            }
        }
    }

    spawnBullets(player, targetX, targetY) {
        const cx = player.x + C.PLAYER_WIDTH / 2;
        const cy = player.y + C.PLAYER_HEIGHT / 2;
        const angle = Math.atan2((targetY || cy) - cy, (targetX || (player.facingRight ? cx + 100 : cx - 100)) - cx);

        const count = player.bulletCount || 1;
        const spreadAngle = 0.15; // radians between bullets if multiple

        for (let i = 0; i < count; i++) {
            const offsetAngle = angle + (i - (count - 1) / 2) * spreadAngle;
            this.bullets.push({
                id: this.bulletIdCounter++,
                ownerId: player.id,
                x: cx,
                y: cy,
                vx: Math.cos(offsetAngle) * player.bulletSpeed,
                vy: Math.sin(offsetAngle) * player.bulletSpeed,
                radius: player.bulletRadius,
                damage: player.bulletDamage,
                bounce: player.bulletBounce,
                life: 180, // frames
            });
        }
    }

    update() {
        if (this.state !== 'playing') return;

        // Update players
        for (const id in this.players) {
            const p = this.players[id];

            // Gravity
            p.vy += C.GRAVITY;
            if (p.vy > C.MAX_FALL_SPEED) p.vy = C.MAX_FALL_SPEED;

            // Move
            p.x += p.vx;
            p.y += p.vy;
            p.grounded = false;

            // Platform collision
            for (const plat of C.PLATFORMS) {
                if (this.rectCollision(p.x, p.y, C.PLAYER_WIDTH, C.PLAYER_HEIGHT, plat.x, plat.y, plat.w, plat.h)) {
                    // Determine collision direction
                    const overlapLeft = (p.x + C.PLAYER_WIDTH) - plat.x;
                    const overlapRight = (plat.x + plat.w) - p.x;
                    const overlapTop = (p.y + C.PLAYER_HEIGHT) - plat.y;
                    const overlapBottom = (plat.y + plat.h) - p.y;

                    const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

                    if (minOverlap === overlapTop && p.vy >= 0) {
                        p.y = plat.y - C.PLAYER_HEIGHT;
                        p.vy = 0;
                        p.grounded = true;
                    } else if (minOverlap === overlapBottom && p.vy < 0) {
                        p.y = plat.y + plat.h;
                        p.vy = 0;
                    } else if (minOverlap === overlapLeft) {
                        p.x = plat.x - C.PLAYER_WIDTH;
                    } else if (minOverlap === overlapRight) {
                        p.x = plat.x + plat.w;
                    }
                }
            }

            // Boundaries
            if (p.y > C.CANVAS_HEIGHT) {
                p.hp = 0; // Fell off
            }
        }

        // Update bullets
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];
            b.x += b.vx;
            b.y += b.vy;
            b.life--;

            // Remove old bullets
            if (b.life <= 0) {
                this.bullets.splice(i, 1);
                continue;
            }

            // Wall bounce / remove
            let hitWall = false;
            if (b.x < 10 || b.x > C.CANVAS_WIDTH - 10) hitWall = true;
            if (b.y < 0 || b.y > C.CANVAS_HEIGHT) hitWall = true;

            // Platform collision
            for (const plat of C.PLATFORMS) {
                if (b.x > plat.x && b.x < plat.x + plat.w && b.y > plat.y && b.y < plat.y + plat.h) {
                    hitWall = true;
                    break;
                }
            }

            if (hitWall) {
                if (b.bounce) {
                    b.vx *= -1;
                    b.vy *= -0.8;
                    b.x = Math.max(12, Math.min(C.CANVAS_WIDTH - 12, b.x));
                } else {
                    this.bullets.splice(i, 1);
                    continue;
                }
            }

            // Hit players
            for (const id in this.players) {
                if (id === b.ownerId) continue;
                const p = this.players[id];
                if (b.x > p.x && b.x < p.x + C.PLAYER_WIDTH && b.y > p.y && b.y < p.y + C.PLAYER_HEIGHT) {
                    p.hp -= b.damage;
                    this.bullets.splice(i, 1);
                    break;
                }
            }
        }

        // Check kills
        for (const id in this.players) {
            if (this.players[id].hp <= 0) {
                this.onPlayerKilled(id);
                break;
            }
        }
    }

    onPlayerKilled(deadId) {
        // Award point to the other player
        for (const id in this.players) {
            if (id !== deadId) {
                this.scores[id]++;

                // Check win
                if (this.scores[id] >= C.ROUNDS_TO_WIN) {
                    this.state = 'gameOver';
                    return;
                }
            }
        }

        this.state = 'roundEnd';
        this.loserId = deadId;

        // Auto-respawn after delay
        setTimeout(() => {
            if (this.state === 'roundEnd') {
                this.respawnPlayers();
                this.state = 'playing';
            }
        }, C.RESPAWN_DELAY);
    }

    respawnPlayers() {
        this.bullets = [];
        let i = 0;
        for (const id in this.players) {
            const p = this.players[id];
            const spawn = C.SPAWN_POINTS[i];
            p.x = spawn.x;
            p.y = spawn.y;
            p.vx = 0;
            p.vy = 0;
            p.hp = p.maxHp;
            i++;
        }
    }

    rectCollision(x1, y1, w1, h1, x2, y2, w2, h2) {
        return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
    }

    getState() {
        return {
            players: this.players,
            bullets: this.bullets,
            scores: this.scores,
            state: this.state,
            loserId: this.loserId,
        };
    }
}

module.exports = GameRoom;
