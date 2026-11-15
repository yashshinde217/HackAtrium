const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hackatrium-admin';
const SITE = { name: 'Hack Atrium', season: 'S01' };
if (!process.env.ADMIN_PASSWORD) console.warn('⚠  ADMIN_PASSWORD not set — using the default "hackatrium-admin". Set it before deploying!');

app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: false }));

/* ------------------------------------------------------------------ */
/* Page rendering: views/<page>.html is wrapped in views/layout.html  */
/* ------------------------------------------------------------------ */
const VIEWS = path.join(__dirname, 'views');
const read = (f) => fs.readFileSync(path.join(VIEWS, f), 'utf8');
const PAGES = {
  '/':                 { view: 'home',     title: 'Hack Atrium S01 — Ride the Tide of Innovation', js: ['home'] },
  '/apply':            { view: 'apply',    title: 'Apply | Hack Atrium S01', js: ['apply'] },
  '/refer':            { view: 'refer',    title: 'Referral Program | Hack Atrium S01', js: ['refer'] },
  '/contact':          { view: 'contact',  title: 'Contact | Hack Atrium S01', js: ['contact'] },
  '/sponsorship':      { view: 'sponsorship', title: 'Sponsorship | Hack Atrium S01', js: ['sponsorship'] },
  '/gallery':          { view: 'gallery',  title: 'Gallery | Hack Atrium S01', js: ['gallery'] },
  '/about':            { view: 'about',    title: 'About | Hack Atrium S01', js: [] },
  '/code-of-conduct':  { view: 'code-of-conduct', title: 'Code of Conduct | Hack Atrium S01', js: [] },
  '/privacy-policy':   { view: 'privacy-policy',  title: 'Privacy Policy | Hack Atrium S01', js: [] },
  '/terms':            { view: 'terms',    title: 'Terms & Conditions | Hack Atrium S01', js: [] },
  '/admin':            { view: 'admin',    title: 'Admin | Hack Atrium S01', js: ['admin'], bare: true },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render(res, page, extra = {}, status = 200) {
  const layout = read('layout.html');
  let body = read(page.view + '.html');
  for (const [k, v] of Object.entries(extra)) body = body.split(`{{${k}}}`).join(v);
  const scripts = page.js.map((j) => `<script src="/js/${j}.js"></script>`).join('\n');
  const html = layout
    .replace('{{TITLE}}', esc(page.title))
    .replace('{{BODY_CLASS}}', 'page-' + page.view + (page.bare ? ' bare' : ''))
    .replace('{{BODY}}', body)
    .replace('{{SCRIPTS}}', scripts);
  res.status(status).type('html').send(html);
}

for (const [route, page] of Object.entries(PAGES)) app.get(route, (req, res) => render(res, page));

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[0-9 ()-]{7,20}$/;
const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, error: msg });

// tiny in-memory rate limiter for public POST endpoints
const hits = new Map();
function limit(max = 10, windowMs = 60_000) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return bad(res, 'Too many requests — please wait a minute and try again.', 429);
    arr.push(now); hits.set(key, arr); next();
  };
}
setInterval(() => hits.clear(), 10 * 60_000).unref();

