'use strict';
/**
 * QA Playtest v3 — Slither Multiplayer
 * 서버 코드 직접 확인 후 작성된 정밀 검증 스크립트
 *
 * 서버 상수(server.js 직접 확인):
 *   MIN_LENGTH=10, BOOST_TICK_COST=5, SNAKE_SPEED=5, BOOST_SPEED=10
 *   p.boosting = !!msg.boost && segments.length > MIN_LENGTH && p.score > 0
 *   extra_shrunk: boost 비용 tick마다 2번 pop (shrunk + extra_shrunk)
 *   self-collision: if (o.id === s.id) continue; — 완전 비활성화
 */

const WebSocket = require('ws');
const SERVER_URL  = 'ws://localhost:3000';
const TICK_MS     = 50;
const MIN_LENGTH  = 10;
const BOOST_TICK_COST = 5;
const SNAKE_SPEED = 5;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connect(name, skin = '#3498db') {
  return new Promise((resolve, reject) => {
    const ws   = new WebSocket(SERVER_URL);
    const msgs = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, skin })));
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      msgs.push(msg);
      if (msg.type === 'init') resolve({ ws, msgs, init: msg });
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 6000);
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

// msgs 중 tick 메시지만, lastN 개를 원하면 slice(-N)
function ticks(msgs)       { return msgs.filter(m => m.type === 'tick'); }
function selfDeathMsg(msgs){ return msgs.find(m => m.type === 'self_death'); }

// 특정 player의 move 이벤트 수집
function myMoves(tickList, pid) {
  const out = [];
  for (const t of tickList)
    for (const mv of (t.moves || []))
      if (mv.id === pid) out.push(mv);
  return out;
}

