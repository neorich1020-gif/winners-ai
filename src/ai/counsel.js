// =====================================================================
// 원장님 말투 '주간 상담글' 생성
// 입력: 원장님 키워드(과목, 이번 주 학습 상태/진도, 수업 태도/특이사항)
//     + 학생 AI 질문창의 이번 주 통계(자동)
//     + 원장님 말투 설정(persona_style, persona_examples, counsel_tone, 서명)
// 출력: 학부모님께 보내는 400~700자 카카오톡 상담 메시지 초안
// 원칙: 원장님이 적지 않은 사실은 지어내지 않는다. 최종 발송은 원장님 승인 후에만.
// =====================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { maskPII } = require('../lib/security');
const { feedbackLine } = require('./feedback');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.AI_REPORT_MODEL || process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

const MAX_CHARS = Number(process.env.COUNSEL_MAX_CHARS || 800); // 알림톡 1건 1,000자 한도 - 머리말·서명 여유
const MAX_GEN_PER_NOTE = 5;                                       // 학생 1명·1주 재생성 한도 (비용 상한)

function notesLine(n) {
  if (!n) return '';
  return [
    n.weakness.length ? `튜터 대화에서 막혔던 부분: ${n.weakness.join(' / ')}` : '',
    n.wrongNotes ? `오답노트 작성 지시 ${n.wrongNotes}회` : '',
    n.director.length ? `튜터 코칭 메모(원장님 참고): ${n.director.join(' / ')}` : '',
    n.cheering.length ? `칭찬 포인트: ${n.cheering[0]}` : '',
  ].filter(Boolean).join('\n');
}

function statsLine(s) {
  const fb = [feedbackLine(s?.feedback), notesLine(s?.notes)].filter(Boolean).join('\n');
  if (!s || !s.questions) return ['이번 주 AI 질문창 이용 기록 없음', fb].filter(Boolean).join('\n');
  const rate = Math.round((s.solved / s.questions) * 100);
  return [
    `학습일 ${s.days}일, 질문한 문제 ${s.questions}개, 스스로 해결 ${rate}%, 평균 힌트 ${s.avg_hint}단계`,
    s.topics?.length ? `질문한 단원: ${s.topics.join(', ')}` : '',
    s.weak?.length ? `힌트를 많이 받은 단원: ${s.weak.join(', ')}` : '',
    s.strong?.length ? `거의 혼자 해결한 단원: ${s.strong.join(', ')}` : '',
    fb,
  ].filter(Boolean).join('\n');
}

function buildCounselPrompt({ academy, student, note, stats }) {
  return `
당신은 "${academy.name}" ${academy.director_name} 원장님을 대신해, 학부모님께 보낼 주간 상담 카카오톡 메시지의 "초안"을 씁니다.
원장님이 읽고 고친 뒤 승인해야 발송되므로, 원장님이 그대로 보내도 될 만큼 자연스럽게 쓰되 원장님이 준 사실만 사용하세요.

# 원장님 말투
${academy.counsel_tone}
${academy.persona_style ? `평소 성격·말버릇: ${academy.persona_style}` : ''}
${academy.persona_examples ? `원장님이 자주 쓰는 표현(분위기만 참고, 학생에게 쓰는 반말은 학부모님용 존댓말로 바꿀 것):\n${academy.persona_examples}` : ''}

# 학생
- 호칭: ${student.nickname} (성은 붙이지 말고 "${student.nickname}이/가" 또는 "${student.nickname} 학생"으로)
- 과목: ${note.subject || '(미입력)'}

# 원장님이 적은 이번 주 키워드
- 학습 상태/진도: ${maskPII(note.progress) || '(미입력)'}
- 수업 태도/특이사항: ${maskPII(note.attitude) || '(미입력)'}

# AI 질문창·첨삭 자동 기록 (참고용, 숫자는 꼭 필요할 때만 1~2개)
# 튜터 대화 요약이 있으면 "막혔던 부분"은 보완 계획으로, "칭찬 포인트"는 칭찬 문단에 자연스럽게 녹이고, "코칭 메모"는 그대로 옮기지 말고 학원의 다음 주 계획 문장으로 바꿔 쓴다.
# 첨삭 기록이 있으면 "자주 나온 실수 유형"과 "스스로 고친 것"을 한 문장으로 자연스럽게 넣는다(실수형/개념형 판단이 있으면 학원 계획과 연결).
${statsLine(stats)}

# 쓰는 법
1. 구성: 짧은 인사 → 이번 주 학습 내용과 진도 → 수업 태도에서 칭찬할 점(구체적으로) → 보완할 점과 학원에서의 계획 → 가정에서 도와주실 한 가지 → 마무리 인사.
2. 길이: 공백 포함 400~700자. 문단 사이는 빈 줄 하나. 카카오톡에서 읽기 편하게 한 문단 2~3문장.
3. 학부모님께는 정중한 존댓말("어머님, 아버님" 대신 "학부모님" 또는 "${student.nickname} 학부모님").
4. 부족한 점은 비난이 아니라 "이렇게 도와주겠다"는 계획으로 쓴다.

# 지키지 않으면 안 되는 것
- 키워드와 자동 기록에 없는 사실(점수, 등수, 시험 결과, 가정사, 건강, 다른 학생 이야기)을 지어내지 않는다.
- 진단·병명·심리 상태 단정("ADHD 같다", "우울해 보인다") 금지. 걱정되는 점은 "상담 전화로 말씀 나누고 싶다"로 바꾼다.
- 성적 향상을 약속하지 않는다. 다른 학생과 비교하지 않는다.
- 반 모집, 할인, 이벤트, 친구 추천 같은 홍보 문구 금지(알림톡 정보성 규정).
- 이모지는 쓰지 않거나 1개 이하. 머리말("[학원명] OO 학생 주간 상담")과 서명은 쓰지 않는다(시스템이 붙임).

본문만 출력하세요.
`.trim();
}

