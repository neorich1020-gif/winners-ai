-- =========================================================
-- 학원 AI 페르소나 MVP - PostgreSQL 스키마
-- 원칙: 1) 학원(academy) 단위로 데이터 완전 분리
--       2) 학생 실명/학부모 연락처는 암호화 저장, AI에는 절대 전달하지 않음
--       3) 보관기간이 지난 대화는 자동 파기
-- =========================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 학원 (= 구독 고객)
CREATE TABLE academies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  director_name    TEXT NOT NULL,          -- 화면 표시용 (예: "김원장")
  persona_name     TEXT NOT NULL DEFAULT '원장쌤',
  persona_style    TEXT NOT NULL DEFAULT '', -- 말투 설명 (예: "다정하지만 단호, 경상도 사투리 살짝")
  persona_examples TEXT NOT NULL DEFAULT '', -- 원장님이 실제로 쓰는 말 예시 3~10줄
  report_weekday   SMALLINT NOT NULL DEFAULT 5,    -- 0=일 ... 5=금
  report_time      TIME NOT NULL DEFAULT '18:00',  -- 한국시간
  report_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  -- 주간 상담글 관련
  counsel_tone     TEXT NOT NULL DEFAULT '따뜻하고 꼼꼼하게. 학부모님께 정중한 존댓말, 구체적인 장면 하나와 다음 주 계획을 꼭 넣는다.',
  counsel_signature TEXT NOT NULL DEFAULT '',            -- 예: "위너스학원 원장 김OO 드림"
  stats_fallback   BOOLEAN NOT NULL DEFAULT TRUE,        -- 승인된 상담글이 없는 학생은 자동 통계 리포트로 대신 발송
  plan_status      TEXT NOT NULL DEFAULT 'trial'   -- trial | active | past_due | canceled
                   CHECK (plan_status IN ('trial','active','past_due','canceled')),
  trial_ends_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '14 days',
  retention_days   INT NOT NULL DEFAULT 365,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 원장/강사 계정
