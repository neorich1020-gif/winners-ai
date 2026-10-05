// 원장님 월 구독 자동결제 (토스페이먼츠 빌링)
// 흐름: 대시보드에서 카드 등록창(토스 SDK requestBillingAuth) → successUrl로 authKey 수신
//      → 서버가 빌링키 발급 → 첫 달 즉시 결제 → 이후 매월 runMonthlyBilling()이 자동 청구
// ※ 엔드포인트·필드명은 토스페이먼츠 최신 문서로 반드시 재확인 후 사용하세요.
const express = require('express');
const crypto = require('crypto');
const { pool, batchPool, withTenant } = require('../lib/db');
const { requireAuth, encrypt, decrypt } = require('../lib/security');

const r = express.Router();
const TOSS = 'https://api.tosspayments.com/v1';
// 요금은 학원이 고른 플랜(academies.plan_code) 기준. 평생 할인으로 고정된 가격이 있으면 그 금액.
async function academyPrice(academyId) {
  return (await pool.query(
    `SELECT p.code, p.name, COALESCE(a.price_locked_krw, p.price_krw) AS amount
       FROM academies a JOIN plans p ON p.code = a.plan_code WHERE a.id=$1`, [academyId])).rows[0];
}
const authHeader = () => 'Basic ' + Buffer.from(`${process.env.TOSS_SECRET_KEY}:`).toString('base64');

async function toss(path, body) {
  const res = await fetch(`${TOSS}${path}`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message || 'toss error'), { toss: data });
  return data;
}

// 1) 카드 등록창을 띄우기 위한 정보 (customerKey는 추측 불가한 랜덤값)
r.get('/setup', requireAuth('staff'), async (req, res) => {
  let sub = (await pool.query('SELECT customer_key FROM subscriptions WHERE academy_id=$1', [req.user.aid])).rows[0];
  const price = await academyPrice(req.user.aid);
  if (!sub) {
    sub = (await pool.query(
      'INSERT INTO subscriptions (academy_id, customer_key, amount_krw) VALUES ($1,$2,$3) RETURNING customer_key',
      [req.user.aid, crypto.randomUUID(), price.amount])).rows[0];
  }
  res.json({ clientKey: process.env.TOSS_CLIENT_KEY, customerKey: sub.customer_key, amount: price.amount, plan: price.name,
    successUrl: `${process.env.APP_BASE_URL}/api/billing/success`, failUrl: `${process.env.APP_BASE_URL}/director#billing-fail` });
});

// 2) 카드 등록 성공 콜백 → 빌링키 발급 → 첫 결제
r.get('/success', requireAuth('staff'), async (req, res) => {
  const { authKey, customerKey } = req.query;
  const sub = (await pool.query('SELECT * FROM subscriptions WHERE academy_id=$1 AND customer_key=$2', [req.user.aid, customerKey])).rows[0];
  if (!sub) return res.redirect('/director#billing-fail');
  try {
    const issued = await toss('/billing/authorizations/issue', { authKey, customerKey });
    const label = issued.card ? `${issued.cardCompany || ''} ${issued.card.number || ''}`.trim() : null;
    await pool.query('UPDATE subscriptions SET billing_key_enc=$2, card_label=$3, updated_at=now() WHERE academy_id=$1',
      [req.user.aid, encrypt(issued.billingKey), label]);
    await chargeAcademy(req.user.aid);
    res.redirect('/director#billing-ok');
  } catch (e) {
    console.error('[billing] issue failed', e.toss || e.message);
    res.redirect('/director#billing-fail');
  }
});

// 실제 1회 청구 (첫 결제 & 매월 정기결제 공용)
async function chargeAcademy(academyId) {
  const sub = (await pool.query('SELECT * FROM subscriptions WHERE academy_id=$1', [academyId])).rows[0];
  if (!sub?.billing_key_enc) return { skipped: 'no_card' };
  const price = await academyPrice(academyId);
  sub.amount_krw = price.amount; // 플랜 변경은 다음 결제부터 반영, 스탠다드 출시가는 평생 고정
  const ym = new Date().toISOString().slice(0, 7);
  const orderId = `sub-${academyId.slice(0, 8)}-${ym}`; // 같은 달 중복 청구 방지 (payments.order_id UNIQUE)
  const exists = (await pool.query("SELECT 1 FROM payments WHERE order_id=$1 AND status='DONE'", [orderId])).rows[0];
  if (exists) return { skipped: 'already_paid' };

  try {
    const pay = await toss(`/billing/${decrypt(sub.billing_key_enc)}`, {
      customerKey: sub.customer_key, amount: sub.amount_krw, orderId, orderName: `AI 원장쌤 ${price.name} (${ym})`,
    });
    await withTenant(academyId, (c) => c.query(
      `INSERT INTO payments (academy_id, order_id, amount_krw, status, payment_key) VALUES ($1,$2,$3,'DONE',$4)
       ON CONFLICT (order_id) DO UPDATE SET status='DONE', payment_key=EXCLUDED.payment_key`,
      [academyId, orderId, sub.amount_krw, pay.paymentKey]));
    await pool.query("UPDATE academies SET plan_status='active' WHERE id=$1", [academyId]);
    await pool.query("UPDATE subscriptions SET fail_count=0, next_billing_at=now() + interval '1 month', updated_at=now() WHERE academy_id=$1", [academyId]);
    return { ok: true };
  } catch (e) {
    const fails = sub.fail_count + 1;
    await withTenant(academyId, (c) => c.query(
      `INSERT INTO payments (academy_id, order_id, amount_krw, status, raw_error) VALUES ($1,$2,$3,'FAILED',$4)
       ON CONFLICT (order_id) DO UPDATE SET raw_error=EXCLUDED.raw_error`,
      [academyId, orderId, sub.amount_krw, JSON.stringify(e.toss || e.message).slice(0, 500)]));
    // 실패 시: 3일 뒤 재시도, 3회 실패 → past_due(학생 접속 7일 유예 후 차단은 운영정책으로)
    await pool.query("UPDATE subscriptions SET fail_count=$2, next_billing_at=now() + interval '3 days' WHERE academy_id=$1", [academyId, fails]);
    if (fails >= 3) await pool.query("UPDATE academies SET plan_status='past_due' WHERE id=$1", [academyId]);
    return { ok: false, fails };
  }
}

// 매일 오전 10시(KST) 스케줄러가 호출: 청구일이 된 학원만 결제
async function runMonthlyBilling() {
  const due = (await batchPool.query(
    "SELECT academy_id FROM subscriptions WHERE billing_key_enc IS NOT NULL AND next_billing_at <= now()")).rows;
  for (const { academy_id } of due) {
    const out = await chargeAcademy(academy_id);
    console.log('[billing]', academy_id, out);
  }
}

// 해지: 빌링키 삭제(다음 달부터 청구 중단), 남은 기간까지는 이용 가능
r.post('/cancel', requireAuth('staff'), async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).end();
  await pool.query('UPDATE subscriptions SET billing_key_enc=NULL, next_billing_at=NULL WHERE academy_id=$1', [req.user.aid]);
  await pool.query("UPDATE academies SET plan_status='canceled' WHERE id=$1", [req.user.aid]);
  res.json({ ok: true });
});

module.exports = { router: r, runMonthlyBilling, chargeAcademy };
