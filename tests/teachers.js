// 선생님 계정 + 담당 반 시험: 원장이 선생님을 만들고 반을 맡기면, 선생님은 그 반 학생만 본다.
// 준비: tests/integration.js와 같은 시험용 PostgreSQL(127.0.0.1:54329). 실제 AI·알림톡 호출 없음.
//   node tests/teachers.js
const crypto = require('crypto');
const PORT = 8096;
Object.assign(process.env, {
  PORT: String(PORT), NODE_ENV: 'test', APP_BASE_URL: `http://localhost:${PORT}`,
  DATABASE_URL: 'postgres://app_user:change-me-app@127.0.0.1:54329/winners_ai',
  DATABASE_URL_BATCH: 'postgres://batch_user:change-me-batch@127.0.0.1:54329/winners_ai',
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), PII_ENC_KEY: crypto.randomBytes(32).toString('base64'),
  PII_HASH_KEY: crypto.randomBytes(32).toString('hex'), DRY_RUN: '1',
});
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'solapi') return { SolapiMessageService: class { async send() { return {}; } } };
  if (req === '@anthropic-ai/sdk') return class { constructor() { this.messages = { create: async () => ({ content: [{ type: 'text', text: '[HINT]\n[TOPIC: 일차방정식]\n힌트' }] }) }; } };
  return origLoad.call(this, req, ...rest);
};
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const admin = new Pool({ connectionString: 'postgres://postgres:pw@127.0.0.1:54329/winners_ai' });
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${!c && x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : ''}`); };
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(`http://localhost:${PORT}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.getSetCookie?.() || [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: res.status, body: j };
  };
}

