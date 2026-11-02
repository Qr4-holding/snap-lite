// Publish to the hub (CleanUpPic) from inside a client's app. Off until /admin holds the hub's address and this app's key (hub_url, hub_key).
// The owner turns it on in Settings, accepting the hub's carrier terms here; that makes their hub account under their own details.
// The owner then chooses each video; nothing is sent automatically. The key stays on this server, it never reaches a browser.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { clean, esc, EMAIL, sameOrigin } = require('./lib/util');
const md = require('./lib/md');
const regFor = require('./lib/reg');

const NAME = 'CleanUpPic', DOC = 'cleanuppic_carrier';
const WHY = {
  email_taken: `That email is already on ${NAME}. Use another one, or contact ${NAME}.`, name_taken: `That business name is already on ${NAME}. Use your full trading name, or contact ${NAME}.`,
  whatsapp: 'That WhatsApp number does not look right. Use a UK mobile like 07700 900123.', details: 'Please fill in the business name and email.', registration: 'Your waste carrier registration is missing.',
  off: `Publishing has been switched off for this app. Contact ${NAME}.`, key: `This app's connection to ${NAME} is not working. Contact ${NAME}.`, closed: `Publishing opens when ${NAME} launches. Nothing was sent.`,
  terms_changed: 'The terms have just changed. Read the new version and accept again.', video: 'That video could not be read. Remake it, then try again.', file: 'That video is too large to publish.', busy: 'It is already being sent. Wait a moment.',
  terms_needed: 'Please accept the terms first.', not_linked: 'Turn publishing on in Settings first.', too_many: 'Too many tries. Wait a while, then try again.'
};
const SAID = { on: `Publishing to ${NAME} is on. Open any approved video to publish it.`, off: `Publishing is off. Your videos have been taken off ${NAME}.`, saved: 'Details saved.', sent: `Sent. It will be live on ${NAME} in a minute or two.`, removed: `Taken off ${NAME}.` };

