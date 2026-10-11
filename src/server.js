// 앱 진입점: 웹 서버 + PWA + 스케줄러(주간 알림톡, 월 자동결제, 대화·사진 자동 파기)
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const path = require('path');
const { pool, batchPool } = require('./lib/db');
const { runWeeklyReports } = require('./jobs/weeklyReport');
const billing = require('./routes/billing');

const app = express();
// 서비스 주소: 직접 정한 도메인(APP_BASE_URL)이 없으면 Render가 알려 주는 주소(…onrender.com)를 사용
process.env.APP_BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:8080').replace(/\/$/, '');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://js.tosspayments.com'],
    frameSrc: ['https://*.tosspayments.com'],
    connectSrc: ["'self'", 'https://*.tosspayments.com'],
    imgSrc: ["'self'", 'data:', 'blob:'],          // blob: = 사진 미리보기
    styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],   // 글꼴(Pretendard) CSS
    fontSrc: ["'self'", 'https://cdn.jsdelivr.net', 'data:'],
    manifestSrc: ["'self'"],                       // PWA 홈 화면 추가
    workerSrc: ["'self'"],                         // 서비스 워커
  } },
}));
// 사진 질문만 큰 요청(최대 6MB: 4MB 사진의 base64 + 여유)을 허용하고, 나머지는 100KB로 제한
const bigJson = express.json({ limit: '6mb' }), smallJson = express.json({ limit: '100kb' });
// 사진을 받는 주소(질문·첨삭)만 6MB, 나머지는 100KB
const PHOTO_PATHS = /^\/api\/student\/(ask|feedback(\/[0-9a-f-]{36}\/retry)?)$/i;
app.use((req, res, next) => (PHOTO_PATHS.test(req.path) ? bigJson : smallJson)(req, res, next));
app.use(cookieParser());

app.use('/api/student', require('./routes/student'));
app.use('/api', require('./routes/signup'));                            // 공개: 요금제 목록, 원장님 가입
app.use('/api/director/counsel', require('./routes/counsel').router);   // 주간 상담·리포트 관리
app.use('/api/director', require('./routes/director'));
app.use('/api/billing', billing.router);