(async () => {
  for (const n of ['선생님시험학원', '다른학원']) await admin.query('DELETE FROM academies WHERE name=$1', [n]);
  await admin.query("DELETE FROM staff WHERE email LIKE '%@tchr.test'");
  const A = (await admin.query("INSERT INTO academies (name, director_name, plan_status) VALUES ('선생님시험학원','원장','active') RETURNING id")).rows[0].id;
  const B = (await admin.query("INSERT INTO academies (name, director_name, plan_status) VALUES ('다른학원','원장','active') RETURNING id")).rows[0].id;
  await admin.query("INSERT INTO staff (academy_id, email, password_hash) VALUES ($1,'owner@tchr.test',$2)", [A, await bcrypt.hash('owner1234', 4)]);
  await admin.query("INSERT INTO staff (academy_id, email, password_hash) VALUES ($1,'other@tchr.test',$2)", [B, await bcrypt.hash('other1234', 4)]);
  const mk = async (aid, name) => (await admin.query("INSERT INTO classes (academy_id, name, subject, grade_band) VALUES ($1,$2,'math','middle') RETURNING id", [aid, name])).rows[0].id;
  const C1 = await mk(A, '중1 수학'), C2 = await mk(A, '중2 수학'), CB = await mk(B, '다른학원 반');
  const pin = await bcrypt.hash('1111', 4);
  const addSt = async (aid, cid, nick, code) => (await admin.query('INSERT INTO students (academy_id, class_id, nickname, login_code, pin_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id', [aid, cid, nick, code, pin])).rows[0].id;
  const S1 = await addSt(A, C1, '중일학생', '1'); const S2 = await addSt(A, C2, '중이학생', '2');
  await admin.query("INSERT INTO question_sessions (academy_id, student_id, subject, topic, solution_shown) VALUES ($1,$2,'math','일차방정식',true)", [A, S1]);
  const q2 = (await admin.query("INSERT INTO question_sessions (academy_id, student_id, subject, topic) VALUES ($1,$2,'math','연립방정식') RETURNING id", [A, S2])).rows[0].id;
  require(require('path').join(__dirname, '..', 'src/server.js'));
  await new Promise((r) => setTimeout(r, 800));

  console.log('\n── 원장: 선생님 계정 만들기 ──');
  const own = client();
  ok((await own('POST', '/api/director/login', { email: 'owner@tchr.test', password: 'owner1234' })).status === 200, '원장 로그인');
  let r = await own('POST', '/api/director/teachers', { name: '김선생', email: 'kim@tchr.test', password: 'short', classIds: [C1] });
  ok(r.status === 400, '임시 비밀번호 8자 미만 거절', r);
  r = await own('POST', '/api/director/teachers', { name: '김선생', email: 'kim@tchr.test', password: 'temp-pass-1', classIds: [C1, CB] });
  ok(r.status === 400, '다른 학원 반은 담당으로 줄 수 없음', r);
  r = await own('POST', '/api/director/teachers', { name: '김선생', email: 'kim@tchr.test', password: 'temp-pass-1', classIds: [C1] });
  ok(r.status === 200 && r.body.id, '선생님 계정 생성 (담당: 중1 수학)', r);
  const TID = r.body.id;
  r = await own('POST', '/api/director/teachers', { name: '김선생', email: 'KIM@tchr.test', password: 'temp-pass-1', classIds: [] });
  ok(r.status === 409, '같은 이메일 중복 거절', r);
  r = await own('GET', '/api/director/teachers');
  ok(r.status === 200 && r.body.length === 1 && r.body[0].class_ids[0] === C1 && r.body[0].must_change_pw, '선생님 목록: 담당 반·첫 로그인 전 표시', r.body);
  r = await own('GET', '/api/director/classes');
  ok(r.body.find((c) => c.id === C1).teachers[0].name === '김선생', '원장 반 목록에 담당 선생님 표시');

  console.log('\n── 선생님: 담당 반만 ──');
  const t = client();
  r = await t('POST', '/api/director/login', { email: 'kim@tchr.test', password: 'temp-pass-1' });
  ok(r.status === 200 && r.body.role === 'teacher' && r.body.mustChangePw === true, '임시 비밀번호로 로그인 → 비밀번호 변경 필요 표시', r.body);
  r = await t('GET', '/api/director/me');
  ok(r.body.role === 'teacher' && r.body.name === '김선생' && r.body.classIds.length === 1, '내 정보: 선생님·담당 반 1개', r.body);
  r = await t('GET', '/api/director/classes');
  ok(r.body.length === 1 && r.body[0].id === C1, '반 목록: 중1 수학만', r.body.map((x) => x.name));
  r = await t('GET', '/api/director/students');
  ok(r.body.length === 1 && r.body[0].id === S1, '학생 목록: 담당 반 학생만', r.body.map((x) => x.nickname));
  r = await t('GET', `/api/director/classes/${C1}/today`);
  ok(r.status === 200 && r.body.students.length === 1 && r.body.students[0].solutions === 1 && r.body.summary.needCheck === 1, '수업 중인 반: 학생·오늘 기록(완성 풀이 봄 → 먼저 볼 학생)', r.body);
  ok((await t('GET', `/api/director/classes/${C2}/today`)).status === 403, '담당 아닌 반은 수업 화면 403');
  ok((await t('GET', `/api/director/classes/${C2}/qr.png`)).status === 403, '담당 아닌 반 QR 403');
  r = await t('GET', '/api/director/monitor/sessions');
  ok(r.body.length === 1 && r.body[0].student_id === S1, '질문 기록: 담당 반 학생 것만', r.body.length);
  ok((await t('GET', `/api/director/monitor/sessions/${q2}`)).status === 403, '다른 반 학생 대화 열기 403');
  r = await t('GET', '/api/director/monitor/overview');
  ok(r.body.week.questions === 1, '오늘 현황 숫자도 담당 반 기준', r.body.week);
  ok((await t('PATCH', `/api/director/students/${S2}`, { nickname: '바꿈' })).status === 403, '다른 반 학생 수정 403');
  ok((await t('PATCH', `/api/director/students/${S1}`, { class_id: C2 })).status === 403, '담당 아닌 반으로 학생 옮기기 403');
  ok((await t('PATCH', `/api/director/students/${S1}`, { active: false })).status === 403, '퇴원 처리는 원장만');
  ok((await t('PATCH', `/api/director/students/${S1}`, { pin: '2222' })).status === 200, '담당 학생 비밀번호 다시 정하기 가능');
  ok((await t('POST', '/api/director/students', { class_id: C2, nickname: '새학생', login_code: '9', pin: '1234' })).status === 403, '담당 아닌 반에 학생 등록 403');
  ok((await t('POST', '/api/director/students', { class_id: C1, nickname: '새학생', login_code: '9', pin: '1234' })).status === 200, '담당 반에 학생 등록 가능');
  ok((await t('GET', '/api/director/teachers')).status === 403, '선생님 관리 화면은 원장만');
  ok((await t('GET', '/api/director/counsel')).status === 403, '주간 상담(학부모 발송)은 원장만');
  ok((await t('PUT', '/api/director/persona', { report_time: '18:00' })).status === 403, '학원 설정은 원장만');
  ok((await t('POST', '/api/director/classes', { name: 'x', subject: 'math', grade_band: 'middle' })).status === 403, '반 만들기는 원장만');
  ok((await t('POST', '/api/director/materials', { title: '전체 교재' })).status === 403, '학원 전체 교재는 원장만');
  ok((await t('POST', '/api/director/materials', { title: '중1 교재', class_id: C1 })).status === 200, '담당 반 교재 등록 가능');

  console.log('\n── 비밀번호 · 담당 반 변경 · 삭제 ──');
  ok((await t('PUT', '/api/director/password', { current: 'temp-pass-1', next: 'my-new-pass' })).status === 200, '선생님이 새 비밀번호로 변경');
  r = await t('GET', '/api/director/me');
  ok(r.body.mustChangePw === false, '변경 후 "비밀번호 변경 필요" 해제');
  ok((await own('PUT', `/api/director/teachers/${TID}`, { classIds: [C1, C2] })).status === 200, '원장이 담당 반 추가');
  r = await t('GET', '/api/director/students');
  ok(r.body.length === 3, '담당 반을 늘리면 바로 그 반 학생도 보임', r.body.length);
  ok((await own('POST', `/api/director/teachers/${TID}/password`, { password: 'reset-pass-9' })).status === 200, '원장이 임시 비밀번호 다시 주기');
  r = await client()('POST', '/api/director/login', { email: 'kim@tchr.test', password: 'my-new-pass' });
  ok(r.status === 401, '예전 비밀번호로는 로그인 불가');
  const other = client();
  await other('POST', '/api/director/login', { email: 'other@tchr.test', password: 'other1234' });
  ok((await other('PUT', `/api/director/teachers/${TID}`, { classIds: [] })).status === 404, '다른 학원 원장은 이 선생님 수정 불가');
  ok((await other('GET', '/api/director/teachers')).body.length === 0, '다른 학원 원장 목록에 안 보임');
  ok((await own('DELETE', `/api/director/teachers/${TID}`)).status === 200, '원장이 선생님 계정 삭제');
  ok((await t('GET', '/api/director/students')).status === 401, '삭제된 선생님은 남은 로그인도 바로 막힘');

  console.log('\n── 원장은 그대로 전체 ──');
  r = await own('GET', '/api/director/students');
  ok(r.body.length === 3, '원장은 모든 반 학생', r.body.length);
  ok((await own('GET', `/api/director/classes/${C2}/today`)).status === 200, '원장은 모든 반 수업 화면');

  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`);
  for (const n of ['선생님시험학원', '다른학원']) await admin.query('DELETE FROM academies WHERE name=$1', [n]).catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
