-- =========================================================
-- DB 계정 2개 만들기 (schema.sql, functions.sql 적용 후 관리자 계정으로 1회 실행)
-- ※ Render처럼 계정이 하나뿐이면 이 파일은 필요 없습니다. db/setup.js가 자동으로 맞춰 줍니다.
--  app_user   : 웹 서버용. 학원별 분리(RLS)가 강제된다.  → DATABASE_URL
--  batch_user : 스케줄러용. 여러 학원을 한 번에 처리.     → DATABASE_URL_BATCH
-- 비밀번호는 반드시 바꿔서 실행하세요.
-- =========================================================
CREATE ROLE app_user   LOGIN PASSWORD 'change-me-app';
CREATE ROLE batch_user LOGIN PASSWORD 'change-me-batch' BYPASSRLS;

GRANT USAGE ON SCHEMA public TO app_user, batch_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, batch_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user, batch_user;
GRANT EXECUTE ON FUNCTION resolve_class(TEXT), open_letter(TEXT) TO app_user, batch_user;
