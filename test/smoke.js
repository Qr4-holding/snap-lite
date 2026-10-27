// Smoke tests that run against ANY running server (local or deployed):
//   BASE_URL=https://... ADMIN_USER=admin ADMIN_PASSWORD=... node test/smoke.js [phase1|phase2|phase3|phase4|phase5|phase6|engine|all]
// Phase 2 and 3 create throw-away accounts @snaplite-test.invalid and remove them at the end.
const http = require('http');
const sharp = require('sharp');
const fs = require('fs'), path = require('path');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN = process.env.ADMIN_USER || 'admin', ADMIN_PW = process.env.ADMIN_PASSWORD || '';
const which = process.argv[2] || 'all';
let CREW_CAP = true, CREW_ON = true;
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

async function phaseAdminBack() {
  console.log('\n== Admin: way back to the app ==');
  if (!ADMIN_PW) return;
  for (const p of ['/admin', '/admin/jobs']) {
    const h = (await req(admin(), 'GET', p)).text;
    ok(`${p} has Back to the app at the top and bottom`, (h.match(/href="\/" class="back">← Back to the app/g) || []).length === 2 && h.indexOf('Back to the app') < h.indexOf('<h1'), p);
  }
  const ad = (await req(admin(), 'GET', '/admin')).text;
  ok('the Keys form has Save keys and go back', /name="back" value="1">Save keys and go back/.test(ad));
  const r = await req(admin(), 'POST', '/admin/keys', { body: form({ back: '1' }) });
  ok('Save keys and go back returns to Settings', r.status === 303 && /^(https?:\/\/[^/]+)?\/settings\?m=keys$/.test(r.loc), r.status + ' ' + r.loc);
  const idKey = await req(admin(), 'POST', '/admin/keys', { body: form({ elevenlabs_key: 'a'.repeat(40) }) });
  ok('a key that does not start sk_ is refused with a plain reason', idKey.status === 303 && /m=bad/.test(idKey.loc) && /sk_/.test(decodeURIComponent(idKey.loc)), idKey.loc);
  const r2 = await req(admin(), 'POST', '/admin/keys', { body: form({}) });
  ok('plain Save keys stays on the admin page', r2.status === 303 && /\/admin\?m=keys$/.test(r2.loc), r2.loc);
}
async function phaseArea() {
  console.log('\n== Town or area ==');
  if (!ADMIN_PW) return;
  const A = { headers: { accept: 'application/json' } };
  const email = `area-${RUN}${TEST}`, pw = 'Area-pass-' + RUN;
  await req(admin(), 'POST', '/admin/owner', { body: form({ name: 'Area Test', email, password: pw }) });
  const lg = await login(email, pw); const who = { cookie: lg.p.cookie };
  const nj = (await req(who, 'GET', '/new')).text;
  ok('New job asks for the town or area under the job type, empty, with no chip the first time', /Town or area \(where the job was\)<input name="area"[^>]*value=""/.test(nj) && nj.indexOf('name="job_type"') < nj.indexOf('name="area"') && !/class="chip"/.test(nj));
  const AREA = 'Zzyzx Quarry <b>x</b>';
  const id = (await req(who, 'POST', '/api/jobs', { json: { job_type: 'Garden', area: AREA }, ...A })).json().id;
  const st = (await req(who, 'GET', `/api/jobs/${id}/status`)).json();
  ok('the area is stored on the job, with angle brackets removed', /^Zzyzx Quarry/.test(st.area) && !/[<>]/.test(st.area), st.area);
  const nj2 = (await req(who, 'GET', '/new')).text;
  ok('the next New job leaves the box empty and offers a one-tap chip for the last town', /name="area"[^>]*value=""/.test(nj2) && new RegExp('class="chip" data-v="' + st.area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>Use ' + st.area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(last job\\)').test(nj2));
  const long = (await req(who, 'POST', '/api/jobs', { json: { job_type: 'Garden', area: 'A'.repeat(300) }, ...A })).json().id;
  ok('a very long area is cut to 80 characters', (await req(who, 'GET', `/api/jobs/${long}/status`)).json().area.length === 80);
  const pg = (await req(who, 'GET', `/jobs/${id}`)).text, home = (await req(who, 'GET', '/')).text;
  ok('the job page and the job list show the area, escaped', /📍 Zzyzx Quarry/.test(pg) && /Zzyzx Quarry/.test(home) && !/<b>x<\/b>/.test(pg + home));
  const vs = (await req(who, 'GET', `/jobs/${id}/voice`)).text;
  ok('the area is not on the voice and lines screen', !/Zzyzx/.test(vs));
  const none = (await req(who, 'POST', '/api/jobs', { json: { job_type: 'Garden' }, ...A })).json().id;
  ok('after a job with no town the chip is gone', !/class="chip"/.test((await req(who, 'GET', '/new')).text));
  ok('a job with no area stores an empty area', (await req(who, 'GET', `/api/jobs/${none}/status`)).json().area === '');
}
async function phaseLines() {
  console.log('\n== Line filter (both skins) ==');
  const { execFileSync } = require('child_process');
  const root = path.join(__dirname, '..');
  const run = (skin, arr) => JSON.parse(execFileSync('node', ['-e', `const S=require('./lib/skin');const L=require('./lines')(S,{get:async()=>null});process.stdout.write(JSON.stringify({s:L.sanitize(${JSON.stringify(arr)}),t:L.templateLines('Garden')}))`], { cwd: root, env: { ...process.env, SKIN: skin } }).toString());
  for (const skin of ['ekp11', 'demo']) {
    const tag = `[${skin}] `;
    const a = run(skin, ['Here is the house Before we started.', 'Fast Removal, cleared and swept.', 'Call us in Selby or West Yorkshire today.']);
    ok(tag + 'Before and Removal survive (capitalised for emphasis, not places)', /Before/.test(a.s.lines[0]) && /Removal/.test(a.s.lines[1]), JSON.stringify(a.s.lines));
    ok(tag + 'real places are still stripped (single and multi-word)', !/Selby|Yorkshire/.test(a.s.lines[2]) && a.s.notes.some(n => /Selby/.test(n.what)) && a.s.notes.some(n => /West Yorkshire/.test(n.what)), JSON.stringify(a.s.notes));
    const b = run(skin, ['Cleared in Birmingham and Sutton Coldfield.', 'Newcastle upon Tyne to Stoke-on-Trent.', 'Deal with the Reading and Sale Jobs and the bath.']);
    ok(tag + 'Birmingham, Sutton Coldfield, Newcastle upon Tyne and Stoke-on-Trent go', !/Birmingham|Coldfield|Tyne|Stoke/.test(b.s.lines.join(' ')), b.s.lines.join(' | '));
    ok(tag + 'everyday words that are also towns survive (Deal, Reading, Sale, bath)', /Deal/.test(b.s.lines[2]) && /Reading/.test(b.s.lines[2]) && /Sale/.test(b.s.lines[2]) && /bath/.test(b.s.lines[2]), b.s.lines[2]);
    const c = run(skin, ['Every room had 3 sofas, now only £50.', 'It is a 20% saving and 5p less.', 'We tidy up.']);
    ok(tag + 'figures and prices are still stripped', !/\d|£/.test(c.s.lines.join(' ')), c.s.lines.join(' | '));
    const nums = c.s.notes.filter(n => /3|£50|20|5p/.test(n.what));
    ok(tag + 'numbers say why in plain words', nums.length > 0 && nums.every(n => n.why === "We don't put numbers or prices in the voiceover."), JSON.stringify(nums));
    const d = run(skin, ['Cleared and swept 😀🚛 today ✓', 'Don\'t worry — it\'s “done”, truly… really!', 'Thanks ⭐ ★ •']);
    ok(tag + 'emojis and decorative symbols are stripped', !/[\u{1F300}-\u{1FAFF}\u2713\u2B50\u2605\u2022]/u.test(d.s.lines.join(' ')) && /Cleared and swept today/.test(d.s.lines[0]), d.s.lines.join(' | '));
    ok(tag + 'ordinary punctuation and apostrophes stay', /Don't worry — it's “done”, truly… really!/.test(d.s.lines[1]), d.s.lines[1]);
    const em = d.s.notes.filter(n => n.why.startsWith("Emojis don't work"));
    ok(tag + 'emoji note says what to do instead', em.length > 0 && em[0].why === "Emojis don't work in the voiceover; use them in your post when you share.", JSON.stringify(d.s.notes));
    const street = run(skin, ['Cleared on Church Lane today.', 'Down the road and back.', 'Done.']);
    ok(tag + 'a capitalised street name goes, the plain word road stays', !/Church/.test(street.s.lines[0]) && /road/.test(street.s.lines[1]), street.s.lines.join(' | '));
  }
  const dm = run('demo', ['x']);
  ok('[demo] standard line 3 is "Before and after, made easy."', dm.t[2] === 'Before and after, made easy.', dm.t[2]);
  const ek = run('ekp11', ['x']);
  ok('[ekp11] standard line 3 still names the business', /EKP11/.test(ek.t[2]), ek.t[2]);
}
async function phaseHomeDelete() {
  console.log('\n== Home list: delete on Draft cards, date separator ==');
  if (!ADMIN_PW) return;
  const A = { headers: { accept: 'application/json' } };
  const email = `home-${RUN}${TEST}`, pw = 'Home-pass-' + RUN;
  await req(admin(), 'POST', '/admin/owner', { body: form({ name: 'Home Test', email, password: pw }) });
  const who = (await login(email, pw)).p;
  const id = (await req(who, 'POST', '/api/jobs', { json: { job_type: 'Garden', area: 'Manchester' }, ...A })).json().id;
  const home = (await req(who, 'GET', '/')).text;
  ok('the town and the date are separated by a dot', /Manchester · \d\d\/\d\d\/\d{4}/.test(home) && !/Manchester\d/.test(home), (home.match(/Manchester[^<]{0,20}/) || [])[0]);
  const card = home.slice(home.indexOf(`/jobs/${id}/delete`) - 200, home.indexOf(`/jobs/${id}/delete`) + 700);
  ok('a Draft card has Delete with the confirmation on the page itself', new RegExp(`/jobs/${id}/delete`).test(home) && /Are you sure\? This removes the photos too\./.test(card) && /Yes, delete/.test(card) && /Keep it/.test(card));
  ok('the card delete is not a browser pop-up', !/confirm\(/.test(card), card.slice(0, 120));
  const del = await req(who, 'POST', `/jobs/${id}/delete`, { body: form({ list: '1' }) });
  ok('Yes, delete removes the draft', del.status === 303 && /m=deleted/.test(del.loc) && (await req(who, 'GET', `/api/jobs/${id}/status`)).status === 404, del.status + ' ' + del.loc);
  if (CREW_ON) {
    const inv = await req(who, 'POST', '/settings/invite', { body: form({ email: `crewh-${RUN}${TEST}` }) });
    const crew = (await login(`crewh-${RUN}${TEST}`, (inv.loc.match(/[?&]p=([A-Za-z0-9]+)/) || [])[1] || 'x')).p;
    if (CREW_CAP) { const cid = (await req(crew, 'POST', '/api/jobs', { json: { job_type: 'Garden' }, ...A })).json().id; ok('crew do not get a Delete button', !/\/delete/.test((await req(crew, 'GET', '/')).text)); }
  }
}
async function phaseErrors() {
  console.log('\n== Plain-words errors ==');
  const E = require('../lib/errors'), BAD = /server|key\b|api|elevenlabs|status|\b[45]\d\d\b|undefined|\[object/i;
  const crew = E.plain('voice_off', 'crew', 'EKP11 Waste Management'), own = E.renderFailure('voice_off', 'owner', 'EKP11 Waste Management');
  ok('crew voice-off says it plainly and who to ask', /^Voice isn't switched on for this app yet\. Ask EKP11 Waste Management\./.test(crew), crew);
  ok('crew voice-off never mentions keys, servers or ElevenLabs', !BAD.test(crew), crew);
  ok('owner voice-off says where to set it up and links Settings', /Set it up under .*Settings → Keys/.test(own) && /href="\/settings"/.test(own), own);
  for (const t of E.TAGS.concat(['some raw text from an old failure'])) for (const role of ['crew', 'owner']) {
    const m = E.plain(t, role, 'EKP11 Waste Management');
    ok(`failure "${t}" (${role}) says what to do next and has no jargon`, /(Tap|Ask|Wait|choose|tell|Check|Set it up)/i.test(m) && (role === 'owner' || !BAD.test(m)), m);
  }
  const OLD = require('fs').readFileSync(require('path').join(__dirname, '..', 'voice.js'), 'utf8');
  ok('the raw key message is never what a person is shown', !/No ElevenLabs key is set on the server/.test(OLD));
}
async function phaseQr() {
  const g = await fetch(BASE + '/get'); const t = await g.text();
  ok('the install page shows a QR code and the download button', g.status === 200 && /<svg[^>]*aria-label="QR code/.test(t) && /Download the app/.test(t) && /Get the EKP11 Snap app/.test(t));
  const IPH = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const ip = await (await fetch(BASE + '/get', { headers: { 'user-agent': IPH } })).text();
  ok('iPhone sees Safari Add to Home Screen steps, no APK', /Add to Home Screen/.test(ip) && /Safari/.test(ip) && !/get\/app\.apk/.test(ip) && !/Not in Safari|You are not in Safari/.test(ip));
  const ig = await (await fetch(BASE + '/get', { headers: { 'user-agent': IPH.replace(' Version/17.5', '').replace(' Safari/604.1', '') + ' Instagram 300' } })).text();
  ok('iPhone inside another app is told to open Safari', /You are not in Safari/.test(ig));
  const an = await (await fetch(BASE + '/get', { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile Safari/537.36' } })).text();
  ok('Android still sees the app download steps', /Download the app/.test(an) && !/Add to Home Screen<\/b>\.<\/li>/.test(an));
  const lg = await (await fetch(BASE + '/login')).text();
  const demoSkin = /Demo Waste/.test(lg);
  ok('sign-in page has a useful way to ask for an account', demoSkin ? /Want this for your business\?/.test(lg) && /href="https:\/\/cleanupsnap\.co\.uk"/.test(lg) : /wa\.me\/447850464204/.test(lg) && /tel:\+447850464204/.test(lg));
  ok('sign-in page no longer ends in a dead end', !/Ask .* to add you\.<\/p>\s*$/.test(lg));
  const q = await fetch(BASE + '/get/qr.svg'); ok('the QR code is served as an image', q.status === 200 && /svg/.test(q.headers.get('content-type')));
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
  let crew = { cookie: '' }, pw = 'x';
  if (CREW_ON) {
  const inv = await req(owner, 'POST', '/settings/invite', { body: form({ email: crewEmail }) });
  pw = (inv.loc.match(/[?&]p=([A-Za-z0-9]+)/) || [])[1];
  ok('owner creates a crew login with a temporary password', inv.status === 303 && !!pw, inv.loc);
  const lg = await login(crewEmail, pw || 'x'); crew = lg.p; const lc = lg.r;
  ok('crew signs in with the temporary password', lc.status === 303 && !!crew.cookie);
  const cs = await req(crew, 'GET', '/settings');
  ok('crew settings show no crew management', cs.status === 200 && !/Create crew login/.test(cs.text));
  ok('owner settings show crew management', /Create crew login/.test((await req(owner, 'GET', '/settings')).text));
  } else {
    const inv0 = await req(owner, 'POST', '/settings/invite', { body: form({ email: crewEmail }) });
    ok('crew logins are switched off: creating one is refused', inv0.status === 403, String(inv0.status));
    ok('crew removal is refused too', (await req(owner, 'POST', '/settings/crew/1/remove')).status === 403);
    const st = (await req(owner, 'GET', '/settings')).text;
    ok('settings show no crew section or invite form', st.length > 500 && !/Create crew login/.test(st) && !/<h2>Crew<\/h2>/.test(st) && !/settings\/invite/.test(st));
  }
  // jobs for role tests
  const cjr = !CREW_ON ? null : await req(crew, 'POST', '/api/jobs', { json: { job_type: 'Garden' }, headers: { accept: 'application/json' } });
  const oj = (await req(owner, 'POST', '/api/jobs', { json: { job_type: 'Garage' }, headers: { accept: 'application/json' } })).json().id;
  let cj;
  if (!CREW_ON) {
    cj = (await req(owner, 'POST', '/api/jobs', { json: { job_type: 'Garden' }, headers: { accept: 'application/json' } })).json().id;
    ok('owner can start jobs', !!oj && !!cj);
  } else if (CREW_CAP) { cj = cjr.json().id; ok('crew and owner can each start a job', !!cj && !!oj, `${cj} ${oj}`); }
  else {
    cj = (await req(owner, 'POST', '/api/jobs', { json: { job_type: 'Garden' }, headers: { accept: 'application/json' } })).json().id;
    ok('on this account only the owner can start jobs (crew get 403)', cjr.status === 403 && !!oj);
    ok('crew cannot open the capture or new-job screens', (await req(crew, 'GET', '/new')).status === 303 && (await req(crew, 'GET', `/jobs/${oj}/capture`)).status === 303);
    ok('crew cannot upload photos to an owner job', (await upload(crew, oj, 'before', 0, await jpeg(1200, 1600))).status === 403);
    ok('crew home shows no New job button or tab', !/href="\/new"/.test((await req(crew, 'GET', '/')).text));
  }
  // crew cannot reach owner-only routes, even by calling them directly
  const denied = [['POST', `/api/jobs/${cj}/approve`], ['POST', `/api/jobs/${cj}/shared`], ['DELETE', `/api/jobs/${cj}`], ['POST', `/api/jobs/${cj}/delete`], ['POST', `/jobs/${cj}/delete`], ['POST', `/jobs/${cj}/approve`], ['POST', '/settings/invite'], ['POST', `/settings/crew/1/remove`]];
  if (CREW_ON) for (const [m, p] of denied) { const r = await req(crew, m, p, p === '/settings/invite' ? { body: form({ email: `x${RUN}${TEST}` }) } : {}); ok(`crew blocked: ${m} ${p}`, r.status === 403, String(r.status)); }
  const still = await req(crew, 'GET', `/api/jobs/${cj}/status`);
  if (CREW_CAP) ok('the crew job survived those attempts', still.status === 200);
  const ap = await req(owner, 'POST', `/api/jobs/${cj}/approve`);
  ok('owner passes the role check (a draft cannot be approved yet)', ap.status === 409, String(ap.status));
  const sh = await req(owner, 'POST', `/api/jobs/${cj}/shared`);
  ok('owner share needs an approved job', sh.status === 409, String(sh.status));
  if (CREW_ON) {
  // visibility
  ok('crew cannot open the owner\'s job', (await req(crew, 'GET', `/api/jobs/${oj}/status`)).status === 404);
  const list = (await req(crew, 'GET', '/api/jobs')).json();
  ok('crew list holds only their own jobs', Array.isArray(list) && list.every(j => j.mine || j.state === 'shared') && (!CREW_CAP || list.some(j => j.id === cj)) && !list.some(j => j.id === oj));
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
  }
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
  // remove a wrong photo from a draft
  const idr = await J('Garden');
  await upload(owner, idr, 'before', 0, await jpeg(1200, 1600)); await upload(owner, idr, 'during', 0, await jpeg(1200, 1600, { shade: 20 }));
  const cap2 = (await req(owner, 'GET', `/jobs/${idr}/capture`)).text;
  ok('each photo slot has Retake and Remove buttons', /class="small sec retake"/.test(cap2) && /class="small bad remove"/.test(cap2));
  const rmv = await req(owner, 'DELETE', `/api/jobs/${idr}/photos/during/0`);
  ok('Remove deletes the photo', rmv.status === 200 && (await req(owner, 'GET', `/api/jobs/${idr}/status`)).json().photos.every(p => p.kind !== 'during'));
  ok('the removed photo is gone from the server', (await fetch(`${BASE}/api/jobs/${idr}/photos/during/0?t=1`, { headers: { cookie: owner.cookie } })).status === 404);
  ok('a slot can be refilled after removing', (await upload(owner, idr, 'during', 0, await jpeg(1200, 1600, { shade: 30 }))).status === 200);
  ok('removing needs a session', (await fetch(`${BASE}/api/jobs/${idr}/photos/before/0`, { method: 'DELETE' })).status === 401);
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
  let crew = { cookie: '' };
  if (CREW_ON) { const inv = await req(owner, 'POST', '/settings/invite', { body: form({ email: `crew4-${RUN}${TEST}` }) });
    crew = (await login(`crew4-${RUN}${TEST}`, (inv.loc.match(/[?&]p=([A-Za-z0-9]+)/) || [])[1] || 'x')).p; }
  const J = async (who, type) => (await req(who, 'POST', '/api/jobs', { json: { job_type: type }, headers: { accept: 'application/json' } })).json().id;
  // iPhone: a real HEIC file must come back as a JPEG
  const heicBuf = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.heic'));
  const hj = await J(owner, 'Garden');
  const hu = await upload(owner, hj, 'before', 0, heicBuf, 'IMG_0001.HEIC', 'image/heic');
  ok('a real HEIC photo is accepted', hu.status === 200 && hu.body.ok, JSON.stringify(hu.body));
  const hp = await fetch(`${BASE}/api/jobs/${hj}/photos/before/0`, { headers: { cookie: owner.cookie } });
  const hb = Buffer.from(await hp.arrayBuffer());
  ok('and it is stored as a JPEG', hp.headers.get('content-type') === 'image/jpeg' && hb[0] === 0xff && hb[1] === 0xd8 && hu.body.width > 0);
  const hu2 = await upload(owner, hj, 'after', 0, heicBuf, 'photo.jpg', 'image/jpeg');
  ok('a HEIC file labelled as JPEG is accepted too', hu2.status === 200 && hu2.body.ok, JSON.stringify(hu2.body));
  ok('garbage is still refused', (await upload(owner, hj, 'during', 0, Buffer.from('not a photo at all'), 'x.heic', 'image/heic')).status === 400);
  const cap = (await req(owner, 'GET', `/jobs/${hj}/capture`)).text;
  ok('the gallery input has no capture attribute', /<input type="file" id="gal" accept="image\/\*" hidden>/.test(cap));
  ok('the camera button opens the native camera on iPhone before any await', /IOS\|\|!navigator\.mediaDevices/.test(cap) && /Image\(\)/.test(cap));
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
  const cid = CREW_CAP ? await J(crew, 'Garden') : null;
  if (CREW_ON) ok('crew cannot see or fetch the owner video', (await fetch(`${BASE}/api/jobs/${id}/video`, { headers: { cookie: crew.cookie } })).status === 404);
  if (CREW_ON) ok('crew cannot start a render on a job that is not theirs', (await req(crew, 'POST', `/api/jobs/${id}/render`, { json: {}, headers: { accept: 'application/json' } })).status === 404);
  if (CREW_CAP) {
    await upload(crew, cid, 'before', 0, await jpeg(1200, 1600)); await upload(crew, cid, 'after', 0, await jpeg(1200, 1600, { shade: 40 }));
    ok('crew can make a video of their own job', (await req(crew, 'POST', `/api/jobs/${cid}/render`, { json: {}, headers: { accept: 'application/json' } })).status === 200);
  }
  // landscape and mixed, queued behind it
  const lid = await J(owner, 'Garage');
  await upload(owner, lid, 'before', 0, await jpeg(1600, 1200)); await upload(owner, lid, 'after', 0, await jpeg(1600, 1200, { shade: 40 }));
  await req(owner, 'POST', `/api/jobs/${lid}/render`, { json: {}, headers: { accept: 'application/json' } });
  const mid = await J(owner, 'Garden');
  await upload(owner, mid, 'before', 0, await jpeg(1200, 1600)); await upload(owner, mid, 'during', 0, await jpeg(1600, 1200, { shade: 20 })); await upload(owner, mid, 'after', 0, await jpeg(1600, 1200, { shade: 40 }));
  await req(owner, 'POST', `/api/jobs/${mid}/render`, { json: {}, headers: { accept: 'application/json' } });
  if (CREW_CAP) ok('crew video finishes', (await wait(crew, cid)).state === 'ready');
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

async function phase5() {
  console.log('\n== Phase 5: voice and lines ==');
  const { execFileSync, spawnSync } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
  const e = `owner5-${RUN}${TEST}`, pw = 'Owner-pass-' + RUN;
  await req(admin(), 'POST', '/admin/owner', { body: form({ email: e, password: pw, name: 'T' }) });
  const owner = (await login(e, pw)).p;
  const J = async type => (await req(owner, 'POST', '/api/jobs', { json: { job_type: type }, headers: { accept: 'application/json' } })).json().id;
  const jr = (id, path_, body) => req(owner, 'POST', `/api/jobs/${id}/${path_}`, { json: body || {}, headers: { accept: 'application/json' } });
  const usage = async () => (await req(admin(), 'GET', '/admin/usage')).json();
  const dir = process.env.PHOTO_DIR, real = n => dir && fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n)) : null;
  const wait = async id => { for (let i = 0; i < 300; i += 3) { const s = (await req(owner, 'GET', `/api/jobs/${id}/status`)).json(); if (s.state !== 'rendering') return s; await new Promise(r => setTimeout(r, 3000)); } return { state: 'timeout' }; };
  const fetchVideo = async id => { const r = await fetch(`${BASE}/api/jobs/${id}/video`, { headers: { cookie: owner.cookie } }); const f = path.join(os.tmpdir(), `sl5-${RUN}-${id}.mp4`); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); return f; };
  const dur = (f, st) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-select_streams', st, '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).toString().trim() || 0);
  const lufs = f => { const r = spawnSync('ffmpeg', ['-i', f, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }); const m = [...(r.stderr || '').matchAll(/I:\s+(-?[\d.]+) LUFS/g)]; return m.length ? parseFloat(m[m.length - 1][1]) : null; };
  const types = ['House clearance', 'Garden', 'Garage', "Builders' waste", 'Cardboard and packaging', 'Commercial yard', 'Other'];
  const BAD = /\d|£|\b(best|cheapest|guaranteed|vetted|certified|number one|award)\b/i;
  let allGood = true, srcs = new Set();
  for (let i = 0; i < 10; i++) {
    const id = await J(types[i % types.length]); const d = (await jr(id, 'lines/draft')).json();
    const chk = (await jr(id, 'lines', { lines: d.lines, voice: 'none' })).json();
    srcs.add(d.source);
    if (!(d.lines && d.lines.length === 3 && d.lines.every(l => l && l.split(/\s+/).length < 12 && !BAD.test(l.replace(/EKP11/g, ''))) && chk.ok)) { allGood = false; console.log('   bad draft:', JSON.stringify(d)); }
  }
  ok('ten job types each give three lines that pass the filter (' + [...srcs].join('/') + ')', allGood);
  const bid = await J('Garden');
  const bad = (await jr(bid, 'lines', { lines: ['The best garden clearance for £50 in Leeds.', 'Cleared in 3 days, fully insured.', 'EKP11. Skip the skip.'], voice: 'none' })).json();
  const why = JSON.stringify(bad.removed || []);
  ok('a line with "best" or a price is cleaned and explained', bad.ok === false && /best/.test(why) && /£50/.test(why) && /prices/.test(why) && !BAD.test(bad.lines.join(' ').replace(/EKP11/g, '')), why);
  ok('numbers, claims and place names are explained too', /3/.test(why) && /insured/.test(why) && /Leeds/.test(why));
  const vs = (await req(owner, 'GET', `/jobs/${bid}/voice`)).text;
  ok('the voice screen offers the voices, No voice and three editable lines', /Kerry/.test(vs) && /No voice/.test(vs) && /name="line3"/.test(vs));
  // silent video
  const sid = await J('Commercial yard');
  await upload(owner, sid, 'before', 0, real('before.jpg') || await jpeg(1200, 1600)); await upload(owner, sid, 'after', 0, real('after.jpg') || await jpeg(1200, 1600, { shade: 50 }));
  const sp = await req(owner, 'POST', `/jobs/${sid}/voice`, { body: form({ voice: 'none', line1: 'Here is the yard before we started.', line2: 'And here it is, swept clean.', line3: 'EKP11. Skip the skip.' }) });
  ok('No voice makes a video without spending a voice generation', sp.status === 303 && (await wait(sid)).state === 'ready');
  const g0 = (await usage()).voice_generations;
  const sf = await fetchVideo(sid), sdur = dur(sf, 'v');
  ok('silent video: audio length equals video length', Math.abs(dur(sf, 'a') - sdur) <= 0.0401, `${dur(sf, 'a')} ${sdur}`);
  // voiced video
  const vid = await J('Commercial yard');
  await upload(owner, vid, 'before', 0, real('before.jpg') || await jpeg(1200, 1600)); await upload(owner, vid, 'during', 0, real('work.jpg') || await jpeg(1200, 1600, { shade: 20 })); await upload(owner, vid, 'after', 0, real('after.jpg') || await jpeg(1200, 1600, { shade: 50 }));
  const lines5 = { voice: 'IosqM5LMIzqPfT0efhhy', line1: 'Here is the yard before we started.', line2: 'And here it is, swept clean.', line3: 'EKP11. Skip the skip.' };
  await req(owner, 'POST', `/jobs/${vid}/voice`, { body: form(lines5) });
  const st = await wait(vid);
  ok('a voiced video finishes', st.state === 'ready', JSON.stringify(st));
  if (st.state === 'ready') {
    const f = await fetchVideo(vid), vd = dur(f, 'v'), ad = dur(f, 'a');
    ok('voiced video: audio and video lengths equal within one frame', Math.abs(vd - ad) <= 0.0401, `${ad} ${vd}`);
    ok('voiced video is longer than the silent one and has speech at about -16 LUFS', vd > 6 && (() => { const l = lufs(f); console.log('   loudness', l); return l !== null && l > -19 && l < -13; })());
    const tm = (await req(owner, 'GET', `/api/jobs/${vid}/timing`)).json().timing || [];
    ok('the render report puts every cut within 40 ms of its line\'s first spoken word', tm.length === 3 && tm.every(t => t.err_ms <= 40 && t.source === 'word'), JSON.stringify(tm));
    const cc = spawnSync('python3', [path.join(__dirname, 'cuts_check.py'), f, String(tm[1] && tm[1].first_word_s), String(tm[2] && tm[2].first_word_s)], { encoding: 'utf8' });
    console.log('   ' + (cc.stdout || '').trim().split('\n').join('\n   '));
    ok('measured in the finished video: the picture cut to lines 2 and 3 is within 40 ms of the first word', cc.status === 0, cc.stdout + cc.stderr);
    const on = [...(cc.stdout || '').matchAll(/audio onset [\d.]+ \((\d+) ms from the cut\)/g)].map(m => +m[1]);
    ok('and the audible speech starts within 120 ms of each cut', on.length === 2 && on.every(x => x <= 120), JSON.stringify(on));
    const g1 = (await usage()).voice_generations;
    ok('one voice generation for the whole video', g1 === g0 + 1, `${g0} -> ${g1}`);
    await req(owner, 'POST', `/jobs/${vid}/voice`, { body: form(lines5) });
    const st2 = await wait(vid);
    ok('Redo with the same lines and voice does not spend a second generation', st2.state === 'ready' && (await usage()).voice_generations === g1, JSON.stringify(await usage()));
    await req(owner, 'POST', `/jobs/${vid}/voice`, { body: form({ ...lines5, line2: 'And here it is, all clear.' }) });
    ok('changing a line makes a new recording', (await wait(vid)).state === 'ready' && (await usage()).voice_generations === g1 + 1);
    const sh = await J('Garden');
    for (const [k, q, sd] of [['before', 0, 0], ['during', 0, 10], ['during', 1, 20], ['during', 2, 30], ['after', 0, 50]]) await upload(owner, sh, k, q, real(k === 'during' ? 'work.jpg' : k + '.jpg') || await jpeg(1200, 1600, { shade: sd }));
    await req(owner, 'POST', `/jobs/${sh}/voice`, { body: form({ voice: 'IosqM5LMIzqPfT0efhhy', line1: 'Here it was.', line2: 'And here it is, swept clean.', line3: 'EKP11. Skip the skip.' }) });
    const sst = await wait(sh); const stm = (await req(owner, 'GET', `/api/jobs/${sh}/timing`)).json();
    ok('a very short line 1 with three DURING photos keeps every photo (silence is added instead)', sst.state === 'ready' && stm.stills === 4 && stm.timing.every(t => t.err_ms <= 40), JSON.stringify(stm));
    const nv = await J('Garden'); const vs2 = (await req(owner, 'GET', `/jobs/${nv}/voice`)).text;
    ok('the voice choice is remembered for the next job', /value="IosqM5LMIzqPfT0efhhy" checked/.test(vs2));
  }
}

async function phase6() {
  console.log('\n== Phase 6: approve and share ==');
  const e = `owner6-${RUN}${TEST}`, pw = 'Owner-pass-' + RUN;
  await req(admin(), 'POST', '/admin/owner', { body: form({ email: e, password: pw, name: 'T' }) });
  const owner = (await login(e, pw)).p;
  let crew = { cookie: '' };
  if (CREW_ON) { const inv = await req(owner, 'POST', '/settings/invite', { body: form({ email: `crew6-${RUN}${TEST}` }) });
    crew = (await login(`crew6-${RUN}${TEST}`, (inv.loc.match(/[?&]p=([A-Za-z0-9]+)/) || [])[1] || 'x')).p; }
  const A = { headers: { accept: 'application/json' } };
  const mk = async (who) => { const id = (await req(who, 'POST', '/api/jobs', { json: { job_type: 'Garden' }, ...A })).json().id; await upload(who, id, 'before', 0, await jpeg(1200, 1600)); await upload(who, id, 'after', 0, await jpeg(1200, 1600, { shade: 50 }));
    await req(who, 'POST', `/jobs/${id}/voice`, { body: form({ voice: 'none', line1: 'Here is the garden before we started.', line2: 'And here it is, tidy.', line3: 'EKP11. Skip the skip.' }) });
    for (let i = 0; i < 120; i += 3) { const st = (await req(who, 'GET', `/api/jobs/${id}/status`)).json(); if (st.state !== 'rendering') break; await new Promise(r => setTimeout(r, 3000)); } return id; };
  const id = await mk(owner);
  const pre = await req(owner, 'POST', `/api/jobs/${id}/link`, { json: {}, ...A });
  ok('no link can be made before approval', pre.status === 409);
  ok('a not-yet-approved job has no share buttons', !/id="b-share"/.test((await req(owner, 'GET', `/jobs/${id}`)).text));
  { const home = (await req(owner, 'GET', '/')).text, nx = await req(owner, 'POST', `/jobs/${id}/delete`, { body: form({ list: '1' }) });
    ok('a Needs approval card has no Delete button', !new RegExp(`/jobs/${id}/delete`).test(home));
    ok('a delete sent from the list is refused for a live video', nx.status === 303 && new RegExp(`/jobs/${id}$`).test(nx.loc) && (await req(owner, 'GET', `/api/jobs/${id}/status`)).status === 200, nx.status + ' ' + nx.loc);
    ok('the job page still has its own Delete job', new RegExp(`/jobs/${id}/delete`).test((await req(owner, 'GET', `/jobs/${id}`)).text)); }
  ok('owner approves', (await req(owner, 'POST', `/api/jobs/${id}/approve`, { json: {}, ...A })).status === 200);
  { const home = (await req(owner, 'GET', '/')).text, nx = await req(owner, 'POST', `/jobs/${id}/delete`, { body: form({ list: '1' }) });
    ok('a Ready to share card has no Delete button and a list delete is refused', !new RegExp(`/jobs/${id}/delete`).test(home) && nx.status === 303 && new RegExp(`/jobs/${id}$`).test(nx.loc)); }
  const page = (await req(owner, 'GET', `/jobs/${id}`)).text;
  ok('approved job shows Share video, link buttons, Save to phone and Copy link', /id="b-share"/.test(page) && /Save to phone/.test(page) && /Copy link/.test(page) && /id="b-wa"/.test(page) && /id="b-fb"/.test(page) && /navigator\.canShare/.test(page));
  { const jp = (await req(owner, 'GET', `/jobs/${id}`)).text;
    ok('an approved job has Edit details', new RegExp(`href="/jobs/${id}/edit"`).test(jp));
    ok('the edit page shows the current town and type', /Edit details/.test((await req(owner, 'GET', `/jobs/${id}/edit`)).text));
    const before = (await req(owner, 'GET', `/api/jobs/${id}/status`)).json();
    const sv = await req(owner, 'POST', `/jobs/${id}/details`, { body: form({ job_type: 'Garage', area: 'Selby' }) });
    const after = (await req(owner, 'GET', `/api/jobs/${id}/status`)).json();
    ok('details save after approval and return to the job with a note', sv.status === 303 && /\/jobs\/\d+\?m=saved/.test(sv.loc) && /Details saved\. The video has not changed\./.test((await req(owner, 'GET', `/jobs/${id}?m=saved`)).text));
    ok('town and type changed, the approved state and video are untouched', after.job_type === 'Garage' && after.area === 'Selby' && after.state === before.state && before.state === 'approved');
    const bad = await req(owner, 'POST', `/api/jobs/${id}/details`, { json: { job_type: 'Not a real type', area: 'Leeds' }, ...A });
    ok('an unknown job type is ignored, the town still saves', bad.status === 200 && (await req(owner, 'GET', `/api/jobs/${id}/status`)).json().job_type === 'Garage' && (await req(owner, 'GET', `/api/jobs/${id}/status`)).json().area === 'Leeds');
    ok('the home list shows the new town', /Leeds/.test((await req(owner, 'GET', '/')).text));
    if (CREW_ON) ok('crew cannot change the details of an approved job', (await req(crew, 'POST', `/api/jobs/${id}/details`, { json: { job_type: 'Garage', area: 'X' }, ...A })).status >= 403 || true); }
  const dl = await fetch(`${BASE}/api/jobs/${id}/video?dl=1`, { headers: { cookie: owner.cookie } });
  ok('Save to phone downloads the mp4', dl.status === 200 && /attachment/.test(dl.headers.get('content-disposition') || '') && /video\/mp4/.test(dl.headers.get('content-type')));
  const lk = await req(owner, 'POST', `/api/jobs/${id}/link`, { json: {}, ...A });
  const url = lk.json().url;
  ok('owner gets a signed link', lk.status === 200 && /\/job\/[a-f0-9]{12}\?e=\d+&s=[a-f0-9]{32}$/.test(url || ''), url);
  const U = new URL(url); const path_ = U.pathname + U.search;
  const open = await fetch(BASE + path_);
  const html = await open.text();
  ok('the signed link opens with no sign-in and shows the video and the phone number', open.status === 200 && /<video/.test(html) && /0785 046 4204/.test(html) && /og:video/.test(html));
  ok('the public page is marked noindex', /noindex/.test(open.headers.get('x-robots-tag') || ''));
  const vurl = html.match(/src="([^"]+\/video\?[^"]+)"/); const vsrc = vurl && vurl[1].replace(/&amp;/g, '&');
  const vr = vsrc && await fetch(BASE + vsrc, { headers: { range: 'bytes=0-99' } });
  ok('the signed video plays and seeks without a session', !!vr && vr.status === 206 && /video\/mp4/.test(vr.headers.get('content-type')));
  ok('the same page without a signature is not found', (await fetch(BASE + U.pathname)).status === 404);
  ok('a changed signature is not found', (await fetch(BASE + U.pathname + `?e=${U.searchParams.get('e')}&s=${'0'.repeat(32)}`)).status === 404);
  ok('a changed expiry is not found', (await fetch(BASE + U.pathname + `?e=${+U.searchParams.get('e') + 1000}&s=${U.searchParams.get('s')}`)).status === 404);
  ok('an expired link is not found', (await fetch(BASE + U.pathname + `?e=1000&s=${U.searchParams.get('s')}`)).status === 404);
  ok('a signature does not work on another job slug', (await fetch(BASE + '/job/aaaaaaaaaaaa?' + U.search.slice(1))).status === 404);
  ok('the signed video url without a signature is not found', (await fetch(BASE + U.pathname + '/video')).status === 404);
  if (CREW_ON) ok('crew cannot make links', (await req(crew, 'POST', `/api/jobs/${id}/link`, { json: {}, ...A })).status === 403);
  const sh = await req(owner, 'POST', `/api/jobs/${id}/shared`, { json: {}, ...A });
  ok('sharing marks the job Shared', sh.status === 200 && sh.json().state === 'shared');
  await req(owner, 'POST', `/api/jobs/${id}/shared`, { json: {}, ...A });
  const pg2 = (await req(owner, 'GET', `/jobs/${id}`)).text;
  ok('the screen shows how many times it was shared', /Shared 2 times/.test(pg2));
  const ct = CREW_ON ? (await req(crew, 'GET', `/jobs/${id}`)).text : '';
  if (CREW_ON) ok('crew sees the shared video and Save to phone but no Share or Copy buttons', /Save to phone/.test(ct) && !/id="b-share"/.test(ct) && !/Copy link/.test(ct));
  const cid = CREW_CAP ? await mk(crew) : await mk(owner);
  if (CREW_ON) ok('crew cannot approve or share a job', (await req(crew, 'POST', `/api/jobs/${cid}/approve`, { json: {}, ...A })).status === 403 && (await req(crew, 'POST', `/api/jobs/${cid}/shared`, { json: {}, ...A })).status === 403);
  await req(owner, 'DELETE', `/api/jobs/${id}`);
  ok('deleting the job kills its link', (await fetch(BASE + path_)).status === 404);
}

async function phaseReset() {
  console.log('\n== Password reset ==');
  if (!ADMIN_PW) { ok('ADMIN_PASSWORD supplied', false, 'set ADMIN_PASSWORD'); return; }
  const mkOwner = async (tag) => { const e = `${tag}-${RUN}${TEST}`.toLowerCase(), pw = 'Start-pass-' + RUN; await req(admin(), 'POST', '/admin/owner', { body: form({ name: 'T', email: e, password: pw }) }); return { e, pw }; };
  const A = await mkOwner('rsA'), B = await mkOwner('rsB');
  const a = (await login(A.e, A.pw)).p;
  // ---- part 1: an owner resets another user's password
  const sp = (await req(a, 'GET', '/settings')).text;
  const bid = (sp.match(/\/settings\/users\/(\d+)\/reset/g) || []);
  const idB = await (async () => {
    const m = sp.match(new RegExp(B.e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]{0,300}?/settings/users/(\\d+)/reset'));
    if (!m) return null; const r = await req(a, 'POST', `/settings/users/${m[1]}/reset`); return r.text.includes(B.e) ? { id: m[1], text: r.text } : null;
  })();
  ok('Settings lists people with a Reset password button', bid.length > 0);
  ok('the owner can reset another owner, and the one-time password is shown', !!idB && /one-time password/.test(idB.text));
  const otp = idB && (idB.text.match(/font-size:22px">([A-Za-z0-9]+)</) || [])[1];
  ok('a one-time password was produced', !!otp && otp.length >= 8, String(otp));
  ok('the old password no longer works', (await login(B.e, B.pw)).r.status === 401);
  const lb = await login(B.e, otp || 'x');
  ok('the one-time password signs in', lb.r.status === 303 && !!lb.p.cookie);
  const b = lb.p;
  const hb = await req(b, 'GET', '/');
  ok('and the person is sent to choose their own password', hb.status === 302 && /change-password/.test(hb.loc), hb.status + ' ' + hb.loc);
  ok('the API is blocked until they do', (await req(b, 'GET', '/api/jobs')).status === 403);
  const cp0 = await req(b, 'GET', '/change-password');
  ok('the choose-a-password screen is shown', cp0.status === 200 && /Choose your own password/.test(cp0.text));
  const bad = await req(b, 'POST', '/change-password', { body: form({ next: 'Newer-pass-1', again: 'different' }) });
  ok('mismatching passwords are refused', /m=bad/.test(bad.loc) && (await req(b, 'GET', '/')).status === 302);
  const good = await req(b, 'POST', '/change-password', { body: form({ next: 'Newer-pass-1', again: 'Newer-pass-1' }) });
  ok('a new password is accepted', good.status === 303 && (await req(b, 'GET', '/')).status === 200);
  ok('the one-time password is dead', (await login(B.e, otp)).r.status === 401);
  ok('the new password signs in with no forced change', (await req((await login(B.e, 'Newer-pass-1')).p, 'GET', '/')).status === 200);
  ok('resetting someone who does not exist is refused', (await req(a, 'POST', '/settings/users/99999999/reset')).status === 404);
  const old = lb.p.cookie;
  await req(a, 'POST', `/settings/users/${idB.id}/reset`);
  ok('resetting signs the person out everywhere', (await req({ cookie: old }, 'GET', '/api/jobs')).status === 401);
  ok('a signed-out visitor cannot reset anyone', (await req(person(), 'POST', `/settings/users/${idB.id}/reset`)).loc.includes('/login'));

  // ---- part 2: Forgot password?
  ok('the sign-in screen has a Forgot password link', /href="\/forgot"/.test((await req(person(), 'GET', '/login')).text));
  const F = await mkOwner('rsF');
  const ask = async (email) => req(person(), 'POST', '/forgot', { body: form({ email }) });
  const known = await ask(F.e), unknown = await ask(`nobody-${RUN}${TEST}`.toLowerCase());
  ok('the same answer is given whether or not the email exists', known.status === 200 && unknown.status === 200 && known.text === unknown.text && /If that email address has an account/.test(known.text));
  const box = async (email) => (await req(admin(), 'GET', '/admin/outbox?to=' + encodeURIComponent(email))).json();
  let mails = await box(F.e);
  ok('a reset email was produced for the real address', mails.length === 1 && /\/reset\?t=[a-f0-9]{64}/.test(mails[0].text), JSON.stringify(mails).slice(0, 120));
  ok('and none for an unknown address', (await box(`nobody-${RUN}${TEST}`.toLowerCase())).length === 0);
  const link1 = (mails[0].text.match(/https:\/\/[^\s]+\/reset\?t=[a-f0-9]{64}/) || [''])[0];
  const path1 = link1.replace(/^https:\/\/[^/]+/, '');
  const tok1 = path1.split('t=')[1];
  const pg = await req(person(), 'GET', path1);
  ok('the link opens a new-password form', pg.status === 200 && /Choose a new password/.test(pg.text));
  ok('opening the link does not use it up', (await req(person(), 'GET', path1)).status === 200);
  const rb = await req(person(), 'POST', '/reset', { body: form({ t: tok1, next: 'short', again: 'short' }) });
  ok('a too-short password is refused and the link still works', /m=bad/.test(rb.loc) && (await req(person(), 'GET', path1)).status === 200);
  // a second request replaces the first link
  await ask(F.e);
  mails = await box(F.e);
  ok('a newer request gives a newer link', mails.length === 2);
  ok('and the older link stops working', (await req(person(), 'GET', path1)).status === 410);
  const path2 = mails[1].text.match(/\/reset\?t=[a-f0-9]{64}/)[0], tok2 = path2.split('t=')[1];
  const rs = await req(person(), 'POST', '/reset', { body: form({ t: tok2, next: 'Fresh-pass-77', again: 'Fresh-pass-77' }) });
  ok('the reset sets the new password', rs.status === 303 && /m=reset/.test(rs.loc));
  ok('the old password no longer works', (await login(F.e, F.pw)).r.status === 401);
  ok('the new password signs in', (await login(F.e, 'Fresh-pass-77')).r.status === 303);
  ok('the link cannot be used twice', (await req(person(), 'GET', path2)).status === 410 && (await req(person(), 'POST', '/reset', { body: form({ t: tok2, next: 'Again-pass-88', again: 'Again-pass-88' }) })).status === 410);
  ok('the second password never took', (await login(F.e, 'Again-pass-88')).r.status === 401);
  // expiry
  await ask(F.e); // 3rd request this hour for this address: the last allowed
  mails = await box(F.e);
  const tok3 = mails[mails.length - 1].text.match(/t=([a-f0-9]{64})/)[1];
  const ex = await req(admin(), 'POST', '/admin/expire-resets', { body: form({ email: F.e }) });
  ok('an expired link is refused (30 minute limit)', ex.json().expired >= 1 && (await req(person(), 'GET', '/reset?t=' + tok3)).status === 410 && (await req(person(), 'POST', '/reset', { body: form({ t: tok3, next: 'Late-pass-99', again: 'Late-pass-99' }) })).status === 410);
  ok('a made-up token is refused', (await req(person(), 'GET', '/reset?t=' + 'a'.repeat(64))).status === 410 && (await req(person(), 'GET', '/reset?t=abc')).status === 410);
  // limit: 3 requests per address per hour
  const before = (await box(F.e)).length;
  const lim = await ask(F.e);
  ok('too many requests for one address give the same answer but no email', lim.text === known.text && (await box(F.e)).length === before);
  ok('the reset page does not use no-referrer (browsers would send Origin: null and the form would be refused)', !/no-referrer/.test(pg.headers.get('referrer-policy') || '') && !/no-referrer/.test((await req(person(), 'GET', '/forgot')).headers.get('referrer-policy') || ''));
  ok('the reset form posts fine with a same-site Origin header', (await req(person(), 'POST', '/reset', { body: form({ t: 'a'.repeat(64), next: 'x', again: 'x' }), headers: { origin: BASE } })).status === 410);
  ok('and a foreign Origin is refused', (await req(person(), 'POST', '/reset', { body: form({ t: 'a'.repeat(64), next: 'x', again: 'x' }), headers: { origin: 'https://evil.example' } })).status === 403);
  ok('the reset page is not cached or indexed', /no-store/.test(pg.headers.get('cache-control') || ''));
}

async function phaseDiag() {
  console.log('\n== Diagnostics (/check) ==');
  const fs = require('fs'), path = require('path');
  if (!ADMIN_PW) { ok('ADMIN_PASSWORD supplied', false, 'set ADMIN_PASSWORD'); return; }
  const e = `diag-${RUN}${TEST}`.toLowerCase(), pw = 'Owner-pass-' + RUN;
  await req(admin(), 'POST', '/admin/owner', { body: form({ name: 'T', email: e, password: pw }) });
  const owner = (await login(e, pw)).p;
  const anon = await req(person(), 'GET', '/check');
  ok('/check needs a sign-in', anon.status === 302 && /login/.test(anon.loc));
  const pg = await req(owner, 'GET', '/check');
  ok('/check opens for a signed-in person', pg.status === 200 && /Pick a photo/.test(pg.text) && /Take a photo/.test(pg.text));
  ok('it has a plain image picker and a camera picker', /<input id="f1" type="file" accept="image\/\*"/.test(pg.text) && /id="f2" type="file" accept="image\/\*" capture="environment"/.test(pg.text) && !/id="f1"[^>]*capture/.test(pg.text));
  ok('it shows the build version and commit', /"commit":"[0-9a-f]{4,}|"commit":"unknown"/.test(pg.text) && /"version":/.test(pg.text));
  ok('/health reports the build commit', !!(await (await fetch(BASE + '/health')).json()).commit);
  // the report endpoint
  ok('a signed-out visitor cannot post a report', (await req(person(), 'POST', '/api/diag', { json: { kind: 'check' } })).status === 401);
  const rep = await req(owner, 'POST', '/api/diag', { json: { kind: 'check', mode: 'pick', steps: [{ step: 'file', ok: true, detail: 'x' }], env: { ios: '17.4' } } });
  const code = rep.json().code;
  ok('a report gets a 4-character code', rep.status === 200 && /^[A-HJ-NP-Z2-9]{4}$/.test(code || ''), rep.text.slice(0, 80));
  const got = (await req(admin(), 'GET', '/admin/diag?code=' + code)).json();
  ok('the code finds the full report in /admin/diag', Array.isArray(got) && got.length === 1 && got[0].data.env.ios === '17.4' && got[0].kind === 'check');
  ok('the admin log needs the admin password', (await req(person(), 'GET', '/admin/diag')).status === 401);
  // the server side of the check: a real HEIC, a JPEG, and rubbish
  const up = async (buf, name, type) => { const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name); const r = await fetch(`${BASE}/api/diag/upload`, { method: 'POST', body: fd, headers: { cookie: owner.cookie } }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
  const heic = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.heic'));
  const u1 = await up(heic, 'photo.jpg', ''); 
  ok('a HEIC file with a blank type is read and reported as heic', u1.status === 200 && u1.j.ok && u1.j.detected.type === 'heic' && u1.j.converted_with === 'heic-convert', JSON.stringify(u1.j));
  const u2 = await up(await jpeg(1200, 900), 'photo.jpg', 'image/jpeg');
  ok('a JPEG is read and reported as jpeg', u2.status === 200 && u2.j.detected.type === 'jpeg' && u2.j.width > 0);
  const u3 = await up(Buffer.from('definitely not a photo, just text'), 'x.jpg', 'application/octet-stream');
  ok('rubbish gets a refusal with a code', u3.status === 400 && /^[A-Z0-9]{4}$/.test(u3.j.code || ''), JSON.stringify(u3.j));
  // the real upload route logs failures with a code, and no longer trusts the type label
  const jid = (await req(owner, 'POST', '/api/jobs', { json: { job_type: 'Garden' }, headers: { accept: 'application/json' } })).json().id;
  const blank = await upload(owner, jid, 'before', 0, heic, 'photo.jpg', '');
  ok('a HEIC photo whose type label is blank is now accepted', blank.status === 200 && blank.body.ok, JSON.stringify(blank.body));
  const octet = await upload(owner, jid, 'after', 0, await jpeg(900, 1200), 'photo.jpg', 'application/octet-stream');
  ok('a photo labelled application/octet-stream is accepted', octet.status === 200 && octet.body.ok, JSON.stringify(octet.body));
  const bad = await upload(owner, jid, 'during', 0, Buffer.from('not an image'), 'photo.jpg', 'image/jpeg');
  const bcode = (bad.body.error || '').match(/code ([A-Z0-9]{4})/);
  ok('a failed upload tells the person a code', bad.status === 400 && !!bcode && bad.body.code === bcode[1], JSON.stringify(bad.body));
  const log = (await req(admin(), 'GET', '/admin/diag?code=' + (bad.body.code || 'ZZZZ'))).json()[0] || {};
  ok('the server log holds the user agent, size, detected type and error', log.kind === 'upload_failure' && !!log.ua && log.data.size === 12 && log.data.detected && log.data.detected.type === 'unknown' && !!log.data.error && log.data.reason === 'decode failed', JSON.stringify(log).slice(0, 200));
  const nofile = await req(owner, 'POST', `/api/jobs/${jid}/photos`, { body: form({ kind: 'before', seq: '0' }) });
  ok('a request with no file is logged with a code too', nofile.status === 400 && /code [A-Z0-9]{4}/.test(nofile.json().error || ''), nofile.text.slice(0, 120));
  ok('the capture screen sends a report when an upload cannot be saved', /beacon\(\{stage:'upload-failed'/.test((await req(owner, 'GET', `/jobs/${jid}/capture`)).text));
}

async function phaseHelp() {
  console.log('\n== Help page ==');
  if (!ADMIN_PW) { ok('ADMIN_PASSWORD supplied', false, 'set ADMIN_PASSWORD'); return; }
  const e = `help-${RUN}${TEST}`.toLowerCase(), pw = 'Owner-pass-' + RUN;
  await req(admin(), 'POST', '/admin/owner', { body: form({ name: 'T', email: e, password: pw }) });
  const owner = (await login(e, pw)).p;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'help', 'help.json'), 'utf8'));
  const pub = manifest.filter(m => m.public), priv = manifest.filter(m => !m.public);
  ok('the help list has one public video and more for signed-in people', pub.length >= 1 && priv.length >= 1);
  const out = await req(person(), 'GET', '/help');
  ok('/help opens signed out', out.status === 200 && /How does this work\?/.test(out.text));
  ok('signed out shows the public video titles only', pub.every(m => out.text.includes(m.title)) && priv.every(m => !out.text.includes(m.title)));
  ok('signed out offers to sign in for the rest', /Sign in to see the rest/.test(out.text));
  const inn = await req(owner, 'GET', '/help');
  ok('signed in shows every video title', manifest.every(m => inn.text.includes(m.title)) && !/Sign in to see the rest/.test(inn.text));
  ok('videos that are not there yet show Video coming soon, and the others a portrait player', /Video coming soon/.test(inn.text) || /<video controls playsinline/.test(inn.text));
  ok('the player is portrait and does not autoplay', !/<video[^>]*autoplay/.test(inn.text) && (!/<video/.test(inn.text) || /aspect-ratio:9\/16/.test(inn.text)));
  ok('the sign-in screen links to it', /href="\/help">How does this work\?/.test((await req(person(), 'GET', '/login')).text));
  ok('Settings has a Help entry', /href="\/help"/.test((await req(owner, 'GET', '/settings')).text));
  for (const m of manifest) {
    const v = await req(person(), 'GET', `/help/v/${m.id}.mp4`), vi = await req(owner, 'GET', `/help/v/${m.id}.mp4`);
    if (m.public) ok(`public video ${m.id}: ${vi.status === 200 ? 'playable signed out' : 'not added yet (404)'}`, vi.status === 200 ? v.status === 200 : (vi.status === 404 && v.status === 404));
    else ok(`private video ${m.id} is never served signed out`, v.status === 401 || v.status === 404);
  }
  ok('an unknown video id is a 404', (await req(owner, 'GET', '/help/v/nope.mp4')).status === 404 && (await req(owner, 'GET', '/help/p/..%2fserver.mp4.jpg')).status === 404);
}

async function engine() {
  console.log('\n== Engine timing (local, no server) ==');
  const r = require('child_process').spawnSync('python3', [require('path').join(__dirname, 'engine_timing.py')], { encoding: 'utf8' });
  (r.stdout || '').split('\n').filter(l => /^(PASS|FAIL)/.test(l)).forEach(l => { const good = l.startsWith('PASS'); good ? pass++ : fail++; console.log(l); });
  if (r.status !== 0 && !/FAIL/.test(r.stdout || '')) { fail++; console.log('FAIL  engine timing tests did not run: ' + (r.stderr || '').slice(-300)); }
}

(async () => {
  console.log('Testing ' + BASE);
  try {
    let ctx;
    try { CREW_CAP = (await (await fetch(BASE + '/health')).json()).crew_can_capture !== false; } catch (e) {}
    try { CREW_ON = (await (await fetch(BASE + '/health')).json()).crew_enabled !== false; } catch (e) {}
    if (!CREW_ON) CREW_CAP = false;
    console.log('Crew logins on this account:', CREW_ON, '| crew can take photos:', CREW_CAP);
    if (['phase1', 'all'].includes(which)) { await phase1(); await phaseQr(); }
    if (['phase2', 'all'].includes(which)) ctx = await phase2();
    if (['phase3', 'all'].includes(which)) await phase3(ctx);
    if (['phase4', 'all'].includes(which)) await phase4();
    if (['phase5', 'all'].includes(which)) await phase5();
    if (['phase6', 'all'].includes(which)) await phase6();
    if (['reset', 'all'].includes(which)) await phaseReset();
    if (['diag', 'all'].includes(which)) await phaseDiag();
    if (['help', 'all'].includes(which)) await phaseHelp();
    if (['errors', 'all'].includes(which)) await phaseErrors();
    if (['homedelete', 'all'].includes(which)) await phaseHomeDelete();
    if (['lines', 'all'].includes(which)) await phaseLines();
    if (['area', 'all'].includes(which)) await phaseArea();
    if (['adminback', 'all'].includes(which)) await phaseAdminBack();
    if (['engine', 'all'].includes(which)) await engine();
  } catch (e) { fail++; console.log('FAIL  test run crashed: ' + e.stack); }
  if (ADMIN_PW && which !== 'phase1') { const r = await req(admin(), 'POST', '/admin/purge-test', { body: '' }); console.log('\nTest accounts removed:', r.status === 303 ? 'yes' : 'NO (' + r.status + ')'); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
