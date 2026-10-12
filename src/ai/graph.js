// 📈 그래프: 튜터가 <<GRAPH>>{...}<<END_GRAPH>> 로 함수·점 정보만 보내면,
// 서버가 식을 안전하게 계산(eval 사용 안 함)해서 좌표를 만들고 학생 화면이 진짜 그래프(SVG)로 그린다.
// 글자로 그린 그래프는 휴대폰에서 줄이 틀어지고 모양이 부정확해서 함수·좌표 단원은 이 방식으로 보여 준다.

const GRAPH_RE = /<<GRAPH>>([\s\S]*?)(<<END_GRAPH>>|$)/;
const MAX_FUNCS = 3, MAX_POINTS = 6, SAMPLES = 240, LIMIT = 100;

// ---- 아주 작은 수식 계산기: 숫자, x, + - * / ^, 괄호, sqrt abs, pi ----
function tokenize(src) {
  const s = String(src).replace(/\s+/g, '').replace(/²/g, '^2').replace(/³/g, '^3').replace(/√/g, 'sqrt').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const num = s.slice(i).match(/^\d+(\.\d+)?/);
    if (num) { out.push({ t: 'n', v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const word = s.slice(i).match(/^(sqrt|abs|pi|x)/i);
    if (word) { const w = word[0].toLowerCase(); out.push(w === 'x' ? { t: 'x' } : w === 'pi' ? { t: 'n', v: Math.PI } : { t: 'f', v: w }); i += w.length; continue; }
    if ('+-*/^()'.includes(c)) { out.push({ t: c }); i += 1; continue; }
    throw new Error('bad token');
  }
  // 곱하기 생략 채우기: 2x, 2(x+1), x(x-1), (x+1)(x-1), 3sqrt(x)
  const res = [];
  for (const tk of out) {
    const prev = res[res.length - 1];
    if (prev && (prev.t === 'n' || prev.t === 'x' || prev.t === ')') && (tk.t === 'n' || tk.t === 'x' || tk.t === '(' || tk.t === 'f')) res.push({ t: '*' });
    res.push(tk);
  }
  return res;
}
function compile(src) {
  if (String(src).length > 60) throw new Error('too long');
  const tk = tokenize(src);
  let p = 0;
  const peek = () => tk[p], eat = (t) => { if (tk[p]?.t !== t) throw new Error('expected ' + t); p++; };
  // expr := term (('+'|'-') term)* ; term := unary (('*'|'/') unary)* ; unary := '-' unary | power ; power := atom ('^' unary)?
  function expr() { let n = term(); while (peek() && (peek().t === '+' || peek().t === '-')) { const op = tk[p++].t; const r = term(), l = n; n = op === '+' ? (x) => l(x) + r(x) : (x) => l(x) - r(x); } return n; }
  function term() { let n = unary(); while (peek() && (peek().t === '*' || peek().t === '/')) { const op = tk[p++].t; const r = unary(), l = n; n = op === '*' ? (x) => l(x) * r(x) : (x) => l(x) / r(x); } return n; }
  function unary() { if (peek()?.t === '-') { p++; const u = unary(); return (x) => -u(x); } if (peek()?.t === '+') { p++; return unary(); } return power(); }
  function power() { const b = atom(); if (peek()?.t === '^') { p++; const e = unary(); return (x) => Math.pow(b(x), e(x)); } return b; }
  function atom() {
    const t = peek(); if (!t) throw new Error('end');
    if (t.t === 'n') { p++; const v = t.v; return () => v; }
    if (t.t === 'x') { p++; return (x) => x; }
    if (t.t === 'f') { p++; eat('('); const a = expr(); eat(')'); return t.v === 'sqrt' ? (x) => Math.sqrt(a(x)) : (x) => Math.abs(a(x)); }
    if (t.t === '(') { p++; const e = expr(); eat(')'); return e; }
    throw new Error('unexpected');
  }
  const f = expr();
  if (p !== tk.length) throw new Error('trailing');
  return f;
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Math.max(-LIMIT, Math.min(LIMIT, Number(v))) : d);
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const round = (v) => Math.round(v * 1000) / 1000;

// 튜터가 보낸 JSON → 학생 화면용 그래프 데이터 (잘못된 식은 조용히 버림)
function buildGraph(spec) {
  if (!spec || typeof spec !== 'object') return null;
  let [x0, x1] = Array.isArray(spec.x) ? spec.x.map((v) => num(v, NaN)) : [NaN, NaN];
  if (!(x1 > x0)) { x0 = -5; x1 = 5; }
  // 고르게 나눈 점 + 정수 x(값 표와 맞게) + 표시할 점의 x → 꺾이는 곳(abs)·절편이 정확히 찍히게
  const pts0 = Array.isArray(spec.points) ? spec.points : [];
  const xs = [...new Set([
    ...Array.from({ length: SAMPLES + 1 }, (_, i) => round(x0 + ((x1 - x0) * i) / SAMPLES)),
    ...Array.from({ length: Math.min(201, Math.floor(x1) - Math.ceil(x0) + 1) }, (_, i) => Math.ceil(x0) + i),
    ...pts0.map((pt) => Number(pt?.x)).filter((x) => Number.isFinite(x) && x >= x0 && x <= x1),
  ])].sort((a, b) => a - b);
  const series = [];
  for (const fn of (Array.isArray(spec.functions) ? spec.functions : []).slice(0, MAX_FUNCS)) {
    let f;
    try { f = compile(fn.expr); } catch { continue; }
    const segs = []; let cur = [];
    for (const x of xs) {
      let y; try { y = f(x); } catch { y = NaN; }
      if (Number.isFinite(y) && Math.abs(y) <= LIMIT * 10) cur.push([round(x), round(y)]);
      else if (cur.length) { segs.push(cur); cur = []; }
    }
    if (cur.length) segs.push(cur);
    if (segs.length) series.push({ label: str(fn.label, 30) || `y = ${str(fn.expr, 30)}`, segs });
  }
  const points = (Array.isArray(spec.points) ? spec.points : []).slice(0, MAX_POINTS)
    .map((pt) => ({ x: num(pt.x, NaN), y: num(pt.y, NaN), label: str(pt.label, 24) }))
    .filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
  if (!series.length && !points.length) return null;
  // y 범위: 지정값이 없으면 보이는 값 기준으로 자동 (점 포함, 위아래 여유)
  let [y0, y1] = Array.isArray(spec.y) ? spec.y.map((v) => num(v, NaN)) : [NaN, NaN];
  if (!(y1 > y0)) {
    const ys = [...series.flatMap((s) => s.segs.flat().map((pt) => pt[1])), ...points.map((pt) => pt.y), 0];
    const sorted = ys.sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.02)], hi = sorted[Math.ceil(sorted.length * 0.98) - 1];
    const pad = Math.max(1, (hi - lo) * 0.12);
    y0 = Math.floor(Math.max(-LIMIT, lo - pad)); y1 = Math.ceil(Math.min(LIMIT, hi + pad));
    if (y1 <= y0) y1 = y0 + 2;
  }
  return { title: str(spec.title, 40), x: [x0, x1], y: [y0, y1], series, points };
}

// 답변에서 그래프 블록을 떼어 낸다
function extractGraph(text) {
  const m = String(text || '').match(GRAPH_RE);
  if (!m) return { text, graph: null };
  const rest = (String(text).slice(0, m.index) + String(text).slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trim();
  let graph = null;
  try { graph = buildGraph(JSON.parse(m[1].trim())); } catch { graph = null; }
  return { text: rest, graph };
}

module.exports = { extractGraph, buildGraph, compile };
