const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const MAP_SIZE = 2400;
const players = {};
let items = [];
let blocks = []; // プレイヤーが設置した建築ブロック

const WEAPONS = {
    wood_sword: { name: "木の剣", price: 0, damage: 25, range: 110, shape: 'arc', angleDeg: 70, color: "#8B4513" },
    iron_sword: { name: "鉄の大剣", price: 150, damage: 50, range: 150, shape: 'arc', angleDeg: 100, color: "#C0C0C0" },
    magic_bow:  { name: "風の弓",   price: 300, damage: 45, range: 350, shape: 'line', width: 45, color: "#2ecc71" },
    fire_staff: { name: "爆炎の杖", price: 500, damage: 85, range: 180, shape: 'circle', color: "#e74c3c" }
};

const SHOP_BUILDING = { x: 1100, y: 1100, width: 200, height: 160 };

// 障害物（自然の木や岩）
const obstacles = [];
for (let i = 0; i < 30; i++) {
    obstacles.push({
        x: Math.random() * (MAP_SIZE - 400) + 200,
        y: Math.random() * (MAP_SIZE - 400) + 200,
        type: Math.random() > 0.5 ? 'tree' : 'rock',
        radius: 24
    });
}

// モブを大量配置！
const mobs = [];
let mobIdCounter = 1;

// 雑魚スライム・ゾンビを50体大量スポーン
for (let i = 0; i < 30; i++) {
    mobs.push({ id: mobIdCounter++, type: 'slime', x: Math.random() * MAP_SIZE, y: Math.random() * MAP_SIZE, hp: 80, maxHp: 80, speed: 1.2, damage: 8, size: 32, exp: 20, coin: 20 });
}
for (let i = 0; i < 20; i++) {
    mobs.push({ id: mobIdCounter++, type: 'zombie', x: Math.random() * MAP_SIZE, y: Math.random() * MAP_SIZE, hp: 150, maxHp: 150, speed: 1.8, damage: 15, size: 36, exp: 40, coin: 45 });
}
// ボスを3体スポーン
for (let i = 0; i < 3; i++) {
    mobs.push({ id: mobIdCounter++, type: 'boss', x: 500 + i * 700, y: 1800, hp: 1000, maxHp: 1000, speed: 1.0, damage: 30, size: 80, exp: 300, coin: 300 });
}

// チーム割り当て用カウンタ
let playerTeamToggle = false;

// モブAI & 定期処理
setInterval(() => {
    mobs.forEach(mob => {
        if (mob.hp <= 0) return;

        let nearestPlayer = null;
        let minDist = 500;

        Object.values(players).forEach(p => {
            if (p.hp <= 0) return;
            const dx = p.x - mob.x;
            const dy = p.y - mob.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
                minDist = dist;
                nearestPlayer = p;
            }
        });

        if (nearestPlayer) {
            const angle = Math.atan2(nearestPlayer.y - mob.y, nearestPlayer.x - mob.x);
            mob.x += Math.cos(angle) * mob.speed;
            mob.y += Math.sin(angle) * mob.speed;

            if (minDist < mob.size / 2 + 16) {
                nearestPlayer.hp -= mob.damage * 0.03;
                if (nearestPlayer.hp <= 0) {
                    nearestPlayer.hp = 0;
                    io.emit('playerHpUpdate', { id: nearestPlayer.id, hp: 0 });
                    setTimeout(() => {
                        nearestPlayer.hp = nearestPlayer.maxHp;
                        nearestPlayer.x = 1200;
                        nearestPlayer.y = 1300;
                        io.emit('playerRespawn', nearestPlayer);
                    }, 3000);
                } else {
                    io.emit('playerHpUpdate', { id: nearestPlayer.id, hp: nearestPlayer.hp });
                }
            }
        }
    });

    // アイテム拾い判定
    Object.values(players).forEach(p => {
        if (p.hp <= 0) return;
        items = items.filter(item => {
            const dx = p.x + 16 - item.x;
            const dy = p.y + 16 - item.y;
            if (Math.sqrt(dx * dx + dy * dy) < 30) {
                if (item.type === 'coin') {
                    p.coins += item.value;
                } else if (item.type === 'potion') {
                    p.hp = Math.min(p.maxHp, p.hp + 40);
                    io.emit('playerHpUpdate', { id: p.id, hp: p.hp });
                }
                io.emit('playerDataUpdate', { id: p.id, coins: p.coins, exp: p.exp, level: p.level });
                return false;
            }
            return true;
        });
    });

    io.emit('mobsState', mobs);
    io.emit('itemsState', items);
}, 50);

