# 웹주소(도메인) 연결과 배포 절차

목표 주소 예시
- 학생: `https://app.winners-ai.kr/s/<반 QR 토큰>` (QR 코드가 가리키는 곳, 홈 화면 앱)
- 원장님: `https://app.winners-ai.kr/director`
- 랜딩(홍보) 페이지: `https://winners-ai.kr`

---

## 1. 어디에 올릴까: Vercel·Netlify보다 Render를 권합니다

| | Vercel / Netlify | Render (권장) | 국내 클라우드 (네이버 클라우드, AWS 서울) |
| --- | --- | --- | --- |
| 이 서비스와 맞는 정도 | 낮음. 화면만 있는 사이트·짧게 실행되는 함수용이라, 금요일 18시 알림톡 스케줄러와 월 자동결제처럼 **계속 켜져 있는 서버**가 기본으로는 안 맞음. 코드 구조를 바꿔야 함 | 높음. 지금 코드 그대로(`npm start`) 올라가고 PostgreSQL도 같은 곳에서 만듦 | 높음. 대신 서버 설정을 직접 해야 해서 개발자 도움 필요 |
| 서버 위치 | 해외 | 싱가포르 선택 가능 (한국 리전은 없음) | 한국 |
| 추천 시점 | 랜딩페이지만 따로 올릴 때 | **MVP·시범 운영** | 학원 수가 늘고 국내 보관이 중요해질 때 |

Render의 무료 서버는 쓰지 마세요. 사용이 없으면 잠들어서 금요일 발송 시각을 놓칠 수 있고, 무료 요금제에서는 내 도메인을 연결할 수 없습니다. 요금은 [Render 요금표](https://render.com/pricing)에서 확인하세요.

## 2. 배포 순서 — 코딩 없이 클릭으로 (Render Blueprint)

코드 묶음 맨 위에 `render.yaml`이 있어서, Render가 이 파일을 읽고 **서버와 DB를 한 번에** 만듭니다.
DB 테이블과 학원별 분리 설정은 서버가 켜질 때 `db/setup.js`가 자동으로 해 줍니다(터미널 명령 필요 없음).
보안 키 3개(JWT_SECRET, PII_ENC_KEY, PII_HASH_KEY)는 Render가 무작위로 만들어 줍니다.

| 단계 | 하는 곳 | 하는 일 |
| --- | --- | --- |
| 1 | GitHub | 회원가입 → **비공개(Private)** 저장소 `winners-ai` 만들기 → 압축 푼 폴더 **안의 파일 전부**를 끌어다 올리기 (Chrome 권장) |
| 2 | Render | GitHub 계정으로 가입 → 결제 카드 등록 |
| 3 | Render | **New → Blueprint** → `winners-ai` 저장소 **Connect** |
| 4 | Render | 입력칸 2개 채우기: `ANTHROPIC_API_KEY`(Claude API 키), `DEMO_STUDENT_PIN`(체험 학생 비밀번호 숫자 4자리) → **Deploy Blueprint** |
| 5 | Render | 서버의 **Logs**에서 `학생 체험 주소: …/s/winners-demo` 확인 → 휴대폰으로 접속, 출석번호 `1` + PIN. 영어 첨삭은 `…/s/winners-demo-en` |
| 6 | 가비아·Cloudflare 등 | 도메인 구입 → Render **Settings → Custom Domains**에 `app.도메인` 추가 → 알려 주는 CNAME을 도메인 회사 DNS에 입력 → **Verify** |
| 7 | Render | **Environment**에 `APP_BASE_URL=https://app.도메인` 추가 → 저장(자동 재배포) |
| 8 | Render | 카카오 템플릿 승인 후 `SOLAPI_API_KEY`, `SOLAPI_API_SECRET`, `KAKAO_PF_ID`, `KAKAO_TEMPLATE_WEEKLY`, `KAKAO_TEMPLATE_COUNSEL` 추가 → 원장님 번호로 1건 시험 → `DRY_RUN=0` |

`render.yaml`의 사양: 서버 `0.5c-512mb`(유료 최소), DB `0.1c-256mb`, 지역 `singapore`, DB는 외부 접속 차단(`ipAllowList: []`).
요금은 Deploy 전에 Render 화면에 표시되니 확인 후 진행하세요.

**원장님 관리자 화면 (`/director`) 계정 만들기**
1. Render → `winners-ai` 서버 → **Environment** → **Add Environment Variable**
2. `DIRECTOR_EMAIL` = 원장님 로그인 이메일, `DIRECTOR_PASSWORD` = 8자 이상 비밀번호 (채팅·메신저에 붙여 넣지 말고 이 칸에만)
3. **Save, rebuild, and deploy** → Logs에 `원장님 관리자 계정을 만들었습니다` 확인
4. `https://<서버주소>/director` 로그인 → **⚙️ 설정 → 비밀번호 바꾸기**로 한 번 바꿔 두면 안전
- 계정은 처음 한 번만 만들어집니다(이미 있으면 그대로 둠). 체험용 반(`winners-demo`)이 있는 학원에 연결돼요.
- 관리자 화면에서 할 수 있는 것: 오늘 현황·선생님 노트, 질문 기록(대화 전체·튜터 요약), 반 만들기·반별 QR(PNG 저장), 학생 등록·비밀번호 재설정·퇴원,
  주간 상담글 생성·수정·승인, 첨삭 기록, 지도 방식·말투·발송 시각·교재 설정, 요금제 변경.

## 3. 홈 화면 앱(PWA) 확인 방법

PWA는 **https 주소에서만** 동작합니다. 5번까지 끝나야 시험할 수 있어요.

- **아이폰**: Safari로 QR 주소 열기 → 아래쪽 공유 버튼(□↑) → "홈 화면에 추가" → 아이콘을 누르면 주소창 없이 질문창이 바로 열림. 다른 브라우저보다 Safari가 가장 확실합니다.
- **안드로이드**: 크롬으로 열기 → 질문창 위에 뜨는 "추가" 버튼, 또는 메뉴(⋮) → "홈 화면에 추가 / 앱 설치"
- 확인할 것: 아이콘 모양, 앱 이름("위너스학원 원장쌤"), 다시 열었을 때 로그인 유지(기본 7일), 사진 버튼으로 카메라·앨범 열림, 비행기 모드에서 "인터넷이 연결되지 않았어요" 화면

포함된 파일
- `public/student.html`, `public/student.js` — 실제 학생 질문창 (로그인·질문·힌트·사진)
- `/s/<토큰>/manifest.webmanifest` — 반마다 다른 시작 주소를 가진 앱 정보 (서버가 만들어 줌)
- `public/sw.js` — 서비스 워커. 화면 껍데기만 저장하고 질문·대화는 저장하지 않음
- `public/offline.html` — 인터넷이 끊겼을 때 안내
- `public/icons/` — 192·512px 아이콘, 안드로이드 maskable 아이콘, 아이폰용 180px 아이콘

## 4. 꼭 챙길 것

- **개인정보 국외 이전 고지**: Render 싱가포르 서버와 Claude(미국)를 쓰므로, 개인정보 처리방침과 학부모 동의서에 "국외 이전(받는 자, 국가, 항목, 보관 기간)"을 적어야 합니다.
- **백업**: Render PostgreSQL 백업 설정 확인.
- **키 관리**: API 키·비밀번호는 Render의 Environment 메뉴에만 입력하고, 채팅·메신저·GitHub에 남기지 않습니다.