module.exports = function hub({ app, pool, SKIN, ui, acct, jobsMod, events, secrets }) {
  const { page, msg } = ui;
  const { needUser, needOwner } = acct;
  const form = express.urlencoded({ extended: false, limit: '10kb' });
  const conf = async () => { const url = String(await secrets.get('hub_url')).replace(/\/+$/, ''), key = await secrets.get('hub_key'); return url && key ? { url, key } : null; };

  async function call(method, p, { json, body, ms = 8000 } = {}) {
    const c = await conf(); if (!c) return { status: 0, j: {} };
    const headers = { authorization: 'Bearer ' + c.key };
    if (json) headers['content-type'] = 'application/json';
    try {
      const r = await fetch(c.url + p, { method, headers, body: json ? JSON.stringify(json) : body, signal: AbortSignal.timeout(ms) });
      return { status: r.status, j: await r.json().catch(() => ({})) };
    } catch (e) { return { status: 0, j: {} }; }
  }
  // what the hub says now, kept for 30 seconds so screens stay quick. null = not set up here, or the hub can't be reached (see .down).
  let cache = null;
  const forget = () => { cache = null; };
  async function status() {
    const c = await conf(); if (!c) return null;
    if (cache && cache.key === c.key && Date.now() - cache.at < 30e3) return cache.st;
    const r = await call('GET', '/api/app/status', { ms: 4000 });
    const st = r.status === 200 ? r.j : { down: true, why: r.j.error || '' };
    cache = { key: c.key, at: Date.now(), st }; return st;
  }
  const why = r => WHY[r.j.error] || `${NAME} could not be reached. Nothing changed. Try again in a few minutes.`;

  // who may publish: a checked, in-date upper tier registration with no flag on the business
  async function eligibility() {
    const s = await acct.standing.get();
    if (s.flag) return { ok: false, text: `Publishing to ${NAME} is paused while your Clean Up UK listing is under review.` };
    if (!s.verified) return { ok: false, text: `${NAME} is for registered upper tier waste carriers. Save your registration number in Settings and check it against the register, then come back.` };
    return { ok: true };
  }
  const details = async (b, user) => {
    const rg = await regFor(pool, SKIN).get();
    return { business: clean(b.business, 80), email: clean(b.email, 120).toLowerCase(), town: clean(b.town, 60), whatsapp: clean(b.whatsapp, 30), reg_number: rg.number, reg_expiry: rg.expiry, accepted_by: user.email };
  };
  const detailFields = v => `<label class="f">Business name <span class="small">(shown on your videos on ${NAME})</span><input name="business" required maxlength="80" value="${esc(v.business)}"></label>
<label class="f">Email <span class="small">(where customers' quote requests go)</span><input name="email" type="email" required maxlength="120" inputmode="email" value="${esc(v.email)}"></label>
<label class="f">Town or area you cover<input name="town" maxlength="60" value="${esc(v.town)}"></label>
<label class="f">WhatsApp number <span class="small">(optional; customers see Message on WhatsApp on your videos)</span><input name="whatsapp" type="tel" inputmode="tel" maxlength="30" placeholder="07700 900123" value="${esc(v.whatsapp)}"></label>`;

  // ---------- Settings ----------
  async function settingsCard() {
    const st = await status(); if (!st) return '';
    const head = `<h2 id="publish">Publish to ${esc(st.hub || NAME)}</h2>`;
    if (st.down) return `${head}<div class="card"><p class="small" style="margin:0">${esc(WHY[st.why] || `${NAME} can't be reached just now. Try again in a few minutes.`)}</p></div>`;
    if (!st.linked) return `${head}<div class="card"><p style="margin:0"><b>Off</b></p><p class="small" style="margin:0">Put your job videos on ${esc(st.hub)} so customers can find you and ask for a quote. You choose each video. Nothing goes on unless you tap Publish.</p><a class="btn" href="/settings/publish">Turn on</a></div>`;
    if (!st.terms_ok) return `${head}<div class="card"><p style="margin:0"><b>The terms have changed</b></p><p class="small" style="margin:0">Read and accept the new version before you publish again. Your videos stay on ${esc(st.hub)}.</p><a class="btn" href="/settings/publish">Read the new terms</a></div>`;
    const c = st.carrier;
    return `${head}<form class="card" method="post" action="/settings/publish/details"><p style="margin:0"><b>✔ On</b></p><p class="small" style="margin:0">You choose each video: open a job and tap Publish.${st.hub_open ? '' : ` ${esc(st.hub)} has not launched yet, so publishing opens at launch.`}</p>
${detailFields({ business: c.name, email: c.email, town: c.town, whatsapp: c.whatsapp })}<button type="submit">Save details</button></form>
<form method="post" action="/settings/publish/off" onsubmit="return confirm('Turn publishing off? All your videos come off ${esc(st.hub).replace(/'/g, '')}.')"><button class="bad" type="submit">Turn off</button></form>`;
  }
  const needHub = async (req, res, next) => { try { if (await conf()) return next(); res.redirect(303, '/settings'); } catch (e) { next(e); } };

  const acceptPage = async (req, res, m = '', vals = null) => {
    const st = await status(), el = await eligibility();
    if (!st || st.down) return res.redirect(303, '/settings#publish');
    if (st.linked && st.terms_ok) return res.redirect(303, '/settings#publish');
    const rg = await regFor(pool, SKIN).get(), prof = await acct.profile.get(), c = st.carrier;
    const v = vals || { business: c ? c.name : rg.trading || rg.registerName || SKIN.short_name || SKIN.name, email: c ? c.email : req.user.email, town: c ? c.town : prof.area, whatsapp: c ? c.whatsapp : prof.mobileNice };
    res.set('Cache-Control', 'no-store').send(page('Settings', `<h1>Publish to ${esc(st.hub)}</h1>${msg(m, true)}
${el.ok ? `<form class="card" method="post" action="/settings/publish/on"><input type="hidden" name="terms_version" value="${+st.terms.version}">
<p class="small" style="margin:0">Check these details. They are what customers see, and they make your ${esc(st.hub)} account. You don't need a separate login.</p>
${detailFields(v)}
<div style="max-height:320px;overflow:auto;border:2px solid var(--line);border-radius:12px;padding:0 12px;font-size:15px" tabindex="0"><p style="font-weight:800;font-size:18px">${esc(st.terms.title)}</p>${md(st.terms.text.replace(/^#\s+.*$/m, ''))}</div>
<label class="small" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="accept" value="1" required style="margin-top:2px"> <span>I accept these terms (version ${+st.terms.version}) for my business</span></label>
<button type="submit">Accept and turn on</button></form>` : `<p class="msg bad" role="alert">${esc(el.text)}</p>`}
<a class="btn sec" href="/settings">Back to Settings</a>`, { user: req.user }));
  };
  app.get('/settings/publish', needUser(), needOwner, needHub, async (req, res, next) => { try { await acceptPage(req, res); } catch (e) { next(e); } });
  app.post('/settings/publish/on', sameOrigin, needUser(), needOwner, needHub, form, async (req, res, next) => { try {
    const b = req.body || {}, v = await details(b, req.user), show = t => acceptPage(req, res, t, v);
    if (b.accept !== '1') return show('Tick the box to accept the terms.');
    if (!EMAIL.test(v.email) || !v.business) return show(WHY.details);
    if (!(await eligibility()).ok) return acceptPage(req, res);
    const r = await call('POST', '/api/app/link', { json: { ...v, accept_terms: true, terms_version: +b.terms_version } }); forget();
    if (r.status !== 200) return show(why(r));
    await pool.query('INSERT INTO acceptances (user_id,email,doc,version) VALUES ($1,$2,$3,$4)', [req.user.id, req.user.email, DOC, +b.terms_version]);
    events('hub_on', req.user.id, null, 'terms ' + (+b.terms_version));
    res.redirect(303, '/settings?hub=on#publish');
  } catch (e) { next(e); } });
  app.post('/settings/publish/details', sameOrigin, needUser(), needOwner, needHub, form, async (req, res, next) => { try {
    const r = await call('POST', '/api/app/link', { json: await details(req.body || {}, req.user) }); forget();
    res.redirect(303, '/settings?hub=' + (r.status === 200 ? 'saved' : encodeURIComponent(r.j.error || 'down')) + '#publish');
  } catch (e) { next(e); } });
  app.post('/settings/publish/off', sameOrigin, needUser(), needOwner, needHub, form, async (req, res, next) => { try {
    const r = await call('POST', '/api/app/unlink', { ms: 15000 }); forget();
    if (r.status !== 200) return res.redirect(303, '/settings?hub=' + encodeURIComponent(r.j.error || 'down') + '#publish');
    await pool.query('UPDATE jobs SET hub_slug=NULL, hub_at=NULL, hub_stale=false WHERE hub_slug IS NOT NULL');
    events('hub_off', req.user.id);
    res.redirect(303, '/settings?hub=off#publish');
  } catch (e) { next(e); } });

  // ---------- one video ----------
  const guessCat = (j, cats) => { const w = String(j.job_type || '').split(/[\s']/)[0].toLowerCase(); return j.hub_trade || (w ? cats.find(c => c.toLowerCase().includes(w)) : '') || ''; };
  async function jobCard(j, q) {
    const c = await conf(); if (!c) return '';
    const st = await status(), on = j.hub_slug, name = (st && st.hub) || NAME;
    const said = q && q.hub ? msg(SAID[q.hub] || WHY[q.hub] || `${NAME} could not be reached. Nothing changed. Try again in a few minutes.`, !SAID[q.hub]) : '';
    const wrap = h => `<div class="card" id="publish" style="margin-top:10px"><h2 style="margin:0">${on ? `✔ On ${esc(name)}` : `Publish to ${esc(name)}`}</h2>${said}${h}</div>`;
    const remove = on ? `<form method="post" action="/jobs/${j.id}/publish/remove" onsubmit="return confirm('Take this video off ${esc(name).replace(/'/g, '')}?')"><button class="bad small" type="submit">Take it off ${esc(name)}</button></form>` : '';
    const seeIt = on ? `<a class="btn sec small" href="${esc(c.url)}/job/${esc(on)}" target="_blank" rel="noopener">View on ${esc(name)}</a>` : '';
    if (!st || st.down) return wrap(`<p class="small" style="margin:0">${esc(name)} can't be reached just now. Try again in a few minutes.</p>`);
    if (!st.linked) return on ? wrap(remove) : wrap(`<p class="small" style="margin:0">Put this video on ${esc(name)} so customers can find you.</p><a class="btn sec" href="/settings#publish">Turn publishing on in Settings</a>`);
    if (!st.terms_ok) return wrap(`<p class="small" style="margin:0">The terms have changed. Accept the new version first.</p><a class="btn sec" href="/settings/publish">Read the new terms</a>`);
    if (on && !j.hub_stale) return wrap(`<div style="display:flex;gap:8px;flex-wrap:wrap">${seeIt}${remove}</div>`);
    if (!['approved', 'shared'].includes(j.state)) return on ? wrap(`<p class="small" style="margin:0">This video has been remade. ${esc(name)} still shows the old one. Approve the new one, then update it here.</p><div style="display:flex;gap:8px;flex-wrap:wrap">${seeIt}${remove}</div>`) : '';
    if (!st.hub_open) return wrap(`<p class="small" style="margin:0">Publishing opens when ${esc(name)} launches.</p>${remove}`);
    const el = await eligibility();
    if (!el.ok) return wrap(`<p class="small" style="margin:0">${esc(el.text)}</p>${remove}`);
    const cat = guessCat(j, st.categories), title = j.hub_title || (j.job_type || 'Clear-up') + (j.area ? ' in ' + j.area : '');
    return wrap(`${on ? `<p class="small" style="margin:0">This video has been remade. ${esc(name)} still shows the old one.</p>` : ''}<form method="post" action="/jobs/${j.id}/publish" style="display:grid;gap:10px">
<label class="f">Title<input name="title" required maxlength="80" value="${esc(title)}"></label>
<label class="f">Type of waste<select name="trade" required>${cat ? '' : '<option value="">Choose…</option>'}${st.categories.map(t => `<option${t === cat ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
<label class="small" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="confirm" value="1" required style="margin-top:2px"> <span>These are my own photos of my own job, with no house numbers, number plates or people's faces showing.</span></label>
<button type="submit">${on ? `Update on ${esc(name)}` : `Publish to ${esc(name)}`}</button></form>${remove}`);
  }
  const back = (res, id, code) => res.redirect(303, `/jobs/${id}?hub=${encodeURIComponent(code)}#publish`);
  app.post('/jobs/:id/publish', sameOrigin, needUser(), needOwner, needHub, form, async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id), b = req.body || {};
    if (!j) return res.redirect(303, '/');
    if (!['approved', 'shared'].includes(j.state) || !j.video) return back(res, j.id, 'video');
    const title = clean(b.title, 80), trade = clean(b.trade, 60);
    if (!title || !trade || b.confirm !== '1') return back(res, j.id, 'details');
    if (!(await eligibility()).ok) return res.redirect(303, `/jobs/${j.id}#publish`);
    const kinds = (await pool.query('SELECT DISTINCT kind FROM job_photos WHERE job_id=$1', [j.id])).rows.map(r => r.kind.toUpperCase()), dir = jobsMod.dirOf(j.id);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ external_id: j.slug, title, trade, description: j.area || '', stages: kinds.join(','), voice: j.voice_id ? '1' : '0', confirm: '1' })) fd.append(k, v);
    fd.append('video', await fs.openAsBlob(path.join(dir, 'video.mp4'), { type: 'video/mp4' }), 'video.mp4');
    if (fs.existsSync(path.join(dir, 'cover.jpg'))) fd.append('cover', await fs.openAsBlob(path.join(dir, 'cover.jpg'), { type: 'image/jpeg' }), 'cover.jpg');
    const r = await call('POST', '/api/app/jobs', { body: fd, ms: 180000 });
    if (r.status === 202) {
      await pool.query('UPDATE jobs SET hub_slug=$2, hub_at=now(), hub_stale=false, hub_title=$3, hub_trade=$4 WHERE id=$1', [j.id, r.j.slug, title, trade]);
      events('hub_published', req.user.id, j.id); return back(res, j.id, 'sent');
    }
    forget();
    if (r.j.error === 'terms_needed') return res.redirect(303, '/settings/publish');
    back(res, j.id, r.j.error || 'down');
  } catch (e) { next(e); } });
  const takeDown = async j => { const r = await call('DELETE', `/api/app/jobs/${encodeURIComponent(j.slug)}`); if (r.status !== 200) return false; await pool.query('UPDATE jobs SET hub_slug=NULL, hub_at=NULL, hub_stale=false WHERE id=$1', [j.id]); return true; };
  app.post('/jobs/:id/publish/remove', sameOrigin, needUser(), needOwner, needHub, form, async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!j) return res.redirect(303, '/');
    if (j.hub_slug && !(await takeDown(j))) return back(res, j.id, 'down');
    events('hub_removed', req.user.id, j.id); back(res, j.id, 'removed');
  } catch (e) { next(e); } });

  // a job deleted here must not stay public on the hub: try now, and every hour until it is gone
  const sweep = async () => { try {
    if (!(await conf())) return;
    for (const j of (await pool.query('SELECT id,slug FROM jobs WHERE deleted_at IS NOT NULL AND hub_slug IS NOT NULL LIMIT 50')).rows) await takeDown(j);
  } catch (e) { console.error('hub sweep', e.message); } };
  setInterval(sweep, 3600e3).unref();

  return { settingsCard, jobCard, flash: q => q.hub ? msg(SAID[q.hub] || WHY[q.hub] || `${NAME} could not be reached. Nothing changed. Try again in a few minutes.`, !SAID[q.hub]) : '', sweep };
};
