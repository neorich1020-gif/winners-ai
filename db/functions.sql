-- =========================================================
-- 로그인 전(학원을 모르는 상태)에 꼭 필요한 조회만 하는 함수 2개
-- 학원 분리(RLS)를 함수 안에서만 잠깐 풀고, 끝나면 원래대로 되돌린다.
-- db/setup.js가 서버 시작 때마다 다시 적용 (CREATE OR REPLACE라 여러 번 실행해도 안전)
-- =========================================================

-- QR 접속: 반 이름·학원 이름만 공개
CREATE OR REPLACE FUNCTION resolve_class(p_token TEXT)
RETURNS TABLE (class_id UUID, academy_id UUID, class_name TEXT, academy_name TEXT, persona_name TEXT, plan_ok BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE prev TEXT := current_setting('app.bypass_rls', true);
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  RETURN QUERY
  SELECT c.id, a.id, c.name, a.name, a.persona_name,
         (a.plan_status = 'active' OR (a.plan_status = 'trial' AND a.trial_ends_at > now()))
    FROM classes c JOIN academies a ON a.id = c.academy_id
   WHERE c.qr_token = p_token;
  PERFORM set_config('app.bypass_rls', COALESCE(prev, ''), true);
END $$;

-- 학부모가 링크로 상담글을 열 때(로그인 없음) 그 한 건만 꺼냄. 첫 열람 시각 기록.
CREATE OR REPLACE FUNCTION open_letter(p_token TEXT)
RETURNS TABLE (academy_name TEXT, nickname TEXT, week_start DATE, body TEXT, signature TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE prev TEXT := current_setting('app.bypass_rls', true);
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  UPDATE letter_links SET opened_at = COALESCE(opened_at, now()) WHERE token = p_token AND expires_at > now();
  RETURN QUERY
  SELECT a.name, s.nickname, n.week_start, n.final_text,
         COALESCE(NULLIF(a.counsel_signature,''), a.name || ' ' || a.director_name || ' 드림')
    FROM letter_links l
    JOIN counsel_notes n ON n.id = l.counsel_id
    JOIN students s ON s.id = n.student_id
    JOIN academies a ON a.id = n.academy_id
   WHERE l.token = p_token AND l.expires_at > now() AND n.status IN ('approved','sent');
  PERFORM set_config('app.bypass_rls', COALESCE(prev, ''), true);
END $$;
