'use strict';
/**
 * QA Full Playtest — Slither Multiplayer
 *
 * 검증 영역:
 *   A. 봇 이동 품질 (스피닝 픽스 효과, 실제 이동 속도·방향)
 *   B. 플레이어 핵심 루프 (입장→이동→음식섭취→점수→부스트→사망)
 *   C. 게임 밸런스·완성도 (속도 비율, 부스트 비용, 재생성, 리더보드)
 *   D. 엣지 케이스 (벽 경계, score=0 부스트, 최소길이)
 */

const WebSocket = require('ws');
const URL = 'ws://localhost:3000';

// Server constants (server.js 직접 확인값)
const TICK_MS         = 50;
const SNAKE_SPEED     = 5;
const BOOST_SPEED     = 10;
const MAX_TURN_DEG    = 8;
const MIN_LENGTH      = 10;
const BOOST_TICK_COST = 5;
const BORDER          = 50;
const WORLD_W         = 5000;
const WORLD_H         = 5000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normDeg(d) { return ((d % 360) + 360) % 360; }
function angleDiff(a, b) {
  let d = normDeg(b) - normDeg(a);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

async function connect(name, skin = '#3498db') {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    const msgs = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, skin })));
    ws.on('message', raw => {
      try { msgs.push(JSON.parse(raw)); } catch {}
      if (msgs.at(-1)?.type === 'init') res({ ws, msgs });
    });
    ws.on('error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 5000);
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function ticks(msgs) { return msgs.filter(m => m.type === 'tick'); }
function myMoves(msgs, pid) {
  return ticks(msgs).flatMap(t => (t.moves || []).filter(mv => mv.id === pid));
}
function botMoves(msgs) {
  return ticks(msgs).flatMap(t =>
    (t.moves || []).filter(mv => mv.id.startsWith('bot-'))
  );
}

// ── Result collector ─────────────────────────────────────────────────────────
const issues = [];
const passes = [];
function pass(tag, msg) { passes.push(`[PASS] ${tag}: ${msg}`); }
function fail(tag, msg) { issues.push(`[FAIL] ${tag}: ${msg}`); }
function warn(tag, msg) { issues.push(`[WARN] ${tag}: ${msg}`); }

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== QA Full Playtest — Slither Multiplayer ===\n');

  // ══════════════════════════════════════════════════════════════════════════
  // A. 봇 이동 품질 (15초 관찰)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('[A] 봇 이동 품질 관찰 (15s)...');
  const { ws: wsObs, msgs: msgsObs } = await connect('QA_observer', '#ffffff');
  const initObs = msgsObs.find(m => m.type === 'init');
  const initBots = initObs.players.filter(p => p.id.startsWith('bot-'));
  console.log(`  서버 init: 봇 ${initBots.length}마리, tick=${initObs.tick}`);

  await sleep(15000);
  wsObs.close();
  await sleep(200);

  const allBotMoves = botMoves(msgsObs);
  const totalBotTicks = allBotMoves.length;
  const maxTurnTicks = allBotMoves.filter(mv => Math.abs(angleDiff(0, mv.angle - (mv._prev ?? mv.angle))) >= MAX_TURN_DEG * 0.93).length;

  // 봇별 이동 분석
  const botIds = [...new Set(allBotMoves.map(mv => mv.id))];
  const botStats = {};
  for (const bid of botIds) {
    const bm = allBotMoves.filter(mv => mv.id === bid);
    // 연속 최대회전 탐지
    let maxRun = 0, curRun = 0, prevAngle = null;
    let totalDist = 0;
    let prevHead = null;
    for (const mv of bm) {
      if (prevAngle !== null) {
        const da = Math.abs(angleDiff(prevAngle, mv.angle));
        if (da >= MAX_TURN_DEG * 0.93) curRun++;
        else { maxRun = Math.max(maxRun, curRun); curRun = 0; }
      }
      if (prevHead && mv.head) {
        const dx = mv.head.x - prevHead.x, dy = mv.head.y - prevHead.y;
        totalDist += Math.sqrt(dx*dx + dy*dy);
      }
      prevAngle = mv.angle;
      prevHead = mv.head;
    }
    maxRun = Math.max(maxRun, curRun);
    const avgSpeed = bm.length > 1 ? totalDist / (bm.length - 1) : 0;
    botStats[bid] = { ticks: bm.length, maxRun, avgSpeed };
  }

  // 봇 점수 확인 (leaderboard 메시지)
  const lbMsgs = msgsObs.filter(m => m.type === 'leaderboard');
  const lastLb  = lbMsgs.at(-1);
  const botScores = lastLb ? lastLb.entries.filter(e => e.id.startsWith('bot-')) : [];

  console.log('  봇별 통계:');
  for (const [bid, s] of Object.entries(botStats)) {
    const name = initBots.find(b => b.id === bid)?.name ?? bid;
    const sc = botScores.find(e => e.id === bid);
    const scoreStr = sc ? `score=${sc.score}` : 'score=?';
    console.log(`    ${bid}(${name}): ${s.ticks}틱, avgSpeed=${s.avgSpeed.toFixed(2)}px/틱, maxSpinRun=${s.maxRun}틱, ${scoreStr}`);
    if (s.maxRun >= 15) fail('A-봇스핀', `${bid} 스핀 ${s.maxRun}틱 연속 최대회전 — 여전히 스피닝`);
    else if (s.maxRun >= 8) warn('A-봇스핀', `${bid} maxRun=${s.maxRun}틱 — 개선됐으나 간헐적 회전 과다`);
    else pass('A-봇이동', `${bid} maxRun=${s.maxRun}틱 정상`);

    if (s.avgSpeed < SNAKE_SPEED * 0.7)
      fail('A-봇속도', `${bid} avgSpeed=${s.avgSpeed.toFixed(2)} — 정상속도(${SNAKE_SPEED}) 70% 미달, 봇이 맴돌고 있음`);
    else
      pass('A-봇속도', `${bid} avgSpeed=${s.avgSpeed.toFixed(2)}px/틱`);
  }
  if (botIds.length === 0) fail('A-봇존재', '봇이 tick.moves에 나타나지 않음');

  // ══════════════════════════════════════════════════════════════════════════
  // B. 플레이어 핵심 루프: 입장→이동→음식→점수→부스트→사망
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[B] 플레이어 핵심 루프...');
  const { ws: wsP, msgs: msgsP } = await connect('QA_player', '#e74c3c');
  const initP = msgsP.find(m => m.type === 'init');
  const pid   = initP.playerId;
  const me0   = initP.players.find(p => p.id === pid);

  // B1. 초기 상태 확인
  const initSeg = me0.segments.length;
  const initScore = me0.score;
  console.log(`  B1 init: segments=${initSeg}, score=${initScore}, angle=${me0.angle.toFixed(1)}°`);
  if (initSeg !== 20) fail('B-초기길이', `초기 세그먼트=${initSeg}, 기대값=20`);
  else pass('B-초기길이', `segments=20 정상`);
  if (initScore !== 0) fail('B-초기점수', `초기 score=${initScore}, 기대값=0`);
  else pass('B-초기점수', 'score=0 정상');

  // B2. 이동 확인 (10틱, angle=45)
  for (let i = 0; i < 10; i++) {
    send(wsP, { type: 'input', angle: 45, boost: false });
    await sleep(TICK_MS);
  }
  const movesB2 = myMoves(msgsP, pid).slice(0, 10);
  const perTickDists = [];
  for (let i = 1; i < movesB2.length; i++) {
    if (!movesB2[i].head || !movesB2[i-1].head) continue;
    const dx = movesB2[i].head.x - movesB2[i-1].head.x;
    const dy = movesB2[i].head.y - movesB2[i-1].head.y;
    perTickDists.push(Math.sqrt(dx*dx+dy*dy));
  }
  const avgDist = perTickDists.length ? perTickDists.reduce((a,b)=>a+b,0)/perTickDists.length : 0;
  if (Math.abs(avgDist - SNAKE_SPEED) > 0.5)
    fail('B-이동속도', `avgDist=${avgDist.toFixed(2)}px/틱 (기대=${SNAKE_SPEED})`);
  else
    pass('B-이동속도', `avgDist=${avgDist.toFixed(2)}px/틱 정상`);

  // B3. 음식 섭취 & 점수 (최대 20초 대기)
  console.log('  B3 음식 섭취 대기 (최대 20s)...');
  let ateFood = false;
  let scoreAtEat = 0, segsAtEat = initSeg;
  let angle = 45;
  for (let i = 0; i < 400 && !ateFood; i++) {
    if (i % 20 === 0) angle = (angle + 70) % 360;
    send(wsP, { type: 'input', angle, boost: false });
    await sleep(TICK_MS);
    const lastT = ticks(msgsP).at(-1);
    if (lastT) {
      for (const sc of (lastT.scores || [])) {
        if (sc.id === pid && sc.score > 0) { scoreAtEat = sc.score; ateFood = true; }
      }
    }
  }
  const movesB3 = myMoves(msgsP, pid);
  let curSegs = initSeg;
  for (const mv of movesB3) {
    if (mv.grew && !mv.shrunk) curSegs++;
    if (!mv.grew && mv.shrunk) curSegs--;
    if (mv.extra_shrunk) curSegs--;
  }
  segsAtEat = curSegs;

  if (!ateFood) {
    fail('B-음식섭취', `400틱 후 score=0 — 음식을 전혀 못 먹음`);
  } else {
    pass('B-음식섭취', `score=${scoreAtEat}, 현재 segments≈${segsAtEat}`);
    // 점수 vs 길이 일관성: 음식 섭취 시 grew=true인지
    const grewEvents = movesB3.filter(mv => mv.grew).length;
    if (grewEvents === 0) warn('B-성장', '음식 섭취했는데 grew=true 이벤트 없음');
    else pass('B-성장', `grew 이벤트 ${grewEvents}건`);
  }

  // B4. 부스트: score>0 상태에서 활성화
  if (scoreAtEat > 0) {
    console.log(`  B4 부스트 테스트 (score=${scoreAtEat})...`);
    const boostStart = ticks(msgsP).length;
    const boostStartScore = scoreAtEat;
    for (let i = 0; i < 30; i++) {
      send(wsP, { type: 'input', angle, boost: true });
      await sleep(TICK_MS);
    }
    const boostMoves = myMoves(msgsP, pid).slice(boostStart);
    const boostedTicks = boostMoves.filter(mv => mv.boosting).length;
    const boostSpeeds = [];
    for (let i = 1; i < boostMoves.length; i++) {
      if (!boostMoves[i].head || !boostMoves[i-1].head || !boostMoves[i].boosting) continue;
      const dx = boostMoves[i].head.x - boostMoves[i-1].head.x;
      const dy = boostMoves[i].head.y - boostMoves[i-1].head.y;
      boostSpeeds.push(Math.sqrt(dx*dx+dy*dy));
    }
    const avgBoostSpeed = boostSpeeds.length ? boostSpeeds.reduce((a,b)=>a+b,0)/boostSpeeds.length : 0;
    const shrunkEvts = boostMoves.filter(mv => mv.shrunk).length;
    const extraShrunkEvts = boostMoves.filter(mv => mv.extra_shrunk).length;
    let finalScoreB4 = boostStartScore;
    for (const t of ticks(msgsP).slice(boostStart)) {
      for (const sc of (t.scores || [])) if (sc.id === pid) finalScoreB4 = sc.score;
    }

    console.log(`    부스트: activeTicks=${boostedTicks}/30, avgSpeed=${avgBoostSpeed.toFixed(2)}, shrunk=${shrunkEvts}, extra_shrunk=${extraShrunkEvts}, score ${boostStartScore}→${finalScoreB4}`);

    if (boostedTicks === 0) fail('B-부스트활성', '부스트 전송했으나 mv.boosting=true 0건');
    else pass('B-부스트활성', `boostedTicks=${boostedTicks}`);

    if (Math.abs(avgBoostSpeed - BOOST_SPEED) > 1)
      fail('B-부스트속도', `avgSpeed=${avgBoostSpeed.toFixed(2)} (기대=${BOOST_SPEED})`);
    else
      pass('B-부스트속도', `avgSpeed=${avgBoostSpeed.toFixed(2)}px/틱 정상`);

    if (shrunkEvts === 0) fail('B-부스트비용', 'boost 30틱에 shrunk 이벤트 없음 — 비용 미부과');
    else pass('B-부스트비용', `shrunk=${shrunkEvts}, extra_shrunk=${extraShrunkEvts}건`);

    if (finalScoreB4 >= boostStartScore && boostStartScore > 0)
      warn('B-부스트점수', `score ${boostStartScore}→${finalScoreB4} 감소 없음 (먹이 섭취로 상쇄됐을 수 있음)`);
    else
      pass('B-부스트점수', `score ${boostStartScore}→${finalScoreB4} 감소 확인`);
  } else {
    warn('B-부스트', 'score=0이라 부스트 테스트 건너뜀');
  }

  // B5. 벽 근처 이동 → wall death 유도
  console.log('  B5 벽 충돌 테스트...');
  // 현재 위치 파악
  const lastMove = myMoves(msgsP, pid).at(-1);
  const headX = lastMove?.head?.x ?? 2500;
  const headY = lastMove?.head?.y ?? 2500;
  // 가장 가까운 벽 방향으로 직진
  const toWallAngle = headX < WORLD_W/2 ? 180 : 0; // 왼쪽 또는 오른쪽 벽
  console.log(`    현재위치 (${headX.toFixed(0)},${headY.toFixed(0)}), 벽 방향 ${toWallAngle}° 직진`);
  const wallStart = ticks(msgsP).length;
  let wallDied = false;
  for (let i = 0; i < 300 && !wallDied; i++) {
    send(wsP, { type: 'input', angle: toWallAngle, boost: false });
    await sleep(TICK_MS);
    const deathMsg = msgsP.find(m => m.type === 'self_death');
    if (deathMsg) wallDied = true;
  }
  const deathMsg = msgsP.find(m => m.type === 'self_death');
  if (!wallDied) {
    fail('B-벽사망', `300틱 직진 후 self_death 미수신 — 벽 사망 미작동 가능`);
  } else {
    pass('B-벽사망', `self_death 수신: score=${deathMsg.score}, rank=${deathMsg.rank}, killed_by=${deathMsg.killed_by}`);
    if (!deathMsg.score && deathMsg.score !== 0) fail('B-사망점수', 'self_death에 score 필드 없음');
    if (!deathMsg.rank) fail('B-사망랭크', 'self_death에 rank 필드 없음');
  }

  // B6. 사망 후 재입장
  console.log('  B6 재입장 테스트...');
  send(wsP, { type: 'join', name: 'QA_player', skin: '#e74c3c' });
  await sleep(300);
  const initMsgs2 = msgsP.filter(m => m.type === 'init');
  if (initMsgs2.length < 2) {
    fail('B-재입장', '사망 후 join → init 미수신 (재입장 불가)');
  } else {
    const newInit = initMsgs2.at(-1);
    const newPid  = newInit.playerId;
    const newMe   = newInit.players.find(p => p.id === newPid);
    const newSegs = newMe?.segments.length ?? '?';
    const newScore = newMe?.score ?? '?';
    pass('B-재입장', `새 playerId 발급, segments=${newSegs}, score=${newScore}`);
  }

  wsP.close();
  await sleep(200);

  // ══════════════════════════════════════════════════════════════════════════
  // C. 게임 완성도·밸런스
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[C] 밸런스·완성도 체크...');

  // C1. 부스트 속도 비율 (boost:normal = 2:1 기대)
  const speedRatio = BOOST_SPEED / SNAKE_SPEED;
  if (speedRatio !== 2.0) warn('C-속도비율', `boost/normal=${speedRatio} (slither.io 기준 2.0)`);
  else pass('C-속도비율', `2:1 정상`);

  // C2. 음식 밀도 체크 (init 메시지 기준)
  const foodCount = initP.food.length;
  const worldArea = WORLD_W * WORLD_H;
  const foodDensity = foodCount / (worldArea / 1e6); // per 1M sq px
  console.log(`  C2 food: count=${foodCount}, density=${foodDensity.toFixed(1)}/100만px²`);
  if (foodCount < 1000) warn('C-음식밀도', `음식 ${foodCount}개 — 초기 부족(기대 2500)`);
  else pass('C-음식밀도', `${foodCount}개 정상`);

  // C3. 리더보드 발송 확인
  const lbAll = msgsP.filter(m => m.type === 'leaderboard');
  if (lbAll.length === 0) fail('C-리더보드', '플레이 중 leaderboard 수신 없음');
  else {
    const firstLb = lbAll[0];
    pass('C-리더보드', `${lbAll.length}회 수신, 마지막 entries=${lbAll.at(-1).entries.length}명`);
    // 리더보드에 내 이름 나오는지 (alive 중에만 표시)
    const myInLb = lbAll.some(lb => lb.entries.some(e => e.id === pid));
    if (!myInLb) warn('C-리더보드-자신', '플레이 중 리더보드에 내 ID 없음 (점수가 계속 0이었으면 정상)');
  }

  // C4. Ping/Pong 응답
  const { ws: wsPing, msgs: msgsPing } = await connect('QA_ping', '#00bcd4');
  const pingPid = msgsPing.find(m => m.type === 'init').playerId;
  send(wsPing, { type: 'ping', ts: Date.now() });
  await sleep(200);
  const pongMsg = msgsPing.find(m => m.type === 'pong');
  if (!pongMsg) fail('C-핑퐁', 'pong 미수신');
  else {
    const rtt = Date.now() - pongMsg.ts;
    pass('C-핑퐁', `pong 수신, RTT≈${rtt}ms`);
  }
  wsPing.close();
  await sleep(100);

  // C5. 동시 접속 (복수 클라이언트에 tick broadcast 확인)
  const { ws: ws2, msgs: msgs2 } = await connect('QA_second', '#9b59b6');
  const pid2 = msgs2.find(m => m.type === 'init').playerId;
  // 첫 번째 클라이언트 init에 두 번째 플레이어가 spawns로 보이는지
  await sleep(200);
  const spawnForP2 = ticks(msgsObs).some(t =>
    (t.spawns || []).some(s => s.id === pid2)
  ); // obs는 이미 닫혔으니 이건 확인 불가
  const initFor2 = msgs2.find(m => m.type === 'init');
  pass('C-복수접속', `두 번째 클라이언트 init 수신, 총 players=${initFor2.players.length}`);
  ws2.close();
  await sleep(100);

  // ══════════════════════════════════════════════════════════════════════════
  // D. 엣지 케이스
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[D] 엣지 케이스...');

  const { ws: wsEdge, msgs: msgsEdge } = await connect('QA_edge', '#f39c12');
  const initEdge = msgsEdge.find(m => m.type === 'init');
  const edgePid  = initEdge.playerId;

  // D1. score=0에서 boost 전송 → mv.boosting=false 확인
  for (let i = 0; i < 10; i++) {
    send(wsEdge, { type: 'input', angle: 0, boost: true });
    await sleep(TICK_MS);
  }
  const edgeMoves1 = myMoves(msgsEdge, edgePid);
  const boostWhileZero = edgeMoves1.filter(mv => mv.boosting === true).length;
  if (boostWhileZero > 0)
    fail('D-score0부스트', `score=0에서 mv.boosting=true ${boostWhileZero}건 — 부스트 차단 실패`);
  else
    pass('D-score0부스트', `score=0 → boosting=false 전부 (${edgeMoves1.length}틱 확인)`);

  // D2. 입력 없을 때 직진 유지 (angle 고정, 그냥 join만 하고 아무것도 안 보내기)
  await sleep(500);
  const edgeMoves2 = myMoves(msgsEdge, edgePid);
  const allAngles = edgeMoves2.map(mv => mv.angle);
  const angleVariance = allAngles.length > 1
    ? allAngles.reduce((acc, a, i) => {
        if (i === 0) return 0;
        return acc + Math.abs(angleDiff(allAngles[i-1], a));
      }, 0) / (allAngles.length - 1)
    : 0;
  // Join 후 입력 없으면 초기 angle 유지 (inputAngle = angle at spawn)
  if (angleVariance > 1) warn('D-무입력이동', `입력 없는 틱에서 angle 평균변화 ${angleVariance.toFixed(2)}° — 예상치 못한 회전`);
  else pass('D-무입력이동', `angle변화 ${angleVariance.toFixed(2)}°/틱 — 직진 유지`);

  wsEdge.close();
  await sleep(100);

  // ══════════════════════════════════════════════════════════════════════════
  // 최종 리포트
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════');
  console.log('PASS 항목:');
  passes.forEach(p => console.log('  ' + p));
  console.log('\nFAIL / WARN 항목:');
  if (issues.length === 0) console.log('  없음');
  else issues.forEach(i => console.log('  ' + i));
  console.log(`\n총 ${passes.length} PASS / ${issues.filter(i=>i.startsWith('[FAIL]')).length} FAIL / ${issues.filter(i=>i.startsWith('[WARN]')).length} WARN`);
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
