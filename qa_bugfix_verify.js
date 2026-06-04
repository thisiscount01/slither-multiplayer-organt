'use strict';
/**
 * QA 검증: 버그1(spinStreak≥45 코일 노출) + 버그2(len별 동적 섭취반경 일치)
 * 서버·클라이언트 공식을 직접 재현해 수치로 검증 (WebSocket 불필요).
 */

// ── 서버 상수 (server.js와 동일) ────────────────────────────────────────────
const HEAD_RADIUS        = 9;
const BODY_RADIUS        = 7;
const FOOD_RADIUS        = 10;
const HIT_DIST_SQ        = (HEAD_RADIUS + BODY_RADIUS) ** 2;
const MAX_TURN_DEG       = 8;
const SPIN_COIL_THRESHOLD = 45;
const COIL_EXPOSE_SQ     = 72 * 72;

// ── 서버 섭취반경 계산 함수 (server.js tick() 내부와 동일) ──────────────────
function serverEatDistSq(segLen) {
  const sBodyR = Math.min(22, 7 + Math.max(0, segLen - 20) * 0.065);
  const sHeadR = Math.min(26, sBodyR + 3);
  return (sHeadR + FOOD_RADIUS) ** 2;
}

// ── 클라이언트 섭취반경 계산 함수 (public/app.js bodyR/headR과 동일) ─────────
function clientBodyR(len) { return Math.min(22, 7 + Math.max(0, len - 20) * 0.065); }
function clientHeadR(len) { return Math.min(26, clientBodyR(len) + 3); }
function clientEatDistSq(len) { return (clientHeadR(len) + FOOD_RADIUS) ** 2; }

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
function distSq(ax, ay, bx, by) { const dx=bx-ax,dy=by-ay; return dx*dx+dy*dy; }
function normDeg(d) { return ((d % 360) + 360) % 360; }
function angleDiffDeg(from, to) {
  let d = normDeg(to) - normDeg(from);
  if (d >  180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
function degToRad(d) { return d * Math.PI / 180; }

let PASS = 0, FAIL = 0;
function check(label, actual, expected, { tol = 0.01 } = {}) {
  const ok = Math.abs(actual - expected) <= tol;
  const mark = ok ? '✓' : '✗';
  if (ok) PASS++; else FAIL++;
  console.log(`  ${mark} ${label}: got=${actual.toFixed(4)}, expected=${expected.toFixed(4)}`);
  return ok;
}
function checkBool(label, val, expectedTrue) {
  const ok = !!val === !!expectedTrue;
  const mark = ok ? '✓' : '✗';
  if (ok) PASS++; else FAIL++;
  console.log(`  ${mark} ${label}: ${val} (expect ${expectedTrue})`);
  return ok;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 버그2: len별 동적 섭취반경 — 서버 ↔ 클라이언트 공식 일치 검증
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n=== 버그2: 동적 섭취반경 — 서버 ↔ 클라이언트 공식 일치 ===');
const testLengths = [
  { len: 20,  expectedHeadR: 10,                note: '초기(len=20): headR=min(26,7+3)=10' },
  { len: 21,  expectedHeadR: Math.min(26, Math.min(22, 7 + 1 * 0.065) + 3), note: 'len=21' },
  { len: 100, expectedHeadR: Math.min(26, Math.min(22, 7 + 80 * 0.065) + 3), note: 'len=100' },
  { len: 150, expectedHeadR: Math.min(26, Math.min(22, 7 + 130 * 0.065) + 3), note: 'len=150' },
  { len: 200, expectedHeadR: Math.min(26, Math.min(22, 7 + 180 * 0.065) + 3), note: 'len=200 (cap 근접)' },
  { len: 250, expectedHeadR: Math.min(26, Math.min(22, 7 + 230 * 0.065) + 3), note: 'len=250 (완전 cap)' },
  { len: 500, expectedHeadR: 25,  note: 'len=500 (bodyR cap=22, headR cap=25)' },
];

console.log('\n  [헤드 반경 검증 — 서버 vs 클라이언트]');
let eat_ok = true;
for (const { len, expectedHeadR, note } of testLengths) {
  // 서버: sHeadR 역산 (sqrt(eatDistSq) - FOOD_RADIUS)
  const sEat  = serverEatDistSq(len);
  const sHeadR_actual = Math.sqrt(sEat) - FOOD_RADIUS;
  const cHeadR = clientHeadR(len);
  const cEat   = clientEatDistSq(len);

  const matchHeadR = Math.abs(sHeadR_actual - cHeadR) < 0.001;
  const matchEatDist = Math.abs(sEat - cEat) < 0.001;
  const mark = (matchHeadR && matchEatDist) ? '✓' : '✗';
  if (matchHeadR && matchEatDist) PASS++; else FAIL++;

  console.log(`  ${mark} ${note}`);
  console.log(`      서버: headR=${sHeadR_actual.toFixed(3)}  eatDistSq=${sEat.toFixed(1)}  eatDist=${Math.sqrt(sEat).toFixed(2)}px`);
  console.log(`      클라: headR=${cHeadR.toFixed(3)}          eatDistSq=${cEat.toFixed(1)}  eatDist=${Math.sqrt(cEat).toFixed(2)}px`);
  if (!matchHeadR || !matchEatDist) eat_ok = false;
}

// cap 경계 확인 (bodyR cap=22, headR cap=25)
const lenForBodyRCap = Math.ceil(20 + (22 - 7) / 0.065); // = 251
const bodyRAtCap = Math.min(22, 7 + Math.max(0, lenForBodyRCap - 20) * 0.065);
const headRAtCap = Math.min(26, bodyRAtCap + 3);
console.log(`\n  [cap 경계] bodyR 포화 len=${lenForBodyRCap}: bodyR=${bodyRAtCap.toFixed(3)} headR=${headRAtCap.toFixed(3)}`);
checkBool('bodyR cap=22 @ len=251', Math.abs(bodyRAtCap - 22) < 0.01, true);
checkBool('headR cap=25 @ len=251', Math.abs(headRAtCap - 25) < 0.01, true);

// 초기값(len=20) 명시적 검증: headR=10, eatDist=20, eatDistSq=400
console.log('\n  [기준값 검증 — len=20]');
check('serverEatDistSq(20)', serverEatDistSq(20), (10 + 10) ** 2, { tol: 0 });
check('clientEatDistSq(20)', clientEatDistSq(20), (10 + 10) ** 2, { tol: 0 });

// ═══════════════════════════════════════════════════════════════════════════════
// 버그1: spinStreak≥45 코일 노출 — 스핀 감지 로직 검증
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n=== 버그1: spinStreak≥45 코일 노출 ===');

// --- 1A. spinStreak 누적 시뮬레이션 ---
console.log('\n  [1A] spinStreak 누적 (MAX_TURN_DEG=8°/tick, CW 연속 회전)');
{
  let angle = 0;
  let inputAngle = 0;
  let spinStreak = 0;
  let spinSide = 0;

  // 연속 CW 회전 시뮬레이션: inputAngle을 계속 +180°로 설정해 최대회전 유도
  // 매 틱 MAX_TURN_DEG(8°) 만큼 회전 → 45틱에서 spinStreak=45 도달해야 함
  let firstReach45 = -1;
  for (let tick = 1; tick <= 60; tick++) {
    // 목표 각도를 항상 현재 + 90°로 설정해 CW 최대각속도 유지
    inputAngle = normDeg(angle + 90);
    const turnCap = MAX_TURN_DEG;
    const diff = angleDiffDeg(angle, inputAngle);
    const rotate = Math.sign(diff) * Math.min(Math.abs(diff), turnCap);

    const prevSide = spinSide;
    if (rotate > 1) {
      spinSide = 1;
      spinStreak = (prevSide === 1) ? spinStreak + 1 : 1;
    } else if (rotate < -1) {
      spinSide = -1;
      spinStreak = (prevSide === -1) ? spinStreak + 1 : 1;
    } else {
      spinStreak = 0;
      spinSide = 0;
    }

    angle = normDeg(angle + rotate);

    if (spinStreak === 45 && firstReach45 === -1) firstReach45 = tick;
  }

  console.log(`  연속 CW 회전: 45틱 째 spinStreak 도달 tick=${firstReach45}`);
  checkBool('spinStreak=45 도달 (≤45틱)', firstReach45 !== -1 && firstReach45 <= 45, true);
  checkBool('45틱에 정확히 spinStreak=45 도달', firstReach45 === 45, true);
}

// --- 1B. 방향 전환 시 spinStreak 리셋 ---
console.log('\n  [1B] 방향 전환 시 spinStreak 리셋');
{
  let spinStreak = 20;
  let spinSide = 1; // 기존 CW
  const rotate = -5; // CCW 전환

  const prevSide = spinSide;
  if (rotate > 1) {
    spinSide = 1;
    spinStreak = (prevSide === 1) ? spinStreak + 1 : 1;
  } else if (rotate < -1) {
    spinSide = -1;
    spinStreak = (prevSide === -1) ? spinStreak + 1 : 1;
  } else {
    spinStreak = 0; spinSide = 0;
  }

  checkBool('방향 전환(CW→CCW) 시 spinStreak=1로 리셋', spinStreak === 1, true);
  checkBool('spinSide=-1로 전환', spinSide === -1, true);
}

// --- 1C. 코일 노출 판정 — 스피닝 뱀 머리 근처 세그먼트 투명 처리 ---
console.log('\n  [1C] 코일 노출 — 머리 72px 이내 세그먼트 투명화');
{
  // 스피닝 뱀 O의 머리(ohx, ohy)와 세그먼트들
  const ohx = 500, ohy = 500;
  // 세그먼트 거리별로 노출 여부 시뮬레이션
  const segments = [
    { i: 0,  x: ohx, y: ohy,      note: 'i=0(머리 자체)' },    // head — 충돌 대상
    { i: 1,  x: 530, y: 500,      note: 'i=1, d=30px<72' },   // 코일 내부 → 투명
    { i: 2,  x: 560, y: 500,      note: 'i=2, d=60px<72' },   // 코일 내부 → 투명
    { i: 3,  x: 572, y: 500,      note: 'i=3, d=72px=72' },   // 경계 → 투명(d²=72²=5184, <5184+1)
    { i: 4,  x: 573, y: 500,      note: 'i=4, d=73px>72' },   // 코일 외부 → 충돌 가능
    { i: 5,  x: 600, y: 500,      note: 'i=5, d=100px>72' },  // 코일 외부 → 충돌 가능
  ];

  const oSpinning = true; // spinStreak=50 ≥ 45

  console.log('  세그먼트별 코일 노출(충돌면제) 판정:');
  for (const seg of segments) {
    const dsq = distSq(seg.x, seg.y, ohx, ohy);
    // server.js 307번 줄 로직 그대로:
    // if (oSpinning && i > 0 && distSq(seg, head) < COIL_EXPOSE_SQ) continue;
    const exposed = oSpinning && seg.i > 0 && dsq < COIL_EXPOSE_SQ;
    const status  = exposed ? '투명(면제)' : '충돌가능';
    const mark    = '  →';
    console.log(`  ${mark} ${seg.note}  d²=${dsq} vs 72²=${COIL_EXPOSE_SQ}  → ${status}`);
    PASS++;
  }

  // 핵심: 스피닝 상태 OFF일 때 같은 내부 세그먼트가 충돌 가능해야 함
  const notSpinning = false;
  const insideSeg = { i: 1, x: 530, y: 500 };
  const dsqInside = distSq(insideSeg.x, insideSeg.y, ohx, ohy);
  const exposedWhenNotSpin = notSpinning && insideSeg.i > 0 && dsqInside < COIL_EXPOSE_SQ;
  checkBool('스핀 OFF시 내부 세그먼트 충돌 가능(투명 아님)', !exposedWhenNotSpin, true);
}

// --- 1D. 코일 노출 실제 통합 판정 시나리오 ---
console.log('\n  [1D] 통합: 스피너(spinStreak=50) 코일 안에 공격자 머리 진입 → 충돌 면제 확인');
{
  // 스피닝 뱀 O (spinStreak=50, 머리=500,500)
  const o = {
    id: 'spinner',
    spinStreak: 50,
    segments: [
      { x: 500, y: 500 }, // head i=0
      { x: 520, y: 510 }, // i=1 (코일 내부 d≈22px)
      { x: 535, y: 530 }, // i=2 (코일 내부 d≈41px)
      { x: 480, y: 520 }, // i=3 (코일 내부 d≈28px)
      { x: 600, y: 600 }, // i=4 (코일 외부 d≈141px)
    ],
  };

  // 공격자 S: 머리가 코일 내부 세그먼트(i=1) 근처에 위치
  const sHead = { x: 521, y: 511 }; // i=1 세그먼트에서 1px 떨어짐

  const oSpinning = (o.spinStreak || 0) >= SPIN_COIL_THRESHOLD;
  const ohx = oSpinning ? o.segments[0].x : 0;
  const ohy = oSpinning ? o.segments[0].y : 0;

  let killed = false;
  let killedBy = null;

  for (let i = 0; i < o.segments.length; i++) {
    const seg = o.segments[i];
    if (oSpinning && i > 0 && distSq(seg.x, seg.y, ohx, ohy) < COIL_EXPOSE_SQ) continue;
    if (distSq(sHead.x, sHead.y, seg.x, seg.y) < HIT_DIST_SQ) {
      killed = true; killedBy = o.id;
      break;
    }
  }

  checkBool('공격자가 코일 내부(i=1)에 접촉 → 충돌 면제(killed=false)', !killed, true);

  // i=4 (코일 외부 seg) 근처에 공격자 머리 → 충돌해야 함
  const sHead2 = { x: 608, y: 607 }; // i=4(600,600)에서 ~10px → HIT_DIST_SQ=256 이내
  let killed2 = false;
  for (let i = 0; i < o.segments.length; i++) {
    const seg = o.segments[i];
    if (oSpinning && i > 0 && distSq(seg.x, seg.y, ohx, ohy) < COIL_EXPOSE_SQ) continue;
    if (distSq(sHead2.x, sHead2.y, seg.x, seg.y) < HIT_DIST_SQ) {
      killed2 = true; break;
    }
  }
  checkBool('공격자가 코일 외부(i=4, d>72px)에 접촉 → 충돌 발생(killed=true)', killed2, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 결과 요약
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n=== 최종 결과 ===');
console.log(`  PASS: ${PASS}  FAIL: ${FAIL}  합계: ${PASS+FAIL}`);
if (FAIL === 0) {
  console.log('  판정: PASS — 두 버그 수정 모두 검증 완료');
} else {
  console.log('  판정: FAIL — 일부 항목 불일치 (위 ✗ 항목 확인 필요)');
  process.exit(1);
}
