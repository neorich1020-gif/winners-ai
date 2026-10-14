// =====================================================================
// 원장 대시보드 > 주간 상담·리포트 관리 API  (/api/director/counsel)
//  GET    /                     이번 주 학생 표 (입력값, 상담글, 상태, AI 질문 통계, 수신 동의)
//  PUT    /:studentId           표 한 줄 저장 (과목, 학습 상태/진도, 수업 태도/특이사항)
//  POST   /:studentId/generate  원장님 말투 상담글 AI 초안 생성
//  PUT    /:studentId/text      본문 직접 수정 (승인 상태였다면 draft로 되돌림)
//  POST   /:studentId/approve   승인 → 금요일 발송 대기
//  POST   /:studentId/unapprove 승인 취소
//  POST   /bulk/generate        키워드가 있고 초안이 없는 학생 일괄 생성 (동시 3건)
//  POST   /bulk/approve         초안 상태 전체 승인
// =====================================================================
const express = require('express');
const { withTenant, audit } = require('../lib/db');
const { requireAuth } = require('../lib/security');
const { generateCounsel, reviewCounsel, MAX_CHARS } = require('../ai/counsel');
const { courseFor } = require('../lib/curriculum');
const { buildStats, mondayOf, nowKST } = require('../jobs/weeklyReport');

const r = express.Router();
r.use(requireAuth('staff'));
const T = (req, fn) => withTenant(req.user.aid, fn);
// 학생 ID 형식이 아니면 DB까지 가지 않고 404
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
r.param('studentId', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ error: '학생을 찾을 수 없습니다' })));

// 이번 주 발송 창(지정 시각 + 3시간)이 이미 지났으면 다음 주 상담글을 쓰도록 안내
function targetWeek(academy, override) {
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return mondayOf(override);
  const now = nowKST();
  const week = mondayOf(now.date);
  const sendDate = new Date(week + 'T00:00:00Z');
  sendDate.setUTCDate(sendDate.getUTCDate() + ((academy.report_weekday + 6) % 7));
  const [h, m] = String(academy.report_time).split(':').map(Number);
  const windowEnd = sendDate.getTime() + ((h + 3) * 60 + m) * 60e3;            // KST 기준 ms
  const nowMs = Date.parse(now.date + 'T' + now.hhmm + ':00Z');
  if (nowMs < windowEnd) return week;
  const next = new Date(week + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + 7);
  return next.toISOString().slice(0, 10);
}
function sendAtLabel(academy, week) {
  const d = new Date(week + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((academy.report_weekday + 6) % 7));
  return `${d.toISOString().slice(0, 10)} ${String(academy.report_time).slice(0, 5)}`;
}

async function loadAcademy(c, aid) {
  return (await c.query('SELECT * FROM academies WHERE id=$1', [aid])).rows[0];
}
async function getOrCreateNote(c, aid, studentId, week) {
  const st = (await c.query('SELECT id, nickname FROM students WHERE id=$1 AND active', [studentId])).rows[0];
  if (!st) throw Object.assign(new Error('학생을 찾을 수 없습니다'), { status: 404 });
  const note = (await c.query(
    `INSERT INTO counsel_notes (academy_id, student_id, week_start) VALUES ($1,$2,$3)
     ON CONFLICT (student_id, week_start) DO UPDATE SET student_id=EXCLUDED.student_id RETURNING *`,
    [aid, studentId, week])).rows[0];
  return { st, note };
}
const locked = (n) => n.status === 'sent';

// ---------- 표 조회 ----------
r.get('/', async (req, res, next) => {
  try {
    res.json(await T(req, async (c) => {
      const academy = await loadAcademy(c, req.user.aid);
      const week = targetWeek(academy, req.query.week);
      const rows = (await c.query(
        `SELECT s.id AS student_id, s.nickname, cl.name AS class_name, cl.subject AS class_subject,
                n.id AS note_id, n.subject, n.progress, n.attitude, n.final_text, n.status, n.gen_count, n.approved_at, n.sent_at,
                bool_or(g.consent_report_at IS NOT NULL AND g.consent_privacy_at IS NOT NULL AND NOT g.report_opt_out) AS can_send,
                count(g.id)::int AS guardians,
                max(w.status) FILTER (WHERE w.week_start=$1) AS delivery_status
           FROM students s
           LEFT JOIN classes cl ON cl.id = s.class_id
           LEFT JOIN counsel_notes n ON n.student_id = s.id AND n.week_start = $1
           LEFT JOIN guardians g ON g.student_id = s.id
           LEFT JOIN weekly_reports w ON w.guardian_id = g.id AND w.week_start = $1
          WHERE s.active
          GROUP BY s.id, cl.id, n.id
          ORDER BY cl.name, s.nickname`, [week])).rows;
      // AI 질문창 통계를 '이번 주 학습 상태' 칸 옆 참고 칩으로 제공
      for (const row of rows) row.ai_stats = await buildStats(req.user.aid, row.student_id, week, c);
      const count = (s) => rows.filter((x) => (x.status || 'empty') === s).length;
      return {
        week, sendAt: sendAtLabel(academy, week), statsFallback: academy.stats_fallback, maxChars: MAX_CHARS,
        summary: { empty: count('empty'), draft: count('draft'), approved: count('approved'), sent: count('sent'), failed: count('failed') },
        rows,
      };
    }));
  } catch (e) { next(e); }
});

