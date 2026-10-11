// =====================================================================
// 학부모 주간 메시지 — 카카오 알림톡 1:1 자동 발송
//   ① 원장님이 승인한 '주간 상담글'이 있으면 그 글을 보낸다 (routes/counsel.js에서 작성·승인)
//   ② 없으면 AI 질문창 통계로 만든 '자동 학습 리포트'를 보낸다 (학원 설정으로 끌 수 있음)
//
// 스케줄: 5분마다 깨어나서 "지금(KST)이 발송 시각인 학원"을 찾는다.
//   → 학원마다 요일·시간을 다르게 설정 가능 (기본 금 18:00)
// 중복 방지: weekly_reports (guardian_id, week_start) UNIQUE
// 재시도: 실패 건은 다음 5분 주기에 다시 시도, 최대 3회
// 발송 조건: 학부모 리포트 수신 동의 O, 수신거부 X, 학원 구독 유효
// 학부모에게 대화 원문은 보내지 않는다 — 통계와 단원명만.
// =====================================================================
const { SolapiMessageService } = require('solapi');
const { batchPool: pool } = require('../lib/db'); // 여러 학원을 다루는 배치 → RLS 우회 계정
const { decrypt } = require('../lib/security');
const { summarizeReviews } = require('../ai/feedback');

const DRY = process.env.DRY_RUN === '1';
const sms = DRY ? null : new SolapiMessageService(process.env.SOLAPI_API_KEY, process.env.SOLAPI_API_SECRET);

// ---- KST 시간 유틸 ----
function nowKST() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return { weekday: d.getUTCDay(), hhmm: d.toISOString().slice(11, 16), date: d.toISOString().slice(0, 10) };
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// ---- 1. 학생별 주간 통계 ----
// db: 기본은 배치용 pool, 원장 화면에서는 학원 RLS가 걸린 client를 넘겨 재사용
async function buildStats(academyId, studentId, weekStart, db = pool) {
  const q = (await db.query(
    `SELECT count(*)::int AS questions,
            count(*) FILTER (WHERE status='solved')::int AS solved,
            count(DISTINCT date(started_at AT TIME ZONE 'Asia/Seoul'))::int AS days,
            coalesce(round(avg(hint_level)::numeric,1),0) AS avg_hint
       FROM question_sessions
      WHERE academy_id=$1 AND student_id=$2 AND kind='question'
        AND started_at >= ($3::date AT TIME ZONE 'Asia/Seoul')
        AND started_at <  (($3::date + 7) AT TIME ZONE 'Asia/Seoul')`,
    [academyId, studentId, weekStart])).rows[0];
  const topics = (await db.query(
    `SELECT topic, count(*)::int AS n, avg(hint_level) AS h FROM question_sessions
      WHERE academy_id=$1 AND student_id=$2 AND topic IS NOT NULL AND kind='question'
        AND started_at >= ($3::date AT TIME ZONE 'Asia/Seoul')
        AND started_at <  (($3::date + 7) AT TIME ZONE 'Asia/Seoul')
      GROUP BY topic ORDER BY n DESC LIMIT 5`,
    [academyId, studentId, weekStart])).rows;
  const strong = topics.filter((t) => t.h < 1.5).map((t) => t.topic).slice(0, 2);
  const weak = topics.filter((t) => t.h >= 2.5).map((t) => t.topic).slice(0, 2);
  // 튜터가 남긴 대화 요약 (막힌 부분·원장님 코칭 메모·학부모 칭찬 한 줄·오답노트 지시)
  const sums = (await db.query(
    `SELECT summary FROM question_sessions
      WHERE academy_id=$1 AND student_id=$2 AND kind='question' AND summary IS NOT NULL
        AND started_at >= ($3::date AT TIME ZONE 'Asia/Seoul')
        AND started_at <  (($3::date + 7) AT TIME ZONE 'Asia/Seoul')
      ORDER BY started_at DESC LIMIT 20`,
    [academyId, studentId, weekStart])).rows.map((r) => r.summary);
  const uniq = (arr, n) => [...new Set(arr.filter(Boolean))].slice(0, n);
  const notes = sums.length ? {
    weakness: uniq(sums.map((x) => x.weakness_point), 3),
    director: uniq(sums.map((x) => x.director_note), 2),
    cheering: uniq(sums.map((x) => x.parent_cheering_msg), 1),
    wrongNotes: sums.filter((x) => x.math_wrong_note_assigned).length,
  } : null;
  // 영작·풀이 첨삭 (상담글 초안과 원장 화면에 사용, 학부모 자동 리포트 템플릿에는 넣지 않음)
  const reviews = (await db.query(
    `SELECT subject, error_count, fixed_count, items FROM feedback_reviews
      WHERE academy_id=$1 AND student_id=$2
        AND created_at >= ($3::date AT TIME ZONE 'Asia/Seoul')
        AND created_at <  (($3::date + 7) AT TIME ZONE 'Asia/Seoul')
      ORDER BY created_at`,
    [academyId, studentId, weekStart])).rows;
  return { ...q, topics: topics.map((t) => t.topic), strong, weak, feedback: summarizeReviews(reviews), notes };
}

