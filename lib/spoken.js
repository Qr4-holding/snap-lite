// How the business name is said aloud. The spoken form goes to the voice service only; captions and the end card keep the written name.
// Rule for any skin: a run of 2 to 4 capitals is spelt out ("EKP" -> "E K P") and a run of 1 to 4 digits is said digit by digit
// ("11" -> "one one"). "EKP11" and "EKP 11" both become "E K P one one". A skin whose name is pronounced as a word sets spoken_name,
// which replaces the rule completely.
const DIGIT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const RUN = /(?<![A-Za-z])[A-Z]{2,4}(?![A-Za-z])|(?<!\d)\d{1,4}(?!\d)/g;
function spokenForm(name) {
  return String(name || '').replace(RUN, m => ' ' + (/^\d/.test(m) ? [...m].map(d => DIGIT[+d]).join(' ') : [...m].join(' ')) + ' ').replace(/\s+/g, ' ').trim();
}
// the business name as it may be typed in a line ("EKP11", "EKP 11", "EKP11 Waste Management")
const rx = t => String(t).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/([A-Za-z])(\d)/g, '$1\\s?$2').replace(/\s+/g, '\\s+');
const brandRegex = SKIN => new RegExp(`\\b(?:${[SKIN.name, SKIN.short_name].filter(Boolean).sort((a, b) => b.length - a.length).map(rx).join('|')})\\b`, 'gi');
// returns a function that swaps every form of the business name in a line for its spoken form (everything else is left as written)
function makeSpoken(SKIN) {
  const squash = s => String(s || '').replace(/\s+/g, '').toLowerCase();
  const full = SKIN.name || '', short = SKIN.short_name || '';
  return text => String(text).replace(SKIN.brandRe, m => {
    if (SKIN.spoken_name) return SKIN.spoken_name;
    const k = squash(m);
    if (short && k === squash(short)) return spokenForm(short);
    if (full && k === squash(full)) return spokenForm(full);
    return spokenForm(m);
  });
}
module.exports = { spokenForm, makeSpoken, brandRegex };