// ---------- 일괄 처리 ----------
// 주의: /:studentId 경로보다 먼저 등록해야 "bulk"가 학생 ID로 잘못 해석되지 않는다
r.post('/bulk/generate', async (req, res, next) => {
  try {
    const academy = await T(req, (c) => loadAcademy(c, req.user.aid));
    const week = targetWeek(academy, req.body?.week);
    const ids = await T(req, async (c) => (await c.query(
      `SELECT student_id FROM counsel_notes WHERE week_start=$1 AND status='empty'
         AND (length(trim(progress))>0 OR length(trim(attitude))>0)`, [week])).rows.map((x) => x.student_id));
    const results = [];
    for (let i = 0; i < ids.length; i += 3) {                       // 동시 3건씩 (API 속도 제한 여유)
      const chunk = ids.slice(i, i + 3);
      results.push(...await Promise.all(chunk.map((sid) =>
        T(req, (c) => generateOne(c, req.user.aid, req.user.sub, sid, week)).catch((e) => ({ studentId: sid, error: e.message })))));
    }
    res.json({ week, generated: results.filter((x) => !x.error).length, results });
  } catch (e) { next(e); }
});
r.post('/bulk/approve', async (req, res, next) => {
  try {
    res.json(await T(req, async (c) => {
      const academy = await loadAcademy(c, req.user.aid);
      const week = targetWeek(academy, req.body?.week);
      const r2 = await c.query(
        `UPDATE counsel_notes SET status='approved', approved_by=$2, approved_at=now()
          WHERE week_start=$1 AND status='draft' AND length(trim(final_text))>0 AND char_length(final_text) <= $3`,
        [week, req.user.sub, MAX_CHARS]);
      await audit(c, { academyId: req.user.aid, actor: `staff:${req.user.sub}`, action: 'counsel_bulk_approve', target: week, ip: req.ip });
      return { approved: r2.rowCount, sendAt: sendAtLabel(academy, week) };
    }));
  } catch (e) { next(e); }
});

// ---------- 한 줄 저장 ----------
r.put('/:studentId', async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await T(req, async (c) => {
      const academy = await loadAcademy(c, req.user.aid);
      const { note } = await getOrCreateNote(c, req.user.aid, req.params.studentId, targetWeek(academy, b.week));
      if (locked(note)) throw Object.assign(new Error('이미 발송된 상담글은 바꿀 수 없습니다'), { status: 409 });
      return (await c.query(
        `UPDATE counsel_notes SET subject=$2, progress=$3, attitude=$4, updated_at=now() WHERE id=$1
         RETURNING id, subject, progress, attitude, status`,
        [note.id, String(b.subject || '').slice(0, 30), String(b.progress || '').slice(0, 500), String(b.attitude || '').slice(0, 500)])).rows[0];
    }));
  } catch (e) { next(e); }
});

// ---------- AI 초안 생성 ----------
async function generateOne(c, aid, staffId, studentId, week) {
  const academy = await loadAcademy(c, aid);
  const wk = week || targetWeek(academy);
  const { st, note } = await getOrCreateNote(c, aid, studentId, wk);
  if (locked(note)) throw Object.assign(new Error('이미 발송된 상담글입니다'), { status: 409 });
  const stats = await buildStats(aid, studentId, wk, c);
  // 반에 정해 둔 이번 달(분기) 학습 코스 → 상담글의 "다음 주 계획" 재료
  const cls = (await c.query('SELECT cl.subject, cl.course_grade, cl.course_mode, cl.course_pin FROM students s JOIN classes cl ON cl.id=s.class_id WHERE s.id=$1', [studentId])).rows[0];
  const course = cls ? courseFor({ subject: cls.subject, grade: cls.course_grade, mode: cls.course_mode, pin: cls.course_pin }) : null;
  const { text, warnings } = await generateCounsel({ academy, student: st, note, stats, course });
  await c.query(
    `UPDATE counsel_notes SET draft_text=$2, final_text=$2, status='draft', gen_count=gen_count+1,
            approved_at=NULL, approved_by=NULL, updated_at=now() WHERE id=$1`, [note.id, text]);
  await audit(c, { academyId: aid, actor: `staff:${staffId}`, action: 'counsel_generate', target: note.id });
  return { studentId, text, warnings, status: 'draft' };
}
r.post('/:studentId/generate', async (req, res, next) => {
  try { res.json(await T(req, (c) => generateOne(c, req.user.aid, req.user.sub, req.params.studentId, req.body?.week))); }
  catch (e) { next(e); }
});

