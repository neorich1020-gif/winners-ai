// =====================================================================
// 원장님 말투 '주간 상담글' 생성
// 입력: 원장님 키워드(과목, 이번 주 학습 상태/진도, 수업 태도/특이사항)
//     + 학생 AI 질문창의 이번 주 통계(자동)
//     + 원장님 말투 설정(persona_style, persona_examples, counsel_tone, 서명)
// 출력: 학부모님께 보내는 400자 이내 카카오톡 상담 메시지 초안 (원장님이 직접 쓴 듯한 따뜻한 말투)
// 원칙: 원장님이 적지 않은 사실은 지어내지 않는다. 최종 발송은 원장님 승인 후에만.
// =====================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { maskPII } = require('../lib/security');
const { feedbackLine } = require('./feedback');
const { courseLine } = require('../lib/curriculum');

const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// 리포트용 모델(AI_REPORT_MODEL)이 안 되면(모델 이름 오류·권한·과부하) 학생 질문창에서 쓰는 기본 모델로 한 번 더 시도
const FALLBACK_MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const anthropic = { messages: { create: async (args) => {
  try { return await anthropicClient.messages.create(args); }
  catch (e) {
    if (args.model === FALLBACK_MODEL || e.status === 401 || /credit|balance|billing/i.test(String(e.message))) throw e;
    console.error('[ai] 모델', args.model, '실패 → 기본 모델로 재시도:', e.status, String(e.message).slice(0, 200));
    return anthropicClient.messages.create({ ...args, model: FALLBACK_MODEL });
  }
} } };
const MODEL = process.env.AI_REPORT_MODEL || process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

const MAX_CHARS = Number(process.env.COUNSEL_MAX_CHARS || 400); // 원장님 요청: 학부모님이 카톡 한 화면에 읽을 수 있게 400자 이내
const MAX_GEN_PER_NOTE = 5;                                       // 학생 1명·1주 재생성 한도 (비용 상한)

