// Publish to the hub, end to end, against a TEST hub and the demo app (never a client's app or the live hub).
//   BASE_URL=<demo app> ADMIN_PASSWORD=... HUB_URL=<test hub> HUB_ADMIN=... [HUB_HOST_URL=<address the app uses for the hub>] node test/hub.js
const sharp = require('sharp');
const BASE = process.env.BASE_URL.replace(/\/$/, ''), HUB = process.env.HUB_URL.replace(/\/$/, ''), AP = process.env.ADMIN_PASSWORD, HP = process.env.HUB_ADMIN;
if (/ekp11/i.test(BASE) || /^https:\/\/(www\.)?cleanuppic\.co\.uk/.test(HUB)) { console.log('Refusing: test hub and demo app only.'); process.exit(1); }
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const form = o => new URLSearchParams(o).toString(), wait = ms => new Promise(r => setTimeout(r, ms));
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const basic = (u, p) => ({ authorization: 'Basic ' + Buffer.from(u + ':' + p).toString('base64') });
let cookie = '';
async function a(method, p, body, h = {}) {
  const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(typeof body === 'string' ? FORM : {}), ...h }, body });
  const m = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).find(c => c.startsWith('sl=')); if (m) cookie = m;
  return { status: r.status, text: await r.text(), loc: r.headers.get('location') || '' };
}
const adminA = (m, p, b) => a(m, p, b, basic('admin', AP));
async function h(method, p, body, headers = {}) { const r = await fetch(HUB + p, { method, redirect: 'manual', headers: { ...(typeof body === 'string' ? FORM : {}), ...headers }, body }); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, text: t, j }; }
const adminH = (m, p, b) => h(m, p, b, basic('admin', HP));
const api = (key, m, p, b, hd = {}) => h(m, p, b, { authorization: 'Bearer ' + key, ...hd });
const hubOpen = on => adminH('POST', '/admin/hub', form({ open: on ? '1' : '0' }));
const newApp = async n => { const r = await adminH('POST', '/admin/apps', form({ name: n })); return (r.text.match(/cup_[a-f0-9]{48}/) || [])[0]; };
const pub = () => a('GET', '/settings');
async function makeJob(type, area) {
  const r = await a('POST', '/api/jobs', form({ job_type: type, area }), { accept: 'application/json' }); const id = JSON.parse(r.text).id;
  for (const [kind, c] of [['before', { r: 120, g: 90, b: 60 }], ['after', { r: 200, g: 220, b: 200 }]]) {
    const fd = new FormData(); fd.append('kind', kind); fd.append('seq', '0'); fd.append('file', new Blob([await sharp({ create: { width: 900, height: 1200, channels: 3, background: c } }).jpeg().toBuffer()], { type: 'image/jpeg' }), 'p.jpg');
    await fetch(`${BASE}/api/jobs/${id}/photos`, { method: 'POST', body: fd, headers: { cookie } });
  }
  return id;
}
async function renderIt(id, how = 'render') {
  const r = await a('POST', `/api/jobs/${id}/${how}`); if (r.status !== 200) throw new Error(how + ' ' + r.status + ' ' + r.text);
  for (let i = 0; i < 120; i++) { await wait(2000); const s = JSON.parse((await a('GET', `/api/jobs/${id}/status`)).text).state; if (s !== 'rendering') return s; }
}
const hubJob = async slug => { for (let i = 0; i < 60; i++) { const r = await h('GET', '/job/' + slug); if (r.status === 200) return r; await wait(1000); } return { status: 0 }; };
const RUN = Date.now().toString(36);

