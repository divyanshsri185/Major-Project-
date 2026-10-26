try { process.loadEnvFile(); } catch { /* no .env file — fine */ }

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const db = require('./db');
const { RULES, CLIENT_TYPES, RATE_LIMIT_MS, verdict } = require('./rules');
const { seed } = require('./seed');

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (IS_PROD) { console.error('JWT_SECRET must be set in production'); process.exit(1); }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] JWT_SECRET not set — using a random one (logins reset on restart)');
}
const GRACE_MS = 5000; // allowance for network latency at the deadline


const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'media-src': ["'self'", 'blob:'],
      'img-src': ["'self'", 'data:'],
    },
  },
}));
app.use((req, res, next) => { // allow camera/mic only for our own origin
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), fullscreen=(self)');
  next();
});
app.use(express.json({ limit: '256kb' }));

// ---------- helpers ----------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const str = (v, min, max, label) => {
  if (typeof v !== 'string') throw bad(`${label} is required`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${label} must be ${min}–${max} characters`);
  return s;
};
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const sign = (u) => jwt.sign({ sub: u.id, role: u.role }, JWT_SECRET, { expiresIn: '12h' });

function auth(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Sign in required'));
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(p.sub);
    if (!user) throw new Error('no user');
    req.user = user;
    next();
  } catch { next(new HttpError(401, 'Session expired — please sign in again')); }
}
const requireExaminer = (req, _res, next) =>
  req.user.role === 'examiner' ? next() : next(new HttpError(403, 'Examiner access only'));

const examQuestions = (examId) =>
  db.prepare('SELECT id,position,text,options,answer FROM questions WHERE exam_id=? ORDER BY position').all(examId)
    .map(q => ({ ...q, options: JSON.parse(q.options) }));
const studentQuestions = (examId) => examQuestions(examId).map(({ id, text, options }) => ({ id, text, options }));

function addEvent(sessionId, type, at = Date.now()) {
  const r = RULES[type];
  db.prepare('INSERT INTO events (session_id,type,message,level,penalty,at) VALUES (?,?,?,?,?,?)')
    .run(sessionId, type, r.msg, r.lvl, r.pen, at);
}

function finalize(session, status) {
  const questions = examQuestions(session.exam_id);
  const answers = JSON.parse(session.answers);
  const correct = questions.reduce((n, q) => n + (answers[q.id] === q.answer ? 1 : 0), 0);
  const now = Date.now();
  db.prepare('UPDATE sessions SET status=?, submitted_at=?, correct=?, total=? WHERE id=?')
    .run(status, Math.min(now, session.deadline), correct, questions.length, session.id);
  addEvent(session.id, status === 'expired' ? 'expire' : 'submit', now);
  return db.prepare('SELECT * FROM sessions WHERE id=?').get(session.id);
}

// Load a session, enforce ownership, and auto-close it if the deadline has passed.
function loadSession(id, user, { allowExaminer = false } = {}) {
  let s = db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  if (!s) throw new HttpError(404, 'Session not found');
  const isOwner = s.user_id === user.id;
  if (!isOwner && !(allowExaminer && user.role === 'examiner')) throw new HttpError(404, 'Session not found');
  if (s.status === 'in_progress' && Date.now() > s.deadline + GRACE_MS) s = finalize(s, 'expired');
  return s;
}

function sessionSummary(s) {
  const flagged = db.prepare("SELECT COUNT(*) c FROM events WHERE session_id=? AND level!=''").get(s.id).c;
  return {
    id: s.id, examId: s.exam_id, status: s.status, startedAt: s.started_at, deadline: s.deadline,
    submittedAt: s.submitted_at, integrity: s.integrity, correct: s.correct, total: s.total,
    hasDevices: !!s.has_devices, flagged, verdict: verdict(s.integrity),
  };
}

// ---------- auth ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts — try again in a few minutes' } });

app.post('/api/auth/register', authLimiter, (req, res) => {
  const name = str(req.body.name, 2, 80, 'Name');
  const email = str(req.body.email, 5, 120, 'Email').toLowerCase();
  const password = str(req.body.password, 8, 128, 'Password');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email address');
  let role = 'student';
  const code = process.env.EXAMINER_INVITE_CODE;
  if (req.body.inviteCode) {
    if (!code || req.body.inviteCode !== code) throw new HttpError(403, 'Invalid invite code');
    role = 'examiner';
  }
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'That email is already registered');
  const info = db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run(name, email, bcrypt.hashSync(password, 10), role, Date.now());
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  res.status(201).json({ token: sign(user), user: publicUser(user) });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const email = str(req.body.email, 3, 120, 'Email').toLowerCase();
  const password = str(req.body.password, 1, 128, 'Password');
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) throw new HttpError(401, 'Wrong email or password');
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- student: exams & sessions ----------
app.get('/api/exams', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT e.id,e.title,e.description,e.duration_sec,
           (SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id) AS question_count
    FROM exams e WHERE e.active=1 ORDER BY e.created_at DESC`).all();
  const mine = db.prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY id DESC').all(req.user.id);
  res.json({
    exams: rows.map(e => {
      const last = mine.find(s => s.exam_id === e.id);
      const live = last && last.status === 'in_progress' && Date.now() <= last.deadline ? last : null;
      return {
        id: e.id, title: e.title, description: e.description, durationSec: e.duration_sec,
        questionCount: e.question_count,
        inProgressSessionId: live ? live.id : null,
        lastResult: last && last.status !== 'in_progress' ? sessionSummary(last) : null,
      };
    }),
  });
});

