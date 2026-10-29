// The per-job record (what a transfer note and Digital Waste Tracking will ask for). Pure rules: no database, no network.
const QTY = [
  { key: 'quarter', label: 'Quarter load', frac: 0.25 }, { key: 'half', label: 'Half load', frac: 0.5 }, { key: 'three_quarter', label: 'Three-quarter load', frac: 0.75 },
  { key: 'full', label: 'Full load', frac: 1 }, { key: 'more', label: 'More than one load', frac: null }
];
const QTY_KEYS = QTY.map(q => q.key);
const cubic = n => { const r = Math.round(n * 100) / 100; return String(r).replace(/\.0+$/, ''); };
// "Half load (8.5 cubic yards)": the van's capacity comes from Settings
const qtyText = (key, cap) => { const q = QTY.find(x => x.key === key); if (!q) return ''; return q.frac == null ? `${q.label} (more than ${cubic(cap)} cubic yards)` : `${q.label} (${cubic(q.frac * cap)} cubic yards)`; };
const qtyYards = (key, cap) => { const q = QTY.find(x => x.key === key); return q && q.frac != null ? Math.round(q.frac * cap * 100) / 100 : null; };

// what the photos can show; each flag has one plain warning
const FLAGS = ['pops', 'fridge', 'plasterboard', 'gas', 'tyres', 'asbestos'];
const WARN = {
  pops: 'This load has upholstered seating (a sofa or chair): it must go to a site that takes POPs waste.',
  fridge: 'This load has a fridge or freezer: it must go to a site that takes fridges and freezers.',
  plasterboard: 'This load has plasterboard: keep it separate and take it to a site that accepts plasterboard.',
  gas: 'This load has gas bottles: they cannot go in with ordinary waste. Take them to a site that accepts gas bottles.',
  tyres: 'This load has tyres: take them to a site that accepts tyres.',
  asbestos: 'This load may have asbestos. Do not break it up or load it. Get it checked by a licensed asbestos specialist first.'
};
const warnings = flags => FLAGS.filter(f => flags && flags[f]).map(f => WARN[f]);
const cleanFlags = f => Object.fromEntries(FLAGS.map(k => [k, !!(f && (f[k] === true || f[k] === 'on' || f[k] === '1' || f[k] === 1))]));

// materials the photo reader may use, and the plain wording/EWC for each. The codes can be overridden per skin (skin.json: ewc_by_material, ewc_by_type).
const MATERIALS = ['furniture', 'mattress', 'household', 'garden', 'cardboard', 'builders', 'plasterboard', 'wood', 'metal', 'electrical', 'textiles', 'glass', 'tyres', 'other'];
const EWC_MATERIAL = { furniture: '20 03 07', mattress: '20 03 07', household: '20 03 01', garden: '20 02 01', cardboard: '15 01 01', builders: '17 09 04', plasterboard: '17 08 02', wood: '20 01 38', metal: '20 01 40', electrical: '20 01 36', textiles: '20 01 11', glass: '20 01 02', tyres: '16 01 03', other: '20 03 01' };
const LEAD = { 'House clearance': 'household clearance', 'Garden': 'garden waste', 'Garage': 'garage clearance', "Builders' waste": "builders' waste", 'Cardboard and packaging': 'cardboard and packaging', 'Commercial yard': 'commercial waste', 'Other': 'waste' };
const ewcOk = s => /^\d{2} \d{2} \d{2}\*?$/.test(s || '');
const ewcClean = s => { const d = String(s || '').replace(/[^0-9*]/g, ''); const m = d.match(/^(\d{2})(\d{2})(\d{2})(\*?)$/); return m ? `${m[1]} ${m[2]} ${m[3]}${m[4]}` : ''; };

function cleanItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 15).map(x => ({
    item: String((x && x.item) || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40),
    count: Math.max(1, Math.min(99, parseInt(x && x.count, 10) || 1)),
    material: MATERIALS.includes(x && x.material) ? x.material : 'other'
  })).filter(x => x.item);
}
// the short description line, from the items: "mixed household clearance: sofa x2, bags, carpet"
function describe(items, jobType, SKIN = {}) {
  const its = cleanItems(items); if (!its.length) return '';
  const lead = (SKIN.job_leads && SKIN.job_leads[jobType]) || LEAD[jobType] || 'waste';
  const mats = new Set(its.map(i => i.material)), names = [];
  for (const i of its) { const t = i.count > 1 ? `${i.item} x${i.count}` : i.item; if (!names.includes(t)) names.push(t); }
  const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ' and more' : '');
  return `${mats.size > 1 ? 'mixed ' : ''}${lead}: ${shown}`.slice(0, 140);
}
// the EWC code: one material in the photos gives its code; a mixed load uses the job type's code. Both tables can be set per skin and are always editable.
function ewcFor(items, jobType, SKIN = {}) {
  const byMat = Object.assign({}, EWC_MATERIAL, SKIN.ewc_by_material || {}), byType = SKIN.ewc_by_type || {};
  const typeCode = ewcClean(byType[jobType]) || '20 03 01';
  const codes = [...new Set(cleanItems(items).map(i => ewcClean(byMat[i.material])).filter(Boolean))];
  return codes.length === 1 ? codes[0] : typeCode;
}

// UK postcode (outward + inward), upper-cased with the space in the right place. '' if it is not one.
const PC = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/;
const postcode = s => { const m = String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().match(PC); return m ? `${m[1]} ${m[2]}` : ''; };
const sic = s => { const d = String(s || '').replace(/\s+/g, ''); return /^\d{5}$/.test(d) ? d : ''; };
const text = (v, max) => String(v || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s ? s : '';

module.exports = { QTY, QTY_KEYS, qtyText, qtyYards, cubic, FLAGS, WARN, warnings, cleanFlags, MATERIALS, EWC_MATERIAL, cleanItems, describe, ewcFor, ewcClean, ewcOk, postcode, sic, text, isoDate };
