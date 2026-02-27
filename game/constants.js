// Shared constants between server and client
module.exports = {
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 500,

    // Player
    PLAYER_WIDTH: 28,
    PLAYER_HEIGHT: 36,
    PLAYER_SPEED: 4.5,
    JUMP_FORCE: -10,
    GRAVITY: 0.45,
    MAX_FALL_SPEED: 12,
    PLAYER_HP: 100,

    // Bullets
    BULLET_SPEED: 12,
    BULLET_RADIUS: 4,
    BULLET_DAMAGE: 25,
    FIRE_RATE: 300, // ms between shots

    // Game
    TICK_RATE: 30, // server network updates per second
    ROUNDS_TO_WIN: 5,
    RESPAWN_DELAY: 1500, // ms

    // Map platforms
    PLATFORMS: [
        // Ground
        { x: 0, y: 460, w: 800, h: 40 },
        // Left platform
        { x: 50, y: 340, w: 180, h: 16 },
        // Right platform
        { x: 570, y: 340, w: 180, h: 16 },
        // Center high platform
        { x: 300, y: 240, w: 200, h: 16 },
        // Left high
        { x: 80, y: 160, w: 120, h: 16 },
        // Right high
        { x: 600, y: 160, w: 120, h: 16 },
        // Walls
        { x: 0, y: 0, w: 10, h: 500 },
        { x: 790, y: 0, w: 10, h: 500 },
    ],

    // Spawn points
    SPAWN_POINTS: [
        { x: 100, y: 300 },
        { x: 680, y: 300 }
    ]
};