app.post('/api/exams/:id/start', auth, (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id=? AND active=1').get(req.params.id);
  if (!exam) throw new HttpError(404, 'Exam not found');
  const qs = studentQuestions(exam.id);
  if (!qs.length) throw new HttpError(409, 'This exam has no questions yet');

  // resume an unexpired attempt instead of starting a second one
  let s = db.prepare("SELECT * FROM sessions WHERE exam_id=? AND user_id=? AND status='in_progress' ORDER BY id DESC")
    .get(exam.id, req.user.id);
  if (s && Date.now() > s.deadline + GRACE_MS) { finalize(s, 'expired'); s = null; }
  if (!s) {
    const now = Date.now();
    const info = db.prepare('INSERT INTO sessions (exam_id,user_id,started_at,deadline,has_devices) VALUES (?,?,?,?,?)')
      .run(exam.id, req.user.id, now, now + exam.duration_sec * 1000, req.body.hasDevices ? 1 : 0);
    s = db.prepare('SELECT * FROM sessions WHERE id=?').get(info.lastInsertRowid);
    addEvent(s.id, 'start', now);
  }
  res.status(201).json(sessionPayload(s, exam, qs));
});

function sessionPayload(s, exam, qs) {
  return {
    session: sessionSummary(s),
    exam: { id: exam.id, title: exam.title, durationSec: exam.duration_sec },
    questions: qs,
    answers: JSON.parse(s.answers),
    serverTime: Date.now(),
    remainingMs: Math.max(0, s.deadline - Date.now()),
    events: db.prepare("SELECT type,message,level,penalty,at FROM events WHERE session_id=? AND level!='' ORDER BY at DESC").all(s.id),
  };
}


// ---------- Third Eye phone pairing ----------
const thirdEyeRooms = new Map();
const THIRD_EYE_TTL_MS = 5 * 60 * 1000;

