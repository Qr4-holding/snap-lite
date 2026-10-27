// Small shared helpers: text cleaning, escaping, passwords, cookies, same-origin check, rate limit.
const crypto = require('crypto');

const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = t => String(t).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
function checkPw(pw, stored) {
  const [salt, h] = String(stored || ':').split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex')), b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const cookies = req => Object.fromEntries((req.get('cookie') || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));

// stop other websites posting forms to us
function sameOrigin(req, res, next) {
  const o = req.get('origin');
  if (o) { let h = ''; try { h = new URL(o).host; } catch (e) {} if (h !== req.get('host')) return res.status(403).type('text/plain').send('That did not go through. Go back, reload the page and try again.'); }
  next();
}

// 10 tries per hour per address (sign-in)
const hits = new Map();
function limited(key, max = 10) {
  const now = Date.now(), hour = 3600e3;
  const list = (hits.get(key) || []).filter(t => now - t < hour);
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

// signed links: the shareable /job/:slug page and private media are only reachable with a valid signature
function sign(secret, text, expires) {
  return crypto.createHmac('sha256', secret).update(text + '|' + expires).digest('hex').slice(0, 32);
}
function verify(secret, text, expires, sig) {
  if (!sig || !/^[a-f0-9]{32}$/.test(sig) || !(Number(expires) > Date.now())) return false;
  const a = Buffer.from(sign(secret, text, expires)), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { clean, esc, slugify, EMAIL, hashPw, checkPw, cookies, sameOrigin, limited, sign, verify };
