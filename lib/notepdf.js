// The waste transfer note as a one-page A4 PDF, laid out like the carrier's existing note: header, Customer and Site side by side, Job Details,
// Disposal and Carrier side by side, the Regulation 12 declaration with signature boxes, and the company footer. Blank boxes stay blank, as on the paper note.
const PDFDocument = require('pdfkit');

const WIN = /[^\x20-\x7E\xA0-\xFF–—‘’“”…•]/g;
const t = v => String(v == null ? '' : v).replace(WIN, '?');
const REG12 = 'I confirm that I have fulfilled my duty to apply the waste hierarchy as required by Regulation 12 of the Waste (England and Wales) Regulations 2011';

// "PAUL V. CASTLE GROUP LIMITED trading as EKP11 ..." -> "Paul V. Castle Group Limited"
function companyName(registerName) {
  let n = String(registerName || '').split(/\s+trading\s+as\s+/i)[0].trim();
  if (n && n === n.toUpperCase()) n = n.toLowerCase().replace(/(^|[\s.\-(])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\bLimited\b/g, 'Limited').replace(/\bLtd\b/g, 'Ltd');
  return n;
}
const ukDate = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const lines = s => { const a = String(s || '').split(/\n|,\s*/).map(x => x.trim()).filter(Boolean); if (a.length > 1 && /^[\d\-\/ ]+$/.test(a[0])) a.splice(0, 2, a[0] + ' ' + a[1]); return a; };   // "145-149, Cardigan Road" stays one line

// d: { carrier:{trading,phone,web,email,regNumber,address,companyName,companyNumber,office,vat}, job:{...}, qtyLabel, logoFile, accent }
function build(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Waste Transfer Note', Author: t(d.carrier.trading) } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = 595, L = 40, R = 555, FULL = R - L, accent = d.accent || '#2e7d32', ink = '#1a1a1a';
    const label = (x, y, w, k, v, opt = {}) => { doc.font('Helvetica-Bold').fontSize(9.5).fillColor(ink).text(t(k) + ' ', x, y, { width: w, continued: true }).font('Helvetica').text(t(v), { width: w, height: opt.h || 28, ellipsis: true }); return doc.y; };
    const box = (x, y, w, h, title) => { doc.lineWidth(0.8).strokeColor('#000').rect(x, y, w, h).stroke(); if (title) doc.font('Helvetica-Bold').fontSize(9.5).fillColor(ink).text(t(title), x + 5, y + 4, { width: w - 10 }); };
    const para = (x, y, w, arr, maxH) => { doc.font('Helvetica').fontSize(9.5).fillColor(ink); let yy = y; for (const l of arr) { if (yy - y > maxH - 11) break; doc.text(t(l), x, yy, { width: w, lineBreak: false, ellipsis: true }); yy += 12; } return yy; };

    // header band, logo, title and the carrier's contact block
    doc.rect(0, 0, W, 84).fill(accent);
    try { if (d.logoBuf) { doc.roundedRect(L, 12, 190, 60, 6).fill('#fff'); doc.image(d.logoBuf, L + 8, 17, { fit: [174, 50], align: 'center', valign: 'center' }); } } catch (e) {}
    doc.font('Helvetica-Bold').fontSize(21).fillColor(ink).text('Waste Transfer Note', 0, 104, { width: W, align: 'center' });
    const c = d.carrier; let cy = 134;
    doc.font('Helvetica').fontSize(10.5).fillColor(ink);
    for (const l of [c.trading, c.phone, c.web, c.email ? 'Email: ' + c.email : '']) if (l) { doc.text(t(l), 330, cy, { width: R - 330 }); cy += 14; }

    const j = d.job; let y = 205;
    // customer | site
    box(L, y, 257, 112, 'Customer Details:'); box(L + 257, y, 258, 112, 'Site Details:');
    para(L + 5, y + 20, 247, [j.commercial && j.custBusiness ? j.custBusiness : '', j.custName, ...lines(j.custAddr)].filter(Boolean), 70);
    doc.font('Helvetica-Bold').fontSize(9.5).text('SIC CODE: ' + t(j.sic), L + 5, y + 96, { width: 247 });
    para(L + 262, y + 20, 248, [j.addr1, j.area, j.postcode].filter(Boolean), 86);
    y += 122;
    // job details
    box(L, y, FULL, 135, 'Job Details:'); doc.moveTo(L + 257, y + 18).lineTo(L + 257, y + 135).stroke();
    let ly = y + 24; const lw = 247;
    ly = label(L + 5, ly, lw, 'Ticket No:', j.ticket || '') + 6;
    ly = label(L + 5, ly, lw, 'Job Type:', j.jobType) + 6;
    ly = label(L + 5, ly, lw, 'Container Type:', 'Man in a van') + 6;
    ly = label(L + 5, ly, lw, 'Container Size:', d.qtyLabel || '', { h: 26 }) + 6;
    let ry = y + 24; const rw = 248, rx = L + 262;
    ry = label(rx, ry, rw, 'Date:', ukDate(j.date)) + 6;
    ry = label(rx, ry, rw, 'Waste Description:', j.wasteDesc, { h: 26 }) + 6;
    ry = label(rx, ry, rw, 'EWC Code:', j.ewc) + 6;
    ry = label(rx, ry, rw, 'SIC Code:', j.sic) + 6;
    label(rx, ry, rw, 'Vehicle Reg:', j.van);
    y += 145;
    // disposal | carrier
    box(L, y, 257, 112, 'Disposal Details:'); box(L + 257, y, 258, 112, 'Carrier Details:');
    para(L + 5, y + 20, 247, [j.tipName, ...lines(j.tipAddr), j.tipDate ? 'Delivered on: ' + ukDate(j.tipDate) : ''].filter(Boolean), 68);
    doc.font('Helvetica-Bold').fontSize(9.5).text('Disposal Site Licence No: ', L + 5, y + 96, { width: 247, continued: true }).font('Helvetica').text(t(j.tipLicence));
    para(L + 262, y + 20, 248, [c.trading, ...lines(c.address)].filter(Boolean), 68);
    doc.font('Helvetica-Bold').fontSize(9.5).text('Waste Carrier Licence No: ', L + 262, y + 96, { width: 248, continued: true }).font('Helvetica').text(t(c.regNumber));
    y += 122;
    // declaration | terms, names and signatures
    box(L, y, 257, 100); box(L + 257, y, 258, 100);
    doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(REG12, L + 5, y + 5, { width: 247 });
    doc.text(t(c.trading ? `ALL WORK CARRIED OUT IS SUBJECT TO ${c.trading.toUpperCase()} TERMS AND CONDITIONS` : ''), L + 262, y + 5, { width: 248 });
    doc.moveTo(L, y + 48).lineTo(R, y + 48).stroke();
    doc.font('Helvetica-Bold').text('CUSTOMER NAME: ', L + 5, y + 54, { width: 247, continued: true }).font('Helvetica').text(t(j.custName));
    doc.font('Helvetica-Bold').text('DRIVER NAME: ', L + 262, y + 54, { width: 248, continued: true }).font('Helvetica').text(t(j.driver));
    doc.font('Helvetica-Bold').text('SIGNATURE:', L + 5, y + 82, { width: 247 }); doc.text('SIGNATURE:', L + 262, y + 82, { width: 248 });
    // footer band: company details
    doc.rect(0, 762, W, 80).fill('#3f3f3f');
    const f = [];
    const trade = c.trading, co = c.companyName;
    f.push(co && trade && co.toLowerCase() !== trade.toLowerCase() ? `${trade} is a Trading name of ${co}` : (co || trade || ''));
    if (c.companyNumber) f.push('Registered Number: ' + c.companyNumber);
    if (c.office) f.push('Registered Address: ' + c.office);
    if (c.vat) f.push('VAT Number ' + c.vat);
    doc.font('Helvetica').fontSize(9.5).fillColor('#ffffff'); let fy = 772;
    for (const l of f) { doc.text(t(l), L, fy, { width: FULL, lineBreak: false, ellipsis: true }); fy += 14; }
    doc.end();
  });
}
module.exports = { build, companyName, ukDate, REG12 };
