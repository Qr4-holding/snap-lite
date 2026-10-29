// Terms, privacy and the Clean Up UK Pledge: each has a version. The owner ticks to accept; we keep who accepted which version and when.
// A new version shows once as a banner with a tick; it never blocks making or sharing a video. No emails.
// Wording and versions come from the skin (skin.legal), so one business can have its own wording; these are the defaults.
const DEFAULT_PLEDGE = [
  'I am a registered waste carrier and will keep my registration current.',
  'Every load I collect goes to a licensed site, and I keep the receipt.',
  'I record every job here, before and after.',
  'I never fly-tip, and I report fly-tipping I find.',
  'I accept that proven fly-tipping ends my place on Clean Up UK and CleanUpSnap.'
];
function docs(SKIN) {
  const l = SKIN.legal || {};
  const ver = (d, dv) => Math.max(1, parseInt(d && d.version, 10) || dv);
  return {
    terms: { key: 'terms', title: 'Terms of use', short: 'the Terms of use', version: ver(l.terms, 1), url: (l.terms && l.terms.url) || 'https://cleanupsnap.co.uk/terms' },
    privacy: { key: 'privacy', title: 'Privacy notice', short: 'the Privacy notice', version: ver(l.privacy, 1), url: (l.privacy && l.privacy.url) || 'https://cleanupsnap.co.uk/privacy' },
    pledge: { key: 'pledge', title: 'Clean Up UK Pledge', short: 'the Clean Up UK Pledge', version: ver(l.pledge, 1), lines: Array.isArray(l.pledge && l.pledge.lines) && l.pledge.lines.length ? l.pledge.lines.map(String) : DEFAULT_PLEDGE }
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
module.exports.docs = docs; module.exports.DEFAULT_PLEDGE = DEFAULT_PLEDGE;
