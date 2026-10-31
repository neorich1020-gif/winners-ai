// 1주차 안정화 시험 (2026-10-31 기술 진단의 실험 3건을 그대로 다시 해 본다)
//   ① 잘못된 입력 → 서버가 꺼지지 않는가
//   ② AI가 8초 걸릴 때 학생 30명 동시 질문 → 다른 화면이 1초 안에 열리는가
//   ③ 같은 와이파이(IP)에서 학생 30명 로그인 → 모두 되는가 / 비밀번호 대입은 학생별로 막히는가
//   ④ AI 시간 초과 → 안내 문구, 서버 유지, 기록 안 남음
// 준비: tests/integration.js와 같은 시험용 PostgreSQL(127.0.0.1:54329). 실제 AI·알림톡 호출 없음.
//   node tests/stability.js
const crypto = require('crypto');
const PORT = 8098;
Object.assign(process.env, {
  PORT: String(PORT), NODE_ENV: 'test', APP_BASE_URL: `http://localhost:${PORT}`,
  DATABASE_URL: 'postgres://app_user:change-me-app@127.0.0.1:54329/winners_ai',
  DATABASE_URL_BATCH: 'postgres://batch_user:change-me-batch@127.0.0.1:54329/winners_ai',
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), PII_ENC_KEY: crypto.randomBytes(32).toString('base64'),
  PII_HASH_KEY: crypto.randomBytes(32).toString('hex'), DRY_RUN: '1', ASK_PER_MINUTE: '100',
});

// ---- 가짜 AI: 지정한 시간만큼 늦게 답하고, 'TIMEOUT'이 들어오면 시간 초과 오류 ----
let AI_DELAY = 0;
class APIConnectionTimeoutError extends Error { constructor() { super('Request timed out.'); this.name = 'APIConnectionTimeoutError'; } }
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'solapi') return { SolapiMessageService: class { async send() { return {}; } } };
  if (req === '@anthropic-ai/sdk') {
    return class { constructor(opts) { global.aiOpts = global.aiOpts || []; global.aiOpts.push(opts); this.messages = { create: async (args) => {
      if (JSON.stringify(args.messages.at(-1)).includes('TIMEOUT')) throw new APIConnectionTimeoutError();
      await new Promise((r) => setTimeout(r, AI_DELAY));
      return { content: [{ type: 'text', text: '[HINT]\n[TOPIC: 일차방정식]\n양변에서 같은 수를 빼 볼까?' }] };
    } }; } };
  }
  return origLoad.call(this, req, ...rest);
};

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const admin = new Pool({ connectionString: 'postgres://postgres:pw@127.0.0.1:54329/winners_ai' });

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : ''}`); };
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const t0 = Date.now();
    try {
      const res = await fetch(`http://localhost:${PORT}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const sc = res.headers.getSetCookie?.() || [];
      if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json, ms: Date.now() - t0 };
    } catch (e) { return { status: 0, body: String(e.cause?.code || e.message), ms: Date.now() - t0 }; }
  };
}
const alive = async () => (await client()('GET', '/healthz')).status === 200;

