'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
const fdate = t => t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const ftime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const vClass = n => n >= 80 ? 'ok' : n >= 50 ? 'warn' : 'bad';

// ---------------- API ----------------
let token = sessionStorage.getItem('invigil_token');
let user = null;
async function api(method, path, body, raw) {
  const res = await fetch('/api' + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) { logout(true); }
    const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e;
  }
  return data;
}

// ---------------- Views ----------------
const VIEWS = ['auth', 'exams', 'landing', 'examView', 'report', 'admin'];
function show(id) { VIEWS.forEach(v => $(v).classList.toggle('hide', v !== id)); window.scrollTo(0, 0); }
function renderNav() {
  const nav = $('nav');
  if (!user) { nav.innerHTML = '<span class="st">Exam proctoring</span>'; return; }
  nav.innerHTML = `<span class="who">${esc(user.name)} · ${esc(user.role)}</span><button class="btn ghost sm" id="logoutBtn">Sign out</button>`;
  $('logoutBtn').onclick = () => logout();
}
function logout(expired) {
  if (examOn) stopExam();
  token = null; user = null; sessionStorage.removeItem('invigil_token');
  renderNav(); show('auth');
  if (expired) $('authErr').textContent = 'Your session expired. Please sign in again.';
}
function enter() {
  renderNav();
  if (user.role === 'examiner') { show('admin'); adminTab('overview'); } else { show('exams'); loadExams(); }
}

// ---------------- Auth ----------------
let regMode = false;
function authMode(reg) {
  regMode = reg;
  $('tabLogin').setAttribute('aria-selected', !reg); $('tabReg').setAttribute('aria-selected', reg);
  $('fName').classList.toggle('hide', !reg); $('fInvite').classList.toggle('hide', !reg);
  $('authGo').textContent = reg ? 'Create account' : 'Sign in';
  $('aPass').autocomplete = reg ? 'new-password' : 'current-password';
  $('authErr').textContent = '';
}
$('tabLogin').onclick = () => authMode(false);
$('tabReg').onclick = () => authMode(true);
$('authForm').onsubmit = async e => {
  e.preventDefault(); $('authErr').textContent = ''; $('authGo').disabled = true;
  try {
    const body = { email: $('aEmail').value, password: $('aPass').value };
    if (regMode) { body.name = $('aName').value; if ($('aInvite').value.trim()) body.inviteCode = $('aInvite').value.trim(); }
    const r = await api('POST', regMode ? '/auth/register' : '/auth/login', body);
    token = r.token; user = r.user; sessionStorage.setItem('invigil_token', token);
    $('aPass').value = ''; enter();
  } catch (err) { $('authErr').textContent = err.message; }
  finally { $('authGo').disabled = false; }
};

// ---------------- Student: exam list ----------------
let currentExam = null;
async function loadExams() {
  const [{ exams }, { sessions }] = await Promise.all([api('GET', '/exams'), api('GET', '/me/sessions')]);
  $('examGrid').innerHTML = exams.length ? '' : '<p class="st">No exams are available yet.</p>';
  exams.forEach(ex => {
    const d = document.createElement('div'); d.className = 'panel card';
    const r = ex.lastResult;
    d.innerHTML = `<h3>${esc(ex.title)}</h3><p>${esc(ex.description)}</p>
      <p>${ex.questionCount} questions · ${Math.round(ex.durationSec / 60)} min</p>
      ${r ? `<p>Last attempt: <span class="badge ${vClass(r.integrity)}">${esc(r.verdict)}</span> · ${r.correct}/${r.total}</p>` : ''}
      <button class="btn">${ex.inProgressSessionId ? 'Resume exam' : r ? 'Retake exam' : 'Start exam'}</button>`;
    d.querySelector('button').onclick = () => { currentExam = ex; openLanding(); };
    $('examGrid').append(d);
  });
  $('mineTbl').innerHTML = sessions.filter(s => s.status !== 'in_progress').map(s =>
    `<tr><td>${esc(s.examTitle)}</td><td>${s.correct}/${s.total}</td><td>${s.integrity}</td>
     <td><span class="badge ${vClass(s.integrity)}">${esc(s.verdict)}</span></td><td>${fdate(s.submittedAt)}</td></tr>`).join('')
    || '<tr><td colspan="5" class="st">No attempts yet.</td></tr>';
}