CREATE TABLE staff (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id    UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,             -- bcrypt
  role          TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','teacher')),
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 반(클래스) & 교재
CREATE TABLE classes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id  UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,               -- 예: "중2 수학 A반"
  subject     TEXT NOT NULL CHECK (subject IN ('math','english','science','korean','etc')),
  grade_band  TEXT NOT NULL CHECK (grade_band IN ('elementary','middle','high')),
  qr_token    TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16),'hex'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE materials (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id  UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  class_id    UUID REFERENCES classes(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,               -- 예: "개념원리 중2-1 3단원"
  scope_note  TEXT NOT NULL DEFAULT '',    -- 이번 주 진도/범위 요약
  content     TEXT NOT NULL DEFAULT '',    -- 핵심 개념·풀이 원칙 (원장님 입력, 저작권 있는 교재 원문 전체 업로드 금지 안내)
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 학생: AI와 화면에는 '닉네임'만 사용. 실명은 암호화.
CREATE TABLE students (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id      UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  class_id        UUID REFERENCES classes(id) ON DELETE SET NULL,
  nickname        TEXT NOT NULL,           -- 예: "민준" (이름만, 성 제외 권장)
  real_name_enc   BYTEA,                   -- AES-256-GCM
  login_code      TEXT NOT NULL,           -- 반 안에서 학생 구분용 4자리 번호
  pin_hash        TEXT NOT NULL,           -- 4자리 PIN bcrypt
  is_under_14     BOOLEAN NOT NULL DEFAULT TRUE,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (class_id, login_code)
);

-- 학부모 연락처 + 동의 기록 (동의 없으면 발송하지 않음)
CREATE TABLE guardians (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id         UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  student_id         UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  relation           TEXT NOT NULL DEFAULT '보호자',
  phone_enc          BYTEA NOT NULL,       -- 암호화된 휴대폰번호
  phone_hash         TEXT NOT NULL,        -- 중복 확인용 HMAC (원문 복원 불가)
  consent_privacy_at TIMESTAMPTZ,          -- 개인정보 수집·이용 동의 (14세 미만은 법정대리인 동의)
  consent_report_at  TIMESTAMPTZ,          -- 주간 리포트 수신 동의
  consent_ai_at      TIMESTAMPTZ,          -- 대화 내용의 AI 처리(국외 이전 포함) 동의
  report_opt_out     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 질문 세션 (문제 1개 = 세션 1개, 힌트 단계 추적)
CREATE TABLE question_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id   UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  topic        TEXT,                       -- AI가 분류한 단원/개념 (예: "일차함수 기울기")
  hint_level   SMALLINT NOT NULL DEFAULT 0,   -- 0~4
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','solved','gave_up','flagged')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ
);

CREATE TABLE messages (
  id          BIGSERIAL PRIMARY KEY,
  academy_id  UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  session_id  UUID NOT NULL REFERENCES question_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('student','ai','system')),
  content     TEXT NOT NULL,               -- 저장 전 전화번호·주소 등 마스킹
  verdict     TEXT,                        -- hint | check | refuse_offtopic | safety | blocked_input
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON messages (academy_id, created_at);

-- 안전 이슈(괴롭힘·자해 암시 등) → 원장님 대시보드 알림
CREATE TABLE safety_flags (
  id          BIGSERIAL PRIMARY KEY,
  academy_id  UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  message_id  BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  category    TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 주간 리포트 (학생 × 주차 당 1건 → 중복 발송 방지)
CREATE TABLE weekly_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id    UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  guardian_id   UUID NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  week_start    DATE NOT NULL,             -- 해당 주 월요일
  kind          TEXT NOT NULL DEFAULT 'stats' CHECK (kind IN ('stats','counsel')), -- 자동 통계 | 원장 승인 상담글
  counsel_id    UUID,                      -- kind='counsel'일 때 counsel_notes.id
  stats         JSONB NOT NULL,
  summary_text  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts      SMALLINT NOT NULL DEFAULT 0,
  provider_msg_id TEXT,
  error         TEXT,
  sent_at       TIMESTAMPTZ,
  UNIQUE (guardian_id, week_start)
);

-- 구독/결제
CREATE TABLE subscriptions (
  academy_id     UUID PRIMARY KEY REFERENCES academies(id) ON DELETE CASCADE,
  customer_key   TEXT NOT NULL UNIQUE,     -- 토스 customerKey (추측 불가한 랜덤값)
  billing_key_enc BYTEA,                   -- 빌링키도 암호화
  card_label     TEXT,                     -- 예: "신한 ****1234"
  amount_krw     INT NOT NULL,
  next_billing_at TIMESTAMPTZ,
  fail_count     SMALLINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id  UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  order_id    TEXT NOT NULL UNIQUE,
  amount_krw  INT NOT NULL,
  status      TEXT NOT NULL,               -- DONE | FAILED
  payment_key TEXT,
  raw_error   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 감사 로그: 누가 언제 어떤 개인정보를 열람/수정/다운로드했는지
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  academy_id  UUID,
  actor       TEXT NOT NULL,               -- staff:<id> | system | student:<id>
  action      TEXT NOT NULL,               -- view_guardian_phone, export, delete_student ...
  target      TEXT,
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 행 단위 보안(RLS): 앱이 SET app.academy_id 후 쿼리 → 다른 학원 데이터 접근 원천 차단
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['classes','materials','students','guardians','question_sessions',
                           'messages','safety_flags','weekly_reports','payments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (academy_id = NULLIF(current_setting('app.academy_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
-- ※ 스케줄러/결제 배치는 RLS 우회 권한이 있는 별도 DB 역할(batch_role)로 실행

-- QR 조회 함수 resolve_class 는 db/functions.sql 에 있습니다


-- =========================================================
-- 주간 상담글 (원장님 키워드 → AI 초안 → 원장님 수정·승인 → 금요일 발송)
-- 학생 × 주차 당 1건. 승인(approved)된 것만 발송된다.
-- 상태: empty(입력만) → draft(AI 초안/수정 중) → approved(발송 대기) → sent | failed
--       승인 후 본문을 고치면 다시 draft로 돌아가 재승인이 필요하다.
-- =========================================================
CREATE TABLE counsel_notes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id     UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  student_id     UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  week_start     DATE NOT NULL,
  subject        TEXT NOT NULL DEFAULT '',     -- 과목 (예: "수학")
  progress       TEXT NOT NULL DEFAULT '',     -- 이번 주 학습 상태/진도 키워드
  attitude       TEXT NOT NULL DEFAULT '',     -- 수업 태도/특이사항 키워드
  draft_text     TEXT,                         -- AI가 만든 원본 (비교·재생성용)
  final_text     TEXT,                         -- 원장님이 최종 수정한 본문 (발송 대상)
  status         TEXT NOT NULL DEFAULT 'empty'
                 CHECK (status IN ('empty','draft','approved','sent','failed')),
  gen_count      SMALLINT NOT NULL DEFAULT 0,  -- 재생성 횟수 (학원당 비용 상한 관리)
  approved_by    UUID REFERENCES staff(id) ON DELETE SET NULL,
  approved_at    TIMESTAMPTZ,
  sent_at        TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, week_start)
);
CREATE INDEX ON counsel_notes (academy_id, week_start);
ALTER TABLE counsel_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON counsel_notes USING (academy_id = NULLIF(current_setting('app.academy_id', true), '')::uuid);

-- 상담글 '전체 보기' 링크 모드용 (알림톡엔 요약 + 버튼, 본문은 이 링크에서 열람)
CREATE TABLE letter_links (
  token        TEXT PRIMARY KEY DEFAULT encode(gen_random_bytes(24),'hex'),
  counsel_id   UUID NOT NULL REFERENCES counsel_notes(id) ON DELETE CASCADE,
  guardian_id  UUID NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  opened_at    TIMESTAMPTZ
);

-- 상담글 링크 함수 open_letter 는 db/functions.sql 에 있습니다


-- =========================================================
-- 학생 질문 사진 (문제집·학습지 촬영)
-- 사진에는 이름·학교·얼굴이 찍힐 수 있으므로 짧게만 보관: 7일 후 자동 삭제 (server.js 새벽 작업)
-- =========================================================
CREATE TABLE question_images (
  id          BIGSERIAL PRIMARY KEY,
  academy_id  UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  session_id  UUID NOT NULL REFERENCES question_sessions(id) ON DELETE CASCADE,
  message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_type  TEXT NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
  bytes       INT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON question_images (session_id);
CREATE INDEX ON question_images (created_at);
ALTER TABLE question_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON question_images USING (academy_id = NULLIF(current_setting('app.academy_id', true), '')::uuid);

-- =========================================================
-- 요금제 3종 (화면에 보이는 기능 설명은 src/lib/plans.js가 기준)
--  lite      라이트     월 49,000원  학생 30명 이하, 사진 질문 학원 전체 월 100회
--  standard  스탠다드   월 69,000원  학생 60명 이하, 사진 무제한 (정가 99,000원 → 출시 기념 평생 할인)
--  premium   프리미엄   월 119,000원 학생 60명 초과·다과목 학원, 인원 제한 없음
-- '학생 수' = students.active = TRUE 인 인원 (퇴원 처리하면 빠짐)
-- =========================================================
CREATE TABLE plans (
  code                TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  price_krw           INT  NOT NULL,          -- 실제 청구 금액
  list_price_krw      INT,                    -- 정가(할인 표시용, 없으면 NULL)
  promo_label         TEXT,                   -- 예: '출시 기념 평생 할인'
  promo_locks_price   BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE면 가입 시 가격을 평생 고정
  max_students        INT,                    -- NULL = 제한 없음
  photo_monthly_limit INT,                    -- NULL = 무제한 (학원 전체 기준, 매월 1일 초기화)
  features            TEXT[] NOT NULL DEFAULT '{}',
  sort_order          SMALLINT NOT NULL DEFAULT 0,
  is_default          BOOLEAN NOT NULL DEFAULT FALSE,
  active              BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO plans (code, name, price_krw, list_price_krw, promo_label, promo_locks_price, max_students, photo_monthly_limit, features, sort_order, is_default) VALUES
 ('lite',     '라이트',   49000, NULL,  NULL, FALSE, 30,   100,
   '{text_unlimited,photo_limited,weekly_counsel,alimtalk}', 1, TRUE),
 ('standard', '스탠다드', 69000, 99000, '출시 기념 평생 할인', TRUE, 60, NULL,
   '{text_unlimited,photo_unlimited,weekly_counsel,alimtalk,exam_mode,voice_report,trial_mode}', 2, FALSE),
 ('premium',  '프리미엄', 119000, NULL, NULL, FALSE, NULL, NULL,
   '{text_unlimited,photo_unlimited,weekly_counsel,alimtalk,exam_mode,voice_report,trial_mode,multi_persona,promo_writer}', 3, FALSE);

-- 학원이 고른 요금제 (체험 중에도 선택 플랜 기준으로 기능·한도 적용)
ALTER TABLE academies ADD COLUMN plan_code TEXT NOT NULL DEFAULT 'lite' REFERENCES plans(code);
ALTER TABLE academies ADD COLUMN price_locked_krw INT;   -- 평생 할인으로 고정된 월 요금 (NULL이면 플랜 가격)
ALTER TABLE subscriptions ALTER COLUMN amount_krw SET DEFAULT 49000;

-- 월별 사용량 (라이트 사진 질문 100회 차감용). 사진 파일은 7일 뒤 지워져도 횟수는 여기 남는다.
CREATE TABLE monthly_usage (
  academy_id      UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  month           DATE NOT NULL,                 -- 그 달 1일 (한국 시간)
  photo_questions INT  NOT NULL DEFAULT 0,
  limit_notified_at TIMESTAMPTZ,                 -- 한도 소진 안내를 원장님께 띄운 시각
  PRIMARY KEY (academy_id, month)
);
ALTER TABLE monthly_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON monthly_usage USING (academy_id = NULLIF(current_setting('app.academy_id', true), '')::uuid);

-- 플랜 변경 기록
CREATE TABLE plan_changes (
  id          BIGSERIAL PRIMARY KEY,
  academy_id  UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  from_code   TEXT, to_code TEXT NOT NULL, price_krw INT NOT NULL,
  changed_by  UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 학원 정보 화면용 대표번호
ALTER TABLE academies ADD COLUMN contact_phone TEXT NOT NULL DEFAULT '';

-- 가입(온보딩): 30분 무료 화상(Zoom) 세팅 신청
ALTER TABLE academies ADD COLUMN setup_call_requested_at TIMESTAMPTZ;
ALTER TABLE academies ADD COLUMN setup_call_note TEXT NOT NULL DEFAULT '';   -- 희망 시간대 등
ALTER TABLE academies ADD COLUMN expected_students INT;                     -- 가입 시 적은 예상 학생 수
