// 서비스 워커: 홈 화면 앱(PWA) 설치 조건 + 빠른 화면 로딩 + 인터넷이 끊겼을 때 안내
// 원칙: 질문·대화·상담글 같은 개인 데이터(/api, /letter)는 절대 캐시하지 않는다.
const VERSION = 'wai-v3';
const SHELL = ['/student.js', '/offline.html', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;              // 질문 보내기(POST) 등은 그대로
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/letter/')) return; // 개인 데이터는 캐시 금지

  // 화면(HTML): 항상 최신 → 실패하면 오프라인 안내
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // 아이콘·스크립트: 캐시 먼저 보여 주고 뒤에서 새로 받아 둠
  if (url.pathname.startsWith('/icons/') || url.pathname === '/student.js') {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
