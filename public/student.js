// 학생 질문창 (실제 서버 연결) — /s/<반 QR 토큰>
(() => {
  const $ = (s) => document.querySelector(s);
  const token = decodeURIComponent(location.pathname.split('/')[2] || '');
  const LEVELS = ['어디서 막혔는지 확인', '필요한 개념 짚기', '첫 단계 방향', '비슷한 예제', '내 풀이 점검'];
  const MAX_EDGE = 1568;          // Claude 권장 긴 변 크기
  const JPEG_QUALITY = 0.85;
  let sessionId = null, level = 0, photo = null, busy = false, persona = '원장쌤', quota = null;
  // 첨삭: fb = { subject:'english'|'math', limit, remaining }, fbMode = 켜짐 여부, retryOf = 고쳐 쓰기 중인 첨삭
  let fb = null, fbMode = false, retryOf = null;
  // 지도 방식: hint_ladder(힌트 4단계) / key_hint(핵심 힌트형: 수학 풀이 전체 → 이해 확인 → 오답노트)
  let teachingMode = 'hint_ladder';
  const keyHint = () => teachingMode === 'key_hint';
  function applyMode() {
    // 핵심 힌트형은 단계 표시가 필요 없고, "힌트 하나 더" 대신 "다시 쉽게 설명해 줘"
    $('#more-hint').textContent = keyHint() ? '🙋 다시 쉽게 설명해 줘' : '💡 힌트 하나 더';
    if (keyHint()) $('#ladder-wrap').hidden = true;
  }
  const FB = {
    english: { chip: '✍️ 영작 첨삭', what: '영어 글을', mode: '쓴 영어 글을 붙여 넣거나 📷 사진으로 올려 줘', retry: '힌트를 보고 고쳐 쓴 글을 보내 줘 (사진도 OK)', place: '내가 쓴 영어 글을 붙여 넣어 줘' },
    math: { chip: '🔢 풀이 첨삭', what: '풀이를', mode: '공책에 푼 풀이를 📷 사진으로 올려 줘', retry: '그 줄부터 다시 푼 풀이를 보내 줘', place: '풀이를 적거나 사진으로 올려 줘' },
  };

  // ---- 공통 ----
  async function api(path, body) {
    const res = await fetch('/api/student' + path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || '잠시 후 다시 해 줘'), { status: res.status, data });
    return data;
  }
  const now = () => new Date().toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  const scrollDown = () => requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
  let lastAiRow = null;

  // 말풍선: AI는 왼쪽 아바타 + 둥근 카드, 학생은 오른쪽 인디고
  function add(role, text, imgUrl) {
    if (role === 'sys') {
      const d = document.createElement('div'); d.className = 'sys'; d.textContent = text;
      $('#chat').appendChild(d); scrollDown(); lastAiRow = null; return d;
    }
    const row = document.createElement('div');
    row.className = 'row ' + (role === 'ai' ? 'ai' : 'me');
    const stack = document.createElement('div'); stack.className = 'stack';
    if (role === 'ai') {
      row.appendChild($('#avatar-tpl').content.cloneNode(true));
      const who = document.createElement('div'); who.className = 'who'; who.textContent = persona; stack.appendChild(who);
    }
    const b = document.createElement('div'); b.className = 'bubble';
    if (imgUrl) { const i = document.createElement('img'); i.src = imgUrl; i.alt = '보낸 문제 사진'; b.appendChild(i); if (!text) b.classList.add('photo-only'); }
    if (text) b.appendChild(document.createTextNode(text));
    stack.appendChild(b);
    const t = document.createElement('div'); t.className = 'time'; t.textContent = now(); stack.appendChild(t);
    row.appendChild(stack);
    $('#chat').appendChild(row); scrollDown();
    lastAiRow = role === 'ai' ? row : null;
    return row;
  }
  function typing(label) {
    const row = document.createElement('div'); row.className = 'row ai typing'; row.setAttribute('role', 'status');
    row.appendChild($('#avatar-tpl').content.cloneNode(true));
    const b = document.createElement('div'); b.className = 'bubble';
    b.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    b.appendChild(document.createTextNode(label));
    row.appendChild(b); $('#chat').appendChild(row); scrollDown();
    return row;
  }
  function renderLadder() {
    document.querySelectorAll('#ladder span').forEach((s, i) => s.classList.toggle('on', i <= level));
    $('#ladder-label').textContent = `힌트 ${level}단계 · ${LEVELS[level]}`;
  }
  // 라이트 플랜: 카메라 버튼에 이번 달 남은 사진 질문 수 표시
  function renderQuota(p) {
    if (p) quota = p;
    const badge = $('#cam-badge');
    if (!quota || quota.limit == null) { badge.hidden = true; $('#sheet-tip').textContent = '문제 하나가 화면에 꽉 차게, 그림자 없이 찍어 줘.'; return; }
    badge.hidden = false; badge.textContent = quota.remaining;
    badge.className = 'cam-badge' + (quota.remaining === 0 ? ' zero' : quota.remaining <= 10 ? ' low' : '');
    $('#cam').setAttribute('aria-label', `문제 사진 올리기 (이번 달 ${quota.remaining}회 남음)`);
    $('#sheet-tip').textContent = `이번 달 학원 사진 질문 ${quota.remaining}회 남았어요. 문제 하나가 꽉 차게 찍어 줘.`;
  }
  function showQuota() { $('#quota').hidden = false; $('#quota-ok').focus(); }

  // ---- 첨삭 모드 ----
  function renderFb(u) {
    if (u) fb = { ...fb, ...u };
    if (!fb?.subject) { $('#fb-chip').hidden = true; return; }
    const c = FB[fb.subject];
    $('#fb-chip').hidden = false;
    $('#fb-chip-label').textContent = c.chip;
    $('#fb-chip').classList.toggle('on', fbMode);
    $('#fb-chip').setAttribute('aria-pressed', String(fbMode));
    const n = $('#fb-chip-n');
    n.hidden = fb.limit == null; n.textContent = fb.limit == null ? '' : `${fb.remaining}회`;
    $('#fb-mode').hidden = !fbMode;
    $('#fb-mode-text').innerHTML = '';
    const b = document.createElement('b'); b.textContent = retryOf ? '고쳐 쓰기 · ' : `${c.chip.slice(2)} 모드 · `;
    $('#fb-mode-text').append(b, document.createTextNode(retryOf ? c.retry : c.mode));
    $('#text').placeholder = fbMode ? (retryOf ? '고쳐 쓴 글을 적어 줘' : c.place) : '문제나 내 풀이를 적어 줘';
    $('#ladder-wrap').hidden = fbMode || $('#chat').hidden || keyHint();
    if (fbMode) $('#cam-badge').hidden = true; else renderQuota();   // 첨삭 사진은 사진 질문 횟수와 따로 셈
    ['#more-hint', '#solved', '#new-q'].forEach((s2) => ($(s2).hidden = fbMode));
  }
  function setFbMode(on, retry = null) {
    fbMode = on; retryOf = on ? retry : null;
    renderFb();
    if (on) $('#text').focus();
  }
  $('#fb-chip').onclick = () => {
    if (!fbMode && fb.limit != null && fb.remaining === 0) return showFbQuota();
    setFbMode(!fbMode);
    if (fbMode) add('sys', `${FB[fb.subject].chip} 시작! ${FB[fb.subject].mode}`);
  };
  $('#fb-exit').onclick = () => { setFbMode(false); add('sys', '첨삭 끝! 다시 질문창으로 돌아왔어'); };
  function showFbQuota() { $('#fb-quota').hidden = false; $('#fbq-ok').focus(); }
  $('#fbq-ok').onclick = () => { $('#fb-quota').hidden = true; setFbMode(false); $('#text').focus(); };

  // 첨삭 결과 카드 (AI 말풍선 안)
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fbCard(r) {
    const row = add('ai', '');
    const b = row.querySelector('.bubble'); b.classList.add('fbc'); b.textContent = '';
    if (r.message) b.appendChild(el('p', 'fb-msg', r.message));
    if (r.praise && r.stage === 'hinted') { const p = el('div', 'praise'); p.append(el('span', '', '👏'), el('span', '', r.praise)); b.appendChild(p); }
    if (r.items?.length) {
      const ol = el('ol');
      for (const it of r.items) {
        const li = el('li', it.fixed ? 'fixed' : '');
        const top = el('div', 'top'); top.append(el('span', 'no', String(it.id)), el('span', 'tag', it.type));
        if (it.fixed) top.appendChild(el('span', 'ok-badge', '✔ 스스로 고쳤어!'));
        li.appendChild(top);
        const o = el('div', 'orig');
        if (r.subject === 'english') { const m = el('mark', '', it.original); o.appendChild(m); } else o.textContent = it.line;
        if (!it.corrected) li.appendChild(o);   // 공개된 항목은 아래 '원래 → 고친 표현' 한 줄로 보여 줌
        if (it.corrected) {
          const f = el('div', 'fix'); f.append(el('s', '', it.original), document.createTextNode('→ ' + it.corrected)); li.appendChild(f);
          if (it.explain) li.appendChild(el('div', 'why', it.explain));
        } else if (!it.fixed) li.appendChild(el('div', 'hint-t', '💡 ' + it.hint));
        ol.appendChild(li);
      }
      b.appendChild(ol);
    }
    if (r.canRetry) {
      const acts = el('div', 'acts');
      const again = el('button', '', r.subject === 'english' ? '✏️ 고쳐 쓰기' : '✏️ 다시 풀기');
      again.onclick = () => { setFbMode(true, r.id); add('sys', FB[r.subject].retry); };
      acts.appendChild(again);
      if (r.canReveal) {
        const idk = el('button', 'alt', '🤔 모르겠어요');
        idk.onclick = async () => {
          if (busy) return; busy = true; idk.disabled = again.disabled = true;
          add('me', '🤔 잘 모르겠어요');
          const t = typing('같이 볼게요…');
          try { const x = await api(`/feedback/${r.id}/reveal`, {}); t.remove(); setFbMode(true); fbCard(x); }
          catch (e) { t.remove(); add('sys', e.message); idk.disabled = again.disabled = false; }
          finally { busy = false; updateSend(); }
        };
        acts.appendChild(idk);
      }
      b.appendChild(acts);
      row.dataset.fbId = r.id;
    } else if (r.stage === 'revealed' || r.stage === 'perfect') {
      b.appendChild(el('p', 'done', r.subject === 'english' && r.stage === 'revealed'
        ? '고친 문장을 공책에 한 번 더 써 보면 오래 기억나! 새 글은 그대로 보내면 돼.'
        : '새 글이나 풀이도 그대로 보내면 첨삭해 줄게.'));
    }
    // 같은 첨삭의 예전 카드 버튼은 잠금
    document.querySelectorAll(`.row[data-fb-id="${r.id}"]`).forEach((old) => { if (old !== row) old.querySelectorAll('.acts button').forEach((x) => (x.disabled = true)); });
    return row;
  }
  $('#quota-ok').onclick = () => { $('#quota').hidden = true; $('#text').focus(); };

  function updateSend() { $('#send').disabled = busy || (!$('#text').value.trim() && !photo); }
  function showChat(nickname) {
    $('#login').hidden = true;
    ['#chat', '#bar', '#ladder-wrap', '#logout'].forEach((s) => ($(s).hidden = false));
    if (!$('#chat').childElementCount) add('ai', `${nickname}, 안녕! 어떤 문제가 막혔어?\n글로 적거나 📷 버튼으로 문제 사진을 올려 줘.${fb?.subject ? `\n직접 쓴 ${FB[fb.subject].what} 봐 줬으면 아래 ${FB[fb.subject].chip} 버튼을 눌러 줘.` : ''}`);
    renderLadder(); renderFb(); applyMode(); updateSend();
    maybeShowInstall();
  }

  // ---- 시작: 반 확인 → 로그인 유지 여부 ----
  async function boot() {
    if (!token) { $('#acad').textContent = 'QR 주소를 다시 확인해 줘'; return; }
    $('#manifest-link').href = `/s/${encodeURIComponent(token)}/manifest.webmanifest`;
    try {
      const c = await api(`/class/${encodeURIComponent(token)}`);
      persona = c.personaName || '원장쌤';
      const initial = (c.academyName || '위').trim().charAt(0);
      $('#logo').textContent = initial; $('#install-logo').textContent = initial;
      $('#acad').textContent = c.academyName;
      $('#cls-name').textContent = c.className;
      $('#persona').textContent = persona;
      $('#status-text').textContent = `${persona} 온라인`;
      document.title = `${persona}에게 물어보기`;
    } catch (e) { $('#acad').textContent = e.message; $('#status-pill').hidden = true; return; }
    try {
      const me = await api('/me');
      if (me.classToken === token) { renderQuota(me.photo); fb = me.feedback || null; teachingMode = me.teachingMode || 'hint_ladder'; return showChat(me.nickname); }
    } catch { /* 로그인 필요 */ }
    $('#login').hidden = false;
    $('#code').focus();
  }

  // ---- 로그인 ----
  $('#login-btn').onclick = async () => {
    $('#login-err').textContent = '';
    $('#login-btn').disabled = true;
    try {
      const r = await api('/login', { token, code: $('#code').value.trim(), pin: $('#pin').value.trim() });
      try { const me = await api('/me'); renderQuota(me.photo); fb = me.feedback || null; teachingMode = me.teachingMode || 'hint_ladder'; } catch { /* 표시만 생략 */ }
      showChat(r.nickname);
    } catch (e) { $('#login-err').textContent = e.message; }
    finally { $('#login-btn').disabled = false; }
  };
  $('#pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });
  $('#logout').onclick = async () => { await api('/logout', {}).catch(() => {}); location.reload(); };

  // ---- 사진: 고르기 → 줄이기(긴 변 1568px JPEG) → 미리보기 ----
  // 첨삭 모드의 사진은 사진 질문 횟수와 따로 센다
  $('#cam').onclick = () => {
    if (!fbMode && quota && quota.limit != null && quota.remaining === 0) return showQuota();
    if (fbMode) $('#sheet-tip').textContent = fb.subject === 'english' ? '쓴 글 전체가 화면에 꽉 차게, 글씨가 잘 보이게 찍어 줘.' : '문제와 내 풀이가 같이 보이게 찍어 줘.';
    else renderQuota();
    $('#sheet').hidden = false;
  };
  $('#sheet-cancel').onclick = () => ($('#sheet').hidden = true);
  $('#sheet').onclick = (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; };
  $('#pick-camera').onclick = () => { $('#sheet').hidden = true; $('#file-camera').click(); };
  $('#pick-album').onclick = () => { $('#sheet').hidden = true; $('#file-album').click(); };
  ['#file-camera', '#file-album'].forEach((s) => $(s).addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) await preparePhoto(f);
  }));

  function loadImage(file) {
    return new Promise((ok, fail) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => ok({ img, url }); img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('이 사진은 열 수 없어요. 카메라로 다시 찍어 줄래?')); };
      img.src = url; // 최신 브라우저는 사진 회전(EXIF) 정보를 자동 반영
    });
  }
  async function preparePhoto(file) {
    try {
      const { img, url } = await loadImage(file);
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
      const base64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
      if (photo?.preview) URL.revokeObjectURL(photo.preview);
      photo = { mediaType: 'image/jpeg', base64, preview: URL.createObjectURL(blob) };
      $('#preview-img').src = photo.preview;
      $('#preview-info').textContent = `사진 준비 완료 · ${Math.round(blob.size / 1024)}KB\n궁금한 점을 같이 적어도 좋아`;
      $('#preview').hidden = false;
      if (!fbMode) { sessionId = null; level = 0; renderLadder(); }  // 사진은 보통 새 문제 → 힌트 단계를 처음부터
      updateSend(); $('#text').focus();
    } catch (e) { add('sys', e.message); }
  }
  $('#preview-x').onclick = () => { if (photo?.preview) URL.revokeObjectURL(photo.preview); photo = null; $('#preview').hidden = true; updateSend(); };

  // ---- 첨삭 보내기 ----
  async function sendFeedback() {
    const text = $('#text').value.trim();
    if (!text && !photo) return;
    busy = true; updateSend();
    add('me', text, photo?.preview);
    const body = { text };
    const sent = photo;
    if (sent) body.image = { mediaType: sent.mediaType, base64: sent.base64 };
    $('#text').value = ''; autoGrow(); $('#preview').hidden = true; photo = null;
    const target = retryOf;
    const t = typing(target ? '고친 부분을 확인하고 있어요…' : sent ? '쓴 글을 읽고 있어요…' : '꼼꼼히 보고 있어요…');
    try {
      const r = await api(target ? `/feedback/${target}/retry` : '/feedback', body);
      t.remove();
      if (r.safety) { add('ai', r.reply); setFbMode(false); return; }
      if (r.quota) renderFb({ limit: r.quota.limit, remaining: r.quota.remaining });
      retryOf = null; renderFb();
      fbCard(r);
    } catch (e) {
      t.remove();
      if (e.data?.code === 'FEEDBACK_QUOTA') { renderFb({ limit: e.data.limit, remaining: 0 }); add('ai', e.message); showFbQuota(); }
      else { add('sys', e.message); if (e.status === 401) setTimeout(() => location.reload(), 1200); }
    } finally { busy = false; updateSend(); }
  }

  // ---- 보내기 ----
  async function ask({ moreHint = false } = {}) {
    if (busy) return;
    if (fbMode && !moreHint) return sendFeedback();
    const text = $('#text').value.trim();
    if (!text && !photo && !moreHint) return;
    busy = true; updateSend();
    if (moreHint) add('me', keyHint() ? '🙋 다시 쉽게 설명해 줘' : '💡 힌트 하나 더');
    else add('me', text, photo?.preview);
    const body = { text: moreHint ? (text || (keyHint() ? '조금 더 쉽게 다시 설명해 줘' : '힌트 하나 더 주세요')) : text, sessionId, moreHint };
    const sent = photo && !moreHint ? photo : null;
    if (sent) body.image = { mediaType: sent.mediaType, base64: sent.base64 };
    $('#text').value = ''; autoGrow(); $('#preview').hidden = true; if (sent) photo = null;
    const t = typing(sent ? '사진 속 문제를 읽고 있어요…' : '선생님이 생각 중이에요…');
    try {
      const r = await api('/ask', body);
      sessionId = r.sessionId; level = r.hintLevel; renderLadder();
      if (r.photo) renderQuota(r.photo);
      t.remove(); add('ai', r.reply);
    } catch (e) {
      t.remove();
      if (e.data?.code === 'PHOTO_QUOTA') {
        renderQuota({ used: e.data.used, limit: e.data.limit, remaining: 0 });
        add('ai', e.message);
        showQuota();
      } else {
        add('sys', e.message);
        if (e.status === 401) setTimeout(() => location.reload(), 1200);
      }
    } finally { busy = false; updateSend(); }
  }
  function autoGrow() { const ta = $('#text'); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; }
  $('#send').onclick = () => ask();
  $('#text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } });
  $('#text').addEventListener('input', () => { autoGrow(); updateSend(); });
  $('#more-hint').onclick = () => {
    if (keyHint()) { if (!sessionId) return add('sys', '먼저 문제를 물어봐 줘!'); return ask({ moreHint: true }); }
    if (level >= 4) return add('sys', '마지막 힌트 단계야. 이제 네 풀이를 보내 줘!');
    ask({ moreHint: true });
  };
  $('#solved').onclick = async () => {
    if (!sessionId) return add('sys', '먼저 문제를 물어봐 줘!');
    await api(`/session/${sessionId}/close`, { solved: true }).catch(() => {});
    add('ai', '잘했어! 🎉 스스로 푼 문제로 기록해 둘게. 다음 문제도 화이팅!');
    sessionId = null; level = 0; renderLadder();
  };
  $('#new-q').onclick = () => { sessionId = null; level = 0; renderLadder(); add('sys', '새 문제 시작! 문제를 적거나 사진을 올려 줘'); };

  // ---- 홈 화면에 추가 (PWA) ----
  let deferred = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const dismissed = () => { try { return localStorage.getItem('wai-install-dismissed') === '1'; } catch { return false; } };
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; maybeShowInstall(); }); // 안드로이드 크롬
  function maybeShowInstall() {
    if (standalone || dismissed() || $('#chat').hidden) return;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (deferred) { $('#install-tip').textContent = '버튼 한 번이면 끝!'; $('#install-btn').hidden = false; $('#install').hidden = false; }
    else if (ios) { $('#install-tip').textContent = 'Safari 공유 버튼(□↑) → "홈 화면에 추가"'; $('#install').hidden = false; }
  }
  $('#install-btn').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#install').hidden = true; };
  $('#install-close').onclick = () => { $('#install').hidden = true; try { localStorage.setItem('wai-install-dismissed', '1'); } catch {} };

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  boot();
})();
