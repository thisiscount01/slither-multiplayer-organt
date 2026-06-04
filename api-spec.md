# Slither Multiplayer — WebSocket Protocol Spec

**Version:** 0.1.0  
**Date:** 2026-06-04  
**Authors:** 백엔드(WebSocket 서버), 프론트엔드(캔버스 클라이언트) 합의  

---

## 1. 개요

서버 권위(Server-Authoritative) 구조의 실시간 멀티플레이어 Slither 게임 WebSocket 프로토콜입니다.

- 서버가 모든 물리·충돌·점수를 계산하고 결과를 클라이언트에 푸시합니다.
- 클라이언트는 입력(방향각·부스트)만 전송하고, 서버 상태를 렌더링합니다.

---

## 2. 전송 계층

| 항목 | 값 |
|---|---|
| 프로토콜 | WebSocket (`ws://` / `wss://`) |
| 메시지 포맷 | JSON (UTF-8) |
| 서버 틱레이트 | **20 TPS** (50ms/tick) |
| 클라이언트 렌더 | 60 FPS (틱 간 보간 처리) |
| 입력 전송 주기 | ≤ 20 Hz (틱레이트에 맞춰 throttle) |

---

## 3. 메시지 봉투(Envelope)

모든 메시지는 최상위 `type` 필드를 공유합니다.

```json
{ "type": "<message_type>", ...payload }
```

---

## 4. 클라이언트 → 서버 메시지

### 4.1 `join` — 게임 참가

WebSocket 연결 직후 1회 전송합니다.

```json
{
  "type": "join",
  "name": "SnakeKing",
  "skin": "#e74c3c"
}
```

| 필드 | 타입 | 제약 |
|---|---|---|
| `name` | string | 1~20자, 공백만으로 구성 불가 |
| `skin` | string | CSS hex color (`#rrggbb`) 또는 프리셋 ID |

---

### 4.2 `input` — 방향·부스트 입력

약 20Hz로 지속 전송합니다. **마우스가 주(primary) 입력이며, 키보드(WASD/화살표)는 클라이언트에서 각도로 변환해 같은 필드로 전송합니다.**

