// The records export: one flat record per job, snake_case field names, same fields in CSV and JSON. Documented in docs/RECORDS.md.
const R = require('./record');
const lonDate = d => d ? new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) : '';
const oneLine = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).join(', ');

// ctx: { carrier:{name,registration_number,tier}, cap }
const FIELDS = [
  ['record_id', (j) => j.id],
  ['job_reference', (j) => j.slug],
  ['job_date', (j) => lonDate(j.created_at)],
  ['job_type', (j) => j.job_type],
  ['job_state', (j) => j.state],
  ['collection_address_line1', (j) => j.addr1],
  ['collection_town_or_area', (j) => j.area],
  ['collection_postcode', (j) => j.postcode],
  ['customer_name', (j) => j.cust_name],
  ['customer_address', (j) => oneLine(j.cust_addr)],
  ['customer_is_business', (j) => !!j.commercial],
  ['customer_business_name', (j) => j.commercial ? j.cust_business : ''],
  ['customer_sic_code', (j) => j.commercial ? j.sic : ''],
  ['waste_description', (j) => j.waste_desc],
  ['ewc_code', (j) => j.ewc],
  ['quantity', (j) => j.qty || j.qty_est || ''],
  ['quantity_label', (j, c) => { const q = j.qty || j.qty_est; const x = R.QTY.find(z => z.key === q); return x ? x.label : ''; }],
  ['quantity_cubic_yards', (j, c) => { const y = R.qtyYards(j.qty || j.qty_est, c.cap); return y == null ? '' : y; }],
  ['quantity_source', (j) => j.qty ? 'owner' : j.qty_est ? 'estimate' : ''],
  ['van_capacity_cubic_yards', (j, c) => c.cap],
  ['items', (j, c, fmt) => fmt === 'json' ? (j.items || []) : (j.items || []).map(i => `${i.item}${i.count > 1 ? ' x' + i.count : ''} [${i.material}]`).join('; ')],
  ['flag_upholstered_seating_pops', (j) => !!(j.flags && j.flags.pops)],
  ['flag_fridge_freezer', (j) => !!(j.flags && j.flags.fridge)],
  ['flag_plasterboard', (j) => !!(j.flags && j.flags.plasterboard)],
  ['flag_gas_bottles', (j) => !!(j.flags && j.flags.gas)],
  ['flag_tyres', (j) => !!(j.flags && j.flags.tyres)],
  ['flag_suspected_asbestos', (j) => !!(j.flags && j.flags.asbestos)],
  ['vehicle_registration', (j) => j.van],
  ['disposal_site_name', (j) => j.tip_name],
  ['disposal_site_address', (j) => j.tip_addr],
  ['disposal_site_licence_number', (j) => j.tip_licence],
  ['disposal_date', (j) => j.tip_date],
  ['disposal_ticket_number', (j) => j.tip_ticket],
  ['tip_receipt_kept', (j) => !!j.has_receipt],
  ['carrier_name', (j, c) => c.carrier.name],
  ['carrier_registration_number', (j, c) => c.carrier.registration_number],
  ['carrier_registration_tier', (j, c) => c.carrier.tier],
  ['driver_name', (j) => j.driver_name || ''],
  ['media_deleted', (j) => !!j.deleted_at],
  ['media_deleted_at', (j) => j.deleted_at ? new Date(j.deleted_at).toISOString() : ''],
  ['record_created_at', (j) => j.created_at ? new Date(j.created_at).toISOString() : '']
];
const NAMES = FIELDS.map(f => f[0]);
const toRecord = (j, ctx, fmt = 'json') => Object.fromEntries(FIELDS.map(([n, fn]) => [n, fn(j, ctx, fmt)]));

// spreadsheet safety: a cell that starts with = + - @ or a control character would be run as a formula, so it gets a leading apostrophe
const cell = v => {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (rows, ctx) => '﻿' + [NAMES.join(','), ...rows.map(j => FIELDS.map(([, fn]) => cell(fn(j, ctx, 'csv'))).join(','))].join('\r\n') + '\r\n';

const isoOk = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
module.exports = { FIELDS, NAMES, toRecord, toCsv, cell, isoOk, lonDate };
