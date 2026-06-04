'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const TICK_MS      = 50;
const HEAD_R       = 10;   // render head radius (base — use headR(len) for dynamic)
const BODY_R       = 7;    // render body radius (base — use bodyR(len) for dynamic)
const FOOD_R       = 6;    // render food radius
const MM_SIZE      = 160;  // minimap canvas size
const INPUT_HZ     = 20;   // input send rate
const CAM_LERP     = 0.12; // camera smoothing

// Color presets (match server)
const SKIN_PRESETS = [
  '#e74c3c','#2ecc71','#3498db','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#e91e63','#00bcd4','#8bc34a',
  '#ff5722','#795548','#ff9800','#cddc39','#607d8b',
];

// ─── DOM refs ────────────────────────────────────────────────────────────────
const landing      = document.getElementById('landing');
const canvas       = document.getElementById('canvas');
const ctx          = canvas.getContext('2d');
const minimap      = document.getElementById('minimap');
const mmCtx        = minimap.getContext('2d');
const hud          = document.getElementById('hud');
const deathScreen  = document.getElementById('deathScreen');
const valScore     = document.getElementById('valScore');
const valLength    = document.getElementById('valLength');
const valPing      = document.getElementById('valPing');
const lbList       = document.getElementById('lbList');
const deathScore   = document.getElementById('deathScore');
const deathRank    = document.getElementById('deathRank');
const boostBarWrap = document.getElementById('boostBarWrap');
const boostFill    = document.getElementById('boostFill');
const boostPill    = document.getElementById('boostPill');
const valPlayers   = document.getElementById('valPlayers');

// Score flash helpers
let lastDisplayedScore = 0;
function flashScore(newScore) {
  if (newScore > lastDisplayedScore) {
    valScore.classList.remove('flash-red');
    valScore.classList.add('flash-green');
    setTimeout(() => valScore.classList.remove('flash-green'), 200);
  } else if (newScore < lastDisplayedScore) {
    valScore.classList.remove('flash-green');
    valScore.classList.add('flash-red');
    setTimeout(() => valScore.classList.remove('flash-red'), 300);
  }
  lastDisplayedScore = newScore;
}

// ─── Game state ───────────────────────────────────────────────────────────────
let ws        = null;
let myId      = null;
let myName    = 'Snake';
let mySkin    = SKIN_PRESETS[0];
let worldW    = 6000;
let worldH    = 6000;

// id → { id, name, skin, score, segments:[{x,y}],
//        angle, boosting, alive,
//        prevHead:{x,y}, lastHead:{x,y}, tickTime:ms }
const snakes = new Map();
// id → { id, x, y, value, color }
const foods  = new Map();
let leaderboard = [];

let cameraX = 3000, cameraY = 3000;
let tickCount = 0;

// Input
let mouseAngle = 0;   // degrees
let isBoosting = false;
let mouseScreen = { x: 0, y: 0 };

// Ping
let pingTs = 0, currentPing = 0;

// Camera zoom (dynamic — zooms out as snake grows)
let cameraZoom = 1.0;

// Floating score popups [{x, y, value, t}]
const scorePopups = [];

// Boost bar (visual length ratio)
let myLength = 20, myScore = 0;

// ─── Color picker setup ───────────────────────────────────────────────────────
const swatchContainer = document.getElementById('colorSwatches');
SKIN_PRESETS.forEach((c, i) => {
  const el = document.createElement('div');
  el.className = 'swatch' + (i === 0 ? ' active' : '');
  el.style.background = c;
  el.title = c;
  el.onclick = () => {
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    el.classList.add('active');
    mySkin = c;
  };
  swatchContainer.appendChild(el);
});

// ─── Landing → game ───────────────────────────────────────────────────────────
document.getElementById('playBtn').onclick = joinGame;
document.getElementById('nameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinGame();
});
document.getElementById('respawnBtn').onclick = () => {
  deathScreen.classList.add('hidden');
  joinGame();
};

