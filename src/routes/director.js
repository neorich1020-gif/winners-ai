// 원장 대시보드 API: 로그인, 말투·교재 세팅, 반/학생/학부모 관리, 질문 모니터링
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool, withTenant, audit } = require('../lib/db');
const { signStaff, requireAuth, cookieOpts, encrypt, decrypt, hmac, normalizePhone } = require('../lib/security');
const { toCard, listPlans, getPlan, capacityStatus, photoUsage } = require('../lib/plans');

const r = express.Router();
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

// ---------- 페르소나(말투) ----------
r.get('/persona', auth, async (req, res) => {
  res.json(await T(req, async (c) => (await c.query(
    `SELECT name, director_name, persona_name, persona_style, persona_examples, report_weekday, report_time, report_enabled,
            counsel_tone, counsel_signature, stats_fallback FROM academies WHERE id=$1`, [req.user.aid])).rows[0]));
});
r.put('/persona', auth, ownerOnly, async (req, res) => {
  const b = req.body || {};
  await T(req, (c) => c.query(
    `UPDATE academies SET persona_name=$2, persona_style=$3, persona_examples=$4,
       report_weekday=$5, report_time=$6, report_enabled=$7,
       counsel_tone=COALESCE($8, counsel_tone), counsel_signature=COALESCE($9, counsel_signature), stats_fallback=$10 WHERE id=$1`,
    [req.user.aid, String(b.persona_name || '원장쌤').slice(0, 20), String(b.persona_style || '').slice(0, 800),
     String(b.persona_examples || '').slice(0, 2000), Number(b.report_weekday ?? 5), b.report_time || '18:00', b.report_enabled !== false,
     b.counsel_tone != null ? String(b.counsel_tone).slice(0, 600) : null,
     b.counsel_signature != null ? String(b.counsel_signature).slice(0, 60) : null, b.stats_fallback !== false]));
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
  return {
    academy: { name: a.name, director_name: a.director_name, contact_phone: a.contact_phone, plan_status: a.plan_status, trial_ends_at: a.trial_ends_at },
    plan: { ...toCard(plan), monthlyKrw: a.price_locked_krw ?? plan.price_krw, priceLocked: a.price_locked_krw != null },
    activeStudents: active,
    capacity: capacityStatus(active, plan, plans),
    photo: { ...photo, exhausted: photo.limit != null && photo.remaining === 0 },  // 라이트: 이번 달 사진 질문 잔여
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
r.get('/materials', auth, async (req, res) => res.json(await T(req, async (c) => (await c.query('SELECT * FROM materials ORDER BY updated_at DESC')).rows)));
r.post('/materials', auth, async (req, res) => {
  const { class_id, title, scope_note, content } = req.body || {};
  const row = await T(req, async (c) => (await c.query(
    'INSERT INTO materials (academy_id, class_id, title, scope_note, content) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.user.aid, class_id || null, title, scope_note || '', String(content || '').slice(0, 8000)])).rows[0]);
  res.json(row);
});

// ---------- 반 / 학생 / 학부모 ----------
r.post('/classes', auth, ownerOnly, async (req, res) => {
  const { name, subject, grade_band } = req.body || {};
  const row = await T(req, async (c) => (await c.query(
    'INSERT INTO classes (academy_id, name, subject, grade_band) VALUES ($1,$2,$3,$4) RETURNING id, name, qr_token', [req.user.aid, name, subject, grade_band])).rows[0]);
  res.json({ ...row, qrUrl: `${process.env.APP_BASE_URL}/s/${row.qr_token}` });
});

r.post('/students', auth, async (req, res) => {
  const { class_id, nickname, real_name, login_code, pin, is_under_14, guardian } = req.body || {};
  const out = await T(req, async (c) => {
    const st = (await c.query(
      `INSERT INTO students (academy_id, class_id, nickname, real_name_enc, login_code, pin_hash, is_under_14)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, nickname, login_code`,
      [req.user.aid, class_id, nickname, encrypt(real_name), String(login_code), await bcrypt.hash(String(pin), 10), is_under_14 !== false])).rows[0];
    if (guardian?.phone) {
      const phone = normalizePhone(guardian.phone);
      // 동의 시각은 '종이/온라인 동의서 확인 완료' 체크 시에만 기록
      const now = guardian.consent_confirmed ? new Date() : null;
      await c.query(
        `INSERT INTO guardians (academy_id, student_id, relation, phone_enc, phone_hash, consent_privacy_at, consent_report_at, consent_ai_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$6)`,
        [req.user.aid, st.id, guardian.relation || '보호자', encrypt(phone), hmac(phone), now]);
    }
    await audit(c, { academyId: req.user.aid, actor: `staff:${req.user.sub}`, action: 'create_student', target: st.id, ip: req.ip });
    const { activeStudents, capacity } = await planSummary(c, req.user.aid);
    return { ...st, activeStudents, capacity }; // 30명 도달·초과 시 화면에 바로 안내
  });
  res.json(out);
});

// 학생 목록 (전화번호는 마스킹해서만 보여 줌)
r.get('/students', auth, async (req, res) => {
  const rows = await T(req, async (c) => (await c.query(
    `SELECT s.id, s.nickname, s.login_code, s.class_id, g.phone_enc, g.consent_report_at IS NOT NULL AS report_ok, g.report_opt_out
       FROM students s LEFT JOIN guardians g ON g.student_id = s.id WHERE s.active ORDER BY s.nickname`)).rows);
  res.json(rows.map(({ phone_enc, ...r }) => {
    const p = phone_enc ? decrypt(phone_enc) : null;
    return { ...r, guardianPhone: p ? `${p.slice(0, 3)}-****-${p.slice(-4)}` : null };
  }));
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
         FROM question_sessions WHERE started_at > now() - interval '7 days'`)).rows[0];
    const topics = (await c.query(
      `SELECT topic, count(*)::int AS n, round(avg(hint_level)::numeric,1) AS avg_hint
         FROM question_sessions WHERE topic IS NOT NULL AND started_at > now() - interval '7 days'
        GROUP BY topic ORDER BY n DESC LIMIT 8`)).rows;
    const flags = (await c.query(
      `SELECT f.id, s.nickname, f.category, f.created_at FROM safety_flags f JOIN students s ON s.id=f.student_id
        WHERE f.resolved_at IS NULL ORDER BY f.created_at DESC`)).rows;
    return { week, topics, flags };
  }));
});

r.get('/monitor/sessions', auth, async (req, res) => {
  res.json(await T(req, async (c) => (await c.query(
    `SELECT q.id, s.nickname, q.topic, q.hint_level, q.status, q.started_at
       FROM question_sessions q JOIN students s ON s.id=q.student_id
      ORDER BY q.started_at DESC LIMIT 100`)).rows));
});

r.get('/monitor/sessions/:id', auth, async (req, res) => {
  res.json(await T(req, async (c) => {
    await audit(c, { academyId: req.user.aid, actor: `staff:${req.user.sub}`, action: 'view_session', target: req.params.id, ip: req.ip });
    return (await c.query("SELECT role, content, verdict, created_at FROM messages WHERE session_id=$1 AND role<>'system' ORDER BY id", [req.params.id])).rows;
  }));
});

r.post('/monitor/flags/:id/resolve', auth, async (req, res) => {
  await T(req, (c) => c.query('UPDATE safety_flags SET resolved_at=now() WHERE id=$1', [req.params.id]));
  res.json({ ok: true });
});

module.exports = r;
