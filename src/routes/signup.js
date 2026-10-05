// =====================================================================
// 공개 API: 요금제 목록 + 원장님 가입(온보딩)
//  GET  /api/plans    서비스 소개·가입 페이지의 플랜 비교 카드
//  POST /api/signup   학원 + 원장 계정 생성 → 14일 무료 체험 시작, 30분 Zoom 세팅 신청 기록
// =====================================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool, withTenant, audit } = require('../lib/db');
const { signStaff, cookieOpts, normalizePhone } = require('../lib/security');
const { toCard, listPlans, getPlan } = require('../lib/plans');

const r = express.Router();

r.get('/plans', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ plans: (await listPlans(pool)).map(toCard),
      setupCall: '30분 무료 화상 통화(Zoom)로 솔라피 및 첫 세팅을 1:1로 원스톱 완료해 드립니다' });
  } catch (e) { next(e); }
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

r.post('/signup', rateLimit({ windowMs: 60 * 60e3, limit: 5 }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const academyName = String(b.academy_name || '').trim().slice(0, 40);
    const directorName = String(b.director_name || '').trim().slice(0, 20);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const phone = normalizePhone(b.phone || '');
    const expected = b.expected_students == null || b.expected_students === '' ? null : Number(b.expected_students);
    if (!academyName || !directorName) throw bad('학원명과 원장님 성함을 적어 주세요');
    if (!EMAIL.test(email)) throw bad('이메일 주소를 확인해 주세요');
    if (password.length < 8) throw bad('비밀번호는 8자 이상으로 정해 주세요');
    if (!/^0\d{8,10}$/.test(phone)) throw bad('연락처(휴대폰 또는 학원 대표번호)를 확인해 주세요');
    if (expected != null && (!Number.isInteger(expected) || expected < 0 || expected > 2000)) throw bad('예상 학생 수를 숫자로 적어 주세요');
    if (b.agree_terms !== true) throw bad('이용약관과 개인정보 처리방침에 동의해 주세요');

    const plan = await getPlan(pool, String(b.plan_code || 'lite'));
    if (!plan || !plan.active) throw bad('요금제를 골라 주세요');
    // 예상 학생 수가 정원보다 많으면 맞는 플랜을 함께 알려 줌 (가입은 막지 않음)
    const plans = await listPlans(pool);
    const fit = expected == null ? null : plans.find((p) => p.max_students == null || expected <= p.max_students);
    const recommend = fit && fit.sort_order > plan.sort_order ? toCard(fit) : null;

    const exists = (await pool.query('SELECT 1 FROM staff WHERE email=$1', [email])).rows[0];
    if (exists) throw Object.assign(new Error('이미 가입된 이메일이에요. 로그인해 주세요.'), { status: 409 });

    const hash = await bcrypt.hash(password, 10);
    // academies·staff는 학원 분리(RLS) 대상이 아니라 일반 연결로 만들고, 감사 기록만 학원 범위로 남긴다
    const client = await pool.connect();
    let academy, staff;
    try {
      await client.query('BEGIN');
      academy = (await client.query(
        `INSERT INTO academies (name, director_name, contact_phone, plan_code, price_locked_krw, expected_students,
                                setup_call_requested_at, setup_call_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, plan_code, trial_ends_at`,
        [academyName, directorName, phone, plan.code, plan.promo_locks_price ? plan.price_krw : null, expected,
         b.setup_call ? new Date() : null, String(b.setup_note || '').slice(0, 200)])).rows[0];
      staff = (await client.query(
        `INSERT INTO staff (academy_id, email, password_hash, role) VALUES ($1,$2,$3,'owner') RETURNING id, academy_id, role`,
        [academy.id, email, hash])).rows[0];
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

    await withTenant(academy.id, (c) => audit(c, { academyId: academy.id, actor: `staff:${staff.id}`, action: 'signup', target: plan.code, ip: req.ip }));
    res.cookie('staff_token', signStaff(staff), cookieOpts(12));
    res.status(201).json({
      academy: { id: academy.id, name: academy.name },
      plan: toCard(plan),
      trialEndsAt: academy.trial_ends_at,
      setupCallRequested: !!b.setup_call,
      recommend,
      next: ['반 만들기', '원장님 말투 세팅', '학생 등록', b.setup_call ? '30분 Zoom 세팅 일정 연락 대기' : '솔라피·카카오 채널 연결'],
    });
  } catch (e) { next(e); }
});

module.exports = r;
