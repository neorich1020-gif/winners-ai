const { JSDOM } = require('jsdom'); const fs = require('fs');
const html = fs.readFileSync('' + require('path').join(__dirname, '..', 'public') + '/student.html', 'utf8').replace('<script src="/student.js"></script>', '');
const js = fs.readFileSync('' + require('path').join(__dirname, '..', 'public') + '/student.js', 'utf8');
const calls = []; const errors = [];
const dom = new JSDOM(html, { url: 'https://app.example.kr/s/qrA', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.matchMedia = () => ({ matches: false }); w.scrollTo = () => {}; w.requestAnimationFrame = (f) => setTimeout(f, 0); w.addEventListener('error', (e) => errors.push(e.message));
let loggedIn = false;
w.fetch = async (url, opt = {}) => {
  const body = opt.body ? JSON.parse(opt.body) : null; calls.push([url, body]);
  const R = (status, data) => ({ ok: status < 400, status, json: async () => data });
  if (url.endsWith('/class/qrA')) return R(200, { academyName: '위너스학원', className: '중2 수학 A반', personaName: '원장쌤' });
  if (url.endsWith('/me')) return loggedIn ? R(200, { nickname: '민준', classToken: 'qrA', photo: { used: 99, limit: 100, remaining: 1 }, feedback: { used: 28, limit: 30, remaining: 2, subject: 'english' } }) : R(401, { error: '로그인이 필요합니다' });
  if (url.endsWith('/login')) { if (body.pin === '1111') { loggedIn = true; return R(200, { nickname: '민준' }); } return R(401, { error: '번호나 비밀번호를 확인해 주세요' }); }
  if (url.endsWith('/ask') && body.image) return R(402, { error: '이번 달 사진 질문 100회를 모두 썼어. 문제를 글로 적어서 물어봐 줘!', code: 'PHOTO_QUOTA', used: 100, limit: 100, remaining: 0, upgradeTo: 'standard' });
  if (url.endsWith('/ask')) { await new Promise(r=>setTimeout(r,80)); return R(200, { sessionId: 's1', hintLevel: body.moreHint ? 1 : 0, reply: body.moreHint ? '이건 일차방정식이야. 등식의 성질 기억나?' : '어디까지 해 봤어?' }); }
  if (url.endsWith('/feedback')) {
    if (body.text.includes('LIMIT')) return R(402, { error: '이번 달 첨삭 30회를 모두 썼어.', code: 'FEEDBACK_QUOTA', used: 30, limit: 30, remaining: 0, upgradeTo: 'standard' });
    fbN++;
    return R(200, { id: 'f' + fbN, subject: 'english', stage: 'hinted', praise: 'favorite 철자 완벽!', message: '실수 2개를 찾았어. 힌트 보고 고쳐서 다시 써 볼래?',
      items: [{ id: 1, type: '시제', original: 'I go to school yesterday', hint: '동사 모양을 다시 확인해 봐!', fixed: null }, { id: 2, type: '관사', original: 'a apple', hint: '모음 소리 앞 관사!', fixed: null }],
      canRetry: true, canReveal: true, quota: { used: 29, limit: 30, remaining: 1 } });
  }
  if (/\/feedback\/f\d\/retry$/.test(url)) return R(200, { id: 'f1', subject: 'english', stage: 'revealed', message: '시제는 완벽하게 고쳤어!',
    items: [{ id: 1, type: '시제', original: 'I go to school yesterday', hint: 'x', fixed: true }, { id: 2, type: '관사', original: 'a apple', hint: 'x', fixed: false, corrected: 'an apple', explain: '모음 소리 앞에는 an' }], canRetry: false, canReveal: false });
  if (/\/feedback\/f\d\/reveal$/.test(url)) return R(200, { id: url.match(/f\d/)[0], subject: 'english', stage: 'revealed', message: '괜찮아, 같이 보자!',
    items: [{ id: 1, type: '시제', original: 'I go to school yesterday', fixed: null, corrected: 'I went to school yesterday', explain: '어제니까 과거형' }], canRetry: false, canReveal: false });
  return R(404, {});
};
let fbN = 0;
w.eval(js);
const $ = (s) => w.document.querySelector(s); const tick = () => new Promise((r) => setTimeout(r, 30));
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + m); };
(async () => {
  await tick(); await tick();
  ok($('#acad').textContent === '위너스학원' && $('#cls-name').textContent === '중2 수학 A반', 'QR 주소로 학원·반 이름 표시');
  ok($('#status-text').textContent.includes('온라인'), '헤더 온라인 상태 뱃지');
  ok($('#manifest-link').getAttribute('href') === '/s/qrA/manifest.webmanifest', '반별 홈 화면 앱 정보 연결');
  ok(!$('#login').hidden && $('#chat').hidden, '처음엔 번호·PIN 로그인 화면');
  $('#code').value = '03'; $('#pin').value = '9999'; $('#login-btn').click(); await tick();
  ok($('#login-err').textContent.includes('확인해 주세요'), '틀린 PIN 안내');
  $('#pin').value = '1111'; $('#login-btn').click(); await tick();
  ok($('#login').hidden && !$('#chat').hidden && $('#chat').textContent.includes('민준'), '로그인 → 질문창');
  ok($('#send').disabled, '빈 입력이면 전송 버튼 비활성');
  ok($('#cam-badge').textContent === '1' && !$('#cam-badge').hidden, '라이트: 카메라 버튼에 이번 달 남은 사진 횟수(1)');
  ok($('#chat .row.ai svg, #chat .row.ai .avatar') !== null, 'AI 말풍선 왼쪽 아바타');
  $('#text').value = '2x+3=11 모르겠어요'; $('#text').dispatchEvent(new w.Event('input'));
  ok(!$('#send').disabled, '입력하면 전송 버튼 활성');
  $('#send').click(); await tick();
  ok($('#chat .typing') && $('#chat .typing').textContent.includes('생각 중'), '답변 대기 중 "선생님이 생각 중이에요" 점 애니메이션');
  ok($('#chat .row.me:last-of-type .bubble, #chat .row.me .bubble') !== null, '학생 말풍선 오른쪽 정렬 행');
  await new Promise(r=>setTimeout(r,150));
  ok($('#chat').textContent.includes('어디까지 해 봤어?') && !$('#chat .typing'), '질문 → 답변 표시, 대기 표시 사라짐');
  $('#more-hint').click(); await new Promise(r=>setTimeout(r,150));
  ok($('#ladder-label').textContent.includes('1단계') && calls.at(-1)[1].sessionId === 's1', '힌트 하나 더 → 1단계, 같은 문제로 이어짐');
  $('#cam').click(); ok(!$('#sheet').hidden && $('#pick-camera') && $('#pick-album'), '📷 → 카메라/앨범 선택 시트');
  ok($('#file-camera').getAttribute('capture') === 'environment' && !$('#file-album').hasAttribute('capture'), '카메라는 후면 카메라 바로 열기, 앨범은 사진 고르기');
  $('#sheet-cancel').click(); ok($('#sheet').hidden, '시트 닫기');
  // 사진 한도 소진 (서버가 PHOTO_QUOTA 응답)
  w.eval("window.__forcePhoto = true");
  $('#text').value = '이 문제요'; $('#text').dispatchEvent(new w.Event('input'));
  // 사진 준비 과정(canvas)은 jsdom이 지원하지 않아, 서버로 이미지가 간 상황을 직접 재현
  const origFetch = w.fetch; w.fetch = (u, o) => { if (u.endsWith('/ask')) { const b = JSON.parse(o.body); b.image = { mediaType: 'image/jpeg', base64: 'x' }; o = { ...o, body: JSON.stringify(b) }; } return origFetch(u, o); };
  $('#send').click(); await new Promise(r=>setTimeout(r,150));
  ok(!$('#quota').hidden && $('#quota').textContent.includes('스탠다드'), '사진 한도 초과 → 업그레이드 안내 팝업');
  ok($('#cam-badge').textContent === '0', '카메라 버튼 잔여 0');
  $('#quota-ok').click(); ok($('#quota').hidden, '팝업 닫고 글로 질문');
  // ---- 영작 첨삭 ----
  ok(!$('#fb-chip').hidden && $('#fb-chip').textContent.includes('✍️ 첨삭') && $('#fb-chip-n').textContent === '2회', '✍️ 첨삭 버튼 하나 + 이번 달 남은 횟수(2회)');
  ok($('#chat').textContent.includes('영어 글이나 수학 풀이') && $('#chat').textContent.includes('첨삭 버튼을 눌러'), '첫 인사에 첨삭 버튼 안내 (영어·수학 둘 다)');
  $('#fb-chip').click(); await tick();
  ok(!$('#fb-mode').hidden && $('#fb-mode').textContent.includes('영어 글') && $('#ladder-wrap').hidden && $('#more-hint').hidden, '첨삭 모드: 안내 띠 표시, 힌트 단계·힌트 버튼 숨김');
  ok($('#text').placeholder.includes('영어 글'), '입력칸 안내 문구 변경');
  ok($('#fb-en').getAttribute('aria-pressed') === 'true' && $('#fb-ma'), '같은 화면에 영어 영작 / 수학 풀이 선택 버튼');
  $('#fb-ma').click(); await tick();
  ok($('#fb-ma').getAttribute('aria-pressed') === 'true' && $('#text').placeholder.includes('풀이') && $('#chat').textContent.includes('풀이 첨삭으로 바꿨어'), '수학 풀이로 바꾸면 안내·입력칸이 수학용으로');
  $('#fb-en').click(); await tick();
  ok($('#cam-badge').hidden, '첨삭 모드에선 사진 질문 잔여 뱃지 숨김(첨삭 사진은 따로 셈)');
  $('#text').value = 'My favorite food is pizza. I go to school yesterday. I ate a apple.'; $('#text').dispatchEvent(new w.Event('input'));
  $('#send').click(); await new Promise(r=>setTimeout(r,80));
  ok(calls.at(-1)[0] === '/api/student/feedback' && calls.at(-1)[1].text.includes('pizza') && calls.at(-1)[1].subject === 'english', '첨삭 모드에서 보내면 첨삭 주소로, 고른 과목과 함께 전송');
  let card = [...w.document.querySelectorAll('.bubble.fbc')].at(-1);
  ok(card && card.querySelectorAll('li').length === 2 && card.querySelector('mark').textContent === 'I go to school yesterday', '첨삭 카드: 틀린 부분 2곳 표시(밑줄)');
  ok(card.textContent.includes('💡 동사 모양') && !card.querySelector('.fix'), '1단계: 힌트만, 고친 표현 없음');
  ok(card.querySelector('.praise').textContent.includes('favorite'), '칭찬 먼저');
  ok($('#fb-chip-n').textContent === '1회', '남은 첨삭 횟수 1회로 줄어듦');
  const [again, idk] = card.querySelectorAll('.acts button');
  ok(again.textContent.includes('고쳐 쓰기') && idk.textContent.includes('모르겠어요'), '"고쳐 쓰기" · "모르겠어요" 버튼');
  again.click(); await tick();
  ok($('#fb-mode').textContent.includes('고쳐 쓰기'), '고쳐 쓰기 모드로 전환');
  $('#text').value = 'I went to school yesterday. I ate a apple.'; $('#text').dispatchEvent(new w.Event('input'));
  $('#send').click(); await new Promise(r=>setTimeout(r,80));
  ok(calls.at(-1)[0] === '/api/student/feedback/f1/retry', '고친 글은 같은 첨삭의 확인 주소로');
  card = [...w.document.querySelectorAll('.bubble.fbc')].at(-1);
  ok(card.querySelector('li.fixed .ok-badge').textContent.includes('스스로 고쳤어') && card.querySelector('.fix').textContent.includes('an apple') && card.textContent.includes('모음 소리'), '고친 건 ✔, 못 고친 것만 고친 표현·이유 공개');
  ok(idk.disabled && again.disabled, '예전 카드 버튼은 잠김');
  ok(!$('#fb-mode').textContent.includes('고쳐 쓰기'), '확인이 끝나면 다시 새 글 첨삭 모드');
  $('#text').value = 'I go to school yesterday.'; $('#text').dispatchEvent(new w.Event('input'));
  $('#send').click(); await new Promise(r=>setTimeout(r,80));
  card = [...w.document.querySelectorAll('.bubble.fbc')].at(-1);
  card.querySelectorAll('.acts button')[1].click(); await new Promise(r=>setTimeout(r,80));
  ok(calls.at(-1)[0] === '/api/student/feedback/f2/reveal' && [...w.document.querySelectorAll('.bubble.fbc')].at(-1).textContent.includes('I went to school'), '"잘 모르겠어요" → 바로 고친 표현 공개');
  $('#text').value = 'LIMIT'; $('#text').dispatchEvent(new w.Event('input'));
  $('#send').click(); await new Promise(r=>setTimeout(r,80));
  ok(!$('#fb-quota').hidden && $('#fb-quota').textContent.includes('스탠다드') && $('#fb-chip-n').textContent === '0회', '첨삭 한도 소진 → 업그레이드 안내, 0회 표시');
  $('#fbq-ok').click(); await tick();
  ok($('#fb-quota').hidden && $('#fb-mode').hidden && !$('#more-hint').hidden, '팝업 닫으면 일반 질문창으로 복귀');
  $('#fb-chip').click(); await tick();
  ok(!$('#fb-quota').hidden && $('#fb-mode').hidden, '0회일 때 첨삭 버튼 → 바로 안내 팝업');
  $('#fbq-ok').click();
  ok(errors.length === 0, '스크립트 오류 없음 ' + errors.join('|'));
  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
})();