app.post('/api/sessions/:id/third-eye/pair', auth, async (req, res) => {
  const session = loadSession(req.params.id, req.user);
  if (session.status !== 'in_progress') throw new HttpError(409, 'This exam session is no longer active');

  // Remove expired rooms before creating a new one.
  const now = Date.now();
  for (const [key, room] of thirdEyeRooms) {
    if (room.expiresAt <= now) {
      for (const ws of [room.laptop, room.phone]) {
        if (ws && ws.readyState === 1) ws.close(1000, 'Pairing expired');
      }
      thirdEyeRooms.delete(key);
    }
  }

  const pairingToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = now + THIRD_EYE_TTL_MS;
  const room = { sessionId: String(session.id), expiresAt, laptop: null, phone: null };
  thirdEyeRooms.set(pairingToken, room);

  // Use the public origin that served this request. For a phone on another
  // device, open Invigil through the HTTPS Cloudflare tunnel before pairing.
  const phoneUrl = `${req.protocol}://${req.get('host')}/phone.html?token=${pairingToken}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(phoneUrl, { errorCorrectionLevel: 'M', margin: 2, width: 260 });
    res.status(201).json({ phoneUrl, qrDataUrl, expiresAt });
  } catch (err) {
    thirdEyeRooms.delete(pairingToken);
    throw err;
  }
});

app.get('/api/sessions/:id', auth, (req, res) => {
  const s = loadSession(req.params.id, req.user);
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(s.exam_id);
  if (s.status !== 'in_progress') return res.json(resultPayload(s, exam));
  res.json(sessionPayload(s, exam, studentQuestions(exam.id)));
});

function resultPayload(s, exam) {
  const events = db.prepare('SELECT type,message,level,penalty,at FROM events WHERE session_id=? ORDER BY at').all(s.id);
  return {
    session: sessionSummary(s),
    exam: { id: exam.id, title: exam.title, durationSec: exam.duration_sec },
    timeUsedSec: Math.max(0, Math.round(((s.submitted_at || Date.now()) - s.started_at) / 1000)),
    flagged: events.filter(e => e.level),
    events,
  };
}

function mergeAnswers(s, incoming) {
  if (!incoming || typeof incoming !== 'object') return s.answers;
  const qs = examQuestions(s.exam_id);
  const byId = new Map(qs.map(q => [String(q.id), q]));
  const cur = JSON.parse(s.answers);
  for (const [qid, idx] of Object.entries(incoming)) {
    const q = byId.get(qid);
    if (!q) continue;
    if (idx === null) { delete cur[qid]; continue; }
    if (Number.isInteger(idx) && idx >= 0 && idx < q.options.length) cur[qid] = idx;
  }
  return JSON.stringify(cur);
}

app.put('/api/sessions/:id/answers', auth, (req, res) => {
  const s = loadSession(req.params.id, req.user);
  if (s.status !== 'in_progress') throw new HttpError(409, 'This exam is already closed');
  const merged = mergeAnswers(s, req.body.answers);
  db.prepare('UPDATE sessions SET answers=? WHERE id=?').run(merged, s.id);
  res.json({ ok: true, remainingMs: Math.max(0, s.deadline - Date.now()) });
});

app.post('/api/sessions/:id/events', auth, (req, res) => {
  const s = loadSession(req.params.id, req.user);
  if (s.status !== 'in_progress') throw new HttpError(409, 'This exam is already closed');
  const list = Array.isArray(req.body.events) ? req.body.events.slice(0, 25) : [];
  const accepted = [];
  const tx = db.transaction(() => {
    let integrity = s.integrity;
    const stamp = db.prepare('SELECT type, MAX(at) last FROM events WHERE session_id=? GROUP BY type').all(s.id);
    const last = Object.fromEntries(stamp.map(r => [r.type, r.last]));
    for (const ev of list) {
      if (!ev || !CLIENT_TYPES.has(ev.type)) continue;
      const now = Date.now();
      if (last[ev.type] && now - last[ev.type] < RATE_LIMIT_MS) continue; // server-side rate limit
      last[ev.type] = now;
      const r = RULES[ev.type];
      integrity = Math.max(0, integrity - r.pen);
      addEvent(s.id, ev.type, now);
      accepted.push({ type: ev.type, message: r.msg, level: r.lvl, penalty: r.pen, at: now });
    }
    db.prepare('UPDATE sessions SET integrity=? WHERE id=?').run(integrity, s.id);
    return integrity;
  });
  const integrity = tx();
  res.json({ integrity, accepted, remainingMs: Math.max(0, s.deadline - Date.now()) });
});

app.post('/api/sessions/:id/submit', auth, (req, res) => {
  let s = loadSession(req.params.id, req.user);
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(s.exam_id);
  if (s.status === 'in_progress') {
    if (req.body && req.body.answers) {
      db.prepare('UPDATE sessions SET answers=? WHERE id=?').run(mergeAnswers(s, req.body.answers), s.id);
      s = db.prepare('SELECT * FROM sessions WHERE id=?').get(s.id);
    }
    s = finalize(s, 'submitted');
  }
  res.json(resultPayload(s, exam));
});

app.get('/api/me/sessions', auth, (req, res) => {
  const rows = db.prepare(`SELECT s.*, e.title FROM sessions s JOIN exams e ON e.id=s.exam_id
                           WHERE s.user_id=? ORDER BY s.id DESC LIMIT 50`).all(req.user.id);
  res.json({ sessions: rows.map(s => ({ ...sessionSummary(s), examTitle: s.title })) });
});

// ---------- examiner: exams ----------
const admin = express.Router();
admin.use(auth, requireExaminer);

function parseExamBody(b) {
  const title = str(b.title, 3, 140, 'Title');
  const description = typeof b.description === 'string' ? b.description.trim().slice(0, 600) : '';
  const minutes = Number(b.durationMinutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 480) throw bad('Duration must be 1–480 minutes');
  let questions = null;
  if (b.questions !== undefined) {
    if (!Array.isArray(b.questions) || b.questions.length < 1 || b.questions.length > 200) throw bad('Add between 1 and 200 questions');
    questions = b.questions.map((q, i) => {
      const text = str(q.text, 3, 1000, `Question ${i + 1}`);
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8) throw bad(`Question ${i + 1} needs 2–8 options`);
      const options = q.options.map((o, j) => str(o, 1, 300, `Question ${i + 1} option ${j + 1}`));
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= options.length) throw bad(`Question ${i + 1} needs a correct answer`);
      return { text, options, answer: q.answer };
    });
  }
  return { title, description, durationSec: Math.round(minutes * 60), questions };
}

function writeQuestions(examId, questions) {
  db.prepare('DELETE FROM questions WHERE exam_id=?').run(examId);
  const ins = db.prepare('INSERT INTO questions (exam_id,position,text,options,answer) VALUES (?,?,?,?,?)');
  questions.forEach((q, i) => ins.run(examId, i, q.text, JSON.stringify(q.options), q.answer));
}

admin.get('/exams', (_req, res) => {
  const rows = db.prepare(`
    SELECT e.*, (SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id) qn,
           (SELECT COUNT(*) FROM sessions s WHERE s.exam_id=e.id) sn
    FROM exams e ORDER BY e.created_at DESC`).all();
  res.json({ exams: rows.map(e => ({ id: e.id, title: e.title, description: e.description,
    durationSec: e.duration_sec, active: !!e.active, questionCount: e.qn, sessionCount: e.sn })) });
});

admin.get('/exams/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM exams WHERE id=?').get(req.params.id);
  if (!e) throw new HttpError(404, 'Exam not found');
  const sn = db.prepare('SELECT COUNT(*) c FROM sessions WHERE exam_id=?').get(e.id).c;
  res.json({ exam: { id: e.id, title: e.title, description: e.description, durationSec: e.duration_sec,
    active: !!e.active, sessionCount: sn,
    questions: examQuestions(e.id).map(({ text, options, answer }) => ({ text, options, answer })) } });
});

admin.post('/exams', (req, res) => {
  const p = parseExamBody(req.body);
  if (!p.questions) throw bad('Add at least one question');
  const id = db.transaction(() => {
    const info = db.prepare('INSERT INTO exams (title,description,duration_sec,created_by,created_at) VALUES (?,?,?,?,?)')
      .run(p.title, p.description, p.durationSec, req.user.id, Date.now());
    writeQuestions(info.lastInsertRowid, p.questions);
    return info.lastInsertRowid;
  })();
  res.status(201).json({ id });
});

admin.put('/exams/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM exams WHERE id=?').get(req.params.id);
  if (!e) throw new HttpError(404, 'Exam not found');
  const p = parseExamBody(req.body);
  const sn = db.prepare('SELECT COUNT(*) c FROM sessions WHERE exam_id=?').get(e.id).c;
  if (p.questions && sn > 0) throw new HttpError(409, 'Questions cannot change after students have taken the exam. Duplicate it instead.');
  db.transaction(() => {
    db.prepare('UPDATE exams SET title=?,description=?,duration_sec=?,active=? WHERE id=?')
      .run(p.title, p.description, p.durationSec, req.body.active === false ? 0 : 1, e.id);
    if (p.questions) writeQuestions(e.id, p.questions);
  })();
  res.json({ ok: true });
});

admin.delete('/exams/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM exams WHERE id=?').get(req.params.id);
  if (!e) throw new HttpError(404, 'Exam not found');
  const sn = db.prepare('SELECT COUNT(*) c FROM sessions WHERE exam_id=?').get(e.id).c;
  if (sn > 0) { db.prepare('UPDATE exams SET active=0 WHERE id=?').run(e.id); return res.json({ ok: true, archived: true }); }
  db.prepare('DELETE FROM exams WHERE id=?').run(e.id);
  res.json({ ok: true, archived: false });
});

// ---------- examiner: sessions & reports ----------
function sweepExpired() {
  const stale = db.prepare("SELECT * FROM sessions WHERE status='in_progress' AND deadline + ? < ?").all(GRACE_MS, Date.now());
  stale.forEach(s => finalize(s, 'expired'));
}

admin.get('/sessions', (req, res) => {
  sweepExpired();
  const where = [], args = [];
  if (req.query.examId) { where.push('s.exam_id=?'); args.push(Number(req.query.examId)); }
  if (req.query.status) { where.push('s.status=?'); args.push(String(req.query.status)); }
  const rows = db.prepare(`
    SELECT s.*, u.name AS student, u.email, e.title
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN exams e ON e.id=s.exam_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 500`).all(...args);
  res.json({ sessions: rows.map(s => ({ ...sessionSummary(s), student: s.student, email: s.email,
    examTitle: s.title, reviewed: !!s.reviewed })) });
});

admin.get('/sessions.csv', (_req, res) => {
  sweepExpired();
  const rows = db.prepare(`
    SELECT s.*, u.name AS student, u.email, e.title
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN exams e ON e.id=s.exam_id ORDER BY s.id DESC`).all();
  const esc = (v) => { // also neutralise spreadsheet formula injection
    let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = ['Session', 'Student', 'Email', 'Exam', 'Status', 'Correct', 'Total', 'Integrity', 'Verdict', 'Flagged events', 'Started', 'Submitted'];
  const lines = [head.join(',')];
  for (const s of rows) {
    const sm = sessionSummary(s);
    lines.push([s.id, s.student, s.email, s.title, s.status, s.correct, s.total, s.integrity, sm.verdict, sm.flagged,
      new Date(s.started_at).toISOString(), s.submitted_at ? new Date(s.submitted_at).toISOString() : ''].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="invigil-sessions.csv"');
  res.send(lines.join('\n'));
});

admin.get('/sessions/:id', (req, res) => {
  const s = loadSession(req.params.id, req.user, { allowExaminer: true });
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(s.exam_id);
  const u = db.prepare('SELECT name,email FROM users WHERE id=?').get(s.user_id);
  const answers = JSON.parse(s.answers);
  res.json({
    ...resultPayload(s, exam),
    student: u, reviewed: !!s.reviewed, note: s.reviewer_note,
    answers: examQuestions(exam.id).map(q => ({ text: q.text, options: q.options, correct: q.answer,
      chosen: Number.isInteger(answers[q.id]) ? answers[q.id] : null })),
  });
});

admin.patch('/sessions/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(req.params.id);
  if (!s) throw new HttpError(404, 'Session not found');
  const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 2000) : s.reviewer_note;
  const reviewed = req.body.reviewed === undefined ? s.reviewed : (req.body.reviewed ? 1 : 0);
  db.prepare('UPDATE sessions SET reviewed=?, reviewer_note=? WHERE id=?').run(reviewed, note, s.id);
  res.json({ ok: true });
});

admin.get('/stats', (_req, res) => {
  sweepExpired();
  const g = (sql) => db.prepare(sql).get();
  res.json({
    exams: g('SELECT COUNT(*) c FROM exams WHERE active=1').c,
    students: g("SELECT COUNT(*) c FROM users WHERE role='student'").c,
    sessions: g("SELECT COUNT(*) c FROM sessions WHERE status!='in_progress'").c,
    live: g("SELECT COUNT(*) c FROM sessions WHERE status='in_progress'").c,
    needsReview: g("SELECT COUNT(*) c FROM sessions WHERE status!='in_progress' AND reviewed=0 AND integrity<80").c,
  });
});

app.use('/api/admin', admin);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// ---------- errors ----------
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

if (require.main === module) {
  seed();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    let parsed;
    try { parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { ws.close(1008, 'Invalid connection URL'); return; }

    const pairingToken = parsed.searchParams.get('token') || '';
    const role = parsed.searchParams.get('role') || '';
    console.log('[Third Eye] WebSocket connection:', { role, hasToken: Boolean(parsed.searchParams.get('token')) });
    const room = thirdEyeRooms.get(pairingToken);
    if (!room || room.expiresAt <= Date.now() || !['laptop', 'phone'].includes(role)) {
      ws.close(1008, 'Pairing token is invalid or expired');
      return;
    }
    if (role === 'phone' && room.phone && room.phone.readyState === 1) {
      ws.close(1008, 'A phone is already paired');
      return;
    }
    if (role === 'laptop' && room.laptop && room.laptop.readyState === 1) {
      ws.close(1008, 'Laptop is already connected');
      return;
    }

    room[role] = ws;
    ws.on('message', (raw) => {
      if (room.expiresAt <= Date.now()) {
        ws.close(1008, 'Pairing expired');
        return;
      }
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || !['offer', 'answer', 'ice', 'ready'].includes(message.type)) return;
      const other = role === 'laptop' ? room.phone : room.laptop;
      if (other && other.readyState === 1) {
        other.send(JSON.stringify({ type: message.type, data: message.data ?? null }));
      }
    });
    ws.on('close', (code, reason) => {
  console.log('[Third Eye] WebSocket closed:', {
    role,
    code,
    reason: reason.toString()
  });
      if (room[role] === ws) room[role] = null;
      if (!room.laptop && !room.phone) thirdEyeRooms.delete(pairingToken);
    });
  });

  server.listen(PORT, () => console.log(`Invigil running on http://localhost:${PORT}`));
}
module.exports = { app, sweepExpired };
