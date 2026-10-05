// =====================================================================
// 서버가 켜질 때마다 자동으로 실행되는 DB 준비 (터미널 명령 없이 배포하기 위함)
//   1) 테이블이 없으면 db/schema.sql 적용 (처음 한 번)
//   2) DB 계정이 하나뿐인 호스팅(Render)용 학원 분리 설정
//      - 계정이 테이블 주인이어도 학원 분리(RLS)가 적용되도록 FORCE
//      - 스케줄러 연결(app.bypass_rls=on)만 여러 학원을 볼 수 있게 정책 수정
//      - QR 조회·상담글 링크 함수(db/functions.sql)는 함수 안에서만 잠깐 우회
//   3) DEMO_STUDENT_PIN이 있고 학원이 하나도 없으면 체험용 반·학생 생성
// 여러 번 실행해도 결과가 같고(멱등), 서버가 여러 대여도 DB 잠금으로 한 번만 실행된다.
// =====================================================================
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { batchPool } = require('../src/lib/db');

const LOCK = 424242;

async function main() {
  const c = await batchPool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK]);

    // 1) 스키마
    const exists = (await c.query("SELECT to_regclass('public.academies') AS t")).rows[0].t;
    if (!exists) {
      console.log('[setup] 처음 실행: 테이블을 만듭니다');
      await c.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    } else {
      console.log('[setup] 테이블이 이미 있습니다');
    }
    await c.query(fs.readFileSync(path.join(__dirname, 'functions.sql'), 'utf8'));

    // 2) 단일 계정용 학원 분리 (BYPASSRLS 계정을 따로 쓰는 경우 USE_DB_ROLES=1 로 건너뜀)
    if (process.env.USE_DB_ROLES !== '1') {
      const tables = (await c.query(
        "SELECT tablename FROM pg_policies WHERE schemaname='public' AND policyname='tenant_isolation'")).rows.map((r) => r.tablename);
      for (const t of tables) {
        await c.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
        await c.query(`DROP POLICY IF EXISTS tenant_isolation ON ${t}`);
        await c.query(`CREATE POLICY tenant_isolation ON ${t}
          USING (current_setting('app.bypass_rls', true) = 'on'
                 OR academy_id = NULLIF(current_setting('app.academy_id', true), '')::uuid)`);
      }
      console.log(`[setup] 학원 분리 설정 완료 (${tables.length}개 표)`);
    }

    // 3) 체험용 반·학생
    const pin = process.env.DEMO_STUDENT_PIN;
    if (pin) {
      if (!/^\d{4}$/.test(pin)) {
        console.log('[setup] DEMO_STUDENT_PIN은 숫자 4자리여야 합니다. 체험 학생을 만들지 않았습니다.');
      } else {
        const count = (await c.query('SELECT count(*)::int AS n FROM academies')).rows[0].n;
        const token = process.env.DEMO_CLASS_TOKEN || 'winners-demo';
        if (count === 0) {
          await c.query('BEGIN');
          const a = (await c.query(
            `INSERT INTO academies (name, director_name, contact_phone, plan_status, persona_style, persona_examples)
             VALUES ($1,$2,$3,'active',$4,$5) RETURNING id`,
            [process.env.DEMO_ACADEMY_NAME || '위너스학원', '원장', (process.env.SENDER_PHONE || '').replace(/\D/g, ''),
             '다정하지만 단호하게. 친근한 반말로 학생 이름을 자주 부르고, 틀려도 "좋아, 거의 다 왔어"로 시작한다.',
             '오케이, 거기까지 잘했어!\n식부터 세워 보자. 문제에서 모르는 게 뭐야?\n급할수록 천천히. 한 줄씩 다시 보자.'])).rows[0];
          const cl = (await c.query(
            `INSERT INTO classes (academy_id, name, subject, grade_band, qr_token) VALUES ($1,'체험반','math','middle',$2) RETURNING id`,
            [a.id, token])).rows[0];
          await c.query(
            `INSERT INTO students (academy_id, class_id, nickname, login_code, pin_hash, is_under_14) VALUES ($1,$2,'체험학생','1',$3,false)`,
            [a.id, cl.id, await bcrypt.hash(pin, 10)]);
          await c.query('COMMIT');
          console.log('[setup] 체험용 반·학생을 만들었습니다');
        }
        console.log(`[setup] 학생 체험 주소: ${(process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '')}/s/${token}  (출석번호 1, 비밀번호는 DEMO_STUDENT_PIN)`);
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    c.release();
    await batchPool.end();
  }
}

main().then(() => console.log('[setup] DB 준비 끝')).catch((e) => {
  console.error('[setup] 실패:', e.message);
  process.exit(1);
});
