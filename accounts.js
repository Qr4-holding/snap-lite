// Accounts and roles: one business per deployment (slug = skin id), users are owner or crew.
// Robert creates the owner in /admin; the owner invites crew from Settings. No public sign-up.
const crypto = require('crypto');
const express = require('express');
const { clean, esc, slugify, EMAIL, hashPw, checkPw, cookies, sameOrigin, limited } = require('./lib/util');

module.exports = function accounts({ app, pool, SKIN, ui, events }) {
  const { page, msg } = ui;
  const form = express.urlencoded({ extended: false, limit: '10kb' });
  const SESSION_DAYS = 180;
  const TEST_DOMAIN = '@snaplite-test.invalid';

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS businesses (
      id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, biz_id INT NOT NULL REFERENCES businesses(id), email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','crew')), name TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS biz_sessions (
      token TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, biz_id INT NOT NULL, expires TIMESTAMPTZ NOT NULL)`);
    await pool.query('ALTER TABLE biz_sessions ADD COLUMN IF NOT EXISTS user_id INT');
    await pool.query('DELETE FROM biz_sessions WHERE expires < now()');
  }

  // ---------- sessions ----------
  async function current(req) {
    const t = cookies(req).sl;
    if (!t || !/^[a-f0-9]{48}$/.test(t)) return null;
    const r = (await pool.query(`SELECT u.id, u.biz_id, u.email, u.role, u.name, b.name AS biz_name, b.slug AS biz_slug
      FROM biz_sessions s JOIN users u ON u.id=s.user_id JOIN businesses b ON b.id=u.biz_id
      WHERE s.token=$1 AND s.expires > now() AND u.deleted_at IS NULL AND b.status='active'`, [t])).rows[0];
    if (r && r.role === 'crew' && !SKIN.crew_enabled) return null;
    return r || null;
  }
  async function signIn(req, res, user) {
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(`INSERT INTO biz_sessions (token,user_id,biz_id,expires) VALUES ($1,$2,$3,now() + interval '${SESSION_DAYS} days')`, [token, user.id, user.biz_id]);
    res.append('Set-Cookie', `sl=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
  }
  const signOut = (req, res) => {
    const t = cookies(req).sl;
    if (t) pool.query('DELETE FROM biz_sessions WHERE token=$1', [t]).catch(() => {});
    res.append('Set-Cookie', `sl=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
  };

  // route guards: enforced on the server, never only hidden in the screens
  const needUser = (opts = {}) => async (req, res, next) => {
    try {
      const u = await current(req);
      if (!u) return opts.json || req.path.startsWith('/api/') ? res.status(401).json({ error: 'Please sign in.' }) : res.redirect(302, '/login');
      req.user = u; next();
    } catch (e) { next(e); }
  };
  const needOwner = async (req, res, next) => {
    try {
      const u = req.user || await current(req);
      if (!u) return req.path.startsWith('/api/') ? res.status(401).json({ error: 'Please sign in.' }) : res.redirect(302, '/login');
      if (u.role !== 'owner') return req.path.startsWith('/api/') ? res.status(403).json({ error: 'Only the owner can do that.' }) : res.status(403).send(page('Owner only', `<h1>Owner only</h1><p>Only the owner can do that.</p><a class="btn" href="/">Back</a>`, { user: u }));
      req.user = u; next();
    } catch (e) { next(e); }
  };

  // ---------- helpers used by /admin ----------
  async function ensureBusiness() {
    let b = (await pool.query('SELECT * FROM businesses WHERE slug=$1', [SKIN.id])).rows[0];
    if (!b) b = (await pool.query('INSERT INTO businesses (slug,name) VALUES ($1,$2) RETURNING *', [SKIN.id, SKIN.name])).rows[0];
    return b;
  }
  async function createUser({ email, password, name, role }) {
    const b = await ensureBusiness();
    email = clean(email, 120).toLowerCase();
    if (!EMAIL.test(email)) throw new Error('That email address does not look right.');
    if (String(password || '').length < 8) throw new Error('The password needs 8 or more characters.');
    if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [email])).rows.length) throw new Error('There is already an account with that email.');
    return (await pool.query('INSERT INTO users (biz_id,email,password_hash,role,name) VALUES ($1,$2,$3,$4,$5) RETURNING id,email,role,name,biz_id',
      [b.id, email, hashPw(password), role, clean(name, 80)])).rows[0];
  }
  const tempPassword = () => crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) + crypto.randomInt(10, 99);
  async function softDelete(userId) {
    // test accounts keep the test domain so /admin can still purge them
    await pool.query(`UPDATE users SET deleted_at=now(), name='Deleted user', password_hash='',
      email='deleted-'||id||CASE WHEN email LIKE '%${TEST_DOMAIN}' THEN '${TEST_DOMAIN}' ELSE '@deleted.invalid' END WHERE id=$1`, [userId]);
    await pool.query('DELETE FROM biz_sessions WHERE user_id=$1', [userId]);
  }

  // ---------- sign in ----------
  const signInPage = (m = '', email = '') => page('Sign in', `
<h1>Sign in</h1>
${msg(m, true)}
<form class="card" method="post" action="/login">
<label class="f">Email<input name="email" type="email" required autocomplete="email" inputmode="email" value="${esc(email)}"></label>
<label class="f">Password<input name="password" type="password" required autocomplete="current-password"></label>
<button type="submit">Sign in</button>
</form>
<p class="small">No account yet? Accounts are set up for you. Ask ${esc(SKIN.name)} to add you.</p>`);

  app.get('/login', async (req, res, next) => { try {
    if (await current(req)) return res.redirect(302, '/');
    res.set('Cache-Control', 'no-store').send(signInPage(req.query.m === 'bye' ? 'Signed out.' : req.query.m === 'gone' ? 'Your account has been deleted.' : ''));
  } catch (e) { next(e); } });

  app.post('/login', sameOrigin, form, async (req, res, next) => { try {
    const b = req.body || {}, email = clean(b.email, 120).toLowerCase();
    if (limited('login:' + req.ip, 20)) return res.status(429).send(signInPage('Too many tries. Please wait an hour.', email));
    const u = (await pool.query(`SELECT u.*, bz.status AS bstatus FROM users u JOIN businesses bz ON bz.id=u.biz_id WHERE u.email=$1 AND u.deleted_at IS NULL`, [email])).rows[0];
    if (!u || u.bstatus !== 'active' || (u.role === 'crew' && !SKIN.crew_enabled) || !checkPw(String(b.password || ''), u.password_hash)) return res.status(401).send(signInPage('Wrong email or password.', email));
    await signIn(req, res, u);
    events('sign_in', u.id);
    res.redirect(303, '/');
  } catch (e) { next(e); } });

  app.post('/logout', sameOrigin, (req, res) => { signOut(req, res); res.redirect(303, '/login?m=bye'); });

  // ---------- settings ----------
  app.get('/settings', needUser(), async (req, res, next) => { try {
    const u = req.user;
    const crew = u.role === 'owner' ? (await pool.query(`SELECT id,email,name,created_at FROM users WHERE biz_id=$1 AND role='crew' AND deleted_at IS NULL ORDER BY id`, [u.biz_id])).rows : [];
    const q = req.query, flash = { invited: '', pw: 'Password changed.', removed: 'Crew member removed.', badpw: 'Not changed: the current password was wrong, or the new one is under 8 characters.', bad: 'Please check the details and try again.', dup: 'There is already an account with that email.' }[q.m] || '';
    const invited = q.m === 'invited' && /^[A-Za-z0-9]{6,20}$/.test(q.p || '') && EMAIL.test(q.e || '') ? `<p class="msg">Crew login created. Give ${esc(q.e)} this temporary password now, it is not shown again: <b style="font-size:22px">${esc(q.p)}</b></p>` : '';
    res.set('Cache-Control', 'no-store').send(page('Settings', `
<h1>Settings</h1>${msg(flash, /^(bad|dup|badpw)$/.test(q.m || ''))}${invited}
<p>Signed in as <b>${esc(u.email)}</b> (${u.role}).</p>
${u.role === 'owner' && SKIN.crew_enabled ? `<h2>Crew</h2>
${crew.length ? `<div class="jobs">${crew.map(c => `<div class="card"><b>${esc(c.email)}</b><form method="post" action="/settings/crew/${c.id}/remove" onsubmit="return confirm('Remove this person?')"><button class="bad small" type="submit">Remove</button></form></div>`).join('')}</div>` : '<p class="small">No crew logins yet.</p>'}
<form class="card" method="post" action="/settings/invite"><label class="f">Crew email<input name="email" type="email" required inputmode="email"></label><button type="submit">Create crew login</button><span class="small">Crew can take photos and make videos. Only you can approve and share.</span></form>` : ''}
<h2>Change password</h2>
<form class="card" method="post" action="/settings/password"><label class="f">Current password<input name="current" type="password" required autocomplete="current-password"></label><label class="f">New password (8 or more characters)<input name="next" type="password" required minlength="8" autocomplete="new-password"></label><button type="submit">Save password</button></form>
<h2>App</h2><p class="small">Version <span id="v">${esc(process.env.APP_VERSION || 'dev')}</span></p>
<form method="post" action="/logout"><button class="sec" type="submit">Sign out</button></form>
<h2>Delete my account</h2>
<form class="card" method="post" action="/settings/delete-account" onsubmit="return confirm('Delete your account? Your jobs stay with ${esc(SKIN.name)}.')"><p class="small" style="margin:0">This removes your login. The jobs you made stay on the business record.</p><label class="f">Your password<input name="password" type="password" required autocomplete="current-password"></label><button class="bad" type="submit">Delete my account</button></form>`, { user: u }));
  } catch (e) { next(e); } });

  app.post('/settings/invite', sameOrigin, needUser(), needOwner, form, async (req, res, next) => { try {
    if (!SKIN.crew_enabled) return res.status(403).send('Crew logins are not used on this app.');
    const pw = tempPassword();
    try { await createUser({ email: req.body.email, password: pw, name: '', role: 'crew' }); }
    catch (e) { return res.redirect(303, '/settings?m=' + (/already/.test(e.message) ? 'dup' : 'bad')); }
    events('crew_invited', req.user.id);
    res.redirect(303, `/settings?m=invited&e=${encodeURIComponent(clean(req.body.email, 120).toLowerCase())}&p=${pw}`);
  } catch (e) { next(e); } });

  app.post('/settings/crew/:id/remove', sameOrigin, needUser(), needOwner, async (req, res, next) => { try {
    if (!SKIN.crew_enabled) return res.status(403).send('Crew logins are not used on this app.');
    const id = parseInt(req.params.id, 10) || 0;
    const c = (await pool.query(`SELECT id FROM users WHERE id=$1 AND biz_id=$2 AND role='crew' AND deleted_at IS NULL`, [id, req.user.biz_id])).rows[0];
    if (c) await softDelete(c.id);
    res.redirect(303, '/settings?m=removed');
  } catch (e) { next(e); } });

  app.post('/settings/password', sameOrigin, needUser(), form, async (req, res, next) => { try {
    const row = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
    const nx = String(req.body.next || '');
    if (!row || !checkPw(String(req.body.current || ''), row.password_hash) || nx.length < 8) return res.redirect(303, '/settings?m=badpw');
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPw(nx), req.user.id]);
    res.redirect(303, '/settings?m=pw');
  } catch (e) { next(e); } });

  // Apple 5.1.1(v): account deletion from inside the app. Soft delete: the user's jobs stay with the business.
  app.post('/settings/delete-account', sameOrigin, needUser(), form, async (req, res, next) => { try {
    const row = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
    if (!row || !checkPw(String(req.body.password || ''), row.password_hash)) return res.redirect(303, '/settings?m=badpw');
    await softDelete(req.user.id);
    signOut(req, res);
    res.redirect(303, '/login?m=gone');
  } catch (e) { next(e); } });

  app.get('/api/version', (req, res) => res.set('Cache-Control', 'no-store').json({ version: process.env.APP_VERSION || 'dev', apk: process.env.ANDROID_APK_URL || '' }));

  return { init, current, needUser, needOwner, createUser, ensureBusiness, softDelete, TEST_DOMAIN };
};
