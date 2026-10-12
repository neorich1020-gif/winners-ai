-- =========================================================
-- 기능 추가용 변경 (여러 번 실행해도 안전 — 서버 시작 때 db/setup.js가 매번 실행)
-- 이미 운영 중인 DB에도 새 기능이 자동으로 들어가게 하려고 schema.sql과 따로 둔다.
-- =========================================================

-- ---------- 2026-10 영어 영작 첨삭 · 수학 풀이 첨삭 ----------
-- 라이트: 학원 전체 월 30회 맛보기, 스탠다드·프리미엄: 무제한(NULL)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS feedback_monthly_limit INT;
UPDATE plans SET feedback_monthly_limit = 30
 WHERE code = 'lite' AND feedback_monthly_limit IS NULL AND NOT ('feedback_limited' = ANY(features));
UPDATE plans SET features = array_append(features, 'feedback_limited')
 WHERE code = 'lite' AND NOT ('feedback_limited' = ANY(features));
UPDATE plans SET features = array_append(features, 'feedback_unlimited')
 WHERE code IN ('standard','premium') AND NOT ('feedback_unlimited' = ANY(features));

ALTER TABLE monthly_usage ADD COLUMN IF NOT EXISTS feedback_reviews INT NOT NULL DEFAULT 0;
ALTER TABLE monthly_usage ADD COLUMN IF NOT EXISTS feedback_notified_at TIMESTAMPTZ;

-- 첨삭 1건 = 학생이 올린 글/풀이 1개
--   stage: hinted(위치·힌트만 보여 줌) → retried(고쳐 써 봄) → revealed(영어: 고친 표현 공개) / perfect(다 맞음)
--   items: [{id, original|line, type, hint, corrected?, explain?, fixed?}]  ← corrected/explain은 공개 전 학생에게 안 보냄
-- 질문 세션에 묶여 있어서 학원 보관기간이 지나면 세션과 함께 자동 삭제된다.
CREATE TABLE IF NOT EXISTS feedback_reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id   UUID NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  session_id   UUID NOT NULL REFERENCES question_sessions(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL CHECK (subject IN ('english','math')),
  stage        TEXT NOT NULL DEFAULT 'hinted' CHECK (stage IN ('hinted','retried','revealed','perfect')),
  transcript   TEXT NOT NULL DEFAULT '',          -- AI가 읽은 학생 글(개인정보 가림 후)
  items        JSONB NOT NULL DEFAULT '[]',
  error_count  INT NOT NULL DEFAULT 0,            -- 처음 짚은 실수 수
  fixed_count  INT NOT NULL DEFAULT 0,            -- 고쳐 쓰기로 스스로 고친 수
  retries      SMALLINT NOT NULL DEFAULT 0,
  praise       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_reviews_student_idx ON feedback_reviews (academy_id, student_id, created_at);
ALTER TABLE feedback_reviews ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='feedback_reviews' AND policyname='tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON feedback_reviews
      USING (academy_id = NULLIF(current_setting('app.academy_id', true), '')::uuid);
  END IF;
END $$;
-- 계정 2개 방식(db/roles.sql)을 쓰는 경우 새 표 권한
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON feedback_reviews TO app_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='batch_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON feedback_reviews TO batch_user;
  END IF;
END $$;

-- 첨삭도 질문 세션으로 저장(원장 모니터링·보관기간 공통)하되, 질문 통계(해결률·힌트 단계)에서는 뺀다
ALTER TABLE question_sessions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'question';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='question_sessions_kind_check') THEN
    ALTER TABLE question_sessions ADD CONSTRAINT question_sessions_kind_check CHECK (kind IN ('question','feedback'));
  END IF;
END $$;

-- ---------- 2026-10 지도 방식 선택 · 대화 요약 ----------
-- teaching_mode: NULL 또는 'hint_ladder' = 힌트 4단계(정답 안 줌, 기본)
--                'key_hint' = 핵심 힌트형 (수학: 풀이 전체 → 이해 확인 → 오답노트 / 영어·기타: 핵심 힌트 1개)
ALTER TABLE academies ADD COLUMN IF NOT EXISTS teaching_mode TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='academies_teaching_mode_check') THEN
    ALTER TABLE academies ADD CONSTRAINT academies_teaching_mode_check CHECK (teaching_mode IS NULL OR teaching_mode IN ('hint_ladder','key_hint'));
  END IF;
END $$;
-- 질문 1건(세션)의 요약: 공부한 주제, 막힌 부분, 오답노트 지시 여부, 원장님 코칭 메모, 학부모 칭찬 한 줄 (학생에게는 안 보임)
ALTER TABLE question_sessions ADD COLUMN IF NOT EXISTS summary JSONB;

-- 접어 둔 '🔑 결정적 힌트'(힌트 2)를 학생이 펼쳐 봤는지 (원장님 화면·상담글용)
ALTER TABLE question_sessions ADD COLUMN IF NOT EXISTS hint2_opened BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------- 2026-10 관리자 화면: 퇴원한 학생의 출석번호는 새 학생이 다시 쓸 수 있게 ----------
-- (재원 중인 학생끼리만 같은 반 출석번호가 겹치지 않으면 됨. 로그인도 재원 학생만 찾음)
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_class_id_login_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS students_active_login_code_uq ON students (class_id, login_code) WHERE active;

-- 학생이 '📖 완성 풀이'를 본 문제인지 (힌트를 받은 뒤 막혔을 때만 공개됨 · 원장님 화면·상담글용)
ALTER TABLE question_sessions ADD COLUMN IF NOT EXISTS solution_shown BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------- 2026-10 학년·월별 기본 학습 코스 (자동 학습 리포트·상담글에 사용) ----------
-- course_grade: 초3~고3 / course_mode: month(월별) | quarter(분기별) | off / course_pin: 고정할 달(1~12) 또는 분기(1~4), NULL이면 날짜 따라 자동
ALTER TABLE classes ADD COLUMN IF NOT EXISTS course_grade TEXT;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS course_mode TEXT NOT NULL DEFAULT 'month';
ALTER TABLE classes ADD COLUMN IF NOT EXISTS course_pin SMALLINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='classes_course_mode_check') THEN
    ALTER TABLE classes ADD CONSTRAINT classes_course_mode_check CHECK (course_mode IN ('month','quarter','off'));
  END IF;
END $$;

-- 주간 상담글: 원장님 손글씨 같은 짧은 카톡 (400자 이내)
UPDATE academies SET counsel_tone = '원장님이 직접 카톡을 쓰듯 따뜻하고 담백하게. 이번 주 아이의 구체적인 한 장면과 다음 주 계획, 가정에서 도와주실 한 가지를 짧게.'
 WHERE counsel_tone LIKE '따뜻하고 꼼꼼하게. 학부모님께 정중한 존댓말, 구체적인 장면%';
ALTER TABLE academies ALTER COLUMN counsel_tone SET DEFAULT '원장님이 직접 카톡을 쓰듯 따뜻하고 담백하게. 이번 주 아이의 구체적인 한 장면과 다음 주 계획, 가정에서 도와주실 한 가지를 짧게.';
