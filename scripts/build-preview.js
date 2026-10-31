// 디자인 미리보기 한 장짜리 HTML 만들기: 실제 학생 화면(student.html + student.js) + 가짜 서버(학생 데이터·AI 호출 없음)
//   node scripts/build-preview.js <출력 경로>
const fs = require('fs'), path = require('path');
const pub = path.join(__dirname, '..', 'public');
let html = fs.readFileSync(path.join(pub, 'student.html'), 'utf8');
const js = fs.readFileSync(path.join(pub, 'student.js'), 'utf8');
const mock = String.raw`
window.__MW_TOKEN = 'demo'; window.__MW_PREVIEW = true;
(() => {
  let logged = false, n = 0, fbN = 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = (status, data) => ({ ok: status < 400, status, json: async () => data });
  const me = () => ({ nickname: '민준', classToken: 'demo', photo: { used: 12, limit: null, remaining: null }, feedback: { used: 0, limit: null, remaining: null, subject: 'math' }, teachingMode: 'key_hint', today: { asked: 1, solved: 0 } });
  const HINT = '📌 핵심 개념 퀴즈\n저울 양쪽에서 같은 무게를 빼면 저울은 어떻게 될까?\n\n🧭 힌트 1 · 해결 흐름 3단계\n1단계: 등식의 성질 떠올리기\n2단계: 양변에서 같은 수를 빼서 x 쪽만 남기기\n3단계: x 앞의 숫자로 양변 나누기\n\n여기에서 헷갈리는 개념이 있으면 편하게 말해 줘!';
  const SOL = '좋아, 같이 끝까지 풀어 보자!\n\n1단계 ▶ 양변에서 3을 빼면\n2x + 3 − 3 = 11 − 3\n2x = 8\n💡 개념: 등식의 양변에서 같은 수를 빼도 등식은 성립해\n2단계 ▶ 양변을 2로 나누면\nx = 8 ÷ 2 = 4\n\n답: x = 4\n\n이제 이 풀이를 가리고 혼자 처음부터 다시 써 보자! 다 쓰면 오답노트 사진으로 인증해 줘 📸';
  const GRAPH = { title: 'y = 2x + 3 과 y = −x + 6', x: [-4, 5], y: [-5, 13], series: [{ label: 'y = 2x + 3', segs: [[[-4, -5], [5, 13]]] }, { label: 'y = −x + 6', segs: [[[-4, 10], [5, 1]]] }], points: [{ x: 1, y: 5, label: '교점 (1, 5)' }] };
  window.fetch = async (url, opt = {}) => {
    const body = opt.body ? JSON.parse(opt.body) : null;
    await wait(250);
    if (url.includes('/class/')) return R(200, { academyName: '위너스학원', className: '중2 수학 A반', personaName: '원장쌤' });
    if (url.endsWith('/me')) return logged ? R(200, me()) : R(401, { error: '로그인이 필요합니다' });
    if (url.endsWith('/login')) { if (/^\d{1,4}$/.test(body.code) && /^\d{4}$/.test(body.pin)) { logged = true; return R(200, { nickname: '민준' }); } return R(401, { error: '번호나 비밀번호를 확인해 주세요 (미리보기: 아무 번호 + 숫자 4자리)' }); }
    if (url.endsWith('/logout')) { logged = false; return R(200, { ok: true }); }
    if (url.includes('/hint2') || url.includes('/close')) return R(200, { ok: true });
    if (url.endsWith('/ask')) {
      await wait(900); n++;
      const sid = body.sessionId || 'demo-' + n;
      if (body.wantSolution) return R(200, { sessionId: sid, hintLevel: 0, reply: SOL, solutionShown: true, solutionAvailable: false, teachingMode: 'key_hint' });
      if (body.moreHint) return R(200, { sessionId: sid, hintLevel: 0, reply: '그럼 더 쉽게 볼게!\n2x + 3 = 11 은 "어떤 수의 2배에 3을 더하면 11"이라는 뜻이야.\n11에서 3을 먼저 빼면 2배 한 값이 나오겠지?', solutionAvailable: true, teachingMode: 'key_hint' });
      if (/그래프|함수|교점/.test(body.text)) return R(200, { sessionId: sid, hintLevel: 0, reply: '📌 핵심 개념 퀴즈\n두 직선이 만나는 점은 두 식을 동시에 만족할까?\n\n🧭 힌트 1 · 해결 흐름 3단계\n1단계: 두 식을 같다고 놓기\n2x + 3 = −x + 6\n2단계: x 값 구하기\n3단계: 구한 x를 한 식에 넣어 y 구하기\n\n아래 그래프에서 두 직선이 어디서 만나는지 먼저 봐 봐!', graph: GRAPH, hint2: '[2x + 3] = [−x + 6]\n양변에 x를 더하면 3x + 3 = 6', solutionAvailable: true, teachingMode: 'key_hint' });
      if (body.image) return R(200, { sessionId: sid, hintLevel: 0, reply: '사진 잘 봤어! (미리보기라 실제 사진은 읽지 않아요)\n\n' + HINT, hint2: '[2x] + 3 ---> 11\n추 3개를 양쪽에서 똑같이 빼 봐!', solutionAvailable: true, teachingMode: 'key_hint' });
      return R(200, { sessionId: sid, hintLevel: 0, reply: HINT, hint2: '[2x] + 3 ---> 11\n저울에서 추 3개를 양쪽에서 똑같이 빼 봐!', solutionAvailable: true, teachingMode: 'key_hint' });
    }
    if (url.endsWith('/feedback')) { await wait(900); fbN++; const en = body.subject === 'english';
      return R(200, en ? { id: 'f' + fbN, subject: 'english', stage: 'hinted', praise: 'favorite 철자를 정확히 썼어!', message: '실수 2개를 찾았어. 힌트를 보고 고쳐서 다시 써 볼래?',
        items: [{ id: 1, type: '시제', original: 'I go to school yesterday', hint: '어제 일이면 동사 모양을 다시 봐!', fixed: null }, { id: 2, type: '관사', original: 'a apple', hint: '모음 소리 앞 관사!', fixed: null }], canRetry: true, canReveal: true }
        : { id: 'f' + fbN, subject: 'math', stage: 'hinted', praise: '식을 깔끔하게 세웠어!', message: '2번째 줄부터 다시 보자.', items: [{ id: 1, type: '부호 실수', line: '2번째 줄: 2x + 3 = 7 → 2x = 10', hint: '양변에서 3을 빼면 오른쪽은 몇이 될까?', fixed: null }], canRetry: true, canReveal: false }); }
    if (/\/feedback\/f\d+\/retry$/.test(url)) { await wait(700); return R(200, { id: 'f' + fbN, subject: 'english', stage: 'revealed', message: '시제는 완벽하게 고쳤어!',
      items: [{ id: 1, type: '시제', original: 'I go to school yesterday', fixed: true }, { id: 2, type: '관사', original: 'a apple', fixed: false, corrected: 'an apple', explain: 'apple은 모음 소리로 시작해서 an을 써.' }], canRetry: false, canReveal: false }); }
    if (/\/feedback\/f\d+\/reveal$/.test(url)) return R(200, { id: 'f' + fbN, subject: 'english', stage: 'revealed', message: '괜찮아, 같이 보자!', items: [{ id: 1, type: '시제', original: 'I go to school yesterday', fixed: null, corrected: 'I went to school yesterday', explain: '어제 일이니까 과거형 went' }], canRetry: false, canReveal: false });
    return R(404, {});
  };
})();
`;
html = html
  .replace(/<link rel="(preconnect|stylesheet)" href="https:\/\/cdn\.jsdelivr[^>]*>\n?/g, '')
  .replace(/<link rel="(manifest|icon|apple-touch-icon)"[^>]*>\n?/g, (m) => (m.includes('manifest') ? '<link rel="manifest" id="manifest-link" href="data:,">\n' : ''))
  .replace('<title>멘트윈</title>', '<title>멘트윈 학생 화면</title>')
  .replace('<script src="/student.js"></script>', `<script>${mock}\n${js}</script>`);
// 게시용(Artifact): 문서 뼈대는 게시할 때 붙으므로 빼고, 보는 사람의 밝게/어둡게 선택(data-theme)도 따르게
if (process.argv.includes('--artifact')) {
  const dark = html.match(/@media \(prefers-color-scheme:dark\)\{:root\{([\s\S]*?)\}\}/);
  html = html
    .replace(/<!doctype html>\n?|<html[^>]*>\n?|<\/html>\n?|<head>\n?|<\/head>\n?|<body>\n?|<\/body>\n?/gi, '')
    .replace(/<meta (charset|name="viewport"|name="theme-color"|name="apple-mobile[^"]*"|name="mobile-web-app-capable")[^>]*>\n?/g, '')
    .replace(/@media \(prefers-color-scheme:dark\)\{:root\{/, '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){')
    .replace(/@media \(prefers-color-scheme:dark\)\{(?!:root)/g, '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) ')
    .replace('</style>', `:root[data-theme="dark"]{${dark ? dark[1] : ''}}\n</style>`);
}
const out = process.argv[2] || path.join(__dirname, '..', 'preview', 'student-preview.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('미리보기 저장:', out, Math.round(html.length / 1024) + 'KB');
