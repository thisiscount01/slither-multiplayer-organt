'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ─── Game constants ───────────────────────────────────────────────────────────
const WORLD_W         = 5000;
const WORLD_H         = 5000;
const TICK_MS         = 50;          // 20 TPS
const SNAKE_SPEED     = 5;           // px/tick (normal)
const BOOST_SPEED     = 10;          // px/tick (boost)
const INIT_LENGTH     = 20;          // starting segments
const MIN_LENGTH      = 10;          // minimum before boost disabled
const HEAD_RADIUS     = 9;           // px  (eating)
const BODY_RADIUS     = 7;           // px  (collision hit-box)
const FOOD_RADIUS     = 10;          // px  (eating — generous for good feel)
// EAT_DIST_SQ — 버그2 수정으로 tick() 내 동적 eatDistSq로 교체됨 (dead constant)
const HIT_DIST_SQ     = (HEAD_RADIUS + BODY_RADIUS) ** 2;
const FOOD_TARGET     = 2500;        // dense food field — slither.io style
const BOOST_TICK_COST = 5;           // every N ticks while boosting: eject 1 segment
const BIG_FOOD_CHANCE = 0.06;        // 6% chance a pellet is worth 3 (bigger)
const BOT_COUNT         = 4;           // AI bots to fill empty server
const BOT_SEARCH_RADIUS = 600;         // px — bot only considers food within this range
const BOT_MAX_TARGET    = 700;         // px — abandon sticky target beyond this distance
const DANGER_R          = 250;         // px — threat avoidance: longer snake head radius
const HUNT_R            = 400;         // px — hunt radius: cut off shorter snakes
const DENSITY_CELL  = 300;                                     // px — density grid cell size
const DENSITY_COLS  = Math.ceil(WORLD_W / DENSITY_CELL);       // 17 cols
const DENSITY_ROWS  = Math.ceil(WORLD_H / DENSITY_CELL);       // 17 rows
const DENSITY_AVG   = FOOD_TARGET / (DENSITY_COLS * DENSITY_ROWS); // ≈ 8.6 food/cell avg
const MAX_PLAYERS     = 60;
const SELF_SKIP       = 15;          // skip own first N segments for self-collision
const LEADERBOARD_MS  = 5000;
const BORDER          = 50;          // wall death margin
const MAX_TURN_DEG    = 8;           // degrees/tick
const SPAWN_PROTECT_MS = 3000;       // ms of collision immunity after spawn