// ---------------- System check ----------------
let stream = null, hasDevices = false, analyser = null, audioCtx = null, faceDet = null;
function setSt(id, txt, cls) { const e = $(id); e.textContent = txt; e.className = 'st ' + (cls || ''); }
async function fullscreenOk() { try { await document.documentElement.requestFullscreen(); return true; } catch { return false; } }
function releaseDevices() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; analyser = null; if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
}
function openLanding() {
  releaseDevices(); hasDevices = false;
  $('lTitle').textContent = currentExam.title;
  ['cCam', 'cMic', 'cFs', 'cFace'].forEach(i => setSt(i, 'Not checked', ''));
  $('begin').disabled = true; $('noDev').classList.add('hide'); $('startErr').textContent = '';
  $('chkMsg').textContent = 'Allow camera and microphone when asked. If you have no camera, choose “Continue without devices” to use browser monitoring only.';
  show('landing');
}
$('backExams').onclick = () => { releaseDevices(); show('exams'); loadExams(); };
$('runCheck').onclick = async () => {
  $('chkMsg').textContent = 'Checking…'; $('startErr').textContent = '';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true });
    hasDevices = true; setSt('cCam', 'Ready', 'ok'); setSt('cMic', 'Ready', 'ok');
    $('vid').srcObject = stream; await $('vid').play().catch(() => {});
    setupAudio();
    if ('FaceDetector' in window) { try { faceDet = new FaceDetector({ fastMode: true, maxDetectedFaces: 3 }); } catch {} }
    setSt('cFace', faceDet ? 'Detecting…' : 'Using motion check', 'ok');
    const fs = await fullscreenOk(); setSt('cFs', fs ? 'Ready' : 'Blocked', fs ? 'ok' : 'bad');
    $('chkMsg').textContent = 'All set. You can begin the exam.'; $('begin').disabled = false;
  } catch (e) {
    setSt('cCam', 'Unavailable', 'bad'); setSt('cMic', 'Unavailable', 'bad'); setSt('cFace', 'Skipped', '');
    $('chkMsg').textContent = 'Camera or microphone could not be opened (' + (e.name || 'error') + '). Allow access in your browser, or continue with browser monitoring only.';
    $('noDev').classList.remove('hide');
  }
};
function setupAudio() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; src.connect(analyser);
  } catch { analyser = null; }
}
$('noDev').onclick = async () => { hasDevices = false; await fullscreenOk(); startExam(); };
$('begin').onclick = startExam;

// ---------------- Exam ----------------
let examOn = false, session = null, questions = [], ans = {}, cur = 0, deadlineLocal = 0, score = 100;
let timerH, loopH, saveH, quiet = false;
let prevFrame = null, noFace = 0, still = 0, loud = 0;
const lastSent = {};
const w = $('work'), wc = w.getContext('2d', { willReadFrequently: true });

async function startExam() {
  $('startErr').textContent = '';
  let data;
  try { data = await api('POST', `/exams/${currentExam.id}/start`, { hasDevices }); }
  catch (e) { $('startErr').textContent = e.message; return; }
  session = data.session; questions = data.questions; ans = data.answers || {}; cur = 0;
  score = session.integrity; deadlineLocal = Date.now() + data.remainingMs;
  Object.keys(lastSent).forEach(k => delete lastSent[k]);
  prevFrame = null; noFace = still = loud = 0;
  show('examView'); examOn = true;
  $('log').innerHTML = ''; updScore(); renderQ();
  data.events.slice().reverse().forEach(e => addLog(e.message + (e.penalty ? ` (−${e.penalty})` : ''), e.level, e.at));
  if (hasDevices) { $('vid').srcObject = stream; $('vid').play().catch(() => {}); $('dCam').className = 'dot'; $('dMic').className = 'dot'; }
  else { $('dCam').className = 'dot off'; $('dMic').className = 'dot off'; }
  addLog('Exam started' + (hasDevices ? '' : ' (browser monitoring only)'), '');
  tick(); timerH = setInterval(tick, 1000); loopH = setInterval(monitor, 500);
}
function tick() {
  const left = Math.max(0, Math.round((deadlineLocal - Date.now()) / 1000));
  $('timer').textContent = fmt(left);
  if (left <= 0) finish(true);
}
function stopExam() {
  closeThirdEye();
  examOn = false; clearInterval(timerH); clearInterval(loopH); clearTimeout(saveH);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  releaseDevices();
}

