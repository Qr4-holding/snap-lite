// Snap Lite: a phone app for one trade business at a time. One codebase (the chassis), one folder per client (skins/<id>/).
// SKIN=<id> picks the client. There are no public pages: everything is behind a sign-in.
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const sharp = require('sharp');
const SKIN = require('./lib/skin');
const { esc } = require('./lib/util');
const ui = require('./lib/ui')(SKIN);

const PORT = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()', 'X-Robots-Tag': 'noindex, nofollow'
  });
  next();
});

// An old address keeps working by sending people to the new one (set PRIMARY_HOST and LEGACY_HOSTS). Two things stay on the old host:
// the Android verification file (it must not redirect) and /health.
const PRIMARY = (process.env.PRIMARY_HOST || '').trim().toLowerCase();
const LEGACY = new Set((process.env.LEGACY_HOSTS || '').toLowerCase().split(/[\s,]+/).filter(Boolean));
app.use((req, res, next) => {
  if (!PRIMARY || !LEGACY.has(String(req.hostname || '').toLowerCase()) || req.path === '/.well-known/assetlinks.json' || req.path === '/health') return next();
  res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 302 : 307, `https://${PRIMARY}${req.originalUrl}`);
});

// ---------- small shared bits ----------
async function initDb(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS events (id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(), type TEXT NOT NULL, user_id INT, job_id INT, detail TEXT)`);
      await pool.query("DELETE FROM events WHERE ts < now() - interval '13 months'");
      console.log('Database ready'); return;
    } catch (e) { console.log('Waiting for database…', e.message); await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('Database not reachable');
}
const events = (type, userId = null, jobId = null, detail = '') => pool.query('INSERT INTO events (type,user_id,job_id,detail) VALUES ($1,$2,$3,$4)', [type, userId, jobId, String(detail).slice(0, 300)]).catch(() => {});

// Nightly: re-check the stored waste carrier registration against the Environment Agency register (after 03:00 UK time, once a day; retried hourly if the register can't be reached).
function startNightlyRegCheck() {
  const regMod = require('./lib/reg')(pool, SKIN), today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const hour = () => +new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/London' });
  const tick = async () => {
    try {
      if (hour() < 3) return;
      const ran = (await pool.query("SELECT value FROM settings WHERE key='reg_recheck_run'")).rows[0];
      if (ran && ran.value === today()) return;
      const r = await regMod.recheck();
      if (r.status === 'none' || r.status === 'found' || r.status === 'notfound') await pool.query("INSERT INTO settings (key,value) VALUES ('reg_recheck_run',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [today()]);
      events('registration_recheck', null, null, r.status + (r.changed ? ' changed' : ''));
    } catch (e) { console.error('registration re-check failed:', e.message); }
  };
  setTimeout(tick, 60 * 1000).unref(); setInterval(tick, 60 * 60 * 1000).unref();
}
app.get('/health', (req, res) => res.json({ ok: true, skin: SKIN.id, crew_can_capture: SKIN.crew_can_capture, crew_enabled: SKIN.crew_enabled, commit: require('./lib/build').commit }));

// ---------- the client's brand: logo, icons, manifest ----------
app.get('/assets/logo.png', (req, res) => res.set('Cache-Control', 'public, max-age=60').type('png').sendFile(acct.logo.current()));
const iconCache = new Map();
async function icon(size, maskable) {
  const key = size + (maskable ? 'm' : '');
  if (iconCache.has(key)) return iconCache.get(key);
  let buf;
  if (fs.existsSync(SKIN.iconFile) && !maskable) buf = await sharp(SKIN.iconFile).resize(size, size).png().toBuffer();
  else {
    const inner = Math.round(size * (maskable ? 0.56 : 0.78));
    const logo = await sharp(SKIN.logoFile).resize({ width: inner, height: inner, fit: 'inside' }).toBuffer();
    buf = await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } }).composite([{ input: logo, gravity: 'center' }]).png().toBuffer();
  }
  iconCache.set(key, buf); return buf;
}
const sendIcon = (size, maskable) => async (req, res, next) => { try { res.set('Cache-Control', 'public, max-age=3600').type('png').send(await icon(size, maskable)); } catch (e) { next(e); } };
app.get('/assets/icon-192.png', sendIcon(192));
app.get('/assets/icon-512.png', sendIcon(512));
app.get('/assets/icon-maskable-512.png', sendIcon(512, true));
app.get('/assets/apple-touch-icon.png', sendIcon(180));
app.get('/manifest.json', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('application/manifest+json').send(JSON.stringify({
  id: '/', name: SKIN.app_name || SKIN.name, short_name: SKIN.short_name || SKIN.name, start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait',
  background_color: '#FFFFFF', theme_color: SKIN.accent,
  icons: [{ src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }]
})));
// Service worker: lets Chrome treat the site as an installable app. It never caches pages or photos (signed-in data must stay fresh).
app.get('/sw.js', (req, res) => res.type('application/javascript').set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).send(
  'self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));self.addEventListener("fetch",e=>{e.respondWith(fetch(e.request));});'));
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

// ---------- install page (the only public page: no job data on it) ----------
const APK = path.join(__dirname, 'apk', `${SKIN.id}-snap.apk`);
app.get('/get/app.apk', (req, res) => fs.existsSync(APK)
  ? res.set({ 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': `attachment; filename="${SKIN.id}-snap.apk"`, 'Cache-Control': 'no-cache' }).sendFile(APK)
  : res.status(404).type('text/plain').send('Not found'));
app.get('/.well-known/assetlinks.json', (req, res) => {
  // only this skin's own app is listed (one assetlinks file holds the entries for every skin's app)
  try {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'apk', 'assetlinks.json'), 'utf8')).filter(e => e.target && e.target.package_name === SKIN.app_id);
    return all.length ? res.set('Cache-Control', 'no-cache').type('application/json').send(JSON.stringify(all)) : res.status(404).end();
  } catch (e) { res.status(404).end(); }
});
const QRCode = require('qrcode');
const qrCache = new Map();
async function qrSvg(url) { if (!qrCache.has(url)) qrCache.set(url, await QRCode.toString(url, { type: 'svg', margin: 1, width: 260, errorCorrectionLevel: 'M', color: { dark: SKIN.ink || '#1F2124', light: '#ffffff' } })); return qrCache.get(url); }
app.get('/get/qr.svg', async (req, res, next) => { try { res.set('Cache-Control', 'no-cache').type('image/svg+xml').send(await qrSvg(`https://${req.get('host')}/get`)); } catch (e) { next(e); } });
app.get('/get', async (req, res, next) => { try {
  const qr = await qrSvg(`https://${req.get('host')}/get`);
  const ua = String(req.get('user-agent') || '');
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua));
  const inApp = /FBAN|FBAV|Instagram|WhatsApp|Line\/|MicroMessenger|Snapchat|GSA\//.test(ua) || (ios && !/Safari\//.test(ua));
  const have = fs.existsSync(APK), mb = have ? (fs.statSync(APK).size / 1048576).toFixed(1) : '';
  const host = esc(req.get('host'));
  const iosSteps = `<h2>Put the app on your iPhone</h2>
${inApp ? `<p class="msg bad" role="alert"><b>You are not in Safari.</b> Tap the Share or ⋯ button and choose <b>Open in Safari</b> (or copy <b>${host}</b> into Safari). The next steps only work in Safari.</p>` : ''}
<ol style="padding-left:22px;display:grid;gap:12px">
<li><b>Open ${host} in Safari</b> (the blue compass icon), not from inside WhatsApp or Facebook.</li>
<li>Tap the <b>Share</b> button: the square with an arrow pointing up, at the bottom of the screen.</li>
<li>Scroll down and tap <b>Add to Home Screen</b>.</li>
<li>Tap <b>Add</b> in the top right.</li>
<li>Open the new icon on your Home Screen and sign in with the email and password you were given.</li></ol>
<p class="small">Always open the app from that icon, and sign in there. It is a separate place from Safari, so you sign in once inside it.</p>`;
  const androidSteps = `${have ? `<h2 style="text-align:center">Or install it on this phone</h2><a class="btn" href="/get/app.apk" style="margin:8px 0 6px">Download the app (${mb} MB)</a><p class="small">For Android phones. Version ${esc((() => { try { return fs.readFileSync(path.join(__dirname, 'apk', 'version.txt'), 'utf8').trim(); } catch (e) { return ''; } })())}.</p>
<h2>Then, on your phone</h2>
<ol style="padding-left:22px;display:grid;gap:10px">
<li><b>Tap the download.</b> If Chrome says the file may be harmful, tap <b>Download anyway</b>. It is our own app.</li>
<li>When it finishes, tap <b>Open</b>.</li>
<li>Android asks to allow installs from Chrome: tap <b>Settings</b>, switch <b>Allow from this source</b> on, then press Back.</li>
<li>Tap <b>Install</b>, then <b>Open</b>. Sign in with the email and password you were given.</li></ol>
<p class="small">If a Play Protect box appears, tap <b>More details</b> then <b>Install anyway</b>.</p>` : '<p class="msg">The app file is not ready yet.</p>'}
<h2>No download?</h2><p>Open <b>${host}</b> in Chrome and use the menu <b>⋮</b> → <b>Add to Home screen</b>.</p>`;
  res.set({ 'Cache-Control': 'no-cache', 'Vary': 'User-Agent' }).send(ui.page('Install the app', `
<h1 style="text-align:center;margin-bottom:4px">Get the ${esc(SKIN.app_name || SKIN.name)} app</h1>
${ios ? '' : `<p style="text-align:center;margin:0 0 12px;font-weight:700">Point your phone's camera at the code</p>
<div style="width:min(300px,80vw);margin:0 auto 16px;padding:14px;border:4px solid var(--a);border-radius:20px;background:#fff;line-height:0">${qr.replace('<svg ', '<svg style="width:100%;height:auto" role="img" aria-label="QR code to install the app" ')}</div>`}
${ios ? iosSteps : androidSteps}`, {}));
} catch (e) { next(e); } });

