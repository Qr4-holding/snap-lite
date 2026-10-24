// Jobs: the capture flow (before, during, after photos uploaded one by one), the job list, and owner-only actions.
// Photos are re-encoded with sharp (location data dropped) and kept under MEDIA_DIR/jobs/<id>/, served only to signed-in people
// of the same business. Nothing here is public.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { clean, esc, sameOrigin } = require('./lib/util');

const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
const JOBS_DIR = path.join(MEDIA_DIR, 'jobs');
const STATES = ['draft', 'rendering', 'ready', 'approved', 'shared', 'failed'];

module.exports = function jobs({ app, pool, SKIN, ui, acct, events, getShare }) {
  const { page, msg } = ui;
  const { needUser, needOwner } = acct;
  const form = express.urlencoded({ extended: false, limit: '10kb' });
  try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch (e) {}
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 6 },
    fileFilter: (req, file, cb) => cb(null, file.fieldname === 'file' && /^image\//.test(file.mimetype)) });

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, biz_id INT NOT NULL, user_id INT, title TEXT NOT NULL DEFAULT '',
      job_type TEXT NOT NULL DEFAULT '', voice_id TEXT, script TEXT, orientation TEXT, state TEXT NOT NULL DEFAULT 'draft',
      video TEXT, cover TEXT, dur TEXT, shared_at TIMESTAMPTZ, share_count INT NOT NULL DEFAULT 0, render_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS job_photos (
      id SERIAL PRIMARY KEY, job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('before','during','after')),
      seq INT NOT NULL DEFAULT 0, file TEXT NOT NULL, width INT, height INT, taken_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (job_id, kind, seq))`);
    await pool.query('CREATE INDEX IF NOT EXISTS jobs_biz_state ON jobs (biz_id, state, created_at DESC)');
    await pool.query(`CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY, user_id INT NOT NULL, platform TEXT, push_subscription JSONB, app_version TEXT, last_seen TIMESTAMPTZ DEFAULT now())`);
  }

  // ---------- access rules (server side) ----------
  // owner: every job of the business. crew: their own jobs, plus jobs that have been shared.
  async function getJob(user, id) {
    const j = (await pool.query('SELECT * FROM jobs WHERE id=$1 AND biz_id=$2', [parseInt(id, 10) || 0, user.biz_id])).rows[0];
    if (!j) return null;
    if (user.role === 'owner' || j.user_id === user.id || j.state === 'shared') return j;
    return null;
  }
  const canEdit = (user, j) => j && (user.role === 'owner' || j.user_id === user.id) && ['draft', 'failed'].includes(j.state);
  const photosOf = async id => (await pool.query('SELECT kind,seq,width,height,taken_at FROM job_photos WHERE job_id=$1 ORDER BY CASE kind WHEN \'before\' THEN 0 WHEN \'during\' THEN 1 ELSE 2 END, seq', [id])).rows;
  const dirOf = id => path.join(JOBS_DIR, String(id));
  const newSlug = () => crypto.randomBytes(6).toString('hex');

  // ---------- create a job ----------
  app.post('/api/jobs', sameOrigin, needUser({ json: true }), express.json({ limit: '5kb' }), form, async (req, res, next) => { try {
    const b = req.body || {}, type = clean(b.job_type, 60);
    const job_type = SKIN.job_types.includes(type) ? type : (SKIN.job_types[0] || '');
    const j = (await pool.query('INSERT INTO jobs (slug,biz_id,user_id,job_type) VALUES ($1,$2,$3,$4) RETURNING id', [newSlug(), req.user.biz_id, req.user.id, job_type])).rows[0];
    events('job_created', req.user.id, j.id);
    if (/json/.test(req.get('accept') || '') && !/html/.test(req.get('accept') || '')) return res.status(201).json({ id: j.id });
    res.redirect(303, `/jobs/${j.id}/capture`);
  } catch (e) { next(e); } });

  // ---------- one photo at a time ----------
  const uploadSafe = (req, res, next) => upload.single('file')(req, res, e => e ? res.status(e.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'That photo is too large (25 MB max).' : 'Could not read that upload.' }) : next());
  app.post('/api/jobs/:id/photos', sameOrigin, needUser({ json: true }), uploadSafe, async (req, res, next) => { try {
    const j = await getJob(req.user, req.params.id);
    if (!j) return res.status(404).json({ error: 'Job not found.' });
    if (!canEdit(req.user, j)) return res.status(409).json({ error: 'This job can no longer be changed.' });
    const kind = ['before', 'during', 'after'].includes(req.body.kind) ? req.body.kind : '';
    const seq = kind === 'during' ? parseInt(req.body.seq, 10) : 0;
    if (!kind || !req.file || !(seq >= 0) || (kind === 'during' && seq >= SKIN.max_during) || (kind !== 'during' && seq !== 0)) return res.status(400).json({ error: 'Check the photo type and try again.' });
    const dir = dirOf(j.id); fs.mkdirSync(dir, { recursive: true });
    const name = `${kind}${seq}`;
    // re-encode: auto-rotate, cap size, drop GPS and other hidden data
    let info;
    try {
      const img = sharp(req.file.buffer, { failOn: 'none' }).rotate();
      info = await img.clone().resize({ width: 2160, height: 2160, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toFile(path.join(dir, name + '.jpg'));
      await img.clone().resize({ width: 320, height: 320, fit: 'inside' }).jpeg({ quality: 78 }).toFile(path.join(dir, name + '_t.jpg'));
    } catch (e) { return res.status(400).json({ error: 'That file is not a photo we can read.' }); }
    await pool.query(`INSERT INTO job_photos (job_id,kind,seq,file,width,height) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (job_id,kind,seq) DO UPDATE SET file=EXCLUDED.file, width=EXCLUDED.width, height=EXCLUDED.height, taken_at=now()`, [j.id, kind, seq, name + '.jpg', info.width, info.height]);
    if (kind === 'before') await pool.query('UPDATE jobs SET orientation=$1 WHERE id=$2', [info.height >= info.width ? 'portrait' : 'landscape', j.id]);
    res.json({ ok: true, kind, seq, width: info.width, height: info.height });
  } catch (e) { next(e); } });

  app.get('/api/jobs/:id/photos/:kind/:seq', needUser({ json: true }), async (req, res, next) => { try {
    const j = await getJob(req.user, req.params.id);
    if (!j || !['before', 'during', 'after'].includes(req.params.kind) || !/^\d$/.test(req.params.seq)) return res.status(404).end();
    const p = (await pool.query('SELECT 1 FROM job_photos WHERE job_id=$1 AND kind=$2 AND seq=$3', [j.id, req.params.kind, +req.params.seq])).rows[0];
    if (!p) return res.status(404).end();
    const f = path.join(dirOf(j.id), `${req.params.kind}${req.params.seq}${req.query.t ? '_t' : ''}.jpg`);
    res.set({ 'Cache-Control': 'private, max-age=3600', 'Content-Type': 'image/jpeg' }); fs.createReadStream(f).on('error', () => res.status(404).end()).pipe(res);
  } catch (e) { next(e); } });

  // remove one photo from a draft (the capture screen's Remove button)
  app.delete('/api/jobs/:id/photos/:kind/:seq', sameOrigin, needUser({ json: true }), async (req, res, next) => { try {
    const j = await getJob(req.user, req.params.id);
    if (!j || !canEdit(req.user, j)) return res.status(404).json({ error: 'Job not found.' });
    const { kind, seq } = req.params;
    if (!['before', 'during', 'after'].includes(kind) || !/^\d$/.test(seq)) return res.status(404).json({ error: 'Photo not found.' });
    await pool.query('DELETE FROM job_photos WHERE job_id=$1 AND kind=$2 AND seq=$3', [j.id, kind, +seq]);
    for (const f of [`${kind}${seq}.jpg`, `${kind}${seq}_t.jpg`]) fs.rm(path.join(dirOf(j.id), f), { force: true }, () => {});
    events('photo_removed', req.user.id, j.id, `${kind}${seq}`);
    res.json({ ok: true });
  } catch (e) { next(e); } });

  app.get('/api/jobs/:id/status', needUser({ json: true }), async (req, res, next) => { try {
    const j = await getJob(req.user, req.params.id);
    if (!j) return res.status(404).json({ error: 'Job not found.' });
    res.set('Cache-Control', 'no-store').json({ id: j.id, state: j.state, orientation: j.orientation, job_type: j.job_type, error: j.render_error, photos: await photosOf(j.id) });
  } catch (e) { next(e); } });

  app.get('/api/jobs', needUser({ json: true }), async (req, res, next) => { try {
    res.set('Cache-Control', 'no-store').json((await visibleJobs(req.user)).map(r => ({ id: r.id, state: r.state, job_type: r.job_type, created_at: r.created_at, mine: r.user_id === req.user.id })));
  } catch (e) { next(e); } });

  async function visibleJobs(user) {
    const q = user.role === 'owner'
      ? ['SELECT * FROM jobs WHERE biz_id=$1 ORDER BY created_at DESC LIMIT 200', [user.biz_id]]
      : ["SELECT * FROM jobs WHERE biz_id=$1 AND (user_id=$2 OR state='shared') ORDER BY created_at DESC LIMIT 200", [user.biz_id, user.id]];
    return (await pool.query(...q)).rows;
  }

  // ---------- owner-only actions, enforced here whatever the screens show ----------
  app.post('/api/jobs/:id/approve', sameOrigin, needUser({ json: true }), needOwner, async (req, res, next) => { try {
    const j = await getJob(req.user, req.params.id);
    if (!j) return res.status(404).json({ error: 'Job not found.' });
    if (j.state !== 'ready') return res.status(409).json({ error: 'Only a finished video can be approved.' });
    await pool.query("UPDATE jobs SET state='approved' WHERE id=$1", [j.id]); events('approved', req.user.id, j.id);
    res.json({ ok: true, state: 'approved' });
  } catch (e) { next(e); } });

  app.post('/api/jobs/:id/shared', sameOrigin, needUser({ json: true }), needOwner, async (req, res, next) => { try {
    const j = await getJob(req.user, req.params.id);
    if (!j) return res.status(404).json({ error: 'Job not found.' });
    if (!['approved', 'shared'].includes(j.state)) return res.status(409).json({ error: 'Approve the video first.' });
    await pool.query("UPDATE jobs SET state='shared', shared_at=now(), share_count=share_count+1 WHERE id=$1", [j.id]); events('shared', req.user.id, j.id);
    res.json({ ok: true, state: 'shared' });
  } catch (e) { next(e); } });

  async function removeJob(user, id) {
    const j = await getJob(user, id);
    if (!j) return false;
    await pool.query('DELETE FROM jobs WHERE id=$1', [j.id]);
    fs.rm(dirOf(j.id), { recursive: true, force: true }, () => {});
    events('job_deleted', user.id, j.id);
    return true;
  }
  app.delete('/api/jobs/:id', sameOrigin, needUser({ json: true }), needOwner, async (req, res, next) => { try {
    res.status(await removeJob(req.user, req.params.id) ? 200 : 404).json({ ok: true });
  } catch (e) { next(e); } });
  app.post('/api/jobs/:id/delete', sameOrigin, needUser({ json: true }), needOwner, async (req, res, next) => { try {
    res.status(await removeJob(req.user, req.params.id) ? 200 : 404).json({ ok: true });
  } catch (e) { next(e); } });
  app.post('/jobs/:id/delete', sameOrigin, needUser(), needOwner, async (req, res, next) => { try {
    await removeJob(req.user, req.params.id); res.redirect(303, '/?m=deleted');
  } catch (e) { next(e); } });
  app.post('/jobs/:id/approve', sameOrigin, needUser(), needOwner, async (req, res, next) => { try {
    const j = await getJob(req.user, req.params.id);
    if (j && j.state === 'ready') { await pool.query("UPDATE jobs SET state='approved' WHERE id=$1", [j.id]); events('approved', req.user.id, j.id); }
    res.redirect(303, `/jobs/${req.params.id}`);
  } catch (e) { next(e); } });

  // ---------- screens ----------
  const LABEL = { draft: 'Draft', rendering: 'Making video…', ready: 'Needs approval', approved: 'Ready to share', shared: 'Shared', failed: 'Failed' };
  const jobCard = (r, mine) => `<a class="job" href="/jobs/${r.id}"><div class="th" style="background-image:url('${r.cover ? `/api/jobs/${r.id}/cover` : `/api/jobs/${r.id}/photos/${r.has_after ? 'after' : 'before'}/0?t=1`}')"></div><div><b>${esc(r.job_type || 'Job')}</b><span class="small">${new Date(r.created_at).toLocaleDateString('en-GB')}${mine ? '' : ' · by crew'}</span><br><span class="pill${['approved', 'ready'].includes(r.state) ? ' on' : ''}">${LABEL[r.state]}</span></div></a>`;

  app.get('/', needUser(), async (req, res, next) => { try {
    const u = req.user, rows = await visibleJobs(u);
    if (rows.length) {
      const have = (await pool.query(`SELECT job_id, bool_or(kind='after') a, bool_or(kind='before') b FROM job_photos WHERE job_id = ANY($1) GROUP BY job_id`, [rows.map(r => r.id)])).rows;
      const m = new Map(have.map(h => [h.job_id, h])); rows.forEach(r => { const h = m.get(r.id) || {}; r.has_after = !!h.a; });
    }
    const group = (title, states) => { const list = rows.filter(r => states.includes(r.state)); return list.length ? `<h2>${title} <span class="small">(${list.length})</span></h2><div class="jobs">${list.map(r => jobCard(r, r.user_id === u.id)).join('')}</div>` : ''; };
    const flash = { deleted: 'Job deleted.' }[req.query.m] || '';
    res.set('Cache-Control', 'no-store').send(page('Jobs', `
