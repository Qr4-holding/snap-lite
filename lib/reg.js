// Waste carrier registration mark. Skin gives the defaults (reg_name, reg_number, reg_expiry); the owner can override them in Settings.
// The mark shows only while a number and an expiry date are set and today is not after the expiry date. It comes off the day after.
const KEYS = ['reg_name', 'reg_number', 'reg_expiry', 'reg_tier', 'reg_company', 'reg_date', 'reg_checked', 'trading_name'];
const ea = require('./ea');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = s => ISO.test(s || '') && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const todayUK = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });   // YYYY-MM-DD
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const nice = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const NAME_MAX = 40;

// pure: values in, what to show out (now is injectable for tests)
function evaluate({ name, number, expiry, tier, trading }, businessName, now = new Date()) {
  const n = String(trading || '').trim() || String(name || '').trim() || businessName, num = String(number || '').trim(), exp = String(expiry || '').trim();
  const today = todayUK(now), has = !!num && validDate(exp);
  const left = has ? daysBetween(today, exp) : null;
  const lower = tier === 'lower' || /^CBDL/i.test(num);   // lower tier covers your own waste only: no registered-carrier mark
  const active = has && left >= 0 && !lower;             // the expiry day itself still counts; gone the day after
  const text = !active ? '' : (n.length > NAME_MAX ? `Registered carrier · ${num}` : `${n} · Registered carrier · ${num}`);   // body tag
  const endText = active ? `Registered carrier · ${num}` : '';                                                              // end-card pill: never the name (the logo is on the card)
  return { name: n, number: num, expiry: exp, set: has, active, lower, expired: has && left < 0, daysLeft: left, warn: has && left <= 60, expiryNice: has ? nice(exp) : '', text, endText };
}

module.exports = function reg(pool, SKIN) {
  const defaults = () => ({ name: SKIN.reg_name || '', number: SKIN.reg_number || '', expiry: SKIN.reg_expiry || '' });
  async function raw() {
    const d = defaults(); let rows = [];
    try { rows = (await pool.query('SELECT key,value FROM settings WHERE key = ANY($1)', [KEYS])).rows; } catch (e) {}
    const o = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const pick = (k, dv) => k in o ? o[k] : dv;
    return { name: pick('reg_name', d.name), number: pick('reg_number', d.number), expiry: pick('reg_expiry', d.expiry), tier: o.reg_tier || '', company: o.reg_company || '', registered: o.reg_date || '',
      checked: o.reg_checked || '', trading: pick('trading_name', SKIN.trading_name || ''), overridden: rows.length > 0 };
  }
  async function get(now) { const r = await raw(); return { ...evaluate(r, SKIN.short_name || SKIN.name, now), overridden: r.overridden, rawName: r.name, registerName: r.name, tier: r.tier || (/^CBDL/i.test(r.number) ? 'lower' : r.number ? 'upper' : ''), company: r.company, registered: r.registered, registeredNice: r.registered ? nice(r.registered) : '', checked: r.checked, checkedNice: r.checked ? nice(r.checked) : '', trading: r.trading }; }
  const put = (k, val) => pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, val]);
  // Save the number, checking it live against the Environment Agency register. The register's own name, tier, company number and dates replace anything typed.
  // result.status: 'found' | 'notfound' (nothing saved) | 'unreachable' (saved as typed, not checked) | 'badnumber' | 'baddate' | 'cleared'
  async function save(v, { lookup = ea.lookup, now } = {}) {
    const num = ea.normNumber(v.number), exp = String(v.expiry || '').trim();
    if (!num) {                                                    // clearing the number turns the mark off
      for (const k of ['reg_name', 'reg_number', 'reg_expiry', 'reg_tier', 'reg_company', 'reg_date', 'reg_checked']) await put(k, '');
      return { ok: true, status: 'cleared', complete: false };
    }
    if (!ea.NUMBER.test(num)) return { ok: false, status: 'badnumber', why: 'number' };
    if (exp && !validDate(exp)) return { ok: false, status: 'baddate', why: 'date' };
    const r = await lookup(num);
    if (r.status === 'notfound') return { ok: false, status: 'notfound', why: 'notfound' };
    if (r.status === 'found') {
      for (const [k, val] of [['reg_name', r.name], ['reg_number', r.number], ['reg_expiry', r.expiry], ['reg_tier', r.tier], ['reg_company', r.company], ['reg_date', r.registered], ['reg_checked', todayUK(now)]]) await put(k, val);
      return { ok: true, status: 'found', complete: !!r.expiry, tier: r.tier, lower: r.tier === 'lower', data: r };
    }
    // the register could not be reached: keep what was typed, say it is unchecked
    for (const [k, val] of [['reg_number', num], ['reg_expiry', exp], ['reg_tier', /^CBDL/.test(num) ? 'lower' : ''], ['reg_checked', '']]) await put(k, val);
    return { ok: true, status: 'unreachable', complete: !!exp };
  }
  async function saveTrading(name) { await put('trading_name', String(name || '').trim().slice(0, 100)); }
  const reset = () => pool.query('DELETE FROM settings WHERE key = ANY($1)', [KEYS.filter(k => k !== 'trading_name')]);   // back to the skin's standard details
  return { get, save, saveTrading, reset, defaults };
};
module.exports.evaluate = evaluate;
