// 학생 질문 1건 처리: 사전필터 → 프롬프트 구성 → Claude 호출(글 + 사진) → 사후검사 → 저장
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt, preFilter, parseModelOutput, postCheck, extractSummary } = require('./prompt');
const { maskPII } = require('../lib/security');
const { getPlan, consumePhoto } = require('../lib/plans');

// 시간제한: 기본 25초(AI_TIMEOUT_MS), 실패 시 SDK가 1번만 다시 시도 → 학생이 최대 약 50초 이상 기다리지 않게
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: Number(process.env.AI_TIMEOUT_MS || 25000), maxRetries: Number(process.env.AI_MAX_RETRIES ?? 1) });
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001'; // Haiku 4.5도 사진(Vision) 입력 지원

// ---- 사진 검증 ----
// 휴대폰에서 긴 변 1568px JPEG로 줄여 보내므로 보통 0.3~0.8MB. 서버는 4MB까지만 받는다(Claude 한도 10MB보다 보수적).
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAGIC = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/webp': (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
};
function parseImage(image) {
  if (!image) return null;
  const mediaType = String(image.mediaType || '');
  if (!MAGIC[mediaType]) throw Object.assign(new Error('사진은 JPG, PNG, WEBP만 올릴 수 있어요'), { status: 400 });
  const data = String(image.base64 || '').replace(/^data:[^,]+,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) throw Object.assign(new Error('사진을 읽을 수 없어요. 다시 찍어 줄래?'), { status: 400 });
  const buf = Buffer.from(data, 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('사진이 너무 커요. 문제 부분만 다시 찍어 줄래?'), { status: 413 });
  // 확장자·MIME만 믿지 않고 파일 앞부분(매직 넘버)으로 실제 이미지인지 확인
  if (buf.length < 64 || !MAGIC[mediaType](buf)) throw Object.assign(new Error('사진 파일이 아니에요'), { status: 400 });
  return { mediaType, buf };
}