// 사후 검사: 금지 표현·길이·지어낸 숫자 의심을 원장님 화면에 '확인 필요'로 띄운다 (자동 수정은 하지 않음)
const AD_WORDS = /(할인|이벤트|모집|등록\s*시|친구\s*추천|무료\s*체험|선착순|특가)/;
const DIAG_WORDS = /(ADHD|우울증|불안장애|자폐|학습장애|난독증|틱\s*장애)/i;
const RANK_WORDS = /(\d+\s*등|상위\s*\d+\s*%|반에서\s*(가장|제일))/;

function reviewCounsel(text, note) {
  const warnings = [];
  const len = [...text].length;
  if (len > MAX_CHARS) warnings.push(`글자 수 ${len}자: 알림톡 한도를 위해 ${MAX_CHARS}자 이하로 줄여 주세요.`);
  if (len < 150) warnings.push('내용이 너무 짧습니다. 키워드를 조금 더 적어 주세요.');
  if (AD_WORDS.test(text)) warnings.push('홍보성 표현이 있어 알림톡 발송이 거절될 수 있습니다.');
  if (DIAG_WORDS.test(text)) warnings.push('진단처럼 읽히는 표현이 있습니다. 직접 상담으로 돌려 주세요.');
  if (RANK_WORDS.test(text)) warnings.push('등수·비교 표현이 있습니다. 원장님이 적은 내용인지 확인해 주세요.');
  // 키워드에 없는 '점'수 숫자가 등장하면 지어냈을 가능성
  const scores = text.match(/\d+\s*점/g) || [];
  const given = `${note.progress} ${note.attitude}`;
  if (scores.some((s) => !given.includes(s.replace(/\s/g, '')))) warnings.push('키워드에 없는 점수가 들어갔습니다. 사실인지 확인해 주세요.');
  return warnings;
}

async function generateCounsel({ academy, student, note, stats }) {
  if (note.gen_count >= MAX_GEN_PER_NOTE) {
    throw Object.assign(new Error('이번 주 이 학생의 상담글 생성 횟수를 모두 썼습니다. 직접 수정해 주세요.'), { status: 429 });
  }
  if (!note.progress.trim() && !note.attitude.trim()) {
    throw Object.assign(new Error('학습 상태나 수업 태도 중 하나는 적어 주세요.'), { status: 400 });
  }
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    temperature: 0.7,
    system: buildCounselPrompt({ academy, student, note, stats }),
    messages: [{ role: 'user', content: '이번 주 상담글 초안을 써 주세요.' }],
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { text, warnings: reviewCounsel(text, note) };
}

// 발송 직전 최종 본문 = 머리말 없이 본문 + 서명 (머리말은 알림톡 템플릿에 고정)
function withSignature(academy, text) {
  const sign = academy.counsel_signature || `${academy.name} ${academy.director_name} 드림`;
  return `${text.trim()}\n\n${sign}`;
}

module.exports = { buildCounselPrompt, reviewCounsel, generateCounsel, withSignature, statsLine, MAX_CHARS };
