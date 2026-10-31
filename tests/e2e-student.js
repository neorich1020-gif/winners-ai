// 실제 서버 + 실제 브라우저(Chromium)로 B안 학생 화면 끝까지 써 보기 (휴대폰·PC)
// 가짜 AI만 쓰고, 시험용 DB(127.0.0.1:54329)에 학원·학생을 새로 만들어 시험 후 지운다.
//   node tests/e2e-student.js [스크린샷 폴더]
const crypto = require('crypto');
const PORT = 8097;
Object.assign(process.env, {
  PORT: String(PORT), NODE_ENV: 'test', APP_BASE_URL: `http://localhost:${PORT}`,
  DATABASE_URL: 'postgres://app_user:change-me-app@127.0.0.1:54329/winners_ai',
  DATABASE_URL_BATCH: 'postgres://batch_user:change-me-batch@127.0.0.1:54329/winners_ai',
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), PII_ENC_KEY: crypto.randomBytes(32).toString('base64'),
  PII_HASH_KEY: crypto.randomBytes(32).toString('hex'), DRY_RUN: '1', ASK_PER_MINUTE: '100',
});
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'solapi') return { SolapiMessageService: class { async send() { return {}; } } };
  if (req === '@anthropic-ai/sdk') {
    return class { constructor() { this.messages = { create: async (args) => {
      if (args.tools) return { content: [{ type: 'tool_use', name: 'r', input: { readable: true, off_topic: false, safety_concern: false, transcript: 'I go to school yesterday', praise: '좋아!', message: '실수 1개를 찾았어.',
        items: [{ original: 'I go to school yesterday', type: '시제', hint: '어제 일이면 동사 모양을 봐!', corrected: 'I went to school yesterday', explain: '과거형' }] } }] };
      if (args.system.includes('완성 풀이') && JSON.stringify(args.messages.at(-1)).includes('완성 풀이')) {
        return { content: [{ type: 'text', text: '[SOLUTION]\n[TOPIC: 일차방정식]\n1단계 ▶ 양변에서 3을 빼면 2x = 8\n2단계 ▶ 양변을 2로 나누면 x = 4\n답: x = 4\n이제 이 풀이를 가리고 혼자 처음부터 다시 써 보자!' }] };
      }
      return { content: [{ type: 'text', text: '[HINT]\n[TOPIC: 일차방정식]\n📌 핵심 개념 퀴즈\n저울 양쪽에서 같은 무게를 빼면?\n🧭 힌트 1 · 해결 흐름 3단계\n1단계: 등식의 성질\n2단계: 양변에서 3 빼기\n3단계: 2로 나누기\n<<HINT2>>\n[2x] + 3 ---> 11\n<<END_HINT2>>' }] };
    } }; } };
  }
  return origLoad.call(this, req, ...rest);
};
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');
const admin = new Pool({ connectionString: 'postgres://postgres:pw@127.0.0.1:54329/winners_ai' });
const SHOTS = process.argv[2];
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${!c && x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : ''}`); };

(async () => {
  await admin.query("DELETE FROM academies WHERE name='화면시험학원'");
  const A = (await admin.query(`INSERT INTO academies (name, director_name, plan_status, teaching_mode) VALUES ('화면시험학원','원장','active','key_hint') RETURNING id`)).rows[0].id;
  const token = 'qrE2E' + crypto.randomBytes(4).toString('hex');
  const C = (await admin.query(`INSERT INTO classes (academy_id, name, subject, grade_band, qr_token) VALUES ($1,'중2 수학','math','middle',$2) RETURNING id`, [A, token])).rows[0].id;
  await admin.query('INSERT INTO students (academy_id, class_id, nickname, login_code, pin_hash) VALUES ($1,$2,$3,$4,$5)', [A, C, '민준', '03', await bcrypt.hash('1111', 4)]);
  require(require('path').join(__dirname, '..', 'src/server.js'));
  await new Promise((r) => setTimeout(r, 800));

  const browser = await chromium.launch();
  for (const [name, vp, mobile] of [['휴대폰', { width: 390, height: 844 }, true], ['PC', { width: 1280, height: 820 }, false]]) {
    console.log(`\n── ${name} ──`);
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/cdn\.jsdelivr|ERR_NAME|ERR_TUNNEL|net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await p.goto(`http://localhost:${PORT}/s/${token}`);
    await p.waitForSelector('#login:not([hidden])');
    ok(await p.textContent('#acad') === '화면시험학원', '반 QR 주소 → 학원 이름 표시');
    await p.fill('#code', '03'); await p.fill('#pin', '1111'); await p.click('#login-btn');
    await p.waitForSelector('#home:not([hidden])');
    ok((await p.textContent('#hello-name')).includes('민준'), '로그인 → 홈');
    ok(await p.isHidden('#go-hw') && (await p.textContent('#hw-title')).includes('곧 열려요'), '숙제는 "곧 열려요" (완성된 척 안 함)');
    ok(await p.isHidden('#tab-notes') && await p.isHidden('#preview-ribbon'), '시안(오답노트·미리보기 띠) 숨김');
    ok((await p.textContent('#mission-n')).trim() === '0 / 2', '오늘의 미션 0/2 (서버 기록 기준)', await p.textContent('#mission-n'));
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/real-${name}-home.png` });
    await p.click('#go-ask'); await p.waitForSelector('#chat:not([hidden])');
    await p.fill('#text', '2x + 3 = 11 어떻게 풀어?'); await p.click('#send');
    await p.waitForSelector('.row.ai .sec');
    ok(await p.locator('.row.ai .step').count() >= 3, 'AI 힌트: 구역 제목 + 단계 번호로 표시');
    await p.click('.hint2-btn'); ok(await p.isVisible('.hint2-body'), '결정적 힌트 펼치기');
    await p.click('#show-sol'); await p.waitForSelector('.row.ai .answer');
    ok((await p.textContent('.row.ai .answer')).includes('x = 4') && await p.isVisible('.retry-note'), '완성 풀이: 답 상자 + "가리고 다시 쓰기" 안내');
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/real-${name}-solution.png` });
    await p.click('#solved'); await p.waitForTimeout(200);
    await p.click('#fb-chip'); await p.click('#fb-en'); await p.fill('#text', 'I go to school yesterday'); await p.click('#send');
    await p.waitForSelector('.fbc li');
    ok(await p.isVisible('.fbc .acts button'), '첨삭 카드 + 고쳐 쓰기 버튼');
    await p.click('#fb-exit');
    await p.click('#back'); await p.waitForSelector('#home:not([hidden])');
    ok((await p.textContent('#mission-n')).trim() === '2 / 2', '질문·해결 후 홈 미션 2/2', await p.textContent('#mission-n'));
    await p.reload(); await p.waitForSelector('#home:not([hidden])');
    ok((await p.textContent('#mission-n')).trim() === '2 / 2', '새로 고침해도 서버 기록으로 2/2 유지', await p.textContent('#mission-n'));
    const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(over <= 0, '가로 넘침 없음', over);
    await p.click('#logout'); await p.waitForSelector('#login:not([hidden])');
    ok(true, '로그아웃 → 로그인 화면');
    ok(errors.length === 0, '화면 오류·보안 정책(CSP) 위반 없음', errors);
    await admin.query("DELETE FROM question_sessions WHERE academy_id=$1", [A]);
    await ctx.close();
  }
  await browser.close();
  await admin.query("DELETE FROM academies WHERE name='화면시험학원'").catch(() => {});
  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