(async () => {
  const was = await (await fetch(BASE + '/standing.json')).json();          // the demo's own registration, put back at the end
  await hubOpen(false);
  await adminA('POST', '/admin/owner', form({ name: 'Demo Owner', email: `owner-${RUN}@snaplite-test.invalid`, password: 'demo-owner-pw' }));
  await a('POST', '/login', form({ email: `owner-${RUN}@snaplite-test.invalid`, password: 'demo-owner-pw' }));
  console.log('\n== Off until connected ==');
  let s = await pub(); ok('no key: the client sees nothing about it', !/Publish to/.test(s.text));
  ok('no key: routes go back to Settings', (await a('GET', '/settings/publish')).status === 303);

  console.log('\n== Keys and the door ==');
  const key = await newApp('Demo app ' + RUN), key2 = await newApp('Other app ' + RUN);
  ok('admin makes a key, shown once', !!key && !(await adminH('GET', '/admin/apps')).text.includes(key));
  ok('no key refused', (await h('GET', '/api/app/status')).status === 401);
  ok('wrong key refused', (await api('cup_' + '0'.repeat(48), 'GET', '/api/app/status')).status === 401);
  const st0 = await api(key, 'GET', '/api/app/status');
  ok('right key answers, hub closed, not linked', st0.status === 200 && st0.j.hub_open === false && st0.j.linked === false && st0.j.terms.version >= 1);
  ok('a browser cannot post a form to Connected apps without the admin login', (await h('POST', '/admin/apps', form({ name: 'x' }))).status === 401);
  const BASEH = process.env.HUB_HOST_URL || HUB;
  await adminA('POST', '/admin/keys', form({ hub_url: BASEH, hub_key: key }));
  s = await pub(); ok('connected: Settings shows the switch, off by default', /Publish to CleanUpPic/.test(s.text) && /<b>Off<\/b>/.test(s.text));
  ok('the key is never in a page', !s.text.includes(key) && !(await adminA('GET', '/admin')).text.includes(key));

  console.log('\n== Registered carriers only ==');
  let p = await a('GET', '/settings/publish'); ok('no checked registration: no way to accept', /upper tier waste carriers/.test(p.text) && !/Accept and turn on/.test(p.text));
  await adminA('POST', '/admin/test-registration', form({ name: 'Lower Ltd', number: 'CBDL123456', expiry: '2099-01-01', tier: 'lower', checked: new Date().toISOString() }));
  p = await a('GET', '/settings/publish'); ok('lower tier refused', /upper tier waste carriers/.test(p.text));
  await adminA('POST', '/admin/test-registration', form({ name: 'Demo Clearances Ltd', number: 'CBDU123456', expiry: '2099-01-01', tier: 'upper', checked: new Date().toISOString() }));

  console.log('\n== Turning on, terms in the app ==');
  p = await a('GET', '/settings/publish');
  ok('accept page shows the terms and version', /Accept and turn on/.test(p.text) && /Publishing to CleanUpPic: carrier terms/.test(p.text) && /version 1/.test(p.text));
  ok('prefilled with the client\'s own details', p.text.includes(`owner-${RUN}@snaplite-test.invalid`) && p.text.includes('Demo Clearances Ltd'));
  const details = { business: 'Demo Clearances ' + RUN, email: `hub-${RUN}@snaplite-test.invalid`, town: 'Leeds', whatsapp: '07700 900123', terms_version: '1' };
  let r = await a('POST', '/settings/publish/on', form(details));
  ok('no tick, not turned on', r.status === 200 && /Tick the box/.test(r.text) && !(await api(key, 'GET', '/api/app/status')).j.linked);
  r = await a('POST', '/settings/publish/on', form({ ...details, accept: '1', terms_version: '0' }));
  ok('an old version of the terms cannot be accepted', /terms have just changed/.test(r.text));
  r = await a('POST', '/settings/publish/on', form({ ...details, accept: '1' }));
  const st1 = await api(key, 'GET', '/api/app/status');
  ok('accepted: account made under the client\'s details', r.status === 303 && st1.j.linked && st1.j.terms_ok && st1.j.carrier.email === details.email && st1.j.carrier.whatsapp === details.whatsapp, r.text.slice(0, 200));
  const apps = (await adminH('GET', '/admin/apps')).text;
  ok('hub keeps who accepted, version and date', /accepted terms version 1 on \d\d\/\d\d\/\d{4}/.test(apps));
  ok('app keeps its own record', /hub_on/.test((await adminA('GET', '/admin/events?type=hub_on')).text));
  ok('hub carrier list shows them', (await adminH('GET', '/admin/carriers')).text.includes(details.email));
  const k2 = await api(key2, 'POST', '/api/app/link', JSON.stringify({ business: 'Someone', email: details.email, reg_number: 'CBDU1', accepted_by: 'x@x.co', accept_terms: true, terms_version: 1 }), { 'content-type': 'application/json' });
  ok('another app cannot take the same email', k2.status === 409 && k2.j.error === 'email_taken');
  const k3 = await api(key2, 'POST', '/api/app/link', JSON.stringify({ business: details.business.toUpperCase(), email: 'other@x.co', reg_number: 'CBDU1', accepted_by: 'x@x.co', accept_terms: true, terms_version: 1 }), { 'content-type': 'application/json' });
  ok('another app cannot take the same business name', k3.status === 409 && k3.j.error === 'name_taken');
  const k4 = await api(key2, 'POST', '/api/app/link', JSON.stringify({ business: 'Fresh', email: 'fresh@x.co', reg_number: 'CBDU1', accepted_by: 'x@x.co' }), { 'content-type': 'application/json' });
  ok('no details change without accepted terms', k4.status === 409 && k4.j.error === 'terms_needed');

  console.log('\n== WhatsApp set in the app ==');
  await a('POST', '/settings/publish/details', form({ business: details.business, email: details.email, town: 'Leeds', whatsapp: '07700 900456' }));
  await wait(100); ok('number saved on the hub', (await api(key, 'GET', '/api/app/status')).j.carrier.whatsapp === '07700 900456');
  r = await a('POST', '/settings/publish/details', form({ business: details.business, email: details.email, town: 'Leeds', whatsapp: '12' }));
  ok('a bad number is refused and says why', /hub=whatsapp/.test(r.loc));

  console.log('\n== Owner only ==');
  const crew = `crew-${RUN}@snaplite-test.invalid`, inv = await a('POST', '/settings/invite', form({ email: crew })), tmp = decodeURIComponent((inv.loc.match(/p=([^&]+)/) || [])[1] || ''), keep = cookie; cookie = '';
  await a('POST', '/login', form({ email: crew, password: tmp }));
  ok('crew cannot open or use publishing', (await a('GET', '/settings/publish')).status === 403 && (await a('POST', '/settings/publish/off', '')).status === 403 && !/Publish to CleanUpPic/.test((await pub()).text));
  cookie = keep;
  console.log('\n== Closed hub ==');
  const id = await makeJob('Garden', 'Selby'), state = await renderIt(id);
  ok('video made', state === 'ready', state);
  let j = await a('GET', `/jobs/${id}`); ok('not approved yet: no publish button', !/Publish to CleanUpPic<\/button>/.test(j.text));
  await a('POST', `/jobs/${id}/approve`);
  j = await a('GET', `/jobs/${id}`); ok('closed: says it opens at launch, no button', /opens when CleanUpPic launches/.test(j.text) && !/<button type="submit">Publish to/.test(j.text));
  r = await a('POST', `/jobs/${id}/publish`, form({ title: 'x', trade: 'Garden waste', confirm: '1' }));
  ok('closed: a forced post is refused and nothing is kept', /hub=closed/.test(r.loc) && !/On CleanUpPic/.test((await a('GET', `/jobs/${id}`)).text));
  ok('closed: hub refuses the key directly', (await api(key, 'POST', '/api/app/jobs', new FormData())).status === 423);
  console.log('\n== Open hub ==');
  await hubOpen(true); await wait(31000);
  const li = await h('POST', '/trade/login', form({ email: details.email, password: '!' }));
  ok('no hub login exists for this account', li.status === 401, String(li.status));
  j = await a('GET', `/jobs/${id}`);
  ok('open: publish form, title and type filled in', /<button type="submit">Publish to CleanUpPic/.test(j.text) && j.text.includes('value="Garden in Selby"') && /<option selected>Garden waste/.test(j.text));
  r = await a('POST', `/jobs/${id}/publish`, form({ title: 'Garden in Selby', trade: 'Garden waste' }));
  ok('no tick on the photo promise: not sent', /hub=details/.test(r.loc));
  r = await a('POST', `/jobs/${id}/publish`, form({ title: 'Garden in Selby <b>', trade: 'Garden waste', confirm: '1' }));
  ok('sent', /hub=sent/.test(r.loc), r.loc);
  j = await a('GET', `/jobs/${id}`); const slug = (j.text.match(/\/job\/([a-z0-9-]+)"/) || [])[1];
  ok('job page says it is on CleanUpPic, with a link', /✔ On CleanUpPic/.test(j.text) && !!slug, j.text.slice(0, 0));
  const live = await hubJob(slug);
  ok('it is live on the hub, under the client\'s name', live.status === 200 && live.text.includes(details.business), String(live.status));
  ok('title is escaped on the hub', !live.text.includes('Selby <b>'));
  const jsj = await h('GET', '/assets/jobs.js'); const rec = JSON.parse(jsj.text.replace(/^window\.STJ_JOBS = /, '').replace(/;$/, '')).find(x => x.slug === slug);
  ok('WhatsApp button number is the one from the app', rec && rec.wa === '447700900456', JSON.stringify(rec || {}).slice(0, 200));
  ok('no customer postcode goes across', !jsj.text.includes('LS12'));
  const vid = await fetch(HUB + rec.video); ok('video plays from the hub', vid.status === 200 && /video/.test(vid.headers.get('content-type')));

  console.log('\n== Video changed, deleted, abuse ==');
  const twice = await a('POST', `/jobs/${id}/publish`, form({ title: 'Again', trade: 'Garden waste', confirm: '1' }));
  await wait(6000);
  ok('same video twice does not make a second job', (JSON.parse((await h('GET', '/assets/jobs.js')).text.replace(/^window\.STJ_JOBS = /, '').replace(/;$/, '')).filter(x => x.biz === details.business)).length === 1, twice.loc);
  await a('POST', `/jobs/${id}/remake`); for (let i = 0; i < 60; i++) { await wait(2000); if (JSON.parse((await a('GET', `/api/jobs/${id}/status`)).text).state !== 'rendering') break; }
  j = await a('GET', `/jobs/${id}`); ok('after a remake: told the hub has the old one until approved', /still shows the old one/.test(j.text));
  await a('POST', `/jobs/${id}/approve`); j = await a('GET', `/jobs/${id}`);
  ok('after approval: Update button', /Update on CleanUpPic/.test(j.text));
  r = await a('POST', `/jobs/${id}/publish`, form({ title: 'Garden in Selby', trade: 'Garden waste', confirm: '1' })); ok('update accepted', /hub=sent/.test(r.loc));
  await wait(6000); const fd = new FormData(); fd.append('external_id', 'bad'); fd.append('title', 't'); fd.append('trade', 'Garden waste'); fd.append('confirm', '1'); fd.append('video', new Blob(['not a video'], { type: 'video/mp4' }), 'v.mp4');
  ok('a file that is not a video is refused', (await api(key, 'POST', '/api/app/jobs', fd)).j.error === 'video');
  r = await a('POST', `/jobs/${id}/publish/remove`, ''); ok('take it off', /hub=removed/.test(r.loc));
  await wait(300); ok('gone from the hub', (await h('GET', '/job/' + slug)).status !== 200 || !(await h('GET', '/job/' + slug)).text.includes(details.business));
  await a('POST', `/jobs/${id}/publish`, form({ title: 'Garden in Selby', trade: 'Garden waste', confirm: '1' })); await wait(6000);
  j = await a('GET', `/jobs/${id}`); const slug2 = (j.text.match(/\/job\/([a-z0-9-]+)"/) || [])[1];
  await a('POST', `/jobs/${id}/delete`, ''); await wait(1500);
  ok('job deleted in the app comes off the hub', !(await h('GET', '/assets/jobs.js')).text.includes(`"slug":"${slug2}"`));
  const id2 = await makeJob('Garage', ''); await renderIt(id2); await a('POST', `/jobs/${id2}/approve`);
  await a('POST', `/jobs/${id2}/publish`, form({ title: 'Garage clear', trade: 'Garage clearance', confirm: '1' })); await wait(6000);
  const appId = (await adminH('GET', '/admin/apps')).text.split('Demo app ' + RUN)[1].match(/\/admin\/apps\/(\d+)\/switch/)[1];
  await adminH('POST', `/admin/apps/${appId}/switch`, '');
  ok('switched off in hub admin: key stops, videos hidden', (await api(key, 'GET', '/api/app/status')).status === 403 && !(await h('GET', '/assets/jobs.js')).text.includes(details.business));
  await adminH('POST', `/admin/apps/${appId}/switch`, ''); ok('switched on: they return', (await h('GET', '/assets/jobs.js')).text.includes(details.business));
  await wait(31000);
  console.log('\n== Turning off ==');
  r = await a('POST', '/settings/publish/off', ''); await wait(300);
  const st2 = await api(key, 'GET', '/api/app/status');
  ok('off: videos gone, account stopped, acceptance record kept', /hub=off/.test(r.loc) && !st2.j.linked && !(await h('GET', '/assets/jobs.js')).text.includes(details.business) && /accepted terms version 1/.test((await adminH('GET', '/admin/apps')).text));
  ok('off: back to Off in Settings', /<b>Off<\/b>/.test((await pub()).text));
  await hubOpen(false);
  if (was.registration_number) await adminA('POST', '/admin/test-registration', form({ name: was.business, number: was.registration_number, expiry: was.registration_expires, tier: was.registration_tier, checked: was.registration_checked_at || '' }));
  await a('POST', '/settings/delete-account', form({ password: 'demo-owner-pw' }));
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