async function makeCode(name) {
  const base = (name.replace(/[^a-z]/gi, '').toUpperCase() + 'XXXX').slice(0, 4);
  for (;;) {
    const code = `HA-${base}${crypto.randomInt(100, 999)}`;
    const check = await db.query('SELECT 1 FROM ambassadors WHERE code = $1', [code]);
    if (check.rows.length === 0) return code;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */
const POINTS_PER_MEMBER = 25;
const TRACKS = ['Hack Atrium Open', 'Build For Good'];

app.post('/api/register', limit(5), async (req, res) => {
  try {
    const b = req.body || {};
    const team = clean(b.teamName, 60), track = clean(b.track, 40);
    const leader = { name: clean(b.leaderName, 80), email: clean(b.leaderEmail, 120).toLowerCase(), phone: clean(b.leaderPhone, 20) };
    const college = clean(b.college, 120), idea = clean(b.idea, 1000), ref = clean(b.referralCode, 20).toUpperCase();
    const members = Array.isArray(b.members) ? b.members.slice(0, 3).map((m) => ({ name: clean(m?.name, 80), email: clean(m?.email, 120).toLowerCase() })).filter((m) => m.name || m.email) : [];

    if (!team || !leader.name || !college) return bad(res, 'Please fill in team name, your name and college.');
    if (!TRACKS.includes(track)) return bad(res, 'Please choose a track.');
    if (!EMAIL.test(leader.email)) return bad(res, 'Please enter a valid email address.');
    if (!PHONE.test(leader.phone)) return bad(res, 'Please enter a valid phone number.');
    if (members.length < 1) return bad(res, 'Teams need at least 2 members (you + 1).');
    for (const m of members) if (!m.name || !EMAIL.test(m.email)) return bad(res, 'Every team member needs a name and a valid email.');
    if (!b.agree) return bad(res, 'Please accept the Code of Conduct.');

    const existingTeam = await db.query('SELECT 1 FROM registrations WHERE leader_email = $1', [leader.email]);
    if (existingTeam.rows.length > 0) return bad(res, 'A team is already registered with this email.', 409);

    let amb = null;
    if (ref) {
      const ambCheck = await db.query('SELECT id, name FROM ambassadors WHERE code = $1', [ref]);
      if (ambCheck.rows.length === 0) return bad(res, 'That referral code does not exist. Leave it empty or check for typos.');
      amb = ambCheck.rows[0];
    }

    const insertRes = await db.query(
      `INSERT INTO registrations (team_name, track, leader_name, leader_email, leader_phone, college, members, idea, referral_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [team, track, leader.name, leader.email, leader.phone, college, JSON.stringify(members), idea, amb ? ref : null]
    );

    const insertedId = insertRes.rows[0].id;

    if (amb) {
      await db.query('UPDATE ambassadors SET points = points + $1 WHERE id = $2', [POINTS_PER_MEMBER * (members.length + 1), amb.id]);
    }

    res.json({ ok: true, id: insertedId, ticket: `HA01-${String(insertedId).padStart(4, '0')}`, referredBy: amb ? amb.name : null });
  } catch (err) {
    console.error('Registration error:', err);
    bad(res, 'Internal server error during registration', 500);
  }
});

app.post('/api/referrals', limit(5), async (req, res) => {
  try {
    const b = req.body || {};
    const d = { name: clean(b.name, 80), phone: clean(b.phone, 20), email: clean(b.email, 120).toLowerCase(), college: clean(b.college, 120), department: clean(b.department, 60), semester: clean(b.semester, 20) };
    if (!d.name || !d.college) return bad(res, 'Please fill in your name and college.');
    if (!EMAIL.test(d.email)) return bad(res, 'Please enter a valid email address.');
    if (!PHONE.test(d.phone)) return bad(res, 'Please enter a valid phone number.');

    const existing = await db.query('SELECT code, points FROM ambassadors WHERE email = $1', [d.email]);
    if (existing.rows.length > 0) return res.json({ ok: true, code: existing.rows[0].code, points: existing.rows[0].points, existing: true });

    const code = await makeCode(d.name);
    await db.query(
      'INSERT INTO ambassadors (code, name, phone, email, college, department, semester) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [code, d.name, d.phone, d.email, d.college, d.department, d.semester]
    );
    res.json({ ok: true, code, points: 0 });
  } catch (err) {
    console.error('Referral error:', err);
    bad(res, 'Internal server error', 500);
  }
});

app.get('/api/referrals/leaderboard', async (req, res) => {
  try {
    const result = await db.query('SELECT name, college, points FROM ambassadors WHERE points > 0 ORDER BY points DESC, created_at ASC LIMIT 10');
    const rows = result.rows;
    res.json({ ok: true, rows: rows.map((r) => ({ name: r.name.split(' ')[0] + (r.name.split(' ')[1] ? ' ' + r.name.split(' ')[1][0] + '.' : ''), college: r.college, points: r.points })) });
  } catch (err) {
    console.error('Leaderboard error:', err);
    bad(res, 'Internal server error', 500);
  }
});

app.get('/api/referrals/:code', async (req, res) => {
  try {
    const cleanCode = clean(req.params.code, 20).toUpperCase();
    const ambResult = await db.query('SELECT name, points FROM ambassadors WHERE code = $1', [cleanCode]);
    if (ambResult.rows.length === 0) return bad(res, 'Code not found', 404);
    const r = ambResult.rows[0];

    const teamsResult = await db.query('SELECT COUNT(*) AS n FROM registrations WHERE referral_code = $1', [cleanCode]);
    const teams = parseInt(teamsResult.rows[0].n, 10);

    res.json({ ok: true, name: r.name.split(' ')[0], points: r.points, teams });
  } catch (err) {
    console.error('Referral lookup error:', err);
    bad(res, 'Internal server error', 500);
  }
});

app.post('/api/contact', limit(5), async (req, res) => {
  try {
    const b = req.body || {};
    const kind = b.kind === 'sponsor' ? 'sponsor' : 'general';
    const d = { first: clean(b.firstName, 60), last: clean(b.lastName, 60), email: clean(b.email, 120).toLowerCase(), phone: clean(b.phone, 20), company: clean(b.company, 100), tier: clean(b.tier, 30), msg: clean(b.message, 3000) };
    if (!d.first) return bad(res, 'Please tell us your name.');
    if (!EMAIL.test(d.email)) return bad(res, 'Please enter a valid email address.');
    if (d.phone && !PHONE.test(d.phone)) return bad(res, 'Please enter a valid phone number.');
    if (kind === 'sponsor' && !d.company) return bad(res, 'Please tell us your company name.');
    if (d.msg.length < 5) return bad(res, 'Please write a short message.');

    await db.query(
      'INSERT INTO enquiries (kind, first_name, last_name, email, phone, company, tier, message) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [kind, d.first, d.last, d.email, d.phone, d.company, d.tier, d.msg]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact error:', err);
    bad(res, 'Internal server error', 500);
  }
});

/* ------------------------------------------------------------------ */
/* Admin API (cookie session)                                         */
/* ------------------------------------------------------------------ */
const sessions = new Set();
const cookieToken = (req) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === 'ha_admin')?.[1];
const requireAdmin = (req, res, next) => (sessions.has(cookieToken(req)) ? next() : bad(res, 'Unauthorised', 401));

app.post('/api/admin/login', limit(8), (req, res) => {
  const pw = String(req.body?.password || '');
  const a = Buffer.from(pw), b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return bad(res, 'Wrong password', 401);
  const t = crypto.randomBytes(24).toString('hex');
  sessions.add(t);
  res.setHeader('Set-Cookie', `ha_admin=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 12}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { sessions.delete(cookieToken(req)); res.setHeader('Set-Cookie', 'ha_admin=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

const TABLES = {
  registrations: { sql: 'SELECT * FROM registrations ORDER BY id DESC', statuses: ['pending', 'shortlisted', 'rejected'] },
  ambassadors: { sql: 'SELECT * FROM ambassadors ORDER BY points DESC, id DESC', statuses: null },
  enquiries: { sql: 'SELECT * FROM enquiries ORDER BY id DESC', statuses: ['new', 'replied', 'closed'] },
};

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const teamsRes = await db.query('SELECT COUNT(*) n FROM registrations');
    const regAll = await db.query('SELECT members FROM registrations');
    const hackersCount = regAll.rows.reduce((s, r) => s + JSON.parse(r.members).length + 1, 0);
    const ambRes = await db.query('SELECT COUNT(*) n FROM ambassadors');
    const enqRes = await db.query("SELECT COUNT(*) n FROM enquiries WHERE status = 'new'");

    res.json({ ok: true, stats: {
      teams: parseInt(teamsRes.rows[0].n, 10),
      hackers: hackersCount,
      ambassadors: parseInt(ambRes.rows[0].n, 10),
      enquiries: parseInt(enqRes.rows[0].n, 10),
    } });
  } catch (err) {
    console.error('Admin stats error:', err);
    bad(res, 'Internal server error', 500);
  }
});

app.get('/api/admin/:table', requireAdmin, async (req, res) => {
  try {
    const t = TABLES[req.params.table];
    if (!t) return bad(res, 'Unknown table', 404);
    const result = await db.query(t.sql);
    res.json({ ok: true, rows: result.rows, statuses: t.statuses });
  } catch (err) {
    console.error('Admin table fetch error:', err);
    bad(res, 'Internal server error', 500);
  }
});

app.patch('/api/admin/:table/:id', requireAdmin, async (req, res) => {
  try {
    const tableKey = req.params.table;
    const t = TABLES[tableKey];
    if (!t || !t.statuses) return bad(res, 'Not editable');
    const s = String(req.body?.status);
    if (!t.statuses.includes(s)) return bad(res, 'Invalid status');
    
    await db.query(`UPDATE ${tableKey} SET status = $1 WHERE id = $2`, [s, Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin patch error:', err);
    bad(res, 'Internal server error', 500);
  }
});

app.get('/api/admin/:table/export.csv', requireAdmin, async (req, res) => {
  try {
    const tableKey = req.params.table;
    const t = TABLES[tableKey];
    if (!t) return bad(res, 'Unknown table', 404);
    const result = await db.query(t.sql);
    const rows = result.rows;
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s; };
    res.type('text/csv').attachment(`${tableKey}.csv`).send([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
  } catch (err) {
    console.error('CSV export error:', err);
    bad(res, 'Internal server error', 500);
  }
});

/* 404 */
app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.use((req, res) => render(res, { view: '404', title: 'Not found | Hack Atrium', js: [] }, {}, 404));

app.listen(PORT, () => console.log(`🏛️ Hack Atrium running at http://localhost:${PORT}  (admin: /admin)`));