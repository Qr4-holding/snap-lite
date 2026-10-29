// Terms, privacy and the Clean Up UK Pledge: each has a version. The owner ticks to accept; we keep who accepted which version and when.
// A new version shows once as a banner with a tick; it never blocks making or sharing a video. No emails.
// Wording and versions come from the skin (skin.legal), so one business can have its own wording; these are the defaults.
const fs = require('fs'), path = require('path');
// The wording lives in skins/<id>/legal/{terms,privacy,pledge}.md, first line "Version: N". A skin without its own file uses the demo skin's (the CleanUpSnap wording).
const FALLBACK = path.join(__dirname, '..', 'skins', 'demo', 'legal');
function load(SKIN, key) {
  for (const dir of [SKIN.dir && path.join(SKIN.dir, 'legal'), FALLBACK]) {
    if (!dir) continue;
    const f = path.join(dir, key + '.md');
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8'), m = raw.match(/^\s*Version:\s*(\d+)\s*\n/i);
    return { version: m ? Math.max(1, +m[1]) : 1, body: m ? raw.slice(m[0].length) : raw, own: dir !== FALLBACK };
  }
  return { version: 1, body: '', own: false };
}
function docs(SKIN) {
  const l = SKIN.legal || {};                                          // optional override in skin.json (version / pledge lines)
  const t = load(SKIN, 'terms'), pr = load(SKIN, 'privacy'), pl = load(SKIN, 'pledge');
  const lines = pl.body.split('\n').map(x => (x.match(/^\d+\.\s+(.*)/) || [])[1]).filter(Boolean);
  const ver = (o, dv) => Math.max(1, parseInt(o && o.version, 10) || dv);
  return {
    terms: { key: 'terms', title: 'Terms of use', short: 'the Terms of use', version: ver(l.terms, t.version), url: '/terms', body: t.body },
    privacy: { key: 'privacy', title: 'Privacy notice', short: 'the Privacy notice', version: ver(l.privacy, pr.version), url: '/privacy', body: pr.body },
    pledge: { key: 'pledge', title: 'Clean Up UK Pledge', short: 'the Clean Up UK Pledge', version: ver(l.pledge, pl.version), url: '/pledge', body: pl.body,
      lines: Array.isArray(l.pledge && l.pledge.lines) && l.pledge.lines.length ? l.pledge.lines.map(String) : lines }
  };
}
const KEYS = ['terms', 'privacy', 'pledge'];
const niceDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

module.exports = function legal(pool, SKIN) {
  const D = docs(SKIN);
  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS acceptances (
      id BIGSERIAL PRIMARY KEY, user_id INT NOT NULL, email TEXT NOT NULL DEFAULT '', doc TEXT NOT NULL, version INT NOT NULL, accepted_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query('CREATE INDEX IF NOT EXISTS acceptances_user ON acceptances (user_id, doc, version)');
  }
  // for one person: each document with the latest version they accepted (0 = never) and whether the current version is accepted
  async function status(userId) {
    const rows = (await pool.query('SELECT doc, MAX(version) AS v, (ARRAY_AGG(accepted_at ORDER BY version DESC, id DESC))[1] AS at FROM acceptances WHERE user_id=$1 GROUP BY doc', [userId])).rows;
    const m = Object.fromEntries(rows.map(r => [r.doc, r]));
    return KEYS.map(k => { const a = m[k], d = D[k]; const have = a ? +a.v : 0; return { ...d, accepted: have >= d.version, acceptedVersion: have, acceptedAt: a ? a.at : null, acceptedNice: a ? niceDate(a.at) : '', changed: have > 0 && have < d.version }; });
  }
  // keys = the document keys the person ticked. Only the current version can be accepted. Returns the keys recorded.
  async function accept(user, keys) {
    const done = [];
    for (const k of [].concat(keys || []).filter(k => KEYS.includes(k))) {
      const have = (await pool.query('SELECT 1 FROM acceptances WHERE user_id=$1 AND doc=$2 AND version=$3', [user.id, k, D[k].version])).rows[0];
      if (!have) await pool.query('INSERT INTO acceptances (user_id,email,doc,version) VALUES ($1,$2,$3,$4)', [user.id, user.email, k, D[k].version]);
      done.push(k);
    }
    return done;
  }
  const pending = async userId => (await status(userId)).filter(s => !s.accepted);
  return { init, status, accept, pending, docs: D, KEYS };
};
module.exports.docs = docs;
