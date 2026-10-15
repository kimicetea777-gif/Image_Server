# Image Server

여러 개인 프로젝트가 공유하는 **이미지 업로드·처리 전용 서버**입니다.
프로젝트는 API 키만 발급받으면 리사이즈, webp 변환, Cloudflare R2 저장, 쓰이지 않은 이미지의 자동 정리(GC)까지 그대로 사용합니다.

기존 웹 서비스에서 운영하던 업로드·변환·정리 로직(리사이즈는 프론트 서버, R2 업로드와 GC는 백엔드)을 떼어내 독립 서비스로 다시 구현했습니다.

## 스택

- Node.js 24 · TypeScript · Fastify 5
- sharp (libvips) — 리사이즈, webp 변환
- SQLite (Node 내장 `node:sqlite`) — 프로젝트(API 키), 이미지 상태 저장
- Cloudflare R2 (S3 호환 API) — 이미지 저장·서빙
- Docker Compose — 단일 인스턴스 운영

## 구조

```
[브라우저] ─▶ [프로젝트 서버 (API 키 보관, 로그인 확인)] ─ 업로드 ─▶ Image Server ─▶ R2
                                                                    │
[프로젝트 백엔드 (게시글 저장 시점)] ─ confirm / release ─────────────┴─▶ SQLite
```

- API 키는 브라우저가 아니라 **프로젝트 서버만** 보관합니다. 브라우저는 이 서버를 직접 호출하지 않습니다.
- 이미지 서버는 "게시글당 몇 장까지" 같은 도메인 규칙을 모르고, 이미지 하나하나의 상태만 관리합니다.

## 이미지 라이프사이클

```
업로드 ──▶ PENDING ──confirm──▶ COMMITTED
              │
              ├─ release ──▶ 즉시 삭제
              └─ 24시간 동안 confirm 없음 ──▶ GC가 삭제
```

| 상태 | 의미 |
|---|---|
| `PENDING` | 업로드됐지만 아직 사용이 확정되지 않음 |
| `COMMITTED` | 호출 측이 사용을 확정함, GC 대상 아님 |
| `DELETE_REQUESTED` | 삭제가 결정됐지만 R2 삭제가 아직 확인되지 않음, 다음 GC 스윕에서 재시도 |

GC는 1시간마다 돌며, R2 삭제가 확인된 이미지만 DB에서 지웁니다.

## API

모든 `/images` 요청은 `X-Api-Key` 헤더가 필요합니다. 요청은 호출한 프로젝트의 이미지로만 범위가 제한됩니다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/images` | multipart 업로드(`file`, 선택 `maxWidth`·`quality`) → 리사이즈·webp 변환 → `PENDING` 기록 → R2 저장. `{ id, url, width, height, format }` 반환 |
| `POST` | `/images/confirm` | `{ ids }` → `COMMITTED`로 전환. 멱등(이미 확정된 id도 성공으로 응답) |
| `POST` | `/images/release` | `{ ids }` → R2와 DB에서 삭제. R2 삭제 실패 시 `DELETE_REQUESTED`로 표시 |
| `GET` | `/images/:id` | 이미지 메타데이터 조회 |
| `DELETE` | `/images` | 호출 프로젝트의 이미지 전부 삭제 — `test` 프로젝트 전용(그 외 403) |
| `GET` | `/healthz` | 헬스체크 (인증 불필요) |

- `confirm`/`release`는 요청당 id 1~20개입니다. 다른 프로젝트의 id나 없는 id는 에러 없이 무시하고, 응답의 `confirmed`/`released` 목록에서 빠집니다. 호출 측은 요청한 id가 응답에 전부 있는지 확인해야 합니다.
- 응답 코드: `401` API 키 없음·불일치, `400` 옵션 범위 위반, `413` 파일 크기 초과, `415` 지원하지 않는 형식, `429` rate limit 초과

### 업로드 예시

```bash
curl -X POST http://localhost:4001/images \
  -H "X-Api-Key: <API 키>" \
  -F "file=@photo.jpg" \
  -F "maxWidth=1280" \
  -F "quality=85"