io.on('connection', (socket) => {
    // 交互にチーム（RED/BLUE）を振り分け
    const assignedTeam = playerTeamToggle ? 'RED' : 'BLUE';
    playerTeamToggle = !playerTeamToggle;

    players[socket.id] = {
        id: socket.id,
        x: 1200,
        y: 1300,
        team: assignedTeam,
        hp: 100,
        maxHp: 100,
        level: 1,
        exp: 0,
        maxExp: 50,
        coins: 0,
        angle: 0,
        weapon: 'wood_sword',
        isAttacking: false,
        skin: null
    };

    socket.emit('init', { id: socket.id, players, mobs, obstacles, shop: SHOP_BUILDING, mapSize: MAP_SIZE, weapons: WEAPONS, items, blocks });
    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('updateSkin', (skinData) => {
        if (players[socket.id]) {
            players[socket.id].skin = skinData;
            io.emit('skinUpdated', { id: socket.id, skin: skinData });
        }
    });

    socket.on('buyWeapon', (weaponKey) => {
        const p = players[socket.id];
        const w = WEAPONS[weaponKey];
        if (p && w && p.coins >= w.price) {
            p.coins -= w.price;
            p.weapon = weaponKey;
            socket.emit('weaponPurchased', { weapon: weaponKey });
            io.emit('playerDataUpdate', { id: socket.id, coins: p.coins, exp: p.exp, level: p.level });
        }
    });

    socket.on('playerMovement', (data) => {
        const p = players[socket.id];
        if (!p || p.hp <= 0) return;
        p.x = data.x;
        p.y = data.y;
        p.angle = data.angle;
        socket.broadcast.emit('playerMoved', p);
    });

    // 建築ブロック設置
    socket.on('placeBlock', (pos) => {
        const p = players[socket.id];
        if (!p || p.hp <= 0) return;
        
        const newBlock = {
            x: Math.floor(pos.x / 32) * 32,
            y: Math.floor(pos.y / 32) * 32,
            color: p.team === 'RED' ? '#e74c3c' : '#3498db'
        };
        blocks.push(newBlock);
        io.emit('blockPlaced', newBlock);
    });

    // 攻撃処理（対人対戦 + モブ攻撃）
    socket.on('playerAttack', (attackData) => {
        const attacker = players[socket.id];
        if (!attacker || attacker.isAttacking || attacker.hp <= 0) return;

        attacker.isAttacking = true;
        attacker.angle = attackData.angle;

        const weapon = WEAPONS[attacker.weapon];
        io.emit('playerAttackStart', { id: socket.id, angle: attackData.angle, weaponKey: attacker.weapon });

        // 1. 他プレイヤーへの対人（PvP）判定（敵チームのみヒット！）
        Object.values(players).forEach(target => {
            if (target.id !== attacker.id && target.team !== attacker.team && target.hp > 0) {
                if (checkHit(attacker.x + 16, attacker.y + 16, target.x + 16, target.y + 16, attacker.angle, weapon)) {
                    target.hp -= weapon.damage;
                    if (target.hp <= 0) {
                        target.hp = 0;
                        attacker.coins += 100; // 敵プレイヤー撃破ボーナス！
                        attacker.exp += 100;
                        io.emit('playerDataUpdate', { id: attacker.id, coins: attacker.coins, exp: attacker.exp, level: attacker.level });
                    }
                    io.emit('playerHpUpdate', { id: target.id, hp: target.hp });
                }
            }
        });

        // 2. モブへの攻撃チェック
        mobs.forEach(mob => {
            if (mob.hp > 0) {
                if (checkHit(attacker.x + 16, attacker.y + 16, mob.x + mob.size/2, mob.y + mob.size/2, attacker.angle, weapon)) {
                    mob.hp -= weapon.damage;
                    if (mob.hp <= 0) {
                        mob.hp = 0;
                        attacker.exp += mob.exp;
                        attacker.coins += mob.coin;

                        items.push({
                            x: mob.x + mob.size/2,
                            y: mob.y + mob.size/2,
                            type: Math.random() > 0.3 ? 'coin' : 'potion',
                            value: mob.coin
                        });

                        if (attacker.exp >= attacker.maxExp) {
                            attacker.level += 1;
                            attacker.exp -= attacker.maxExp;
                            attacker.maxExp = Math.floor(attacker.maxExp * 1.5);
                            attacker.maxHp += 20;
                            attacker.hp = attacker.maxHp;
                        }

                        io.emit('playerDataUpdate', { id: socket.id, coins: attacker.coins, exp: attacker.exp, level: attacker.level, hp: attacker.hp, maxHp: attacker.maxHp });

                        setTimeout(() => {
                            mob.hp = mob.maxHp;
                            mob.x = Math.random() * (MAP_SIZE - 400) + 200;
                            mob.y = Math.random() * (MAP_SIZE - 400) + 200;
                        }, 5000);
                    }
                }
            }
        });

        setTimeout(() => { if (players[socket.id]) players[socket.id].isAttacking = false; }, 250);
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

function checkHit(px, py, tx, ty, angle, weapon) {
    const dx = tx - px;
    const dy = ty - py;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (weapon.shape === 'circle') {
        return dist <= weapon.range;
    } else if (weapon.shape === 'arc') {
        if (dist > weapon.range) return false;
        let targetAngle = Math.atan2(dy, dx);
        let diff = targetAngle - angle;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        return Math.abs(diff) <= (weapon.angleDeg / 2) * (Math.PI / 180);
    } else if (weapon.shape === 'line') {
        if (dist > weapon.range) return false;
        let targetAngle = Math.atan2(dy, dx);
        let diff = targetAngle - angle;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        const crossDist = Math.abs(Math.sin(diff) * dist);
        return crossDist <= weapon.width && Math.cos(diff) > 0;
    }
    return false;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));