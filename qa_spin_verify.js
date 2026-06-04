// QA: 봇 스피닝 재현 검증
// 프로토콜: join → init(전체상태) → tick(delta: moves[{id,head,angle,boosting}])
// inputAngle은 서버 내부 전용 — 브로드캐스트 안 됨.
// 판정 기준: dAngle(angle 변화량) ≥ 8°/tick 연속 = 최대회전속도 = 스피닝 패턴.

const WebSocket = require('ws');

const WS_URL      = 'ws://localhost:3000';
const OBSERVE_MS  = 1500;   // 1.5초 = TICK_MS 50ms 기준 ~30틱 수집 후 10틱 슬라이스
const REPORT_TICKS = 10;    // 보고에 사용할 틱 수

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function angleDiff(a, b) {
  let d = ((b - a) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

async function main() {
  const ws   = new WebSocket(WS_URL);
  const msgs = [];
  let ready  = false;

  await new Promise((res, rej) => {
    ws.on('open', () => {
      // 관전자 플레이어로 join (tick broadcast 수신 위해 clients map에 등록 필요)
      ws.send(JSON.stringify({ type: 'join', name: 'QA-Observer', skin: '#888888' }));
      ready = true;
      res();
    });
    ws.on('error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 5000);
  });

  ws.on('message', raw => {
    try { msgs.push(JSON.parse(raw)); } catch {}
  });

  // tick 수집
  await sleep(OBSERVE_MS);
  ws.close();
  await sleep(100);

  // ── 분석 ─────────────────────────────────────────────────────────────────
  const initMsg  = msgs.find(m => m.type === 'init');
  const tickMsgs = msgs.filter(m => m.type === 'tick');

  console.log('=== 봇 스피닝 현상 재현 검증 ===');
  console.log(`수신: init=${initMsg ? 1 : 0}, tick=${tickMsgs.length}개`);

  if (!initMsg) { console.error('init 미수신 — 서버 연결 실패'); process.exit(1); }

  // 초기 봇 상태
  const botState = new Map();
  const botTrace = new Map();

  for (const p of (initMsg.players || [])) {
    if (!String(p.id).startsWith('bot-')) continue;
    const head = p.segments?.[0];
    botState.set(p.id, { angle: p.angle, x: head?.x ?? 0, y: head?.y ?? 0 });
    botTrace.set(p.id, []);
    console.log(`초기 봇: ${p.id}  name="${p.name}"  angle=${p.angle?.toFixed(2)}  pos=(${head?.x?.toFixed(1)},${head?.y?.toFixed(1)})`);
  }

  // tick 재생 (처음 REPORT_TICKS 개)
  const sliced = tickMsgs.slice(0, REPORT_TICKS);
  for (const t of sliced) {
    for (const mv of (t.moves || [])) {
      if (!String(mv.id).startsWith('bot-')) continue;
      if (!mv.head) continue;

      if (!botState.has(mv.id)) {
        botState.set(mv.id, { angle: mv.angle, x: mv.head.x, y: mv.head.y });
        botTrace.set(mv.id, []);
      }

      const prev   = botState.get(mv.id);
      const dAngle = angleDiff(prev.angle, mv.angle);

      botTrace.get(mv.id).push({
        tick:   t.tick,
        angle:  mv.angle,
        dAngle,
        x:      mv.head.x,
        y:      mv.head.y,
      });

      botState.set(mv.id, { angle: mv.angle, x: mv.head.x, y: mv.head.y });
    }
  }

  // ── 봇별 상세 ────────────────────────────────────────────────────────────
  const botIds = [...botTrace.keys()].sort();
  console.log('');

  for (const id of botIds) {
    const trace = botTrace.get(id);
    if (!trace || trace.length === 0) {
      console.log(`[${id}] 이동 데이터 없음 (틱 내 moves에 미포함)`);
      continue;
    }

    console.log(`[${id}]  ${trace.length}틱 관찰`);
    console.log('  tick |  angle(°) | dAngle(°/tk) |    x     |    y     |');
    console.log('  -----+-----------+--------------+----------+----------+');

    for (const e of trace) {
      const flag = Math.abs(e.dAngle) >= 7.9 ? ' ← 최대회전' : '';
      console.log(
        `  ${String(e.tick).padStart(4)} | ${e.angle.toFixed(2).padStart(9)} | ${e.dAngle.toFixed(2).padStart(12)} | ${e.x.toFixed(1).padStart(8)} | ${e.y.toFixed(1).padStart(8)} |${flag}`
      );
    }

    const first = trace[0], last = trace[trace.length - 1];
    const dx    = last.x - first.x, dy = last.y - first.y;
    const dist  = Math.sqrt(dx*dx + dy*dy);
    const spinN = trace.filter(e => Math.abs(e.dAngle) >= 7.9).length;
    const maxD  = Math.max(...trace.map(e => Math.abs(e.dAngle)));

    const angleRange = (() => {
      const angles = trace.map(e => e.angle);
      return (Math.max(...angles) - Math.min(...angles)).toFixed(1);
    })();

    console.log(`  위치 변화  : dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)}  총이동=${dist.toFixed(1)}px (${trace.length}틱)`);
    console.log(`  각도 변화  : max dAngle=${maxD.toFixed(2)}°/tick  최대회전도달=${spinN}/${trace.length}틱  angle범위=${angleRange}°`);
    if (spinN > 0) {
      console.log(`  ⚠ 스피닝: ${spinN}틱 연속 최대각속도 선회 감지`);
    }
    console.log('');
  }

  // ── 종합 ─────────────────────────────────────────────────────────────────
  let totalT = 0, spinT = 0;
  for (const id of botIds) {
    for (const e of (botTrace.get(id) || [])) {
      totalT++;
      if (Math.abs(e.dAngle) >= 7.9) spinT++;
    }
  }
  const pct = totalT > 0 ? (spinT/totalT*100).toFixed(1) : '0.0';

  console.log('=== 종합 판정 ===');
  console.log(`관찰 tick: ${sliced.length}  봇: ${botIds.length}개  총 이동엔트리: ${totalT}`);
  console.log(`최대회전속도(≥8°/tick): ${spinT}/${totalT} (${pct}%)`);
  console.log(`inputAngle: 서버 내부 필드, 브로드캐스트 없음 — angle 변화량으로 대리 판정`);

  if (parseFloat(pct) >= 20) {
    console.log(`판정: [스피닝 재현됨] 봇이 ${pct}% tick에서 최대각속도 선회 — 제자리 선회 패턴 확인`);
  } else {
    console.log(`판정: [정상] 스피닝 미재현 (최대회전 비율 ${pct}% < 20%)`);
  }
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
