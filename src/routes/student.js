// 학생용 API: QR → 반 확인 → 번호+PIN 로그인 → 질문
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool, withTenant } = require('../lib/db');
const { signStudent, requireAuth, cookieOpts, STUDENT_HOURS } = require('../lib/security');
const tutor = require('../ai/tutor');
const feedback = require('../ai/feedback');
const { getPlan, photoUsage, feedbackUsage } = require('../lib/plans');

const r = express.Router();

// PIN 무차별 대입 방지
const loginLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 10 });
// 질문 남용 방지: 학생 1명당 분당 6회, 하루 150회 (비용 상한)
const askLimiter = rateLimit({ windowMs: 60e3, limit: Number(process.env.ASK_PER_MINUTE || 6), keyGenerator: (req) => req.user.sub });
const dailyLimiter = rateLimit({ windowMs: 24 * 3600e3, limit: 150, keyGenerator: (req) => req.user.sub });
// 사진 질문은 글보다 비용이 커서 따로 하루 30장 한도
const photoLimiter = rateLimit({ windowMs: 24 * 3600e3, limit: 30, keyGenerator: (req) => req.user.sub,
  skip: (req) => !req.body?.image, message: { error: '오늘 사진 질문은 다 썼어. 문제를 글로 적어서 물어봐 줘!' } });

// 첨삭은 학생 1명당 하루 15회(새 첨삭 + 고쳐 쓰기 확인 합산), 분당 4회
const feedbackLimiter = rateLimit({ windowMs: 24 * 3600e3, limit: Number(process.env.FEEDBACK_PER_DAY || 15), keyGenerator: (req) => req.user.sub,
  message: { error: '오늘 첨삭은 여기까지! 내일 또 올려 줘.' } });
const feedbackBurst = rateLimit({ windowMs: 60e3, limit: Number(process.env.FEEDBACK_PER_MINUTE || 4), keyGenerator: (req) => req.user.sub,
  message: { error: '잠깐! 천천히 하나씩 올려 줘.' } });

// QR 링크(/s/:token)가 처음 호출 → 반 이름, 학원 이름만 공개
r.get('/class/:token', async (req, res) => {
  const row = (await pool.query('SELECT * FROM resolve_class($1)', [req.params.token])).rows[0];
  if (!row) return res.status(404).json({ error: '없는 링크예요. 선생님께 QR을 다시 받아 주세요.' });
  if (!row.plan_ok) return res.status(402).json({ error: '지금은 이용할 수 없어요. 원장님께 알려 주세요.' });
  res.json({ className: row.class_name, academyName: row.academy_name, personaName: row.persona_name });
});

r.post('/login', loginLimiter, async (req, res) => {
  const { token, code, pin } = req.body || {};
  const cls = (await pool.query('SELECT * FROM resolve_class($1)', [token])).rows[0];
  if (!cls || !cls.plan_ok) return res.status(401).json({ error: '번호나 비밀번호를 확인해 주세요' });

  const st = await withTenant(cls.academy_id, async (c) =>
    (await c.query('SELECT * FROM students WHERE class_id=$1 AND login_code=$2 AND active', [cls.class_id, String(code)])).rows[0]);
  if (!st || !(await bcrypt.compare(String(pin), st.pin_hash))) return res.status(401).json({ error: '번호나 비밀번호를 확인해 주세요' });

  res.cookie('student_token', signStudent(st), cookieOpts(STUDENT_HOURS));
  res.json({ nickname: st.nickname });
});

