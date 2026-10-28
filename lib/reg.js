// Waste carrier registration mark. Skin gives the defaults (reg_name, reg_number, reg_expiry); the owner can override them in Settings.
// The mark shows only while a number and an expiry date are set and today is not after the expiry date. It comes off the day after.
const KEYS = ['reg_name', 'reg_number', 'reg_expiry'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = s => ISO.test(s || '') && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const todayUK = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });   // YYYY-MM-DD
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const nice = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const NAME_MAX = 40;

// pure: values in, what to show out (now is injectable for tests)
function evaluate({ name, number, expiry }, businessName, now = new Date()) {
  const n = String(name || '').trim() || businessName, num = String(number || '').trim(), exp = String(expiry || '').trim();
  const today = todayUK(now), has = !!num && validDate(exp);
  const left = has ? daysBetween(today, exp) : null;
  const active = has && left >= 0;                       // the expiry day itself still counts; gone the day after
  const text = !active ? '' : (n.length > NAME_MAX ? `Registered carrier · ${num}` : `${n} · Registered carrier · ${num}`);
  return { name: n, number: num, expiry: exp, set: has, active, expired: has && left < 0, daysLeft: left, warn: has && left <= 60, expiryNice: has ? nice(exp) : '', text };
}

module.exports = function reg(pool, SKIN) {
  const defaults = () => ({ name: SKIN.reg_name || '', number: SKIN.reg_number || '', expiry: SKIN.reg_expiry || '' });
  async function raw() {
    const d = defaults(); let rows = [];
    try { rows = (await pool.query('SELECT key,value FROM settings WHERE key = ANY($1)', [KEYS])).rows; } catch (e) {}
    const o = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return { name: 'reg_name' in o ? o.reg_name : d.name, number: 'reg_number' in o ? o.reg_number : d.number, expiry: 'reg_expiry' in o ? o.reg_expiry : d.expiry, overridden: rows.length > 0 };
  }
  async function get(now) { const r = await raw(); return { ...evaluate(r, SKIN.short_name || SKIN.name, now), overridden: r.overridden, rawName: r.name }; }
  async function save(v) {
    const num = String(v.number || '').trim().toUpperCase().replace(/\s+/g, ''), exp = String(v.expiry || '').trim(), name = String(v.name || '').trim().slice(0, 100);
    if (num && !/^[A-Z0-9]{5,20}$/.test(num)) return { ok: false, why: 'number' };
    if (exp && !validDate(exp)) return { ok: false, why: 'date' };
    for (const [k, val] of [['reg_name', name], ['reg_number', num], ['reg_expiry', exp]]) await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, val]);
    return { ok: true, complete: !!num && !!exp };
  }
  const reset = () => pool.query('DELETE FROM settings WHERE key = ANY($1)', [KEYS]);   // back to the skin's standard details
  return { get, save, reset, defaults };
};
module.exports.evaluate = evaluate;
module.exports.todayUK = todayUK;