// ---------- modules ----------
const secrets = require('./lib/secrets')(pool);
let mailMod;
const acct = require('./accounts')({ app, pool, SKIN, ui, events, getMail: () => mailMod });
mailMod = require('./mail')(secrets, SKIN, acct.TEST_DOMAIN);
let shareMod;
const helpMod = require('./help')({ app, SKIN, ui, acct });
const diagMod = require('./diag')({ app, pool, SKIN, ui, acct });
let recordMod;
const jobsMod = require('./jobs')({ app, pool, SKIN, ui, acct, events, diag: diagMod, getShare: () => shareMod, getRecord: () => recordMod });
shareMod = require('./share')({ app, pool, SKIN, ui, acct, jobsMod, events });
const linesMod = require('./lines')(SKIN, secrets);
let voiceMod, renderMod;
renderMod = require('./render')({ app, pool, SKIN, acct, jobsMod, events, getVoice: () => voiceMod, getRecord: () => recordMod });
recordMod = require('./record')({ app, pool, SKIN, ui, acct, jobsMod, events, secrets });
voiceMod = require('./voice')({ app, pool, SKIN, ui, acct, jobsMod, getRender: () => renderMod, events, secrets, linesMod });
require('./outputs')({ app, pool, SKIN, ui, acct, jobsMod, events });
const adminMod = require('./admin')({ app, pool, SKIN, acct, jobsMod, secrets, mailMod, diagMod });

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
process.on('unhandledRejection', e => console.error('Unhandled:', e && e.message));
app.use((err, req, res, next) => { console.error(err); res.status(500).send('Something went wrong. Please try again.'); });

initDb()
  .then(() => adminMod.init())
  .then(() => acct.init())
  .then(() => diagMod.init())
  .then(() => jobsMod.init())
  .then(() => shareMod.init())
  .then(() => renderMod.init())
  .then(() => { startNightlyRegCheck(); })
  .then(() => app.listen(PORT, () => console.log(`${SKIN.name} (Snap Lite) on port ${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