// AI 응답을 기다리는 동안 DB 연결을 잡고 있지 않도록 3단계로 나눈다 (2026-10-31 진단 실험 2: 연결 고갈)
//   ① 읽기 + 한도 확인(짧은 DB 작업) → ② Claude 호출(DB 연결 없음) → ③ 저장(짧은 DB 작업, 한 트랜잭션)
// 저장은 AI 답이 온 뒤 한 번에 하므로, AI 오류·시간 초과 때는 이전처럼 아무것도 남지 않는다(사진 횟수도 차감 안 됨).
// db: (fn) => withTenant(학원, fn).  예전처럼 DB client를 넘겨도 동작한다(그때는 한 연결에서 처리).
async function preview(c, fn) { // 실제로 바꾸지 않고 '되는지'만 확인 (한도 검사용)
  await c.query('SAVEPOINT tutor_check');
  try { return await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT tutor_check'); }
}

async function answer(dbOrClient, { academy, cls, student, sessionId, text, wantMoreHint, image, wantSolution = false }) {
  const db = typeof dbOrClient === 'function' ? dbOrClient : (fn) => fn(dbOrClient);
  const img = parseImage(image);
  const typed = String(text || '').trim();
  const clean = maskPII(typed || (img ? '사진 속 문제를 도와주세요' : ''));
  const content = img ? `[사진] ${clean}` : clean;
  // 사진만 보낸 경우 글자 검사는 건너뛰고, 글이 있으면 기존 필터 적용
  const pf = typed || !img ? preFilter(clean) : { block: false };

  // ---------- ① 읽기 ----------
  const ctx = await db(async (client) => {
    const plan = img ? await getPlan(client, academy.plan_code) : null;
    // 사진 한도(라이트: 학원 전체 월 100회) 먼저 확인 — 다 썼으면 AI를 부르지 않고 402 + PHOTO_QUOTA
    if (img) await preview(client, () => consumePhoto(client, academy.id, plan));
    let session = null;
    if (sessionId) {
      session = (await client.query("SELECT * FROM question_sessions WHERE id=$1 AND student_id=$2 AND kind='question'", [sessionId, student.id])).rows[0] || null;
    }
    if (pf.block) return { plan, session };
    const materials = (await client.query(
      'SELECT title, scope_note, content FROM materials WHERE active AND (class_id=$1 OR class_id IS NULL) ORDER BY updated_at DESC LIMIT 3',
      [cls.id])).rows;
    let history = [], lastImg = null, hintsSoFar = 0;
    if (session) {
      // 최근 대화 11개 + 이번 질문 = 12개만 문맥으로 사용 (비용 절감, 오래된 내용 노출 최소화)
      history = (await client.query(
        "SELECT id, role, content FROM messages WHERE session_id=$1 AND role<>'system' ORDER BY id DESC LIMIT 11", [session.id])).rows.reverse();
      // 이 문제(세션)의 가장 최근 사진 1장만 다시 붙인다 → 후속 질문에서도 AI가 문제를 볼 수 있고, 비용은 1장분
      lastImg = (await client.query(
        'SELECT message_id, media_type, data FROM question_images WHERE session_id=$1 ORDER BY id DESC LIMIT 1', [session.id])).rows[0] || null;
      hintsSoFar = (await client.query(
        "SELECT count(*)::int AS n FROM messages WHERE session_id=$1 AND role='ai' AND verdict IN ('hint','hint_leak_blocked')", [session.id])).rows[0].n;
    }
    return { plan, session, materials, history, lastImg, hintsSoFar };
  });

  const hintLevel = ctx.session ? Math.min(4, ctx.session.hint_level + (wantMoreHint && ctx.session.hint_level < 4 ? 1 : 0)) : (wantMoreHint ? 1 : 0);

  // 새 문제 저장 + 학생 질문 저장 (③에서 AI 답과 함께 한 트랜잭션으로)
  async function saveQuestion(client) {
    const photo = img ? await consumePhoto(client, academy.id, ctx.plan) : null;
    let session = ctx.session;
    if (session) {
      // 세션이 그사이 지워졌으면(보관 기간 파기 등) 새 문제로
      session = (await client.query('SELECT * FROM question_sessions WHERE id=$1 AND student_id=$2', [session.id, student.id])).rows[0] || null;
    }
    if (!session) {
      session = (await client.query(
        'INSERT INTO question_sessions (academy_id, student_id, subject) VALUES ($1,$2,$3) RETURNING *',
        [academy.id, student.id, cls.subject])).rows[0];
    }
    if (hintLevel !== session.hint_level && hintLevel > session.hint_level) {
      session.hint_level = hintLevel;
      await client.query('UPDATE question_sessions SET hint_level=$1 WHERE id=$2', [session.hint_level, session.id]);
    }
    const stored = (await client.query(
      'INSERT INTO messages (academy_id, session_id, role, content) VALUES ($1,$2,$3,$4) RETURNING id',
      [academy.id, session.id, 'student', content])).rows[0];
    if (img) {
      await client.query(
        'INSERT INTO question_images (academy_id, session_id, message_id, media_type, bytes, data) VALUES ($1,$2,$3,$4,$5,$6)',
        [academy.id, session.id, stored.id, img.mediaType, img.buf.length, img.buf]);
    }
    return { session, photo };
  }

  if (pf.block) {
    return db(async (client) => {
      const { session, photo } = await saveQuestion(client);
      await client.query('INSERT INTO messages (academy_id, session_id, role, content, verdict) VALUES ($1,$2,$3,$4,$5)',
        [academy.id, session.id, 'ai', pf.reply, pf.verdict || 'blocked_input']);
      return { sessionId: session.id, hintLevel: session.hint_level, reply: pf.reply, photo };
    });
  }

  // ---------- ② Claude 호출 (DB 연결 없음) ----------
  const NEW_ID = '__new__';
  const history = [...ctx.history, { id: NEW_ID, role: 'student', content }];
  const lastImg = img ? { message_id: NEW_ID, media_type: img.mediaType, data: img.buf } : ctx.lastImg;
  let msgs = history.map((h) => {
    const role = h.role === 'student' ? 'user' : 'assistant';
    const body = h.content.replace(/^\[사진\] /, '');
    if (lastImg && String(h.id) === String(lastImg.message_id)) {
      return { role, content: [
        { type: 'image', source: { type: 'base64', media_type: lastImg.media_type, data: lastImg.data.toString('base64') } },
        { type: 'text', text: body },
      ] };
    }
    return { role, content: body };
  });
  // Claude 대화는 학생(user) 차례로 시작해야 한다 → 잘린 기록의 앞쪽 AI 답변 제거
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  // 잘려서 사진이 빠졌다면 첫 질문 앞에 사진을 다시 붙임
  if (lastImg && !msgs.some((m) => Array.isArray(m.content))) {
    const first = msgs[0];
    first.content = [
      { type: 'image', source: { type: 'base64', media_type: lastImg.media_type, data: lastImg.data.toString('base64') } },
      { type: 'text', text: typeof first.content === 'string' ? first.content : '' },
    ];
  }

  const keyHint = academy.teaching_mode === 'key_hint';
  // 완성 풀이 공개 조건(핵심 힌트형): 이 문제에서 힌트를 한 번 이상 받은 뒤 → 학생이 막혀서 포기하지 않게 바로 보여 줌
  const hintsSoFar = ctx.hintsSoFar;
  const solutionUnlocked = keyHint && hintsSoFar >= 1;
  // 학생이 막혔다는 신호: 📖 완성 풀이 보기 버튼(확실) 또는 "모르겠어/포기/풀이 보여 줘" 같은 말
  const GIVE_UP = /(모르겠|몰라|포기|어려워|못\s*풀|막혔|(완성\s*)?풀이\s*(좀\s*)?(보여|알려|줘)|답\s*(좀\s*)?(보여|알려))/;
  const forceSolution = solutionUnlocked && wantSolution;            // 버튼: AI 표시와 상관없이 완성 풀이로 처리
  const stuck = solutionUnlocked && (wantSolution || GIVE_UP.test(clean));
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: keyHint ? 1200 : 600,   // 핵심 힌트형은 3칸(퀴즈·흐름·단서) + 요약을 쓰므로 길게
    temperature: 0.4,
    system: buildSystemPrompt({ academy, cls, student, materials: ctx.materials, hintLevel, hasImage: !!lastImg, solutionUnlocked, forceSolution }),
    messages: msgs,
  });
  const raw = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const { summary } = extractSummary(raw);
  // 정답 노출 검사: 핵심 힌트형은 학생이 직접 쓴 답·풀이·오답노트(숫자·식·사진)를 확인하는 [CHECK] 답변에서만 정답을 말해도 된다.
  // "최종 풀이 적어 주세요"처럼 학생 풀이 없이 [CHECK]로 완성 풀이를 주는 경우는 막는다.
  // [SOLUTION](완성 풀이)은 공개 조건을 만족할 때만 그대로 보내고, 아니면 힌트로 보고 정답 노출을 가린다
  let parsed = parseModelOutput(raw);
  if (parsed.verdict === 'solution' && !solutionUnlocked) parsed = { ...parsed, verdict: 'hint' };
  // 버튼을 눌렀으면 AI가 [SOLUTION] 표시를 빠뜨려도 완성 풀이로 본다 (안전 신호는 그대로 우선)
  if (forceSolution && parsed.verdict !== 'safety' && parsed.verdict !== 'refuse_offtopic') parsed = { ...parsed, verdict: 'solution' };
  // "모르겠어" 등으로 막혔다고 한 뒤 AI가 [HINT]로 표시했지만 실제로 풀이·답을 준 경우도 막지 않는다 (힌트를 이미 받은 문제라 공개 허용)
  if (stuck && parsed.verdict === 'hint' && /가리고[\s\S]{0,30}다시\s*써/.test(parsed.text)) parsed = { ...parsed, verdict: 'solution' };
  if (parsed.verdict === 'solution') parsed = { ...parsed, hint2: null };
  const ownWork = !!img || /[0-9=]/.test(clean || '');
  const out = parsed.verdict === 'solution' || (stuck && parsed.verdict === 'hint') || (keyHint && parsed.verdict === 'check' && ownWork)
    ? parsed : postCheck(parsed, keyHint ? 0 : hintLevel);

  // ---------- ③ 저장 (한 트랜잭션) ----------
  return db(async (client) => {
    const { session, photo } = await saveQuestion(client);
    if (out.verdict === 'solution') await client.query('UPDATE question_sessions SET solution_shown=true WHERE id=$1', [session.id]);

    const saved = (await client.query(
      'INSERT INTO messages (academy_id, session_id, role, content, verdict) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      // 접어 둔 힌트 2도 대화 기록에는 함께 남긴다 (다음 답변에서 튜터가 이미 준 힌트를 알 수 있게, 원장님 모니터링용)
      [academy.id, session.id, 'ai', out.text
         + (out.hint2 ? `\n\n[🔑 결정적 힌트 · 접어 둠]\n${out.hint2}` : '')
         + (out.graph ? `\n\n[📈 그래프 보여 줌: ${[...out.graph.series.map((g) => g.label), ...out.graph.points.map((pt) => pt.label || `(${pt.x}, ${pt.y})`)].join(', ')}]` : ''),
       out.leaked ? 'hint_leak_blocked' : out.verdict])).rows[0];

    if (out.topic) await client.query('UPDATE question_sessions SET topic=COALESCE(topic,$1) WHERE id=$2', [out.topic, session.id]);
    // 학생에게 보이지 않는 요약(막힌 부분·코칭 메모·학부모 칭찬 한 줄) → 원장님 화면과 금요일 상담글 초안에 사용
    // hint2_opened는 튜터가 아니라 시스템이 기록한 값(학생이 실제로 펼쳤는지)을 그대로 이어 붙인다
    if (summary) await client.query("UPDATE question_sessions SET summary = $1::jsonb || jsonb_build_object('hint2_opened', hint2_opened, 'solution_shown', solution_shown) WHERE id=$2", [JSON.stringify(summary), session.id]);
    if (out.verdict === 'safety') {
      await client.query("UPDATE question_sessions SET status='flagged' WHERE id=$1", [session.id]);
      await client.query('INSERT INTO safety_flags (academy_id, student_id, message_id, category) VALUES ($1,$2,$3,$4)',
        [academy.id, student.id, saved.id, 'wellbeing']);
    }
    return { sessionId: session.id, hintLevel: session.hint_level, reply: out.text, hint2: out.hint2 || null, graph: out.graph || null, safety: out.verdict === 'safety',
      solutionShown: out.verdict === 'solution', solutionAvailable: keyHint && out.verdict !== 'solution' && (hintsSoFar >= 1 || out.verdict === 'hint'), withImage: !!img, photo,
      teachingMode: keyHint ? 'key_hint' : 'hint_ladder' };
  });
}

module.exports = { answer, parseImage, MAX_IMAGE_BYTES };