const SKIN_PRESETS = [
  '#e74c3c','#2ecc71','#3498db','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#e91e63','#00bcd4','#8bc34a',
  '#ff5722','#795548','#ff9800','#cddc39','#607d8b',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function uid() { return crypto.randomUUID(); }
function rand(a, b) { return a + Math.random() * (b - a); }
function distSq(ax, ay, bx, by) { const dx=bx-ax,dy=by-ay; return dx*dx+dy*dy; }
function degToRad(d) { return d * Math.PI / 180; }
function normDeg(d) { return ((d % 360) + 360) % 360; }
function angleDiffDeg(from, to) {
  let d = normDeg(to) - normDeg(from);
  if (d >  180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// ─── State ───────────────────────────────────────────────────────────────────
const players    = new Map();   // id → player
const foods      = new Map();   // id → food
const clients    = new Map();   // playerId → ws
const newSpawns  = [];          // players who joined since last tick (for spawns broadcast)
let tickCount  = 0;
let lastLBoard = 0;

// ─── Food ────────────────────────────────────────────────────────────────────
function makeFood(x, y, value = null, color = null) {
  // Natural value distribution: 6% big (worth 3), rest normal (worth 1)
  const v = value ?? (Math.random() < BIG_FOOD_CHANCE ? 3 : 1);
  return {
    id:    uid(),
    x:     x    ?? rand(BORDER, WORLD_W - BORDER),
    y:     y    ?? rand(BORDER, WORLD_H - BORDER),
    value: v,
    size:  v >= 3 ? 10 : v > 1 ? 8 : 6,
    color: color ?? (v >= 3
      ? `hsl(${Math.floor(Math.random()*60 + 30)},100%,65%)`   // warm gold for big
      : `hsl(${Math.floor(Math.random() * 360)},80%,65%)`),
  };
}

function spawnFood(x, y, value, color) {
  const f = makeFood(x, y, value, color);
  foods.set(f.id, f);
  return f;
}

function refillFood() {
  const need = FOOD_TARGET - foods.size;
  if (need <= 0) return [];
  const out = [];
  const batch = Math.min(need, 25);
  for (let i = 0; i < batch; i++) out.push(spawnFood());
  return out;
}

// ─── Snake ───────────────────────────────────────────────────────────────────
function makeSnake(id, name, skin) {
  const MIN_SPAWN_DIST    = 400;
  const MIN_SPAWN_DIST_SQ = MIN_SPAWN_DIST * MIN_SPAWN_DIST;
  const MAX_TRIES         = 30;

  let bestX = 0, bestY = 0, bestMinDistSq = -1;

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const cx = rand(BORDER + 300, WORLD_W - BORDER - 300);
    const cy = rand(BORDER + 300, WORLD_H - BORDER - 300);

    // Compute minimum squared distance to all segments of alive snakes
    let minDSq = Infinity;
    for (const p of players.values()) {
      if (!p.alive) continue;
      for (const seg of p.segments) {
        const d = distSq(cx, cy, seg.x, seg.y);
        if (d < minDSq) minDSq = d;
      }
    }

    if (minDSq > bestMinDistSq) {
      bestMinDistSq = minDSq;
      bestX = cx;
      bestY = cy;
    }

    if (minDSq >= MIN_SPAWN_DIST_SQ) break; // good spot found early
  }

  const x     = bestX;
  const y     = bestY;
  const angle = Math.random() * 360;
  const rad   = degToRad(angle);
  const segs  = [];
  for (let i = 0; i < INIT_LENGTH; i++) {
    segs.push({ x: x - Math.cos(rad) * i * SNAKE_SPEED,
                y: y - Math.sin(rad) * i * SNAKE_SPEED });
  }
  return {
    id, name, skin, score: 0,
    segments: segs,
    angle,              // current server angle (degrees)
    inputAngle: angle,  // latest client target angle
    boosting: false,
    boostTick: 0,
    alive: true,
    spawnedAt: Date.now(),  // for spawn invincibility window
    spinStreak: 0,          // consecutive same-direction ticks (coil detection)
    spinSide: 0,            // +1 = CW, -1 = CCW, 0 = not spinning
  };
}

function killPlayer(player, killedById) {
  if (!player.alive) return [];
  player.alive = false;

  // Convert body → food (every 2nd segment)
  const food = [];
  const perSeg = Math.max(1, Math.floor((player.score || 1) / Math.max(1, player.segments.length)));
  for (let i = 0; i < player.segments.length; i += 2) {
    food.push(spawnFood(player.segments[i].x, player.segments[i].y, perSeg, player.skin));
  }

  // Rank at moment of death
  let rank = 1;
  for (const p of players.values()) {
    if (p.id !== player.id && p.alive && p.score > player.score) rank++;
  }

  const ws = clients.get(player.id);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type:      'self_death',
      tick:      tickCount,
      killed_by: killedById || null,
      score:     player.score,
      rank,
    }));
  }
  return food;
}

