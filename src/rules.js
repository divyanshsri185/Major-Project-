// Server-side catalogue of proctoring events. The server — not the browser —
// decides how many integrity points each event costs, so a tampered client
// cannot hide violations or inflate its own score.
const RULES = {
  cover:  { msg: 'Camera appears covered or very dark',           pen: 8,  lvl: 'b' },
  face:   { msg: 'No face detected in frame',                     pen: 6,  lvl: 'w' },
  multi:  { msg: 'More than one face detected',                   pen: 10, lvl: 'b' },
  move:   { msg: 'Sudden movement in frame',                      pen: 3,  lvl: 'w' },
  still:  { msg: 'No movement for 20 seconds',                    pen: 4,  lvl: 'w' },
  audio:  { msg: 'Sustained loud sound or talking',               pen: 5,  lvl: 'w' },
  tab:    { msg: 'Switched tab or minimised window',              pen: 10, lvl: 'b' },
  blur:   { msg: 'Exam window lost focus',                        pen: 5,  lvl: 'w' },
  fs:     { msg: 'Left full-screen mode',                         pen: 6,  lvl: 'w' },
  copy:   { msg: 'Blocked copy attempt',                          pen: 3,  lvl: 'w' },
  cut:    { msg: 'Blocked cut attempt',                           pen: 3,  lvl: 'w' },
  paste:  { msg: 'Blocked paste attempt',                         pen: 3,  lvl: 'w' },
  ctx:    { msg: 'Right-click blocked',                           pen: 2,  lvl: 'w' },
  key:    { msg: 'Blocked keyboard shortcut',                     pen: 3,  lvl: 'w' },
  // informational (no penalty, not "flagged")
  start:  { msg: 'Exam started',                                  pen: 0,  lvl: '' },
  submit: { msg: 'Exam submitted',                                pen: 0,  lvl: '' },
  expire: { msg: 'Time expired — exam auto-submitted',            pen: 0,  lvl: '' },
};

// Client may only report these; start/submit/expire are server-generated.
const CLIENT_TYPES = new Set(Object.keys(RULES).filter(k => !['start', 'submit', 'expire'].includes(k)));

// Same event type is only counted once per this many ms (matches the UI behaviour).
const RATE_LIMIT_MS = 5000;

function verdict(score) {
  return score >= 80 ? 'Clean session'
       : score >= 50 ? 'Review recommended'
       : 'High risk — manual review required';
}

module.exports = { RULES, CLIENT_TYPES, RATE_LIMIT_MS, verdict };
