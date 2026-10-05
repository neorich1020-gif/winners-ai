const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('' + require('path').join(__dirname, '..', 'public') + '/prototype.html', 'utf8');
const errors = [];
const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.scrollTo = () => {}; w.addEventListener('error', (e) => errors.push(e.message)); } });
const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);
let pass = 0, fail = 0; const ok = (c, m, x) => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + m + (c || x === undefined ? '' : '  → ' + x)); };
const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const pill = (id) => d.querySelector(`tr[data-row="${id}"] .pill`).textContent;
const flow = () => [...d.querySelectorAll('#flow b')].map((b) => b.textContent).join('/');

ok(errors.length === 0, '페이지 스크립트 오류 없음', errors.join(' | '));
click(d.querySelector('[data-view="director"]'));
click(d.querySelector('[data-pane="report"]'));
ok(!$('#pane-report').hidden, '원장 대시보드 > 주간 상담·리포트 화면 열림');
ok(d.querySelectorAll('#counsel-table tr[data-row]').length === 5, '학생 5명 표 표시');
const head = [...d.querySelectorAll('#counsel-table th')].map((t) => t.textContent).join('|');
ok(head.includes('과목') && head.includes('이번 주 학습 상태/진도') && head.includes('수업 태도/특이사항'), '표 열: ' + head);
ok(pill('k1') === '승인 · 발송 대기' && pill('k2') === 'AI 초안 · 확인 필요', '시작 상태: 민준 승인, 하은 초안');
ok(flow() === '3/1/1/0', '진행 현황 숫자 (작성 전/초안/승인/완료) = ' + flow());

