// The per-job record: collection and customer addresses, quantity, items and flags, waste description and EWC code, van, disposal site and tip receipt.
// None of it is in the video, so it can be filled in or changed at any stage, with no remake and no re-approval.
const express = require('express');
const multer = require('multer');
const fs = require('fs'), path = require('path');
const { esc, clean, sameOrigin } = require('./lib/util');
const R = require('./lib/record');
const photo = require('./lib/photo');

module.exports = function record({ app, pool, SKIN, ui, acct, jobsMod, events, secrets }) {
  const { page, msg } = ui;
  const { needUser } = acct;
  const vis = require('./lib/vision')(secrets, SKIN);
  const form = express.urlencoded({ extended: false, limit: '20kb' });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 4 } });
  const busy = new Set();

  // who may change a job's record: the owner, or the person who made the job (it never touches the video)
  const mayRecord = (u, j) => j && (u.role === 'owner' || j.user_id === u.id);
  const eff = j => j.qty || j.qty_est || '';
  const flagsOf = j => R.cleanFlags(j.flags || {});
  const put = (k, v) => pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);

  // ---- reading the photos: items, flags and a quantity estimate. Runs in the background when a video is started; "Read the photos again" runs it on demand.
  async function analyse(jobId, { force = false, refresh = false } = {}) {
    if (busy.has(jobId)) return { status: 'busy' };
    busy.add(jobId);
    try {
      const j = (await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];
      if (!j || (!force && !refresh && j.items)) return { status: 'skipped' };
      const dir = jobsMod.dirOf(jobId);
      const ph = (await pool.query("SELECT kind,seq FROM job_photos WHERE job_id=$1 AND kind IN ('before','during') ORDER BY CASE kind WHEN 'before' THEN 0 ELSE 1 END, seq", [jobId])).rows;
      const bufs = ph.map(p => { try { return fs.readFileSync(path.join(dir, `${p.kind}${p.seq}.jpg`)); } catch (e) { return null; } }).filter(Boolean);
      if (!bufs.length) return { status: 'nophotos' };
      const cap = (await acct.profile.get()).vanCap;
      const r = await vis.analyse(bufs, j.job_type, cap);
      if (r.error) { await pool.query('UPDATE jobs SET analyse_note=$2 WHERE id=$1', [jobId, r.error === 'nokey' ? 'nokey' : 'failed']); events('items_failed', null, jobId, r.error); return { status: 'failed', error: r.error }; }
      const desc = R.describe(r.items, j.job_type, SKIN), code = R.ewcFor(r.items, j.job_type, SKIN);
      // what the owner has typed is kept unless they asked to read the photos again
      await pool.query(`UPDATE jobs SET items=$2::jsonb, flags=$3::jsonb, qty_est=$4, waste_desc=CASE WHEN $6 OR waste_desc='' THEN $5 ELSE waste_desc END, ewc=CASE WHEN $6 OR ewc='' THEN $7 ELSE ewc END, analysed_at=now(), analyse_note='' WHERE id=$1`,
        [jobId, JSON.stringify(r.items), JSON.stringify(r.flags), r.qty, desc, force, code]);
      events('items_read', null, jobId, `${r.items.length} items`);
      return { status: 'ok', items: r.items, flags: r.flags, qty: r.qty };
    } catch (e) { events('items_failed', null, jobId, String(e.message).slice(0, 120)); return { status: 'failed', error: e.message }; }
    finally { busy.delete(jobId); }
  }

  // ---- the tip receipt: kept as proof of disposal, never in the video. The model reads site, date and ticket number into the editable boxes.
  const receiptFile = id => path.join(jobsMod.dirOf(id), 'receipt.jpg');
  async function saveReceipt(j, buffer) {
    const r = await photo.normalize(buffer);
    fs.mkdirSync(jobsMod.dirOf(j.id), { recursive: true }); fs.writeFileSync(receiptFile(j.id), r.full);
    await pool.query('UPDATE jobs SET has_receipt=true WHERE id=$1', [j.id]);
    const read = await vis.readReceipt(r.full);
    let note = '';
    if (read.error) note = read.error === 'nokey' ? 'noread' : 'failed';
    else {
      const sites = (await acct.profile.get()).sites, low = s => String(s || '').toLowerCase();
      const hit = read.site ? sites.find(x => low(x.name).includes(low(read.site)) || low(read.site).includes(low(x.name)) || (read.permit && x.licence && x.licence === read.permit)) : null;
      // a site already in the usual list brings its address and licence number; the receipt only fills boxes that are still empty
      await pool.query(`UPDATE jobs SET tip_name=CASE WHEN tip_name='' THEN $2 ELSE tip_name END, tip_addr=CASE WHEN tip_addr='' THEN $3 ELSE tip_addr END, tip_licence=CASE WHEN tip_licence='' THEN $4 ELSE tip_licence END,
        tip_date=CASE WHEN tip_date='' THEN $5 ELSE tip_date END, tip_ticket=CASE WHEN tip_ticket='' THEN $6 ELSE tip_ticket END WHERE id=$1`,
        [j.id, hit ? hit.name : read.site, hit ? hit.address : read.address, hit ? hit.licence : read.permit, read.date, read.ticket]);
      if (!read.site && !read.date && !read.ticket) note = 'unclear';
    }
    events('receipt_added', null, j.id, note);
    return note;
  }

  // ---- pieces of page
  const qtyRow = (j, cap, selName = 'qty') => {
    const cur = eff(j);
    return `<div style="display:flex;flex-wrap:wrap;gap:8px">${R.QTY.map(q => `<button type="submit" name="${selName}" value="${q.key}" class="${cur === q.key ? 'chip on' : 'chip'}" style="${cur === q.key ? 'background:var(--a);color:#fff' : ''}" aria-pressed="${cur === q.key}">${esc(q.label)}</button>`).join('')}</div>`;
  };
  const sourceNote = j => !eff(j) ? '' : j.qty ? '' : ' <span class="small">(estimated from the photos; tap to change)</span>';

  async function forJobPage(u, j, may) {
    const warn = R.warnings(flagsOf(j)).map(w => `<p class="msg bad" role="alert">${esc(w)}</p>`).join('');
    if (!mayRecord(u, j)) return { warn, card: '' };
    const cap = (await acct.profile.get()).vanCap, cur = eff(j);
    const lines = [
      cur ? `Quantity: <b>${esc(R.qtyText(cur, cap))}</b>${j.qty ? '' : ' (estimated)'}` : '',
      j.waste_desc ? `Waste: ${esc(j.waste_desc)}` : '',
      u.role === 'owner' && j.ewc ? `EWC code: ${esc(j.ewc)}` : '',
      j.tip_name ? `Disposal site: ${esc(j.tip_name)}${j.tip_date ? ' · ' + esc(j.tip_date) : ''}` : '',
      j.has_receipt ? 'Tip receipt kept.' : ''
    ].filter(Boolean);
    const note = j.analyse_note === 'nokey' ? '<p class="small" style="margin:0">The photos were not read because the writing and photo-reading key is not set up yet.</p>' : j.analyse_note === 'failed' ? '<p class="small" style="margin:0">The photos could not be read this time. Tap Read the photos again on the job record.</p>' : '';
    return { warn, card: `<div class="card" style="margin-top:12px"><b>Job record</b>
<p class="small" style="margin:0">How much did you take? ${sourceNote(j)}</p>
<form method="post" action="/jobs/${j.id}/qty">${qtyRow(j, cap)}</form>
${lines.length ? `<p class="small" style="margin:0">${lines.join('<br>')}</p>` : ''}${note}
<a class="btn sec" href="/jobs/${j.id}/record">${j.waste_desc || j.tip_name || j.cust_name ? 'Open the job record' : 'Fill in the job record'}</a>
<p class="small" style="margin:0">Not in the video. Fill in what you can: it saves typing the transfer note later.</p></div>` };
  }

  // ---- the full record form
  const val = (over, k, d) => esc(over && over.values && over.values[k] != null ? over.values[k] : d);
  async function formHtml(u, j, over = {}) {
    const prof = await acct.profile.get(), cap = prof.vanCap, owner = u.role === 'owner';
    const fl = over.values && over.values.flags ? R.cleanFlags(over.values.flags) : flagsOf(j);
    const er = f => { const x = (over.problems || []).find(p => p.field === f); return x ? `<span class="small" style="color:#b00020">${esc(x.why)}</span>` : ''; };
    const commercial = over.values ? !!over.values.commercial : j.commercial;
    const curQ = over.values && over.values.qty != null ? over.values.qty : eff(j);
    const sitesSel = prof.sites.length ? `<label class="f">Which site?<select name="site_pick"><option value="">Choose a usual site…</option>${prof.sites.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join('')}<option value="">A different site (fill in below)</option></select></label>` : '';
    const flagLabel = { pops: 'Upholstered seating (sofa or chair)', fridge: 'Fridge or freezer', plasterboard: 'Plasterboard', gas: 'Gas bottles', tyres: 'Tyres', asbestos: 'Possible asbestos' };
    return page('Job record', `
<h1>Job record</h1>${over.flash ? msg(over.flash, !!over.bad) : ''}
<p class="small">${esc(j.job_type || 'Job')}${j.area ? ' · ' + esc(j.area) : ''}. None of this is in the video. Fill in what you can, and leave the rest empty.</p>
${R.warnings(fl).map(w => `<p class="msg bad" role="alert">${esc(w)}</p>`).join('')}
<h2>Tip receipt or weighbridge ticket</h2>
<form class="card" method="post" action="/jobs/${j.id}/receipt" enctype="multipart/form-data">
${j.has_receipt ? `<img src="/api/jobs/${j.id}/receipt?v=${Date.now()}" alt="Tip receipt" style="max-width:100%;max-height:280px;border-radius:10px">` : '<p class="small" style="margin:0">Take a photo of the receipt, or pick one from your gallery. We read the site, date and ticket number into the boxes below, and keep the photo as proof of disposal.</p>'}
<label class="f">${j.has_receipt ? 'Replace it' : 'Add the receipt'}<input name="file" type="file" accept="image/*" required></label><button type="submit">${j.has_receipt ? 'Replace and read it' : 'Add and read it'}</button></form>
${j.has_receipt ? `<form method="post" action="/jobs/${j.id}/receipt/remove" onsubmit="return confirm('Remove the receipt photo?')"><button class="sec small" type="submit">Remove the receipt photo</button></form>` : ''}
<form method="post" action="/jobs/${j.id}/record">
<h2>Where we collected from</h2><div class="card">
<label class="f">First line of the address <span class="small">(optional)</span><input name="addr1" maxlength="80" value="${val(over, 'addr1', j.addr1)}" placeholder="12 High Street"></label>
<div style="display:grid;grid-template-columns:3fr 2fr;gap:10px"><label class="f">Town or area<input name="area" maxlength="80" value="${val(over, 'area', j.area)}"></label><label class="f">Postcode<input name="postcode" maxlength="9" autocapitalize="characters" value="${val(over, 'postcode', j.postcode)}" placeholder="LS12 2PY">${er('postcode')}</label></div></div>
<h2>The customer</h2><div class="card">
<label class="f">Customer name <span class="small">(optional)</span><input name="cust_name" maxlength="80" value="${val(over, 'cust_name', j.cust_name)}"></label>
<label class="f">Customer address <span class="small">(optional; only if it is not where we collected from)</span><textarea name="cust_addr" rows="3" maxlength="200">${val(over, 'cust_addr', j.cust_addr)}</textarea></label>
<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="commercial" value="1" style="width:auto"${commercial ? ' checked' : ''} onchange="document.getElementById('biz').style.display=this.checked?'grid':'none'"> <span>This is a commercial job (the customer is a business)</span></label>
<div id="biz" style="display:${commercial ? 'grid' : 'none'};gap:10px"><label class="f">Customer's business name<input name="cust_business" maxlength="100" value="${val(over, 'cust_business', j.cust_business)}"></label>
<label class="f">SIC code <span class="small">(5 digits, optional) <a href="https://resources.companieshouse.gov.uk/sic/" target="_blank" rel="noopener">Find a SIC code</a></span><input name="sic" inputmode="numeric" maxlength="5" value="${val(over, 'sic', j.sic)}" placeholder="38110">${er('sic')}</label></div></div>
<h2>The load</h2><div class="card">
<p class="small" style="margin:0">How much did you take?${sourceNote(j)}</p>
<div style="display:flex;flex-wrap:wrap;gap:12px">${R.QTY.map(q => `<label style="display:flex;gap:6px;align-items:center"><input type="radio" name="qty" value="${q.key}" style="width:auto"${curQ === q.key ? ' checked' : ''}> ${esc(q.label)}</label>`).join('')}</div>
<p class="small" style="margin:0">A full load is ${esc(R.cubic(cap))} cubic yards (your van size, in Settings).</p>
${prof.vans.length > 1 ? `<label class="f">Which van?<select name="van">${prof.vans.map(v => `<option value="${esc(v)}"${(over.values && over.values.van != null ? over.values.van : j.van) === v ? ' selected' : ''}>${esc(require('./lib/profile').platePretty(v))}</option>`).join('')}</select></label>` : ''}
<label class="f">What was it? <span class="small">(one short line, made from the photos; change it if it is wrong)</span><input name="waste_desc" maxlength="140" value="${val(over, 'waste_desc', j.waste_desc)}" placeholder="mixed household clearance: sofa, bags, carpet"></label>
${owner ? `<label class="f">EWC code <span class="small">(the waste code; set from the job type and what is in the photos)</span><input name="ewc" maxlength="9" inputmode="numeric" value="${val(over, 'ewc', j.ewc)}" placeholder="20 03 07">${er('ewc')}</label>` : ''}
${j.items && j.items.length ? `<p class="small" style="margin:0">Seen in the photos: ${esc(j.items.map(i => (i.count > 1 ? i.count + ' x ' : '') + i.item).join(', '))}</p>` : ''}
<p class="small" style="margin:0">Does the load have any of these? Tick what is there.</p>
<div style="display:grid;gap:6px">${R.FLAGS.map(f => `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="flag_${f}" value="1" style="width:auto"${fl[f] ? ' checked' : ''}> ${esc(flagLabel[f])}</label>`).join('')}</div></div>
<h2>Where it went</h2><div class="card">${sitesSel}
<label class="f">Site name<input name="tip_name" maxlength="80" value="${val(over, 'tip_name', j.tip_name)}"></label>
<label class="f">Site address<input name="tip_addr" maxlength="160" value="${val(over, 'tip_addr', j.tip_addr)}"></label>
<label class="f">Site licence or permit number<input name="tip_licence" maxlength="30" autocapitalize="characters" value="${val(over, 'tip_licence', j.tip_licence)}">${er('tip_licence')}</label>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><label class="f">Date<input name="tip_date" type="date" value="${val(over, 'tip_date', j.tip_date)}">${er('tip_date')}</label><label class="f">Ticket number<input name="tip_ticket" maxlength="40" value="${val(over, 'tip_ticket', j.tip_ticket)}"></label></div></div>
<button type="submit">Save the job record</button></form>
<form method="post" action="/jobs/${j.id}/record/read" style="margin-top:10px"><button class="sec" type="submit">Read the photos again</button><p class="small" style="margin:6px 0 0">This lists the items, the flags and the quantity again from the photos, and replaces the line and code above.</p></form>
<a class="btn sec" href="/jobs/${j.id}" style="margin-top:10px">Back to the job</a>`, { user: u });
  }

  const flashes = { saved: 'Job record saved.', receipt: 'Receipt saved and read. Check the boxes below and correct anything that is wrong.', noread: 'Receipt saved. We could not read it automatically yet, so please type the site, date and ticket number.', unclear: 'Receipt saved, but the writing was not clear enough to read. Please type the site, date and ticket number.', receiptfail: 'Receipt saved, but reading it failed this time. Please type the site, date and ticket number.', receiptgone: 'Receipt photo removed.', receiptbad: "That file couldn't be read as a picture. Try taking the photo again.", reread: 'Photos read again.', rereadfail: "The photos couldn't be read just now. Nothing was changed. Try again in a minute." };

  app.get('/jobs/:id/record', needUser(), async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!mayRecord(req.user, j)) return res.redirect(303, j ? `/jobs/${j.id}` : '/');
    const m = req.query.m; res.set('Cache-Control', 'no-store').send(await formHtml(req.user, j, { flash: flashes[m] || '', bad: /bad|fail/.test(m || '') }));
  } catch (e) { next(e); } });

  // the one-tap quantity row on the job page
  app.post('/jobs/:id/qty', sameOrigin, needUser(), form, async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!mayRecord(req.user, j)) return res.redirect(303, j ? `/jobs/${j.id}` : '/');
    const q = String((req.body || {}).qty || '');
    if (R.QTY_KEYS.includes(q)) await pool.query('UPDATE jobs SET qty=$2 WHERE id=$1', [j.id, q]);
    res.redirect(303, `/jobs/${j.id}`);
  } catch (e) { next(e); } });

  const readForm = (b, j, owner, sites, vans) => {
    const problems = [], t = R.text, v = {};
    v.addr1 = t(b.addr1, 80); v.area = clean(String(b.area || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' '), 80);
    const rawPc = t(b.postcode, 12); v.postcode = R.postcode(rawPc); if (rawPc && !v.postcode) problems.push({ field: 'postcode', why: "That postcode doesn't look right. It should look like LS12 2PY. Fix it or clear the box." });
    v.cust_name = t(b.cust_name, 80); v.cust_addr = String(b.cust_addr || '').replace(/[\u0000-\u0008\u000b-\u001f<>]/g, ' ').split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('\n').slice(0, 200);
    v.commercial = b.commercial === '1' || b.commercial === 'on'; v.cust_business = t(b.cust_business, 100);
    const rawSic = String(b.sic || '').replace(/\s+/g, ''); v.sic = R.sic(rawSic); if (v.commercial && rawSic && !v.sic) problems.push({ field: 'sic', why: 'A SIC code is 5 digits, for example 38110. Fix it or clear the box.' });
    v.qty = R.QTY_KEYS.includes(b.qty) ? b.qty : null;                              // null = leave as it is
    v.van = vans.includes(String(b.van || '')) ? String(b.van) : null;
    v.waste_desc = t(b.waste_desc, 140);
    if (owner) { const raw = String(b.ewc || '').trim(); v.ewc = R.ewcClean(raw); if (raw && !v.ewc) problems.push({ field: 'ewc', why: 'An EWC code is six digits, for example 20 03 07. Fix it or clear the box.' }); }
    v.flags = R.cleanFlags(Object.fromEntries(R.FLAGS.map(f => [f, b['flag_' + f]])));
    // a usual site tapped from the list fills name, address and licence; otherwise what was typed is used
    const pick = b.site_pick !== '' && b.site_pick != null ? sites[parseInt(b.site_pick, 10)] : null;
    if (pick) { v.tip_name = pick.name; v.tip_addr = pick.address; v.tip_licence = pick.licence; }
    else { v.tip_name = t(b.tip_name, 80); v.tip_addr = t(b.tip_addr, 160); v.tip_licence = t(b.tip_licence, 30).toUpperCase(); }
    if (v.tip_licence && !/^[A-Z0-9 \/\-]{4,30}$/.test(v.tip_licence)) problems.push({ field: 'tip_licence', why: 'The licence or permit number should be letters and numbers only, for example JB3607UK.' });
    const rawD = String(b.tip_date || '').trim(); v.tip_date = R.isoDate(rawD); if (rawD && !v.tip_date) problems.push({ field: 'tip_date', why: 'Pick the date from the calendar.' });
    v.tip_ticket = t(b.tip_ticket, 40);
    return { v, problems };
  };
  app.post('/jobs/:id/record', sameOrigin, needUser(), form, async (req, res, next) => { try {
    const u = req.user, j = await jobsMod.getJob(u, req.params.id);
    if (!mayRecord(u, j)) return res.redirect(303, j ? `/jobs/${j.id}` : '/');
    const prof = await acct.profile.get(), owner = u.role === 'owner';
    const { v, problems } = readForm(req.body || {}, j, owner, prof.sites, prof.vans);
    if (problems.length) return res.status(400).set('Cache-Control', 'no-store').send(await formHtml(u, j, { flash: 'Not saved. Please fix what is marked in red and tap Save again.', bad: true, problems, values: { ...req.body, flags: v.flags, commercial: v.commercial, qty: req.body.qty } }));
    await pool.query(`UPDATE jobs SET addr1=$2, area=$3, postcode=$4, cust_name=$5, cust_addr=$6, commercial=$7, cust_business=$8, sic=$9, qty=COALESCE($10,qty), van=COALESCE($11,van),
      waste_desc=$12, ewc=CASE WHEN $13::boolean THEN $14 ELSE ewc END, flags=$15::jsonb, tip_name=$16, tip_addr=$17, tip_licence=$18, tip_date=$19, tip_ticket=$20 WHERE id=$1`,
      [j.id, v.addr1, v.area, v.postcode, v.cust_name, v.cust_addr, v.commercial, v.commercial ? v.cust_business : '', v.commercial ? v.sic : '', v.qty, v.van, v.waste_desc, owner, v.ewc || '', JSON.stringify(v.flags), v.tip_name, v.tip_addr, v.tip_licence, v.tip_date, v.tip_ticket]);
    if (v.van) await put('lastvan:' + u.id, v.van);
    events('record_saved', u.id, j.id);
    res.redirect(303, `/jobs/${j.id}/record?m=saved`);
  } catch (e) { next(e); } });

  app.post('/jobs/:id/record/read', sameOrigin, needUser(), form, async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!mayRecord(req.user, j)) return res.redirect(303, j ? `/jobs/${j.id}` : '/');
    const r = await analyse(j.id, { force: true });
    res.redirect(303, `/jobs/${j.id}/record?m=${r.status === 'ok' ? 'reread' : 'rereadfail'}`);
  } catch (e) { next(e); } });

  const uploadSafe = (req, res, next) => upload.single('file')(req, res, e => e ? res.redirect(303, `/jobs/${req.params.id}/record?m=receiptbad`) : next());
  app.post('/jobs/:id/receipt', sameOrigin, needUser(), uploadSafe, async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!mayRecord(req.user, j)) return res.redirect(303, j ? `/jobs/${j.id}` : '/');
    if (!req.file) return res.redirect(303, `/jobs/${j.id}/record?m=receiptbad`);
    let note; try { note = await saveReceipt(j, req.file.buffer); } catch (e) { return res.redirect(303, `/jobs/${j.id}/record?m=receiptbad`); }
    res.redirect(303, `/jobs/${j.id}/record?m=${note === 'noread' ? 'noread' : note === 'unclear' ? 'unclear' : note === 'failed' ? 'receiptfail' : 'receipt'}`);
  } catch (e) { next(e); } });
  app.post('/jobs/:id/receipt/remove', sameOrigin, needUser(), form, async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!mayRecord(req.user, j)) return res.redirect(303, j ? `/jobs/${j.id}` : '/');
    try { fs.unlinkSync(receiptFile(j.id)); } catch (e) {}
    await pool.query('UPDATE jobs SET has_receipt=false WHERE id=$1', [j.id]);
    res.redirect(303, `/jobs/${j.id}/record?m=receiptgone`);
  } catch (e) { next(e); } });
  app.get('/api/jobs/:id/receipt', needUser({ json: true }), async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!mayRecord(req.user, j) || !j.has_receipt) return res.status(404).end();
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'image/jpeg' }); fs.createReadStream(receiptFile(j.id)).on('error', () => res.status(404).end()).pipe(res);
  } catch (e) { next(e); } });

  // the record as data (the tests use it; the export in item 3 builds on the same fields)
  const recordJson = (j, cap) => ({ id: j.id, job_type: j.job_type, created_at: j.created_at, collection_address: { line1: j.addr1, area: j.area, postcode: j.postcode }, customer: { name: j.cust_name, address: j.cust_addr, commercial: j.commercial, business: j.cust_business, sic: j.sic },
    quantity: eff(j), quantity_source: j.qty ? 'owner' : j.qty_est ? 'estimate' : '', van_capacity_cubic_yards: cap, quantity_cubic_yards: R.qtyYards(eff(j), cap), items: j.items || [], flags: flagsOf(j), waste_description: j.waste_desc, ewc_code: j.ewc, van: j.van,
    disposal: { site: j.tip_name, address: j.tip_addr, licence: j.tip_licence, date: j.tip_date, ticket: j.tip_ticket, receipt: !!j.has_receipt } });
  app.get('/api/jobs/:id/record', needUser({ json: true }), async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!mayRecord(req.user, j)) return res.status(404).json({ error: "We can't find that job." });
    const rec = recordJson(j, (await acct.profile.get()).vanCap); if (req.user.role !== 'owner') delete rec.ewc_code;
    res.set('Cache-Control', 'no-store').json(rec);
  } catch (e) { next(e); } });

  return { forJobPage, analyse, recordJson };
};