// ---------------- Third Eye phone camera ----------------
let thirdEyeSocket = null;
let thirdEyePeer = null;
let thirdEyePairToken = null;
let thirdEyeLocalIce = [];
let thirdEyeRemoteIce = [];

function setThirdEyeStatus(message) {
  const el = $('thirdEyeStatus');
  if (el) el.textContent = message;
}

function closeThirdEye() {
  if (thirdEyeSocket) {
    try { thirdEyeSocket.close(); } catch {}
    thirdEyeSocket = null;
  }
  if (thirdEyePeer) {
    try { thirdEyePeer.close(); } catch {}
    thirdEyePeer = null;
  }
  thirdEyePairToken = null;
  thirdEyeLocalIce = [];
  thirdEyeRemoteIce = [];
  const video = $('thirdEyeVideo');
  if (video) {
    video.pause();
    video.srcObject = null;
    video.style.display = 'none';
  }
  const qr = $('thirdEyeQr');
  if (qr) qr.replaceChildren();
}

async function pairThirdEyePhone() {
  if (!examOn || !session?.id) {
    setThirdEyeStatus('Start the exam before pairing a phone.');
    return;
  }
  const btn = $('thirdEyePair');
  btn.disabled = true;
  setThirdEyeStatus('Creating secure pairing QR code…');
  $('thirdEyeQr').replaceChildren();
  try {
    closeThirdEye();
    const data = await api('POST', `/sessions/${session.id}/third-eye/pair`, {});
    thirdEyePairToken = new URL(data.phoneUrl).searchParams.get('token');
    const img = document.createElement('img');
    img.alt = 'Third Eye phone pairing QR code';
    img.src = data.qrDataUrl;
    img.style.cssText = 'width:260px;max-width:100%;height:auto;background:#fff;padding:8px;border-radius:8px';
    $('thirdEyeQr').append(img);
    const link = document.createElement('a');
    link.href = data.phoneUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open phone pairing page';
    link.style.display = 'block';
    link.style.marginTop = '8px';
    $('thirdEyeQr').append(link);
    setThirdEyeStatus('Scan this QR code with your phone within 5 minutes. Open Invigil through your HTTPS tunnel for phone camera access.');

    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${location.host}/?role=laptop&token=${encodeURIComponent(thirdEyePairToken)}`;
    thirdEyeSocket = new WebSocket(wsUrl);
    thirdEyeSocket.onopen = () => setThirdEyeStatus('QR ready. Waiting for phone camera…');
    thirdEyeSocket.onerror = () => setThirdEyeStatus('Could not connect to signaling server. Check that Invigil is running.');
    thirdEyeSocket.onclose = () => {
      if (examOn && thirdEyePairToken) setThirdEyeStatus('Pairing connection closed. Generate a new QR code to try again.');
    };
    thirdEyeSocket.onmessage = async event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      try {
        if (msg.type === 'ready') {
          if (thirdEyePeer) thirdEyePeer.close();
          thirdEyePeer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
          thirdEyePeer.onicecandidate = e => {
            if (e.candidate && thirdEyeSocket?.readyState === WebSocket.OPEN) {
              thirdEyeSocket.send(JSON.stringify({ type: 'ice', data: e.candidate }));
            }
          };
          thirdEyePeer.ontrack = e => {
            const v = $('thirdEyeVideo');
            v.srcObject = e.streams[0];
            v.style.display = 'block';
            v.play().catch(() => {});
            setThirdEyeStatus('Phone camera connected.');
          };
          const offer = await thirdEyePeer.createOffer();
          await thirdEyePeer.setLocalDescription(offer);
          thirdEyeSocket.send(JSON.stringify({ type: 'offer', data: thirdEyePeer.localDescription }));
        } else if (msg.type === 'answer' && thirdEyePeer) {
          await thirdEyePeer.setRemoteDescription(msg.data);
          for (const candidate of thirdEyeRemoteIce) await thirdEyePeer.addIceCandidate(candidate);
          thirdEyeRemoteIce = [];
        } else if (msg.type === 'ice' && thirdEyePeer) {
          if (thirdEyePeer.remoteDescription) await thirdEyePeer.addIceCandidate(msg.data);
          else thirdEyeRemoteIce.push(msg.data);
        }
      } catch (e) {
        setThirdEyeStatus('Camera connection failed: ' + (e.message || 'WebRTC error'));
      }
    };
  } catch (e) {
    setThirdEyeStatus('Could not create pairing: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}
$('thirdEyePair')?.addEventListener('click', pairThirdEyePhone);

function renderQ() {
  const q = questions[cur];
  $('qNum').textContent = `Question ${cur + 1} of ${questions.length}`;
  $('qText').textContent = q.text; $('opts').innerHTML = '';
  q.options.forEach((t, i) => {
    const l = document.createElement('label'); l.className = 'opt' + (ans[q.id] === i ? ' sel' : '');
    l.innerHTML = '<input type="radio" name="o"' + (ans[q.id] === i ? ' checked' : '') + '>'; l.append(t);
    l.onclick = ev => { ev.preventDefault(); ans[q.id] = i; renderQ(); queueSave(); };
    $('opts').append(l);
  });
  $('prev').disabled = cur === 0; $('next').disabled = cur === questions.length - 1;
}
$('prev').onclick = () => { cur--; renderQ(); };
$('next').onclick = () => { cur++; renderQ(); };

function queueSave() {
  $('saveSt').textContent = 'Saving…'; clearTimeout(saveH);
  saveH = setTimeout(async () => {
    try { await api('PUT', `/sessions/${session.id}/answers`, { answers: ans }); $('saveSt').textContent = 'Answers saved'; }
    catch (e) { $('saveSt').textContent = e.status === 409 ? 'Exam closed' : 'Could not save — will retry on submit'; }
  }, 400);
}

$('submit').onclick = () => {
  quiet = true; const ok = confirm('Submit your exam now?'); setTimeout(() => quiet = false, 800);
  if (ok) finish(false);
};

function addLog(msg, lvl, at) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="t">${ftime(at || Date.now())}</span><span class="${esc(lvl || '')}"></span>`;
  li.lastChild.textContent = msg; $('log').prepend(li);
}
function toast(m) {
  const d = document.createElement('div'); d.className = 'flash'; d.textContent = '⚠ ' + m;
  document.body.append(d); setTimeout(() => d.remove(), 2200);
}
function updScore() {
  $('score').textContent = score; const m = $('meter'); m.style.width = score + '%';
  m.style.background = score > 75 ? 'var(--ok)' : score > 45 ? 'var(--warn)' : 'var(--bad)';
}

// Report a suspicious event to the server. The server decides the penalty.
async function report(type) {
  if (!examOn || quiet) return;
  const now = Date.now();
  if (lastSent[type] && now - lastSent[type] < 5000) return;
  lastSent[type] = now;
  try {
    const r = await api('POST', `/sessions/${session.id}/events`, { events: [{ type }] });
    score = r.integrity; updScore();
    r.accepted.forEach(ev => { addLog(`${ev.message} (−${ev.penalty})`, ev.level, ev.at); toast(ev.message); });
  } catch (e) { if (e.status === 409) finish(true); }
}

async function finish(timedOut) {
  if (!examOn) return;
  stopExam();
  let r;
  try { r = await api('POST', `/sessions/${session.id}/submit`, { answers: ans }); }
  catch (e) { alert('Could not submit: ' + e.message); show('exams'); loadExams(); return; }
  renderReport(r, $('repSum'), $('repTbl'), $('repLog'));
  show('report');
}
function renderReport(r, sumEl, tblEl, logEl, extraRows = '') {
  const s = r.session;
  sumEl.innerHTML = `Verdict: <span class="badge ${vClass(s.integrity)}">${esc(s.verdict)}</span>${s.status === 'expired' ? ' · time expired' : ''}`;
  tblEl.innerHTML = extraRows +
    `<tr><th>Answer score</th><td>${s.correct} / ${s.total}</td></tr>
     <tr><th>Integrity score</th><td>${s.integrity} / 100</td></tr>
     <tr><th>Flagged events</th><td>${r.flagged.length}</td></tr>
     <tr><th>Time used</th><td>${fmt(r.timeUsedSec)}</td></tr>
     <tr><th>Monitoring</th><td>${s.hasDevices ? 'Camera, microphone and browser' : 'Browser only'}</td></tr>`;
  logEl.innerHTML = r.flagged.length ? '' : '<li>No events were flagged.</li>';
  r.flagged.forEach(e => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="t">${ftime(e.at)}</span><span class="${esc(e.level)}"></span>`;
    li.lastChild.textContent = `${e.message} (−${e.penalty})`; logEl.append(li);
  });
}
$('again').onclick = () => { show('exams'); loadExams(); };

// ---------------- Monitoring (runs in the browser; only flags leave it) ----------------
async function monitor() {
  if (!examOn || !hasDevices) return;
  const v = $('vid'); if (v.readyState < 2) return;
  wc.drawImage(v, 0, 0, 64, 48);
  const d = wc.getImageData(0, 0, 64, 48).data; let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
  const bright = sum / (d.length / 4);
  let diff = 0;
  if (prevFrame) { for (let i = 0; i < d.length; i += 4) diff += Math.abs(d[i] - prevFrame[i]); diff /= d.length / 4; }
  prevFrame = new Uint8ClampedArray(d);
  if (bright < 18) { noFace++; $('dCam').className = 'dot off'; if (noFace >= 4) report('cover'); }
  else {
    let faces = null;
    if (faceDet) { try { faces = await faceDet.detect(v); } catch { faceDet = null; } }
    if (faces) {
      if (faces.length === 0) { noFace++; $('dCam').className = 'dot off'; if (noFace >= 4) report('face'); }
      else { noFace = 0; $('dCam').className = 'dot'; if (faces.length > 1) report('multi'); }
    } else {
      if (diff < 0.25) still++; else still = 0;
      if (diff > 28) report('move');
      if (still >= 40) report('still');
      $('dCam').className = 'dot'; noFace = 0;
    }
  }
  if (analyser) {
    const a = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(a);
    let s = 0; for (const x of a) s += Math.abs(x - 128);
    if (s / a.length > 14) { loud++; $('dMic').className = 'dot off'; if (loud >= 4) report('audio'); }
    else { loud = 0; $('dMic').className = 'dot'; }
  }
}
document.addEventListener('visibilitychange', () => {
  if (!examOn) return;
  if (document.hidden) { $('dTab').className = 'dot off'; report('tab'); } else $('dTab').className = 'dot';
});
window.addEventListener('blur', () => { if (examOn) report('blur'); });
document.addEventListener('fullscreenchange', () => { if (examOn && !document.fullscreenElement) report('fs'); });
['copy', 'cut', 'paste'].forEach(ev => document.addEventListener(ev, e => {
  if (examOn && !isTyping(e.target)) { e.preventDefault(); report(ev); }
}));
document.addEventListener('contextmenu', e => { if (examOn) { e.preventDefault(); report('ctx'); } });
document.addEventListener('keydown', e => {
  if (examOn && (e.ctrlKey || e.metaKey) && ['c', 'v', 'x', 'p', 's', 'u'].includes(e.key.toLowerCase())) { e.preventDefault(); report('key'); }
});
function isTyping() { return false; } // exam answers are multiple choice: block clipboard everywhere

// ---------------- Examiner ----------------
const ADM = ['admOverview', 'admExams', 'admEditor', 'admDetail'];
function admShow(id) { ADM.forEach(v => $(v).classList.toggle('hide', v !== id)); }
function adminTab(t) {
  $('atOverview').setAttribute('aria-selected', t === 'overview'); $('atExams').setAttribute('aria-selected', t === 'exams');
  if (t === 'overview') { admShow('admOverview'); loadOverview(); } else { admShow('admExams'); loadAdminExams(); }
}
$('atOverview').onclick = () => adminTab('overview');
$('atExams').onclick = () => adminTab('exams');

async function loadOverview() {
  const [st, ex] = await Promise.all([api('GET', '/admin/stats'), api('GET', '/admin/exams')]);
  $('stats').innerHTML = [['Active exams', st.exams], ['Students', st.students], ['Completed sessions', st.sessions],
    ['In progress now', st.live], ['Need review', st.needsReview]].map(([l, n]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
  const sel = $('fExam'), keep = sel.value;
  sel.innerHTML = '<option value="">All exams</option>' + ex.exams.map(e => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  sel.value = keep; loadSessions();
}
async function loadSessions() {
  const q = new URLSearchParams(); if ($('fExam').value) q.set('examId', $('fExam').value); if ($('fStatus').value) q.set('status', $('fStatus').value);
  const { sessions } = await api('GET', '/admin/sessions?' + q);
  $('sessTbl').innerHTML = sessions.map(s => `<tr class="click" data-id="${s.id}">
    <td>${esc(s.student)}<br><span class="who">${esc(s.email)}</span></td><td>${esc(s.examTitle)}</td>
    <td>${esc(s.status.replace('_', ' '))}</td><td>${s.correct ?? '—'}${s.total ? ' / ' + s.total : ''}</td>
    <td><span class="badge ${vClass(s.integrity)}">${s.integrity}</span></td><td>${s.flagged}</td><td>${s.reviewed ? '✓' : ''}</td></tr>`).join('')
    || '<tr><td colspan="7" class="st">No sessions yet.</td></tr>';
  $('sessTbl').querySelectorAll('tr.click').forEach(tr => tr.onclick = () => openSession(tr.dataset.id));
}
$('fExam').onchange = loadSessions; $('fStatus').onchange = loadSessions; $('refresh').onclick = loadOverview;
$('csv').onclick = async () => {
  const res = await api('GET', '/admin/sessions.csv', null, true); const blob = await res.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'invigil-sessions.csv'; a.click(); URL.revokeObjectURL(a.href);
};

let detailId = null;
async function openSession(id) {
  const r = await api('GET', '/admin/sessions/' + id); detailId = id;
  $('dTitle').textContent = `${r.student.name} — ${r.exam.title}`;
  renderReport(r, $('dSum'), $('dTbl'), $('dLog'),
    `<tr><th>Student</th><td>${esc(r.student.name)} (${esc(r.student.email)})</td></tr><tr><th>Started</th><td>${fdate(r.session.startedAt)}</td></tr>`);
  $('dAns').innerHTML = r.answers.map((a, i) => `<p><b>${i + 1}. ${esc(a.text)}</b><br>
    <span class="ans ${a.chosen === a.correct ? 'good' : 'wrong'}">${a.chosen === null ? 'No answer' : esc(a.options[a.chosen])}</span>
    ${a.chosen === a.correct ? '' : ` · correct: ${esc(a.options[a.correct])}`}</p>`).join('');
  $('dNote').value = r.note || ''; $('dRev').checked = r.reviewed; admShow('admDetail');
}
$('backSess').onclick = () => { admShow('admOverview'); loadOverview(); };
$('dSave').onclick = async () => {
  await api('PATCH', '/admin/sessions/' + detailId, { note: $('dNote').value, reviewed: $('dRev').checked });
  $('dSave').textContent = 'Saved ✓'; setTimeout(() => $('dSave').textContent = 'Save review', 1500);
};

async function loadAdminExams() {
  const { exams } = await api('GET', '/admin/exams');
  $('admExamList').innerHTML = exams.length ? '' : '<p class="st">No exams yet.</p>';
  exams.forEach(e => {
    const d = document.createElement('div'); d.className = 'panel card';
    d.innerHTML = `<h3>${esc(e.title)} ${e.active ? '' : '<span class="badge">archived</span>'}</h3><p>${esc(e.description)}</p>
      <p>${e.questionCount} questions · ${Math.round(e.durationSec / 60)} min · ${e.sessionCount} attempts</p>
      <div class="row"><button class="btn sm" data-a="edit">Edit</button><button class="btn ghost sm" data-a="del">${e.sessionCount ? 'Archive' : 'Delete'}</button></div>`;
    d.querySelector('[data-a=edit]').onclick = () => openEditor(e.id);
    d.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(e.sessionCount ? 'Archive this exam? Students will no longer see it.' : 'Delete this exam?')) return;
      await api('DELETE', '/admin/exams/' + e.id); loadAdminExams();
    };
    $('admExamList').append(d);
  });
}

let editId = null, edQs = [], edLocked = false;
const blankQ = () => ({ text: '', options: ['', '', '', ''], answer: 0 });
$('newExam').onclick = () => openEditor(null);
async function openEditor(id) {
  editId = id; edLocked = false; $('edErr').textContent = ''; $('edLock').textContent = '';
  if (id) {
    const { exam } = await api('GET', '/admin/exams/' + id);
    $('edTitleH').textContent = 'Edit exam'; $('edTitle').value = exam.title; $('edDesc').value = exam.description;
    $('edDur').value = Math.round(exam.durationSec / 60); edQs = exam.questions;
    if (exam.sessionCount) { edLocked = true; $('edLock').textContent = 'Students have already taken this exam, so questions are locked. You can still change the title, description and duration.'; }
  } else {
    $('edTitleH').textContent = 'New exam'; $('edTitle').value = ''; $('edDesc').value = ''; $('edDur').value = 30; edQs = [blankQ()];
  }
  renderQEditor(); admShow('admEditor');
}
function renderQEditor() {
  const box = $('edQs'); box.innerHTML = ''; $('addQ').classList.toggle('hide', edLocked);
  edQs.forEach((q, qi) => {
    const d = document.createElement('div'); d.className = 'qedit';
    d.innerHTML = `<label class="field"><span>Question ${qi + 1}</span><textarea ${edLocked ? 'disabled' : ''}></textarea></label><div class="opts"></div>
      ${edLocked ? '' : '<button class="btn ghost sm" data-a="addo">+ Option</button> <button class="btn ghost sm" data-a="delq">Remove question</button>'}`;
    const ta = d.querySelector('textarea'); ta.value = q.text; ta.oninput = () => q.text = ta.value;
    const ob = d.querySelector('.opts');
    q.options.forEach((o, oi) => {
      const r = document.createElement('div'); r.className = 'orow';
      r.innerHTML = `<input type="radio" name="c${qi}" title="Correct answer" ${q.answer === oi ? 'checked' : ''} ${edLocked ? 'disabled' : ''}>
        <input type="text" maxlength="300" placeholder="Option ${oi + 1}" ${edLocked ? 'disabled' : ''}>
        ${edLocked || q.options.length <= 2 ? '' : '<button class="btn ghost sm" type="button">✕</button>'}`;
      const [rad, txt] = r.querySelectorAll('input'); txt.value = o;
      rad.onchange = () => q.answer = oi; txt.oninput = () => q.options[oi] = txt.value;
      const x = r.querySelector('button'); if (x) x.onclick = () => { q.options.splice(oi, 1); if (q.answer >= q.options.length) q.answer = 0; else if (q.answer > oi) q.answer--; renderQEditor(); };
      ob.append(r);
    });
    const ao = d.querySelector('[data-a=addo]'); if (ao) ao.onclick = () => { if (q.options.length < 8) { q.options.push(''); renderQEditor(); } };
    const dq = d.querySelector('[data-a=delq]'); if (dq) dq.onclick = () => { if (edQs.length > 1) { edQs.splice(qi, 1); renderQEditor(); } };
    box.append(d);
  });
}
$('addQ').onclick = () => { edQs.push(blankQ()); renderQEditor(); };
$('cancelExam').onclick = () => adminTab('exams');
$('saveExam').onclick = async () => {
  $('edErr').textContent = '';
  const body = { title: $('edTitle').value, description: $('edDesc').value, durationMinutes: Number($('edDur').value) };
  if (!edLocked) body.questions = edQs;
  try {
    if (editId) await api('PUT', '/admin/exams/' + editId, body); else await api('POST', '/admin/exams', body);
    adminTab('exams');
  } catch (e) { $('edErr').textContent = e.message; }
};

// ---------------- Boot ----------------
(async function boot() {
  if (token) {
    try { user = (await api('GET', '/auth/me')).user; enter(); return; } catch { token = null; }
  }
  show('auth');
})();