// 도윤: 상담글 생성
click(d.querySelector('[data-gen="k3"]'));
ok(pill('k3') === 'AI 초안 · 확인 필요' && $('#ed-text').value.includes('도윤'), '도윤 상담글 생성 → 편집기에 초안');
ok($('#kakao-body').textContent.includes('[위너스학원] 도윤 학생 주간 상담 안내'), '카톡 미리보기 갱신');
// 지후: 키워드 없이 생성 → 안내
click(d.querySelector('[data-gen="k4"]'));
ok($('#ed-saved').textContent.includes('하나는 적어'), '지후(키워드 없음) 생성 시 안내 문구');
// 지후 키워드 입력 후 AI 칩 없음 확인, 하은 AI 칩 클릭
click(d.querySelector('[data-chip="k2"]'));
ok(d.querySelector('#prog-k2').value.includes('AI 질문 9개'), '하은 AI 기록 칩 → 학습 상태 칸에 붙여짐');
// 하은 편집 → 승인
click(d.querySelector('[data-pick="k2"]'));
type($('#ed-text'), $('#ed-text').value + '\n\n추가 문장입니다.');
ok($('#ed-count').textContent.includes('/ 800자'), '글자 수 표시: ' + $('#ed-count').textContent);
click($('#ed-approve'));
ok(pill('k2') === '승인 · 발송 대기', '하은 승인');
type($('#ed-text'), $('#ed-text').value + ' 수정');
ok(pill('k2') === 'AI 초안 · 확인 필요' && $('#ed-saved').textContent.includes('다시 승인'), '승인 후 수정 → 재승인 필요');
// 800자 초과 승인 차단
type($('#ed-text'), '가'.repeat(820));
ok($('#ed-approve').disabled && $('#ed-warn').textContent.includes('800자'), '800자 넘으면 승인 버튼 잠김 + 경고');
type($('#ed-text'), '반 모집 중입니다. 할인 이벤트도 있어요. ' + '좋습니다. '.repeat(30));
ok($('#ed-warn').textContent.includes('홍보성'), '홍보 문구 경고 표시');
click($('#ed-regen'));
ok(!$('#ed-text').value.includes('할인'), '다시 생성하면 새 초안으로 교체');
// 일괄 승인
click($('#bulk-approve'));
ok(pill('k2') === '승인 · 발송 대기' && pill('k3') === '승인 · 발송 대기', '초안 모두 승인');
// 서연은 키워드 있음 → 일괄 생성
click($('#bulk-gen'));
ok(pill('k5') === 'AI 초안 · 확인 필요', '일괄 생성: 서연 초안');
// 발송 시간 변경
$('#r-time').value = '19:00'; $('#r-time').dispatchEvent(new w.Event('change'));
ok($('#send-at').textContent.includes('19:00'), '발송 시각 변경 반영: ' + $('#send-at').textContent);
// 금요일 발송 시뮬레이션
click($('#simulate'));
const log = $('#send-log').textContent;
ok(pill('k1') === '발송 완료' && pill('k2') === '발송 완료' && pill('k3') === '발송 완료', '승인된 3명 발송 완료');
ok(log.includes('서연  제외') && log.includes('지후  ✓ 자동 학습 리포트'), '서연 제외(동의 없음), 지후 자동 리포트 대체');
ok(flow().endsWith('/3'), '진행 현황 발송 완료 3 = ' + flow());
click(d.querySelector('[data-pick="k1"]'));
ok($('#ed-text').disabled && $('#ed-approve').disabled, '발송된 글은 편집 잠김');
// 모니터링 → 상담 연결
click(d.querySelector('[data-pane="monitor"]'));
click($('#to-counsel'));
ok(!$('#pane-report').hidden && d.querySelector('tr.sel[data-row="k2"]'), '모니터링 "하은 상담글에 반영" → 상담 화면 하은 선택');
// 기존 학생 화면 회귀
click(d.querySelector('[data-view="student"]'));
click($('#more-hint'));
ok($('#ladder-label').textContent.includes('1단계'), '학생 질문창 힌트 단계 정상');
// 사진 질문 (시연)
click($('#cam')); ok(!$('#pick').hidden, '📷 → 카메라/앨범/예시 선택');
ok($('#f-cam').getAttribute('capture') === 'environment', '카메라 입력은 후면 카메라');
click($('#pick-sample')); ok(!$('#pv').hidden, '예시 문제 사진 미리보기');
$('#composer').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
ok($('#pv').hidden && $('#ladder-label').textContent.includes('0단계'), '사진 전송 → 새 문제로 0단계');
// 요금제·정원
click(d.querySelector('[data-view="director"]'));
ok($('#cap-banner').hidden && $('#cap-count').textContent === '28 / 30명', '28명: 배너 없음, 28 / 30명 표시');
click($('#cap-add')); click($('#cap-add'));
ok(!$('#cap-banner').hidden && $('#cap-pill').textContent.includes('정원 도달 30/30'), '30명: 상단 "정원 도달" 배너');
click($('#cap-add'));
ok($('#cap-pill').textContent.includes('정원 초과 31/30') && $('#cap-banner').classList.contains('over') && !$('#side-badge').hidden, '31명: "정원 초과" 배너 + 메뉴 뱃지');
click($('#cap-go')); ok(!$('#pane-billing').hidden && $('#pane-billing').textContent.includes('월 49,000원'), '배너 → 학원 정보 및 요금 관리 (월 49,000원)');
click($('#cap-sub')); click($('#cap-sub')); ok($('#cap-banner').hidden, '퇴원 처리로 29명 → 배너 사라짐');
// ===== 요금제 3종 =====
const lc = d.querySelectorAll('#land-plans .pcard'), dc = d.querySelectorAll('#dash-plans .pcard');
ok(lc.length === 3 && dc.length === 3, '랜딩·대시보드 모두 플랜 카드 3개');
const std = d.querySelector('#land-plans .pcard.pop');
ok(std && std.textContent.includes('스탠다드') && std.textContent.includes('🔥 가장 인기 / 추천') && std.textContent.includes('출시 기념 평생 할인 (월 99,000원 ➔ 69,000원)'), '스탠다드 카드: 인기 뱃지 + 평생 할인 뱃지');
ok([...lc].map(c=>c.querySelector('.pc-price b').textContent).join('/') === '49,000/69,000/119,000', '가격 49,000 / 69,000 / 119,000');
ok(lc[0].textContent.includes('사진 질문(Vision) 월 100회') && lc[1].textContent.includes('사진 질문(Vision) 무제한'), '라이트 사진 월 100회, 스탠다드 무제한');
ok(std.querySelectorAll('li.soon').length === 3 && lc[2].querySelectorAll('li.soon').length === 2, '미개발 기능은 "곧 제공" 표시 (스탠다드 3, 프리미엄 추가분 2)');
// 대시보드 플랜 변경 (29명 상태)
click(d.querySelector('[data-pane="billing"]'));
click(d.querySelector('#dash-plans [data-change-plan="standard"]'));
ok($('#plan-msg').textContent.includes('바꿀까요'), '플랜 변경은 확인 단계 먼저');
click($('#plan-ok'));
ok($('#cur-name').textContent === '스탠다드' && $('#cur-price').textContent === '월 69,000원' && !$('#cur-lock').hidden, '스탠다드로 변경 → 69,000원 평생 고정 표시');
ok($('#cap-count').textContent === '29 / 60명' && $('#photo-wrap').hidden, '정원 60명, 사진 사용량 막대 숨김(무제한)');
ok(d.querySelector('#p-badge').hidden, '학생 카메라 버튼의 잔여 횟수 숨김(무제한)');
for(let i=0;i<32;i++) click($('#cap-add'));
ok(d.querySelector('#dash-plans [data-change-plan="lite"]') === null && d.querySelector('#dash-plans .pcard').textContent.includes('선택 불가'), '61명이면 라이트로 내릴 수 없음');
ok($('#cap-pill').textContent.includes('정원 초과 61/60') && $('#cap-msg').textContent.includes('프리미엄'), '61명: 프리미엄 추천 배너');
for(let i=0;i<32;i++) click($('#cap-sub'));
// 사진 한도 (라이트)
click($('#quota-demo'));
ok(!$('#p-quota').hidden && $('#p-quota').textContent.includes('스탠다드 플랜'), '라이트 100회 소진 → 학생 화면 업그레이드 안내 팝업');
ok(d.querySelector('#p-badge').textContent === '0', '카메라 버튼 잔여 0');
click($('#pq-ok')); click($('#cam'));
ok(!$('#p-quota').hidden && $('#pick').hidden, '소진 후 📷 누르면 사진 선택 대신 안내');
click($('#pq-ok'));
click(d.querySelector('[data-view="director"]'));
ok(!$('#cap-banner').hidden && $('#cap-pill').textContent.includes('100/100회 소진'), '원장 대시보드 상단: 사진 소진 + 스탠다드 안내');
click($('#quota-reset'));
ok(d.querySelector('#p-badge').textContent === '37', '되돌리기 → 37회 남음');
// 학생 화면 새 디자인
click(d.querySelector('[data-view="student"]'));
ok(d.querySelector('.prow.ai .pav svg') && d.querySelector('.ph-status').textContent.includes('온라인'), 'AI 말풍선 아바타 + 헤더 온라인 뱃지');
$('#student-input').value='x = 4'; $('#student-input').dispatchEvent(new w.Event('input',{bubbles:true}));
ok(!$('#p-send').disabled, '글자 입력하면 전송 버튼 활성');
$('#composer').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
ok(d.querySelector('.ptyping') && d.querySelector('.ptyping').textContent.includes('생각 중'), '답변 작성 중 "선생님이 생각 중이에요" 표시');
// 가입
click(d.querySelector('[data-view="landing"]'));
click(d.querySelector('#land-plans [data-pick-plan="standard"]'));
ok(d.querySelector('input[name="su-plan"][value="standard"]').checked, '카드의 체험 시작 → 가입 폼에 플랜 선택됨');
$('#su-count').value='75'; $('#su-count').dispatchEvent(new w.Event('input'));
ok($('#su-recommend').textContent.includes('프리미엄'), '예상 학생 75명 → 프리미엄 추천');
$('#su-count').value='45'; $('#su-count').dispatchEvent(new w.Event('input'));
$('#signup-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
ok($('#su-err').textContent.length > 0 && $('#su-done').hidden, '필수값 없으면 오류 안내');
$('#su-academy').value='위너스학원'; $('#su-name').value='김OO'; $('#su-email').value='a@winners.kr'; $('#su-pw').value='12345678'; $('#su-phone').value='010-2000-5369'; $('#su-agree').checked=true;
$('#signup-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
ok(!$('#su-done').hidden && $('#su-steps').textContent.includes('30분 Zoom 세팅') && $('#su-done-sub').textContent.includes('69,000원'), '가입 완료 → 온보딩 단계(Zoom 세팅 포함)');
const zoomCount = (d.body.textContent.match(/30분 무료 화상 통화\(Zoom\)/g)||[]).length;
ok(zoomCount >= 4, `Zoom 무료 세팅 안내 문구 ${zoomCount}곳 (대시보드·랜딩·가입·하단)`);
ok(errors.length === 0, '조작 중 스크립트 오류 없음', errors.join(' | '));
console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`);
setTimeout(() => process.exit(fail ? 1 : 0), 600);
