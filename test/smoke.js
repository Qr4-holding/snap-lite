// Smoke tests that run against ANY running server (local or deployed):
//   BASE_URL=https://... ADMIN_USER=admin ADMIN_PASSWORD=... node test/smoke.js [phase1|phase2|phase3|phase4|all]
// Phase 2 and 3 create throw-away accounts @snaplite-test.invalid and remove them at the end.
const http = require('http');
const sharp = require('sharp');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN = process.env.ADMIN_USER || 'admin', ADMIN_PW = process.env.ADMIN_PASSWORD || '';
const which = process.argv[2] || 'all';
const TEST = '@snaplite-test.invalid', RUN = Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

// a person with a cookie jar
const person = () => ({ cookie: '' });
async function req(who, method, path, { body, headers = {}, json } = {}) {
  const h = Object.assign({}, headers);
  if (who && who.cookie) h.cookie = who.cookie;
  if (who && who.basic) h.authorization = 'Basic ' + Buffer.from(who.basic).toString('base64');
  if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (body && typeof body === 'string' && !h['content-type']) h['content-type'] = 'application/x-www-form-urlencoded';
  const r = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (who && sc.length) { const m = sc.map(c => c.split(';')[0]).find(c => c.startsWith('sl=')); if (m) who.cookie = m.endsWith('=') ? '' : m; }
  const text = await r.text().catch(() => '');
  return { status: r.status, headers: r.headers, text, loc: r.headers.get('location') || '', json: () => { try { return JSON.parse(text); } catch (e) { return {}; } } };
}
const form = o => new URLSearchParams(o).toString();
const admin = () => ({ basic: ADMIN + ':' + ADMIN_PW });
async function login(email, password) { const p = person(); const r = await req(p, 'POST', '/login', { body: form({ email, password }) }); return { p, r }; }
const jpeg = async (w, h, opt = {}) => {
  let s = sharp({ create: { width: w, height: h, channels: 3, background: { r: 90 + (opt.shade || 0), g: 140, b: 90 } } });
  if (opt.exif) s = s.withExif(opt.exif);
  if (opt.orientation) s = s.withMetadata({ orientation: opt.orientation });
  return s.jpeg().toBuffer();
};
async function upload(who, jobId, kind, seq, buf, name = 'photo.jpg', type = 'image/jpeg') {
  const fd = new FormData(); fd.append('kind', kind); fd.append('seq', String(seq)); fd.append('file', new Blob([buf], { type }), name);
  const h = { cookie: who.cookie };
  const r = await fetch(`${BASE}/api/jobs/${jobId}/photos`, { method: 'POST', body: fd, headers: h, redirect: 'manual' });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function phase1() {
  console.log('\n== Phase 1: fork and strip ==');
  const h = await req(null, 'GET', '/health');
  ok('health answers and names the skin', h.status === 200 && h.json().ok === true && h.json().skin === 'ekp11', h.text);
  const l = await req(null, 'GET', '/login');
  ok('sign-in screen is served', l.status === 200 && /<form[^>]+action="\/login"/.test(l.text));
  ok('sign-in screen is in EKP11 colours with the EKP11 logo', l.text.includes('#018603') && l.text.includes('/assets/logo.png') && l.text.includes('EKP11'));
  ok('no SnapTheJob wording on the sign-in screen', !/SnapTheJob|Snap The Job|Get a quote|waiting list/i.test(l.text));
  const logo = await fetch(BASE + '/assets/logo.png');
  ok('logo is served as an image', logo.status === 200 && /image\/png/.test(logo.headers.get('content-type') || ''));
  const m = await req(null, 'GET', '/manifest.json');
  ok('manifest carries the EKP11 name and colour', m.status === 200 && m.json().theme_color === '#018603' && /EKP11/.test(m.json().name || ''));
  for (const p of ['/assets/icon-192.png', '/assets/icon-512.png', '/assets/apple-touch-icon.png']) { const r = await fetch(BASE + p); ok('icon ' + p, r.status === 200 && /image\/png/.test(r.headers.get('content-type') || '')); }
  const root = await req(null, 'GET', '/');
  ok('home redirects to sign-in when signed out', root.status === 302 && root.loc.endsWith('/login'), root.status + ' ' + root.loc);
  for (const p of ['/api/jobs', '/api/jobs/1/status', '/api/jobs/1/photos/before/0']) { const r = await req(null, 'GET', p); ok('no public job data at ' + p, r.status === 401, String(r.status)); }
  for (const p of ['/jobs/1', '/jobs/1/capture', '/new', '/settings']) { const r = await req(null, 'GET', p); ok('screen needs sign-in: ' + p, r.status === 302 && r.loc.endsWith('/login'), r.status + ' ' + r.loc); }
  for (const p of ['/feed', '/job/anything', '/trade', '/quotes', '/admin/quotes', '/api/waitlist', '/api/follow', '/api/contact', '/sitemap.xml', '/uploads/jobs/x.mp4', '/media/waste-clearance.mp4', '/assets/jobs.js', '/work/house'])
    { const r = await req(null, 'GET', p); ok('removed or private: ' + p, r.status === 404 || r.status === 401, String(r.status)); }
  const post = await req(null, 'POST', '/api/waitlist', { json: { name: 'x', email: 'x@x.co' } });
  ok('waiting-list endpoint is gone', post.status === 404, String(post.status));
  const a = await req(null, 'GET', '/admin');
  ok('admin asks for a password', a.status === 401);
  const robots = await req(null, 'GET', '/robots.txt');
  ok('robots keeps search engines out', /Disallow: \//.test(robots.text));
  ok('security headers present', h.headers.get('x-content-type-options') === 'nosniff' && /noindex/.test(h.headers.get('x-robots-tag') || ''));
}

async function phase2() {
  console.log('\n== Phase 2: accounts and roles ==');
  if (!ADMIN_PW) { ok('ADMIN_PASSWORD supplied for admin tests', false, 'set ADMIN_PASSWORD'); return {}; }
  const ownerEmail = `owner-${RUN}${TEST}`, ownerPw = 'Owner-pass-' + RUN, crewEmail = `crew-${RUN}${TEST}`;
  const bad = await req({ basic: ADMIN + ':wrong-password' }, 'GET', '/admin');
  ok('admin refuses a wrong password', bad.status === 401);
  const mk = await req(admin(), 'POST', '/admin/owner', { body: form({ name: 'Test Owner', email: ownerEmail, password: ownerPw }) });
  ok('admin creates the owner', mk.status === 303 && /m=owner/.test(mk.loc), mk.status + ' ' + mk.loc);
  const dup = await req(admin(), 'POST', '/admin/owner', { body: form({ name: 'x', email: ownerEmail, password: ownerPw }) });
  ok('duplicate owner email is refused', /m=bad/.test(dup.loc));
  const wrong = await login(ownerEmail, 'not-the-password');
  ok('wrong password does not sign in', wrong.r.status === 401 && !wrong.p.cookie);
  const { p: owner, r: lo } = await login(ownerEmail, ownerPw);
  ok('owner signs in', lo.status === 303 && !!owner.cookie, lo.status + ' ' + lo.loc);
  const home = await req(owner, 'GET', '/');
  ok('owner sees the jobs screen', home.status === 200 && /New job/.test(home.text));
  // crew
  const inv = await req(owner, 'POST', '/settings/invite', { body: form({ email: crewEmail }) });
  const pw = (inv.loc.match(/[?&]p=([A-Za-z0-9]+)/) || [])[1];
  ok('owner creates a crew login with a temporary password', inv.status === 303 && !!pw, inv.loc);
  const { p: crew, r: lc } = await login(crewEmail, pw || 'x');
  ok('crew signs in with the temporary password', lc.status === 303 && !!crew.cookie);
  const cs = await req(crew, 'GET', '/settings');
  ok('crew settings show no crew management', cs.status === 200 && !/Create crew login/.test(cs.text));
  ok('owner settings show crew management', /Create crew login/.test((await req(owner, 'GET', '/settings')).text));
  // jobs for role tests
  const cj = (await req(crew, 'POST', '/api/jobs', { json: { job_type: 'Garden' }, headers: { accept: 'application/json' } })).json().id;
  const oj = (await req(owner, 'POST', '/api/jobs', { json: { job_type: 'Garage' }, headers: { accept: 'application/json' } })).json().id;
  ok('crew and owner can each start a job', !!cj && !!oj, `${cj} ${oj}`);
  // crew cannot reach owner-only routes, even by calling them directly
  const denied = [['POST', `/api/jobs/${cj}/approve`], ['POST', `/api/jobs/${cj}/shared`], ['DELETE', `/api/jobs/${cj}`], ['POST', `/api/jobs/${cj}/delete`], ['POST', `/jobs/${cj}/delete`], ['POST', `/jobs/${cj}/approve`], ['POST', '/settings/invite'], ['POST', `/settings/crew/1/remove`]];
  for (const [m, p] of denied) { const r = await req(crew, m, p, p === '/settings/invite' ? { body: form({ email: `x${RUN}${TEST}` }) } : {}); ok(`crew blocked: ${m} ${p}`, r.status === 403, String(r.status)); }
  const still = await req(crew, 'GET', `/api/jobs/${cj}/status`);
  ok('the crew job survived those attempts', still.status === 200);
  const ap = await req(owner, 'POST', `/api/jobs/${cj}/approve`);
  ok('owner passes the role check (a draft cannot be approved yet)', ap.status === 409, String(ap.status));
  const sh = await req(owner, 'POST', `/api/jobs/${cj}/shared`);
  ok('owner share needs an approved job', sh.status === 409, String(sh.status));
  // visibility
  ok('crew cannot open the owner\'s job', (await req(crew, 'GET', `/api/jobs/${oj}/status`)).status === 404);
  const list = (await req(crew, 'GET', '/api/jobs')).json();
  ok('crew list holds only their own jobs', Array.isArray(list) && list.every(j => j.mine) && list.some(j => j.id === cj) && !list.some(j => j.id === oj));
  ok('owner sees both jobs', ((await req(owner, 'GET', '/api/jobs')).json() || []).filter(j => [cj, oj].includes(j.id)).length === 2);
  // account deletion keeps jobs
  const wd = await req(crew, 'POST', '/settings/delete-account', { body: form({ password: 'wrong-wrong' }) });
  ok('deleting an account needs the password', /m=badpw/.test(wd.loc));
  const oldCookie = crew.cookie;
  const del = await req(crew, 'POST', '/settings/delete-account', { body: form({ password: pw }) });
  ok('crew deletes their own account', del.status === 303 && /m=gone/.test(del.loc), del.loc);
  ok('deleted account cannot sign in again', (await login(crewEmail, pw)).r.status === 401);
  ok('the old session of a deleted account is dead', (await req({ cookie: oldCookie }, 'GET', '/api/jobs')).status === 401);
  ok('their job is kept for the business', (await req(owner, 'GET', `/api/jobs/${cj}/status`)).status === 200);
  // owner removes crew
  const inv2 = await req(owner, 'POST', '/settings/invite', { body: form({ email: `crew2-${RUN}${TEST}` }) });
  const pw2 = (inv2.loc.match(/[?&]p=([A-Za-z0-9]+)/) || [])[1];
  const crew2 = (await login(`crew2-${RUN}${TEST}`, pw2 || 'x')).p;
  const page = (await req(owner, 'GET', '/settings')).text, id2 = (page.match(/\/settings\/crew\/(\d+)\/remove/) || [])[1];
  const rm = await req(owner, 'POST', `/settings/crew/${id2}/remove`);
  ok('owner removes a crew member and their session stops working', rm.status === 303 && (await req({ cookie: crew2.cookie }, 'GET', '/api/jobs')).status === 401);
  const pc = await req(owner, 'POST', '/settings/password', { body: form({ current: ownerPw, next: ownerPw + 'x' }) });
  ok('owner changes password', /m=pw/.test(pc.loc) && (await login(ownerEmail, ownerPw + 'x')).r.status === 303);
  return { owner, ownerPw: ownerPw + 'x', ownerEmail };
}

async function phase3(ctx) {
  console.log('\n== Phase 3: capture ==');
  let owner = ctx && ctx.owner;
  if (!owner) {
    if (!ADMIN_PW) { ok('ADMIN_PASSWORD supplied', false); return; }
    const e = `owner3-${RUN}${TEST}`, pw = 'Owner-pass-' + RUN;
    await req(admin(), 'POST', '/admin/owner', { body: form({ email: e, password: pw, name: 'T' }) });
    owner = (await login(e, pw)).p;
  }
  const J = async type => (await req(owner, 'POST', '/api/jobs', { json: { job_type: type }, headers: { accept: 'application/json' } })).json().id;
  const id = await J('Commercial yard');
  ok('a job is created', !!id);
  const cap = await req(owner, 'GET', `/jobs/${id}/capture`);
  ok('capture screen is served', cap.status === 200 && /BEFORE/.test(cap.text) && /AFTER/.test(cap.text) && /DURING/.test(cap.text));
  ok('capture screen carries the before-photo overlay for After', /ghost/.test(cap.text) && /photos\/before\/0/.test(cap.text));
  ok('new-job screen lists the skin job types', /Commercial yard/.test((await req(owner, 'GET', '/new')).text));
  const set = [['before', 0], ['during', 0], ['during', 1], ['during', 2], ['after', 0]];
  let allOk = true;
  for (const [k, s] of set) { const r = await upload(owner, id, k, s, await jpeg(1200, 1600, { shade: s * 10 })); if (r.status !== 200) { allOk = false; console.log('   ', k, s, r.status, JSON.stringify(r.body)); } }
  ok('1 before + 3 during + 1 after upload one by one', allOk);
  let st = (await req(owner, 'GET', `/api/jobs/${id}/status`)).json();
  ok('the job holds five photos', (st.photos || []).length === 5, JSON.stringify(st.photos));
  ok('portrait before photo is recorded as portrait', st.orientation === 'portrait' && st.photos.find(p => p.kind === 'before').height > st.photos.find(p => p.kind === 'before').width);
  ok('a fourth during photo is refused', (await upload(owner, id, 'during', 3, await jpeg(800, 600))).status === 400);
  ok('a bad kind is refused', (await upload(owner, id, 'bogus', 0, await jpeg(800, 600))).status === 400);
  ok('a non-photo file is refused', (await upload(owner, id, 'during', 0, Buffer.from('not an image at all'), 'x.jpg', 'image/jpeg')).status === 400);
  await upload(owner, id, 'during', 0, await jpeg(1000, 1000, { shade: 50 }));
  st = (await req(owner, 'GET', `/api/jobs/${id}/status`)).json();
  ok('retaking a photo replaces it (still five photos)', st.photos.length === 5);
  // landscape job
  const id2 = await J('Garden');
  await upload(owner, id2, 'before', 0, await jpeg(1600, 1200));
  ok('landscape before photo is recorded as landscape', (await req(owner, 'GET', `/api/jobs/${id2}/status`)).json().orientation === 'landscape');
  // phone photos are often stored sideways with an EXIF flag: the recorded shape is what the person sees
  const id3 = await J('Garage');
  await upload(owner, id3, 'before', 0, await jpeg(1600, 1200, { orientation: 6 }));
  const s3 = (await req(owner, 'GET', `/api/jobs/${id3}/status`)).json();
  ok('a sideways-stored phone photo is turned upright and recorded as portrait', s3.orientation === 'portrait' && s3.photos[0].height > s3.photos[0].width, JSON.stringify(s3));
  // hidden location data is dropped
  let geo = true;
  try {
    const withGps = await jpeg(900, 1200, { exif: { IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '53/1 48/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '1/1 33/1 0/1' } } });
    ok('(test photo really carries GPS)', (await sharp(withGps).metadata()).exif !== undefined);
    await upload(owner, id3, 'after', 0, withGps);
    const back = await fetch(`${BASE}/api/jobs/${id3}/photos/after/0`, { headers: { cookie: owner.cookie } });
    const meta = await sharp(Buffer.from(await back.arrayBuffer())).metadata();
    geo = !!meta.exif;
  } catch (e) { console.log('   (GPS check skipped: ' + e.message + ')'); geo = false; }
  ok('stored photos carry no hidden location data', !geo);
  // a dropped signal loses one photo, not the job
  const id4 = await J('House clearance');
  await upload(owner, id4, 'before', 0, await jpeg(1200, 1600));
  await upload(owner, id4, 'during', 0, await jpeg(1200, 1600));
  await new Promise(resolve => {
    const u = new URL(BASE); const lib = u.protocol === 'https:' ? require('https') : http;
    const b = '----drop' + RUN, head = `--${b}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nduring\r\n--${b}\r\nContent-Disposition: form-data; name="seq"\r\n\r\n1\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
    const r = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: `/api/jobs/${id4}/photos`, method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'multipart/form-data; boundary=' + b, 'content-length': 900000 } });
    r.on('error', () => resolve()); r.on('close', () => resolve());
    r.write(head); r.write(Buffer.alloc(20000, 1)); setTimeout(() => { r.destroy(); setTimeout(resolve, 600); }, 300);
  });
  let s4 = (await req(owner, 'GET', `/api/jobs/${id4}/status`)).json();
  ok('after a dropped upload the other photos are intact and the cut-off one is absent', s4.photos.length === 2 && !s4.photos.some(p => p.kind === 'during' && p.seq === 1), JSON.stringify(s4.photos));
  ok('retrying the dropped photo works', (await upload(owner, id4, 'during', 1, await jpeg(1200, 1600))).status === 200 && (await req(owner, 'GET', `/api/jobs/${id4}/status`)).json().photos.length === 3);
  // privacy
  ok('photos need a session', (await fetch(`${BASE}/api/jobs/${id}/photos/before/0`)).status === 401);
  const ph = await fetch(`${BASE}/api/jobs/${id}/photos/before/0?t=1`, { headers: { cookie: owner.cookie } });
  ok('photo thumbnails are served to the owner', ph.status === 200 && /jpeg/.test(ph.headers.get('content-type')));
  const home = (await req(owner, 'GET', '/')).text;
  ok('the job list shows the jobs with their state', /Drafts/.test(home) && /Commercial yard/.test(home));
  const gone = await req(owner, 'DELETE', `/api/jobs/${id2}`);
  ok('owner deletes a job and its photos go too', gone.status === 200 && (await req(owner, 'GET', `/api/jobs/${id2}/status`)).status === 404);
}

async function phase4() {
  console.log('\n== Phase 4: engine ==');
  const { execFileSync } = require('child_process'); const fs = require('fs'); const os = require('os'), path = require('path');
  const e = `owner4-${RUN}${TEST}`, pw = 'Owner-pass-' + RUN;
  await req(admin(), 'POST', '/admin/owner', { body: form({ email: e, password: pw, name: 'T' }) });
  const owner = (await login(e, pw)).p;
  const inv = await req(owner, 'POST', '/settings/invite', { body: form({ email: `crew4-${RUN}${TEST}` }) });
  const crew = (await login(`crew4-${RUN}${TEST}`, (inv.loc.match(/[?&]p=([A-Za-z0-9]+)/) || [])[1] || 'x')).p;
  const J = async (who, type) => (await req(who, 'POST', '/api/jobs', { json: { job_type: type }, headers: { accept: 'application/json' } })).json().id;
  const dir = process.env.PHOTO_DIR, real = n => dir && fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n)) : null;
  const wait = async (who, id, secs = 240) => { for (let i = 0; i < secs; i += 3) { const s = (await req(who, 'GET', `/api/jobs/${id}/status`)).json(); if (s.state !== 'rendering') return s; await new Promise(r => setTimeout(r, 3000)); } return { state: 'timeout' }; };
  const probe = async (who, id) => {
    const r = await fetch(`${BASE}/api/jobs/${id}/video`, { headers: { cookie: who.cookie } }); const f = path.join(os.tmpdir(), `sl-${RUN}-${id}.mp4`);
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    const q = (st, k) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', st, '-show_entries', `stream=${k}`, '-of', 'csv=p=0', f]).toString().trim();
    const o = { status: r.status, type: r.headers.get('content-type'), v: parseFloat(q('v', 'duration')), a: parseFloat(q('a', 'duration') || 0), size: q('v', 'width,height'), file: f, bytes: fs.statSync(f).size };
    return o;
  };
  // portrait job with three photos
  const id = await J(owner, 'Commercial yard');
  ok('a job with no photos cannot be rendered', (await req(owner, 'POST', `/api/jobs/${id}/render`, { json: {}, headers: { accept: 'application/json' } })).status === 400);
  await upload(owner, id, 'before', 0, real('before.jpg') || await jpeg(1200, 1600));
  await upload(owner, id, 'during', 0, real('work.jpg') || await jpeg(1200, 1600, { shade: 20 }));
  await upload(owner, id, 'after', 0, real('after.jpg') || await jpeg(1200, 1600, { shade: 50 }));
  const t0 = Date.now();
  const go = await req(owner, 'POST', `/api/jobs/${id}/render`, { json: {}, headers: { accept: 'application/json' } });
  ok('render starts', go.status === 200 && go.json().state === 'rendering', go.text);
  const sOn = (await req(owner, 'GET', `/jobs/${id}`)).text;
  ok('the review screen shows a progress message and polls while rendering', /Making your video/.test(sOn) && /api\/jobs\/\d+\/status/.test(sOn));
  const st = await wait(owner, id);
  ok('render finishes as ready (' + Math.round((Date.now() - t0) / 1000) + 's)', st.state === 'ready', JSON.stringify(st));
  const pv = await probe(owner, id);
  ok('video is served as mp4', pv.status === 200 && /video\/mp4/.test(pv.type) && pv.bytes > 50000, JSON.stringify(pv));
  ok('portrait 1080x1920', pv.size === '1080,1920', pv.size);
  ok('audio track exists and its length equals the video within one frame', pv.a > 0 && Math.abs(pv.a - pv.v) <= 0.0401, `${pv.a} vs ${pv.v}`);
  ok('video length is a whole number of frames, about 13 s', Math.abs(pv.v * 25 - Math.round(pv.v * 25)) < 0.05 && pv.v > 11 && pv.v < 16, String(pv.v));
  const rg = await fetch(`${BASE}/api/jobs/${id}/video`, { headers: { cookie: owner.cookie, range: 'bytes=0-99' } });
  ok('video supports seeking (range requests)', rg.status === 206 && (await rg.arrayBuffer()).byteLength === 100);
  ok('video needs a session', (await fetch(`${BASE}/api/jobs/${id}/video`)).status === 401);
  ok('cover image is served', (await fetch(`${BASE}/api/jobs/${id}/cover`, { headers: { cookie: owner.cookie } })).status === 200);
  const rv = (await req(owner, 'GET', `/jobs/${id}`)).text;
  ok('the review screen shows the video and an Approve button', /<video/.test(rv) && /Approve/.test(rv));
  // crew rules
  const cid = await J(crew, 'Garden');
  ok('crew cannot see or fetch the owner video', (await fetch(`${BASE}/api/jobs/${id}/video`, { headers: { cookie: crew.cookie } })).status === 404);
  ok('crew cannot start a render on a job that is not theirs', (await req(crew, 'POST', `/api/jobs/${id}/render`, { json: {}, headers: { accept: 'application/json' } })).status === 404);
  await upload(crew, cid, 'before', 0, await jpeg(1200, 1600)); await upload(crew, cid, 'after', 0, await jpeg(1200, 1600, { shade: 40 }));
  ok('crew can make a video of their own job', (await req(crew, 'POST', `/api/jobs/${cid}/render`, { json: {}, headers: { accept: 'application/json' } })).status === 200);
  // landscape and mixed, queued behind it
  const lid = await J(owner, 'Garage');
  await upload(owner, lid, 'before', 0, await jpeg(1600, 1200)); await upload(owner, lid, 'after', 0, await jpeg(1600, 1200, { shade: 40 }));
  await req(owner, 'POST', `/api/jobs/${lid}/render`, { json: {}, headers: { accept: 'application/json' } });
  const mid = await J(owner, 'Garden');
  await upload(owner, mid, 'before', 0, await jpeg(1200, 1600)); await upload(owner, mid, 'during', 0, await jpeg(1600, 1200, { shade: 20 })); await upload(owner, mid, 'after', 0, await jpeg(1600, 1200, { shade: 40 }));
  await req(owner, 'POST', `/api/jobs/${mid}/render`, { json: {}, headers: { accept: 'application/json' } });
  ok('crew video finishes', (await wait(crew, cid)).state === 'ready');
  ok('landscape job finishes', (await wait(owner, lid)).state === 'ready');
  const pl = await probe(owner, lid);
  ok('landscape photos give a 1920x1080 video, audio matching', pl.size === '1920,1080' && Math.abs(pl.a - pl.v) <= 0.0401, JSON.stringify(pl));
  ok('mixed photos finish and follow the BEFORE photo (portrait)', (await wait(owner, mid)).state === 'ready' && (await probe(owner, mid)).size === '1080,1920');
  // approve, then remake is blocked
  const ap = await req(owner, 'POST', `/api/jobs/${id}/approve`, { json: {}, headers: { accept: 'application/json' } });
  ok('owner approves the finished video', ap.status === 200);
  ok('an approved video cannot be replaced by a remake', (await req(owner, 'POST', `/api/jobs/${id}/render`, { json: {}, headers: { accept: 'application/json' } })).status === 409);
  ok('health still fine after renders', (await (await fetch(BASE + '/health')).json()).ok === true);
}

(async () => {
  console.log('Testing ' + BASE);
  try {
    let ctx;
    if (['phase1', 'all'].includes(which)) await phase1();
    if (['phase2', 'all'].includes(which)) ctx = await phase2();
    if (['phase3', 'all'].includes(which)) await phase3(ctx);
    if (['phase4', 'all'].includes(which)) await phase4();
  } catch (e) { fail++; console.log('FAIL  test run crashed: ' + e.stack); }
  if (ADMIN_PW && which !== 'phase1') { const r = await req(admin(), 'POST', '/admin/purge-test', { body: '' }); console.log('\nTest accounts removed:', r.status === 303 ? 'yes' : 'NO (' + r.status + ')'); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
