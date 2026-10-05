// 학생 질문 1건 처리: 사전필터 → 프롬프트 구성 → Claude 호출(글 + 사진) → 사후검사 → 저장
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt, preFilter, parseModelOutput, postCheck } = require('./prompt');
const { maskPII } = require('../lib/security');
const { getPlan, consumePhoto } = require('../lib/plans');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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

async function answer(client, { academy, cls, student, sessionId, text, wantMoreHint, image }) {
  const img = parseImage(image);
  // 사진 질문 횟수 차감 (라이트: 학원 전체 월 100회). 다 쓰면 402 + PHOTO_QUOTA → 학생 화면에 업그레이드 안내 팝업
  let photo = null;
  if (img) photo = await consumePhoto(client, academy.id, await getPlan(client, academy.plan_code));
  const typed = String(text || '').trim();
  const clean = maskPII(typed || (img ? '사진 속 문제를 도와주세요' : ''));

  // 세션 확보 (없으면 새 문제로 시작). 사진은 보통 새 문제이므로 sessionId가 없으면 새 세션.
  let session;
  if (sessionId) {
    session = (await client.query('SELECT * FROM question_sessions WHERE id=$1 AND student_id=$2', [sessionId, student.id])).rows[0];
  }
  if (!session) {
    session = (await client.query(
      'INSERT INTO question_sessions (academy_id, student_id, subject) VALUES ($1,$2,$3) RETURNING *',
      [academy.id, student.id, cls.subject])).rows[0];
  }
  if (wantMoreHint && session.hint_level < 4) {
    session.hint_level += 1;
    await client.query('UPDATE question_sessions SET hint_level=$1 WHERE id=$2', [session.hint_level, session.id]);
  }

  const stored = (await client.query(
    'INSERT INTO messages (academy_id, session_id, role, content) VALUES ($1,$2,$3,$4) RETURNING id',
    [academy.id, session.id, 'student', img ? `[사진] ${clean}` : clean])).rows[0];
  if (img) {
    await client.query(
      'INSERT INTO question_images (academy_id, session_id, message_id, media_type, bytes, data) VALUES ($1,$2,$3,$4,$5,$6)',
      [academy.id, session.id, stored.id, img.mediaType, img.buf.length, img.buf]);
  }

  // 사진만 보낸 경우 글자 검사는 건너뛰고, 글이 있으면 기존 필터 적용
  const pf = typed || !img ? preFilter(clean) : { block: false };
  if (pf.block) {
    await client.query('INSERT INTO messages (academy_id, session_id, role, content, verdict) VALUES ($1,$2,$3,$4,$5)',
      [academy.id, session.id, 'ai', pf.reply, pf.verdict || 'blocked_input']);
    return { sessionId: session.id, hintLevel: session.hint_level, reply: pf.reply, photo };
  }

  const materials = (await client.query(
    'SELECT title, scope_note, content FROM materials WHERE active AND (class_id=$1 OR class_id IS NULL) ORDER BY updated_at DESC LIMIT 3',
    [cls.id])).rows;

  // 최근 대화 12개만 문맥으로 사용 (비용 절감, 오래된 내용 노출 최소화)
  const history = (await client.query(
    "SELECT id, role, content FROM messages WHERE session_id=$1 AND role<>'system' ORDER BY id DESC LIMIT 12", [session.id])).rows.reverse();
  // 이 문제(세션)의 가장 최근 사진 1장만 다시 붙인다 → 후속 질문에서도 AI가 문제를 볼 수 있고, 비용은 1장분
  const lastImg = (await client.query(
    'SELECT message_id, media_type, data FROM question_images WHERE session_id=$1 ORDER BY id DESC LIMIT 1', [session.id])).rows[0];

  let msgs = history.map((h) => {
    const role = h.role === 'student' ? 'user' : 'assistant';
    const content = h.content.replace(/^\[사진\] /, '');
    if (lastImg && String(h.id) === String(lastImg.message_id)) {
      return { role, content: [
        { type: 'image', source: { type: 'base64', media_type: lastImg.media_type, data: lastImg.data.toString('base64') } },
        { type: 'text', text: content },
      ] };
    }
    return { role, content };
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

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    temperature: 0.4,
    system: buildSystemPrompt({ academy, cls, student, materials, hintLevel: session.hint_level, hasImage: !!lastImg }),
    messages: msgs,
  });
  const raw = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const out = postCheck(parseModelOutput(raw), session.hint_level);

  const saved = (await client.query(
    'INSERT INTO messages (academy_id, session_id, role, content, verdict) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [academy.id, session.id, 'ai', out.text, out.leaked ? 'hint_leak_blocked' : out.verdict])).rows[0];

  if (out.topic) await client.query('UPDATE question_sessions SET topic=COALESCE(topic,$1) WHERE id=$2', [out.topic, session.id]);
  if (out.verdict === 'safety') {
    await client.query("UPDATE question_sessions SET status='flagged' WHERE id=$1", [session.id]);
    await client.query('INSERT INTO safety_flags (academy_id, student_id, message_id, category) VALUES ($1,$2,$3,$4)',
      [academy.id, student.id, saved.id, 'wellbeing']);
  }
  return { sessionId: session.id, hintLevel: session.hint_level, reply: out.text, safety: out.verdict === 'safety', withImage: !!img, photo };
}

module.exports = { answer, parseImage, MAX_IMAGE_BYTES };
