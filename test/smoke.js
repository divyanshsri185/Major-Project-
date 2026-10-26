// End-to-end smoke test. Runs the real server against a temporary database.
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `invigil-test-${Date.now()}.db`);
process.env.JWT_SECRET = 'test-secret';
process.env.EXAMINER_INVITE_CODE = 'letmein';
process.env.ADMIN_PASSWORD = 'AdminPass123!';
const assert = require('assert');
const { seed } = require('./../src/seed');
const { app } = require('./../src/server');
const db = require('./../src/db');

(async () => {
  seed({ quiet: true });
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body, token) => {
    const r = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; } return { status: r.status, body: j };
  };
  const ok = (n) => console.log('  ✓ ' + n);

  // auth
  let r = await call('POST', '/auth/register', { name: 'Ann Student', email: 'ann@x.com', password: 'password1' });
  assert.equal(r.status, 201); const ann = r.body.token; ok('student registers');
  r = await call('POST', '/auth/register', { name: 'Ann Two', email: 'ANN@x.com', password: 'password1' }); assert.equal(r.status, 409); ok('duplicate email rejected (case-insensitive)');
  r = await call('POST', '/auth/register', { name: 'Eve', email: 'eve@x.com', password: 'password1', inviteCode: 'wrong' }); assert.equal(r.status, 403); ok('bad invite code rejected');
  r = await call('POST', '/auth/login', { email: 'ann@x.com', password: 'nope' }); assert.equal(r.status, 401); ok('wrong password rejected');
  r = await call('POST', '/auth/login', { email: 'examiner@invigil.local', password: 'AdminPass123!' }); assert.equal(r.status, 200); const adm = r.body.token; ok('seeded examiner logs in');

  // permissions
  r = await call('GET', '/admin/stats', null, ann); assert.equal(r.status, 403); ok('student blocked from admin API');
  r = await call('GET', '/exams'); assert.equal(r.status, 401); ok('unauthenticated blocked');

  // exam start — answers must never reach the student
  r = await call('GET', '/exams', null, ann); const examId = r.body.exams[0].id;
  r = await call('POST', `/exams/${examId}/start`, { hasDevices: true }, ann); assert.equal(r.status, 201);
  assert.ok(!JSON.stringify(r.body).includes('"answer"')); ok('correct answers are not sent to the student');
  const sid = r.body.session.id; const qs = r.body.questions;
  const r2 = await call('POST', `/exams/${examId}/start`, {}, ann); assert.equal(r2.body.session.id, sid); ok('second start resumes the same session');

  // events: server-authoritative penalties + rate limit + unknown types
  r = await call('POST', `/sessions/${sid}/events`, { events: [{ type: 'tab' }, { type: 'tab' }, { type: 'bogus' }, { type: 'submit' }, { type: 'multi', penalty: -999 }] }, ann);
  assert.equal(r.body.accepted.length, 2); assert.equal(r.body.integrity, 100 - 10 - 10); ok('penalties set by server; duplicates, unknown & forged types ignored');

  // answers
  const chosen = {}; qs.forEach((q, i) => chosen[q.id] = i === 0 ? 1 : 0); // correct for Q1 (index 1) and Q4 (index 0)
  r = await call('PUT', `/sessions/${sid}/answers`, { answers: { ...chosen, 99999: 1 } }, ann); assert.equal(r.status, 200);
  r = await call('GET', `/sessions/${sid}`, null, ann); assert.equal(Object.keys(r.body.answers).length, qs.length); ok('answers autosave (foreign question ids dropped)');

  // another student cannot touch it
  r = await call('POST', '/auth/register', { name: 'Bob', email: 'bob@x.com', password: 'password1' }); const bob = r.body.token;
  r = await call('GET', `/sessions/${sid}`, null, bob); assert.equal(r.status, 404); ok("students cannot access each other's sessions");

  // submit + grading
  r = await call('POST', `/sessions/${sid}/submit`, { answers: chosen }, ann);
  assert.equal(r.body.session.status, 'submitted'); assert.equal(r.body.session.correct, 2); // Q1 (idx 1) and Q4 (idx 0) are right
  ok(`graded on the server: ${r.body.session.correct}/${r.body.session.total}, integrity ${r.body.session.integrity}, verdict "${r.body.session.verdict}"`);
  r = await call('POST', `/sessions/${sid}/events`, { events: [{ type: 'tab' }] }, ann); assert.equal(r.status, 409); ok('events rejected after submission');
  r = await call('PUT', `/sessions/${sid}/answers`, { answers: { [qs[0].id]: 0 } }, ann); assert.equal(r.status, 409); ok('answers locked after submission');

  // server-side timer
  r = await call('POST', `/exams/${examId}/start`, {}, bob); const bobSid = r.body.session.id;
  db.prepare('UPDATE sessions SET deadline=? WHERE id=?').run(Date.now() - 60_000, bobSid);
  r = await call('PUT', `/sessions/${bobSid}/answers`, { answers: { [qs[0].id]: 1 } }, bob); assert.equal(r.status, 409);
  r = await call('GET', `/sessions/${bobSid}`, null, bob); assert.equal(r.body.session.status, 'expired'); ok('expired sessions are auto-closed by the server');

  // examiner views
  r = await call('GET', '/admin/sessions', null, adm); assert.equal(r.body.sessions.length, 2);
  r = await call('GET', `/admin/sessions/${sid}`, null, adm); assert.ok(r.body.events.length >= 4 && r.body.answers[0].correct !== undefined); ok('examiner sees full timeline and correct answers');
  r = await call('PATCH', `/admin/sessions/${sid}`, { reviewed: true, note: 'Looked at tab switches; fine.' }, adm); assert.equal(r.status, 200);
  r = await fetch(base + '/api/admin/sessions.csv', { headers: { Authorization: 'Bearer ' + adm } }); const csv = await r.text(); assert.ok(csv.startsWith('Session,Student')); ok('CSV export works');

  // exam management
  r = await call('POST', '/admin/exams', { title: 'Bad', durationMinutes: 10, questions: [{ text: 'Q?', options: ['a', 'b'], answer: 5 }] }, adm); assert.equal(r.status, 400);
  r = await call('POST', '/admin/exams', { title: 'New exam', durationMinutes: 10, questions: [{ text: 'Pick a', options: ['a', 'b'], answer: 0 }] }, adm); assert.equal(r.status, 201); ok('examiner creates exam; invalid exam rejected');
  r = await call('PUT', `/admin/exams/${examId}`, { title: 'Renamed', durationMinutes: 10, questions: [{ text: 'Pick one', options: ['a', 'b'], answer: 0 }] }, adm); assert.equal(r.status, 409); ok('questions locked once students have attempted');
  r = await call('DELETE', `/admin/exams/${examId}`, null, adm); assert.equal(r.body.archived, true); ok('exam with attempts is archived, not deleted');

  // static frontend + security headers
  r = await fetch(base + '/'); assert.equal(r.status, 200); assert.ok((await r.text()).includes('Invigil'));
  assert.ok(r.headers.get('content-security-policy')); assert.ok(r.headers.get('permissions-policy').includes('camera=(self)')); ok('frontend served with CSP + camera permissions policy');

  srv.close(); console.log('\nAll checks passed.'); process.exit(0);
})().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