// ---- 2. 알림톡 변수 (승인된 템플릿의 #{변수}와 1:1 일치해야 함) ----
function toTemplateVars(academy, student, s) {
  const solvedRate = s.questions ? Math.round((s.solved / s.questions) * 100) : 0;
  let comment;
  if (s.questions === 0) comment = '이번 주는 AI 질문창 이용이 없었어요. 다음 주에는 막히는 문제를 꼭 물어보도록 응원해 주세요.';
  else if (s.avg_hint <= 1.5) comment = '힌트를 적게 받고도 스스로 해결하는 힘이 좋아지고 있어요.';
  else if (s.avg_hint >= 3) comment = '어려워하는 부분이 있어 수업 시간에 한 번 더 짚어 주겠습니다.';
  else comment = '꾸준히 질문하며 스스로 풀어 보려는 태도가 좋습니다.';
  return {
    '#{학원명}': academy.name,
    '#{학생명}': student.nickname,
    '#{학습일수}': String(s.days),
    '#{질문수}': String(s.questions),
    '#{해결률}': `${solvedRate}%`,
    '#{학습단원}': s.topics.slice(0, 3).join(', ') || '-',
    '#{보완단원}': s.weak.join(', ') || '없음',
    '#{원장코멘트}': comment,
  };
}

// 학부모 화면에 보이게 될 최종 문장 (DB 기록 & DRY_RUN 확인용)
function renderPreview(v) {
  return `[${v['#{학원명}']}] ${v['#{학생명}']} 학생 주간 학습 리포트
■ 이번 주 학습일: ${v['#{학습일수}']}일
■ 질문한 문제: ${v['#{질문수}']}개 (스스로 해결 ${v['#{해결률}']})
■ 공부한 단원: ${v['#{학습단원}']}
■ 보완이 필요한 단원: ${v['#{보완단원}']}
■ 원장 코멘트: ${v['#{원장코멘트}']}`;
}

// ---- 3. 발송 ----
// 알림톡 템플릿 2종 (둘 다 카카오 검수 필요, docs/alimtalk-template.md)
//  - 주간 학습 리포트(자동 통계): KAKAO_TEMPLATE_WEEKLY
//  - 주간 상담(원장 승인 상담글): KAKAO_TEMPLATE_COUNSEL
//    COUNSEL_MODE=inline → 본문을 #{상담내용} 변수로 그대로 발송 (기본)
//    COUNSEL_MODE=link   → 짧은 안내 + "상담글 전체 보기" 버튼, 본문은 /letter/<토큰> 보안 링크에서 열람
const COUNSEL_MODE = process.env.COUNSEL_MODE === 'link' ? 'link' : 'inline';

