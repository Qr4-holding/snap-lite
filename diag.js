// Diagnostics for phones that misbehave: the /check page, a place to send its report, and a log of every failed photo upload.
// Every report or failure gets a short code that can be quoted and looked up at /admin/diag.
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { esc, limited } = require('./lib/util');
const build = require('./lib/build');
const photo = require('./lib/photo');

module.exports = function diag({ app, pool, SKIN, ui, acct }) {
  const { page } = ui;
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const mkCode = () => Array.from(crypto.randomBytes(4), b => ALPHA[b % ALPHA.length]).join('');
  const uaOf = req => String(req.get('user-agent') || '').slice(0, 300);

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS diag_log (
      code TEXT PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(), kind TEXT NOT NULL, user_id INT, job_id INT, ua TEXT, data JSONB)`);
    await pool.query("DELETE FROM diag_log WHERE ts < now() - interval '90 days'");
  }
  async function put(kind, req, job_id, data) {
    for (let i = 0; i < 5; i++) {
      const code = mkCode();
      try {
        await pool.query('INSERT INTO diag_log (code,kind,user_id,job_id,ua,data) VALUES ($1,$2,$3,$4,$5,$6)',
          [code, kind, req.user ? req.user.id : null, job_id || null, uaOf(req), JSON.stringify(data).slice(0, 60000)]);
        return code;
      } catch (e) { if (e.code !== '23505') { console.error('diag log failed:', e.message); return 'NONE'; } }
    }
    return 'NONE';
  }
  // a failed photo upload: what arrived, what it really was, what went wrong. Returns the code to show the person.
  async function uploadFailure(req, { reason, error, file, status, jobId }) {
    const f = file || {};
    const detected = f.buffer ? photo.sniff(f.buffer) : (error && error.detected) || null;
    const code = await put('upload_failure', req, jobId, {
      reason, status, error: error ? String(error.message || error).slice(0, 400) : undefined,
      name: f.originalname, mimetype: f.mimetype, size: f.size || (f.buffer && f.buffer.length), detected,
      fields: req.body ? Object.keys(req.body).slice(0, 8) : []
    });
    console.warn(`upload failed [${code}] ${reason}: ${error ? String(error.message || error).slice(0, 120) : ''}`);
    return code;
  }

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 6 } });

  // the check page runs the same steps the capture screen does and reports each one
  app.get('/check', acct.needUser(), (req, res) => {
    res.set('Cache-Control', 'no-store').send(page('Check', `<h1>Photo check</h1>
<p>Tap one button, choose or take a photo, then wait for the report. Nothing is saved to any job.</p>
<div class="card" id="env"><p class="small">Loading…</p></div>
<div style="display:grid;gap:10px;margin:14px 0">
<label class="btn" style="position:relative;overflow:hidden;text-align:center">Pick a photo<input id="f1" type="file" accept="image/*" style="position:absolute;inset:0;opacity:0;width:100%;height:100%"></label>
<label class="btn sec" style="position:relative;overflow:hidden;text-align:center">Take a photo<input id="f2" type="file" accept="image/*" capture="environment" style="position:absolute;inset:0;opacity:0;width:100%;height:100%"></label>
</div>
<div id="out"></div>`, { user: req.user, script: CHECK_JS.replace('__CFG__', JSON.stringify({ version: build.version, commit: build.commit, started: build.started })) }));
  });

  app.post('/api/diag/upload', acct.needUser({ json: true }), (req, res, next) => upload.single('file')(req, res, async e => {
    if (e) return res.status(400).json({ error: 'Could not read that upload.', code: await uploadFailure(req, { reason: 'check: multer ' + (e.code || ''), error: e }) });
    if (!req.file) return res.status(400).json({ error: 'No file arrived.', code: await uploadFailure(req, { reason: 'check: no file in the request' }) });
    try { const r = await photo.normalize(req.file.buffer); res.json({ ok: true, width: r.width, height: r.height, jpeg_bytes: r.full.length, converted_with: r.via, detected: r.detected, received_bytes: req.file.size, received_type: req.file.mimetype }); }
    catch (err) { res.status(400).json({ error: 'The server could not read that photo.', detail: String(err.message).slice(0, 200), detected: err.detected, code: await uploadFailure(req, { reason: 'check: decode failed', error: err, file: req.file }) }); }
  }));

  app.post('/api/diag', acct.needUser({ json: true }), express.json({ limit: '100kb' }), async (req, res, next) => { try {
    if (limited('diag:' + req.user.id, 40)) return res.status(429).json({ error: 'Too many reports.' });
    const r = req.body && typeof req.body === 'object' ? req.body : null;
    if (!r) return res.status(400).json({ error: 'No report.' });
    res.json({ ok: true, code: await put(String(r.kind || 'check').replace(/[^a-z-]/g, '').slice(0, 20) || 'check', req, null, r) });
  } catch (e) { next(e); } });

  async function recent(code, limit = 25) {
    if (code) return (await pool.query('SELECT code,ts,kind,user_id,job_id,ua,data FROM diag_log WHERE code=$1', [String(code).toUpperCase().slice(0, 8)])).rows;
    return (await pool.query('SELECT code,ts,kind,user_id,job_id,ua,data FROM diag_log ORDER BY ts DESC LIMIT $1', [limit])).rows;
  }

  const CHECK_JS = `(function(){
var CFG=__CFG__, $=function(s){return document.querySelector(s)}, UA=navigator.userAgent;
function iosVer(){ var m=/OS (\\d+)[_.](\\d+)(?:[_.](\\d+))?/.exec(UA); if(/iPhone|iPad|iPod/.test(UA)&&m) return m[1]+'.'+m[2]+(m[3]?'.'+m[3]:''); if(/Macintosh/.test(UA)&&navigator.maxTouchPoints>1) return 'iPad (reports as a Mac), Safari '+((/Version\\/([\\d.]+)/.exec(UA)||[])[1]||'?'); return 'not an iPhone or iPad'; }
var ENV={version:CFG.version,commit:CFG.commit,serverStarted:CFG.started,userAgent:UA,ios:iosVer(),standalone:navigator.standalone===true,displayModeStandalone:!!(window.matchMedia&&matchMedia('(display-mode: standalone)').matches),sw:'checking',screen:screen.width+'x'+screen.height,dpr:window.devicePixelRatio,online:navigator.onLine,cookies:navigator.cookieEnabled};
function drawEnv(){ var rows=[['App version',ENV.version+' (build '+ENV.commit+')'],['Phone and browser',UA],['iOS version',ENV.ios],['Running as a home-screen app',ENV.standalone?'Yes':'No'+(ENV.displayModeStandalone?' (display-mode says yes)':'')],['Service worker',ENV.sw],['Screen',ENV.screen+' at '+ENV.dpr+'x'],['Online',ENV.online?'Yes':'No']];
  $('#env').innerHTML=rows.map(function(r){ var d=document.createElement('div'); d.textContent=r[1]; return '<p class="small" style="margin:6px 0"><b>'+r[0]+':</b> '+d.innerHTML+'</p>'; }).join(''); }
drawEnv();
if(navigator.serviceWorker){ navigator.serviceWorker.getRegistration().then(function(r){ ENV.sw=!r?'Not registered':(r.active?'Active ('+r.active.state+')':(r.installing?'Installing':(r.waiting?'Waiting':'Registered, not active')))+(navigator.serviceWorker.controller?', controlling this page':', not controlling this page'); drawEnv(); }).catch(function(e){ ENV.sw='Error: '+e.message; drawEnv(); }); } else { ENV.sw='Not supported by this browser'; drawEnv(); }
function err(e){ return (e&&e.name?e.name+': ':'')+(e&&e.message?e.message:String(e)); }
function run(file,mode){
  var out=$('#out'), R={kind:'check',mode:mode,started:new Date().toISOString(),env:ENV,steps:[]}, T0=Date.now();
  out.innerHTML='<h2>Report ('+(mode==='camera'?'Take a photo':'Pick a photo')+')</h2><ol id="steps" style="padding-left:20px"></ol><p id="end" class="small"></p>';
  function say(name,ok,text,extra){ var ms=Date.now()-T0; R.steps.push({step:name,ok:ok,detail:text,ms:ms,extra:extra}); var li=document.createElement('li'); li.style.margin='8px 0'; li.style.color=ok===false?'#b00020':''; li.textContent=(ok===false?'PROBLEM: ':ok===true?'OK: ':'')+text; $('#steps').appendChild(li); }
  (async function(){
    try{
      if(!file){ say('file',false,'The phone said a picture was chosen but gave the page no file.'); return finish(); }
      say('file',true,'File name '+(file.name||'(none)')+', type '+(file.type||'(blank)')+', size '+file.size+' bytes ('+(file.size/1048576).toFixed(2)+' MB), last changed '+(file.lastModified?new Date(file.lastModified).toISOString():'unknown')+'.',{name:file.name,type:file.type,size:file.size,lastModified:file.lastModified});
      var bmp=null,img=null,w=0,h=0;
      if(typeof createImageBitmap!=='function'){ say('bitmap',false,'This browser has no createImageBitmap.'); }
      else { try{ bmp=await createImageBitmap(file,{imageOrientation:'from-image'}); say('bitmap',true,'createImageBitmap opened it: '+bmp.width+' x '+bmp.height+'.'); w=bmp.width;h=bmp.height; }catch(e){ say('bitmap',false,'createImageBitmap could not open it ('+err(e)+').'); } }
      try{
        img=await new Promise(function(res,rej){ var u=URL.createObjectURL(file),im=new Image(),t=setTimeout(function(){ rej(new Error('timed out after 15 seconds')); },15000); im.onload=function(){ clearTimeout(t); res(im); }; im.onerror=function(){ clearTimeout(t); rej(new Error('the image element refused it')); }; im.src=u; });
        say('img',true,'An image element opened it: '+img.naturalWidth+' x '+img.naturalHeight+'.'); if(!w){w=img.naturalWidth;h=img.naturalHeight;}
      }catch(e){ say('img',false,'An image element could not open it ('+err(e)+').'); }
      var blob=file, how='the original file, unchanged';
      var src=bmp||img;
      if(src){
        try{
          var sc=Math.min(1,2160/Math.max(w,h));
          if(sc>=1&&file.size<6e6&&file.type==='image/jpeg'){ say('canvas',true,'It is already a small JPEG, so the app sends it as it is.'); }
          else { var c=document.createElement('canvas'); c.width=Math.round(w*sc); c.height=Math.round(h*sc); c.getContext('2d').drawImage(src,0,0,c.width,c.height);
            blob=await new Promise(function(r){ c.toBlob(function(b){ r(b); },'image/jpeg',0.9); });
            if(!blob){ blob=file; say('canvas',false,'The picture could not be turned into a JPEG (the canvas gave nothing). The original would be sent.'); }
            else { how='a JPEG made in the browser'; say('canvas',true,'Turned into a JPEG: '+c.width+' x '+c.height+', type '+blob.type+', size '+blob.size+' bytes.'); } }
        }catch(e){ say('canvas',false,'Making the JPEG failed ('+err(e)+'). The original would be sent.'); blob=file; }
      } else { say('canvas',false,'Neither the browser tools could open the picture, so the original file would be sent to the server to convert.'); }
      say('final',null,'Sending '+how+': type '+(blob.type||'(blank)')+', size '+blob.size+' bytes.');
      try{
        var fd=new FormData(); fd.append('file',blob,'photo.jpg');
        var t1=Date.now(), r=await fetch('/api/diag/upload',{method:'POST',body:fd,credentials:'same-origin'}), txt=await r.text(), j=null; try{ j=JSON.parse(txt); }catch(e){}
        R.upload={status:r.status,ms:Date.now()-t1,json:j,text:j?undefined:txt.slice(0,300)};
        if(r.ok&&j&&j.ok) say('upload',true,'The server accepted it (status '+r.status+') and read it as a '+j.detected.type+' file, '+j.width+' x '+j.height+', converting with '+j.converted_with+'. Took '+(Date.now()-t1)+' ms.');
        else say('upload',false,'The server refused it (status '+r.status+'): '+(j&&j.error?j.error:txt.slice(0,160))+(j&&j.detail?' ('+j.detail+')':'')+(j&&j.code?' Server code '+j.code+'.':''));
      }catch(e){ R.upload={error:err(e)}; say('upload',false,'The upload did not reach the server ('+err(e)+').'); }
    }catch(e){ say('crash',false,'The check itself failed: '+err(e)); }
    finish();
  })();
  async function finish(){
    R.totalMs=Date.now()-T0; $('#end').textContent='Total time '+(R.totalMs/1000).toFixed(1)+' seconds. Sending the report…';
    try{ var r=await fetch('/api/diag',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(R),credentials:'same-origin'}); var j=await r.json();
      if(j&&j.code){ $('#end').innerHTML='Total time '+(R.totalMs/1000).toFixed(1)+' seconds.<br><span style="font-size:22px">Report sent, code <b>'+j.code+'</b></span><br>Please read this code to Robert.'; }
      else throw new Error('status '+r.status);
    }catch(e){ $('#end').innerHTML='Total time '+(R.totalMs/1000).toFixed(1)+' seconds. <b>The report could not be sent ('+err(e)+').</b> Please take a screenshot of this page instead.'; }
  }
}
$('#f1').addEventListener('change',function(){ run(this.files&&this.files[0],'pick'); });
$('#f2').addEventListener('change',function(){ run(this.files&&this.files[0],'camera'); });
})();`;

  return { init, uploadFailure, put, recent, upload };
};
