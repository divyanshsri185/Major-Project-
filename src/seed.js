const bcrypt = require('bcryptjs');
const db = require('./db');

const DEMO_QUESTIONS = [
  { q: 'Which layer of the OSI model is responsible for routing packets between networks?', o: ['Data link', 'Network', 'Transport', 'Session'], a: 1 },
  { q: 'What is the time complexity of binary search on a sorted array?', o: ['O(n)', 'O(n log n)', 'O(log n)', 'O(1)'], a: 2 },
  { q: 'Which HTTP status code means the resource was not found?', o: ['200', '301', '403', '404'], a: 3 },
  { q: 'In machine learning, overfitting means the model…', o: ['Performs well on training data but poorly on new data', 'Performs poorly everywhere', 'Has too few parameters', 'Trains too quickly'], a: 0 },
  { q: 'Which data structure uses last-in, first-out ordering?', o: ['Queue', 'Stack', 'Heap', 'Graph'], a: 1 },
];

function seed({ quiet = false } = {}) {
  const now = Date.now();
  let admin = db.prepare("SELECT * FROM users WHERE role='examiner' LIMIT 1").get();

  if (!admin) {
    const email = process.env.ADMIN_EMAIL || 'examiner@invigil.local';
    const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    const info = db.prepare(
      'INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)'
    ).run('Chief Examiner', email, bcrypt.hashSync(password, 10), 'examiner', now);
    admin = { id: info.lastInsertRowid };
    if (!quiet) console.log(`[seed] examiner created: ${email}  (password from ADMIN_PASSWORD or default)`);
  }

  if (process.env.NODE_ENV !== 'production') {
    const exists = db.prepare("SELECT 1 FROM users WHERE email='student@invigil.local'").get();
    if (!exists) {
      db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
        .run('Demo Student', 'student@invigil.local', bcrypt.hashSync('Student123!', 10), 'student', now);
      if (!quiet) console.log('[seed] demo student: student@invigil.local / Student123!');
    }
  }

  if (!db.prepare('SELECT 1 FROM exams LIMIT 1').get()) {
    const tx = db.transaction(() => {
      const e = db.prepare(
        'INSERT INTO exams (title,description,duration_sec,created_by,created_at) VALUES (?,?,?,?,?)'
      ).run('Computing fundamentals — demo', 'Five multiple-choice questions on networking, algorithms, web and ML basics.', 600, admin.id, now);
      const ins = db.prepare('INSERT INTO questions (exam_id,position,text,options,answer) VALUES (?,?,?,?,?)');
      DEMO_QUESTIONS.forEach((q, i) => ins.run(e.lastInsertRowid, i, q.q, JSON.stringify(q.o), q.a));
    });
    tx();
    if (!quiet) console.log('[seed] demo exam created');
  }
}

module.exports = { seed };
if (require.main === module) seed();
