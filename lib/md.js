// Tiny Markdown for our own legal pages: # ## headings, "- " lists, "1. " lists, **bold**, *italic*, paragraphs. Everything is escaped first.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
module.exports = function md(text) {
  const out = []; let list = null, para = [];
  const flushP = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const flushL = () => { if (list) out.push(`<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.t}>`); list = null; };
  for (const raw of String(text).split('\n')) {
    const l = raw.trimEnd(); let m;
    if (!l.trim()) { flushP(); flushL(); }
    else if ((m = l.match(/^(#{1,3})\s+(.*)/))) { flushP(); flushL(); out.push(`<h${m[1].length + 0}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = l.match(/^[-*]\s+(.*)/))) { flushP(); if (!list || list.t !== 'ul') { flushL(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); }
    else if ((m = l.match(/^\d+\.\s+(.*)/))) { flushP(); if (!list || list.t !== 'ol') { flushL(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); }
    else { flushL(); para.push(l.trim()); }
  }
  flushP(); flushL(); return out.join('\n');
};