function notesLine(n) {
  if (!n) return '';
  return [
    n.weakness.length ? `튜터 대화에서 막혔던 부분: ${n.weakness.join(' / ')}` : '',
    n.wrongNotes ? `오답노트 작성 지시 ${n.wrongNotes}회` : '',
    n.problems ? `결정적 힌트 없이 흐름만으로 푼 문제 ${n.problems - (n.hint2Opened || 0)}개 / 결정적 힌트를 펼쳐 본 문제 ${n.hint2Opened || 0}개` : '',
    n.solutionShown ? `막혔을 때 완성 풀이를 보고 혼자 다시 써 보기로 이어간 문제 ${n.solutionShown}개` : '',
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

function buildCounselPrompt({ academy, student, note, stats, course }) {
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

${course ? `# 이번 달 학원 학습 코스 (학원 계획이라 사실로 써도 됨, 필요할 때 한 번만 자연스럽게)
${courseLine(course)} / 목표: ${course.focus}
` : ''}
# 쓰는 법 — "원장님이 휴대폰으로 직접 쓴 카톡"처럼
1. 길이: 공백 포함 250~380자. 절대 400자를 넘기지 않는다. 문단 3개 이하, 문단 사이 빈 줄 하나.
2. 흐름: 짧은 인사 → 이번 주 ${student.nickname}의 구체적인 한 장면(칭찬) → 보완할 점과 다음 주 학원 계획 → 가정에서 도와주실 한 가지 → 짧은 마무리.
   다 넣으려고 하지 말고, 이번 주에 가장 전하고 싶은 이야기 1~2개만 고른다.
3. 말투: 원장님이 직접 아이를 지켜본 사람으로서 1인칭("제가", "저희 학원에서")으로, 따뜻하고 담백하게.
   예) "오늘 수업 끝나고 민준이가 먼저 질문하러 왔어요. 그 모습이 참 반가웠습니다."
4. 숫자·통계는 넣지 않거나 꼭 필요할 때 1개만. 보고서나 성적표처럼 쓰지 않는다.
5. 학부모님께는 정중한 존댓말("${student.nickname} 학부모님" 또는 "어머님·아버님" 대신 "학부모님").
6. 부족한 점은 걱정이 아니라 "제가 이렇게 챙기겠습니다"라는 계획으로 쓴다.

# AI가 쓴 티가 나는 표현 금지
- "~를 통해", "또한", "뿐만 아니라", "다양한", "긍정적인", "향상", "역량", "성장하는 모습을 보여주었습니다", "~할 수 있도록 지도하겠습니다", "인상적이었습니다"
- 번호·글머리표·제목·괄호 설명, "첫째/둘째", 같은 칭찬 반복, 과한 감탄("정말 정말 대단해요!")
- 이모지 없음. 머리말("[학원명] OO 학생 주간 상담")과 서명은 쓰지 않는다(시스템이 붙임).

# 지키지 않으면 안 되는 것
- 키워드와 자동 기록에 없는 사실(점수, 등수, 시험 결과, 가정사, 건강, 다른 학생 이야기)을 지어내지 않는다.
- 진단·병명·심리 상태 단정("ADHD 같다", "우울해 보인다") 금지. 걱정되는 점은 "통화로 잠깐 말씀 나누고 싶어요"로 바꾼다.
- 성적 향상을 약속하지 않는다. 다른 학생과 비교하지 않는다.
- 반 모집, 할인, 이벤트, 친구 추천 같은 홍보 문구 금지(알림톡 정보성 규정).

본문만 출력하세요.
`.trim();
}

// 사후 검사: 금지 표현·길이·지어낸 숫자 의심을 원장님 화면에 '확인 필요'로 띄운다 (자동 수정은 하지 않음)
const AD_WORDS = /(할인|이벤트|모집|등록\s*시|친구\s*추천|무료\s*체험|선착순|특가)/;
const DIAG_WORDS = /(ADHD|우울증|불안장애|자폐|학습장애|난독증|틱\s*장애)/i;
const AI_WORDS = /(를 통해|을 통해|뿐만 아니라|다양한|긍정적인|향상|역량|보여주었습니다|보여 주었습니다|인상적이었습니다|첫째|둘째)/;
const RANK_WORDS = /(\d+\s*등|상위\s*\d+\s*%|반에서\s*(가장|제일))/;

function reviewCounsel(text, note) {
  const warnings = [];
  const len = [...text].length;
  if (len > MAX_CHARS) warnings.push(`글자 수 ${len}자: 알림톡 한도를 위해 ${MAX_CHARS}자 이하로 줄여 주세요.`);
  if (len < 150) warnings.push('내용이 너무 짧습니다. 키워드를 조금 더 적어 주세요.');
  if (AD_WORDS.test(text)) warnings.push('홍보성 표현이 있어 알림톡 발송이 거절될 수 있습니다.');
  if (DIAG_WORDS.test(text)) warnings.push('진단처럼 읽히는 표현이 있습니다. 직접 상담으로 돌려 주세요.');
  const ai = text.match(new RegExp(AI_WORDS.source, 'g'));
  if (ai) warnings.push(`AI가 쓴 것처럼 딱딱한 표현이 있어요(${[...new Set(ai)].slice(0, 3).join(', ')}). 원장님 말로 바꿔 주세요.`);
  if (RANK_WORDS.test(text)) warnings.push('등수·비교 표현이 있습니다. 원장님이 적은 내용인지 확인해 주세요.');
  // 키워드에 없는 '점'수 숫자가 등장하면 지어냈을 가능성
  const scores = text.match(/\d+\s*점/g) || [];
  const given = `${note.progress} ${note.attitude}`;
  if (scores.some((s) => !given.includes(s.replace(/\s/g, '')))) warnings.push('키워드에 없는 점수가 들어갔습니다. 사실인지 확인해 주세요.');
  return warnings;
}

async function generateCounsel({ academy, student, note, stats, course }) {
  if (note.gen_count >= MAX_GEN_PER_NOTE) {
    throw Object.assign(new Error('이번 주 이 학생의 상담글 생성 횟수를 모두 썼습니다. 직접 수정해 주세요.'), { status: 429 });
  }
  if (!note.progress.trim() && !note.attitude.trim()) {
    throw Object.assign(new Error('학습 상태나 수업 태도 중 하나는 적어 주세요.'), { status: 400 });
  }
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 700,
    temperature: 0.7,
    system: buildCounselPrompt({ academy, student, note, stats, course }),
    messages: [{ role: 'user', content: '이번 주 상담글 초안을 써 주세요.' }],
  });
  let text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  // 400자를 넘기면 한 번만 줄여 달라고 다시 부탁 (원장님 말투·사실은 그대로)
  if ([...text].length > MAX_CHARS) {
    const short = await anthropic.messages.create({
      model: MODEL, max_tokens: 700, temperature: 0.3,
      system: `아래 학부모님 카톡 글을 공백 포함 ${MAX_CHARS - 30}자 이내로 줄인다. 원장님 1인칭 말투와 따뜻한 느낌, 구체적인 장면, 사실은 그대로 두고 덜 중요한 문장만 뺀다. 새로운 사실을 넣지 않는다. 본문만 출력.`,
      messages: [{ role: 'user', content: text }],
    });
    const t2 = short.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (t2 && [...t2].length < [...text].length) text = t2;
  }
  return { text, warnings: reviewCounsel(text, note) };
}

// 발송 직전 최종 본문 = 머리말 없이 본문 + 서명 (머리말은 알림톡 템플릿에 고정)
function withSignature(academy, text) {
  const sign = academy.counsel_signature || `${academy.name} ${academy.director_name} 드림`;
  return `${text.trim()}\n\n${sign}`;
}

module.exports = { buildCounselPrompt, reviewCounsel, generateCounsel, withSignature, statsLine, MAX_CHARS };
