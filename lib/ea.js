// Live check of a waste carrier registration number against the Environment Agency public register (England).
// Reads the register's own public data (Open Government / EA Conditional Licence). Returns plain results, never throws.
const BASE = 'https://environment.data.gov.uk/public-register/waste-carriers-brokers/registration/';
const NUMBER = /^CB[A-Z]{1,2}\d{5,8}$/;               // e.g. CBDU527134 (upper tier), CBDL123456 (lower tier)
const normNumber = s => String(s || '').toUpperCase().replace(/[\s\-]+/g, '');
const isoDate = s => /^\d{4}-\d{2}-\d{2}/.test(s || '') ? String(s).slice(0, 10) : '';

// pure: the register's JSON in, our fields out (kept separate so it can be tested without the network)
function parse(json, wanted) {
  const it = json && Array.isArray(json.items) ? json.items[0] : null;
  if (!it || normNumber(it.registrationNumber || it.notation) !== wanted) return null;
  const tierRaw = String((it.tier && (it.tier.notation || it.tier.label)) || '').toLowerCase();
  const holder = it.holder || {};
  return {
    number: wanted,
    name: String(holder.name || '').trim(),
    tier: tierRaw.startsWith('lower') ? 'lower' : tierRaw.startsWith('upper') ? 'upper' : (/^CBDL/.test(wanted) ? 'lower' : 'upper'),
    company: String(holder.companyNumber || '').trim(),
    registered: isoDate(it.registrationDate),
    expiry: isoDate(it.expiryDate),
    address: String(((holder.hasSite || {}).siteAddress || {}).extended_address || '').replace(/\s+/g, ' ').trim()   // the registered site address, as the register prints it
  };
}

// status: 'found' | 'notfound' | 'unreachable' | 'badnumber'
async function lookup(numberIn, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const number = normNumber(numberIn);
  if (!NUMBER.test(number)) return { status: 'badnumber', number };
  try {
    const r = await fetchImpl(BASE + number + '.json', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 404) return { status: 'notfound', number };
    if (!r.ok) return { status: 'unreachable', number };
    const data = parse(await r.json(), number);
    return data ? { status: 'found', ...data } : { status: 'notfound', number };
  } catch (e) { return { status: 'unreachable', number }; }
}
module.exports = { lookup, parse, normNumber, NUMBER };