(async () => {
  // ---- 준비: 학원 1곳, 중2 수학반 학생 35명 ----
  await admin.query("DELETE FROM academies WHERE name='안정화시험학원'");
  const A = (await admin.query(`INSERT INTO academies (name, director_name, plan_status, teaching_mode) VALUES ('안정화시험학원','원장','active','key_hint') RETURNING id`)).rows[0].id;
  await admin.query("DELETE FROM staff WHERE email='owner@stable.kr'");
  await admin.query(`INSERT INTO staff (academy_id, email, password_hash) VALUES ($1,'owner@stable.kr',$2)`, [A, await bcrypt.hash('test1234', 10)]);
  const token = 'qrStable' + crypto.randomBytes(4).toString('hex');
  const C = (await admin.query(`INSERT INTO classes (academy_id, name, subject, grade_band, qr_token) VALUES ($1,'중2 수학','math','middle',$2) RETURNING id`, [A, token])).rows[0].id;
  const pin = await bcrypt.hash('1111', 4);
  for (let i = 1; i <= 35; i++) {
    await admin.query('INSERT INTO students (academy_id, class_id, nickname, login_code, pin_hash) VALUES ($1,$2,$3,$4,$5)', [A, C, `학생${i}`, String(i).padStart(2, '0'), pin]);
  }
  require(require('path').join(__dirname, '..', 'src/server.js'));
  await new Promise((r) => setTimeout(r, 800));

  console.log('\n── 0. AI 시간제한 설정 ──');
  const tutorOpts = (global.aiOpts || []).find((o) => o.timeout === 25000);
  ok(!!tutorOpts && tutorOpts.maxRetries === 1, '학생 질문 AI: 25초 제한, 재시도 1번', global.aiOpts);
  ok((global.aiOpts || []).filter((o) => o.timeout === 45000 && o.maxRetries === 0).length >= 2, '첨삭·상담글 AI: 45초 제한 (+기본 모델로 1번 더)');

  console.log('\n── 1. 잘못된 입력에도 서버 유지 ──');
  const dir = client();
  ok((await dir('POST', '/api/director/login', { email: 'owner@stable.kr', password: 'test1234' })).status === 200, '원장 로그인');
  let r = await dir('PUT', '/api/director/persona', { report_time: 'abc', report_weekday: 5 });
  ok(r.status === 400 && await alive(), '발송 시각 "abc" → 400 안내, 서버 그대로 (진단 때는 서버 꺼짐)', r);
  r = await dir('PUT', '/api/director/persona', { report_time: '25:99' });
  ok(r.status === 400, '발송 시각 "25:99" → 400', r);
  r = await dir('PUT', '/api/director/persona', { report_weekday: 9 });
  ok(r.status === 400, '발송 요일 9 → 400', r);
  r = await dir('PUT', '/api/director/persona', { report_time: '19:30', report_weekday: 4 });
  ok(r.status === 200, '올바른 값(목 19:30)은 저장', r);
  r = await dir('PUT', '/api/director/persona', { report_time: '18:00', report_weekday: 5 });

  // 원장 화면 주소 전부에 엉뚱한 값 보내기 (숫자 자리에 글자, 객체, 배열, 아주 긴 글 등)
  const junk = [{ id: 'zzz', name: {}, grade: [], report_time: 'x', weekday: 'x', limit: -1, days: 'abc', subject: 123, course_grade: 'x', course_mode: {}, course_pin: 'nope', text: 'a'.repeat(5000), phone: '012', code: { $ne: 1 } }, 'not-json-object', null, []];
  const routes = [
    ['PUT', '/api/director/password'], ['POST', '/api/director/plan/change'], ['PUT', '/api/director/academy'],
    ['POST', '/api/director/materials'], ['DELETE', '/api/director/materials/zzz'], ['DELETE', '/api/director/materials/123'],
    ['POST', '/api/director/classes'], ['PUT', '/api/director/classes/zzz'], ['PUT', `/api/director/classes/${C}`], ['GET', '/api/director/classes/zzz/qr.png'],
    ['POST', '/api/director/students'], ['GET', '/api/director/students?class_id=zzz'], ['PATCH', '/api/director/students/zzz'], ['DELETE', '/api/director/students/zzz'],
    ['GET', '/api/director/monitor/overview?days=abc'], ['GET', '/api/director/monitor/sessions?student_id=zzz&limit=abc'], ['GET', '/api/director/monitor/sessions/zzz'],
    ['GET', '/api/director/feedback?student_id=zzz'], ['POST', '/api/director/monitor/flags/zzz/resolve'],
    ['GET', '/api/director/counsel?week=abc'], ['POST', '/api/director/counsel/bulk/approve'], ['PUT', '/api/director/counsel/zzz'],
    ['PUT', '/api/director/counsel/zzz/text'], ['POST', '/api/director/counsel/zzz/approve'], ['POST', '/api/director/counsel/zzz/unapprove'],
    ['POST', '/api/director/counsel/zzz/test-send'], ['GET', '/api/student/class/%00'], ['POST', '/api/student/login'],
    ['POST', '/api/student/session/zzz/close'], ['POST', '/api/billing/zzz'],
  ];
  let sent = 0, server500 = 0, down = 0;
  for (const [m, p] of routes) {
    for (const body of (m === 'GET' || m === 'DELETE' ? [undefined] : junk)) {
      const x = await dir(m, p, body);
      sent++;
      if (x.status === 0) down++;
      if (x.status >= 500) server500++;
    }
  }
  ok(down === 0 && await alive(), `엉뚱한 값 ${sent}건을 보내도 서버가 한 번도 꺼지지 않음`, { sent, down, server500 });
  console.log(`      (참고: 그중 '잠시 후 다시' 500 응답 ${server500}건 — 서버는 유지, 원인은 남은 위험에 기록)`);

  console.log('\n── 2. 같은 와이파이에서 학생 30명 로그인 ──');
  const students = [];
  let logged = 0;
  for (let i = 1; i <= 30; i++) {
    const s = client();
    const x = await s('POST', '/api/student/login', { token, code: String(i).padStart(2, '0'), pin: '1111' });
    if (x.status === 200) logged++;
    students.push(s);
  }
  ok(logged === 30, `30명 모두 로그인 (진단 때는 11번째부터 차단)`, logged);

  console.log('\n── 3. 비밀번호 대입은 학생별로 차단 ──');
  const atk = client();
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await atk('POST', '/api/student/login', { token, code: '33', pin: String(2000 + i) })).status);
  ok(codes.slice(0, 10).every((c) => c === 401) && codes[10] === 429, '같은 학생 비밀번호 10번 틀리면 11번째는 15분 차단', codes);
  r = await client()('POST', '/api/student/login', { token, code: '34', pin: '1111' });
  ok(r.status === 200, '같은 와이파이의 다른 학생은 그대로 로그인', r.status);

  console.log('\n── 4. AI가 8초 걸릴 때 30명 동시 질문 ──');
  AI_DELAY = 8000;
  const t0 = Date.now();
  const asks = students.map((s, i) => s('POST', '/api/student/ask', { text: `2x + 3 = 11 어떻게 풀어? (${i})` }));
  await new Promise((res) => setTimeout(res, 1500));
  const other = client();
  await other('POST', '/api/student/login', { token, code: '35', pin: '1111' });
  const me = await other('GET', '/api/student/me');
  ok(me.status === 200 && me.ms < 1000, `질문 30개가 AI를 기다리는 동안 다른 학생 첫 화면 ${me.ms}ms (진단 때 7,266ms)`, { status: me.status, ms: me.ms });
  const dme = await dir('GET', '/api/director/monitor/overview');
  ok(dme.status === 200 && dme.ms < 1000, `원장 오늘 현황 ${dme.ms}ms`, { status: dme.status, ms: dme.ms });
  const done = await Promise.all(asks);
  const okAsks = done.filter((x) => x.status === 200).length;
  ok(okAsks === 30, `질문 30개 모두 답 받음 (전체 ${Date.now() - t0}ms)`, done.filter((x) => x.status !== 200).slice(0, 3));
  const saved = (await admin.query(`SELECT count(*)::int n FROM messages m JOIN question_sessions q ON q.id=m.session_id WHERE q.academy_id=$1 AND m.role='ai'`, [A])).rows[0].n;
  ok(saved === 30, 'AI 답 30개 모두 저장', saved);
  AI_DELAY = 0;

  console.log('\n── 5. AI 시간 초과 ──');
  const before = (await admin.query('SELECT count(*)::int n FROM messages WHERE academy_id=$1', [A])).rows[0].n;
  r = await students[0]('POST', '/api/student/ask', { text: 'TIMEOUT 문제' });
  ok(r.status === 503 && /늦어/.test(r.body.error), '시간 초과 → "답이 늦어지고 있어" 안내 (503)', r);
  const after = (await admin.query('SELECT count(*)::int n FROM messages WHERE academy_id=$1', [A])).rows[0].n;
  ok(after === before, '실패한 질문은 기록이 반쯤 남지 않음', { before, after });
  ok(await alive(), '서버 그대로');
  r = await students[0]('POST', '/api/student/ask', { text: '다시 물어볼게 2x=8' });
  ok(r.status === 200, '바로 다시 질문하면 정상 답', r.status);

  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`);
  await admin.query("DELETE FROM academies WHERE name='안정화시험학원'").catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