// ─── Game tick ────────────────────────────────────────────────────────────────
function tick() {
  tickCount++;

  const moves        = [];
  const deaths       = [];
  const foodSpawned  = [];
  const foodEaten    = [];
  const scoreDeltas  = [];
  const toKill       = new Map(); // id → killedBy (id|null)

  // 1. Move
  for (const p of players.values()) {
    if (!p.alive) continue;

    // Smooth turn — boost reduces agility slightly; length does NOT affect turn rate
    const turnCap = MAX_TURN_DEG * (p.boosting ? 0.70 : 1.0);
    const diff    = angleDiffDeg(p.angle, p.inputAngle);
    let   rotate  = Math.sign(diff) * Math.min(Math.abs(diff), turnCap);
    const speed   = p.boosting ? BOOST_SPEED : SNAKE_SPEED;

    // [버그1 수정] 스핀 감지: 같은 방향 연속 회전 틱 추적.
    // 충돌 판정은 아래 collision 섹션에서 처리 (코일 몸통 투명화).
    // 회전율(MAX_TURN_DEG/turnCap) 및 자살방지는 그대로 유지.
    const prevSide = p.spinSide;
    if (rotate > 1) {
      p.spinSide   = 1;
      p.spinStreak = (prevSide === 1) ? p.spinStreak + 1 : 1;
    } else if (rotate < -1) {
      p.spinSide   = -1;
      p.spinStreak = (prevSide === -1) ? p.spinStreak + 1 : 1;
    } else {
      p.spinStreak = 0;
      p.spinSide   = 0;
    }

    p.angle       = normDeg(p.angle + rotate);
    const rad   = degToRad(p.angle);
    const nx    = p.segments[0].x + Math.cos(rad) * speed;
    const ny    = p.segments[0].y + Math.sin(rad) * speed;

    // Wall death
    if (nx < BORDER || nx > WORLD_W - BORDER || ny < BORDER || ny > WORLD_H - BORDER) {
      toKill.set(p.id, null);
      continue;
    }

    p.segments.unshift({ x: nx, y: ny });

    // Eat food
    let grew        = false;
    let shrunk      = false;
    let extra_shrunk = false;

    // [버그2 수정] 동적 섭취반경: 뱀 크기에 따라 headR이 커지므로 EAT 판정도 같이 스케일.
    // 클라이언트 app.js bodyR()/headR() 공식과 동일하게 계산.
    const sBodyR    = Math.min(22, 7 + Math.max(0, p.segments.length - 20) * 0.065);
    const sHeadR    = Math.min(26, sBodyR + 3);
    const eatDistSq = (sHeadR + FOOD_RADIUS) ** 2;

    for (const [fid, f] of foods) {
      if (distSq(nx, ny, f.x, f.y) < eatDistSq) {
        p.score += f.value;
        foods.delete(fid);
        foodEaten.push(fid);
        grew = true;
        scoreDeltas.push({ id: p.id, score: p.score });
        break;
      }
    }

    // Boost cost: eject tail as food (shrunk) + extra pop to actually reduce length
    if (p.boosting && p.segments.length > MIN_LENGTH && p.score > 0) {
      p.boostTick++;
      if (p.boostTick % BOOST_TICK_COST === 0) {
        // 1) Eject tail segment as food (the "shrunk" pop)
        const tail = p.segments[p.segments.length - 1];
        const f    = spawnFood(tail.x, tail.y, 1, p.skin);
        foodSpawned.push(f);
        p.segments.pop();
        shrunk = true;

        // 2) Extra pop so net length actually decreases by 1
        if (p.segments.length > MIN_LENGTH) {
          p.segments.pop();
          extra_shrunk = true;
        }

        // 3) Score penalty
        p.score = Math.max(0, p.score - 1);
        scoreDeltas.push({ id: p.id, score: p.score });

        // 4) If score just hit 0, stop boosting immediately
        if (p.score === 0) p.boosting = false;
      }
    } else if (p.boosting && (p.segments.length <= MIN_LENGTH || p.score === 0)) {
      // Force-stop boost when resources depleted
      p.boosting = false;
    }

    // Normal tail trim (skipped when shrunk, so snake stays same length normally)
    if (!grew && !shrunk) p.segments.pop();

    moves.push({ id: p.id, head: { x: nx, y: ny }, grew, shrunk, extra_shrunk, angle: p.angle, boosting: p.boosting });
  }

  // 2. Collision (head vs other snakes' bodies only — self-collision disabled)
  // [버그1 수정] 코일 노출: 스핀 중인 뱀(45틱 이상 연속 같은 방향 회전)의
  // 머리 주변 72px 이내 몸통 세그먼트는 공격자에게 투명 처리.
  // → 다른 뱀이 코일 안으로 진입해 스피너의 머리 경로에 몸통을 놓으면
  //   스피너 자신의 머리가 공격자 몸통에 닿아 죽는 정상 판정 발생.
  // 자살방지·회전율 불변.
  const SPIN_COIL_THRESHOLD = 45;      // ticks — 한 바퀴 완성 기준
  const COIL_EXPOSE_SQ      = 72 * 72; // px² — 최소 코일 지름² (2×35.8px)
  const alive = Array.from(players.values()).filter(p => p.alive && !toKill.has(p.id));
  const now = Date.now();
  for (const s of alive) {
    // Spawn invincibility: newly spawned snakes cannot be killed for SPAWN_PROTECT_MS
    if (now - s.spawnedAt < SPAWN_PROTECT_MS) continue;
    const hx = s.segments[0].x, hy = s.segments[0].y;
    for (const o of alive) {
      if (o.id === s.id) continue;  // no self-kill: skip own body entirely
      // 스핀 코일 노출 여부 판단
      const oSpinning = (o.spinStreak || 0) >= SPIN_COIL_THRESHOLD;
      const ohx = oSpinning ? o.segments[0].x : 0;
      const ohy = oSpinning ? o.segments[0].y : 0;
      for (let i = 0; i < o.segments.length; i++) {
        const seg = o.segments[i];
        // 스핀 중인 뱀의 머리 근처 몸통(i>0)은 투명 — 공격자가 코일을 뚫고 진입 가능
        if (oSpinning && i > 0 && distSq(seg.x, seg.y, ohx, ohy) < COIL_EXPOSE_SQ) continue;
        if (distSq(hx, hy, seg.x, seg.y) < HIT_DIST_SQ) {
          if (!toKill.has(s.id)) toKill.set(s.id, o.id);
          break;
        }
      }
      if (toKill.has(s.id)) break;
    }
  }

  // 3. Execute deaths
  for (const [id, killedBy] of toKill) {
    const p = players.get(id);
    if (p && p.alive) {
      const f = killPlayer(p, killedBy);
      foodSpawned.push(...f);
      deaths.push(id);
    }
  }

  // 4. Refill food
  foodSpawned.push(...refillFood());

  // 5. Broadcast delta tick
  // Include any players who joined mid-game so existing clients can see them
  const spawnPayload = newSpawns.splice(0).map(p => ({
    id: p.id, name: p.name, skin: p.skin, score: p.score,
    length: p.segments.length, segments: p.segments,
    angle: p.angle, boosting: p.boosting,
    spawnProtectUntil: p.spawnedAt + SPAWN_PROTECT_MS,
  }));

  const tickMsg = JSON.stringify({
    type:         'tick',
    tick:         tickCount,
    moves,
    spawns:       spawnPayload,
    deaths,
    food_spawned: foodSpawned,
    food_eaten:   foodEaten,
    scores:       scoreDeltas,
  });
  for (const ws of clients.values()) {
    if (ws.readyState === 1) ws.send(tickMsg);
  }

  // 6. Leaderboard (every 5s)
  if (Date.now() - lastLBoard >= LEADERBOARD_MS) {
    lastLBoard = Date.now();
    broadcastLeaderboard();
  }
}

