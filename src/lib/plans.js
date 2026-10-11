// =====================================================================
// 요금제 3종: 화면 표시용 설명, 정원 판단, 사진 질문 월 한도 차감
// 가격·한도 숫자는 DB plans 표가 기준이고, 여기에는 '어떻게 보여 줄지'만 둔다.
// =====================================================================

// ready=false 는 아직 개발 전인 기능 → 화면에 '곧 제공'으로 표시 (없는 기능을 있는 것처럼 팔지 않기)
const FEATURES = {
  text_unlimited:  { label: '텍스트 질문 무제한', ready: true },
  photo_limited:   { label: '사진 질문(Vision) 월 100회', ready: true },
  photo_unlimited: { label: '사진 질문(Vision) 무제한', ready: true },
  feedback_limited:   { label: '영어 영작·수학 풀이 AI 첨삭 월 30회', ready: true },
  feedback_unlimited: { label: '영어 영작·수학 풀이 AI 첨삭 무제한', ready: true },
  weekly_counsel:  { label: '원장님 말투 AI 주간 상담글·리포트', ready: true },
  alimtalk:        { label: '솔라피 카카오 알림톡 자동 발송', ready: true },
  exam_mode:       { label: '시험기간 모드', ready: false },
  voice_report:    { label: '원장님 음성 리포트 옵션', ready: false },
  trial_mode:      { label: '신규 상담생 전용 AI 체험 모드', ready: false },
  multi_persona:   { label: '강사별 멀티 AI 페르소나', ready: false },
  promo_writer:    { label: '블로그·당근 홍보글 자동 생성', ready: false },
};

const ORDER = Object.keys(FEATURES);

const BADGES = {
  lite: { audience: '학생 30명 이하 소규모 학원' },
  standard: { audience: '학생 60명 이하', popular: '🔥 가장 인기 / 추천' },
  premium: { audience: '학생 60명 초과 또는 다과목 학원' },
};

function toCard(p) {
  return {
    code: p.code,
    name: p.name,
    priceKrw: p.price_krw,
    listPriceKrw: p.list_price_krw,
    promoLabel: p.promo_label,
    promoLocksPrice: p.promo_locks_price,
    maxStudents: p.max_students,
    photoMonthlyLimit: p.photo_monthly_limit,
    feedbackMonthlyLimit: p.feedback_monthly_limit ?? null,
    audience: BADGES[p.code]?.audience || '',
    popular: BADGES[p.code]?.popular || null,
    // 화면 표시 순서는 FEATURES 정의 순서 (DB에 나중에 추가된 기능도 제자리에 보이게)
    features: [...p.features].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
      .map((f) => ({ code: f, ...(FEATURES[f] || { label: f, ready: false }) })),
  };
}

async function listPlans(db) {
  return (await db.query('SELECT * FROM plans WHERE active ORDER BY sort_order')).rows;
}
async function getPlan(db, code) {
  return (await db.query('SELECT * FROM plans WHERE code=$1', [code])).rows[0];
}

// 정원 판단 + 다음 플랜 추천
//   ok: 여유 · full: 정원과 같음 · over: 정원 초과 (이용은 막지 않고 안내만)
function capacityStatus(active, plan, plans = []) {
  const max = plan.max_students;
  if (max == null) return { level: 'ok', badge: null, message: null, recommend: null };
  const next = plans.find((p) => p.sort_order > plan.sort_order && (p.max_students == null || p.max_students > max));
  const nextText = next ? `${next.name}(${next.max_students ? `${next.max_students}명 이하` : '인원 제한 없음'}, 월 ${next.price_krw.toLocaleString('ko-KR')}원)` : null;
  if (active > max) return { level: 'over', badge: `학생 ${active}명 · ${plan.name} 정원(${max}명) 초과`,
    message: nextText ? `${nextText} 플랜으로 변경을 권해 드려요. 지금은 그대로 이용하실 수 있어요.` : '플랜 변경을 안내해 드릴게요.', recommend: next?.code || null };
  if (active === max) return { level: 'full', badge: `정원 도달 ${active}/${max}명`,
    message: `다음 학생을 등록하면 ${plan.name} 정원을 넘습니다.${nextText ? ` 인원이 늘면 ${nextText}을 확인해 보세요.` : ''}`, recommend: next?.code || null };
  return { level: 'ok', badge: null, message: null, recommend: null };
}

