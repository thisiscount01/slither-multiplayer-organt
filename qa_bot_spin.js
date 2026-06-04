'use strict';
/**
 * QA: Bot Spinning Bug — Reproduce & Diagnose
 *
 * 접속 후 tick 메시지에서 모든 봇(id: bot-N)의 angle·head(x,y)를
 * 틱 단위로 추적합니다.
 *
 * 측정 지표:
 *   - dAngle: 틱 간 실제 각도 변화 (부호 있음, -180~+180)
 *   - spinning 판정: |dAngle| >= 7.5° (≈MAX_TURN_DEG=8°) 를 15틱 이상 연속
 *   - positional lock: 15틱 동안 head 이동 반경 < 100px (제자리 맴돌기)
 */

const WebSocket = require('ws');
const OBSERVE_MS   = 20000;   // 20초 관찰 (60s 제한 내)
const TICK_MS      = 50;
const MAX_TURN     = 8;       // degrees/tick (server constant)
const SPIN_THRESH  = MAX_TURN * 0.93;  // 7.44° — max-turn 근접
const SPIN_MIN_RUN = 15;      // 연속 틱 수
const POS_RADIUS   = 100;     // 위치 고착 반경 (px)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normDeg(d) { return ((d % 360) + 360) % 360; }
function angleDiff(from, to) {
  let d = normDeg(to) - normDeg(from);
  if (d >  180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

async function main() {
  console.log('=== Bot Spin Diagnostic ===');
  console.log(`Observing ${OBSERVE_MS/1000}s — MAX_TURN=${MAX_TURN}°/tick, spin_thresh=${SPIN_THRESH.toFixed(1)}°, spin_min_run=${SPIN_MIN_RUN} ticks\n`);

  const ws   = new WebSocket('ws://localhost:3000');
  const msgs = [];

  await new Promise((res, rej) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name: 'QA_observer', skin: '#ffffff' })));
    ws.on('message', raw => {
      try { msgs.push(JSON.parse(raw)); } catch {}
    });
    ws.on('error', rej);
    ws.on('close', () => {});
    // Wait for init
    const iv = setInterval(() => {
      if (msgs.some(m => m.type === 'init')) { clearInterval(iv); res(); }
    }, 50);
    setTimeout(() => { clearInterval(iv); rej(new Error('init timeout')); }, 6000);
  });

  const init = msgs.find(m => m.type === 'init');
  const bots = init.players.filter(p => p.id.startsWith('bot-'));
  console.log(`Server init: ${init.players.length} players (bots: ${bots.length}), tick=${init.tick}`);
  if (bots.length === 0) { console.log('WARNING: no bots visible at init'); }

  // Per-bot state
  const botState = new Map();  // id → { angle, x, y, tick }
  const botTrace = new Map();  // id → [{ tick, angle, dAngle, x, y }]
  const botSpins = new Map();  // id → [{ startTick, endTick, direction, ticks, headRange }]

  for (const b of bots) {
    botState.set(b.id, { angle: b.angle, x: b.segments[0].x, y: b.segments[0].y, tick: init.tick });
    botTrace.set(b.id, []);
    botSpins.set(b.id, []);
  }

  // Observe for OBSERVE_MS
  await sleep(OBSERVE_MS);
  ws.close();
  await sleep(200);

  const tickMsgs = msgs.filter(m => m.type === 'tick');
  console.log(`Collected ${tickMsgs.length} tick messages\n`);

  // ── Replay tick messages ────────────────────────────────────────────────
  for (const t of tickMsgs) {
    for (const mv of (t.moves || [])) {
      if (!mv.id.startsWith('bot-')) continue;
      if (!mv.head) continue;

      const prev = botState.get(mv.id);
      if (!prev) {
        // New bot appeared
        botState.set(mv.id, { angle: mv.angle, x: mv.head.x, y: mv.head.y, tick: t.tick });
        botTrace.set(mv.id, []);
        botSpins.set(mv.id, []);
        continue;
      }

      const dAngle = angleDiff(prev.angle, mv.angle);
      botTrace.get(mv.id).push({
        tick:   t.tick,
        angle:  mv.angle,
        dAngle,
        x:      mv.head.x,
        y:      mv.head.y,
      });
      botState.set(mv.id, { angle: mv.angle, x: mv.head.x, y: mv.head.y, tick: t.tick });
    }

    // Handle new bots from spawns
    for (const sp of (t.spawns || [])) {
      if (!sp.id.startsWith('bot-')) continue;
      if (!botState.has(sp.id)) {
        botState.set(sp.id, { angle: sp.angle, x: sp.segments[0].x, y: sp.segments[0].y, tick: t.tick });
        botTrace.set(sp.id, []);
        botSpins.set(sp.id, []);
      }
    }
  }

  // ── Spin detection ──────────────────────────────────────────────────────
  for (const [id, trace] of botTrace) {
    const spins = botSpins.get(id);
    let run = 0, runSign = 0, runStart = 0;
    const runXs = [], runYs = [];

    for (let i = 0; i < trace.length; i++) {
      const e = trace[i];
      const sign = Math.sign(e.dAngle);

      if (Math.abs(e.dAngle) >= SPIN_THRESH && sign === runSign) {
        run++;
        runXs.push(e.x); runYs.push(e.y);
      } else {
        // Flush previous run
        if (run >= SPIN_MIN_RUN) {
          const xs = runXs.slice(), ys = runYs.slice();
          const cx = xs.reduce((a,b)=>a+b,0)/xs.length;
          const cy = ys.reduce((a,b)=>a+b,0)/ys.length;
          const maxR = Math.max(...xs.map((x,i) => Math.sqrt((x-cx)**2+(ys[i]-cy)**2)));
          spins.push({
            startTick: trace[runStart].tick,
            endTick:   trace[i-1].tick,
            direction: runSign > 0 ? 'CCW(+)' : 'CW(-)',
            ticks:     run,
            headRadius: maxR.toFixed(1),
            centerX:    cx.toFixed(1),
            centerY:    cy.toFixed(1),
          });
        }
        // Start new run
        run = Math.abs(e.dAngle) >= SPIN_THRESH ? 1 : 0;
        runSign = sign;
        runStart = i;
        runXs.length = 0; runYs.length = 0;
        if (run) { runXs.push(e.x); runYs.push(e.y); }
      }
    }
    // Final run
    if (run >= SPIN_MIN_RUN) {
      const xs = runXs.slice(), ys = runYs.slice();
      const cx = xs.reduce((a,b)=>a+b,0)/xs.length;
      const cy = ys.reduce((a,b)=>a+b,0)/ys.length;
      const maxR = Math.max(...xs.map((x,i) => Math.sqrt((x-cx)**2+(ys[i]-cy)**2)));
      spins.push({
        startTick: trace[runStart].tick,
        endTick:   trace[trace.length-1].tick,
        direction: runSign > 0 ? 'CCW(+)' : 'CW(-)',
        ticks:     run,
        headRadius: maxR.toFixed(1),
        centerX:    cx.toFixed(1),
        centerY:    cy.toFixed(1),
      });
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────
  let totalSpins = 0;

  for (const [id, trace] of botTrace) {
    const spins = botSpins.get(id);
    const name  = bots.find(b => b.id === id)?.name ?? id;
    console.log(`Bot [${id}] "${name}"  trace=${trace.length}틱  spins=${spins.length}`);

    if (spins.length > 0) {
      totalSpins += spins.length;
      for (const sp of spins) {
        console.log(`  SPIN: tick ${sp.startTick}~${sp.endTick} (${sp.ticks}틱, ${sp.direction}) center=(${sp.centerX},${sp.centerY}) headRadius=${sp.headRadius}px`);
      }

      // Print detailed angle trace for first spin episode
      const firstSpin = spins[0];
      const spinTrace = trace.filter(e => e.tick >= firstSpin.startTick - 2 && e.tick <= firstSpin.startTick + 20);
      console.log(`  상세(첫 스핀 ±2틱):`);
      console.log(`  ${'tick'.padStart(6)} ${'angle'.padStart(8)} ${'dAngle'.padStart(8)} ${'x'.padStart(9)} ${'y'.padStart(9)}`);
      for (const e of spinTrace) {
        const flag = Math.abs(e.dAngle) >= SPIN_THRESH ? ' ← MAX' : '';
        console.log(`  ${String(e.tick).padStart(6)} ${e.angle.toFixed(2).padStart(8)} ${e.dAngle.toFixed(2).padStart(8)} ${e.x.toFixed(1).padStart(9)} ${e.y.toFixed(1).padStart(9)}${flag}`);
      }
    } else {
      // Even without full spin, show dAngle distribution
      const maxFlips = trace.filter(e => Math.abs(e.dAngle) >= SPIN_THRESH);
      const maxRateRatio = (maxFlips.length / Math.max(1, trace.length) * 100).toFixed(1);
      console.log(`  최대회전속도 도달: ${maxFlips.length}틱 / ${trace.length}틱 (${maxRateRatio}%)`);

      // Sample first 10 ticks
      if (trace.length > 0) {
        console.log(`  첫 10틱 각도 트레이스:`);
        for (const e of trace.slice(0, 10)) {
          console.log(`    tick=${e.tick} angle=${e.angle.toFixed(2)} dAngle=${e.dAngle.toFixed(2)} pos=(${e.x.toFixed(1)},${e.y.toFixed(1)})`);
        }
      }
    }
    console.log();
  }

  // ── Root cause analysis ─────────────────────────────────────────────────
  console.log('=== ROOT CAUSE ANALYSIS ===');

  // Check: how often do bots hit max turn rate?
  let totalTicks = 0, maxTurnTicks = 0;
  for (const trace of botTrace.values()) {
    for (const e of trace) {
      totalTicks++;
      if (Math.abs(e.dAngle) >= SPIN_THRESH) maxTurnTicks++;
    }
  }
  const maxTurnPct = (maxTurnTicks / Math.max(1, totalTicks) * 100).toFixed(1);
  console.log(`전체 봇 이동 틱: ${totalTicks}  최대회전속도 도달: ${maxTurnTicks}틱 (${maxTurnPct}%)`);
  console.log(`스핀 에피소드(≥${SPIN_MIN_RUN}틱 연속 최대회전): ${totalSpins}건`);

  if (maxTurnPct > 20) {
    console.log('\n[DIAGNOSIS] 봇이 전체 이동의 ' + maxTurnPct + '%에서 최대회전속도(8°/틱)에 도달.');
    console.log('원인 후보: inputAngle이 매 틱 급격히 교체되어 angle이 따라잡지 못함.');
    console.log('→ tickBots()의 스티어링 타겟(음식 방향) 이력 없이 즉각 덮어쓰기가 원인.');
  } else {
    console.log('\n[DIAGNOSIS] 최대회전속도 도달 비율이 낮음 — 다른 원인 추가 조사 필요.');
  }

  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