function joinGame() {
  myName = document.getElementById('nameInput').value.trim().slice(0, 20) || 'Snake';
  landing.style.display = 'none';
  canvas.style.display = 'block';
  hud.classList.remove('hidden');
  resizeCanvas();

  if (ws && ws.readyState !== WebSocket.CLOSED) {
    sendJoin();
  } else {
    openWS();
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function openWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    sendJoin();
    setInterval(sendInput, 1000 / INPUT_HZ);
    setInterval(sendPing,  3000);
  };

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMsg(msg);
  };

  ws.onclose = () => { /* could show reconnect UI */ };
  ws.onerror = () => { /* ignore */ };
}

function sendJoin() {
  send({ type: 'join', name: myName, skin: mySkin });
}

function sendInput() {
  if (!myId) return;
  const s = snakes.get(myId);
  if (!s || !s.alive) return;
  send({ type: 'input', angle: mouseAngle, boost: isBoosting });
}

function sendPing() {
  pingTs = Date.now();
  send({ type: 'ping', ts: pingTs });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ─── Message handlers ─────────────────────────────────────────────────────────
function handleMsg(msg) {
  switch (msg.type) {
    case 'init':        onInit(msg);      break;
    case 'tick':        onTick(msg);      break;
    case 'self_death':  onDeath(msg);     break;
    case 'leaderboard': onLeaderboard(msg); break;
    case 'pong':        onPong(msg);      break;
    case 'error':       onError(msg);     break;
  }
}

function onInit(msg) {
  myId   = msg.playerId;
  worldW = msg.world.width;
  worldH = msg.world.height;
  tickCount = msg.tick;

  snakes.clear();
  foods.clear();

  for (const p of msg.players)  upsertSnake(p);
  for (const f of msg.food)     foods.set(f.id, f);

  if (valPlayers) valPlayers.textContent = Array.from(snakes.values()).filter(s => s.alive).length;

  // Snap camera to my head + initialize direction to avoid initial spinning
  const me = snakes.get(myId);
  if (me && me.segments.length) {
    cameraX = me.segments[0].x;
    cameraY = me.segments[0].y;
    mouseAngle = me.angle ?? 0;  // start pointing where snake is already heading
  }
}

function upsertSnake(p) {
  const head = p.segments && p.segments.length ? p.segments[0] : { x: 0, y: 0 };
  const existing = snakes.get(p.id);
  if (existing) {
    Object.assign(existing, {
      name: p.name, skin: p.skin, score: p.score,
      segments: p.segments, angle: p.angle ?? existing.angle,
      boosting: p.boosting ?? existing.boosting, alive: true,
      prevHead: { ...head }, lastHead: { ...head }, tickTime: Date.now(),
    });
  } else {
    snakes.set(p.id, {
      id: p.id, name: p.name, skin: p.skin, score: p.score,
      segments: p.segments ? [...p.segments] : [],
      angle: p.angle ?? 0, boosting: p.boosting ?? false, alive: true,
      prevHead: { ...head }, lastHead: { ...head }, tickTime: Date.now(),
    });
  }
}

function onTick(msg) {
  tickCount = msg.tick;
  const now = Date.now();

  // Moves: reconstruct segments
  for (const mv of (msg.moves || [])) {
    const s = snakes.get(mv.id);
    if (!s || !s.alive) continue;

    // Save previous head for interpolation
    s.prevHead  = s.segments.length ? { ...s.segments[0] } : { ...mv.head };
    s.lastHead  = { ...mv.head };
    s.tickTime  = now;
    if (mv.angle    !== undefined) s.angle    = mv.angle;
    if (mv.boosting !== undefined) s.boosting = mv.boosting;

    // Segment reconstruction
    // shrunk = tail ejected as food (net 0 without extra_shrunk)
    // extra_shrunk = additional pop so snake actually shrinks by 1
    s.segments.unshift({ x: mv.head.x, y: mv.head.y });
    if (!mv.grew || mv.shrunk) s.segments.pop();
    if (mv.extra_shrunk && s.segments.length > 1) s.segments.pop();
  }

  // Spawns (new players or respawns)
  for (const p of (msg.spawns || [])) upsertSnake(p);

  // Deaths
  for (const deadId of (msg.deaths || [])) {
    const s = snakes.get(deadId);
    if (s) s.alive = false;
  }

  // Food eaten
  for (const fid of (msg.food_eaten || [])) foods.delete(fid);

  // Food spawned
  for (const f of (msg.food_spawned || [])) foods.set(f.id, f);

  // Score deltas + floating popups
  for (const sc of (msg.scores || [])) {
    const s = snakes.get(sc.id);
    if (s) {
      if (sc.id === myId && s.segments.length) {
        const diff = sc.score - s.score;
        if (diff !== 0) {
          scorePopups.push({
            x: s.segments[0].x + (Math.random() - 0.5) * 30,
            y: s.segments[0].y - 20,
            value: diff,
            t: Date.now(),
          });
        }
      }
      s.score = sc.score;
    }
  }

  // Update HUD for self
  const me = snakes.get(myId);
  if (me) {
    const newScore = me.score;
    flashScore(newScore);
    myScore  = newScore;
    myLength = me.segments.length;
    valScore.textContent  = newScore.toLocaleString();
    valLength.textContent = me.segments.length;

    // Boost gauge: length ratio (max 300 for full bar)
    const ratio = Math.min(1, me.segments.length / 300);
    boostFill.style.width = (ratio * 100) + '%';
    if (isBoosting) {
      boostBarWrap.classList.add('visible');
      boostPill.classList.add('active');
    } else {
      boostBarWrap.classList.remove('visible');
      boostPill.classList.remove('active');
    }
  }

  // Live player count (all alive snakes incl. bots)
  if (valPlayers) valPlayers.textContent = Array.from(snakes.values()).filter(s => s.alive).length;
}

function onDeath(msg) {
  const me = snakes.get(myId);
  if (me) me.alive = false;
  isBoosting = false;  // reset boost state on death

  // Bug fix: clear boost UI immediately on death — onTick won't run for myId after myId=null,
  // so bar/pill would stay visible on the death screen unless explicitly cleaned up here.
  boostBarWrap.classList.remove('visible');
  boostPill.classList.remove('active');

  // Show killer name before clearing myId (killer still in snakes map)
  let killerText = '벽에 부딪혔습니다';
  if (msg.killed_by) {
    const killer = snakes.get(msg.killed_by);
    const killerName = killer ? killer.name : msg.killed_by;
    killerText = `${killerName}에게 잡혔습니다`;
  }

  myId = null;

  deathScore.textContent = `최종 점수: ${msg.score.toLocaleString()} — ${killerText}`;
  deathRank.textContent  = `순위: ${msg.rank}위`;
  deathScreen.classList.remove('hidden');
}

function onLeaderboard(msg) {
  leaderboard = msg.entries || [];
  lbList.innerHTML = '';
  for (const e of leaderboard) {
    const li  = document.createElement('li');
    li.className = e.id === myId ? 'me' : '';
    const rank  = document.createElement('span');
    rank.className = 'lb-rank';
    rank.textContent = `#${e.rank}`;
    const name  = document.createElement('span');
    name.className = 'lb-name';
    name.textContent = e.name.slice(0, 14);
    const score = document.createElement('span');
    score.className = 'lb-score';
    score.textContent = e.score.toLocaleString();
    li.append(rank, name, score);
    lbList.appendChild(li);
  }
}

function onPong(msg) {
  currentPing = Date.now() - (msg.ts || pingTs);
  valPing.textContent = currentPing;
}

function onError(msg) {
  alert(`서버 오류: ${msg.message}`);
}

// ─── Input ────────────────────────────────────────────────────────────────────
canvas.addEventListener('mousemove', e => {
  mouseScreen.x = e.clientX;
  mouseScreen.y = e.clientY;
  updateMouseAngle();
});

canvas.addEventListener('contextmenu', e => { e.preventDefault(); isBoosting = true; });
canvas.addEventListener('mouseup', e => { if (e.button === 2) isBoosting = false; });
canvas.addEventListener('mousedown', e => { if (e.button === 2) isBoosting = true; });

window.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); isBoosting = true; }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space') isBoosting = false;
});

