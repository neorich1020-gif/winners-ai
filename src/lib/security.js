// 개인정보 암호화 · 마스킹 · 인증 유틸
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// 암호화 키: 32바이트 base64면 그대로, 아니면(예: Render가 자동 생성한 긴 무작위 값) SHA-256으로 32바이트 키를 만든다
const RAW_ENC = process.env.PII_ENC_KEY || '';
const decoded = Buffer.from(RAW_ENC, 'base64');
const ENC_KEY = decoded.length === 32 ? decoded : crypto.createHash('sha256').update(RAW_ENC).digest();
const HASH_KEY = process.env.PII_HASH_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const STUDENT_HOURS = Number(process.env.STUDENT_SESSION_HOURS || 168);

if (process.env.NODE_ENV === 'production') {
  if (RAW_ENC.length < 32) throw new Error('PII_ENC_KEY가 너무 짧습니다 (32자 이상 무작위 값)');
  if (HASH_KEY.length < 32) throw new Error('PII_HASH_KEY가 너무 짧습니다');
  if (JWT_SECRET.length < 32) throw new Error('JWT_SECRET too short');
}

// AES-256-GCM: [iv(12)][tag(16)][ciphertext]
function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
function decrypt(buf) {
  if (!buf) return null;
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
const hmac = (v) => crypto.createHmac('sha256', HASH_KEY).update(String(v)).digest('hex');
const normalizePhone = (p) => String(p).replace(/\D/g, '');

// 학생이 실수로 입력한 개인정보를 저장·AI 전달 전에 가림
function maskPII(text) {
  return String(text)
    .replace(/01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/g, '[전화번호]')
    .replace(/\d{6}[-\s]?[1-4]\d{6}/g, '[주민번호]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[이메일]')
    .replace(/(\S+(시|군|구)\s+\S+(동|읍|면|로|길)\s*\d+(-\d+)?)/g, '[주소]');
}

// 토큰: 원장(staff)은 12시간, 학생은 기본 7일(STUDENT_SESSION_HOURS) — 서로 다른 audience
function signStaff(staff) {
  return jwt.sign({ sub: staff.id, aid: staff.academy_id, role: staff.role }, JWT_SECRET, { audience: 'staff', expiresIn: '12h' });
}
function signStudent(st) {
  // 홈 화면 앱(PWA)으로 매번 PIN을 치지 않도록 기본 7일 유지. 공용 기기는 '로그아웃' 버튼 사용
  return jwt.sign({ sub: st.id, aid: st.academy_id, cid: st.class_id }, JWT_SECRET, { audience: 'student', expiresIn: `${STUDENT_HOURS}h` });
}
function requireAuth(audience) {
  return (req, res, next) => {
    const token = req.cookies?.[`${audience}_token`];
    if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });
    try {
      req.user = jwt.verify(token, JWT_SECRET, { audience });
      next();
    } catch {
      res.status(401).json({ error: '다시 로그인해 주세요' });
    }
  };
}
const cookieOpts = (hours) => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: hours * 3600e3 });

module.exports = { STUDENT_HOURS, encrypt, decrypt, hmac, normalizePhone, maskPII, signStaff, signStudent, requireAuth, cookieOpts };
