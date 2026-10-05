// PostgreSQL 연결
// - pool:      웹 요청용. RLS(학원별 분리)가 적용되는 일반 계정으로 접속하고,
//              학원 데이터는 반드시 withTenant()로 감싸 조회한다.
// - batchPool: 스케줄러(금요일 발송·정기결제·자동 파기)용. 여러 학원을 한 번에 다뤄야 하므로
//              RLS를 우회해야 한다. 방법은 두 가지:
//                ① DATABASE_URL_BATCH = BYPASSRLS 권한이 있는 별도 계정 (db/roles.sql)
//                ② 계정이 하나뿐인 호스팅(Render 등): 같은 계정으로 따로 연결하고, 그 연결에서만
//                   app.bypass_rls = on 을 켠다 (db/setup.js가 정책을 이 방식에 맞게 설정)
//              웹 요청용 pool에서는 절대 bypass를 켜지 않는다.
const { Pool } = require('pg');

// DB 암호화 연결: Render 내부 주소(점이 없는 호스트, 예: dpg-xxxx-a)는 같은 네트워크라 암호화 없이,
// 외부 주소는 암호화(require). DATABASE_SSL=off|require|verify 로 직접 정할 수도 있다.
function sslFor(url) {
  const mode = process.env.DATABASE_SSL;
  if (mode === 'off') return false;
  if (mode === 'verify') return { rejectUnauthorized: true };
  if (mode === 'require') return { rejectUnauthorized: false };
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  if (!host || host === 'localhost' || host === '127.0.0.1' || !host.includes('.')) return false;
  return process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
}
const DB_URL = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: DB_URL, ssl: sslFor(DB_URL) });
let batchPool;
if (process.env.DATABASE_URL_BATCH) {
  batchPool = new Pool({ connectionString: process.env.DATABASE_URL_BATCH, ssl: sslFor(process.env.DATABASE_URL_BATCH), max: 3 });
} else {
  batchPool = new Pool({ connectionString: DB_URL, ssl: sslFor(DB_URL), max: 3 });
  batchPool.on('connect', (c) => c.query("SET app.bypass_rls = 'on'").catch(() => {}));
}

async function withTenant(academyId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.academy_id', $1, true)", [academyId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function audit(client, { academyId, actor, action, target, ip }) {
  await client.query('INSERT INTO audit_logs (academy_id, actor, action, target, ip) VALUES ($1,$2,$3,$4,$5)', [academyId, actor, action, target, ip || null]);
}

module.exports = { pool, batchPool, withTenant, audit };