function updateMouseAngle() {
  if (!myId) return;
  const me = snakes.get(myId);
  if (!me || !me.segments.length) return;
  const head = interpHead(me);
  const sx = (head.x - cameraX) * cameraZoom + canvas.width  / 2;
  const sy = (head.y - cameraY) * cameraZoom + canvas.height / 2;
  const dx = mouseScreen.x - sx;
  const dy = mouseScreen.y - sy;
  // Ignore cursor if too close to head — prevents oscillation / spinning
  const distSq = dx*dx + dy*dy;
  if (distSq < 30*30) return;
  mouseAngle = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
}

// ─── Render helpers ───────────────────────────────────────────────────────────
function interpHead(s) {
  if (!s.prevHead || !s.lastHead) {
    return s.segments.length ? s.segments[0] : { x: 0, y: 0 };
  }
  const t  = Math.min(1, (Date.now() - s.tickTime) / TICK_MS);
  return {
    x: s.prevHead.x + (s.lastHead.x - s.prevHead.x) * t,
    y: s.prevHead.y + (s.lastHead.y - s.prevHead.y) * t,
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function tintColor(hex, brightness) {
  const [r,g,b] = hexToRgb(hex);
  return `rgb(${Math.round(r*brightness)},${Math.round(g*brightness)},${Math.round(b*brightness)})`;
}

function degToRad(d) { return d * Math.PI / 180; }

// ─── Dynamic thickness (slither.io style: longer = fatter) ────────────────────
// len=20 → bodyR=7, headR=10  (same as original base values)
// len=100 → bodyR≈12.5, headR≈15.5
// len=250+ → bodyR=22, headR=25  (capped)
function bodyR(len) {
  return Math.min(22, 7 + Math.max(0, len - 20) * 0.065);
}
function headR(len) {
  return Math.min(26, bodyR(len) + 3);
}
function eyeR(len) {
  // Eye radius scales gently: 3.5 at start → 5.5 at max
  return Math.min(5.5, 3.5 + Math.max(0, len - 20) * 0.008);
}
function pupilR(len) {
  return eyeR(len) * 0.57;
}

// ─── Canvas resize ────────────────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── Main render loop ─────────────────────────────────────────────────────────
function render() {
  requestAnimationFrame(render);

  const W = canvas.width, H = canvas.height;

  // Camera follow
  const me = myId ? snakes.get(myId) : null;
  if (me && me.alive && me.segments.length) {
    const head = interpHead(me);
    cameraX += (head.x - cameraX) * CAM_LERP;
    cameraY += (head.y - cameraY) * CAM_LERP;
    updateMouseAngle();
  }

  // Dynamic zoom: zoom out as snake grows (1.0 at start → 0.45 when very long)
  const zoomTarget = (me && me.alive)
    ? Math.max(0.45, 1 - (me.segments.length - 20) / 380)
    : 1.0;
  cameraZoom += (zoomTarget - cameraZoom) * 0.04;

  const ox = W / 2 - cameraX;   // world → screen offset
  const oy = H / 2 - cameraY;

  // ── Background ────────────────────────────────────────────────────────────
  ctx.fillStyle = '#060614';
  ctx.fillRect(0, 0, W, H);

  // Apply zoom transform (scales world around screen center = camera position)
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(cameraZoom, cameraZoom);
  ctx.translate(-W / 2, -H / 2);

  // Grid
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  const GRID = 80;
  const gox  = ((ox % GRID) + GRID) % GRID;
  const goy  = ((oy % GRID) + GRID) % GRID;
  for (let x = gox; x <= W; x += GRID) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = goy; y <= H; y += GRID) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  ctx.restore();

  // World border (pulsing red glow)
  {
    const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 400);
    ctx.save();
    ctx.shadowColor = `rgba(231,76,60,${pulse})`;
    ctx.shadowBlur  = 30;
    ctx.strokeStyle = `rgba(231,76,60,${0.7 + 0.3 * pulse})`;
    ctx.lineWidth   = 4;
    ctx.strokeRect(ox, oy, worldW, worldH);
    ctx.restore();
  }

  // ── Food ──────────────────────────────────────────────────────────────────
  for (const f of foods.values()) {
    const fx = f.x + ox, fy = f.y + oy;
    const cullHalfW = (W/2)/cameraZoom + 20, cullHalfH = (H/2)/cameraZoom + 20;
    if (fx < W/2 - cullHalfW || fx > W/2 + cullHalfW || fy < H/2 - cullHalfH || fy > H/2 + cullHalfH) continue;
    const fr = f.size || FOOD_R;

    ctx.save();
    // Outer glow (brighter for larger death food)
    ctx.shadowColor = f.color;
    ctx.shadowBlur  = fr > 6 ? 16 : 8;
    ctx.beginPath();
    ctx.arc(fx, fy, fr, 0, Math.PI*2);
    ctx.fillStyle = f.color;
    ctx.fill();
    // Inner highlight
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(fx - fr*0.28, fy - fr*0.28, fr*0.35, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fill();
    ctx.restore();
  }

  // ── Snakes ────────────────────────────────────────────────────────────────
  for (const s of snakes.values()) {
    if (!s.alive || !s.segments.length) continue;

    const head    = interpHead(s);
    const hsx     = head.x + ox, hsy = head.y + oy;
    const isMe    = s.id === myId;

    // Viewport cull (generous margin for long snakes)
    if (hsx < -400 || hsx > W+400 || hsy < -400 || hsy > H+400) continue;

    // Build render array: interpolated head + body
    const rSegs = [head, ...s.segments.slice(1)];

    // Dynamic thickness based on snake length (slither.io style)
    const sLen = s.segments.length;
    const bR   = bodyR(sLen);   // body radius for this snake
    const hR   = headR(sLen);   // head radius for this snake
    const eR   = eyeR(sLen);    // eye white radius
    const pR   = pupilR(sLen);  // pupil radius

    ctx.save();

    // Boost glow
    if (s.boosting) {
      ctx.shadowColor = s.skin;
      ctx.shadowBlur  = 18;
    }

    // ── Body path (outline + fill) ──────────────────────────────────────────
    if (rSegs.length >= 2) {
      // Dark outline
      ctx.beginPath();
      ctx.moveTo(rSegs[0].x + ox, rSegs[0].y + oy);
      for (let i = 1; i < rSegs.length; i++) {
        const p  = rSegs[i-1], c = rSegs[i];
        const mx = (p.x + c.x) / 2 + ox;
        const my = (p.y + c.y) / 2 + oy;
        ctx.quadraticCurveTo(p.x + ox, p.y + oy, mx, my);
      }
      ctx.strokeStyle = tintColor(s.skin, 0.35);
      ctx.lineWidth   = (bR + 2) * 2;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.stroke();

      // Color fill
      ctx.beginPath();
      ctx.moveTo(rSegs[0].x + ox, rSegs[0].y + oy);
      for (let i = 1; i < rSegs.length; i++) {
        const p  = rSegs[i-1], c = rSegs[i];
        const mx = (p.x + c.x) / 2 + ox;
        const my = (p.y + c.y) / 2 + oy;
        ctx.quadraticCurveTo(p.x + ox, p.y + oy, mx, my);
      }
      ctx.strokeStyle = s.skin;
      ctx.lineWidth   = bR * 2;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.stroke();

      // Highlight stripe (top-center)
      ctx.beginPath();
      ctx.moveTo(rSegs[0].x + ox, rSegs[0].y + oy);
      for (let i = 1; i < Math.min(rSegs.length, 6); i++) {
        const p  = rSegs[i-1], c = rSegs[i];
        const mx = (p.x + c.x) / 2 + ox;
        const my = (p.y + c.y) / 2 + oy;
        ctx.quadraticCurveTo(p.x + ox, p.y + oy, mx, my);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth   = bR * 0.7;
      ctx.stroke();

    }

    ctx.shadowBlur = 0;

    // ── Head circle ─────────────────────────────────────────────────────────
    ctx.shadowColor = isMe ? s.skin : 'transparent';
    ctx.shadowBlur  = isMe ? 16 : 0;

    ctx.beginPath();
    ctx.arc(hsx, hsy, hR + 1, 0, Math.PI*2);
    ctx.fillStyle = tintColor(s.skin, 0.35);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(hsx, hsy, hR, 0, Math.PI*2);
    ctx.fillStyle = s.skin;
    ctx.fill();

    ctx.shadowBlur = 0;

    // ── Eyes ────────────────────────────────────────────────────────────────
    const rad  = degToRad(s.angle);
    const fwd  = { x: Math.cos(rad), y: Math.sin(rad) };
    const perp = { x: -Math.sin(rad), y: Math.cos(rad) };
    const EYE  = hR * 0.48;
    const eyes = [
      { x: hsx + fwd.x*EYE + perp.x*hR*0.5,
        y: hsy + fwd.y*EYE + perp.y*hR*0.5 },
      { x: hsx + fwd.x*EYE - perp.x*hR*0.5,
        y: hsy + fwd.y*EYE - perp.y*hR*0.5 },
    ];

    for (const eye of eyes) {
      ctx.beginPath();
      ctx.arc(eye.x, eye.y, eR, 0, Math.PI*2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      // Pupil facing movement direction
      ctx.beginPath();
      ctx.arc(eye.x + fwd.x*pR*0.75, eye.y + fwd.y*pR*0.75, pR, 0, Math.PI*2);
      ctx.fillStyle = '#111';
      ctx.fill();
    }

    // ── Name tag ────────────────────────────────────────────────────────────
    // Font size scales with snake thickness (12→18px) so names stay readable
    const nameFontSize = Math.round(Math.min(18, 12 + (hR - 10) * 0.4));
    ctx.font      = `${isMe ? 'bold ' : ''}${nameFontSize}px sans-serif`;
    ctx.textAlign = 'center';
    const tw = ctx.measureText(s.name).width;
    const ty = hsy - hR - 12;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const pad = 6;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(hsx - tw/2 - pad, ty - 13, tw + pad*2, 17, 4);
    } else {
      ctx.rect(hsx - tw/2 - pad, ty - 13, tw + pad*2, 17);
    }
    ctx.fill();

    ctx.fillStyle = isMe ? '#fff' : 'rgba(255,255,255,0.85)';
    ctx.fillText(s.name, hsx, ty);

    ctx.restore();
  }

  // End zoom transform — minimap & overlays are screen-space
  ctx.restore();

  // ── Minimap ───────────────────────────────────────────────────────────────
  renderMinimap();

  // ── Direction indicator + custom cursor ──────────────────────────────────
  drawDirectionAndCursor();

  // ── Score popups ──────────────────────────────────────────────────────────
  drawScorePopups();
}

// ─── Direction indicator & custom cursor ─────────────────────────────────────
function drawDirectionAndCursor() {
  const W = canvas.width, H = canvas.height;
  const mx = mouseScreen.x, my = mouseScreen.y;

  // Direction line from my snake head toward cursor
  if (myId) {
    const me = snakes.get(myId);
    if (me && me.alive && me.segments.length) {
      const head = interpHead(me);
      // Use zoom-corrected screen position
      const hsx = (head.x - cameraX) * cameraZoom + W / 2;
      const hsy = (head.y - cameraY) * cameraZoom + H / 2;
      const dx = mx - hsx, dy = my - hsy;
      const dist = Math.sqrt(dx*dx + dy*dy);

      if (dist > 30) {
        const ux = dx / dist, uy = dy / dist;
        const startDist = headR(me.segments.length) + 8;
        const lineDist  = Math.min(90, dist - 24);

        ctx.save();
        ctx.setLineDash([5, 9]);
        ctx.lineDashOffset = -(Date.now() / 60) % 14; // animated march
        ctx.strokeStyle = me.boosting
          ? 'rgba(255,111,0,0.55)'
          : 'rgba(255,255,255,0.30)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(hsx + ux * startDist, hsy + uy * startDist);
        ctx.lineTo(hsx + ux * (startDist + lineDist), hsy + uy * (startDist + lineDist));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }

  // Custom crosshair cursor
  ctx.save();
  const R = 9, GAP = 4, ARM = 7;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;

  // Outer circle
  ctx.beginPath();
  ctx.arc(mx, my, R, 0, Math.PI*2);
  ctx.stroke();

  // Cross arms (with gap)
  ctx.beginPath();
  ctx.moveTo(mx - R - ARM,    my);        ctx.lineTo(mx - R - GAP, my);
  ctx.moveTo(mx + R + GAP,    my);        ctx.lineTo(mx + R + ARM, my);
  ctx.moveTo(mx,    my - R - ARM);        ctx.lineTo(mx, my - R - GAP);
  ctx.moveTo(mx,    my + R + GAP);        ctx.lineTo(mx, my + R + ARM);
  ctx.stroke();

  // Center dot
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(mx, my, 1.5, 0, Math.PI*2);
  ctx.fill();

  ctx.restore();
}

// ─── Minimap ─────────────────────────────────────────────────────────────────
function renderMinimap() {
  const ms = MM_SIZE;
  const sx = ms / worldW;
  const sy = ms / worldH;

  mmCtx.clearRect(0, 0, ms, ms);

  // Background
  mmCtx.fillStyle = 'rgba(5,5,20,0.85)';
  mmCtx.fillRect(0, 0, ms, ms);

  // Food density (very small dots)
  for (const f of foods.values()) {
    mmCtx.fillStyle = f.color;
    mmCtx.fillRect(f.x * sx - 0.5, f.y * sy - 0.5, 1, 1);
  }

  // Snakes
  for (const s of snakes.values()) {
    if (!s.alive || !s.segments.length) continue;
    const hx = s.segments[0].x * sx;
    const hy = s.segments[0].y * sy;
    const isMe = s.id === myId;

    // Dot size scales with snake length (bigger snake = bigger dot on minimap)
    const mmDot = isMe ? 4 : Math.min(5, 1.5 + s.segments.length / 80);
    mmCtx.beginPath();
    mmCtx.arc(hx, hy, mmDot, 0, Math.PI*2);
    mmCtx.fillStyle = isMe ? '#fff' : s.skin;
    mmCtx.fill();

    if (isMe) {
      mmCtx.beginPath();
      mmCtx.arc(hx, hy, 4, 0, Math.PI*2);
      mmCtx.strokeStyle = 'rgba(255,255,255,0.6)';
      mmCtx.lineWidth = 1;
      mmCtx.stroke();
    }
  }

  // Viewport rect — must account for cameraZoom: visible world area = screen / zoom
  if (myId) {
    const vx = (cameraX - (canvas.width  / 2) / cameraZoom) * sx;
    const vy = (cameraY - (canvas.height / 2) / cameraZoom) * sy;
    const vw = (canvas.width  / cameraZoom) * sx;
    const vh = (canvas.height / cameraZoom) * sy;
    mmCtx.strokeStyle = 'rgba(255,255,255,0.35)';
    mmCtx.lineWidth = 1;
    mmCtx.strokeRect(vx, vy, vw, vh);
  }

  // World border on minimap
  mmCtx.strokeStyle = 'rgba(231,76,60,0.5)';
  mmCtx.lineWidth = 1.5;
  mmCtx.strokeRect(0, 0, ms, ms);
}

// ─── Score popups ────────────────────────────────────────────────────────────
function drawScorePopups() {
  const now = Date.now();
  const W = canvas.width, H = canvas.height;
  for (let i = scorePopups.length - 1; i >= 0; i--) {
    const p = scorePopups[i];
    const age = (now - p.t) / 900;  // 0→1 over 900 ms
    if (age >= 1) { scorePopups.splice(i, 1); continue; }
    const alpha = 1 - age * age;    // ease-out fade
    const sx = (p.x - cameraX) * cameraZoom + W / 2;
    const sy = (p.y - cameraY) * cameraZoom + H / 2 - age * 55;  // float up
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = p.value > 0 ? '#69ff47' : '#ff4444';
    ctx.fillText((p.value > 0 ? '+' : '') + p.value, sx, sy);
    ctx.restore();
  }
}

// ─── Start render loop ────────────────────────────────────────────────────────
render();