// 한국 시간 기준 이번 달 1일
function monthKST(now = Date.now()) {
  return new Date(now + 9 * 3600e3).toISOString().slice(0, 8) + '01';
}

// 사진 질문 1회 차감. 같은 트랜잭션 안에서 호출 → AI 오류로 롤백되면 차감도 취소된다.
// 동시에 여러 학생이 보내도 UPDATE 행 잠금으로 한도를 넘지 않는다.
async function consumePhoto(client, academyId, plan) {
  const month = monthKST();
  await client.query('INSERT INTO monthly_usage (academy_id, month) VALUES ($1,$2) ON CONFLICT DO NOTHING', [academyId, month]);
  const row = (await client.query(
    `UPDATE monthly_usage SET photo_questions = photo_questions + 1
      WHERE academy_id=$1 AND month=$2 AND ($3::int IS NULL OR photo_questions < $3)
      RETURNING photo_questions`, [academyId, month, plan.photo_monthly_limit])).rows[0];
  if (!row) {
    // 한도 소진: 원장님 대시보드 안내용 시각 기록 (별도 쿼리라 롤백돼도 큰 문제 없음)
    await client.query('UPDATE monthly_usage SET limit_notified_at = COALESCE(limit_notified_at, now()) WHERE academy_id=$1 AND month=$2', [academyId, month]);
    const err = new Error(`이번 달 사진 질문 ${plan.photo_monthly_limit}회를 모두 썼어. 문제를 글로 적어서 물어봐 줘!`);
    Object.assign(err, { status: 402, code: 'PHOTO_QUOTA', extra: { used: plan.photo_monthly_limit, limit: plan.photo_monthly_limit, remaining: 0, upgradeTo: 'standard' } });
    throw err;
  }
  return photoStatus(row.photo_questions, plan);
}
async function photoUsage(client, academyId, plan) {
  const row = (await client.query('SELECT photo_questions FROM monthly_usage WHERE academy_id=$1 AND month=$2', [academyId, monthKST()])).rows[0];
  return photoStatus(row?.photo_questions || 0, plan);
}
function photoStatus(used, plan) {
  const limit = plan.photo_monthly_limit;
  return { used, limit, remaining: limit == null ? null : Math.max(0, limit - used) };
}

// 첨삭 1회 차감 (라이트: 학원 전체 월 30회). 사진 질문 횟수와는 따로 센다. 고쳐 쓰기 확인은 차감하지 않음.
async function consumeFeedback(client, academyId, plan) {
  const month = monthKST();
  const limit = plan.feedback_monthly_limit ?? null;
  await client.query('INSERT INTO monthly_usage (academy_id, month) VALUES ($1,$2) ON CONFLICT DO NOTHING', [academyId, month]);
  const row = (await client.query(
    `UPDATE monthly_usage SET feedback_reviews = feedback_reviews + 1
      WHERE academy_id=$1 AND month=$2 AND ($3::int IS NULL OR feedback_reviews < $3)
      RETURNING feedback_reviews`, [academyId, month, limit])).rows[0];
  if (!row) {
    await client.query('UPDATE monthly_usage SET feedback_notified_at = COALESCE(feedback_notified_at, now()) WHERE academy_id=$1 AND month=$2', [academyId, month]);
    const err = new Error(`이번 달 첨삭 ${limit}회를 모두 썼어. 궁금한 문장은 글로 질문해 줘!`);
    Object.assign(err, { status: 402, code: 'FEEDBACK_QUOTA', extra: { used: limit, limit, remaining: 0, upgradeTo: 'standard' } });
    throw err;
  }
  return usageStatus(row.feedback_reviews, limit);
}
async function feedbackUsage(client, academyId, plan) {
  const row = (await client.query('SELECT feedback_reviews FROM monthly_usage WHERE academy_id=$1 AND month=$2', [academyId, monthKST()])).rows[0];
  return usageStatus(row?.feedback_reviews || 0, plan.feedback_monthly_limit ?? null);
}
function usageStatus(used, limit) {
  return { used, limit, remaining: limit == null ? null : Math.max(0, limit - used) };
}

module.exports = { FEATURES, toCard, listPlans, getPlan, capacityStatus, consumePhoto, photoUsage, consumeFeedback, feedbackUsage, monthKST };