```

## 설계 결정

### R2와 DB의 정합성: DB에 먼저 기록

R2와 DB는 하나의 트랜잭션으로 묶을 수 없습니다. 그래서 업로드할 때 **복구 가능한 쪽(GC가 훑는 DB)에 `PENDING`을 먼저 기록**하고 R2에 올립니다.

| 실패 지점 | 결과 |
|---|---|
| DB 기록 실패 | 아직 아무것도 올리지 않았으므로 에러만 반환 |
| R2 업로드 실패 | row를 `DELETE_REQUESTED`로 표시 → 다음 GC 스윕이 정리 |
| 위 표시마저 실패하거나 프로세스가 죽음 | row가 `PENDING`으로 남음 → 24시간 뒤 GC가 정리 |

R2 업로드가 실패해도 row를 바로 지우지 않는 이유는, 타임아웃이면 실제로는 업로드됐을 수 있기 때문입니다. GC가 키 삭제를 시도하면 R2는 없는 키여도 성공으로 응답하므로 어느 경우든 정리됩니다. 이미지 id는 업로드가 끝난 뒤에야 응답으로 나가므로, 업로드 중인 row를 외부에서 볼 수는 없습니다.

### GC와 confirm의 경쟁 조건: 삭제 전 선점

GC는 만료된 `PENDING` 목록을 조회한 뒤 하나씩 R2에서 지웁니다. R2 삭제를 `await`하는 동안 다른 요청이 실행될 수 있어서, 그사이 도착한 `confirm`이 확정한 이미지를 GC가 지울 수 있었습니다.

그래서 지우기 직전에 조건부 UPDATE로 **선점**합니다.

```sql
UPDATE images SET status = 'DELETE_REQUESTED' WHERE id = ? AND status = 'PENDING'
```

바뀐 행이 없으면(이미 확정됨) 건너뜁니다. GC와 `confirm` 중 먼저 온 쪽만 성공하고, 확정 응답을 받은 이미지가 지워지는 일은 없습니다.

### 그 밖의 결정

- **매직 바이트로 형식 판별**: 확장자와 `Content-Type`은 믿지 않습니다. JPEG, PNG, WebP, BMP만 허용하고, 모두 webp로 다시 인코딩합니다.
- **EXIF 처리**: 회전 정보를 반영해 픽셀을 바로잡은 뒤 메타데이터를 제거합니다. 사진의 GPS 위치 정보가 저장되지 않습니다.
- **API 키는 SHA-256 해시로 저장**: 길고 랜덤한 키를 전제로 하므로 빠른 해시로 충분하고, 해시로 바로 조회할 수 있습니다.
- **Rate limit은 메모리에, 업로드에만**: 프로젝트별 10초 슬라이딩 윈도우입니다. 요청마다 쓰기가 생기는 카운터를 SQLite에 두면 병목이 되고, 단일 인스턴스라 Redis가 필요 없습니다.
- **SQLite + 단일 인스턴스**: 여러 인스턴스로 늘릴 계획이 없다는 전제 위에서 선택했습니다. WAL 모드로 읽기와 쓰기가 서로를 막지 않습니다. 늘려야 한다면 Postgres와 공유 rate limit 저장소로 옮겨야 합니다.
- **sharp 메모리**: libvips는 V8 힙 밖의 네이티브 메모리를 씁니다. 컨테이너 메모리 384MB 안에서 Node 힙을 192MB로 제한해 이미지 처리 여유를 남겼습니다.
- **하지 않은 것**: 큐 기반 비동기 처리, Redis, Postgres, 다중 인스턴스는 현재 규모에 필요하지 않아 도입하지 않았습니다.

## 실행

### 로컬

```bash
npm install
cp .env.example .env    # R2 자격증명과 PROJECTS 값을 채움
npm run dev             # http://localhost:4001
```

### Docker

```bash
docker compose up -d --build
curl http://127.0.0.1:4001/healthz
```

- 멀티스테이지 빌드로 런타임 이미지에는 컴파일 결과와 운영 의존성만 담습니다.
- root가 아닌 `node` 유저로 실행하고, 컨테이너 `HEALTHCHECK`가 `/healthz`를 확인합니다.
- `SIGTERM`을 받으면 처리 중인 요청을 마친 뒤 종료합니다.
- 포트는 `127.0.0.1`에만 바인딩합니다. 외부 공개는 앞단의 리버스 프록시(운영에서는 Cloudflare Tunnel)가 맡습니다.

### 프로젝트 등록

`.env`의 `PROJECTS`에 `slug:apiKey[:rateLimit]`를 콤마로 구분해 적고 재시작하면, 서버가 시작할 때 DB에 반영합니다. 키 교체와 rate limit 변경도 같은 방식입니다.

```bash
PROJECTS=my_board:<openssl rand -hex 32 결과>,test:<다른 랜덤 키>:20
```

### 환경 변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `4000` | 서버 포트 (`.env.example`은 compose 매핑에 맞춰 4001) |
| `DATABASE_PATH` | `./data/image_server.sqlite` | SQLite 파일 경로 |
| `PROJECTS` | (없음) | 등록 프로젝트 목록 |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL` | (필수) | R2 접속 정보와 공개 URL |
| `MAX_UPLOAD_BYTES` | `10485760` (10MB) | 업로드 최대 크기 |
| `GC_SWEEP_INTERVAL_MS` | `3600000` (1시간) | GC 주기 |
| `GC_PENDING_TTL_HOURS` | `24` | 미확정 이미지 보존 시간 |

필수 값이 없거나 형식이 틀리면 서버가 시작하지 않습니다(zod 검증).