${msg(flash)}<a class="btn" href="/new" style="min-height:72px;font-size:22px">＋ New job</a>
${u.role === 'owner' ? group('Needs approval', ['ready']) : ''}${group('Ready to share', ['approved'])}${group('Shared', ['shared'])}${group('Drafts', ['draft', 'rendering'])}${group('Failed', ['failed'])}
${rows.length ? '' : `<p class="small" style="margin-top:18px">No jobs yet. Tap New job and take a before photo.</p>`}`, { user: u }));
  } catch (e) { next(e); } });

  app.get('/new', needUser(), (req, res) => res.set('Cache-Control', 'no-store').send(page('New job', `
<h1>New job</h1>
<form class="card" method="post" action="/api/jobs"><label class="f">What was the job?<select name="job_type">${SKIN.job_types.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>
<button type="submit">Start: take the before photo</button></form>`, { user: req.user })));

  app.get('/jobs/:id/capture', needUser(), async (req, res, next) => { try {
    const j = await getJob(req.user, req.params.id);
    if (!j) return res.redirect(303, '/');
    if (!canEdit(req.user, j)) return res.redirect(303, `/jobs/${j.id}`);
    const photos = await photosOf(j.id);
    const CFG = { id: j.id, maxDuring: SKIN.max_during, photos: photos.map(p => ({ kind: p.kind, seq: p.seq })), version: Date.now() };
    const slot = (kind, seq, label, cls) => `<div class="shot ${cls}" data-kind="${kind}" data-seq="${seq}" role="button" tabindex="0" aria-label="${label} photo"><span class="tag">${label}</span><span class="hint">Tap to add</span><span class="st" hidden></span><span class="acts"><button type="button" class="small sec retake">Retake</button><button type="button" class="small bad remove">Remove</button></span></div>`;
    const slots = slot('before', 0, 'BEFORE', 'before') + Array.from({ length: SKIN.max_during }, (_, i) => slot('during', i, SKIN.max_during > 1 ? `DURING ${i + 1}` : 'DURING', 'during') ).join('') + slot('after', 0, 'AFTER', 'after');
    res.set('Cache-Control', 'no-store').send(page('Photos', `
<h1>${esc(j.job_type || 'Job')}</h1>
<p class="small">Take the BEFORE photo first. For AFTER, stand in the same spot: a faint outline of the before photo helps you line it up. During photos are optional. Each photo saves as you take it.</p>
<div class="shots" id="shots">${slots}</div>
<p id="note" class="small"></p>
<div style="display:grid;gap:10px;margin-top:14px"><a class="btn" id="done" href="/jobs/${j.id}/voice" aria-disabled="true">Done: save job</a></div>
<input type="file" id="gal" accept="image/*" hidden>
<input type="file" id="cap" accept="image/*" capture="environment" hidden>
<div id="menu" class="cam" hidden style="grid-template-rows:1fr auto;background:rgba(0,0,0,.6)"><div></div><div class="bar" style="flex-direction:column;background:#fff;padding:16px;border-radius:18px 18px 0 0"><button id="mCam">Take photo</button><button class="sec" id="mGal">Choose from gallery</button><button class="sec" id="mX">Cancel</button></div></div>
<div id="cam" class="cam" hidden><div class="view"><video id="vid" playsinline muted></video><img id="ghost" class="ghost" alt="" hidden></div><div class="bar"><button class="snap" id="snap">Snap</button><button class="sec" id="cX">Cancel</button></div></div>`,
      { user: req.user, script: CAPTURE_JS.replace('__CFG__', JSON.stringify(CFG)) }));
  } catch (e) { next(e); } });

  // browser side of the capture screen: live camera with a ghost of the BEFORE photo for AFTER, gallery import, one request per photo with retries
  const CAPTURE_JS = `(function(){
var CFG=__CFG__, $=function(s){return document.querySelector(s)}, slots={}, cur=null, stream=null;
document.querySelectorAll('.shot').forEach(function(el){ slots[el.dataset.kind+el.dataset.seq]=el;
  el.querySelector('.retake').addEventListener('click',function(e){ e.stopPropagation(); open(el); });
  el.querySelector('.remove').addEventListener('click',function(e){ e.stopPropagation(); if(!confirm('Remove this photo?')) return; remove(el); }); el.addEventListener('click',function(){ open(el); }); el.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); open(el);} }); });
