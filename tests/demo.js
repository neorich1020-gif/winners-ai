// 체험 계정 시험: 여러 사람이 같은 체험 번호를 써도 한 사람의 실수로 모두가 막히지 않는가
// 준비: 시험용 DB에 체험 반이 있어야 함 (DEMO_STUDENT_PIN=4321 로 db/setup.js 한 번 실행)
//   node tests/demo.js
const crypto = require('crypto');
const PORT = 8095;
Object.assign(process.env, {
  PORT: String(PORT), NODE_ENV: 'test', APP_BASE_URL: `http://localhost:${PORT}`,
  DATABASE_URL: 'postgres://app_user:change-me-app@127.0.0.1:54329/winners_ai',
  DATABASE_URL_BATCH: 'postgres://batch_user:change-me-batch@127.0.0.1:54329/winners_ai',
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), PII_ENC_KEY: crypto.randomBytes(32).toString('base64'),
  PII_HASH_KEY: crypto.randomBytes(32).toString('hex'), DRY_RUN: '1', ASK_PER_MINUTE: '2',
});
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'solapi') return { SolapiMessageService: class { async send() { return {}; } } };
  if (req === '@anthropic-ai/sdk') return class { constructor() { this.messages = { create: async () => ({ content: [{ type: 'text', text: '[HINT]\n[TOPIC: 일차방정식]\n힌트' }] }) }; } };
  return origLoad.call(this, req, ...rest);
};
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${!c && x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 200) : ''}`); };
function client(ip) {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(`http://localhost:${PORT}${path}`, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.getSetCookie?.() || [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: res.status, body: j };
  };
}
(async () => {
  require(require('path').join(__dirname, '..', 'src/server.js'));
  await new Promise((r) => setTimeout(r, 800));
  for (const tk of ['winners-demo', 'winners-demo-en']) ok((await client('1.1.1.1')('GET', `/api/student/class/${tk}`)).status === 200, `체험 주소 열림: /s/${tk}`);

  const a = client('10.0.0.1'), b = client('10.0.0.2');
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await a('POST', '/api/student/login', { token: 'winners-demo', code: '1', pin: String(1000 + i) })).status);
  ok(codes[10] === 429, '체험 번호를 10번 틀린 사람은 잠김', codes);
  ok((await b('POST', '/api/student/login', { token: 'winners-demo', code: '1', pin: '4321' })).status === 200, '다른 사람은 같은 체험 번호로 바로 로그인 (예전: 15분 모두 잠김)');

  const c = client('10.0.0.3');
  await c('POST', '/api/student/login', { token: 'winners-demo', code: '1', pin: '4321' });
  const r1 = [];
  for (let i = 0; i < 3; i++) r1.push((await b('POST', '/api/student/ask', { text: `2x+${i}=5` })).status);
  ok(r1[2] === 429, '한 사람이 분당 질문 한도를 다 쓰면 그 사람만 잠깐 대기', r1);
  ok((await c('POST', '/api/student/ask', { text: '3x=9' })).status === 200, '다른 체험자는 계속 질문 가능 (예전: 모두 같이 막힘)');
  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