// ---------- 직접 수정 ----------
r.put('/:studentId/text', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    res.json(await T(req, async (c) => {
      const academy = await loadAcademy(c, req.user.aid);
      const { note } = await getOrCreateNote(c, req.user.aid, req.params.studentId, targetWeek(academy, req.body?.week));
      if (locked(note)) throw Object.assign(new Error('이미 발송된 상담글입니다'), { status: 409 });
      const wasApproved = note.status === 'approved';
      await c.query(
        `UPDATE counsel_notes SET final_text=$2, status=$3, approved_at=NULL, approved_by=NULL, updated_at=now() WHERE id=$1`,
        [note.id, text, text ? 'draft' : 'empty']);
      return { status: text ? 'draft' : 'empty', needsReapproval: wasApproved, warnings: text ? reviewCounsel(text, note) : [] };
    }));
  } catch (e) { next(e); }
});

// ---------- 승인 / 취소 ----------
r.post('/:studentId/approve', async (req, res, next) => {
  try {
    res.json(await T(req, async (c) => {
      const academy = await loadAcademy(c, req.user.aid);
      const { note } = await getOrCreateNote(c, req.user.aid, req.params.studentId, targetWeek(academy, req.body?.week));
      if (!note.final_text?.trim()) throw Object.assign(new Error('승인할 상담글이 없습니다'), { status: 400 });
      if ([...note.final_text].length > MAX_CHARS) throw Object.assign(new Error(`${MAX_CHARS}자 이하로 줄여 주세요`), { status: 400 });
      if (locked(note)) throw Object.assign(new Error('이미 발송되었습니다'), { status: 409 });
      await c.query("UPDATE counsel_notes SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1", [note.id, req.user.sub]);
      await audit(c, { academyId: req.user.aid, actor: `staff:${req.user.sub}`, action: 'counsel_approve', target: note.id, ip: req.ip });
      return { status: 'approved', sendAt: sendAtLabel(academy, targetWeek(academy, req.body?.week)) };
    }));
  } catch (e) { next(e); }
});
r.post('/:studentId/unapprove', async (req, res, next) => {
  try {
    res.json(await T(req, async (c) => {
      const academy = await loadAcademy(c, req.user.aid);
      const { note } = await getOrCreateNote(c, req.user.aid, req.params.studentId, targetWeek(academy, req.body?.week));
      if (note.status !== 'approved') return { status: note.status };
      await c.query("UPDATE counsel_notes SET status='draft', approved_by=NULL, approved_at=NULL WHERE id=$1", [note.id]);
      return { status: 'draft' };
    }));
  } catch (e) { next(e); }
});

// ---------- 원장님 휴대폰으로 테스트 발송 (실제 알림톡 1건, 학부모님께는 안 감) ----------
const testLimiter = require('express-rate-limit').rateLimit({ windowMs: 60 * 60e3, limit: 10 });
r.post('/:studentId/test-send', testLimiter, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.studentId)) throw Object.assign(new Error('없는 학생이에요'), { status: 404 });
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (!/^01\d{8,9}$/.test(phone)) throw Object.assign(new Error('받을 휴대폰 번호를 확인해 주세요'), { status: 400 });
    const { unifiedVars, sendTest, UNIFIED, buildStats } = require('../jobs/weeklyReport');
    const out = await T(req, async (c) => {
      const academy = await loadAcademy(c, req.user.aid);
      const week = targetWeek(academy, req.body?.week);
      const t = (await c.query(`SELECT s.id AS student_id, s.nickname, cl.subject, cl.course_grade, cl.course_mode, cl.course_pin
                                  FROM students s LEFT JOIN classes cl ON cl.id=s.class_id WHERE s.id=$1`, [req.params.studentId])).rows[0];
      if (!t) throw Object.assign(new Error('없는 학생이에요'), { status: 404 });
      const n = (await c.query('SELECT * FROM counsel_notes WHERE student_id=$1 AND week_start=$2', [t.student_id, week])).rows[0];
      const note = n && String(n.final_text || '').trim() ? n : null;
      const stats = await buildStats(req.user.aid, t.student_id, week, c);
      const course = courseFor({ subject: t.subject, grade: t.course_grade, mode: t.course_mode, pin: t.course_pin });
      return { ...unifiedVars(academy, t, { note, stats, course, weekStart: week }), kind: note ? 'counsel' : 'stats' };
    });
    const r2 = await sendTest({ phone, templateId: UNIFIED(), vars: out.vars, preview: out.preview });
    res.json({ ok: true, kind: out.kind, preview: out.preview, messageId: r2.messageId });
  } catch (e) {
    if (e.status) return next(e);
    next(Object.assign(new Error(`솔라피 발송 실패: ${String(e.message).slice(0, 160)}`), { status: 400 }));
  }
});

module.exports = { router: r, targetWeek, sendAtLabel };
