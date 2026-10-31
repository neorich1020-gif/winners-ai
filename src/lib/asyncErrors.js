// 안전망 ①: async 라우트에서 난 오류를 Express 오류 처리기로 넘긴다.
// Express 4는 async 함수의 실패(Promise 거부)를 잡지 못해서, try/catch가 없는 화면에
// 잘못된 값이 한 번 들어오면 서버 전체가 꺼졌다(2026-10-31 진단 실험 1).
// 모든 라우트를 고치는 대신 Express의 처리 함수 한 곳을 감싸 빠짐없이 적용한다.
// 반드시 라우트를 불러오기 전에 require 한다 (server.js 맨 위).
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__asyncSafe) {
  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // 오류 처리기(err, req, res, next)는 Express 기본 동작 그대로
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') {
        out.then(undefined, (err) => next(err || new Error('요청 처리 실패')));
      }
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype.__asyncSafe = true;
}

// 안전망 ②: 라우트 밖(스케줄러 등)에서 놓친 Promise 실패도 서버를 끄지 않고 기록만 남긴다.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : err);
});

module.exports = {};