function broadcastLeaderboard() {
  const entries = Array.from(players.values())
    .filter(p => p.alive)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score }));
  const msg = JSON.stringify({ type: 'leaderboard', tick: tickCount, entries });
  for (const ws of clients.values()) { if (ws.readyState === 1) ws.send(msg); }
}

function sendInit(ws, player) {
  const allPlayers = Array.from(players.values())
    .filter(p => p.alive)
    .map(p => ({
      id: p.id, name: p.name, skin: p.skin, score: p.score,
      length: p.segments.length, segments: p.segments,
      angle: p.angle, boosting: p.boosting,
      spawnProtectUntil: p.spawnedAt + SPAWN_PROTECT_MS,
    }));
  ws.send(JSON.stringify({
    type:     'init',
    playerId: player.id,
    tick:     tickCount,
    world:    { width: WORLD_W, height: WORLD_H },
    players:  allPlayers,
    food:     Array.from(foods.values()),
    spawnProtectUntil: player.spawnedAt + SPAWN_PROTECT_MS,
  }));
}

// ─── HTTP + WebSocket ─────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── join ──
    if (msg.type === 'join') {
      if (players.size >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', code: 'ROOM_FULL', message: 'Server is full.' }));
        return;
      }

      // Clean up previous session on same connection (respawn)
      if (playerId) {
        const old = players.get(playerId);
        if (old) killPlayer(old, null);
        players.delete(playerId);
        clients.delete(playerId);
        playerId = null;
      }

      const name = String(msg.name || '').trim().slice(0, 20) || 'Snake';
      const skin = /^#[0-9a-fA-F]{6}$/.test(msg.skin)
        ? msg.skin
        : SKIN_PRESETS[Math.floor(Math.random() * SKIN_PRESETS.length)];

      playerId = uid();
      const player = makeSnake(playerId, name, skin);
      players.set(playerId, player);
      clients.set(playerId, ws);
      newSpawns.push(player);   // broadcast to existing clients in next tick
      sendInit(ws, player);
      return;
    }

    if (!playerId) return;

    // ── input ──
    if (msg.type === 'input') {
      const p = players.get(playerId);
      if (!p || !p.alive) return;
      const angle = parseFloat(msg.angle);
      if (!isNaN(angle)) p.inputAngle = normDeg(angle);
      p.boosting = !!msg.boost && p.segments.length > MIN_LENGTH && p.score > 0;
      return;
    }

    // ── resync ──
    if (msg.type === 'resync') {
      const p = players.get(playerId);
      if (p) sendInit(ws, p);
      return;
    }

    // ── ping ──
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: msg.ts, server_ts: Date.now() }));
    }
  });

  ws.on('close', () => {
    if (!playerId) return;
    const p = players.get(playerId);
    if (p) killPlayer(p, null);
    players.delete(playerId);
    clients.delete(playerId);
    playerId = null;
  });

  ws.on('error', () => ws.terminate());
});

