// /admin: Robert only (basic auth). Creates the business owner, lists jobs, shows render errors, backups, password.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { clean, esc, hashPw, sameOrigin } = require('./lib/util');

const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';

module.exports = function admin({ app, pool, SKIN, acct, jobsMod, secrets, mailMod, diagMod }) {
  const form = express.urlencoded({ extended: false, limit: '10kb' });
  let ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
  let adminHash = null;
  const fails = new Map();
  const checkPw = pw => {
    if (adminHash) {
      const [salt, h] = adminHash.split(':');
      const a = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex')), b = Buffer.from(h);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    if (!ADMIN_PASSWORD) return false;
    const a = Buffer.from(pw), b = Buffer.from(ADMIN_PASSWORD);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  function auth(req, res, next) {
    const [type, value] = (req.headers.authorization || '').split(' ');
    if (type === 'Basic' && value) {
      const f = (fails.get(req.ip) || []).filter(t => Date.now() - t < 15 * 60e3);
      if (f.length >= 10) return res.status(429).send('Too many tries. Wait 15 minutes.');
      const [u, ...p] = Buffer.from(value, 'base64').toString().split(':');
      if (u === ADMIN_USER && checkPw(p.join(':'))) return next();
      f.push(Date.now()); fails.set(req.ip, f);
    }
    res.set('WWW-Authenticate', `Basic realm="${SKIN.name} admin"`).status(401).send('Sign in required');
  }

  async function init() {
    await pool.query('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const h = (await pool.query("SELECT value FROM settings WHERE key='admin_hash'")).rows[0]; if (h) adminHash = h.value;
    const u = (await pool.query("SELECT value FROM settings WHERE key='admin_user'")).rows[0]; if (u) ADMIN_USER = u.value;
  }
  const listBackups = () => { try { return fs.readdirSync(BACKUP_DIR).filter(f => /^[a-z]+-[\d-]+\.sql\.gz$/.test(f)).sort().reverse(); } catch (e) { return []; } };
  const shell = (title, body) => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ${esc(SKIN.name)} admin</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;max-width:900px;color:${esc(SKIN.ink)}}nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}nav a.back{background:#fff;border-color:${esc(SKIN.accent)};color:${esc(SKIN.accent)}}nav a{padding:8px 14px;border-radius:18px;border:1px solid #ccc;text-decoration:none;color:inherit;font-weight:600}
form.card{border:1px solid #ddd;border-radius:14px;padding:14px;display:grid;gap:10px;max-width:520px;margin:10px 0}label{display:grid;gap:4px;font-weight:600}input,select{font:inherit;padding:10px;border:1px solid #bbb;border-radius:10px}
button{background:${esc(SKIN.accent)};color:#fff;border:0;border-radius:20px;padding:10px 18px;font:inherit;font-weight:700;cursor:pointer}button.del{background:#fff;color:#a1260f;border:1px solid #f0b8ae}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #eee;padding:6px;text-align:left}.ok{background:#eef8ef;border:1px solid ${esc(SKIN.accent)};padding:10px 14px;border-radius:12px}.bad{background:#fdece8;border:1px solid #a1260f;padding:10px 14px;border-radius:12px}</style></head><body>
<nav><a href="/" class="back">← Back to the app</a><a href="/admin">Overview</a><a href="/admin/jobs">All jobs</a></nav>${body}<nav style="margin-top:24px"><a href="/" class="back">← Back to the app</a></nav></body></html>`;

  app.get('/admin', auth, async (req, res, next) => { try {
    const keyState = { el: await secrets.has('elevenlabs_key'), an: await secrets.has('anthropic_key'), mail: await mailMod.configured() };
    const b = (await pool.query('SELECT * FROM businesses WHERE slug=$1', [SKIN.id])).rows[0];
    const users = b ? (await pool.query('SELECT id,email,role,created_at,deleted_at FROM users WHERE biz_id=$1 ORDER BY id', [b.id])).rows : [];
    const counts = (await pool.query('SELECT state, count(*)::int n FROM jobs WHERE deleted_at IS NULL GROUP BY state ORDER BY state')).rows;
    const flash = { owner: ['Owner created.', 0], bad: [req.query.why || 'Not saved.', 1], pw: ['Sign-in details saved. Use them next time.', 0], pwbad: ['Not saved: wrong current password, or the new passwords do not match or are under 12 characters.', 1], purged: ['Test data removed.', 0], keys: ['Keys saved.', 0] }[req.query.m];
    res.set('Cache-Control', 'no-store').send(shell('Overview', `<h1>${esc(SKIN.name)} admin</h1>
${flash ? `<p class="${flash[1] ? 'bad' : 'ok'}">${esc(flash[0])}</p>` : ''}
<h2>Business</h2><p>${b ? `${esc(b.name)} (${esc(b.slug)})` : 'Not created yet: it is created with the first owner.'} · version ${esc(process.env.APP_VERSION || 'dev')}</p>
<h2>People</h2><table><tr><th>Email</th><th>Role</th><th>Created</th><th></th></tr>${users.map(u => `<tr><td>${esc(u.email)}</td><td>${u.role}</td><td>${new Date(u.created_at).toLocaleDateString('en-GB')}</td><td>${u.deleted_at ? 'deleted' : ''}</td></tr>`).join('') || '<tr><td colspan="4">No one yet.</td></tr>'}</table>
<h2>Create an owner</h2><form class="card" method="post" action="/admin/owner"><label>Name<input name="name" maxlength="80"></label><label>Email<input name="email" type="email" required></label><label>Password (8 or more)<input name="password" type="password" required minlength="8" autocomplete="new-password"></label><button type="submit">Create owner</button></form>
<h2>Jobs by state</h2><p>${counts.map(c => `${esc(c.state)}: ${c.n}`).join(' · ') || 'No jobs yet.'}</p>
<h2>Backups</h2><ul>${listBackups().map(f => `<li><a href="/admin/backup/${esc(f)}">${esc(f)}</a></li>`).join('') || '<li>The first backup appears after tonight.</li>'}</ul>
<h2>Sign-in details</h2><form class="card" method="post" action="/admin/password"><label>Username<input name="user" value="${esc(ADMIN_USER)}" required minlength="3"></label><label>Current password<input name="current" type="password" required autocomplete="current-password"></label><label>New password (12 or more, blank keeps current)<input name="next" type="password" minlength="12" autocomplete="new-password"></label><label>New password again<input name="again" type="password" minlength="12" autocomplete="new-password"></label><button type="submit">Save</button></form>
<h2>Voice and writing keys</h2><p class="small">ElevenLabs: ${keyState.el ? 'set' : 'not set'} · Anthropic: ${keyState.an ? 'set' : 'not set'}. Pasted keys are stored on the server and never shown again; leave a box blank to keep the current key.</p><form class="card" method="post" action="/admin/keys"><label>ElevenLabs API key<input name="elevenlabs_key" type="password" autocomplete="off"></label><label>Anthropic API key<input name="anthropic_key" type="password" autocomplete="off"></label><h2>Password reset email (Brevo SMTP)</h2><p class="small">Email sending: ${keyState.mail ? 'ready' : 'not set'}. Needs the Brevo SMTP login, the SMTP key, and a sender address verified in Brevo.</p><label>Brevo SMTP login<input name="brevo_login" autocomplete="off"></label><label>Brevo SMTP key<input name="brevo_key" type="password" autocomplete="off"></label><label>Send from (verified address)<input name="mail_from" type="email" autocomplete="off"></label><div style="display:flex;gap:10px;flex-wrap:wrap"><button type="submit">Save keys</button><button type="submit" name="back" value="1">Save keys and go back</button></div></form>
<h2>Test data</h2><form method="post" action="/admin/purge-test" onsubmit="return confirm('Remove test accounts and their jobs?')"><button class="del" type="submit">Remove test accounts (@snaplite-test.invalid)</button></form>`));
  } catch (e) { next(e); } });

  app.post('/admin/owner', auth, sameOrigin, form, async (req, res, next) => { try {
    try { const u = await acct.createUser({ email: req.body.email, password: req.body.password, name: req.body.name, role: 'owner' });
      if (req.body.must_change) await pool.query('UPDATE users SET must_change=true WHERE id=$1', [u.id]); }   // one-time password: they choose their own at first sign-in
    catch (e) { return res.redirect(303, '/admin?m=bad&why=' + encodeURIComponent(e.message)); }
    res.redirect(303, '/admin?m=owner');
  } catch (e) { next(e); } });

  app.post('/admin/owner-password', auth, sameOrigin, form, async (req, res, next) => { try {
    const email = clean(req.body.email, 120).toLowerCase(), pw = String(req.body.password || '');
    if (pw.length < 8) return res.status(400).json({ error: 'Password needs 8 or more characters.' });
    const r = await pool.query("UPDATE users SET password_hash=$1, must_change=($3::boolean) WHERE email=$2 AND role='owner' AND deleted_at IS NULL", [hashPw(pw), email, !!req.body.must_change]);
    if (!r.rowCount) return res.status(404).json({ error: 'No such owner.' });
    await pool.query('DELETE FROM biz_sessions WHERE user_id IN (SELECT id FROM users WHERE email=$1)', [email]);
    res.json({ ok: true });
  } catch (e) { next(e); } });

  // what phones reported: /admin/diag (latest) or /admin/diag?code=ABCD
  app.get('/admin/diag', auth, async (req, res, next) => { try {
    res.set('Cache-Control', 'no-store').json(await diagMod.recent(req.query.code));
  } catch (e) { next(e); } });

  // test helpers: only ever about @snaplite-test.invalid addresses
  app.get('/admin/outbox', auth, (req, res) => {
    const to = String(req.query.to || '');
    if (!to.endsWith(acct.TEST_DOMAIN)) return res.status(400).json({ error: 'Test addresses only.' });
    res.set('Cache-Control', 'no-store').json(mailMod.outbox.filter(m => m.to === to));
  });
  app.post('/admin/expire-resets', auth, sameOrigin, form, async (req, res, next) => { try {
    const to = clean(req.body.email, 120).toLowerCase();
    if (!to.endsWith(acct.TEST_DOMAIN)) return res.status(400).json({ error: 'Test addresses only.' });
    const r = await pool.query("UPDATE password_resets SET expires=now() - interval '1 minute' WHERE used_at IS NULL AND user_id IN (SELECT id FROM users WHERE email=$1)", [to]);
    res.json({ ok: true, expired: r.rowCount });
  } catch (e) { next(e); } });

  // sends one real message and reports exactly what the mail server said (no secrets in the answer)
  app.post('/admin/test-mail', auth, sameOrigin, form, async (req, res) => {
    const to = clean(req.body.to, 120).toLowerCase();
    try { res.json(await mailMod.send({ to, subject: `${SKIN.name}: email test`, text: 'This is a test message from your app. If you can read it, sending works.' })); }
    catch (e) { res.status(502).json({ ok: false, error: String(e.message).slice(0, 300), code: e.code, responseCode: e.responseCode }); }
  });

  app.post('/admin/keys', auth, sameOrigin, form, async (req, res, next) => { try {
    const wrong = (req.body.elevenlabs_key || '').trim() && !/^sk_/.test(String(req.body.elevenlabs_key).trim()) ? "That is not the ElevenLabs key itself (real keys start with sk_). It may be the key's ID. Nothing was saved: copy the key when it is created, or create a new one."
      : (req.body.anthropic_key || '').trim() && !/^sk-ant-/.test(String(req.body.anthropic_key).trim()) ? 'That does not look like an Anthropic key (they start with sk-ant-). Nothing was saved.' : '';
    if (wrong) return res.redirect(303, '/admin?m=bad&why=' + encodeURIComponent(wrong));
    for (const k of ['elevenlabs_key', 'anthropic_key', 'brevo_login', 'brevo_key', 'mail_from']) { const v = String(req.body[k] || '').trim(); if (v && /^[\x21-\x7e]{10,200}$/.test(v)) await secrets.set(k, v); }
    res.redirect(303, req.body.back ? '/settings?m=keys' : '/admin?m=keys');
  } catch (e) { next(e); } });
  // recent events, newest first (optionally one type)
  app.get('/admin/events', auth, async (req, res, next) => { try {
    const t = String(req.query.type || '');
    const r = await pool.query(`SELECT ts,type,job_id,detail FROM events ${t ? 'WHERE type=$1' : ''} ORDER BY id DESC LIMIT 40`, t ? [t] : []);
    res.set('Cache-Control', 'no-store').json(r.rows);
  } catch (e) { next(e); } });
  // asks ElevenLabs exactly what it says about each voice with the stored key (never shows the key)
  app.get('/admin/voice-check', auth, async (req, res, next) => { try {
    const key = await secrets.get('elevenlabs_key'); if (!key) return res.json({ key: 'not set' });
    const out = { key: 'set', length: key.length, voices: [] };
    const say = async r => { let b = ''; try { b = await r.text(); } catch (e) {} let d = b; try { const j = JSON.parse(b); d = j.detail || j; } catch (e) {} return { status: r.status, detail: typeof d === 'string' ? d.slice(0, 300) : d }; };
    try { out.user = await say(await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key } })); } catch (e) { out.user = String(e.message); }
    for (const v of SKIN.voices || []) {
      const o = { id: v.id, label: v.label };
      try { o.lookup = await say(await fetch('https://api.elevenlabs.io/v1/voices/' + encodeURIComponent(v.id), { headers: { 'xi-api-key': key } })); if (o.lookup.status === 200) o.lookup = { status: 200 }; } catch (e) { o.lookup = String(e.message); }
      try { const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v.id)}?output_format=mp3_22050_32`, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello.', model_id: process.env.ELEVEN_MODEL || 'eleven_v4' }) }); o.speech = r.status === 200 ? { status: 200 } : await say(r); } catch (e) { o.speech = String(e.message); }
      out.voices.push(o);
    }
    res.set('Cache-Control', 'no-store').json(out);
  } catch (e) { next(e); } });
  app.get('/admin/usage', auth, async (req, res, next) => { try {
    const q = async t => +(await pool.query('SELECT count(*)::int n FROM events WHERE type=$1', [t])).rows[0].n;
    res.set('Cache-Control', 'no-store').json({ voice_generations: await q('tts_generated'), lines_drafted: await q('lines_drafted'), keys: { elevenlabs: await secrets.has('elevenlabs_key'), anthropic: await secrets.has('anthropic_key') } });
  } catch (e) { next(e); } });
  app.get('/admin/jobs', auth, async (req, res, next) => { try {
    const rows = (await pool.query(`SELECT j.*, u.email, (SELECT count(*)::int FROM job_photos p WHERE p.job_id=j.id) photos FROM jobs j LEFT JOIN users u ON u.id=j.user_id ORDER BY j.created_at DESC LIMIT 300`)).rows;
    res.set('Cache-Control', 'no-store').send(shell('Jobs', `<h1>All jobs</h1><table><tr><th>#</th><th>Type</th><th>By</th><th>State</th><th>Photos</th><th>Error</th></tr>${rows.map(r => `<tr><td>${r.id}</td><td>${esc(r.job_type)}</td><td>${esc(r.email || '')}</td><td>${esc(r.state)}</td><td>${r.photos}</td><td>${esc(r.render_error || '')}</td></tr>`).join('') || '<tr><td colspan="6">No jobs.</td></tr>'}</table>`));
  } catch (e) { next(e); } });

  // Test hook, demo skin only: writes registration details exactly as given, without asking the register, so dates and tiers can be tested.
  app.post('/admin/test-registration', auth, sameOrigin, form, async (req, res, next) => { try {
    if (SKIN.id !== 'demo') return res.status(403).send('Test hook is for the demo only.');
    const b = req.body || {}, put = (k, v) => pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, String(v || '')]);
    for (const [k, f] of [['reg_name', 'name'], ['reg_number', 'number'], ['reg_expiry', 'expiry'], ['reg_tier', 'tier'], ['reg_checked', 'checked']]) await put(k, b[f]);
    res.json({ ok: true });
  } catch (e) { next(e); } });
  // run the nightly registration re-check now (also used by the tests)
  app.post('/admin/recheck-registration', auth, sameOrigin, form, async (req, res, next) => { try {
    res.json(await require('./lib/reg')(pool, SKIN).recheck());
  } catch (e) { next(e); } });
  app.post('/admin/purge-test', auth, sameOrigin, form, async (req, res, next) => { try {
    const ids = (await pool.query('SELECT id FROM users WHERE email LIKE $1', ['%' + acct.TEST_DOMAIN])).rows.map(r => r.id);
    if (ids.length) {
      const js = (await pool.query('SELECT id FROM jobs WHERE user_id = ANY($1)', [ids])).rows.map(r => r.id);
      for (const id of js) { await pool.query('DELETE FROM jobs WHERE id=$1', [id]); fs.rm(jobsMod.dirOf(id), { recursive: true, force: true }, () => {}); }
      await pool.query('DELETE FROM biz_sessions WHERE user_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM acceptances WHERE user_id = ANY($1)', [ids]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    }
    res.redirect(303, '/admin?m=purged');
  } catch (e) { next(e); } });

  app.post('/admin/password', auth, sameOrigin, form, async (req, res, next) => { try {
    const { current = '', next: nx = '', again = '' } = req.body, user = clean(req.body.user, 40);
    if (!checkPw(current) || !/^[A-Za-z0-9._@-]{3,40}$/.test(user) || (nx && (nx.length < 12 || nx !== again))) return res.redirect(303, '/admin?m=pwbad');
    if (nx) { adminHash = hashPw(nx); await pool.query(`INSERT INTO settings (key,value) VALUES ('admin_hash',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [adminHash]); }
    ADMIN_USER = user; await pool.query(`INSERT INTO settings (key,value) VALUES ('admin_user',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [user]);
    res.redirect(303, '/admin?m=pw');
  } catch (e) { next(e); } });

  app.get('/admin/backup/:file', auth, (req, res) => {
    if (!listBackups().includes(req.params.file)) return res.status(404).send('Not found');
    res.download(path.join(BACKUP_DIR, req.params.file));
  });

  return { init, auth };
};
