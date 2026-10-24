// Snap Lite: a phone app for one trade business at a time. One codebase (the chassis), one folder per client (skins/<id>/).
// SKIN=<id> picks the client. There are no public pages: everything is behind a sign-in.
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const sharp = require('sharp');
const SKIN = require('./lib/skin');
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
const events = (type, userId = null, jobId = null, detail = '') => pool.query('INSERT INTO events (type,user_id,job_id,detail) VALUES ($1,$2,$3,$4)', [type, userId, jobId, String(detail).slice(0, 80)]).catch(() => {});

app.get('/health', (req, res) => res.json({ ok: true, skin: SKIN.id }));

// ---------- the client's brand: logo, icons, manifest ----------
app.get('/assets/logo.png', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('png').sendFile(SKIN.logoFile));
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

// ---------- modules ----------
const acct = require('./accounts')({ app, pool, SKIN, ui, events });
const jobsMod = require('./jobs')({ app, pool, SKIN, ui, acct, events });
const renderMod = require('./render')({ app, pool, SKIN, acct, jobsMod, events });
const adminMod = require('./admin')({ app, pool, SKIN, acct, jobsMod });

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
process.on('unhandledRejection', e => console.error('Unhandled:', e && e.message));
app.use((err, req, res, next) => { console.error(err); res.status(500).send('Something went wrong. Please try again.'); });

initDb()
  .then(() => adminMod.init())
  .then(() => acct.init())
  .then(() => jobsMod.init())
  .then(() => renderMod.init())
  .then(() => app.listen(PORT, () => console.log(`${SKIN.name} (Snap Lite) on port ${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