// ─── Bot AI ───────────────────────────────────────────────────────────────────
const BOT_NAMES  = ['Noodle','Zigzag','Spiral','Chomper','Wiggles','Slithero','Coily'];
const BOT_COLORS = ['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#c77dff','#ff9f43','#48dbfb'];

function spawnBot(index) {
  const id   = `bot-${index}`;
  const name = BOT_NAMES[index % BOT_NAMES.length];
  const skin = BOT_COLORS[index % BOT_COLORS.length];
  const bot  = makeSnake(id, name, skin);
  bot.isBot        = true;
  bot.targetFoodId = null;

  // ── Pre-settle initial heading to prevent spawn spinning ─────────────────
  // Simulate the same cone-based food selection used by tickBots() up to 5
  // times, instantly snapping bot.angle each iteration until it converges on
  // a stable food target, then rebuild the body trail so segments align with
  // the settled direction.
  const hx = bot.segments[0].x;
  const hy = bot.segments[0].y;

  // Density grid for spawn-settle (one-time build — spawn is rare)
  const spawnDensityGrid = buildDensityGrid();
  for (let iter = 0; iter < 5; iter++) {
    // Matches tickBots() scoring: f.value × cos⁴ × densityMult / (d+120)
    let bestScore = -Infinity, bestFood = null;
    let bestAlign = -Infinity, fFwd = null;
    for (const f of foods.values()) {
      const dx = f.x - hx, dy = f.y - hy;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d > BOT_SEARCH_RADIUS || d < 1) continue;
      const fAngle    = normDeg(Math.atan2(dy, dx) * 180 / Math.PI);
      const alignDiff = Math.abs(angleDiffDeg(bot.angle, fAngle));
      const alignment = 180 - alignDiff;
      if (alignment > bestAlign) { bestAlign = alignment; fFwd = f; }
      if (alignDiff >= 90) continue;
      const cosA  = Math.cos(alignDiff * Math.PI / 180);
      const cos4  = cosA * cosA * cosA * cosA;
      const n     = densityAt(spawnDensityGrid, f.x, f.y);
      const score = (f.value || 1) * cos4 * (1 + n / DENSITY_AVG) / (d + 120);
      if (score > bestScore) { bestScore = score; bestFood = f; }
    }
    if (!bestFood) bestFood = fFwd;
    if (!bestFood) break;

    const targetAngle = normDeg(
      Math.atan2(bestFood.y - hy, bestFood.x - hx) * 180 / Math.PI
    );
    bot.targetFoodId = bestFood.id;

    // Converged: angle is already pointing at chosen food
    if (Math.abs(angleDiffDeg(bot.angle, targetAngle)) < 1) break;

    // Instant snap (no physics clamp) — next iteration re-scores with new angle
    bot.angle = targetAngle;
  }

  // Rebuild segments trail from settled angle so body is straight behind head
  const rad  = degToRad(bot.angle);
  const head = bot.segments[0];
  bot.segments = [];
  for (let i = 0; i < INIT_LENGTH; i++) {
    bot.segments.push({
      x: head.x - Math.cos(rad) * i * SNAKE_SPEED,
      y: head.y - Math.sin(rad) * i * SNAKE_SPEED,
    });
  }
  bot.inputAngle = bot.angle;   // sync so first-tick diff is ≈ 0°

  players.set(id, bot);
  return bot;
}

// ── Density grid helpers ──────────────────────────────────────────────────────
// Build a flat Uint16Array counting food pellets per DENSITY_CELL×DENSITY_CELL
// grid cell.  O(N_food) per call — called once at the top of tickBots().
function buildDensityGrid() {
  const grid = new Uint16Array(DENSITY_COLS * DENSITY_ROWS);
  for (const f of foods.values()) {
    const ci = Math.min(Math.floor(f.x / DENSITY_CELL), DENSITY_COLS - 1);
    const ri = Math.min(Math.floor(f.y / DENSITY_CELL), DENSITY_ROWS - 1);
    grid[ri * DENSITY_COLS + ci]++;
  }
  return grid;
}

// Sum food count in the 3×3 neighborhood of the cell containing (x,y).  O(1).
function densityAt(grid, x, y) {
  const ci = Math.min(Math.max(Math.floor(x / DENSITY_CELL), 0), DENSITY_COLS - 1);
  const ri = Math.min(Math.max(Math.floor(y / DENSITY_CELL), 0), DENSITY_ROWS - 1);
  let sum = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = ri + dr, c = ci + dc;
      if (r >= 0 && r < DENSITY_ROWS && c >= 0 && c < DENSITY_COLS)
        sum += grid[r * DENSITY_COLS + c];
    }
  }
  return sum;
}