// 상담글 '전체 보기' 링크 (COUNSEL_MODE=link일 때 알림톡 버튼이 가리키는 곳)
// 추측 불가능한 48자리 토큰 + 30일 만료, 검색엔진 수집 금지
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
app.get('/letter/:token', async (req, res, next) => {
  try {
    if (!/^[0-9a-f]{48}$/.test(req.params.token)) return res.status(404).send('링크를 확인해 주세요.');
    const row = (await pool.query('SELECT * FROM open_letter($1)', [req.params.token])).rows[0];
    res.set('X-Robots-Tag', 'noindex').set('Cache-Control', 'no-store');
    if (!row) return res.status(404).send('기간이 지났거나 없는 링크입니다. 학원에 문의해 주세요.');
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(row.academy_name)} 주간 상담</title>
<body style="font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;max-width:560px;margin:0 auto;padding:24px 18px;line-height:1.75;color:#1d2420;background:#f6f7f5">
<p style="color:#5d6b64;font-size:14px;margin:0">${esc(row.academy_name)} · ${esc(row.week_start)} 주</p>
<h1 style="font-size:20px;margin:6px 0 18px">${esc(row.nickname)} 학생 주간 상담</h1>
<div style="background:#fff;border-radius:14px;padding:20px;white-space:pre-wrap">${esc(row.body)}</div>
<p style="color:#5d6b64;font-size:13px">${esc(row.signature)}</p></body>`);
  } catch (e) { next(e); }
});

// Render 상태 확인용 (DB 없이 바로 응답)
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// ---- PWA ----
// 반마다 QR 주소가 달라서, 학생 앱 정보(manifest)는 반별로 만들어 준다 → 홈 화면 아이콘을 누르면 그 반 질문창이 바로 열림
app.get('/s/:token/manifest.webmanifest', async (req, res, next) => {
  try {
    const row = (await pool.query('SELECT * FROM resolve_class($1)', [req.params.token])).rows[0];
    if (!row) return res.status(404).end();
    const start = `/s/${encodeURIComponent(req.params.token)}`;
    res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
      id: start, name: `${row.academy_name} ${row.persona_name}`, short_name: row.persona_name.slice(0, 12),
      description: `${row.class_name} 질문창`, start_url: start, scope: start, display: 'standalone', orientation: 'portrait',
      lang: 'ko', background_color: '#FAF8F5', theme_color: '#4F5BD5',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  } catch (e) { next(e); }
});
// 서비스 워커는 항상 최신본을 받도록 캐시 금지 (업데이트가 바로 반영되게)
app.get('/sw.js', (req, res) => res.set('Cache-Control', 'no-cache').set('Service-Worker-Allowed', '/')
  .sendFile(path.join(__dirname, '..', 'public', 'sw.js')));

// 정적 화면: /s/<QR토큰> → 학생 질문창, /director → 원장 대시보드, / → 랜딩
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('/s/:token', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'student.html')));
// 원장 대시보드: 실제 화면을 React로 이식하기 전까지는 시연판을 보여 준다 (API는 /api/director/* 에 모두 준비됨)
app.get('/director', (req, res) => res.redirect('/prototype.html#director'));
// 주소만 입력하고 들어온 경우: 원장님용 소개(랜딩) 화면으로
app.get('/', (req, res) => res.redirect('/prototype.html#landing'));

// 에러는 학생/원장에게 내부 정보를 노출하지 않음
app.use((err, req, res, _next) => {
  console.error('[error]', req.method, req.path, err.message);
  // 4xx는 우리가 만든 안내 문구(예: "키워드를 적어 주세요")만 그대로 보여 주고, 5xx는 감춘다
  // Claude API 오류(키 오류 401, 크레딧 부족 400, 과부하 429/529 등)는 학생 로그인 문제가 아니므로
  // 그대로 넘기지 않고 503 "잠시 후" 안내로 바꾼다 (401을 넘기면 학생 화면이 로그아웃됨)
  if (err.headers && err.status && !err.code) {
    return res.status(503).json({ error: 'AI 선생님 연결이 잠깐 안 돼요. 잠시 후 다시 보내 줘!' });
  }
  const status = err.status || 500;
  // code/extra: 화면이 상황별 안내(예: 사진 한도 소진 → 업그레이드 팝업)를 띄울 수 있게 함께 보냄
  res.status(status).json(status < 500 ? { error: err.message, code: err.code, ...(err.extra || {}) } : { error: '잠시 후 다시 시도해 주세요' });
});

// ---- 스케줄러: 서버가 여러 대여도 한 대만 실행되도록 DB 잠금 사용 ----
async function once(lockId, fn) {
  const c = await batchPool.connect();
  try {
    const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [lockId]);
    if (!rows[0].ok) return;
    try { await fn(); } finally { await c.query('SELECT pg_advisory_unlock($1)', [lockId]); }
  } catch (e) { console.error('[cron]', lockId, e.message); }
  finally { c.release(); }
}
const TZ = { timezone: 'Asia/Seoul' };
cron.schedule('*/5 * * * *', () => once(1001, () => runWeeklyReports()), TZ);   // 주간 리포트(학원별 요일·시각 판단은 내부에서)
cron.schedule('0 10 * * *', () => once(1002, billing.runMonthlyBilling), TZ);   // 매일 10시 정기결제 대상 청구
cron.schedule('30 3 * * *', () => once(1003, async () => {                       // 매일 새벽 보관기간 지난 대화 파기
  const r = await batchPool.query(
    `DELETE FROM question_sessions q USING academies a
      WHERE q.academy_id=a.id AND q.started_at < now() - make_interval(days => a.retention_days)`);
  // 질문 사진은 개인정보(이름·얼굴)가 찍힐 수 있어 7일만 보관
  const img = await batchPool.query("DELETE FROM question_images WHERE created_at < now() - interval '7 days'");
  console.log('[retention] deleted sessions:', r.rowCount, 'photos:', img.rowCount);
}), TZ);

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`멘트윈 서버 실행 중 :${port}`));