async function sendAlimtalk(phone, templateId, vars, preview, buttons) {
  if (DRY) {
    console.log('[DRY_RUN] →', phone.slice(0, 3) + '****' + phone.slice(-4), `(${templateId === process.env.KAKAO_TEMPLATE_COUNSEL ? '상담글' : '통계'})\n` + preview);
    return { messageId: 'dry-run' };
  }
  const r = await sms.send({
    to: phone,
    from: process.env.SENDER_PHONE,
    kakaoOptions: {
      pfId: process.env.KAKAO_PF_ID,
      templateId,
      variables: vars,
      ...(buttons ? { buttons } : {}),
      disableSms: false, // 카톡 미설치/실패 시 문자(LMS)로 대체 발송
    },
  });
  return { messageId: r?.groupInfo?.groupId || null };
}

// 원장 승인 상담글 → 알림톡 변수
function counselTemplateVars(academy, student, note, token) {
  const sign = academy.counsel_signature || `${academy.name} ${academy.director_name} 드림`;
  if (COUNSEL_MODE === 'link') {
    return {
      vars: { '#{학원명}': academy.name, '#{학생명}': student.nickname, '#{원장명}': academy.director_name },
      buttons: [{ buttonType: 'WL', buttonName: '상담글 전체 보기',
        linkMo: `${process.env.APP_BASE_URL}/letter/${token}`, linkPc: `${process.env.APP_BASE_URL}/letter/${token}` }],
      preview: `[${academy.name}] ${student.nickname} 학생 주간 상담 안내\n${academy.director_name} 원장님이 이번 주 상담글을 보내셨습니다.\n[상담글 전체 보기] → /letter/${token.slice(0, 6)}…`,
    };
  }
  const body = `${note.final_text.trim()}\n\n${sign}`;
  return {
    vars: { '#{학원명}': academy.name, '#{학생명}': student.nickname, '#{상담내용}': body },
    preview: `[${academy.name}] ${student.nickname} 학생 주간 상담 안내\n\n${body}`,
  };
}

