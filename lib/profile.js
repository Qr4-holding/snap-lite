// The owner's business details (Settings, owner only): trading name, mobile, base town, vans, insurance. One business per install, kept in the settings table.
const todayUK = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const nice = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// UK mobile: 07xxx xxxxxx, or +44 7xxx xxxxxx. Stored as 07xxxxxxxxx.
function mobile(s) {
  let d = String(s || '').replace(/[\s\-().]/g, '');
  if (/^\+447/.test(d)) d = '0' + d.slice(3); else if (/^00447/.test(d)) d = '0' + d.slice(4); else if (/^447\d{9}$/.test(d)) d = '0' + d.slice(2);
  return /^07[1-57-9]\d{8}$/.test(d) ? d : '';
}
const mobileNice = m => m ? `${m.slice(0, 5)} ${m.slice(5)}` : '';

// UK number plates: current (AB12 CDE), older prefix (A123 BCD), suffix (ABC 123D), and dateless / Northern Ireland styles. Spaces stripped, upper-case.
const PLATES = [/^[A-Z]{2}\d{2}[A-Z]{3}$/, /^[A-Z]\d{1,3}[A-Z]{3}$/, /^[A-Z]{3}\d{1,3}[A-Z]$/, /^[A-Z]{1,3}\d{1,4}$/, /^\d{1,4}[A-Z]{1,3}$/];
const plate = s => { const p = String(s || '').toUpperCase().replace(/[\s\-]+/g, ''); return PLATES.some(r => r.test(p)) ? p : ''; };
// a box of plates, one per line or separated by commas; returns the good ones (no repeats) and the ones that did not look like a plate
function plates(text) {
  const good = [], bad = [];
  for (const raw of String(text || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean)) { const p = plate(raw); if (!p) bad.push(raw.slice(0, 20)); else if (!good.includes(p)) good.push(p); }
  return { good: good.slice(0, 10), bad };
}
const platePretty = p => /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(p) ? p.slice(0, 4) + ' ' + p.slice(4) : p;

const area = s => String(s || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);

module.exports = function profile(pool) {
  const K = ['trading_name', 'owner_mobile', 'base_area', 'vans', 'ins_name', 'ins_expiry'];
  const put = (k, v) => pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
  async function get(now) {
    let rows = []; try { rows = (await pool.query('SELECT key,value FROM settings WHERE key = ANY($1)', [K])).rows; } catch (e) {}
    const o = Object.fromEntries(rows.map(r => [r.key, r.value]));
    let vans = []; try { vans = JSON.parse(o.vans || '[]'); } catch (e) {}
    const insured = !!o.ins_expiry && validDate(o.ins_expiry) && o.ins_expiry >= todayUK(now);   // shown only while current; the expiry day itself still counts
    return { mobile: o.owner_mobile || '', mobileNice: mobileNice(o.owner_mobile), area: o.base_area || '', vans, ins_name: o.ins_name || '', ins_expiry: o.ins_expiry || '',
      insured, insuranceLine: insured ? `Insured (self-declared), expires ${nice(o.ins_expiry)}` : '' };
  }
  // v: raw form fields. Returns { ok, problems: [{field, why}] }. Nothing is saved if something is wrong, so the owner fixes it in one go.
  async function save(v) {
    const problems = [], out = {};
    const m = String(v.mobile || '').trim();
    if (m) { const n = mobile(m); n ? out.owner_mobile = n : problems.push({ field: 'mobile', why: "That doesn't look like a UK mobile number. It should start 07, for example 07700 900123." }); } else out.owner_mobile = '';
    out.base_area = area(v.area);
    const pl = plates(v.vans);
    if (pl.bad.length) problems.push({ field: 'vans', why: `${pl.bad.map(b => '"' + b + '"').join(', ')} ${pl.bad.length > 1 ? "don't" : "doesn't"} look like a UK number plate. Put one per line, for example AB12 CDE.` });
    else out.vans = JSON.stringify(pl.good);
    const ie = String(v.ins_expiry || '').trim(), iname = String(v.ins_name || '').replace(/[<>]/g, '').trim().slice(0, 100);
    if (ie && !validDate(ie)) problems.push({ field: 'insurance', why: 'The insurance expiry date is not a real date. Pick it from the calendar.' });
    else if (ie && !iname) problems.push({ field: 'insurance', why: 'Add the name of the insurer as well, or clear the expiry date.' });
    else { out.ins_name = iname; out.ins_expiry = ie; }
    if (problems.length) return { ok: false, problems };
    for (const [k, val] of Object.entries(out)) await put(k, val);
    return { ok: true, problems: [] };
  }
  return { get, save };
};
module.exports.mobile = mobile; module.exports.plate = plate; module.exports.plates = plates; module.exports.platePretty = platePretty; module.exports.mobileNice = mobileNice;
