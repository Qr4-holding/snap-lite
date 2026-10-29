// Render queue: turns a job's photos into the branded video with video/engine.py. One render at a time (the server is small).
// Files live next to the photos: MEDIA_DIR/jobs/<id>/video.mp4 and cover.jpg. Only signed-in people of the same business can fetch them.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sameOrigin } = require('./lib/util');
const regFor = require('./lib/reg');

module.exports = function render({ app, pool, SKIN, acct, jobsMod, events, getVoice }) {
  const { needUser } = acct;
  const regMod = regFor(pool, SKIN);
  const queue = []; let busy = false;
  const ENGINE = path.join(__dirname, 'video', 'engine.py');

  const canRender = (u, j, change) => j && (u.role === 'owner' || j.user_id === u.id) && (change ? (u.role === 'owner' ? ['draft', 'failed', 'ready', 'approved', 'shared'] : ['draft', 'failed', 'ready']) : ['draft', 'failed', 'ready']).includes(j.state);

  async function buildConfig(j) {
    const dir = jobsMod.dirOf(j.id);
    const ph = (await pool.query('SELECT kind,seq FROM job_photos WHERE job_id=$1 ORDER BY CASE kind WHEN \'before\' THEN 0 WHEN \'during\' THEN 1 ELSE 2 END, seq', [j.id])).rows;
    if (!ph.some(p => p.kind === 'before') || !ph.some(p => p.kind === 'after')) { const e = new Error('Needs a BEFORE and an AFTER photo.'); e.tag = 'photos'; throw e; }
    const cfg = {
      out: path.join(dir, 'video.tmp.mp4'), cover: path.join(dir, 'cover.tmp.jpg'), work: path.join(dir, 'work'),
      orientation: j.orientation || 'auto',
      brand: { logo: acct.logo.current(), accent: SKIN.accent, strap: SKIN.tagline || '', web: SKIN.web || '', phone: SKIN.phone || '', email: SKIN.email || '' },
      end_card: SKIN.end_card || { headline: '', button: '', hold_seconds: 5 },
      photos: ph.slice(0, 5).map(p => ({ kind: p.kind, src: path.join(dir, `${p.kind}${p.seq}.jpg`) })),
      voice: null, lines: []
    };
    const rg = await regMod.get();                 // the registration mark: read at render time, so a remake picks up changes
    if (rg.active) cfg.reg = { text: rg.text, end_text: rg.endText };
    const v = await getVoice().ensure(j, dir);          // null = silent video; otherwise the saved or freshly made recording
    if (v) { cfg.voice = v.voice; cfg.lines = v.lines; }
    return cfg;
  }

  function runEngine(cfgFile) {
    return new Promise(resolve => {
      const p = spawn('python3', ['-I', ENGINE, cfgFile], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
      const timer = setTimeout(() => p.kill('SIGKILL'), 8 * 60 * 1000);
      p.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
      p.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    });
  }

  async function renderJob(id) {
    const j = (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
    if (!j || j.state !== 'rendering') return;
    const dir = jobsMod.dirOf(id), t0 = Date.now();
    try {
      const cfg = await buildConfig(j); const cf = path.join(dir, 'render.json');
      fs.writeFileSync(cf, JSON.stringify(cfg));
      const r = await runEngine(cf);
      const m = /RESULT (\{.*\})/.exec(r.out); const res = m ? JSON.parse(m[1]) : null;
      if (r.code !== 0 || !res || !res.ok) throw new Error((res && res.errors && res.errors.join('; ')) || (r.err || 'Render failed').slice(-300));
      fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify({ timing: res.timing || [], stills: res.stills, padding: res.padding || [] })); fs.renameSync(cfg.out, path.join(dir, 'video.mp4')); fs.renameSync(cfg.cover, path.join(dir, 'cover.jpg'));
      await pool.query("UPDATE jobs SET state='ready', video='video.mp4', cover='cover.jpg', dur=$2, render_error=NULL WHERE id=$1 AND state='rendering'", [id, String(res.duration)]);
      events('rendered', null, id, `${res.duration}s in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      await pool.query("UPDATE jobs SET state='failed', render_error=$2 WHERE id=$1 AND state='rendering'", [id, e.tag || 'other']).catch(() => {});
      events('render_failed', null, id, e.message);
    } finally { fs.rm(path.join(dir, 'work'), { recursive: true, force: true }, () => {}); }
  }

  async function pump() {
    if (busy) return; busy = true;
    try { while (queue.length) { const id = queue.shift(); try { await renderJob(id); } catch (e) { console.error('render', id, e.message); } } }
    finally { busy = false; }
  }
  const enqueue = id => { if (!queue.includes(id)) queue.push(id); pump(); };

  async function start(user, id, change) {
    const j = await jobsMod.getJob(user, id);
    if (!j) return { code: 404, error: "We can't find that job. Go back to Jobs and try again." };
    if (!canRender(user, j, change)) return { code: 409, error: 'This video is being made or is already approved, so it cannot be remade now.' };
    const ph = (await pool.query('SELECT kind FROM job_photos WHERE job_id=$1', [j.id])).rows.map(p => p.kind);
    if (!ph.includes('before') || !ph.includes('after')) return { code: 400, error: 'Add a BEFORE and an AFTER photo first.' };
    await pool.query("UPDATE jobs SET state='rendering', render_error=NULL WHERE id=$1", [j.id]);
    events(change ? 'photos_changed_remake' : 'render_start', user.id, j.id, change ? j.state : ''); enqueue(j.id);
    return { code: 200, state: 'rendering' };
  }

  app.post('/api/jobs/:id/render', sameOrigin, needUser({ json: true }), async (req, res, next) => { try {
    const r = await start(req.user, req.params.id);
    res.status(r.code).json(r.error ? { error: r.error } : { ok: true, state: r.state });
  } catch (e) { next(e); } });
  app.post('/jobs/:id/render', sameOrigin, needUser(), async (req, res, next) => { try {
    await start(req.user, req.params.id); res.redirect(303, `/jobs/${req.params.id}`);
  } catch (e) { next(e); } });

  // Done on the photo screen of a video that already exists: remake with the current lines and voice. A live video goes back to Needs approval.
  app.post('/jobs/:id/remake', sameOrigin, needUser(), async (req, res, next) => { try {
    const r = await start(req.user, req.params.id, true);
    res.redirect(303, r.code === 200 ? `/jobs/${req.params.id}` : `/jobs/${req.params.id}${r.code === 404 ? '' : '?m=err'}`);
  } catch (e) { next(e); } });
  app.post('/api/jobs/:id/remake', sameOrigin, needUser({ json: true }), async (req, res, next) => { try {
    const r = await start(req.user, req.params.id, true);
    res.status(r.code).json(r.error ? { error: r.error } : { ok: true, state: r.state });
  } catch (e) { next(e); } });

  const sendMedia = (name, type) => async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!j || !j.video || !['ready', 'approved', 'shared'].includes(j.state)) return res.status(404).end();
    res.set({ 'Cache-Control': 'private, no-cache', 'Content-Type': type });
    if (req.query.dl) res.set('Content-Disposition', `attachment; filename="${(SKIN.id || 'job')}-${j.id}.mp4"`);
    res.sendFile(path.join(jobsMod.dirOf(j.id), name), { acceptRanges: true, headers: { 'Content-Type': type } }, err => { if (err && !res.headersSent) res.status(404).end(); });
  } catch (e) { next(e); } };
  app.get('/api/jobs/:id/video', needUser({ json: true }), sendMedia('video.mp4', 'video/mp4'));
  app.get('/api/jobs/:id/timing', needUser({ json: true }), async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!j) return res.status(404).json({ error: "We can't find that job. Go back to Jobs and try again." });
    let t = {}; try { t = JSON.parse(fs.readFileSync(path.join(jobsMod.dirOf(j.id), 'timing.json'), 'utf8')); } catch (e) {}
    if (Array.isArray(t)) t = { timing: t };
    res.set('Cache-Control', 'no-store').json({ timing: t.timing || [], stills: t.stills || 0, padding: t.padding || [] });
  } catch (e) { next(e); } });
  app.get('/api/jobs/:id/cover', needUser({ json: true }), sendMedia('cover.jpg', 'image/jpeg'));

  async function init() {
    // anything left "rendering" by a restart goes back in the queue
    const r = (await pool.query("SELECT id FROM jobs WHERE state='rendering' ORDER BY id")).rows;
    r.forEach(x => queue.push(x.id)); if (r.length) { console.log('Re-queued renders:', r.map(x => x.id).join(',')); pump(); }
  }
  return { init, enqueue, start };
};
