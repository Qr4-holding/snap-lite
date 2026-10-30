// Outputs from the job record: the transfer note PDF (owner), and the records export as CSV or JSON (owner).
const sharp = require('sharp');
const { esc } = require('./lib/util');
const R = require('./lib/record');
const notepdf = require('./lib/notepdf');
const EX = require('./lib/export');
const regFor = require('./lib/reg');

module.exports = function outputs({ app, pool, SKIN, ui, acct, jobsMod, events }) {
  const { needUser, needOwner } = acct;

  // who is carrying: the register's details, the owner's trading name, phone and registered office
  async function carrierInfo() {
    const rg = await regFor(pool, SKIN).get(), prof = await acct.profile.get();
    const web = String(SKIN.web || '').trim(), www = web && !/^(www\.|https?:)/i.test(web) ? 'www.' + web : web;
    return { rg, prof, carrier: {
      trading: rg.trading || rg.registerName || SKIN.short_name || SKIN.name, phone: prof.mobileNice || SKIN.phone || '', web: www, email: SKIN.email || '',
      regNumber: rg.number, tier: rg.tier, address: rg.address || '', companyName: notepdf.companyName(rg.registerName), companyNumber: rg.company || '',
      office: prof.office || SKIN.registered_office || rg.address || '', vat: prof.vat || '' } };
  }

  app.get('/jobs/:id/transfer-note.pdf', needUser(), needOwner, async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!j) return res.redirect(303, '/');
    const { prof, carrier } = await carrierInfo();
    const drv = (await pool.query('SELECT name FROM users WHERE id=$1', [j.user_id])).rows[0];
    const q = j.qty || j.qty_est;
    let logoBuf = null; try { logoBuf = await sharp(acct.logo.current()).flatten({ background: '#ffffff' }).png().toBuffer(); } catch (e) {}
    const buf = await notepdf.build({ carrier, accent: SKIN.accent, logoBuf, qtyLabel: q ? R.qtyText(q, prof.vanCap) : '',
      job: { commercial: j.commercial, custBusiness: j.cust_business, custName: j.cust_name, custAddr: j.cust_addr, sic: j.commercial ? j.sic : '', addr1: j.addr1, area: j.area, postcode: j.postcode,
        ticket: j.tip_ticket, jobType: j.job_type, date: EX.lonDate(j.created_at), wasteDesc: j.waste_desc, ewc: j.ewc, van: j.van ? require('./lib/profile').platePretty(j.van) : '',
        tipName: j.tip_name, tipAddr: j.tip_addr, tipDate: j.tip_date, tipLicence: j.tip_licence, driver: (drv && drv.name) || '' } });
    events('transfer_note', req.user.id, j.id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="transfer-note-${j.id}.pdf"`, 'Cache-Control': 'private, no-store' }).send(buf);
  } catch (e) { next(e); } });

  // the export: every job in the date range, including jobs whose photos and video were deleted (the record is kept)
  async function rows(req) {
    const from = String(req.query.from || '').trim(), to = String(req.query.to || '').trim();
    if ((from && !EX.isoOk(from)) || (to && !EX.isoOk(to))) return { error: 'baddate' };
    if (from && to && from > to) return { error: 'order' };
    const r = (await pool.query(`SELECT j.*, u.name AS driver_name FROM jobs j LEFT JOIN users u ON u.id=j.user_id
      WHERE j.biz_id=$1 AND ($2::date IS NULL OR (j.created_at AT TIME ZONE 'Europe/London')::date >= $2::date) AND ($3::date IS NULL OR (j.created_at AT TIME ZONE 'Europe/London')::date <= $3::date)
      ORDER BY j.created_at, j.id`, [req.user.biz_id, from || null, to || null])).rows;
    const { prof, carrier } = await carrierInfo();
    return { rows: r, from, to, ctx: { cap: prof.vanCap, carrier: { name: carrier.trading, registration_number: carrier.regNumber, tier: carrier.tier } } };
  }
  const bad = (res, e) => res.redirect(303, '/settings?m=' + (e === 'order' ? 'exportorder' : 'exportbad') + '#export');
  app.get('/settings/export.csv', needUser(), needOwner, async (req, res, next) => { try {
    const x = await rows(req); if (x.error) return bad(res, x.error);
    events('records_export', req.user.id, null, 'csv ' + x.rows.length);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="job-records${x.from || x.to ? `-${x.from || 'start'}-to-${x.to || 'today'}` : ''}.csv"`, 'Cache-Control': 'private, no-store' }).send(EX.toCsv(x.rows, x.ctx));
  } catch (e) { next(e); } });
  app.get('/settings/export.json', needUser(), needOwner, async (req, res, next) => { try {
    const x = await rows(req); if (x.error) return bad(res, x.error);
    events('records_export', req.user.id, null, 'json ' + x.rows.length);
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="job-records${x.from || x.to ? `-${x.from || 'start'}-to-${x.to || 'today'}` : ''}.json"`, 'Cache-Control': 'private, no-store' })
      .send(JSON.stringify({ format: 'snaplite-job-records', version: 1, exported_at: new Date().toISOString(), from: x.from || null, to: x.to || null, count: x.rows.length, records: x.rows.map(j => EX.toRecord(j, x.ctx, 'json')) }, null, 2));
  } catch (e) { next(e); } });
  return { carrierInfo };
};
