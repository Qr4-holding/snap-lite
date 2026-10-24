// Page shell for every app screen: skin colours and logo, big tap targets, portrait first.
const { esc } = require('./util');

module.exports = function ui(SKIN) {
  const A = SKIN.accent, INK = SKIN.ink || '#1F2124';
  const css = `
:root{--a:${A};--ink:${INK};--line:#dfe3df;--soft:#f3f6f3;--bad:#b3261e}
*{box-sizing:border-box}[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:#fff;line-height:1.4;font-size:17px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;border-bottom:4px solid var(--a);background:#fff;position:sticky;top:0;z-index:5}
header.top img{height:40px;width:auto;display:block}
header.top a.who{color:var(--ink);font-weight:700;text-decoration:none;padding:10px 4px}
main{max-width:560px;margin:0 auto;padding:16px 16px 96px}
h1{font-size:26px;margin:6px 0 12px}h2{font-size:20px;margin:22px 0 8px}
.btn,button{appearance:none;border:0;border-radius:14px;min-height:56px;padding:12px 20px;font:inherit;font-weight:800;font-size:18px;background:var(--a);color:#fff;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;cursor:pointer;text-align:center}
.btn.sec,button.sec{background:#fff;color:var(--ink);border:2px solid var(--line)}
.btn.bad,button.bad{background:#fff;color:var(--bad);border:2px solid #f0c4c0}
.btn.small,button.small{min-height:44px;font-size:16px;width:auto;display:inline-flex}
.btn[disabled],button[disabled]{opacity:.5}
form.card,.card{border:2px solid var(--line);border-radius:16px;padding:14px;display:grid;gap:12px;margin:0 0 14px}
label.f{display:grid;gap:4px;font-weight:700}
input,select,textarea{font:inherit;padding:14px;border:2px solid #c9cfc9;border-radius:12px;background:#fff;color:var(--ink);width:100%;min-height:52px}
.msg{padding:12px 14px;border-radius:12px;background:var(--soft);border:2px solid var(--a);font-weight:700;margin:0 0 12px}
.msg.bad{background:#fdecea;border-color:var(--bad);color:var(--bad)}
.small{font-size:14px;color:#566}
.pill{display:inline-block;border-radius:999px;padding:3px 10px;font-size:13px;font-weight:800;background:var(--soft);border:1px solid var(--line)}
.pill.on{background:var(--a);color:#fff;border-color:var(--a)}
.jobs{display:grid;gap:10px}
.job{display:grid;grid-template-columns:72px 1fr;gap:12px;align-items:center;border:2px solid var(--line);border-radius:14px;padding:8px;text-decoration:none;color:inherit}
.job .th{width:72px;height:96px;border-radius:10px;background:var(--soft) center/cover no-repeat}
.job b{display:block}
.shots{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.shot{position:relative;aspect-ratio:3/4;border:3px dashed #b9c4b9;border-radius:14px;background:var(--soft) center/cover no-repeat;display:grid;place-items:center;text-align:center;font-weight:800;color:#566;padding:6px;cursor:pointer;overflow:hidden}
.shot.has{border-style:solid;border-color:var(--a)}
.shot .tag{position:absolute;left:8px;top:8px;border-radius:8px;padding:3px 9px;font-size:14px;font-weight:900;background:#fff;color:var(--a)}
.shot.during .tag{background:var(--ink);color:#fff}.shot.after .tag{background:var(--a);color:#fff}
.shot .st{position:absolute;left:8px;right:8px;bottom:8px;border-radius:8px;background:rgba(255,255,255,.92);font-size:13px;padding:3px}
.shot.err{border-color:var(--bad)}
.cam{position:fixed;inset:0;background:#000;z-index:20;display:grid;grid-template-rows:1fr auto}
.cam .view{position:relative;overflow:hidden}.cam video,.cam img.ghost{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cam img.ghost{opacity:.3;pointer-events:none}.cam .bar{display:flex;gap:10px;padding:14px;background:#000}
.cam .snap{background:#fff;color:#000}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left}
`;
  const head = (title, extra = '') => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="${esc(A)}"><title>${esc(title)} · ${esc(SKIN.app_name || SKIN.name)}</title><link rel="manifest" href="/manifest.json"><link rel="icon" href="/assets/icon-192.png"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="${esc(SKIN.short_name || SKIN.name)}"><style>${css}</style>${extra}</head><body>`;
  function page(title, body, { user, script = '', headExtra = '' } = {}) {
    return head(title, headExtra) + `<header class="top"><a href="/"><img src="/assets/logo.png" alt="${esc(SKIN.name)}"></a>${user ? `<a class="who" href="/settings">${esc(user.name || 'Me')} ⚙</a>` : ''}</header><main>${body}</main><script>if('serviceWorker' in navigator)window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});</script>${script ? `<script>${script}</script>` : ''}</body></html>`;
  }
  const msg = (m, bad) => m ? `<p class="msg${bad ? ' bad' : ''}" role="alert">${esc(m)}</p>` : '';
  return { page, msg, css, head };
};
