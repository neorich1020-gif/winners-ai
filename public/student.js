// 학생 질문창 (실제 서버 연결) — /s/<반 QR 토큰>
(() => {
  const $ = (s) => document.querySelector(s);
  // 미리보기(디자인 시안) 빌드는 window.__MW_TOKEN / __MW_PREVIEW 를 넣어 가짜 서버로 동작한다. 실제 서비스에서는 둘 다 없음.
  const token = window.__MW_TOKEN || decodeURIComponent(location.pathname.split('/')[2] || '');
  const PREVIEW = !!window.__MW_PREVIEW;
  const LEVELS = ['어디서 막혔는지 확인', '필요한 개념 짚기', '첫 단계 방향', '비슷한 예제', '내 풀이 점검'];
  const MAX_EDGE = 1568;          // Claude 권장 긴 변 크기
  const JPEG_QUALITY = 0.85;
  let sessionId = null, level = 0, photo = null, busy = false, persona = '원장쌤', quota = null;
  // 📖 완성 풀이 보기: 핵심 힌트형에서 이 문제의 힌트를 한 번 받은 뒤에만 나타남 (막혀서 포기하지 않게)
  let solAvail = false;
  const setSol = (v) => { solAvail = !!v; const b = document.getElementById('show-sol'); if (b) b.hidden = !solAvail || fbMode; };
  // 첨삭: fb = { subject:'english'|'math', limit, remaining }, fbMode = 켜짐 여부, retryOf = 고쳐 쓰기 중인 첨삭
  let fb = null, fbMode = false, retryOf = null;
  // 지도 방식: hint_ladder(힌트 4단계) / key_hint(핵심 힌트형: 수학 풀이 전체 → 이해 확인 → 오답노트)
  let teachingMode = 'hint_ladder';
  const keyHint = () => teachingMode === 'key_hint';
  function applyMode() {
    // 핵심 힌트형은 단계 표시가 필요 없고, "힌트 하나 더" 대신 "다시 쉽게 설명해 줘" (결정적 힌트는 답변 아래 접힌 칸)
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
    if (text && role === 'ai') { b.classList.add('rich'); b.appendChild(richText(text)); }
    else if (text) b.appendChild(document.createTextNode(text));
    stack.appendChild(b);
    const t = document.createElement('div'); t.className = 'time'; t.textContent = now(); stack.appendChild(t);
    row.appendChild(stack);
    $('#chat').appendChild(row); scrollDown();
    lastAiRow = role === 'ai' ? row : null;
    return row;
  }
  // AI 답변 읽기 쉽게: 구역 제목(📌🧭🔑💡📖) · 단계(1단계 ▶) · 수식 줄 · 답 · '가리고 다시 쓰기' 안내
  // 서버가 이미 보통 글자로 정리한 답을 줄 단위로 나눠 모양만 입힌다 (글자는 textContent로만 넣음)
  const SEC = { '📌': 's-quiz', '🧭': 's-flow', '🔑': 's-key', '💡': 's-concept', '📖': 's-flow', '✨': 's-concept', '🎯': 's-quiz' };
  function richText(text) {
    const frag = document.createDocumentFragment();
    let lastGap = true;
    const div = (cls, t) => { const d = document.createElement('div'); d.className = cls; if (t != null) d.textContent = t; return d; };
    for (const raw of String(text).split('\n')) {
      const l = raw.trim();
      if (!l) { if (!lastGap) { frag.appendChild(div('gap')); lastGap = true; } continue; }
      lastGap = false;
      const em = [...l][0];
      let m;
      if (em === '💡' && /^💡\s*(개념|팁|참고|기억)/.test(l)) {
        frag.appendChild(div('tip', l));            // 💡 개념: … → 문단 속 짧은 메모 상자 (제목처럼 굵게 X)
      } else if (SEC[em] && l.length > 2) {
        const d = div('sec ' + SEC[em]);
        d.append(div('em', em), Object.assign(document.createElement('span'), { textContent: l.slice(em.length).trim() }));
        frag.appendChild(d);
      } else if ((m = l.match(/^(\d{1,2})\s*단계\s*[▶:：.)\-]?\s*(.*)$/))) {
        const d = div('step'); d.append(div('n', m[1]), div('tx', m[2] || '')); frag.appendChild(d);
      } else if ((m = l.match(/^(?:최종\s*)?(?:정)?답\s*[:：]\s*(.+)$/))) {
        const a = div('answer'); const sr = div('sr', ': '); // 화면은 '답' 표시, 읽어 주기·복사는 "답: x = 4"
        a.append(Object.assign(document.createElement('span'), { className: 'lab', textContent: '답' }), sr, document.createTextNode(m[1]));
        frag.appendChild(a);
      } else if (/가리고[\s\S]{0,30}다시\s*(써|풀)/.test(l)) {
        frag.appendChild(div('retry-note', '✍️ ' + l));
      } else if (/[=≤≥<>√∠×÷²³^]/.test(l) && l.replace(/[^가-힣]/g, '').length <= 6) {
        frag.appendChild(div('math', l));
      } else frag.appendChild(div('ln', l));
    }
    return frag;
  }

  // 접어 둔 '🔑 결정적 힌트': 누르면 펼쳐지고, 펼친 기록을 서버에 남긴다 (원장님 화면·상담글용)
  function addHint2(row, text, sid) {
    const box = document.createElement('div'); box.className = 'hint2';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'hint2-btn';
    btn.textContent = '🔑 결정적 힌트 보기'; btn.setAttribute('aria-expanded', 'false');
    const body = document.createElement('div'); body.className = 'hint2-body'; body.hidden = true; body.textContent = text;
    btn.onclick = () => {
      const open = body.hidden;
      body.hidden = !open; btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? '🔑 결정적 힌트 접기' : '🔑 결정적 힌트 보기';
      if (open && !box.dataset.logged) { box.dataset.logged = '1'; api(`/session/${sid}/hint2`, {}).catch(() => {}); }
      if (open) scrollDown();
    };
    box.append(btn, body);
    row.querySelector('.stack').insertBefore(box, row.querySelector('.time'));
  }
  // 📈 그래프: 서버가 계산한 좌표를 진짜 그래프(SVG)로 그린다. "📈 그래프 보기"로 접혀 있다가 펼쳐짐
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, text) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; }
  function niceStep(range) { const raw = range / 8, p = Math.pow(10, Math.floor(Math.log10(raw))); const m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
  function drawGraph(g) {
    const W = 320, H = 280, L = 12, R = 12, T = 12, B = 12;
    const [x0, x1] = g.x, [y0, y1] = g.y;
    const sx = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R), sy = (y) => H - B - ((y - y0) / (y1 - y0)) * (H - T - B);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'graph-svg', role: 'img', 'aria-label': g.title || '그래프' });
    const cid = 'gc' + Math.random().toString(36).slice(2, 8);
    const cp = svgEl('clipPath', { id: cid }); cp.appendChild(svgEl('rect', { x: L, y: T, width: W - L - R, height: H - T - B })); svg.appendChild(cp);
    const grid = svgEl('g', { class: 'g-grid' }), labels = svgEl('g', { class: 'g-tick' });
    const xs = niceStep(x1 - x0), ys = niceStep(y1 - y0);
    const ax = Math.min(Math.max(0, x0), x1), ay = Math.min(Math.max(0, y0), y1);   // 축 위치 (0이 범위 밖이면 가장자리)
    for (let v = Math.ceil(x0 / xs) * xs; v <= x1 + 1e-9; v += xs) {
      grid.appendChild(svgEl('line', { x1: sx(v), y1: T, x2: sx(v), y2: H - B }));
      if (Math.abs(v) > 1e-9) labels.appendChild(svgEl('text', { x: sx(v), y: Math.min(H - B - 2, sy(ay) + 13), 'text-anchor': 'middle' }, +v.toFixed(2)));
    }
    for (let v = Math.ceil(y0 / ys) * ys; v <= y1 + 1e-9; v += ys) {
      grid.appendChild(svgEl('line', { x1: L, y1: sy(v), x2: W - R, y2: sy(v) }));
      if (Math.abs(v) > 1e-9) labels.appendChild(svgEl('text', { x: Math.max(L + 2, sx(ax) - 4), y: sy(v) + 4, 'text-anchor': sx(ax) - 4 < L + 14 ? 'start' : 'end' }, +v.toFixed(2)));
    }
    svg.appendChild(grid);
    const axes = svgEl('g', { class: 'g-axis' });
    axes.appendChild(svgEl('line', { x1: L, y1: sy(ay), x2: W - R, y2: sy(ay) }));
    axes.appendChild(svgEl('line', { x1: sx(ax), y1: T, x2: sx(ax), y2: H - B }));
    axes.appendChild(svgEl('text', { x: W - R - 2, y: sy(ay) - 5, 'text-anchor': 'end', class: 'g-axname' }, 'x'));
    axes.appendChild(svgEl('text', { x: sx(ax) + 6, y: T + 10, class: 'g-axname' }, 'y'));
    if (x0 <= 0 && x1 >= 0 && y0 <= 0 && y1 >= 0) axes.appendChild(svgEl('text', { x: sx(0) - 4, y: sy(0) + 13, 'text-anchor': 'end', class: 'g-tick' }, 'O'));
    svg.appendChild(axes); svg.appendChild(labels);
    const plot = svgEl('g', { 'clip-path': `url(#${cid})` });
    g.series.forEach((s, i) => s.segs.forEach((seg) => {
      plot.appendChild(svgEl('polyline', { class: `g-line c${i % 3}`, points: seg.map(([x, y]) => `${sx(x).toFixed(1)},${sy(Math.max(y0 - (y1 - y0), Math.min(y1 + (y1 - y0), y))).toFixed(1)}`).join(' ') }));
    }));
    svg.appendChild(plot);
    g.points.forEach((pt) => {
      if (pt.x < x0 || pt.x > x1 || pt.y < y0 || pt.y > y1) return;
      svg.appendChild(svgEl('circle', { cx: sx(pt.x), cy: sy(pt.y), r: 4.5, class: 'g-pt' }));
      if (pt.label) {
        const right = sx(pt.x) < W * 0.62;
        svg.appendChild(svgEl('text', { x: sx(pt.x) + (right ? 8 : -8), y: sy(pt.y) - 8, 'text-anchor': right ? 'start' : 'end', class: 'g-ptlabel' }, pt.label));
      }
    });
    return svg;
  }
  function addGraph(row, g) {
    const box = document.createElement('div'); box.className = 'graph';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'graph-btn';
    btn.textContent = '📈 그래프 보기'; btn.setAttribute('aria-expanded', 'false');
    const body = document.createElement('div'); body.className = 'graph-body'; body.hidden = true;
    if (g.title) body.appendChild(Object.assign(document.createElement('div'), { className: 'graph-title', textContent: g.title }));
    try { body.appendChild(drawGraph(g)); } catch { return; }
    if (g.series.length) {
      const legend = document.createElement('div'); legend.className = 'graph-legend';
      g.series.forEach((s, i) => { const it = document.createElement('span'); it.className = `c${i % 3}`; it.textContent = s.label; legend.appendChild(it); });
      body.appendChild(legend);
    }
    btn.onclick = () => {
      const open = body.hidden; body.hidden = !open; btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? '📈 그래프 접기' : '📈 그래프 보기';
      if (open) scrollDown();
    };
    box.append(btn, body);
    row.querySelector('.stack').insertBefore(box, row.querySelector('.time'));
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
    $('#fb-chip-label').textContent = '✍️ 첨삭';
    $('#fb-en').setAttribute('aria-pressed', String(fb.subject === 'english'));
    $('#fb-ma').setAttribute('aria-pressed', String(fb.subject === 'math'));
    $('#fb-en').disabled = $('#fb-ma').disabled = !!retryOf;   // 고쳐 쓰는 중에는 과목 고정
    $('#fb-chip').classList.toggle('on', fbMode);
    $('#fb-chip').setAttribute('aria-pressed', String(fbMode));
    const n = $('#fb-chip-n');
    n.hidden = fb.limit == null; n.textContent = fb.limit == null ? '' : `${fb.remaining}회`;
    $('#fb-mode').hidden = !fbMode;
    $('#fb-mode-text').innerHTML = '';
    const b = document.createElement('b'); b.textContent = retryOf ? '고쳐 쓰기' : `${c.chip.slice(2).trim()} 모드`;
    $('#fb-mode-text').append(b, Object.assign(document.createElement('span'), { className: 'mt', textContent: ' · ' + (retryOf ? c.retry : c.mode) }));
    $('#text').placeholder = fbMode ? (retryOf ? '고쳐 쓴 글을 적어 줘' : c.place) : '문제나 내 풀이를 적어 줘';
    $('#ladder-wrap').hidden = fbMode || $('#chat').hidden || keyHint();
    if (fbMode) $('#cam-badge').hidden = true; else renderQuota();   // 첨삭 사진은 사진 질문 횟수와 따로 셈
    ['#more-hint', '#solved', '#new-q'].forEach((s2) => ($(s2).hidden = fbMode));
    $('#show-sol').hidden = fbMode || !solAvail;
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
  function pickSubject(sub) {
    if (retryOf || fb.subject === sub) return;
    fb.subject = sub; renderFb();
    add('sys', `${FB[sub].chip.slice(2).trim()}으로 바꿨어! ${FB[sub].mode}`);
  }
  $('#fb-en').onclick = () => pickSubject('english');
  $('#fb-ma').onclick = () => pickSubject('math');
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
      again.onclick = () => { fb.subject = r.subject; setFbMode(true, r.id); add('sys', FB[r.subject].retry); };
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

  // ---- 화면 전환: 홈(오늘) · 질문(대화) · 오답노트(시안) ----
  let view = 'login', nick = '', today = { asked: 0, solved: 0 };
  function setView(v) {
    view = v;
    $('#home').hidden = v !== 'home';
    $('#notes').hidden = v !== 'notes';
    $('#chat').hidden = v !== 'chat';
    $('#bar').hidden = v !== 'chat';
    $('#tabs').hidden = v !== 'home' && v !== 'notes';
    $('#back').hidden = v !== 'chat';
    $('#logout').hidden = v === 'chat' || v === 'login';   // 질문 화면에서는 학원 이름이 잘리지 않게 숨김 (홈에서 로그아웃)
    $('#ladder-wrap').hidden = v !== 'chat' || fbMode || keyHint();
    [['#tab-home', 'home'], ['#tab-ask', 'chat'], ['#tab-notes', 'notes']].forEach(([s2, k]) => {
      if (k === v) $(s2).setAttribute('aria-current', 'page'); else $(s2).removeAttribute('aria-current');
    });
    if (v === 'chat') scrollDown(); else window.scrollTo(0, 0);
  }
  // 로그인 후 첫 화면 = 홈
  function showChat(nickname) {
    nick = nickname || nick;
    $('#login').hidden = true;
    $('#logout').hidden = false;
    renderHome();
    setView('home');
    renderFb(); applyMode(); updateSend();
    maybeShowInstall();
  }
  // 질문 화면 열기 (처음 열 때 인사)
  function openChat() {
    if (!$('#chat').childElementCount) add('ai', `${nick}, 안녕! 어떤 문제가 막혔어?\n글로 적거나 📷 버튼으로 문제 사진을 올려 줘.${fb?.subject ? `\n직접 쓴 영어 글이나 수학 풀이를 봐 줬으면 아래 ✍️ 첨삭 버튼을 눌러 줘.` : ''}`);
    setView('chat');
    renderLadder(); renderFb(); applyMode(); updateSend();
  }

  // 홈: 오늘의 미션 · 오늘의 숙제 · AI에게 질문하기
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  let hw = null; // 오늘의 숙제: 실제 숙제 기능이 열리기 전에는 항상 null (미리보기에서만 예시)
  function renderHome() {
    $('#hello-name').textContent = `${nick}, 오늘도 반가워!`;
    try { $('#today-date').textContent = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }); } catch { /* 표시만 생략 */ }
    // 오늘의 미션: 실제로 기록되는 것만 센다 (숙제 기능이 열리면 숙제 인증이 첫 줄에 들어감)
    const items = [];
    if (hw) items.push({ label: '숙제 사진 인증', done: !!hw.result });
    items.push({ label: '막힌 문제 AI에게 물어보기', done: today.asked > 0 });
    items.push({ label: '스스로 1문제 해결하기', done: today.solved > 0 });
    const done = items.filter((i) => i.done).length;
    const pct = Math.round((done / items.length) * 100);
    $('#mission-n').textContent = `${done} / ${items.length}`;
    $('#mission-fill').style.width = pct + '%';
    $('#mission-fill').classList.toggle('full', pct === 100);
    $('#mission-bar').setAttribute('aria-valuenow', String(pct));
    const ul = $('#mission-list'); ul.textContent = '';
    for (const it of items) {
      const li = document.createElement('li'); li.className = 'm-item' + (it.done ? ' done' : '');
      const c = document.createElement('span'); c.className = 'm-check'; c.innerHTML = CHECK; c.setAttribute('aria-hidden', 'true');
      const l = document.createElement('span'); l.className = 'm-label'; l.textContent = it.label;
      const st = document.createElement('span'); st.className = 'sr'; st.textContent = it.done ? '완료' : '아직';
      li.append(c, l, st); ul.appendChild(li);
    }
    // 오늘의 숙제 카드
    const card = $('#hw-card');
    if (!hw) {
      card.classList.add('empty');
      $('#hw-badge').className = 'badge b-gray'; $('#hw-badge').textContent = '오늘의 숙제';
      $('#hw-title').textContent = '숙제 인증은 곧 열려요';
      $('#hw-desc').textContent = '선생님이 숙제를 내 주면 여기에서 사진으로 인증해요.';
      $('#go-hw').hidden = true;
    } else {
      card.classList.remove('empty');
      const r = hw.result;
      $('#hw-badge').className = 'badge ' + (!r ? 'b-peach' : r.choice === 'help' ? 'b-peach' : 'b-mint');
      $('#hw-badge').textContent = !r ? `${hw.subject} · ${hw.due}` : r.choice === 'help' ? '🙋 도움 요청 보냄' : '✓ 제출 완료';
      $('#hw-title').textContent = hw.title;
      $('#hw-desc').textContent = !r ? hw.desc : r.choice === 'help' ? '선생님이 확인하고 도와줄 거야.' : `사진 ${r.shots}장 제출 · 선생님 확인을 기다리는 중`;
      $('#go-hw').hidden = false;
      $('#go-hw').className = 'btn ' + (r ? 'btn-line' : 'btn-primary');
      $('#go-hw').lastChild.textContent = r ? '제출 내용 보기' : '숙제 사진 인증하기';
    }
    // 화면당 강조 버튼 1개: 인증할 숙제가 있으면 숙제 버튼, 없으면 AI 질문이 가장 크게
    const hwFirst = hw && !hw.result;
    $('#go-ask').className = 'ask-hero ' + (hwFirst ? 'sub' : 'main');
    $('#go-fb').hidden = !fb?.subject;
  }
  $('#go-ask').onclick = () => openChat();
  $('#tab-ask').onclick = () => openChat();
  $('#tab-home').onclick = () => { renderHome(); setView('home'); };
  $('#back').onclick = () => { renderHome(); setView('home'); };
  $('#go-photo-ask').onclick = () => { openChat(); $('#cam').click(); };
  $('#go-fb').onclick = () => { openChat(); if (!fbMode) $('#fb-chip').click(); };

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
      if (me.classToken === token) { renderQuota(me.photo); fb = me.feedback || null; teachingMode = me.teachingMode || 'hint_ladder'; if (me.today) today = me.today; return showChat(me.nickname); }
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
      try { const me = await api('/me'); renderQuota(me.photo); fb = me.feedback || null; teachingMode = me.teachingMode || 'hint_ladder'; if (me.today) today = me.today; } catch { /* 표시만 생략 */ }
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
      if (!fbMode) { sessionId = null; level = 0; renderLadder(); setSol(false); }  // 사진은 보통 새 문제 → 힌트 단계를 처음부터
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
    const body = { text, subject: fb.subject };
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
  async function ask({ moreHint = false, solution = false } = {}) {
    if (busy) return;
    if (fbMode && !moreHint) return sendFeedback();
    const text = $('#text').value.trim();
    if (!text && !photo && !moreHint && !solution) return;
    busy = true; updateSend();
    if (solution) add('me', '📖 완성 풀이 보여 줘');
    else if (moreHint) add('me', keyHint() ? '🙋 다시 쉽게 설명해 줘' : '💡 힌트 하나 더');
    else add('me', text, photo?.preview);
    const body = { text: solution ? '해 봤는데 막혔어요. 완성 풀이를 보여 주세요' : moreHint ? (text || (keyHint() ? '조금 더 쉽게 다시 설명해 줘' : '힌트 하나 더 주세요')) : text, sessionId, moreHint, ...(solution ? { wantSolution: true } : {}) };
    const sent = photo && !moreHint && !solution ? photo : null;
    if (sent) body.image = { mediaType: sent.mediaType, base64: sent.base64 };
    $('#text').value = ''; autoGrow(); $('#preview').hidden = true; if (sent) photo = null;
    const t = typing(sent ? '사진 속 문제를 읽고 있어요…' : '선생님이 생각 중이에요…');
    try {
      const r = await api('/ask', body);
      if (!sessionId) today.asked += 1;   // 새 문제 질문 → 오늘의 미션 반영
      sessionId = r.sessionId; level = r.hintLevel; renderLadder();
      if (r.photo) renderQuota(r.photo);
      t.remove();
      const row = add('ai', r.reply);
      if (r.graph) addGraph(row, r.graph);
      if (r.hint2) addHint2(row, r.hint2, r.sessionId);
      setSol(r.solutionAvailable);
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
  $('#show-sol').onclick = () => { if (!sessionId) return add('sys', '먼저 문제를 물어봐 줘!'); ask({ solution: true }); };
  $('#solved').onclick = async () => {
    if (!sessionId) return add('sys', '먼저 문제를 물어봐 줘!');
    await api(`/session/${sessionId}/close`, { solved: true }).catch(() => {});
    add('ai', '잘했어! 🎉 스스로 푼 문제로 기록해 둘게. 다음 문제도 화이팅!');
    today.solved += 1;
    sessionId = null; level = 0; renderLadder(); setSol(false);
  };
  $('#new-q').onclick = () => { sessionId = null; level = 0; renderLadder(); setSol(false); add('sys', '새 문제 시작! 문제를 적거나 사진을 올려 줘'); };

  // ---- 홈 화면에 추가 (PWA) ----
  let deferred = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const dismissed = () => { try { return localStorage.getItem('wai-install-dismissed') === '1'; } catch { return false; } };
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; maybeShowInstall(); }); // 안드로이드 크롬
  function maybeShowInstall() {
    if (standalone || dismissed() || !nick) return;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (deferred) { $('#install-tip').textContent = '버튼 한 번이면 끝!'; $('#install-btn').hidden = false; $('#install').hidden = false; }
    else if (ios) { $('#install-tip').textContent = 'Safari 공유 버튼(□↑) → "홈 화면에 추가"'; $('#install').hidden = false; }
  }
  $('#install-btn').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#install').hidden = true; };
  $('#install-close').onclick = () => { $('#install').hidden = true; try { localStorage.setItem('wai-install-dismissed', '1'); } catch {} };

  // 아래 입력 영역 높이가 바뀌면(첨삭 모드·사진 미리보기) 마지막 답이 가려지지 않게 대화 아래 여백을 맞춘다
  if ('ResizeObserver' in window) new ResizeObserver(() => { $('#chat').style.paddingBottom = ($('#bar').offsetHeight + 24) + 'px'; }).observe($('#bar'));
  if (PREVIEW) previewOnly();
  if ('serviceWorker' in navigator && !PREVIEW) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  boot();

  // =====================================================================
  // 아래는 디자인 미리보기 전용 시안 (숙제 인증 3단계 · 오답노트).
  // 실제 숙제 기능은 아직 서버에 없으므로, 실제 서비스(PREVIEW=false)에서는 화면에 나타나지 않는다.
  // =====================================================================
  function previewOnly() {
    $('#preview-ribbon').hidden = false;
    $('#tab-notes').hidden = false;
    hw = { subject: '수학', due: '오늘 밤 10시 마감', title: '쎈 수학 42~45쪽 · 12문제', desc: '푼 페이지를 사진으로 찍어 인증해 줘. (시안 예시)' };

    // ---------- 숙제 인증: 사진 찍기 → 얼마나 했나요 → 제출 ----------
    let step = 1, shots = [], choice = null, hard = new Set();
    const CHOICES = [
      { k: 'all', ic: '✅', bg: 'var(--mint-soft)', t: '다 했어요', d: '12문제 모두 풀었어요' },
      { k: 'part', ic: '🌗', bg: 'var(--blue-soft)', t: '일부만 했어요', d: '못 푼 문제가 있어요' },
      { k: 'help', ic: '🙋', bg: 'var(--peach-soft)', t: '도움이 필요해요', d: '선생님께 바로 알려 줄게요' },
    ];
    const el2 = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    function sample(i) { // 미리보기용 공책 사진 (그림으로 만듦)
      const c = document.createElement('canvas'); c.width = 300; c.height = 400; const g = c.getContext('2d');
      g.fillStyle = '#FFFDF7'; g.fillRect(0, 0, 300, 400); g.strokeStyle = '#D9E4F5';
      for (let y = 40; y < 400; y += 28) { g.beginPath(); g.moveTo(0, y); g.lineTo(300, y); g.stroke(); }
      g.fillStyle = '#3B3F58'; g.font = '20px serif';
      ['2x + 3 = 11', '2x = 8', 'x = 4', '3x - 5 = 7', '3x = 12', 'x = 4'].forEach((t, k) => g.fillText(`${k + 1 + i * 6}) ${t}`, 22, 70 + k * 56));
      return c.toDataURL('image/jpeg', 0.8);
    }
    function upload(shot) { // 업로드 상태 흉내: 진행 → 완료 (두 번째 사진은 처음에 실패 → 다시 누르면 성공)
      shot.status = 'uploading'; shot.p = 10; draw();
      const fail = shot.failOnce; shot.failOnce = false;
      const t = setInterval(() => {
        shot.p += 30;
        if (shot.p >= 100 || (fail && shot.p >= 70)) { clearInterval(t); shot.status = fail ? 'fail' : 'done'; }
        draw();
      }, 260);
    }
    function addShot(url) { const s = { url, status: 'uploading', p: 0, failOnce: shots.length === 1 }; shots.push(s); upload(s); }
    $('#file-hw').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addShot(URL.createObjectURL(f)); });
    function draw() {
      const body = $('#hwf-body'); body.textContent = '';
      $('#hwf-steps').querySelectorAll('div').forEach((d, i) => { d.className = i + 1 < step || step === 4 ? 'done' : i + 1 === step ? 'on' : ''; });
      const next = $('#hwf-next');
      if (step === 1) {
        body.append(el2('p', 'page-sub', '푼 페이지를 한 장씩 찍어 줘. 글씨가 잘 보이면 충분해!'));
        const grid = el2('div', 'shots');
        shots.forEach((s, i) => {
          const d = el2('div', 'shot'); const im = el2('img'); im.src = s.url; im.alt = `숙제 사진 ${i + 1}`; d.appendChild(im);
          const st = el2('span', 'badge st ' + (s.status === 'done' ? 'b-mint' : s.status === 'fail' ? 'b-peach' : 'b-blue'),
            s.status === 'done' ? '✓ 올라감' : s.status === 'fail' ? '↻ 다시 올리기' : `올리는 중 ${Math.min(99, s.p)}%`);
          if (s.status === 'fail') { d.style.cursor = 'pointer'; d.onclick = () => upload(s); d.setAttribute('role', 'button'); d.setAttribute('aria-label', `사진 ${i + 1} 다시 올리기`); }
          if (s.status === 'uploading') { const pr = el2('i', 'prog'); pr.style.width = s.p + '%'; d.appendChild(pr); }
          d.appendChild(st); grid.appendChild(d);
        });
        if (shots.length < 6) {
          const add2 = el2('button', 'shot add'); add2.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.2-1.8A1.5 1.5 0 0 1 10.55 3.5h2.9a1.5 1.5 0 0 1 1.25.7L15.9 6h1.6A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.4"/></svg>';
          add2.appendChild(document.createTextNode(shots.length ? '한 장 더' : '사진 찍기'));
          add2.onclick = () => $('#file-hw').click();
          grid.appendChild(add2);
        }
        body.appendChild(grid);
        const smp = el2('button', 'ghost', '＋ 예시 사진 넣기 (미리보기용)'); smp.onclick = () => addShot(sample(shots.length)); smp.style.alignSelf = 'flex-start';
        body.appendChild(smp);
        const ready = shots.some((s) => s.status === 'done') && !shots.some((s) => s.status === 'uploading');
        next.textContent = shots.some((s) => s.status === 'fail') ? '실패한 사진은 눌러서 다시 올려 줘' : '다음'; next.disabled = !ready || shots.some((s) => s.status === 'fail');
      } else if (step === 2) {
        body.append(el2('p', 'page-sub', '숙제를 얼마나 했는지 하나만 골라 줘.'));
        const box = el2('div', 'choice');
        for (const c of CHOICES) {
          const b = el2('button'); b.setAttribute('aria-pressed', String(choice === c.k));
          const ic = el2('span', 'ci', c.ic); ic.style.background = c.bg;
          const tx = el2('span'); tx.append(el2('b', '', c.t), el2('span', '', c.d));
          b.append(ic, tx); b.onclick = () => { choice = c.k; draw(); };
          box.appendChild(b);
        }
        body.appendChild(box);
        if (choice && choice !== 'all') {
          body.append(el2('p', 'page-sub', '어려웠던 문제 번호 (선택 · 안 골라도 돼)'));
          const q = el2('div', 'opt-q');
          for (let n = 1; n <= 12; n++) {
            const b = el2('button', '', String(n)); b.setAttribute('aria-pressed', String(hard.has(n)));
            b.onclick = () => { hard.has(n) ? hard.delete(n) : hard.add(n); draw(); };
            q.appendChild(b);
          }
          body.appendChild(q);
        }
        next.textContent = '다음'; next.disabled = !choice;
      } else if (step === 3) {
        const c = CHOICES.find((x) => x.k === choice);
        body.append(el2('p', 'page-sub', '이대로 제출할까?'));
        const sum = el2('div', 'card sum');
        [['숙제', hw.title], ['사진', `${shots.filter((s) => s.status === 'done').length}장`], ['상태', `${c.ic} ${c.t}`], ['어려운 문제', hard.size ? [...hard].sort((a, b) => a - b).join(', ') + '번' : '없음']]
          .forEach(([k, v]) => { const r = el2('div'); r.append(el2('span', '', k), el2('span', '', v)); sum.appendChild(r); });
        body.appendChild(sum);
        body.appendChild(el2('p', 'page-sub', '※ 시안이라 실제로 제출되지는 않아요.'));
        next.textContent = choice === 'help' ? '제출하고 도움 요청하기' : '제출하기'; next.disabled = false;
      } else {
        const help = choice === 'help';
        const res = el2('div', 'result');
        const ic = el2('div', 'big-ic', help ? '🙋' : '🎉'); ic.style.background = help ? 'var(--peach-soft)' : 'var(--mint-soft)';
        res.append(ic, el2('span', 'badge ' + (help ? 'b-peach' : 'b-mint'), help ? '도움 요청 보냄' : '제출 완료'),
          el2('h3', '', help ? '선생님께 알렸어!' : '오늘 숙제 끝!'),
          el2('p', '', help ? '선생님 화면에 바로 표시돼. 기다리는 동안 AI에게 먼저 물어봐도 좋아.' : '선생님이 확인하면 여기에 표시돼. 수고했어!'));
        body.appendChild(res);
        next.textContent = '홈으로'; next.disabled = false;
      }
    }
    function openFlow() {
      if (hw.result) { step = 4; } else { step = 1; shots = []; choice = null; hard = new Set(); }
      $('#hw-flow').hidden = false; draw();
    }
    $('#go-hw').onclick = openFlow;
    $('#hwf-close').onclick = () => { $('#hw-flow').hidden = true; renderHome(); };
    $('#hwf-next').onclick = () => {
      if (step < 3) { step += 1; return draw(); }
      if (step === 3) { hw.result = { choice, shots: shots.filter((s) => s.status === 'done').length }; step = 4; return draw(); }
      $('#hw-flow').hidden = true; renderHome(); setView('home');
    };

    // ---------- 오답노트: 다시 풀 문제 · 가리고 쓰기 · 재확인 ----------
    const NOTES = [
      { id: 1, k: 'retry', title: '일차방정식 2x + 3 = 11', meta: '완성 풀이를 본 문제 · 어제', problem: '2x + 3 = 11 일 때, x의 값을 구하시오.', sol: '1단계 ▶ 양변에서 3을 빼면 2x = 8\n2단계 ▶ 양변을 2로 나누면 x = 4\n답: x = 4' },
      { id: 2, k: 'retry', title: '일차함수의 기울기', meta: '힌트 2를 본 문제 · 10월 29일', problem: '두 점 (1, 3), (3, 7)을 지나는 직선의 기울기는?', sol: '1단계 ▶ 기울기 = (y의 증가량) ÷ (x의 증가량)\n2단계 ▶ (7 − 3) ÷ (3 − 1) = 4 ÷ 2\n답: 2' },
      { id: 3, k: 'cover', title: '연립방정식 가감법', meta: '가리고 쓰는 중', problem: 'x + y = 5, x − y = 1 을 푸시오.', sol: '1단계 ▶ 두 식을 더하면 2x = 6\n2단계 ▶ x = 3, y = 2\n답: x = 3, y = 2' },
      { id: 4, k: 'check', title: '일차부등식', meta: '선생님 확인 대기', problem: '3x − 5 > 7 을 푸시오.', sol: '1단계 ▶ 3x > 12\n2단계 ▶ x > 4\n답: x > 4', wait: true },
      { id: 5, k: 'check', title: '등식의 성질', meta: '재확인 통과 ✓', problem: '5x = 2x + 9 를 푸시오.', sol: '1단계 ▶ 3x = 9\n답: x = 3', passed: true },
    ];
    const KCOL = { retry: 'var(--peach)', cover: 'var(--blue)', check: 'var(--mint)' };
    let tabK = 'retry';
    function drawNotes() {
      ['retry', 'cover', 'check'].forEach((k) => ($('#nc-' + k).textContent = NOTES.filter((n) => n.k === k).length));
      document.querySelectorAll('.seg3 button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === tabK)));
      const list = $('#note-list'); list.textContent = ''; list.hidden = false; $('#note-detail').hidden = true;
      $('.seg3').hidden = false;
      for (const n of NOTES.filter((x) => x.k === tabK)) {
        const b = el2('button', 'card note');
        const bar = el2('span', 'bar-l'); bar.style.background = KCOL[n.k];
        const t = el2('span', 'nt'); t.append(el2('b', '', n.title), el2('span', '', n.meta));
        b.append(bar, t); b.insertAdjacentHTML('beforeend', '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 5l7 7-7 7"/></svg>');
        b.onclick = () => openNote(n);
        list.appendChild(b);
      }
    }
    function openNote(n) {
      $('#note-list').hidden = true; $('.seg3').hidden = true;
      const d = $('#note-detail'); d.hidden = false; d.textContent = '';
      const backB = el2('button', 'ghost', '‹ 목록으로'); backB.style.alignSelf = 'flex-start'; backB.onclick = drawNotes;
      const stage = n.k === 'retry' ? 1 : n.k === 'cover' ? 2 : 3;
      const sp = el2('div', 'stepper'); for (let i = 1; i <= 3; i++) sp.appendChild(el2('span', i <= stage ? 'on' : ''));
      d.append(backB, el2('h2', 'page-title', n.title), sp);
      // ① 다시 풀 문제
      const s1 = el2('section', 'card stage' + (stage > 1 ? ' done' : ''));
      const h1 = el2('h3'); h1.append(el2('span', 'num', '1'), document.createTextNode('다시 풀 문제'));
      s1.append(h1, el2('div', 'problem', n.problem));
      if (stage === 1) { const go = el2('button', 'btn btn-primary', '풀이 보고 가리고 쓰기 시작'); go.onclick = () => { n.k = 'cover'; n.meta = '가리고 쓰는 중'; openNote(n); }; s1.appendChild(go); }
      d.appendChild(s1);
      // ② 가리고 쓰기
      const s2 = el2('section', 'card stage' + (stage > 2 ? ' done' : ''));
      const h2 = el2('h3'); h2.append(el2('span', 'num', '2'), document.createTextNode('풀이 가리고 혼자 쓰기'));
      s2.appendChild(h2);
      if (stage >= 2) {
        const cov = el2('div', 'cover' + (stage === 2 ? ' hidden-sol' : ''));
        cov.append(el2('div', 'sol', n.sol), el2('div', 'veil', '🙈 풀이를 가렸어 · 공책에 혼자 써 봐'));
        s2.appendChild(cov);
        if (stage === 2) {
          const row = el2('div', 'quick');
          const peek = el2('button', '', '👀 잠깐 보기'); peek.onmousedown = peek.ontouchstart = () => cov.classList.remove('hidden-sol'); peek.onmouseup = peek.onmouseleave = peek.ontouchend = () => cov.classList.add('hidden-sol');
          const done = el2('button', '', '✍️ 다 썼어요'); done.onclick = () => { n.k = 'check'; n.meta = '선생님 확인 대기'; n.wait = true; openNote(n); };
          row.append(peek, done); s2.appendChild(row);
        }
      } else s2.appendChild(el2('p', 'page-sub', '1단계를 마치면 열려요'));
      d.appendChild(s2);
      // ③ 재확인
      const s3 = el2('section', 'card stage' + (n.passed ? ' done' : ''));
      const h3 = el2('h3'); h3.append(el2('span', 'num', '3'), document.createTextNode('재확인'));
      s3.appendChild(h3);
      if (stage < 3) s3.appendChild(el2('p', 'page-sub', '공책 사진을 올리면 선생님이 다시 확인해요'));
      else if (n.passed) s3.appendChild(el2('span', 'badge b-mint', '✓ 재확인 통과 · 스스로 풀었어!'));
      else { s3.append(el2('span', 'badge b-blue', '⏳ 선생님 확인 대기'), el2('p', 'page-sub', '선생님이 확인하면 여기 표시돼요.')); }
      d.appendChild(s3);
      d.appendChild(el2('p', 'page-sub', '※ 시안 예시 문제예요.'));
      window.scrollTo(0, 0);
    }
    document.querySelectorAll('.seg3 button').forEach((b) => (b.onclick = () => { tabK = b.dataset.k; drawNotes(); }));
    $('#tab-notes').onclick = () => { drawNotes(); setView('notes'); };
  }
})();
