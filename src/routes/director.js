// 원장 대시보드 API: 로그인, 말투·교재 세팅, 반/학생/학부모 관리, 질문 모니터링
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool, withTenant, audit } = require('../lib/db');
const { signStaff, requireAuth, cookieOpts, encrypt, decrypt, hmac, normalizePhone } = require('../lib/security');
const { toCard, listPlans, getPlan, capacityStatus, photoUsage, feedbackUsage } = require('../lib/plans');

const QRCode = require('qrcode');
const CURRICULUM = require('../lib/curriculum');

const r = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECTS = ['math', 'english', 'science', 'korean', 'etc'];
const GRADES = ['elementary', 'middle', 'high'];
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const auth = requireAuth('staff');
const ownerOnly = (req, res, next) => (req.user.role === 'owner' ? next() : res.status(403).json({ error: '원장 권한이 필요합니다' }));
const T = (req, fn) => withTenant(req.user.aid, fn);

r.post('/login', rateLimit({ windowMs: 15 * 60e3, limit: 8 }), async (req, res) => {
  const { email, password } = req.body || {};
  const s = (await pool.query('SELECT * FROM staff WHERE email=$1', [String(email).toLowerCase()])).rows[0];
  if (!s || !(await bcrypt.compare(String(password), s.password_hash))) return res.status(401).json({ error: '이메일 또는 비밀번호 오류' });
  await pool.query('UPDATE staff SET last_login_at=now() WHERE id=$1', [s.id]);
  res.cookie('staff_token', signStaff(s), cookieOpts(12));
  res.json({ ok: true });
});