function url(k,s){ return '/api/jobs/'+CFG.id+'/photos/'+k+'/'+s+'?t=1&v='+CFG.version; }
function mark(k,s,u){ var el=slots[k+s]; if(!el) return; el.classList.add('has'); el.classList.remove('err'); el.style.backgroundImage="url('"+u+"')"; var h=el.querySelector('.hint'); if(h) h.hidden=true; }
CFG.photos.forEach(function(p){ mark(p.kind,p.seq,url(p.kind,p.seq)); });
function status(el,t,bad){ var st=el.querySelector('.st'); st.hidden=!t; st.textContent=t||''; el.classList.toggle('err',!!bad); }
function note(){ var b=CFG.photos.some(function(p){return p.kind==='before'}), a=CFG.photos.some(function(p){return p.kind==='after'}); $('#note').textContent=(b&&a)?'Before and after saved. You can add during photos or finish.':(b?'Now the AFTER photo.':''); $('#done').setAttribute('aria-disabled',(b&&a)?'false':'true'); }
$('#done').addEventListener('click',function(e){ if($('#done').getAttribute('aria-disabled')==='true'){ e.preventDefault(); $('#note').textContent='Add at least a BEFORE and an AFTER photo first.'; } });
function remove(el){
  var k=el.dataset.kind, s=+el.dataset.seq; status(el,'Removing…');
  fetch('/api/jobs/'+CFG.id+'/photos/'+k+'/'+s,{method:'DELETE',credentials:'same-origin'}).then(function(r){
    if(r.status===401){ location.href='/login'; return; }
    if(!r.ok){ status(el,'Could not remove. Try again.',true); return; }
    CFG.photos=CFG.photos.filter(function(p){return !(p.kind===k&&p.seq===s)});
    el.classList.remove('has','err'); el.style.backgroundImage=''; var h=el.querySelector('.hint'); if(h) h.hidden=false; status(el,''); note();
  }).catch(function(){ status(el,'No signal. Try again.',true); });
}
function open(el){ cur=el; $('#menu').hidden=false; }
$('#mX').onclick=function(){ $('#menu').hidden=true; };
$('#mGal').onclick=function(){ $('#menu').hidden=true; $('#gal').value=''; $('#gal').click(); };
$('#gal').onchange=function(){ if(this.files[0]) send(cur,this.files[0]); };
$('#cap').onchange=function(){ if(this.files[0]) send(cur,this.files[0]); };
$('#mCam').onclick=async function(){
  $('#menu').hidden=true; var el=cur;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ $('#cap').value=''; $('#cap').click(); return; }
  try{ stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:2160},height:{ideal:2160}},audio:false}); }catch(e){ $('#cap').value=''; $('#cap').click(); return; }
  var v=$('#vid'); v.srcObject=stream; await v.play().catch(function(){});
  var g=$('#ghost'); if(el.dataset.kind==='after'&&slots.before0.classList.contains('has')){ g.src='/api/jobs/'+CFG.id+'/photos/before/0?v='+CFG.version; g.hidden=false; } else g.hidden=true;
  $('#cam').hidden=false;
};
function stop(){ if(stream){ stream.getTracks().forEach(function(t){t.stop();}); stream=null; } $('#cam').hidden=true; }
$('#cX').onclick=stop;
$('#snap').onclick=function(){ var v=$('#vid'); if(!v.videoWidth) return; var c=document.createElement('canvas'); var s=Math.min(1,2160/Math.max(v.videoWidth,v.videoHeight)); c.width=Math.round(v.videoWidth*s); c.height=Math.round(v.videoHeight*s); c.getContext('2d').drawImage(v,0,0,c.width,c.height); var el=cur; stop(); c.toBlob(function(b){ send(el,b); },'image/jpeg',0.92); };
async function shrink(f){ try{ var bmp=await createImageBitmap(f,{imageOrientation:'from-image'}); var s=Math.min(1,2160/Math.max(bmp.width,bmp.height)); if(s>=1&&f.size<6e6) return f; var c=document.createElement('canvas'); c.width=Math.round(bmp.width*s); c.height=Math.round(bmp.height*s); c.getContext('2d').drawImage(bmp,0,0,c.width,c.height); return await new Promise(function(r){ c.toBlob(function(b){ r(b||f); },'image/jpeg',0.9); }); }catch(e){ return f; } }
async function send(el,file){
  var k=el.dataset.kind, s=+el.dataset.seq; status(el,'Uploading…');
  var blob=await shrink(file);
  for(var i=0;i<4;i++){
    try{
      var fd=new FormData(); fd.append('kind',k); fd.append('seq',s); fd.append('file',blob,'photo.jpg');
      var r=await fetch('/api/jobs/'+CFG.id+'/photos',{method:'POST',body:fd,credentials:'same-origin'});
      if(r.status===401){ location.href='/login'; return; }
      var j=await r.json().catch(function(){return {};});
      if(r.ok){ CFG.version=Date.now(); if(!CFG.photos.some(function(p){return p.kind===k&&p.seq===s})) CFG.photos.push({kind:k,seq:s}); mark(k,s,url(k,s)); status(el,'Saved'); setTimeout(function(){ status(el,''); },1500); note(); return; }
      if(r.status>=400&&r.status<500){ status(el,j.error||'Could not save. Tap to retry.',true); return; }
    }catch(e){}
    status(el,'No signal. Retrying…',true); await new Promise(function(r){ setTimeout(r,1500*(i+1)); });
  }
  status(el,'Not saved. Tap to try again.',true);
}
note();
})();`;

  app.get('/jobs/:id', needUser(), async (req, res, next) => { try {
    const u = req.user, j = await getJob(u, req.params.id);
    if (!j) return res.redirect(303, '/');
    const ph = await photosOf(j.id);
    const thumbs = ph.map(p => `<div class="shot has ${p.kind}" style="background-image:url('/api/jobs/${j.id}/photos/${p.kind}/${p.seq}?t=1')"><span class="tag">${p.kind.toUpperCase()}</span></div>`).join('');
    const owner = u.role === 'owner';
    const hasBA = ph.some(p => p.kind === 'before') && ph.some(p => p.kind === 'after');
    const mine = owner || j.user_id === u.id;
    const done = ['ready', 'approved', 'shared'].includes(j.state);
    const v = encodeURIComponent(j.dur || '') + (j.shared_at ? '' : '');
    const player = done ? `<video id="vid" controls playsinline preload="metadata" poster="/api/jobs/${j.id}/cover" src="/api/jobs/${j.id}/video" style="display:block;margin:0 auto;max-width:100%;width:auto;height:34vh;border-radius:14px;background:#000"></video><button type="button" class="sec small" id="fs" style="margin:6px auto 0">Full screen</button>` : '';
    const busy = j.state === 'rendering' ? '<p class="msg" id="busy">Making your video… this takes about a minute. You can leave this page open.</p>' : '';
    const fail = j.state === 'failed' ? `<p class="msg bad">The video could not be made${j.render_error ? ': ' + esc(j.render_error) : ''}. Try again.</p>` : '';
    const poll = j.state === 'rendering' ? `var n=0;(function p(){fetch('/api/jobs/${j.id}/status',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d.state!=='rendering'){location.reload();}else{setTimeout(p,Math.min(5000,1500+(n++)*500));}}).catch(function(){setTimeout(p,4000);});})();` : '';
    const sh = ['approved', 'shared'].includes(j.state) ? getShare().panel(j, owner) : null;
    res.set('Cache-Control', 'no-store').send(page('Job', `