function tickBots() {
  // ── 0. Build density grid once per tick (O(N_food), shared across all bots) ─
  // densityMult = 1 + neighbourhood_count / DENSITY_AVG gives ~1× at average
  // density and up to ~3-4× at tight food clusters.
  const densityGrid = buildDensityGrid();

  // Pre-collect alive snakes once (shared by all bots — O(players) per tick)
  const aliveSnakes = Array.from(players.values()).filter(o => o.alive);

  for (const p of players.values()) {
    if (!p.isBot || !p.alive) continue;

    const hx    = p.segments[0].x, hy = p.segments[0].y;
    const myLen = p.segments.length;

    // ── 1. Sticky target: reuse last target if still valid ────────────────────
    let targetFood = p.targetFoodId ? foods.get(p.targetFoodId) : null;
    if (targetFood) {
      const dx = targetFood.x - hx, dy = targetFood.y - hy;
      if (Math.sqrt(dx * dx + dy * dy) > BOT_MAX_TARGET) {
        targetFood = null;   // too far — re-search
        p.targetFoodId = null;
      }
    }

    // ── 2. Re-select when no valid sticky target ──────────────────────────────
    // Scoring formula: f.value × cos⁴(alignDiff) × densityMult / (d + 120)
    //   · f.value      — prioritises big (value=3) pellets and boost-ejected food
    //   · cos⁴         — strongly forward-biased; 30°-off food needs 1.8× closer
    //   · densityMult  = 1 + neighbourhood / DENSITY_AVG
    //                  — steers toward food clusters even when slightly off-axis
    //   · (d + 120)    — distance denominator; 120 prevents runaway near-bias
    let rawBestScore = 0;
    if (!targetFood) {
      let bestScore = -Infinity;
      let bestFwd = -Infinity, fFwd = null;
      for (const f of foods.values()) {
        const dx = f.x - hx, dy = f.y - hy;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d > BOT_SEARCH_RADIUS || d < 1) continue;
        const fAngle    = normDeg(Math.atan2(dy, dx) * 180 / Math.PI);
        const alignDiff = Math.abs(angleDiffDeg(p.angle, fAngle));
        const alignment = 180 - alignDiff;
        // Fallback: track the most-forward food in case nothing passes the cone
        if (alignment > bestFwd) { bestFwd = alignment; fFwd = f; }
        if (alignDiff >= 90) continue;
        const cosA          = Math.cos(alignDiff * Math.PI / 180);
        const cos4          = cosA * cosA * cosA * cosA;
        const neighbourhood = densityAt(densityGrid, f.x, f.y);
        const densityMult   = 1 + neighbourhood / DENSITY_AVG;
        const score         = (f.value || 1) * cos4 * densityMult / (d + 120);
        if (score > bestScore) { bestScore = score; targetFood = f; rawBestScore = score; }
      }
      if (!targetFood) { targetFood = fFwd; rawBestScore = 0; }
      p.targetFoodId = targetFood ? targetFood.id : null;
    } else {
      p.targetFoodId = targetFood.id;
      // Re-compute score for quality estimate on sticky target
      const dx = targetFood.x - hx, dy = targetFood.y - hy;
      const d  = Math.sqrt(dx * dx + dy * dy);
      const fAngle    = normDeg(Math.atan2(dy, dx) * 180 / Math.PI);
      const alignDiff = Math.abs(angleDiffDeg(p.angle, fAngle));
      if (alignDiff < 90) {
        const cosA = Math.cos(alignDiff * Math.PI / 180);
        const n    = densityAt(densityGrid, targetFood.x, targetFood.y);
        rawBestScore = (targetFood.value || 1) * cosA * cosA * cosA * cosA *
                       (1 + n / DENSITY_AVG) / (d + 120);
      }
    }

    // ── 3. Steer toward target ────────────────────────────────────────────────
    let bestAngle = p.angle;
    if (targetFood) {
      bestAngle = normDeg(
        Math.atan2(targetFood.y - hy, targetFood.x - hx) * 180 / Math.PI
      );
    }

    // ── 4. Soft wall repulsion ────────────────────────────────────────────────
    // Smoothly blend food direction with wall-escape direction based on how
    // close the bot is to each wall.  Repulsion starts at SOFT_R px from the
    // wall and reaches full strength at HARD_R.  This eliminates the 90-180°
    // hard overrides that caused path collapse.
    const SOFT_R = 700;           // repulsion radius (px)
    const HARD_R = 200;           // innermost zone: full override (safety net)
    let repX = 0, repY = 0;
    const dl = hx - BORDER,      dr = WORLD_W - BORDER - hx;
    const dt = hy - BORDER,      db = WORLD_H - BORDER - hy;
    const nearDist = Math.min(dl, dr, dt, db);
    if (nearDist < SOFT_R) {
      if (dl < SOFT_R) repX += (SOFT_R - dl) / SOFT_R;
      if (dr < SOFT_R) repX -= (SOFT_R - dr) / SOFT_R;
      if (dt < SOFT_R) repY += (SOFT_R - dt) / SOFT_R;
      if (db < SOFT_R) repY -= (SOFT_R - db) / SOFT_R;
      const repAngle = normDeg(Math.atan2(repY, repX) * 180 / Math.PI);
      // blend strength: 0 at SOFT_R, 1 at HARD_R (or closer)
      const strength = Math.min(1.0, (SOFT_R - nearDist) / (SOFT_R - HARD_R));
      const bRad = degToRad(bestAngle), rRad = degToRad(repAngle);
      const bx2  = Math.cos(bRad) * (1 - strength) + Math.cos(rRad) * strength;
      const by2  = Math.sin(bRad) * (1 - strength) + Math.sin(rRad) * strength;
      bestAngle  = normDeg(Math.atan2(by2, bx2) * 180 / Math.PI);
      p.targetFoodId = null;   // re-search after clearing the wall zone
    }
    // bestAngle now has wall repulsion baked in — used as base for the
    // threat/hunt overrides below.

    // ── 5. Threat avoidance: two-zone detection ──────────────────────────────
    // WARN_R (420 px) — pre-warning: gentle deflection away from approaching
    //   longer snake so the bot starts turning early, before it's in real danger.
    // DANGER_R (250 px, constant) — strong escape + boost: proximity-weighted
    //   blend that fully overrides food angle as the threat closes in.
    // Both zones require approach > 0.15 (threat roughly aimed at us).
    const WARN_R   = 420;
    const WARN_R2  = WARN_R * WARN_R;
    const DANGER_R2 = DANGER_R * DANGER_R;

    let threatAngle    = null;
    let threatStrength = 0;   // strong (DANGER_R) signal
    let warnAngle      = null;
    let warnStrength   = 0;   // soft (WARN_R) signal

    for (const o of aliveSnakes) {
      if (o.id === p.id) continue;
      if (o.segments.length <= myLen) continue;          // only longer snakes

      const ohx = o.segments[0].x, ohy = o.segments[0].y;
      const dSq = distSq(hx, hy, ohx, ohy);
      if (dSq > WARN_R2) continue;

      const d      = Math.sqrt(dSq);
      const oRad   = degToRad(o.angle);
      const toUsX  = (hx - ohx) / d;
      const toUsY  = (hy - ohy) / d;
      // approach > 0  ⇒  threat heading toward us
      const approach = Math.cos(oRad) * toUsX + Math.sin(oRad) * toUsY;
      if (approach < 0.15) continue;                    // not aimed at us

      // Escape direction: directly away from the threat head
      const escAngle = normDeg(Math.atan2(hy - ohy, hx - ohx) * 180 / Math.PI);

      if (dSq < DANGER_R2) {
        // Strong zone: proximity × approach → 0..1
        const str = ((DANGER_R - d) / DANGER_R) * approach;
        if (str > threatStrength) { threatStrength = str; threatAngle = escAngle; }
      } else {
        // Soft pre-warning zone: weaker, only deflects gently
        const str = ((WARN_R - d) / WARN_R) * approach * 0.45;
        if (str > warnStrength) { warnStrength = str; warnAngle = escAngle; }
      }
    }

    // ── 6. Hunt: cut off shorter snakes ───────────────────────────────────────
    // Target any alive snake (bots included) that is shorter than us and within
    // HUNT_R.  Predict its path 12 ticks forward and aim for the intercept
    // (cut-off manoeuvre).  Prey may be anywhere in the forward 180° — we don't
    // require it to be directly ahead, only not strictly behind us.
    // Skip entirely when under a meaningful threat — survival first.
    let huntAngle    = null;
    let huntStrength = 0;

    if (threatStrength < 0.20) {
      for (const o of aliveSnakes) {
        if (o.id === p.id) continue;
        if (o.segments.length >= myLen) continue;        // only hunt strictly shorter snakes (prevents mutual-chase orbit)

        const ohx = o.segments[0].x, ohy = o.segments[0].y;
        const dSq = distSq(hx, hy, ohx, ohy);
        if (dSq > HUNT_R * HUNT_R) continue;

        const d       = Math.sqrt(dSq);
        const myRad   = degToRad(p.angle);
        const toPreyX = (ohx - hx) / d;
        const toPreyY = (ohy - hy) / d;
        // forward ≥ 0  ⇒  prey is anywhere in the forward hemisphere
        const forward = Math.cos(myRad) * toPreyX + Math.sin(myRad) * toPreyY;
        if (forward < 0.0) continue;                   // ignore prey strictly behind

        // Predict prey position 12 ticks ahead and aim for intercept
        const PREDICT  = 12;
        const oRad     = degToRad(o.angle);
        const oSpd     = o.boosting ? BOOST_SPEED : SNAKE_SPEED;
        const predX    = ohx + Math.cos(oRad) * oSpd * PREDICT;
        const predY    = ohy + Math.sin(oRad) * oSpd * PREDICT;
        const itcAngle = normDeg(Math.atan2(predY - hy, predX - hx) * 180 / Math.PI);

        // Strength: forward alignment × proximity (0 at edge, peaks close + ahead)
        const str = forward * (1 - d / HUNT_R);
        if (str > huntStrength) { huntStrength = str; huntAngle = itcAngle; }
      }
    }

    // ── 7. Compose final angle & decide boost ────────────────────────────────
    // Priority (highest first): strong threat > hunt > pre-warn > food+wall
    // Boost: always for DANGER_R escape; only for strong hunt opportunity.
    let finalAngle  = bestAngle;
    let shouldBoost = false;
    const canBoost  = myLen > MIN_LENGTH && p.score > 0;

    if (threatAngle !== null) {
      // Strong escape: blend food→escape, ts→1 as threat closes in
      const ts   = Math.min(1.0, threatStrength * 1.8);
      const bRad = degToRad(bestAngle), eRad = degToRad(threatAngle);
      const bx2  = Math.cos(bRad) * (1 - ts) + Math.cos(eRad) * ts;
      const by2  = Math.sin(bRad) * (1 - ts) + Math.sin(eRad) * ts;
      finalAngle  = normDeg(Math.atan2(by2, bx2) * 180 / Math.PI);
      shouldBoost = canBoost;        // always boost to escape lethal threats
    } else if (huntAngle !== null) {
      // Hunt intercept: moderate blend, don't entirely abandon food
      const hs   = Math.min(0.75, huntStrength * 1.3);
      const bRad = degToRad(bestAngle), hRad = degToRad(huntAngle);
      const bx2  = Math.cos(bRad) * (1 - hs) + Math.cos(hRad) * hs;
      const by2  = Math.sin(bRad) * (1 - hs) + Math.sin(hRad) * hs;
      finalAngle  = normDeg(Math.atan2(by2, bx2) * 180 / Math.PI);
      shouldBoost = canBoost && huntStrength > 0.35; // boost only for strong opportunities
    } else if (warnAngle !== null) {
      // Pre-warning: very gentle deflection — preserves food angle mostly
      const ws   = Math.min(0.35, warnStrength * 1.5);
      const bRad = degToRad(bestAngle), wRad = degToRad(warnAngle);
      const bx2  = Math.cos(bRad) * (1 - ws) + Math.cos(wRad) * ws;
      const by2  = Math.sin(bRad) * (1 - ws) + Math.sin(wRad) * ws;
      finalAngle  = normDeg(Math.atan2(by2, bx2) * 180 / Math.PI);
      // no boost in pre-warning zone
    }

    // ── 8. Publish state ─────────────────────────────────────────────────────
    const myDensity = densityAt(densityGrid, hx, hy);
    p.botFood = {
      angle:   bestAngle,
      score:   Math.min(1, rawBestScore * 150),
      density: myDensity / (DENSITY_AVG * 9),
    };

    p.inputAngle = finalAngle;
    p.boosting   = shouldBoost;
  }
}

// Respawn dead bots periodically
function maintainBots() {
  for (let i = 0; i < BOT_COUNT; i++) {
    const id = `bot-${i}`;
    const existing = players.get(id);
    if (!existing || !existing.alive) {
      if (existing) players.delete(id);
      const bot = spawnBot(i);
      newSpawns.push(bot);
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
for (let i = 0; i < FOOD_TARGET; i++) spawnFood();

// Spawn initial bots
for (let i = 0; i < BOT_COUNT; i++) spawnBot(i);

// Bot tick runs inside game tick
const _origTick = tick;
// Patch tick to include bot AI before physics
setInterval(() => {
  tickBots();
  tick();
}, TICK_MS);

setInterval(maintainBots, 5000); // revive dead bots every 5s

server.listen(PORT, () => {
  console.log(`🐍 Slither Multiplayer — http://localhost:${PORT}`);
});
