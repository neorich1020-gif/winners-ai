// 멘트윈 원장님 관리자 화면 (/director) — 서버 API(/api/director/...)에 연결
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SUBJ = { math: '수학', english: '영어', science: '과학', korean: '국어', etc: '기타' };
  const GRADE = { elementary: '초등', middle: '중등', high: '고등' };
  const STATUS = { solved: ['ok', '스스로 해결'], gave_up: ['warn', '포기'], open: ['', '진행 중'], flagged: ['bad', '확인 필요'] };
  const CS = { empty: ['', '작성 전'], draft: ['warn', 'AI 초안 · 확인 필요'], approved: ['brand', '승인 · 발송 대기'], sent: ['ok', '발송 완료'], failed: ['bad', '발송 실패'] };
  const time = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function api(path, opts = {}) {
    const res = await fetch('/api/director' + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'), credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('다시 로그인해 주세요'); }
    if (!res.ok) throw Object.assign(new Error(data.error || '잠시 후 다시 시도해 주세요'), { status: res.status, data });
    return data;
  }
  function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2600); }
  function msg(id, t, ok) { const el = $(id); el.textContent = t; el.className = 'msg ' + (ok ? 'ok' : 'err'); }

  // ---------- 로그인 ----------
  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#lg-email').focus(); }
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault(); $('#lg-err').textContent = '';
    try {
      await api('/login', { body: { email: $('#lg-email').value.trim(), password: $('#lg-pw').value } });
      $('#lg-pw').value = ''; await boot();
    } catch (err) { $('#lg-err').textContent = err.message; }
  };
  $('#logout').onclick = async () => { await api('/logout', { body: {} }).catch(() => {}); showLogin(); };

  let me = null, classes = [], students = [];
  async function boot() {
    try { me = await api('/me'); } catch { return showLogin(); }
    $('#login').hidden = true; $('#app').hidden = false;
    $('#acad-name').textContent = me.academy.name; $('#me-email').textContent = me.email;
    document.title = `멘트윈 · ${me.academy.name}`;
    go(location.hash.slice(1) || 'home');
  }

  // ---------- 메뉴 ----------
  const VIEWS = { home: loadHome, sessions: loadSessions, students: loadStudents, counsel: loadCounsel, feedback: loadFeedback, settings: loadSettings, billing: loadBilling };
  function go(v) {
    if (!VIEWS[v]) v = 'home';
    $$('#nav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === v)));
    Object.keys(VIEWS).forEach((k) => ($('#v-' + k).hidden = k !== v));
    history.replaceState(null, '', '#' + v);
    window.scrollTo(0, 0);
    VIEWS[v]().catch((e) => toast(e.message));
  }
  $$('#nav button').forEach((b) => (b.onclick = () => go(b.dataset.view)));
  // 주소 끝(#students 등)을 직접 바꾸거나 뒤로 가기를 눌러도 해당 메뉴로
  window.addEventListener('hashchange', () => { if (!$('#app').hidden) go(location.hash.slice(1)); });

  // ---------- 오른쪽 창 ----------
  function openDrawer(html) { $('#drawer-panel').innerHTML = html; $('#drawer').hidden = false; $('#drawer-panel [data-close]')?.addEventListener('click', closeDrawer); return $('#drawer-panel'); }
  function closeDrawer() { $('#drawer').hidden = true; $('#drawer-panel').innerHTML = ''; }
  $('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });
  const top = (title) => `<div class="top"><h2>${esc(title)}</h2><button class="btn ghost small" data-close>닫기</button></div>`;

  // ---------- 오늘 현황 ----------
  async function loadHome() {
    const [o, ss] = await Promise.all([api('/monitor/overview'), api('/monitor/sessions')]);
    const w = o.week || {};
    const rate = w.questions ? Math.round((w.solved / w.questions) * 100) : 0;
    $('#stats').innerHTML = [
      [w.questions || 0, '질문한 문제'], [`${rate}%`, '스스로 해결'], [w.active_students || 0, '이용 학생'], [w.avg_hint ?? '-', '평균 힌트 단계'],
    ].map(([b, s]) => `<div class="card stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('');
    $('#flags').innerHTML = (o.flags || []).map((f) => `<div class="alert"><span class="pill bad">확인 필요</span><span><b>${esc(f.nickname)}</b> 학생 대화에서 마음이 힘들다는 신호가 있었어요. (${time(f.created_at)})</span><span class="sp"></span>
      <button class="btn ghost small" data-open-student="${esc(f.nickname)}">대화 보기</button><button class="btn small" data-resolve="${esc(f.id)}">상담 완료</button></div>`).join('');
    const fb = $('#flag-badge'); fb.hidden = !(o.flags || []).length; fb.textContent = (o.flags || []).length;
    const max = Math.max(1, ...(o.topics || []).map((t) => t.n));
    $('#topics').innerHTML = (o.topics || []).length ? o.topics.map((t) => `<div class="bar-row"><span>${esc(t.topic)}</span><div class="bar"><i class="${t.avg_hint >= 2.5 ? 'hard' : ''}" style="width:${(t.n / max) * 100}%"></i></div><span class="note">${t.n}건 · ${esc(t.avg_hint)}</span></div>`).join('') : '<div class="empty">아직 질문이 없어요</div>';
    const noted = ss.filter((x) => x.summary && (x.summary.weakness_point || x.summary.director_note)).slice(0, 8);
    $('#notes').innerHTML = noted.length ? noted.map((x) => `<li><b>${esc(x.nickname)}</b> · ${esc(x.summary.topic || x.topic || '')}<br><span class="note">${x.summary.weakness_point ? '헷갈린 부분: ' + esc(x.summary.weakness_point) : ''}${x.summary.director_note ? ' · 코칭: ' + esc(x.summary.director_note) : ''}</span></li>`).join('') : '<li class="note" style="list-style:none;margin-left:-18px">튜터가 남긴 메모가 아직 없어요</li>';
    $$('[data-resolve]').forEach((b) => (b.onclick = async () => { await api(`/monitor/flags/${b.dataset.resolve}/resolve`, { body: {} }); toast('상담 완료로 표시했어요'); loadHome(); }));
    $$('[data-open-student]').forEach((b) => (b.onclick = () => { const s = ss.find((x) => x.nickname === b.dataset.openStudent && x.status === 'flagged') || ss.find((x) => x.nickname === b.dataset.openStudent); if (s) openSession(s); }));
  }

  // ---------- 질문 기록 ----------
  async function loadSessions() {
    if (!students.length) students = await api('/students');
    const sel = $('#ss-student'); const cur = sel.value;
    sel.innerHTML = '<option value="">전체</option>' + students.map((s) => `<option value="${esc(s.id)}">${esc(s.nickname)} (${esc(s.class_name || '')})</option>`).join('');
    sel.value = cur; sel.onchange = loadSessions;
    const rows = await api('/monitor/sessions' + (sel.value ? `?studentId=${encodeURIComponent(sel.value)}` : ''));
    $('#ss-table').innerHTML = '<tr><th>시각</th><th>학생</th><th>반</th><th>단원</th><th>상태</th><th>결정적 힌트</th><th>헷갈린 부분</th></tr>' +
      (rows.length ? rows.map((r, i) => {
        const st = STATUS[r.status] || ['', r.status];
        const kind = r.kind === 'feedback' ? '<span class="pill">첨삭</span> ' : '';
        return `<tr class="click" data-i="${i}" tabindex="0"><td class="note">${time(r.started_at)}</td><td><b>${esc(r.nickname)}</b></td><td>${esc(r.class_name || '')}</td>
          <td>${kind}${esc(r.topic || '-')}</td><td><span class="pill ${st[0]}">${esc(st[1])}</span></td><td>${[r.hint2_opened ? '🔑 펼침' : '', r.solution_shown ? '📖 풀이 봄' : ''].filter(Boolean).join(' ') || '<span class="note">-</span>'}</td>
          <td class="note">${esc(r.summary?.weakness_point || '')}</td></tr>`;
      }).join('') : '<tr><td colspan="7"><div class="empty">아직 질문 기록이 없어요</div></td></tr>');
    $$('#ss-table tr[data-i]').forEach((tr) => { tr.onclick = () => openSession(rows[tr.dataset.i]); tr.onkeydown = (e) => { if (e.key === 'Enter') openSession(rows[tr.dataset.i]); }; });
  }
  async function openSession(s) {
    const panel = openDrawer(top(`${s.nickname} · ${s.topic || '질문'}`) + '<div class="empty">불러오는 중…</div>');
    const msgs = await api(`/monitor/sessions/${s.id}`);
    const sm = s.summary;
    panel.innerHTML = top(`${s.nickname} · ${s.topic || '질문'}`) +
      (sm ? `<div class="sumcard"><div><b>과목·주제</b>${esc([sm.subject, sm.topic].filter(Boolean).join(' · '))}</div>
        <div><b>헷갈린 부분</b>${esc(sm.weakness_point || '없음')}</div><div><b>코칭 메모</b>${esc(sm.director_note || '-')}</div>
        <div><b>칭찬 한 줄</b>${esc(sm.parent_cheering_msg || '-')}</div>
        <div><b>결정적 힌트</b>${s.hint2_opened ? '펼쳐 봄' : '안 펼침'}${s.solution_shown ? ' · 📖 완성 풀이 봄' : ''} · <b style="min-width:0">오답노트</b> ${sm.math_wrong_note_assigned ? '지시함' : '-'}</div></div>` : '') +
      msgs.map((m) => `<div class="bub ${m.role === 'student' ? 'student' : 'ai'} ${m.verdict === 'safety' ? 'flag' : ''}">${esc(m.content)}</div>`).join('') +
      '<p class="note">이 대화를 열람한 기록이 남았어요.</p>';
    panel.querySelector('[data-close]').onclick = closeDrawer;
  }

  // ---------- 반·학생 ----------
  async function loadStudents() {
    [classes, students] = await Promise.all([api('/classes'), api('/students')]);
    $('#classes').innerHTML = classes.length ? classes.map((c) => `<div class="card cls">
        <div class="row-head" style="margin:0"><h2>${esc(c.name)}</h2><span class="pill">${esc(GRADE[c.grade_band] || '')} ${esc(SUBJ[c.subject] || '')}</span><span class="sp"></span><span class="note">학생 ${c.students}명</span></div>
        <div class="url">${esc(c.qrUrl)}</div>
        <div class="note">📚 리포트 학습 코스: ${c.course ? esc(c.course.line) : '<span style="color:var(--warn)">설정 안 됨 (반 수정에서 학년 선택)</span>'}</div>
        <div class="acts"><button class="btn small" data-copy="${esc(c.qrUrl)}">주소 복사</button><button class="btn ghost small" data-qr="${esc(c.id)}">QR 보기·저장</button><button class="btn ghost small" data-edit-class="${esc(c.id)}">반 수정</button></div>
      </div>`).join('') : '<div class="card empty">아직 반이 없어요. "+ 반 만들기"로 시작해 주세요.</div>';
    $$('[data-copy]').forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('주소를 복사했어요. 카톡에 붙여 넣으세요'); } catch { prompt('이 주소를 복사하세요', b.dataset.copy); } }));
    $$('[data-qr]').forEach((b) => (b.onclick = () => {
      const c = classes.find((x) => x.id === b.dataset.qr);
      openDrawer(top(`${c.name} 질문방 QR`) + `<img src="/api/director/classes/${esc(c.id)}/qr.png" alt="${esc(c.name)} QR 코드" style="width:100%;max-width:360px;align-self:center;background:#fff;border-radius:12px;padding:8px">
        <a class="btn" href="/api/director/classes/${esc(c.id)}/qr.png" download="${esc(c.name)}-QR.png">QR 이미지 저장</a>
        <p class="note">교실에 붙일 때 아래에 "출석번호 + 비밀번호 4자리로 로그인"이라고 적어 두면 좋아요.</p><div class="url" style="font-size:12.5px;word-break:break-all">${esc(c.qrUrl)}</div>`);
    }));
    $$('[data-edit-class]').forEach((b) => (b.onclick = () => classForm(classes.find((x) => x.id === b.dataset.editClass))));
    $('#st-table').innerHTML = '<tr><th>반</th><th>출석번호</th><th>이름</th><th>학부모 번호</th><th>리포트 동의</th><th>이번 주 질문</th><th></th></tr>' +
      (students.length ? students.map((s) => `<tr><td>${esc(s.class_name || '-')}</td><td>${esc(s.login_code)}</td><td><b>${esc(s.nickname)}</b>${s.is_under_14 ? ' <span class="pill">14세 미만</span>' : ''}</td>
        <td class="note">${esc(s.guardianPhone || '미등록')}</td><td>${s.report_ok && !s.report_opt_out ? '<span class="pill ok">동의</span>' : '<span class="pill warn">동의 전</span>'}</td>
        <td>${s.week_questions}</td><td><button class="btn ghost small" data-edit="${esc(s.id)}">수정</button></td></tr>`).join('')
        : '<tr><td colspan="7"><div class="empty">등록된 학생이 없어요</div></td></tr>');
    $$('[data-edit]').forEach((b) => (b.onclick = () => studentForm(students.find((x) => x.id === b.dataset.edit))));
  }
  $('#add-class').onclick = () => classForm(null);
  $('#add-student').onclick = async () => { if (!classes.length) classes = await api('/classes'); if (!classes.length) return toast('먼저 반을 만들어 주세요'); studentForm(null); };

  function classForm(c) {
    const guessGrade = (gb) => ({ elementary: '초5', middle: '중2', high: '고1' }[gb] || '');
    const p = openDrawer(top(c ? '반 수정' : '반 만들기') + `<form class="form" id="cf">
      <label class="f">반 이름<input id="cf-name" maxlength="40" value="${esc(c?.name || '')}" placeholder="예: 중2 수학 A반" required></label>
      <label class="f">과목<select id="cf-subj">${Object.entries(SUBJ).map(([k, v]) => `<option value="${k}" ${c?.subject === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="f">학년<select id="cf-grade">${Object.entries(GRADE).map(([k, v]) => `<option value="${k}" ${(c?.grade_band || 'middle') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <h3 style="margin:8px 0 0;font-size:15px">📚 학습 코스 (자동 학습 리포트·상담글에 들어가요)</h3>
      <div class="form two">
        <label class="f">코스 학년<select id="cf-cgrade"><option value="">선택 안 함</option></select></label>
        <label class="f">단위<select id="cf-cmode"><option value="month">월별</option><option value="quarter">분기별</option><option value="off">사용 안 함</option></select></label>
      </div>
      <label class="f">보낼 코스<select id="cf-cpin"></select></label>
      <div id="cf-plan" class="note"></div>
      <button class="btn" type="submit">${c ? '저장' : '반 만들기'}</button><p class="msg" id="cf-msg"></p></form>`);
    const sel = (id) => $(id, p);
    let plan = null;
    async function loadPlan() {
      const subj = sel('#cf-subj').value, grade = sel('#cf-cgrade').value, mode = sel('#cf-cmode').value;
      const pinSel = sel('#cf-cpin'), keep = pinSel.dataset.v ?? (c?.course_pin != null ? String(c.course_pin) : '');
      if (!['math', 'english'].includes(subj)) { sel('#cf-plan').textContent = '학습 코스는 영어·수학 반에서 쓸 수 있어요.'; pinSel.innerHTML = ''; return; }
      if (!grade || mode === 'off') { sel('#cf-plan').textContent = mode === 'off' ? '자동 리포트에 학습 코스를 넣지 않아요.' : '코스 학년을 고르면 1년 코스가 보여요.'; pinSel.innerHTML = ''; return; }
      plan = await api(`/courses?subject=${subj}&grade=${encodeURIComponent(grade)}`);
      const list = mode === 'quarter' ? plan.quarters.map((q) => [q.quarter, q.label]) : plan.months.map((m) => [m.month, m.label]);
      pinSel.innerHTML = `<option value="">자동 (지금 ${mode === 'quarter' ? plan.nowQuarter + '분기' : plan.nowMonth + '월'} 기준으로 바뀜)</option>` +
        list.map(([v, l]) => `<option value="${v}">${esc(l)} 고정</option>`).join('');
      pinSel.value = list.some(([v]) => String(v) === keep) ? keep : '';
      delete pinSel.dataset.v;
      const now = mode === 'quarter' ? plan.nowQuarter : plan.nowMonth, picked = Number(pinSel.value) || now;
      const rows = mode === 'quarter'
        ? plan.quarters.map((q) => `<tr${q.quarter === picked ? ' style="font-weight:700;background:var(--brand-soft)"' : ''}><td>${esc(q.label)}</td><td>${esc(q.title)}</td></tr>`)
        : plan.months.map((m) => `<tr${m.month === picked ? ' style="font-weight:700;background:var(--brand-soft)"' : ''}><td>${esc(m.label)}</td><td>${esc(m.title)}<div class="note">${esc(m.focus)}</div></td></tr>`);
      sel('#cf-plan').innerHTML = `<div class="tbl" style="max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:10px"><table>${rows.join('')}</table></div>
        <p class="note">굵게 표시된 코스가 학부모님 리포트에 들어가요. 가정에서 도와주실 한 가지도 함께 안내돼요.</p>`;
      const box = sel('#cf-plan .tbl'), on = box && [...box.querySelectorAll('tr')].find((tr) => tr.style.fontWeight === '700');
      if (on) box.scrollTop = Math.max(0, on.offsetTop - 50);   // 지금 들어갈 코스가 보이게
    }
    const gSel = sel('#cf-cgrade');
    (async () => {
      const g = (await api('/courses')).grades;
      gSel.innerHTML += g.map((x) => `<option value="${x}">${x}</option>`).join('');
      gSel.value = c?.course_grade || guessGrade(sel('#cf-grade').value);
      sel('#cf-cmode').value = c?.course_mode || 'month';
      loadPlan().catch((e) => msg('#cf-msg', e.message));
    })();
    ['#cf-subj', '#cf-cgrade'].forEach((id) => sel(id).addEventListener('change', () => loadPlan().catch(() => {})));
    sel('#cf-cmode').addEventListener('change', () => { sel('#cf-cpin').dataset.v = ''; loadPlan().catch(() => {}); });
    sel('#cf-cpin').addEventListener('change', () => { sel('#cf-cpin').dataset.v = sel('#cf-cpin').value; loadPlan().catch(() => {}); });
    $('#cf', p).onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: $('#cf-name').value.trim(), subject: $('#cf-subj').value, grade_band: $('#cf-grade').value,
        course_grade: gSel.value || null, course_mode: sel('#cf-cmode').value, course_pin: sel('#cf-cpin').value || null };
      try { await api(c ? `/classes/${c.id}` : '/classes', { method: c ? 'PUT' : 'POST', body }); closeDrawer(); toast(c ? '반 정보를 저장했어요' : '반을 만들었어요. 주소(QR)가 생겼어요'); loadStudents(); }
      catch (err) { msg('#cf-msg', err.message); }
    };
  }

  function studentForm(s) {
    const p = openDrawer(top(s ? `${s.nickname} 학생 수정` : '학생 등록') + `<form class="form" id="sf">
      <label class="f">반<select id="sf-class">${classes.map((c) => `<option value="${esc(c.id)}" ${s?.class_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <div class="form two"><label class="f">출석번호 (숫자)<input id="sf-code" inputmode="numeric" maxlength="4" value="${esc(s?.login_code || '')}" required></label>
      <label class="f">${s ? '새 비밀번호 4자리 (바꿀 때만)' : '비밀번호 4자리'}<input id="sf-pin" inputmode="numeric" maxlength="4" ${s ? '' : 'required'} autocomplete="off"></label></div>
      <label class="f">부르는 이름 (튜터·상담글에 쓰여요. 성은 빼도 돼요)<input id="sf-nick" maxlength="12" value="${esc(s?.nickname || '')}" placeholder="예: 민준" required></label>
      ${s ? '' : '<label class="f">실명 (선택 · 암호화해서 보관, 튜터에게는 안 보내요)<input id="sf-real" maxlength="20"></label>'}
      <label class="check"><input type="checkbox" id="sf-u14" ${s ? (s.is_under_14 ? 'checked' : '') : 'checked'}> 만 14세 미만 (보호자 동의 필요)</label>
      <label class="f">학부모 휴대폰 ${s?.guardianPhone ? `(지금: ${esc(s.guardianPhone)} · 바꿀 때만 입력)` : '(금요일 상담 알림톡 받을 번호)'}<input id="sf-phone" inputmode="tel" maxlength="13" placeholder="010-0000-0000"></label>
      <label class="check"><input type="checkbox" id="sf-consent"> 학부모님 개인정보·리포트 수신 동의서를 확인했어요 ${s?.report_ok ? '(이미 동의됨)' : ''}</label>
      <button class="btn" type="submit">${s ? '저장' : '학생 등록'}</button><p class="msg" id="sf-msg"></p>
      ${s ? '<button class="btn danger" type="button" id="sf-out">퇴원 처리</button><p class="note">퇴원 처리하면 질문방에 들어올 수 없고, 학생 수(요금제 정원)에서 빠져요.</p>' : ''}
    </form>`);
    $('#sf', p).onsubmit = async (e) => {
      e.preventDefault();
      const phone = $('#sf-phone').value.trim();
      const body = { class_id: $('#sf-class').value, login_code: $('#sf-code').value.trim(), nickname: $('#sf-nick').value.trim(), is_under_14: $('#sf-u14').checked };
      const pin = $('#sf-pin').value.trim(); if (pin) body.pin = pin;
      if (!s) body.real_name = $('#sf-real').value.trim() || undefined;
      if (phone || $('#sf-consent').checked) {
        if (!phone && !s?.guardianPhone) return msg('#sf-msg', '동의를 체크하려면 학부모 번호를 넣어 주세요');
        if (phone) body.guardian = { phone, consent_confirmed: $('#sf-consent').checked };
      }
      if (s && !phone && $('#sf-consent').checked) return msg('#sf-msg', '동의 확인을 저장하려면 학부모 번호를 한 번 더 입력해 주세요');
      try {
        const r = await api(s ? `/students/${s.id}` : '/students', { method: s ? 'PATCH' : 'POST', body });
        closeDrawer(); students = [];
        toast(s ? (r.pinChanged ? '저장했어요. 새 비밀번호를 학생에게 알려 주세요' : '저장했어요') : `${body.nickname} 학생을 등록했어요`);
        if (!s && r.capacity?.message) setTimeout(() => toast(r.capacity.message), 2700);
        loadStudents();
      } catch (err) { msg('#sf-msg', err.message); }
    };
    if (s) $('#sf-out', p).onclick = async (e) => {
      const b = e.currentTarget;
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '한 번 더 누르면 퇴원 처리돼요'; return; }
      try { await api(`/students/${s.id}`, { method: 'PATCH', body: { active: false } }); closeDrawer(); students = []; toast('퇴원 처리했어요'); loadStudents(); }
      catch (err) { msg('#sf-msg', err.message); }
    };
  }

  // ---------- 주간 상담 ----------
  let cs = null;
  async function loadCounsel() {
    cs = await api('/counsel');
    $('#cs-lead').textContent = `${cs.week} 주 · ${cs.sendAt} 학부모님께 1:1 발송 예정${cs.statsFallback ? ' · 승인 안 된 학생은 자동 학습 리포트로 대신 발송' : ''}`;
    const su = cs.summary;
    $('#cs-flow').innerHTML = [['empty', '작성 전'], ['draft', '초안 · 확인 필요'], ['approved', '승인 · 발송 대기'], ['sent', '발송 완료'], ['failed', '발송 실패']]
      .map(([k, l]) => `<span><b>${su[k] || 0}</b>${l}</span>`).join('');
    $('#cs-table').innerHTML = '<tr><th>학생</th><th>과목</th><th>이번 주 학습 상태/진도</th><th>수업 태도/특이사항</th><th>튜터 기록</th><th>상태</th><th></th></tr>' +
      (cs.rows.length ? cs.rows.map((r) => {
        const st = CS[r.status || 'empty'] || ['', r.status];
        const lock = r.status === 'sent';
        const a = r.ai_stats || {};
        const chip = [a.questions ? `질문 ${a.questions} · 해결 ${Math.round((a.solved / a.questions) * 100)}%` : '', a.feedback ? `첨삭 ${a.feedback.count}` : '',
          a.notes?.weakness?.length ? `헷갈림: ${a.notes.weakness[0]}` : ''].filter(Boolean).join(' · ') || '기록 없음';
        return `<tr data-sid="${esc(r.student_id)}"><td><b>${esc(r.nickname)}</b><div class="note">${esc(r.class_name || '')}${r.can_send ? '' : ' · <span style="color:var(--warn)">수신 동의 없음</span>'}</div></td>
          <td class="kw"><input data-f="subject" value="${esc(r.subject || SUBJ[r.class_subject] || '')}" style="min-width:70px;width:80px" ${lock ? 'disabled' : ''}></td>
          <td class="kw"><input data-f="progress" value="${esc(r.progress || '')}" placeholder="예: 일차함수 진도 완료, 기울기 연습" ${lock ? 'disabled' : ''}></td>
          <td class="kw"><input data-f="attitude" value="${esc(r.attitude || '')}" placeholder="예: 질문 늘어남, 숙제 1번 누락" ${lock ? 'disabled' : ''}></td>
          <td class="note" style="min-width:140px">${esc(chip)}</td><td><span class="pill ${st[0]}">${esc(st[1])}</span></td>
          <td><button class="btn small ${r.final_text ? 'ghost' : ''}" data-cs-open="${esc(r.student_id)}">${r.final_text ? '열기·수정' : '상담글 생성'}</button></td></tr>`;
      }).join('') : '<tr><td colspan="7"><div class="empty">등록된 학생이 없어요</div></td></tr>');
    $$('#cs-table input').forEach((inp) => {
      inp.classList.add('f'); inp.style.cssText += ';border:1px solid var(--line);border-radius:8px;padding:7px 9px;background:var(--surface);width:100%';
      inp.onchange = () => saveRow(inp.closest('tr').dataset.sid);
    });
    $$('[data-cs-open]').forEach((b) => (b.onclick = () => openCounsel(b.dataset.csOpen)));
  }
  async function saveRow(sid) {
    const tr = $(`#cs-table tr[data-sid="${sid}"]`); const v = (f) => $(`input[data-f="${f}"]`, tr).value;
    try { await api(`/counsel/${sid}`, { method: 'PUT', body: { subject: v('subject'), progress: v('progress'), attitude: v('attitude') } }); toast('저장했어요'); }
    catch (e) { toast(e.message); }
  }
  async function openCounsel(sid) {
    const r = cs.rows.find((x) => x.student_id === sid);
    const tr = $(`#cs-table tr[data-sid="${sid}"]`);
    if (!r.final_text) {
      const v = (f) => $(`input[data-f="${f}"]`, tr).value;
      await api(`/counsel/${sid}`, { method: 'PUT', body: { subject: v('subject'), progress: v('progress'), attitude: v('attitude') } }).catch(() => {});
    }
    const p = openDrawer(top(`${r.nickname} 학부모님 상담글`) + `<div class="editor form">
      <p class="note" style="margin:0">${esc(cs.sendAt)} 발송 예정 · 승인한 글만 발송돼요. 고친 뒤에는 다시 승인해 주세요.</p>
      <label class="f">본문<textarea id="ed-text" placeholder="'AI 초안 만들기'를 누르면 원장님 말투로 초안이 생겨요">${esc(r.final_text || '')}</textarea></label>
      <div class="counter" id="ed-count"></div><ul class="warnlist" id="ed-warn"></ul>
      <div class="acts"><button class="btn ghost" id="ed-gen">${r.final_text ? '다시 생성' : 'AI 초안 만들기'}</button><button class="btn ghost" id="ed-save">수정 저장</button>
        <span style="flex:1"></span>${r.status === 'approved' ? '<button class="btn ghost" id="ed-unok">승인 취소</button>' : ''}<button class="btn" id="ed-ok" ${r.status === 'sent' ? 'disabled' : ''}>승인하고 발송 예약</button></div>
      <p class="msg" id="ed-msg"></p></div>`);
    const ta = $('#ed-text', p);
    const count = () => { const n = [...ta.value].length; const c = $('#ed-count'); c.textContent = `${n} / ${cs.maxChars}자`; c.className = 'counter' + (n > cs.maxChars ? ' over' : ''); };
    ta.oninput = count; count();
    if (r.status === 'sent') ta.disabled = true;
    const showWarn = (w) => { $('#ed-warn').innerHTML = (w || []).map((x) => `<li>${esc(x)}</li>`).join(''); };
    $('#ed-gen', p).onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = '원장님 말투로 쓰는 중…';
      try { const g = await api(`/counsel/${sid}/generate`, { body: {} }); ta.value = g.text; count(); showWarn(g.warnings); msg('#ed-msg', '초안이 생겼어요. 읽어 보고 고친 다음 승인해 주세요', true); }
      catch (err) { msg('#ed-msg', err.message); }
      finally { b.disabled = false; b.textContent = '다시 생성'; }
    };
    $('#ed-save', p).onclick = async () => {
      try { const s2 = await api(`/counsel/${sid}/text`, { method: 'PUT', body: { text: ta.value } }); showWarn(s2.warnings); msg('#ed-msg', s2.needsReapproval ? '저장했어요. 다시 승인해야 발송돼요' : '저장했어요', true); }
      catch (err) { msg('#ed-msg', err.message); }
    };
    $('#ed-ok', p).onclick = async () => {
      try {
        await api(`/counsel/${sid}/text`, { method: 'PUT', body: { text: ta.value } });
        const a = await api(`/counsel/${sid}/approve`, { body: {} }); closeDrawer(); toast(`승인했어요 · ${a.sendAt} 발송`); loadCounsel();
      } catch (err) { msg('#ed-msg', err.message); }
    };
    $('#ed-unok', p)?.addEventListener('click', async () => { await api(`/counsel/${sid}/unapprove`, { body: {} }); closeDrawer(); toast('승인을 취소했어요'); loadCounsel(); });
  }
  $('#bulk-gen').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = '생성 중… (학생 수에 따라 1~2분)';
    try { const r = await api('/counsel/bulk/generate', { body: {} }); toast(`${r.generated}명 초안을 만들었어요`); loadCounsel(); }
    catch (err) { toast(err.message); } finally { b.disabled = false; b.textContent = '키워드 있는 학생 일괄 생성'; }
  };
  $('#bulk-ok').onclick = async (e) => {
    const b = e.currentTarget;
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '한 번 더 누르면 초안 전부 승인'; setTimeout(() => { b.dataset.sure = ''; b.textContent = '초안 모두 승인'; }, 4000); return; }
    try { const r = await api('/counsel/bulk/approve', { body: {} }); toast(`${r.approved}명 승인 · ${r.sendAt} 발송`); loadCounsel(); }
    catch (err) { toast(err.message); } finally { b.dataset.sure = ''; b.textContent = '초안 모두 승인'; }
  };

  // ---------- 첨삭 기록 ----------
  async function loadFeedback() {
    const r = await api('/feedback');
    const w = r.week;
    $('#fb-week').innerHTML = w ? `<h2>이번 주 첨삭 ${w.count}회 <span class="note">영어 영작 ${w.english} · 수학 풀이 ${w.math} · 짚은 실수 ${w.errors}개 중 스스로 고친 것 ${w.fixed}개</span></h2>
      <div>${(w.top || []).map((t) => `<span class="pill warn" style="margin-right:6px">${esc(t.type)} ${t.n}회</span>`).join('')}${w.mathPattern ? `<span class="pill brand">수학 ${esc(w.mathPattern)}</span>` : ''}</div>` : '<div class="empty">이번 주 첨삭이 아직 없어요</div>';
    $('#fb-table').innerHTML = '<tr><th>시각</th><th>학생</th><th>과목</th><th>짚은 실수</th><th>스스로 고침</th><th>단계</th></tr>' +
      (r.reviews.length ? r.reviews.map((x, i) => `<tr class="click" data-fb="${i}"><td class="note">${time(x.created_at)}</td><td><b>${esc(x.nickname)}</b></td><td>${x.subject === 'english' ? '영어 영작' : '수학 풀이'}</td>
        <td>${x.error_count}</td><td>${x.fixed_count}</td><td><span class="pill">${{ hinted: '힌트만 봄', retried: '다시 풀었음', revealed: '고친 표현 공개', perfect: '완벽' }[x.stage] || x.stage}</span></td></tr>`).join('')
        : '<tr><td colspan="6"><div class="empty">첨삭 기록이 없어요</div></td></tr>');
    $$('#fb-table tr[data-fb]').forEach((tr) => (tr.onclick = () => {
      const x = r.reviews[tr.dataset.fb];
      openDrawer(top(`${x.nickname} · ${x.subject === 'english' ? '영어 영작' : '수학 풀이'} 첨삭`) + `<div class="bub student" style="align-self:stretch;max-width:100%">${esc(x.transcript)}</div>
        ${(x.items || []).map((it) => `<div class="bub ai" style="max-width:100%">[${esc(it.type)}] ${esc(it.original || it.line)}${it.corrected ? ' → ' + esc(it.corrected) : ''}${it.fixed ? '  ✔ 스스로 고침' : ''}${it.explain ? '\n' + esc(it.explain) : ''}</div>`).join('')}
        ${x.praise ? `<div class="sumcard"><b>칭찬</b>${esc(x.praise)}</div>` : ''}`);
    }));
  }

  // ---------- 설정 ----------
  let persona = null;
  async function loadSettings() {
    const [p, mats, cls] = await Promise.all([api('/persona'), api('/materials'), api('/classes')]);
    persona = p; classes = cls;
    $$('#mode-form input[name=mode]').forEach((r) => (r.checked = r.value === (p.teaching_mode || 'hint_ladder')));
    $('#p-name').value = p.persona_name || ''; $('#p-style').value = p.persona_style || ''; $('#p-examples').value = p.persona_examples || '';
    $('#p-counsel').value = p.counsel_tone || ''; $('#p-sign').value = p.counsel_signature || '';
    $('#r-day').value = String(p.report_weekday); $('#r-time').value = String(p.report_time || '18:00').slice(0, 5);
    $('#r-enabled').checked = !!p.report_enabled; $('#r-fallback').checked = !!p.stats_fallback;
    $('#a-name').value = me.academy.name || ''; $('#a-dir').value = me.academy.director_name || '';
    $('#m-class').innerHTML = '<option value="">모든 반</option>' + cls.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('#mat-list').innerHTML = mats.length ? mats.map((m) => `<div class="card" style="padding:12px;margin-top:8px;box-shadow:none"><div class="row-head" style="margin:0"><b>${esc(m.title)}</b><span class="pill">${esc(m.class_name || '모든 반')}</span><span class="sp"></span><button class="btn ghost small" data-mat-del="${esc(m.id)}">내리기</button></div><div class="note">${esc(m.scope_note)}</div></div>`).join('') : '<p class="note">등록된 교재가 없어요</p>';
    $$('[data-mat-del]').forEach((b) => (b.onclick = async () => { await api(`/materials/${b.dataset.matDel}`, { method: 'DELETE' }); toast('교재를 내렸어요'); loadSettings(); }));
  }
  async function savePersona(patch, msgId, okText) {
    try { persona = { ...persona, ...patch }; await api('/persona', { method: 'PUT', body: persona }); msg(msgId, okText, true); }
    catch (e) { msg(msgId, e.message); }
  }
  $('#mode-form').onsubmit = (e) => { e.preventDefault(); const v = $('#mode-form input[name=mode]:checked')?.value; savePersona({ teaching_mode: v }, '#mode-msg', '저장했어요. 다음 질문부터 이 방식으로 답해요'); };
  $('#persona-form').onsubmit = (e) => { e.preventDefault(); savePersona({ persona_name: $('#p-name').value.trim() || '원장쌤', persona_style: $('#p-style').value, persona_examples: $('#p-examples').value }, '#persona-msg', '말투를 저장했어요'); };
  $('#report-form').onsubmit = (e) => {
    e.preventDefault();
    savePersona({ report_weekday: Number($('#r-day').value), report_time: $('#r-time').value || '18:00', report_enabled: $('#r-enabled').checked, stats_fallback: $('#r-fallback').checked,
      counsel_tone: $('#p-counsel').value, counsel_signature: $('#p-sign').value }, '#report-msg', '발송 설정을 저장했어요');
  };
  $('#mat-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/materials', { body: { class_id: $('#m-class').value || null, title: $('#m-title').value.trim(), scope_note: $('#m-scope').value.trim(), content: $('#m-content').value } });
      ['#m-title', '#m-scope', '#m-content'].forEach((s) => ($(s).value = '')); msg('#mat-msg', '교재를 추가했어요', true); loadSettings();
    } catch (err) { msg('#mat-msg', err.message); }
  };
  $('#academy-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/academy', { method: 'PUT', body: { name: $('#a-name').value.trim(), director_name: $('#a-dir').value.trim(), contact_phone: $('#a-phone').value.trim() || undefined } });
      me = await api('/me'); $('#acad-name').textContent = me.academy.name; msg('#academy-msg', '학원 정보를 저장했어요', true);
    } catch (err) { msg('#academy-msg', err.message); }
  };
  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/password', { method: 'PUT', body: { current: $('#pw-cur').value, next: $('#pw-new').value } }); $('#pw-cur').value = $('#pw-new').value = ''; msg('#pw-msg', '비밀번호를 바꿨어요', true); }
    catch (err) { msg('#pw-msg', err.message); }
  };

  // ---------- 요금 ----------
  async function loadBilling() {
    const s = await api('/plan');
    const won = (n) => Number(n).toLocaleString('ko-KR');
    $('#bl-lead').textContent = `지금 ${s.plan.name} · 월 ${won(s.plan.monthlyKrw)}원${s.plan.priceLocked ? ' (출시 기념가 평생 고정)' : ''} · 상태: ${{ trial: '무료 체험', active: '이용 중', past_due: '결제 확인 필요', canceled: '해지됨' }[s.academy.plan_status] || s.academy.plan_status}`;
    const meter = (label, used, limit) => {
      if (limit == null) return `<div class="card"><h2>${label}</h2><p class="note" style="margin:0">제한 없음 (이번 달 ${used ?? 0})</p></div>`;
      const pct = Math.min(100, (used / limit) * 100);
      return `<div class="card"><h2>${label}</h2><div class="meter ${used >= limit ? 'over' : used >= limit * 0.8 ? 'full' : ''}"><i style="width:${pct}%"></i></div><span class="note">${used} / ${limit}</span></div>`;
    };
    $('#bl-usage').innerHTML = meter('활성 학생', s.activeStudents, s.plan.maxStudents) + meter('이번 달 사진 질문 (학원 전체)', s.photo.used, s.photo.limit) + meter('이번 달 첨삭 (학원 전체)', s.feedback?.used, s.feedback?.limit)
      + (s.capacity?.message ? `<div class="card"><h2>안내</h2><p style="margin:0">${esc(s.capacity.message)}</p></div>` : '');
    $('#bl-plans').innerHTML = s.plans.map((p) => `<div class="plan ${p.code === s.plan.code ? 'cur' : ''}">
      <div class="row-head" style="margin:0"><b>${esc(p.name)}</b>${p.popular ? `<span class="pill warn">${esc(p.popular)}</span>` : ''}</div>
      <div class="price">월 ${won(p.priceKrw)}원 ${p.listPriceKrw ? `<s class="note">${won(p.listPriceKrw)}원</s>` : ''}</div>
      <div class="note">${esc(p.audience)}</div>
      <ul>${p.features.map((f) => `<li class="${f.ready ? '' : 'soon'}">${esc(f.label)}${f.ready ? '' : ' (곧 제공)'}</li>`).join('')}</ul>
      ${p.code === s.plan.code ? '<span class="pill brand" style="align-self:flex-start">지금 요금제</span>' : `<button class="btn ghost small" data-plan="${esc(p.code)}" style="align-self:flex-start">이 요금제로 변경</button>`}
    </div>`).join('');
    $$('[data-plan]').forEach((b) => (b.onclick = async () => {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '한 번 더 누르면 변경 (다음 결제일부터 적용)'; return; }
      try { await api('/plan/change', { body: { code: b.dataset.plan } }); toast('요금제를 바꿨어요'); loadBilling(); }
      catch (err) { $('#bl-msg').textContent = err.message; $('#bl-msg').className = 'msg err'; }
    }));
  }

  boot();
})();
