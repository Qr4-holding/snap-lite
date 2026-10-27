// Fills a demo install with a few sample jobs from the sample yard photos, then creates the demo owner with a one-time password.
//   BASE_URL=https://demo... ADMIN_PASSWORD=... PHOTO_DIR=<folder with before.jpg work.jpg after.jpg> OWNER_EMAIL=... OWNER_PW=... node test/seed-demo.js
const fs = require('fs'), path = require('path'), sharp = require('sharp');
const BASE = process.env.BASE_URL.replace(/\/$/, ''), AP = process.env.ADMIN_PASSWORD, DIR = process.env.PHOTO_DIR;
const A = 'Basic ' + Buffer.from('admin:' + AP).toString('base64'), H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = o => new URLSearchParams(o).toString();
let cookie = '';
async function api(method, p, { body, json, auth } = {}) {
  const h = { accept: 'application/json' }; if (cookie) h.cookie = cookie; if (auth) h.authorization = A;
  if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); } else if (typeof body === 'string') h['content-type'] = 'application/x-www-form-urlencoded';
  const r = await fetch(BASE + p, { method, headers: h, body, redirect: 'manual' });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; const m = sc.map(c => c.split(';')[0]).find(c => c.startsWith('sl=')); if (m) cookie = m;
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, j, t, loc: r.headers.get('location') || '' };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function photoSet(variant) {
  const rd = n => fs.readFileSync(path.join(DIR, n));
  const t = async (buf, op) => op === 'mirror' ? sharp(buf).flop().jpeg({ quality: 90 }).toBuffer()
    : op === 'land' ? sharp(buf).extract({ left: 0, top: 360, width: 768, height: 576 }).resize(1600, 1200).jpeg({ quality: 90 }).toBuffer()
    : sharp(buf).jpeg({ quality: 90 }).toBuffer();
  return { before: await t(rd('before.jpg'), variant), during: await t(rd('work.jpg'), variant), after: await t(rd('after.jpg'), variant) };
}
async function upload(id, kind, seq, buf) {
  const fd = new FormData(); fd.append('kind', kind); fd.append('seq', String(seq)); fd.append('file', new Blob([buf], { type: 'image/jpeg' }), 'photo.jpg');
  const r = await fetch(`${BASE}/api/jobs/${id}/photos`, { method: 'POST', body: fd, headers: { cookie } });
  if (r.status !== 200) throw new Error('upload ' + kind + ' ' + r.status + ' ' + (await r.text()));
}
let bot, botPw;
async function removeBot() { if (!bot || !cookie) return; const r = await api('POST', '/settings/delete-account', { body: form({ password: botPw }) }); console.log('seed owner removed:', /m=gone/.test(r.loc)); cookie = ''; bot = null; }
(async () => {
  bot = `seed-${Date.now()}@seed.invalid`, botPw = 'Seed-' + Math.random().toString(36).slice(2) + 'A1';
  let r = await api('POST', '/admin/owner', { auth: true, body: form({ name: 'Seed', email: bot, password: botPw }) }); if (!/m=owner/.test(r.loc)) throw new Error('create seed owner: ' + r.loc);
  r = await api('POST', '/login', { body: form({ email: bot, password: botPw }) }); if (r.status !== 303) throw new Error('seed login ' + r.status);
  const defs = [
    { type: 'Cardboard and packaging', variant: 'plain', during: true, approve: true },
    { type: 'Garage', variant: 'mirror', during: false, approve: false },
    { type: 'Commercial yard', variant: 'land', during: true, approve: true }
  ];
  const ids = [];
  for (const d of defs) {
    const id = (await api('POST', '/api/jobs', { json: { job_type: d.type } , auth: false })).j.id; if (!id) throw new Error('create job');
    const ph = await photoSet(d.variant);
    await upload(id, 'before', 0, ph.before); if (d.during) await upload(id, 'during', 0, ph.during); await upload(id, 'after', 0, ph.after);
    r = await api('POST', `/api/jobs/${id}/render`, { json: {} }); if (r.status !== 200) throw new Error('render ' + r.status + r.t);
    ids.push({ id, d });
    for (let i = 0; i < 90; i++) { await wait(3000); const s = (await api('GET', `/api/jobs/${id}/status`)).j; if (s.state === 'ready') break; if (s.state === 'failed') throw new Error('render failed ' + JSON.stringify(s)); }
    if (d.approve) { r = await api('POST', `/api/jobs/${id}/approve`, { json: {} }); if (r.status !== 200) throw new Error('approve ' + r.status + r.t); }
    console.log('job', id, d.type, d.approve ? 'approved' : 'ready');
  }
  // the seed owner goes away (soft delete keeps the jobs with the business)
  await removeBot();
  if (process.env.OWNER_EMAIL) {
    r = await api('POST', '/admin/owner', { auth: true, body: form({ name: process.env.OWNER_NAME || '', email: process.env.OWNER_EMAIL, password: process.env.OWNER_PW, must_change: '1' }) });
    console.log('owner created:', /m=owner/.test(r.loc));
  }
})().catch(async e => { console.error('SEED FAILED:', e.message); try { await removeBot(); } catch (x) {} process.exit(1); });
