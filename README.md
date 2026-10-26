# Invigil — AI exam proctor (full stack)

Your original single-file demo, turned into a real application: **Node/Express + SQLite backend** and a
**vanilla-JS frontend** (same look and the same in-browser camera, microphone and lockdown monitoring).

## Quick start

```bash
npm install
cp .env.example .env      # then edit JWT_SECRET and ADMIN_PASSWORD
npm start                 # http://localhost:3000
npm test                  # end-to-end smoke test (uses a temporary database)
```

First run seeds an examiner account (`ADMIN_EMAIL` / `ADMIN_PASSWORD`) and a demo exam (your 5 questions).
Outside production it also creates `student@invigil.local` / `Student123!`.

> Camera/microphone/fullscreen need a **secure context**: use `localhost` or serve over HTTPS.

## What changed from the demo

| Demo (client only)                    | Now                                                                 |
|---------------------------------------|---------------------------------------------------------------------|
| Questions + answers in page source    | Stored in DB; **correct answers never sent to students**            |
| Score computed in the browser         | **Graded on the server**                                            |
| Integrity penalties in the browser    | **Server decides penalties**, rate-limits events, ignores forged ones |
| Timer in the browser                  | **Server deadline**; late edits rejected, expired exams auto-closed |
| Report vanished on refresh            | Every session, event and result persisted                           |
| No users                              | Student / examiner accounts (bcrypt + JWT)                          |
| —                                     | Examiner dashboard: exam builder, session review, notes, CSV export |

## Privacy

Video and audio are analysed **in the browser only** and are never uploaded. The backend receives just the
event type (e.g. `tab`, `multi`, `audio`). Tell students this up front, and check the consent and data-retention
rules that apply to you before using proctoring for real assessments.

## Roles

* **Student** — registers, picks an exam, runs the system check, takes the exam, sees their report. A page reload
  mid-exam resumes the same session with the remaining time.
* **Examiner** — signs in, builds exams, watches the sessions table, opens a session for the full event timeline
  and answer review, leaves notes, marks reviewed, downloads CSV. To create more examiners, set
  `EXAMINER_INVITE_CODE` and have them enter it on the *Create account* tab.

## API

All routes are under `/api`; send `Authorization: Bearer <token>`.

| Method & path                        | Who      | Purpose                                              |
|--------------------------------------|----------|------------------------------------------------------|
| `POST /auth/register`, `/auth/login` | public   | Returns `{ token, user }` (rate-limited)             |
| `GET /auth/me`                       | any      | Current user                                         |
| `GET /exams`                         | any      | Active exams + your in-progress/last result          |
| `POST /exams/:id/start`              | student  | Start or resume a session; returns questions (no answers) and remaining time |
| `PUT /sessions/:id/answers`          | owner    | Autosave `{ answers: { [questionId]: optionIndex } }` |
| `POST /sessions/:id/events`          | owner    | Report `{ events: [{ type }] }`; returns server-computed integrity |
| `POST /sessions/:id/submit`          | owner    | Final answers → graded report                        |
| `GET /sessions/:id`, `/me/sessions`  | owner    | Resume / history                                     |
| `GET/POST/PUT/DELETE /admin/exams…`  | examiner | Exam CRUD (questions lock once attempted; delete archives) |
| `GET /admin/sessions`, `/admin/sessions/:id`, `PATCH …` | examiner | Review, notes, reviewed flag |
| `GET /admin/sessions.csv`, `/admin/stats` | examiner | Export and dashboard numbers                    |

Event types and their penalties live in `src/rules.js` — edit them there.

## Layout

```
src/server.js   routes, auth, grading, timer enforcement
src/db.js       SQLite schema (users, exams, questions, sessions, events)
src/rules.js    proctoring event catalogue + penalties
src/seed.js     first-run examiner + demo exam
public/         index.html, styles.css, app.js (your UI, wired to the API)
test/smoke.js   end-to-end test
```

## Deploying

* Set `NODE_ENV=production`, a long random `JWT_SECRET`, and a strong `ADMIN_PASSWORD`.
* Put it behind HTTPS (Caddy, nginx, or your platform's TLS). `docker build -t invigil . && docker run -p 3000:3000 -v invigil:/data -e JWT_SECRET=… invigil`.
* Back up the SQLite file at `DB_PATH`. For many concurrent exams, move to Postgres (the SQL is plain and portable).

## Known limits (be honest with your users)

Browser-based proctoring is a deterrent and a flagging aid, not proof of cheating. A determined student can use a
second device, and the face check falls back to a crude motion heuristic in browsers without the `FaceDetector`
API (mostly Chromium). Treat the integrity score as a prompt for human review — the verdict text already says so.
