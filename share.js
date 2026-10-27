// Sharing: owner-only signed links, and the public /job/:slug page they open. A link carries an expiry and a signature;
// without a valid pair nothing is shown (404). Only approved or shared jobs can have a link, and only their finished video and cover are served.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { esc, sameOrigin, sign, verify } = require('./lib/util');

const LINK_DAYS = 365;

module.exports = function share({ app, pool, SKIN, ui, acct, jobsMod, events }) {
  const { page } = ui;
  const { needUser, needOwner } = acct;
  let secret = '';
  async function init() {
    await pool.query('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    let r = (await pool.query("SELECT value FROM settings WHERE key='link_secret'")).rows[0];
    if (!r) { await pool.query("INSERT INTO settings (key,value) VALUES ('link_secret',$1) ON CONFLICT (key) DO NOTHING", [crypto.randomBytes(32).toString('hex')]); r = (await pool.query("SELECT value FROM settings WHERE key='link_secret'")).rows[0]; }
    secret = r.value;
  }
  const origin = req => `https://${req.get('host')}`;
  const shareable = j => j && ['approved', 'shared'].includes(j.state) && j.video;
  const makeQuery = slug => { const e = Date.now() + LINK_DAYS * 864e5; return `e=${e}&s=${sign(secret, slug, e)}`; };

  // owner asks for the link to hand out
  app.post('/api/jobs/:id/link', sameOrigin, needUser({ json: true }), needOwner, async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!j) return res.status(404).json({ error: "We can't find that job. Go back to Jobs and try again." });
    if (!shareable(j)) return res.status(409).json({ error: 'Approve the video first, then share it.' });
    events('link_made', req.user.id, j.id);
    res.set('Cache-Control', 'no-store').json({ url: `${origin(req)}/job/${j.slug}?${makeQuery(j.slug)}` });
  } catch (e) { next(e); } });

  // public side: the signature is the only key
  async function bySig(req) {
    const slug = String(req.params.slug || ''); if (!/^[a-f0-9]{12}$/.test(slug)) return null;
    if (!verify(secret, slug, req.query.e, String(req.query.s || ''))) return null;
    const j = (await pool.query('SELECT * FROM jobs WHERE slug=$1', [slug])).rows[0];
    return shareable(j) ? j : null;
  }
  const q = req => `e=${encodeURIComponent(req.query.e)}&s=${encodeURIComponent(req.query.s)}`;
  app.get('/job/:slug', async (req, res, next) => { try {
    const j = await bySig(req);
    if (!j) return res.status(404).type('text/plain').send('Not found');
    const base = `/job/${j.slug}`, o = origin(req);
    const vurl = `${base}/video?${q(req)}`, curl = `${base}/cover?${q(req)}`;
    const head = `<meta property="og:type" content="video.other"><meta property="og:title" content="${esc(SKIN.name)}: before and after"><meta property="og:image" content="${esc(o + curl)}"><meta property="og:video" content="${esc(o + vurl)}"><meta property="og:video:type" content="video/mp4">`;
    res.set({ 'Cache-Control': 'private, no-cache', 'X-Robots-Tag': 'noindex, nofollow' }).send(page('Before and after', `
<h1 style="text-align:center">Before and after</h1>
<video controls playsinline preload="metadata" poster="${esc(curl)}" src="${esc(vurl)}" style="width:100%;border-radius:14px;background:#000;max-height:75vh"></video>
<div style="display:grid;gap:10px;margin-top:16px;text-align:center">
${SKIN.phone ? `<a class="btn" href="tel:${esc(String(SKIN.phone).replace(/\s+/g, ''))}">Call ${esc(SKIN.phone)}</a>` : ''}
${SKIN.web ? `<a class="btn sec" href="https://${esc(SKIN.web)}">${esc(SKIN.web)}</a>` : ''}
<p class="small">${esc(SKIN.name)}</p></div>`, { headExtra: head }));
  } catch (e) { next(e); } });
  const media = (name, type) => async (req, res, next) => { try {
    const j = await bySig(req);
    if (!j) return res.status(404).type('text/plain').send('Not found');
    res.set({ 'Cache-Control': 'private, no-cache', 'X-Robots-Tag': 'noindex' });
    res.sendFile(path.join(jobsMod.dirOf(j.id), name), { acceptRanges: true, headers: { 'Content-Type': type } }, err => { if (err && !res.headersSent) res.status(404).end(); });
  } catch (e) { next(e); } };
  app.get('/job/:slug/video', media('video.mp4', 'video/mp4'));
  app.get('/job/:slug/cover', media('cover.jpg', 'image/jpeg'));

  // the block of share buttons on the job screen (owner only for sharing; everyone who can open a shared job can save it)
  function panel(j, owner) {
    const id = j.id, text = `${SKIN.name}: before and after.${SKIN.phone ? ' ' + SKIN.phone : ''}`;
    const html = `<div class="card" id="share" style="margin-top:10px;gap:8px">
${owner ? `<button type="button" id="b-share">Share video</button>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button type="button" id="b-wa" class="small" style="background:#1a9c4a;width:100%;font-size:15px">Send link on WhatsApp</button><button type="button" id="b-fb" class="small" style="background:#1877f2;width:100%;font-size:15px">Send link on Facebook</button></div>` : ''}
<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><a class="btn sec" id="b-save" href="/api/jobs/${id}/video?dl=1" download="${esc(SKIN.id)}-${id}.mp4">Save to phone</a>
${owner ? `<button type="button" class="sec" id="b-copy">Copy link</button>` : ''}</div>
<p class="small" id="share-note" style="margin:0">${j.state === 'shared' ? `Shared ${j.share_count} time${j.share_count === 1 ? '' : 's'}${j.shared_at ? ', last on ' + new Date(j.shared_at).toLocaleDateString('en-GB') : ''}. ` : ''}${owner ? '“Share video” sends the video file itself. The WhatsApp and Facebook buttons send only a link that plays it.' : ''}</p></div>`;
    const script = `
var ID=${id},TEXT=${JSON.stringify(text)},note=document.getElementById('share-note');
function say(t){note.textContent=t;}
function mark(){return fetch('/api/jobs/'+ID+'/shared',{method:'POST',credentials:'same-origin'}).then(function(r){return r.ok?r.json():null;}).catch(function(){return null;});}
function getLink(){return fetch('/api/jobs/'+ID+'/link',{method:'POST',credentials:'same-origin'}).then(function(r){return r.json();}).then(function(d){return d.url;});}
var bs=document.getElementById('b-share');
if(bs)bs.addEventListener('click',async function(){
  bs.disabled=true;say('Getting the video ready…');
  try{
    var r=await fetch('/api/jobs/'+ID+'/video',{credentials:'same-origin'});var blob=await r.blob();
    var file=new File([blob],'${esc(SKIN.id)}-'+ID+'.mp4',{type:'video/mp4'});
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      await navigator.share({files:[file],text:TEXT});await mark();say('Shared. Thank you.');setTimeout(function(){location.reload();},900);
    }else if(navigator.share){
      var u=await getLink();await navigator.share({text:TEXT,url:u});await mark();say('Link shared.');setTimeout(function(){location.reload();},900);
    }else{say('This phone cannot open the share menu here. Use Save to phone or Copy link.');}
  }catch(e){say(e&&e.name==='AbortError'?'Sharing was cancelled.':'Could not share. Try Save to phone or Copy link.');}
  bs.disabled=false;});
function openApp(btn,mk){btn.addEventListener('click',async function(){
  btn.disabled=true;say('Opening…');
  try{var u=await getLink();var t=TEXT+' '+u;await mark();location.href=mk(u,t);say('Opened. Come back here when you have posted it.');}
  catch(e){say('Could not open it. Try Share video or Copy link.');}
  btn.disabled=false;});}
var bw=document.getElementById('b-wa');
if(bw)openApp(bw,function(u,t){return 'intent://send?text='+encodeURIComponent(t)+'#Intent;scheme=whatsapp;package=com.whatsapp;S.browser_fallback_url='+encodeURIComponent('https://wa.me/?text='+encodeURIComponent(t))+';end';});
var bf=document.getElementById('b-fb');
if(bf)openApp(bf,function(u){return 'https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(u);});
var bc=document.getElementById('b-copy');
if(bc)bc.addEventListener('click',async function(){
  try{var u=await getLink();
    try{await navigator.clipboard.writeText(u);say('Link copied. Paste it into a message or post.');}
    catch(e){window.prompt('Copy this link',u);}
    await mark();
  }catch(e){say('Could not make the link. Try again.');}});`;
    return { html, script: owner ? script : "" };
  }
  return { init, panel };
};