```json
{
  "type": "input",
  "angle": 135.5,
  "boost": false
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `angle` | float | 0~360°, 시계 방향. East(오른쪽) = 0°. `atan2(mouseY − headY, mouseX − headX)`로 계산 |
| `boost` | bool | `true` = 부스트 ON (속도 2×, 질량 소모) |

> 서버는 새 `input`을 받기 전까지 마지막 각도를 유지합니다.

---

### 4.3 `resync` — 전체 상태 재요청

클라이언트가 상태 불일치를 감지했을 때 전송합니다. 서버는 `init`으로 응답합니다.

```json
{
  "type": "resync"
}
```

---

### 4.4 `ping` — 레이턴시 측정

```json
{
  "type": "ping",
  "ts": 1717459200000
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `ts` | integer | 클라이언트 타임스탬프 (ms, Unix epoch) |

---

## 5. 서버 → 클라이언트 메시지

### 5.1 `init` — 초기 전체 스냅샷

`join` 수신 직후 1회 전송. `resync` 요청 시에도 재전송합니다.

```json
{
  "type": "init",
  "tick": 10423,
  "world": {
    "width": 6000,
    "height": 6000
  },
  "players": [ /* Player[] */ ],
  "food":    [ /* Food[]   */ ]
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `tick` | integer | 현재 서버 틱 번호 (단조 증가) |
| `world` | object | 월드 크기 (픽셀 단위 논리 좌표) |
| `players` | Player[] | 현재 방 내 모든 살아있는 플레이어 |
| `food` | Food[] | 현재 방 내 모든 먹이 |

---

### 5.2 `tick` — 델타 업데이트 (매 50ms)

변경이 있는 항목만 포함합니다. 빈 배열·없는 필드는 생략합니다.

```json
{
  "type": "tick",
  "tick": 10424,
  "moves": [
    {
      "id": "uuid-player-1",
      "head": { "x": 312.5, "y": 204.1 },
      "grew": false
    }
  ],
  "spawns":       [ /* Player[] — 새로 접속/리스폰된 플레이어 */ ],
  "deaths":       [ "uuid-player-2" ],
  "food_spawned": [ /* Food[] */ ],
  "food_eaten":   [ "uuid-food-7" ],
  "scores":       [
    { "id": "uuid-player-1", "score": 4820 }
  ]
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `tick` | integer | 이 델타가 속한 틱 번호 |
| `moves[].id` | string | 이동한 플레이어 ID |
| `moves[].head` | `{x, y}` | 이 틱의 새 머리 위치 |
| `moves[].grew` | bool | `true`이면 꼬리를 제거하지 않음(먹이 섭취) |
| `spawns` | Player[] | 이 틱에 입장/리스폰한 플레이어 (전체 세그먼트 포함) |
| `deaths` | string[] | 이 틱에 사망한 플레이어 ID 목록 |
| `food_spawned` | Food[] | 새로 생성된 먹이 |
| `food_eaten` | string[] | 섭취되어 사라진 먹이 ID |
| `scores` | object[] | 이 틱에 점수가 바뀐 플레이어만 포함 |

**클라이언트 세그먼트 재구성 규칙:**
```
segments.unshift(new_head)     // 머리 추가
if (!grew) segments.pop()      // grew=false 이면 꼬리 제거
```

---

### 5.3 `self_death` — 본인 사망 알림

```json
{
  "type": "self_death",
  "tick": 10430,
  "killed_by": "uuid-player-3",
  "score":  3210,
  "rank":   12
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `killed_by` | string \| null | 충돌한 상대 플레이어 ID. `null` = 벽/자기충돌 |
| `score` | integer | 최종 점수 |
| `rank` | integer | 사망 시점 순위 |

> 사망한 플레이어의 세그먼트는 `tick.food_spawned`에 동시 포함됩니다(사체 먹이 변환).

---

### 5.4 `leaderboard` — 리더보드 (저주기 브로드캐스트)

5초마다 전체 브로드캐스트. 상위 10명만 포함합니다.

```json
{
  "type": "leaderboard",
  "tick": 10500,
  "entries": [
    { "rank": 1, "id": "uuid-player-5", "name": "TopSnake", "score": 12400 }
  ]
}
```

---

### 5.5 `pong` — 레이턴시 응답

```json
{
  "type": "pong",
  "ts":        1717459200000,
  "server_ts": 1717459200015
}
```

---

### 5.6 `error` — 오류 알림

```json
{
  "type": "error",
  "code": "ROOM_FULL",
  "message": "Maximum players reached."
}
```

---

## 6. 데이터 오브젝트

### 6.1 Player Object

```json
{
  "id":       "uuid-player-1",
  "name":     "SnakeKing",
  "skin":     "#e74c3c",
  "score":    0,
  "length":   12,
  "segments": [
    { "x": 310.0, "y": 200.0 },
    { "x": 305.5, "y": 199.3 },
    { "x": 301.1, "y": 198.6 }
  ]
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | 서버 발급 UUID |
| `segments` | `{x,y}[]` | `[0]`이 머리. `init` / `spawns`에서만 전체 전달 |
| `length` | integer | 세그먼트 수 (클라이언트가 segments.length로 검증 가능) |

**좌표계:** 원점(0,0)은 월드 좌상단. X축 오른쪽↑, Y축 아래↑.

---

### 6.2 Food Object

```json
{
  "id":    "uuid-food-42",
  "x":     1024.0,
  "y":     800.5,
  "value": 1,
  "color": "#2ecc71"
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `value` | integer | 먹었을 때 증가하는 질량 (기본 1, 사체 먹이는 더 클 수 있음) |
| `color` | string | 표시 색상 |

---

## 7. 틱 & 업데이트 주기

| 파라미터 | 값 | 비고 |
|---|---|---|
| 서버 틱레이트 | 20 TPS (50ms) | 물리·충돌 계산 주기 |
| 클라이언트 렌더 | 60 FPS | 틱 간 선형 보간 |
| 입력 전송 주기 | ≤ 20 Hz | mousemove throttle |
| 리더보드 주기 | 0.2 Hz (5s) | 저주기 별도 브로드캐스트 |
| 점수 전송 | 변경 틱에만 | `tick.scores`에 포함 |

### 클라이언트 보간 (60fps ↔ 20TPS)

틱 간격(50ms) 사이에서 뱀 머리를 이전 위치 → 최신 수신 위치로 선형 보간해 부드러운 움직임을 구현합니다.

```
t = (now − last_tick_time) / TICK_INTERVAL   // 0.0 ~ 1.0
rendered_x = lerp(prev_head.x, curr_head.x, t)
rendered_y = lerp(prev_head.y, curr_head.y, t)
```

### 부스트 동작

| 조건 | 서버 처리 |
|---|---|
| `boost: true` 전송 | 이동 속도 2× |
| 부스트 지속 | 매 틱마다 꼬리 세그먼트 1개 소모 → `tick.food_spawned`에 추가 |
| 최소 길이 미만 | 부스트 무시 |

---

## 8. 연결 수명주기

```
Client                             Server
  │─── WS connect ───────────────────>│
  │─── join {name, skin} ───────────> │
  │<─── init {tick, world,            │
  │          players, food} ──────────│
  │                                   │  (매 50ms)
  │<─── tick {moves, ...} ────────────│
  │─── input {angle, boost} ────────> │
  │               ···                 │
  │─── resync ──────────────────────> │  (상태 불일치 감지 시)
  │<─── init ─────────────────────────│
  │               ···                 │
  │<─── self_death ───────────────────│  (사망 시)
  │─── join (재접속) ───────────────> │
```

---

## 9. 에러 코드

| code | 발생 조건 |
|---|---|
| `ROOM_FULL` | 최대 플레이어 수 초과 |
| `INVALID_NAME` | name이 빈 값이거나 20자 초과 |
| `RATE_LIMITED` | `input` 전송이 30Hz 초과 |
| `UNKNOWN_TYPE` | 알 수 없는 메시지 타입 |

---

## 10. 미결 사항 (v0.1 → v0.2 전 확인 필요)

| # | 항목 | 현재 가정 | 확인 대상 |
|---|---|---|---|
| 1 | 좌표계 원점 | 월드 좌상단 (0,0) | 서버 개발자 확인 |
| 2 | 최대 플레이어 수 | 미정 | 서버/인프라 결정 |
| 3 | Skin 포맷 | hex color 단일 색상 | 클라이언트 그래디언트 지원 여부 |
| 4 | 세그먼트 간격 | 고정 픽셀 간격 | 서버 물리 설계 확인 |
| 5 | 리스폰 정책 | 즉시 재접속 (`join` 재전송) | 쿨다운/로비 여부 |
