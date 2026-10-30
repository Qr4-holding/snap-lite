// A business's Clean Up UK standing: pledged, registration checked, and any admin flag. One answer for Settings, the shared job page and /standing.json.
// Flags (admin only, logged): reported (mark and hub listing withdrawn while reviewed), confirmed (removed; shown for 12 months), cleared (back to normal).
const FLAGS = ['reported', 'confirmed', 'cleared'];
const ukDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const monthYear = d => new Date(d).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const NOTE_MAX = 500;

module.exports = function standing({ pool, SKIN, regFor, legal, profile, testDomain }) {
  const put = (k, v) => pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS standing_log (id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(), action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', who TEXT NOT NULL DEFAULT '')`);
  }
  async function flagRaw() {
    const o = Object.fromEntries((await pool.query("SELECT key,value FROM settings WHERE key IN ('pledge_flag','pledge_flag_note','pledge_flag_at')")).rows.map(r => [r.key, r.value]));
    return { flag: FLAGS.includes(o.pledge_flag) && o.pledge_flag !== 'cleared' ? o.pledge_flag : '', note: o.pledge_flag_note || '', at: o.pledge_flag_at || '' };
  }
  // the latest Pledge version any owner of this business has ticked (test accounts never count)
  async function pledgeRow() {
    return (await pool.query(`SELECT a.version, a.accepted_at FROM acceptances a JOIN users u ON u.id=a.user_id JOIN businesses b ON b.id=u.biz_id
      WHERE a.doc='pledge' AND u.role='owner' AND u.deleted_at IS NULL AND b.slug=$1 AND ($3 OR u.email NOT LIKE $2) ORDER BY a.version DESC, a.accepted_at DESC LIMIT 1`, [SKIN.id, '%' + testDomain, SKIN.id === 'demo'])).rows[0];
  }
  async function get(now = new Date()) {
    const [rg, fl, pr, prof] = [await regFor(pool, SKIN).get(now), await flagRaw(), await pledgeRow(), await profile.get()];
    const pledged = !!pr, upper = rg.tier === 'upper', verified = !!rg.checked && rg.set && !rg.expired && upper;
    const reported = fl.flag === 'reported', confirmed = fl.flag === 'confirmed';
    const removedShown = confirmed && fl.at && now < new Date(new Date(fl.at).setFullYear(new Date(fl.at).getFullYear() + 1));
    const eligible = pledged && verified && !fl.flag;
    return { business: rg.trading || rg.registerName || SKIN.short_name || SKIN.name, registration_number: rg.number || null, registration_tier: rg.tier || null,
      registration_expires: rg.expiry || null, registration_checked_at: rg.checked ? new Date(rg.checked).toISOString() : null,
      pledged, pledge_version: pr ? pr.version : null, pledged_at: pr ? new Date(pr.accepted_at).toISOString() : null,
      insured_until: prof.insured ? prof.ins_expiry : null, campaign_eligible: eligible, reported, removed_at: removedShown ? ukDay(fl.at) : null,
      removed_text: removedShown ? 'Removed from Clean Up UK ' + monthYear(fl.at) : '', flag: fl.flag, flag_note: fl.note, flag_at: fl.at || null, verified };
  }
  // what the public may see
  const publicJson = (s, origin, now = new Date()) => ({ business: s.business, registration_number: s.registration_number, registration_tier: s.registration_tier, registration_expires: s.registration_expires,
    registration_checked_at: s.registration_checked_at, pledged: s.pledged, pledge_version: s.pledge_version, pledged_at: s.pledged_at, insured_until: s.insured_until,
    campaign_eligible: s.campaign_eligible, reported: s.reported, removed_at: s.removed_at, app_origin: origin, updated_at: now.toISOString() });
  async function setFlag(action, note, who) {
    if (!FLAGS.includes(action)) return { ok: false, why: 'Pick reported, confirmed or cleared.' };
    note = String(note || '').trim().slice(0, NOTE_MAX);
    if (action !== 'cleared' && !note) return { ok: false, why: 'Write a note saying why. It is kept in the log.' };
    const cur = (await flagRaw()).flag;
    if (action === 'cleared' && !cur) return { ok: false, why: 'Nothing is flagged, so there is nothing to clear.' };
    if (action === 'confirmed' && cur !== 'reported') return { ok: false, why: 'Report it first, so it is reviewed, then confirm.' };
    if (action === 'reported' && cur) return { ok: false, why: 'It is already ' + cur + '. Clear it first.' };
    await put('pledge_flag', action); await put('pledge_flag_note', note); await put('pledge_flag_at', new Date().toISOString());
    await pool.query('INSERT INTO standing_log (action,note,who) VALUES ($1,$2,$3)', [action, note, String(who || '').slice(0, 80)]);
    return { ok: true };
  }
  const log = async () => (await pool.query('SELECT ts,action,note,who FROM standing_log ORDER BY id DESC LIMIT 50')).rows;
  return { init, get, publicJson, setFlag, log, FLAGS };
};