// ---------- 내 계정 ----------
r.get('/me', auth, async (req, res, next) => {
  try {
    res.json(await T(req, async (c) => {
      const s = (await c.query('SELECT email, role FROM staff WHERE id=$1', [req.user.sub])).rows[0];
      const a = (await c.query('SELECT name, director_name, plan_status, plan_code FROM academies WHERE id=$1', [req.user.aid])).rows[0];
      if (!s) throw bad('다시 로그인해 주세요', 401);
      return { email: s.email, role: s.role, academy: a };
    }));
  } catch (e) { next(e); }
});
r.post('/logout', (req, res) => { res.clearCookie('staff_token'); res.json({ ok: true }); });
r.put('/password', auth, rateLimit({ windowMs: 15 * 60e3, limit: 8 }), async (req, res, next) => {
  try {
    const { current, next: nextPw } = req.body || {};
    if (String(nextPw || '').length < 8) throw bad('새 비밀번호는 8자 이상으로 정해 주세요');
    const s = (await pool.query('SELECT * FROM staff WHERE id=$1', [req.user.sub])).rows[0];
    if (!s || !(await bcrypt.compare(String(current || ''), s.password_hash))) throw bad('지금 비밀번호가 맞지 않아요', 400);
    await pool.query('UPDATE staff SET password_hash=$2 WHERE id=$1', [s.id, await bcrypt.hash(String(nextPw), 10)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- 페르소나(말투) ----------
r.get('/persona', auth, async (req, res) => {
  res.json(await T(req, async (c) => (await c.query(
    `SELECT name, director_name, persona_name, persona_style, persona_examples, report_weekday, report_time, report_enabled,
            counsel_tone, counsel_signature, stats_fallback, COALESCE(teaching_mode,'hint_ladder') AS teaching_mode FROM academies WHERE id=$1`, [req.user.aid])).rows[0]));
});
r.put('/persona', auth, ownerOnly, async (req, res) => {
  const b = req.body || {};
  await T(req, (c) => c.query(
    `UPDATE academies SET persona_name=$2, persona_style=$3, persona_examples=$4,
       report_weekday=$5, report_time=$6, report_enabled=$7,
       counsel_tone=COALESCE($8, counsel_tone), counsel_signature=COALESCE($9, counsel_signature), stats_fallback=$10,
       teaching_mode=COALESCE($11, teaching_mode) WHERE id=$1`,
    [req.user.aid, String(b.persona_name || '원장쌤').slice(0, 20), String(b.persona_style || '').slice(0, 800),
     String(b.persona_examples || '').slice(0, 2000), Number(b.report_weekday ?? 5), b.report_time || '18:00', b.report_enabled !== false,
     b.counsel_tone != null ? String(b.counsel_tone).slice(0, 600) : null,
     b.counsel_signature != null ? String(b.counsel_signature).slice(0, 60) : null, b.stats_fallback !== false,
     ['hint_ladder', 'key_hint'].includes(b.teaching_mode) ? b.teaching_mode : null]));
  res.json({ ok: true });
});

// ---------- 학원 정보 및 요금/구독 관리 ----------
// 활성 학생 수를 플랜 정원(라이트 30 / 스탠다드 60 / 프리미엄 제한 없음)과 비교해 상단 뱃지 상태를 함께 돌려준다
async function planSummary(c, aid) {
  const a = (await c.query('SELECT name, director_name, contact_phone, plan_status, trial_ends_at, plan_code, price_locked_krw FROM academies WHERE id=$1', [aid])).rows[0];
  const plans = await listPlans(c);
  const plan = plans.find((p) => p.code === a.plan_code);
  const sub = (await c.query('SELECT card_label, next_billing_at FROM subscriptions WHERE academy_id=$1', [aid])).rows[0];
  const active = (await c.query('SELECT count(*)::int AS n FROM students WHERE active')).rows[0].n; // RLS로 이 학원만
  const photo = await photoUsage(c, aid, plan);
  const fb = await feedbackUsage(c, aid, plan);
  return {
    academy: { name: a.name, director_name: a.director_name, contact_phone: a.contact_phone, plan_status: a.plan_status, trial_ends_at: a.trial_ends_at },
    plan: { ...toCard(plan), monthlyKrw: a.price_locked_krw ?? plan.price_krw, priceLocked: a.price_locked_krw != null },
    activeStudents: active,
    capacity: capacityStatus(active, plan, plans),
    photo: { ...photo, exhausted: photo.limit != null && photo.remaining === 0 },  // 라이트: 이번 달 사진 질문 잔여
    feedback: { ...fb, exhausted: fb.limit != null && fb.remaining === 0 },       // 라이트: 이번 달 첨삭 잔여
    billing: sub ? { card: sub.card_label, nextBillingAt: sub.next_billing_at } : null,
    plans: plans.map(toCard),
  };
}
r.get('/plan', auth, async (req, res, next) => {
  try { res.json(await T(req, (c) => planSummary(c, req.user.aid))); } catch (e) { next(e); }
});
// 플랜 변경: 다음 결제부터 새 금액. 스탠다드 출시 기념가는 변경 시점에 평생 고정.
r.post('/plan/change', auth, ownerOnly, async (req, res, next) => {
  try {
    res.json(await T(req, async (c) => {
      const to = await getPlan(c, String(req.body?.code || ''));
      if (!to || !to.active) throw Object.assign(new Error('없는 요금제입니다'), { status: 400 });
      const a = (await c.query('SELECT plan_code, price_locked_krw FROM academies WHERE id=$1', [req.user.aid])).rows[0];
      if (a.plan_code === to.code) return planSummary(c, req.user.aid);
      const active = (await c.query('SELECT count(*)::int AS n FROM students WHERE active')).rows[0].n;
      if (to.max_students != null && active > to.max_students) {
        throw Object.assign(new Error(`지금 학생이 ${active}명이라 ${to.name}(${to.max_students}명 이하)로 바꿀 수 없어요. 퇴원 처리 후 다시 시도해 주세요.`), { status: 409 });
      }
      const locked = to.promo_locks_price ? to.price_krw : null;
      await c.query('UPDATE academies SET plan_code=$2, price_locked_krw=$3 WHERE id=$1', [req.user.aid, to.code, locked]);
      await c.query('UPDATE subscriptions SET amount_krw=$2 WHERE academy_id=$1', [req.user.aid, locked ?? to.price_krw]);
      await c.query('INSERT INTO plan_changes (academy_id, from_code, to_code, price_krw, changed_by) VALUES ($1,$2,$3,$4,$5)',
        [req.user.aid, a.plan_code, to.code, locked ?? to.price_krw, req.user.sub]);
      await audit(c, { academyId: req.user.aid, actor: `staff:${req.user.sub}`, action: 'plan_change', target: `${a.plan_code}->${to.code}`, ip: req.ip });
      return planSummary(c, req.user.aid);
    }));
  } catch (e) { next(e); }
});
r.put('/academy', auth, ownerOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    await T(req, (c) => c.query('UPDATE academies SET name=COALESCE($2,name), director_name=COALESCE($3,director_name), contact_phone=COALESCE($4,contact_phone) WHERE id=$1',
      [req.user.aid, b.name ? String(b.name).slice(0, 40) : null, b.director_name ? String(b.director_name).slice(0, 20) : null,
       b.contact_phone != null ? normalizePhone(b.contact_phone).slice(0, 12) : null]));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- 교재 ----------
r.get('/materials', auth, async (req, res) => res.json(await T(req, async (c) => (await c.query('SELECT m.*, cl.name AS class_name FROM materials m LEFT JOIN classes cl ON cl.id=m.class_id WHERE m.active ORDER BY m.updated_at DESC')).rows)));
r.post('/materials', auth, async (req, res) => {
  const { scope_note, content } = req.body || {};
  const title = String(req.body?.title || '').trim().slice(0, 80);
  const class_id = UUID.test(String(req.body?.class_id || '')) ? req.body.class_id : null;
  if (!title) return res.status(400).json({ error: '교재 이름을 적어 주세요' });
  const row = await T(req, async (c) => (await c.query(
    'INSERT INTO materials (academy_id, class_id, title, scope_note, content) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.user.aid, class_id || null, title, scope_note || '', String(content || '').slice(0, 8000)])).rows[0]);
  res.json(row);
});

r.delete('/materials/:id', auth, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) throw bad('없는 교재예요', 404);
    await T(req, (c) => c.query('UPDATE materials SET active=false, updated_at=now() WHERE id=$1', [req.params.id]));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- 반 / 학생 / 학부모 ----------
const classUrl = (token) => `${process.env.APP_BASE_URL}/s/${token}`;
function checkClass(b) {
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) throw bad('반 이름을 적어 주세요');
  if (!SUBJECTS.includes(b.subject)) throw bad('과목을 골라 주세요');
  if (!GRADES.includes(b.grade_band)) throw bad('학년(초·중·고)을 골라 주세요');
  // 학습 코스 (자동 학습 리포트·상담글용): 학년 초3~고3, 월별/분기별/안 씀, 고정 달·분기(없으면 자동)
  const course_grade = b.course_grade ? String(b.course_grade) : null;
  if (course_grade && !CURRICULUM.GRADES.includes(course_grade)) throw bad('코스 학년을 다시 골라 주세요');
  const course_mode = ['month', 'quarter', 'off'].includes(b.course_mode) ? b.course_mode : 'month';
  const pin = b.course_pin == null || b.course_pin === '' ? null : Number(b.course_pin);
  if (pin != null && !(Number.isInteger(pin) && pin >= 1 && pin <= (course_mode === 'quarter' ? 4 : 12))) throw bad('고정할 달·분기를 다시 골라 주세요');
  return { name, subject: b.subject, grade_band: b.grade_band, course_grade, course_mode, course_pin: pin };
}
const classCourse = (x) => CURRICULUM.courseFor({ subject: x.subject, grade: x.course_grade, mode: x.course_mode, pin: x.course_pin });
r.get('/classes', auth, async (req, res, next) => {
  try {
    const rows = await T(req, async (c) => (await c.query(
      `SELECT cl.id, cl.name, cl.subject, cl.grade_band, cl.qr_token, cl.created_at, cl.course_grade, cl.course_mode, cl.course_pin,
              count(s.id) FILTER (WHERE s.active)::int AS students
         FROM classes cl LEFT JOIN students s ON s.class_id = cl.id
        GROUP BY cl.id ORDER BY cl.created_at`)).rows);
    res.json(rows.map((x) => {
      const c = classCourse(x);
      return { ...x, qrUrl: classUrl(x.qr_token), course: c ? { label: c.label, title: c.title, line: CURRICULUM.courseLine(c) } : null };
    }));
  } catch (e) { next(e); }
});
r.post('/classes', auth, ownerOnly, async (req, res, next) => {
  try {
    const v = checkClass(req.body || {});
    const row = await T(req, async (c) => (await c.query(
      `INSERT INTO classes (academy_id, name, subject, grade_band, course_grade, course_mode, course_pin) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, subject, grade_band, qr_token, course_grade, course_mode, course_pin`,
      [req.user.aid, v.name, v.subject, v.grade_band, v.course_grade, v.course_mode, v.course_pin])).rows[0]);
    res.json({ ...row, students: 0, qrUrl: classUrl(row.qr_token) });
  } catch (e) { next(e); }
});
r.put('/classes/:id', auth, ownerOnly, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) throw bad('없는 반이에요', 404);
    const v = checkClass(req.body || {});
    const row = await T(req, async (c) => (await c.query(
      'UPDATE classes SET name=$2, subject=$3, grade_band=$4, course_grade=$5, course_mode=$6, course_pin=$7 WHERE id=$1 RETURNING id',
      [req.params.id, v.name, v.subject, v.grade_band, v.course_grade, v.course_mode, v.course_pin])).rows[0]);
    if (!row) throw bad('없는 반이에요', 404);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// 학년별 기본 학습 코스 목록 (반 설정 화면에서 12개월·4분기 미리 보기)
r.get('/courses', auth, (req, res) => {
  const subject = req.query.subject === 'english' ? 'english' : 'math';
  const grade = CURRICULUM.GRADES.includes(req.query.grade) ? req.query.grade : null;
  if (!grade) return res.json({ grades: CURRICULUM.GRADES, months: [], quarters: [] });
  const month = new Date(Date.now() + 9 * 3600e3).getUTCMonth() + 1;
  res.json({
    grades: CURRICULUM.GRADES, subject, grade, nowMonth: month, nowQuarter: CURRICULUM.quarterOf(month),
    months: CURRICULUM.yearPlan(subject, grade).map((c) => ({ month: c.month, label: c.label, title: c.title, focus: c.focus, tip: c.tip })),
    quarters: [1, 2, 3, 4].map((q) => { const c = CURRICULUM.quarterCourse(subject, grade, q, 0); return { quarter: q, label: c.label, title: c.title }; }),
  });
});

// 반 QR 이미지 (인쇄용 PNG). 학원 분리(RLS)로 다른 학원 반은 조회되지 않음
r.get('/classes/:id/qr.png', auth, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) throw bad('없는 반이에요', 404);
    const cl = await T(req, async (c) => (await c.query('SELECT qr_token FROM classes WHERE id=$1', [req.params.id])).rows[0]);
    if (!cl) throw bad('없는 반이에요', 404);
    const png = await QRCode.toBuffer(classUrl(cl.qr_token), { width: 640, margin: 2, errorCorrectionLevel: 'M' });
    res.type('png').set('Cache-Control', 'private, max-age=300').send(png);
  } catch (e) { next(e); }
});

function checkStudent(b, { requirePin }) {
  const nickname = String(b.nickname || '').trim().slice(0, 12);
  const login_code = String(b.login_code || '').trim();
  const pin = b.pin == null ? '' : String(b.pin).trim();
  if (!nickname) throw bad('학생 이름(부르는 이름)을 적어 주세요');
  if (!/^\d{1,4}$/.test(login_code)) throw bad('출석번호는 숫자 1~4자리로 적어 주세요');
  if ((requirePin || pin) && !/^\d{4}$/.test(pin)) throw bad('비밀번호는 숫자 4자리로 정해 주세요');
  if (!UUID.test(String(b.class_id || ''))) throw bad('반을 골라 주세요');
  return { nickname, login_code, pin };
}
const dupCode = (e) => (e.code === '23505' ? bad('그 반에 같은 출석번호가 이미 있어요', 409) : e);

r.post('/students', auth, async (req, res, next) => {
  try {
    const { class_id, real_name, is_under_14, guardian } = req.body || {};
    const { nickname, login_code, pin } = checkStudent(req.body || {}, { requirePin: true });
    const out = await T(req, async (c) => {
      if (!(await c.query('SELECT 1 FROM classes WHERE id=$1', [class_id])).rows[0]) throw bad('반을 다시 골라 주세요');
      const st = (await c.query(
        `INSERT INTO students (academy_id, class_id, nickname, real_name_enc, login_code, pin_hash, is_under_14)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, nickname, login_code`,
        [req.user.aid, class_id, nickname, real_name ? encrypt(String(real_name).slice(0, 20)) : null, login_code,
         await bcrypt.hash(pin, 10), is_under_14 !== false]).catch((e) => { throw dupCode(e); })).rows[0];
      if (guardian?.phone) await saveGuardian(c, req.user.aid, st.id, guardian);
      await audit(c, { academyId: req.user.aid, actor: `staff:${req.user.sub}`, action: 'create_student', target: st.id, ip: req.ip });
      const { activeStudents, capacity } = await planSummary(c, req.user.aid);
      return { ...st, activeStudents, capacity }; // 30명 도달·초과 시 화면에 바로 안내
    });
    res.json(out);
  } catch (e) { next(e); }
});

// 학부모 연락처 저장 (한 학생당 대표 보호자 1명). 동의 시각은 '종이/온라인 동의서 확인 완료' 체크 시에만 기록
async function saveGuardian(c, aid, studentId, guardian) {
  const phone = normalizePhone(guardian.phone);
  if (!/^01\d{8,9}$/.test(phone)) throw bad('학부모 휴대폰 번호를 확인해 주세요');
  const now = guardian.consent_confirmed ? new Date() : null;
  const g = (await c.query('SELECT id FROM guardians WHERE student_id=$1 ORDER BY created_at LIMIT 1', [studentId])).rows[0];
  if (g) {
    await c.query(
      `UPDATE guardians SET phone_enc=$2, phone_hash=$3,
              consent_privacy_at = CASE WHEN $4::timestamptz IS NULL THEN consent_privacy_at ELSE COALESCE(consent_privacy_at, $4) END,
              consent_report_at  = CASE WHEN $4::timestamptz IS NULL THEN consent_report_at  ELSE COALESCE(consent_report_at, $4) END,
              consent_ai_at      = CASE WHEN $4::timestamptz IS NULL THEN consent_ai_at      ELSE COALESCE(consent_ai_at, $4) END
        WHERE id=$1`, [g.id, encrypt(phone), hmac(phone), now]);
  } else {
    await c.query(
      `INSERT INTO guardians (academy_id, student_id, relation, phone_enc, phone_hash, consent_privacy_at, consent_report_at, consent_ai_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$6)`,
      [aid, studentId, guardian.relation || '보호자', encrypt(phone), hmac(phone), now]);
  }
}

// 학생 목록 (전화번호는 마스킹해서만 보여 줌)
r.get('/students', auth, async (req, res, next) => {
  try {
    const rows = await T(req, async (c) => (await c.query(
      `SELECT s.id, s.nickname, s.login_code, s.class_id, s.is_under_14, s.active, cl.name AS class_name,
              g.phone_enc, (g.consent_report_at IS NOT NULL AND g.consent_privacy_at IS NOT NULL) AS report_ok, g.report_opt_out,
              (SELECT count(*)::int FROM question_sessions q WHERE q.student_id=s.id AND q.started_at > now() - interval '7 days') AS week_questions
         FROM students s LEFT JOIN classes cl ON cl.id = s.class_id
         LEFT JOIN LATERAL (SELECT * FROM guardians g WHERE g.student_id = s.id ORDER BY created_at LIMIT 1) g ON TRUE
        WHERE s.active ORDER BY cl.created_at, cl.name, length(s.login_code), s.login_code`)).rows);
    res.json(rows.map(({ phone_enc, ...r2 }) => {
      const p = phone_enc ? decrypt(phone_enc) : null;
      return { ...r2, guardianPhone: p ? `${p.slice(0, 3)}-****-${p.slice(-4)}` : null };
    }));
  } catch (e) { next(e); }
});

// 학생 정보 수정 / 비밀번호(PIN) 다시 정하기 / 학부모 번호·동의 / 퇴원(active=false)
r.patch('/students/:id', auth, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) throw bad('없는 학생이에요', 404);
    const b = req.body || {};
    const out = await T(req, async (c) => {
      const cur = (await c.query('SELECT * FROM students WHERE id=$1', [req.params.id])).rows[0];
      if (!cur) throw bad('없는 학생이에요', 404);
      if (b.active === false) {
        await c.query('UPDATE students SET active=false WHERE id=$1', [cur.id]);
        await audit(c, { academyId: req.user.aid, actor: `staff:${req.user.sub}`, action: 'deactivate_student', target: cur.id, ip: req.ip });
        return { ok: true, active: false };
      }
      const v = checkStudent({ nickname: b.nickname ?? cur.nickname, login_code: b.login_code ?? cur.login_code,
        class_id: b.class_id ?? cur.class_id, pin: b.pin }, { requirePin: false });
      if (v.pin === '' && b.pin) throw bad('비밀번호는 숫자 4자리로 정해 주세요');
      if (!(await c.query('SELECT 1 FROM classes WHERE id=$1', [b.class_id ?? cur.class_id])).rows[0]) throw bad('반을 다시 골라 주세요');
      await c.query(
        `UPDATE students SET nickname=$2, login_code=$3, class_id=$4, pin_hash=COALESCE($5, pin_hash),
                is_under_14=COALESCE($6, is_under_14) WHERE id=$1`,
        [cur.id, v.nickname, v.login_code, b.class_id ?? cur.class_id, v.pin ? await bcrypt.hash(v.pin, 10) : null,
         typeof b.is_under_14 === 'boolean' ? b.is_under_14 : null]).catch((e) => { throw dupCode(e); });
      if (b.guardian?.phone) await saveGuardian(c, req.user.aid, cur.id, b.guardian);
      await audit(c, { academyId: req.user.aid, actor: `staff:${req.user.sub}`, action: 'update_student', target: cur.id, ip: req.ip });
      return { ok: true, pinChanged: !!v.pin };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// 학생 완전 삭제 (퇴원 시) — CASCADE로 대화·리포트·연락처까지 파기
r.delete('/students/:id', auth, ownerOnly, async (req, res) => {
  await T(req, async (c) => {
    await c.query('DELETE FROM students WHERE id=$1', [req.params.id]);
    await audit(c, { academyId: req.user.aid, actor: `staff:${req.user.sub}`, action: 'delete_student', target: req.params.id, ip: req.ip });
  });
  res.json({ ok: true });
});

// ---------- 모니터링 ----------
r.get('/monitor/overview', auth, async (req, res) => {
  res.json(await T(req, async (c) => {
    const week = (await c.query(
      `SELECT count(*)::int AS questions,
              count(*) FILTER (WHERE status='solved')::int AS solved,
              count(DISTINCT student_id)::int AS active_students,
              round(avg(hint_level)::numeric,1) AS avg_hint
         FROM question_sessions WHERE kind='question' AND started_at > now() - interval '7 days'`)).rows[0];
    const topics = (await c.query(
      `SELECT topic, count(*)::int AS n, round(avg(hint_level)::numeric,1) AS avg_hint
         FROM question_sessions WHERE topic IS NOT NULL AND kind='question' AND started_at > now() - interval '7 days'
        GROUP BY topic ORDER BY n DESC LIMIT 8`)).rows;
    const flags = (await c.query(
      `SELECT f.id, s.nickname, f.category, f.created_at FROM safety_flags f JOIN students s ON s.id=f.student_id
        WHERE f.resolved_at IS NULL ORDER BY f.created_at DESC`)).rows;
    return { week, topics, flags };
  }));
});

r.get('/monitor/sessions', auth, async (req, res) => {
  res.json(await T(req, async (c) => (await c.query(
    `SELECT q.id, q.student_id, s.nickname, cl.name AS class_name, q.subject, q.topic, q.hint_level, q.status, q.started_at,
            q.kind, q.summary, q.hint2_opened, q.solution_shown,
            (SELECT count(*)::int FROM messages m WHERE m.session_id=q.id AND m.role='student') AS turns
       FROM question_sessions q JOIN students s ON s.id=q.student_id LEFT JOIN classes cl ON cl.id=s.class_id
      WHERE ($1::uuid IS NULL OR q.student_id=$1)
      ORDER BY q.started_at DESC LIMIT 100`, [UUID.test(String(req.query.studentId || '')) ? req.query.studentId : null])).rows));
});

r.get('/monitor/sessions/:id', auth, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: '없는 대화예요' });
  res.json(await T(req, async (c) => {
    await audit(c, { academyId: req.user.aid, actor: `staff:${req.user.sub}`, action: 'view_session', target: req.params.id, ip: req.ip });
    return (await c.query("SELECT role, content, verdict, created_at FROM messages WHERE session_id=$1 AND role<>'system' ORDER BY id", [req.params.id])).rows;
  }));
});

// ---------- 영작·풀이 첨삭 기록 ----------
// 학생별 최근 첨삭(고친 표현까지 전부) + 이번 주 실수 유형 요약 → 학생별 약점 확인·상담 준비용
r.get('/feedback', auth, async (req, res, next) => {
  try {
    const sid = req.query.studentId;
    if (sid && !/^[0-9a-f-]{36}$/i.test(String(sid))) return res.status(400).json({ error: '잘못된 학생' });
    res.json(await T(req, async (c) => {
      const rows = (await c.query(
        `SELECT f.id, f.student_id, s.nickname, f.subject, f.stage, f.transcript, f.items, f.error_count, f.fixed_count,
                f.retries, f.praise, f.created_at
           FROM feedback_reviews f JOIN students s ON s.id=f.student_id
          WHERE ($1::uuid IS NULL OR f.student_id=$1)
          ORDER BY f.created_at DESC LIMIT 50`, [sid || null])).rows;
      const week = rows.filter((r) => Date.now() - new Date(r.created_at) < 7 * 86400e3).reverse();
      const { summarizeReviews } = require('../ai/feedback');
      return { reviews: rows, week: summarizeReviews(week) };
    }));
  } catch (e) { next(e); }
});

r.post('/monitor/flags/:id/resolve', auth, async (req, res) => {
  await T(req, (c) => c.query('UPDATE safety_flags SET resolved_at=now() WHERE id=$1', [req.params.id]));
  res.json({ ok: true });
});

module.exports = r;