// ---- 4. 학원 1곳 처리 ----
// 학부모마다: ① 원장님이 승인한 이번 주 상담글이 있으면 상담글 발송
//            ② 없으면 학원 설정(stats_fallback)에 따라 자동 통계 리포트 발송 또는 건너뜀
// 승인되지 않은 초안(draft)은 절대 발송하지 않는다.
async function processAcademy(academy, weekStart) {
  const targets = (await pool.query(
    `SELECT s.id AS student_id, s.nickname, g.id AS guardian_id, g.phone_enc
       FROM students s JOIN guardians g ON g.student_id = s.id
      WHERE s.academy_id=$1 AND s.active
        AND g.consent_report_at IS NOT NULL AND g.consent_privacy_at IS NOT NULL AND NOT g.report_opt_out`,
    [academy.id])).rows;

  let sent = 0, failed = 0, skipped = 0;
  for (const t of targets) {
    // 이미 이번 주 발송 완료됐거나 3회 실패한 학부모는 건너뜀
    const prev = (await pool.query('SELECT status, attempts FROM weekly_reports WHERE guardian_id=$1 AND week_start=$2', [t.guardian_id, weekStart])).rows[0];
    if (prev && (prev.status === 'sent' || prev.status === 'skipped' || prev.attempts >= 3)) continue;

    const note = (await pool.query(
      `SELECT * FROM counsel_notes WHERE student_id=$1 AND week_start=$2 AND status IN ('approved','sent','failed')
         AND approved_at IS NOT NULL AND length(trim(final_text))>0`,
      [t.student_id, weekStart])).rows[0];
    const stats = await buildStats(academy.id, t.student_id, weekStart);

    let kind, templateId, vars, preview, buttons;
    if (note) {
      kind = 'counsel';
      templateId = process.env.KAKAO_TEMPLATE_COUNSEL;
      let token = null;
      if (COUNSEL_MODE === 'link') {
        token = (await pool.query(
          `INSERT INTO letter_links (counsel_id, guardian_id) VALUES ($1,$2) RETURNING token`, [note.id, t.guardian_id])).rows[0].token;
      }
      ({ vars, preview, buttons } = counselTemplateVars(academy, t, note, token));
    } else if (academy.stats_fallback) {
      kind = 'stats';
      templateId = process.env.KAKAO_TEMPLATE_WEEKLY;
      vars = toTemplateVars(academy, t, stats);
      preview = renderPreview(vars);
    } else {
      await pool.query(
        `INSERT INTO weekly_reports (academy_id, student_id, guardian_id, week_start, kind, stats, summary_text, status)
         VALUES ($1,$2,$3,$4,'stats',$5,'승인된 상담글 없음 · 자동 리포트 꺼짐','skipped')
         ON CONFLICT (guardian_id, week_start) DO NOTHING`,
        [academy.id, t.student_id, t.guardian_id, weekStart, stats]);
      skipped++;
      continue;
    }

    await pool.query(
      `INSERT INTO weekly_reports (academy_id, student_id, guardian_id, week_start, kind, counsel_id, stats, summary_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (guardian_id, week_start) DO UPDATE SET kind=EXCLUDED.kind, counsel_id=EXCLUDED.counsel_id, stats=EXCLUDED.stats, summary_text=EXCLUDED.summary_text`,
      [academy.id, t.student_id, t.guardian_id, weekStart, kind, note?.id || null, stats, preview]);
    try {
      const { messageId } = await sendAlimtalk(decrypt(t.phone_enc), templateId, vars, preview, buttons);
      await pool.query("UPDATE weekly_reports SET status='sent', sent_at=now(), provider_msg_id=$3, attempts=attempts+1 WHERE guardian_id=$1 AND week_start=$2",
        [t.guardian_id, weekStart, messageId]);
      if (note) await pool.query("UPDATE counsel_notes SET status='sent', sent_at=COALESCE(sent_at, now()) WHERE id=$1", [note.id]);
      sent++;
    } catch (e) {
      const row = (await pool.query("UPDATE weekly_reports SET status='failed', error=$3, attempts=attempts+1 WHERE guardian_id=$1 AND week_start=$2 RETURNING attempts",
        [t.guardian_id, weekStart, String(e.message).slice(0, 300)])).rows[0];
      // 3회 모두 실패했고 다른 학부모에게도 안 갔으면 상담글을 '실패'로 표시 → 원장님 화면에 빨간 표시
      if (note && row.attempts >= 3 && note.status !== 'sent') await pool.query("UPDATE counsel_notes SET status='failed' WHERE id=$1 AND status<>'sent'", [note.id]);
      failed++;
    }
    await new Promise((r) => setTimeout(r, 120)); // 발송사 초당 제한 여유
  }
  console.log(`[weekly] ${academy.name} week=${weekStart} sent=${sent} failed=${failed} skipped=${skipped}`);
}

// ---- 5. 스케줄러 진입점 (5분마다 호출) ----
// 발송 시각 ~ 3시간 사이에 깨어날 때마다 '아직 안 보낸/실패한' 건만 처리 → 서버 재시작·장애에도 누락 없음
async function runWeeklyReports({ force = false } = {}) {
  const now = nowKST();
  const weekStart = mondayOf(now.date);
  const academies = (await pool.query(
    `SELECT * FROM academies
      WHERE report_enabled
        AND (plan_status='active' OR (plan_status='trial' AND trial_ends_at > now()))
        AND ($1 OR (report_weekday=$2 AND $3::time >= report_time AND $3::time < report_time + interval '3 hours'))`,
    [force, now.weekday, now.hhmm])).rows;
  for (const a of academies) {
    try { await processAcademy(a, weekStart); }
    catch (e) { console.error('[weekly] academy failed', a.id, e.message); }
  }
}

module.exports = { runWeeklyReports, toTemplateVars, renderPreview, counselTemplateVars, mondayOf, nowKST, buildStats };
