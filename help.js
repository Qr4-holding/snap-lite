// Help page: a short list of how-to videos played inside the app.
// Drop-in: put <id>.mp4 (portrait) in help/ (or skins/<skin>/help/ to override for one client) and, optionally, <id>.jpg as the poster.
// Titles and which videos are public (readable signed out) live in help.json next to the files. A missing file shows "coming soon".
// With no poster file the first second of the video is used.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { esc } = require('./lib/util');

module.exports = function help({ app, SKIN, ui, acct }) {
  const { page } = ui;
  const DIRS = [path.join(SKIN.dir, 'help'), path.join(__dirname, 'help')];
  const POSTERS = path.join(process.env.MEDIA_DIR || path.join(__dirname, 'media'), 'help-posters');
  const find = name => { for (const d of DIRS) { const f = path.join(d, name); if (fs.existsSync(f)) return f; } return null; };
  function list() {
    const f = find('help.json'); let items = [];
    try { items = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
    return items.filter(i => /^[a-z0-9-]{1,40}$/.test(i.id || '')).map(i => ({ id: i.id, title: String(i.title || i.id).slice(0, 90), public: !!i.public, file: find(i.id + '.mp4') }));
  }
  const user = async req => { try { return await acct.current(req); } catch (e) { return null; } };

  app.get('/help', async (req, res, next) => { try {
    const u = await user(req), all = list(), shown = all.filter(i => u || i.public);
    const aspect = 'aspect-ratio:9/16;width:100%;max-width:320px;margin:0 auto;display:block;border-radius:14px;background:#111';
    const card = i => `<div class="card" style="margin:0 0 18px"><h2 style="margin:0 0 10px;font-size:19px">${esc(i.title)}</h2>${i.file
      ? `<video controls playsinline preload="none" poster="/help/p/${i.id}.jpg" src="/help/v/${i.id}.mp4" style="${aspect};object-fit:contain"></video>`
      : `<div style="${aspect};display:flex;align-items:center;justify-content:center;text-align:center;color:#fff;font-weight:700;padding:20px;box-sizing:border-box">Video coming soon</div>`}</div>`;
    res.set('Cache-Control', 'no-store').send(page('Help', `<h1>How does this work?</h1>
<p class="small">Short videos. Tap one to play it.</p>${shown.map(card).join('') || '<p>No videos yet.</p>'}
${u ? '' : '<p class="small">Sign in to see the rest of the videos.</p><a class="btn sec" href="/login">Back to sign in</a>'}`, { user: u, nav: 'settings' }));
  } catch (e) { next(e); } });

  const one = async (req, res) => { const i = list().find(x => x.id === req.params.id); if (!i || !i.file) return null; if (!i.public && !(await user(req))) { res.status(401).end(); return false; } return i; };
  app.get('/help/v/:id.mp4', async (req, res, next) => { try {
    const i = await one(req, res); if (i === false) return; if (!i) return res.status(404).end();
    res.set({ 'Cache-Control': i.public ? 'public, max-age=300' : 'private, max-age=300', 'Content-Type': 'video/mp4' }).sendFile(i.file, { acceptRanges: true, headers: { 'Content-Type': 'video/mp4' } }, e => { if (e && !res.headersSent) res.status(404).end(); });
  } catch (e) { next(e); } });
  app.get('/help/p/:id.jpg', async (req, res, next) => { try {
    const i = await one(req, res); if (i === false) return; if (!i) return res.status(404).end();
    const own = find(i.id + '.jpg'); let f = own;
    if (!f) {
      fs.mkdirSync(POSTERS, { recursive: true });
      f = path.join(POSTERS, `${i.id}-${Math.round(fs.statSync(i.file).mtimeMs)}.jpg`);
      if (!fs.existsSync(f)) await new Promise(r => execFile('ffmpeg', ['-y', '-v', 'error', '-ss', '1', '-i', i.file, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', f], { timeout: 20000 }, () => r()));
      if (!fs.existsSync(f)) await new Promise(r => execFile('ffmpeg', ['-y', '-v', 'error', '-i', i.file, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', f], { timeout: 20000 }, () => r()));
    }
    if (!f || !fs.existsSync(f)) return res.status(404).end();
    res.set({ 'Cache-Control': i.public ? 'public, max-age=3600' : 'private, max-age=3600', 'Content-Type': 'image/jpeg' }).sendFile(f);
  } catch (e) { next(e); } });
  return { list };
};