<h1 style="font-size:22px;margin:0 0 6px">${esc(j.job_type || 'Job')} <span class="pill on" style="vertical-align:middle">${LABEL[j.state]}</span></h1>
${busy}${fail}${player}
${owner && j.state === 'ready' ? `<form method="post" action="/jobs/${j.id}/approve" style="margin-top:10px"><button type="submit">Approve</button></form>` : ''}
${sh ? sh.html : ''}
${done ? '' : `<div class="shots">${thumbs || '<p class="small">No photos yet.</p>'}</div>`}
<div style="display:grid;gap:10px;margin-top:12px">
${mine && hasBA && ['draft', 'failed'].includes(j.state) ? `<a class="btn" href="/jobs/${j.id}/voice">${j.state === 'failed' ? 'Try again' : 'Choose voice and make video'}</a>` : ''}
${canEdit(u, j) ? `<a class="btn sec" href="/jobs/${j.id}/capture">Add or retake photos</a>` : ''}
${mine && j.state === 'ready' ? `<a class="btn sec" href="/jobs/${j.id}/voice">Change voice or lines</a>` : ''}
${!owner && j.state === 'ready' ? '<p class="msg">Waiting for approval.</p>' : ''}
${owner ? `<form method="post" action="/jobs/${j.id}/delete" onsubmit="return confirm('Delete this job and its photos?')"><button class="bad" type="submit">Delete job</button></form>` : ''}
<a class="btn sec" href="/">Back to jobs</a></div>`, { user: u, script: poll + (sh ? sh.script : '') + `var fs=document.getElementById('fs'),v=document.getElementById('vid');if(fs&&v)fs.addEventListener('click',function(){var f=v.requestFullscreen||v.webkitRequestFullscreen||v.webkitEnterFullscreen;if(f)f.call(v);});` }));
  } catch (e) { next(e); } });

  return { init, getJob, removeJob, dirOf, STATES };
};