// 홈 화면 앱을 다시 열었을 때: 로그인 유지 중인지 확인 (같은 반 QR일 때만)
r.get('/me', requireAuth('student'), async (req, res, next) => {
  try {
    const out = await withTenant(req.user.aid, async (c) => {
      const st = (await c.query(
        `SELECT s.nickname, c.qr_token, c.subject, a.plan_code, a.teaching_mode FROM students s JOIN classes c ON c.id=s.class_id JOIN academies a ON a.id=s.academy_id
          WHERE s.id=$1 AND s.active`, [req.user.sub])).rows[0];
      if (!st) return null;
      const plan = await getPlan(c, st.plan_code);
      const photo = await photoUsage(c, req.user.aid, plan); // 라이트면 이번 달 남은 사진 질문 수
      const fb = await feedbackUsage(c, req.user.aid, plan);  // 라이트면 이번 달 남은 첨삭 수
      const fbSubject = ['english', 'math'].includes(st.subject) ? st.subject : 'english'; // 처음 선택값 (화면에서 영어/수학 바꿀 수 있음)
      return { nickname: st.nickname, classToken: st.qr_token, photo, feedback: { ...fb, subject: fbSubject },
        teachingMode: st.teaching_mode === 'key_hint' ? 'key_hint' : 'hint_ladder' };
    });
    if (!out) return res.status(401).json({ error: '다시 로그인해 주세요' });
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/logout', (req, res) => {
  res.clearCookie('student_token');
  res.json({ ok: true });
});

r.post('/ask', requireAuth('student'), askLimiter, dailyLimiter, photoLimiter, async (req, res, next) => {
  try {
    const { text, sessionId, moreHint, image } = req.body || {}; // image: { mediaType, base64 }
    const out = await withTenant(req.user.aid, async (c) => {
      const academy = (await c.query('SELECT * FROM academies WHERE id=$1', [req.user.aid])).rows[0];
      const cls = (await c.query('SELECT * FROM classes WHERE id=$1', [req.user.cid])).rows[0];
      const student = (await c.query('SELECT id, nickname, class_id FROM students WHERE id=$1 AND active', [req.user.sub])).rows[0];
      if (!student) throw Object.assign(new Error('inactive'), { status: 401 });
      return tutor.answer(c, { academy, cls, student, sessionId, text: String(text || ''), wantMoreHint: !!moreHint, image });
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ---------- 영어 영작 · 수학 풀이 첨삭 ----------
async function studentCtx(c, req) {
  const academy = (await c.query('SELECT * FROM academies WHERE id=$1', [req.user.aid])).rows[0];
  const cls = (await c.query('SELECT * FROM classes WHERE id=$1', [req.user.cid])).rows[0];
  const student = (await c.query('SELECT id, nickname, class_id FROM students WHERE id=$1 AND active', [req.user.sub])).rows[0];
  if (!student) throw Object.assign(new Error('inactive'), { status: 401 });
  return { academy, cls, student };
}
// 처음 첨삭: { text?, image?, subject? }  → 틀린 위치·유형·힌트만 (고친 표현은 아직 안 보냄)
r.post('/feedback', requireAuth('student'), feedbackBurst, feedbackLimiter, photoLimiter, async (req, res, next) => {
  try {
    const { text, image, subject } = req.body || {};
    res.json(await withTenant(req.user.aid, async (c) => feedback.createReview(c, await studentCtx(c, req), { text, image, subject })));
  } catch (e) { next(e); }
});
// 고쳐 쓴 글 / 다시 푼 풀이 확인 (횟수 차감 없음, 최대 2번)
r.post('/feedback/:id/retry', requireAuth('student'), feedbackBurst, feedbackLimiter, photoLimiter, async (req, res, next) => {
  try {
    const { text, image } = req.body || {};
    res.json(await withTenant(req.user.aid, async (c) => feedback.retryReview(c, await studentCtx(c, req), req.params.id, { text, image })));
  } catch (e) { next(e); }
});
// 영어 "잘 모르겠어요" → 고친 표현·이유 바로 공개
r.post('/feedback/:id/reveal', requireAuth('student'), async (req, res, next) => {
  try {
    res.json(await withTenant(req.user.aid, async (c) => feedback.revealReview(c, await studentCtx(c, req), req.params.id)));
  } catch (e) { next(e); }
});

// 학생이 "풀었어요!" / "포기" 버튼
r.post('/session/:id/close', requireAuth('student'), async (req, res) => {
  const status = req.body?.solved ? 'solved' : 'gave_up';
  await withTenant(req.user.aid, (c) => c.query(
    "UPDATE question_sessions SET status=$1, ended_at=now() WHERE id=$2 AND student_id=$3 AND status='open'",
    [status, req.params.id, req.user.sub]));
  res.json({ ok: true });
});

module.exports = r;