const results = [];
function report(id, label, pass, detail) {
  results.push({ id, label, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} — ${label}`);
  console.log(`      ${detail}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== QA Playtest v3 — Slither Multiplayer ===\n');

  // ── ① score=0에서 boost=true → mv.boosting false 유지 ───────────────────
  // 서버: p.boosting = !!msg.boost && segs > MIN_LENGTH && p.score > 0
  // score=0이면 마지막 조건 false → p.boosting=false
  {
    console.log('── ① score=0에서 boost=true 전송 → mv.boosting 관찰 ──');
    const { ws, msgs, init } = await connect('QA_score0');
    const pid      = init.playerId;
    const initData = init.players.find(p => p.id === pid);
    const initSegs = initData?.segments.length ?? 20;
    const initScoreVal = initData?.score ?? 0;

    console.log(`  init: score=${initScoreVal}, segments=${initSegs}`);
    console.log(`  boost 전송 20틱 (score=${initScoreVal} 상태)…`);

    // 즉시 boost=true 20틱 전송 (score=0 상태)
    const SEND_N = 20;
    for (let i = 0; i < SEND_N; i++) {
      send(ws, { type: 'input', angle: 45, boost: true });
      await sleep(TICK_MS);
    }

    const allTicks = ticks(msgs);
    const moves    = myMoves(allTicks, pid);

    let mvTrue = 0, mvFalse = 0;
    let shrunkEvt = 0, extraShrunkEvt = 0;
    let scoreChanges = [];

    for (const mv of moves) {
      if (mv.boosting === true)    mvTrue++;
      if (mv.boosting === false)   mvFalse++;
      if (mv.shrunk)               shrunkEvt++;
      if (mv.extra_shrunk)         extraShrunkEvt++;
    }
    for (const t of allTicks)
      for (const sc of (t.scores || []))
        if (sc.id === pid) scoreChanges.push(sc.score);

    // 죽었는지 확인 (bot 충돌 가능성)
    const died = !!selfDeathMsg(msgs);

    const pass1 = mvTrue === 0 && moves.length >= 10 && !died;
    report('①', 'score=0 → mv.boosting false 유지',
      pass1,
      `initScore=${initScoreVal}, initSegs=${initSegs}; ` +
      `${moves.length}틱 확인: mv.boosting=true ${mvTrue}건 / false ${mvFalse}건; ` +
      `shrunk=${shrunkEvt}, extra_shrunk=${extraShrunkEvt}; ` +
      `scoreChanges=[${scoreChanges.join(',')}]; died=${died}`
    );
    ws.close();
    await sleep(400);
  }

  // ── ② score≥5 후 boost → score·segments 동시 감소 + extra_shrunk 횟수 ──
  {
    console.log('── ② score≥5 후 boost → score·segments 감소 (extra_shrunk 포함) ──');
    const { ws, msgs, init } = await connect('QA_drain');
    const pid      = init.players.find(p => true)?.id;  // self
    const selfPid  = init.playerId;
    const initSegs = init.players.find(p => p.id === selfPid)?.segments.length ?? 20;

    // Phase1: score≥5 수집 (최대 30초, 600틱)
    console.log('  Phase1: score≥5 수집 (최대 30초)…');
    let angle = 60;
    let latestScore = 0;
    let segCount = initSegs;
    let p1Done = false;

    for (let i = 0; i < 600 && !p1Done; i++) {
      if (i % 20 === 0) angle = (angle + 75) % 360;  // 넓게 커버
      send(ws, { type: 'input', angle, boost: false });
      await sleep(TICK_MS);

      // 마지막 tick의 score 체크
      const lastTick = ticks(msgs).slice(-1)[0];
      if (lastTick) {
        for (const sc of (lastTick.scores || []))
          if (sc.id === selfPid) latestScore = sc.score;
        if (latestScore >= 5) p1Done = true;
      }
    }

    // phase1 전체에서 정확한 segs 재구성
    const p1Ticks = ticks(msgs);
    segCount = initSegs;
    for (const mv of myMoves(p1Ticks, selfPid)) {
      if (mv.grew && !mv.shrunk) segCount++;
      if (!mv.grew && mv.shrunk) segCount--;
      // grew && shrunk: net 0 (서버: unshift + shrunk pop + extra_shrunk pop)
      // Wait, need to account for extra_shrunk too
      if (mv.extra_shrunk) segCount--;  // extra pop
    }
    const p1TickCount = p1Ticks.length;
    console.log(`  Phase1 완료 (${p1TickCount}틱): score=${latestScore}, segments≈${segCount}`);

    if (latestScore < 5) {
      report('②', 'score≥5 후 boost 동시 감소',
        false,
        `${p1TickCount}틱 후 score=${latestScore} (≥5 미달). 테스트 불가.`
      );
      ws.close();
      await sleep(400);
    } else {
      const snapScore = latestScore;
      const snapSegs  = segCount;
      const p2StartIdx = ticks(msgs).length;

      // Phase2: boost 60틱
      console.log(`  Phase2: boost 60틱 (시작 score=${snapScore}, segs≈${snapSegs})…`);
      for (let i = 0; i < 60; i++) {
        send(ws, { type: 'input', angle, boost: true });
        await sleep(TICK_MS);
      }

      const p2Ticks  = ticks(msgs).slice(p2StartIdx);
      const p2Moves  = myMoves(p2Ticks, selfPid);

      let finalScore   = snapScore;
      let finalSegs    = snapSegs;
      let shrunkCnt    = 0;
      let extraShrunkCnt = 0;
      let grewCnt      = 0;
      let scoreTrace   = [];
      let boostOnTicks = 0;

      for (const t of p2Ticks)
        for (const sc of (t.scores || []))
          if (sc.id === selfPid) { finalScore = sc.score; scoreTrace.push(sc.score); }

      for (const mv of p2Moves) {
        if (mv.boosting) boostOnTicks++;
        if (mv.shrunk)        { shrunkCnt++; finalSegs--; }
        if (mv.extra_shrunk)  { extraShrunkCnt++; finalSegs--; }
        if (mv.grew && !mv.shrunk) { grewCnt++; finalSegs++; }
      }

      const died = !!selfDeathMsg(msgs);

      // PASS: score 감소 + shrunk or extra_shrunk 발생
      const pass2 = (finalScore < snapScore) && (shrunkCnt > 0) && !died;
      report('②', 'score≥5 후 boost → score·segments 동시 감소',
        pass2,
        `score: ${snapScore}→${finalScore} (감소=${snapScore-finalScore}); ` +
        `segments: ${snapSegs}→${finalSegs}; ` +
        `shrunk=${shrunkCnt}, extra_shrunk=${extraShrunkCnt}, grew=${grewCnt}; ` +
        `boostOnTicks=${boostOnTicks}/${p2Moves.length}; ` +
        `scoreTrace=[${scoreTrace.slice(0,10).join(',')}]; died=${died}`
      );
      ws.close();
      await sleep(400);
    }
  }

  // ── ③ 90↔270 교번 급회전 100틱 → self-death 없음 ───────────────────────
  // 서버: if (o.id === s.id) continue; — 자기 충돌 완전 비활성화
  {
    console.log('── ③ 90↔270 교번 100틱 → self-death 없음 확인 ──');
    const { ws, msgs, init } = await connect('QA_zigzag');
    const pid = init.playerId;

    // 워밍업: 30틱 직진 → 몸통 축적
    console.log('  워밍업 30틱 (angle=90)…');
    for (let i = 0; i < 30; i++) {
      send(ws, { type: 'input', angle: 90, boost: false });
      await sleep(TICK_MS);
    }

    // 교번: 90↔270 100틱
    console.log('  교번(90↔270) 100틱…');
    for (let i = 0; i < 100; i++) {
      send(ws, { type: 'input', angle: i % 2 === 0 ? 90 : 270, boost: false });
      await sleep(TICK_MS);
    }

    const allTicks  = ticks(msgs);
    const deathMsg  = selfDeathMsg(msgs);
    let deathInTick = 0;
    for (const t of allTicks)
      if ((t.deaths || []).includes(pid)) deathInTick++;

    // 실제 서버에서 적용된 angle 범위 확인 (MAX_TURN_DEG=8°/tick)
    const allMoves   = myMoves(allTicks, pid);
    const angles     = allMoves.map(mv => mv.angle?.toFixed(1));
    const angleMin   = Math.min(...allMoves.map(mv => mv.angle ?? 0)).toFixed(1);
    const angleMax   = Math.max(...allMoves.map(mv => mv.angle ?? 0)).toFixed(1);
    const lastAngle  = allMoves.at(-1)?.angle?.toFixed(1) ?? '?';

    const pass3 = deathInTick === 0 && !deathMsg;
    report('③', '90↔270 교번 100틱 → self-death 없음',
      pass3,
      `총 ${allTicks.length}틱 확인; deaths[]에 자신: ${deathInTick}건; ` +
      `self_death 메시지: ${deathMsg ? `있음(score=${deathMsg.score},rank=${deathMsg.rank})` : '없음'}; ` +
      `실 angle 범위=[${angleMin}°~${angleMax}°] (MAX_TURN=8°/tick), 마지막angle=${lastAngle}°`
    );
    ws.close();
    await sleep(400);
  }

  // ── ④ angle=60 고정 40틱 → head 이동 거리(px) ───────────────────────────
  {
    console.log('── ④ angle=60 고정 40틱 → head 이동 거리(px) ──');
    const { ws, msgs, init } = await connect('QA_angle60');
    const pid        = init.playerId;
    const initPlayer = init.players.find(p => p.id === pid);
    const initAngle  = initPlayer?.angle?.toFixed(1) ?? '?';
    const initHead   = initPlayer?.segments?.[0];

    console.log(`  initAngle=${initAngle}°`);

    for (let i = 0; i < 40; i++) {
      send(ws, { type: 'input', angle: 60, boost: false });
      await sleep(TICK_MS);
    }

    const allMoves = myMoves(ticks(msgs), pid);

    if (allMoves.length < 10) {
      report('④', 'angle=60 고정 40틱 이동', false,
        `move 이벤트 부족: ${allMoves.length}건`);
    } else {
      const headTrace = allMoves.filter(mv => mv.head).map(mv => ({
        x: mv.head.x, y: mv.head.y, angle: mv.angle
      }));

      // 틱별 이동거리
      const perTickDists = [];
      for (let i = 1; i < headTrace.length; i++) {
        const ddx = headTrace[i].x - headTrace[i-1].x;
        const ddy = headTrace[i].y - headTrace[i-1].y;
        perTickDists.push(Math.sqrt(ddx*ddx + ddy*ddy));
      }

      const first    = headTrace[0];
      const last     = headTrace.at(-1);
      const dx       = last.x - first.x;
      const dy       = last.y - first.y;
      const totalDist = Math.sqrt(dx*dx + dy*dy);
      const avgSpeed  = totalDist / headTrace.length;

      const minPTD = Math.min(...perTickDists).toFixed(3);
      const maxPTD = Math.max(...perTickDists).toFixed(3);
      const allExact5 = perTickDists.every(d => Math.abs(d - SNAKE_SPEED) < 0.01);

      // 40틱 fully converged 기대값:
      // angle 수렴 소요: |initAngle - 60| / 8 틱
      // 수렴 후 방향: cos(60°)=0.5 → dx=+100px, sin(60°)≈0.866 → dy=+173px (40틱)
      const finalServerAngle = last.angle?.toFixed(1) ?? '?';
      const died = !!selfDeathMsg(msgs);

      const pass4 = totalDist > 20 && headTrace.length >= 30 && !died;
      report('④', 'angle=60 고정 40틱 head 이동',
        pass4,
        `${headTrace.length}틱; ` +
        `first=(${first.x.toFixed(2)},${first.y.toFixed(2)}) → last=(${last.x.toFixed(2)},${last.y.toFixed(2)}); ` +
        `dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}, 총 dist=${totalDist.toFixed(2)}px; ` +
        `avgSpeed=${avgSpeed.toFixed(3)}px/틱; ` +
        `perTick범위=[${minPTD}~${maxPTD}], 모두5.000px=${allExact5}; ` +
        `initAngle=${initAngle}°→finalAngle=${finalServerAngle}° (목표=60°); died=${died}`
      );
    }
    ws.close();
    await sleep(400);
  }

  // ── 최종 요약 ─────────────────────────────────────────────────────────────
  console.log('=== FINAL SUMMARY ===');
  let passed = 0;
  for (const r of results) {
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.id} — ${r.label}`);
    if (r.pass) passed++;
  }
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(2); });
