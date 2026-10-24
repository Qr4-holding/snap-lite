// The three spoken lines: drafting (Claude, with skin templates as the safe fallback) and the filter every line must pass.
// Rules come from the spec: plain UK English, under 12 words a line, no digits or pound signs, no superlatives or promises,
// no places, nothing claimed that the skin has not listed in facts_allowed.
const BANNED = ['best', 'cheapest', 'cheap', 'guaranteed', 'guarantee', 'vetted', 'certified', 'number one', 'award', 'awards', 'award-winning', 'finest', 'top rated', 'no 1', 'unbeatable', 'perfect', 'amazing'];
const CLAIMS = ['licensed', 'licenced', 'insured', 'registered', 'accredited', 'family-run', 'family run', 'same day', 'same-day', 'free quote', 'free quotes', 'fully', 'years', 'recycled', 'recycle', 'eco-friendly', 'affordable', 'fast', 'fastest', 'cheaper', 'lowest', 'discount', 'offer', 'trusted', 'reliable', 'professional', 'experienced', 'local', 'nationwide', 'rated'];
const PLACE_SUFFIX = /\b(street|road|lane|avenue|crescent|terrace)\b/i;
const MAX_WORDS = 11;

module.exports = function lines(SKIN, secrets) {
  const allowed = (SKIN.facts_allowed || []).map(s => String(s).toLowerCase());
  const name = SKIN.short_name || SKIN.name;
  const NAMEOK = new Set([name.toLowerCase(), 'ekp11', 'ekp', 'i']);

  // Returns { text, removed: [{what, why}], ok } for one line.
  function sanitizeLine(raw) {
    let t = String(raw || '').replace(/\s+/g, ' ').trim(); const removed = [];
    t = t.replace(/EKP\s?11(\s+Waste\s+Management)?/gi, 'ZZBRANDZZ');
    const take = (re, why) => { t = t.replace(re, m => { removed.push({ what: m.trim(), why }); return ' '; }); };
    take(/[£$€]\s*\d[\d,.]*/g, 'prices are never spoken');
    take(/\d[\d,.]*\s*(?:%|p\b)?/g, 'no numbers or digits');
    for (const w of BANNED.slice().sort((a, b) => b.length - a.length)) take(new RegExp(`\\b${w.replace(/ /g, '\\s+')}\\b`, 'gi'), 'we do not use boasts or superlatives');
    for (const w of CLAIMS) if (!allowed.some(a => a.includes(w))) take(new RegExp(`\\b${w.replace(/ /g, '\\s+')}\\b`, 'gi'), 'claims need Paul\'s confirmation first');
    take(new RegExp(`\\b\\w+\\s+${PLACE_SUFFIX.source.slice(2, -2)}\\b`, 'gi'), 'no street or place names');
    const words = t.split(' ');
    const kept = words.map((w, i) => {
      const bare = w.replace(/[^A-Za-z0-9']/g, ''); const startOfSentence = i === 0 || /[.!?]$/.test(words[i - 1]);
      if (!startOfSentence && /^[A-Z][a-z]{2,}$/.test(bare) && !NAMEOK.has(bare.toLowerCase()) && !/^(Waste|Management)$/.test(bare)) { removed.push({ what: bare, why: 'no town or place names' }); return ''; }
      return w;
    });
    t = kept.join(' ').replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/^[\s,;:.\-–]+/, '').trim();
    if (t.split(' ').filter(Boolean).length > MAX_WORDS) { removed.push({ what: t.split(' ').slice(MAX_WORDS).join(' '), why: `lines are kept under ${MAX_WORDS + 1} words` }); t = t.split(' ').slice(0, MAX_WORDS).join(' ').replace(/[,;:\-–]+$/, ''); }
    if (t && !/[.!?]$/.test(t)) t += '.';
    t = t.replace(/ZZBRANDZZ/g, name);
    if (t.split(' ').filter(Boolean).length < 2 && !/ZZBRANDZZ/.test(t)) t = '';
    return { text: t, removed, ok: removed.length === 0 && !!t };
  }
  // The three lines as an array in, cleaned lines and a plain list of what was taken out and why.
  function sanitize(arr) {
    const out = [], notes = [];
    arr.slice(0, 3).forEach((l, i) => { const r = sanitizeLine(l); out.push(r.text); r.removed.forEach(x => notes.push({ line: i + 1, ...x })); if (!r.text && String(l || '').trim()) notes.push({ line: i + 1, what: String(l).slice(0, 40), why: 'that line was too short once the problem words were removed' }); });
    return { lines: out, notes, ok: notes.length === 0 && out.every(Boolean) && out.length === 3 };
  }

  const TEMPLATES = {
    'House clearance': [['Here is the house before we started.', 'And here it is, cleared and swept.'], ['Every room full, before.', 'Every room clear, after.']],
    'Garden': [['Here is the garden before we started.', 'And here it is, cleared and tidy.'], ['Overgrown and full of rubbish, before.', 'Clear and tidy, after.']],
    'Garage': [['Here is the garage before we started.', 'And here it is, emptied out.'], ['Packed to the door, before.', 'Empty and swept, after.']],
    "Builders' waste": [['Here is the site before we started.', 'And here it is, cleared away.'], ['Rubble everywhere, before.', 'Cleared and swept, after.']],
    'Cardboard and packaging': [['Here is the cardboard before we started.', 'And here it is, collected and gone.'], ['Stacked up and in the way, before.', 'Collected and clear, after.']],
    'Commercial yard': [['Here is the yard before we started.', 'And here it is, swept clean.'], ['Piled high, before.', 'Clear and swept, after.']],
    'Other': [['Here is the job before we started.', 'And here it is, cleared.'], ['Before, it was full.', 'After, it is clear.']]
  };
  const closer = () => `${name} Waste Management. ${(SKIN.tagline || 'Skip the skip.')}`.replace(/Waste Management Waste Management/, 'Waste Management');
  function templateLines(type) {
    const set = TEMPLATES[type] || TEMPLATES.Other; const pick = set[Math.floor(Math.random() * set.length)];
    return [pick[0], pick[1], `${name}. ${SKIN.tagline || 'Skip the skip.'}`];
  }

  async function draft(type) {
    const key = await secrets.get('anthropic_key');
    if (key) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const rules = (SKIN.script_rules || []).join(' ');
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({ model: process.env.DRAFT_MODEL || 'claude-haiku-5-5', max_tokens: 1500, thinking: { type: 'disabled' },
              system: `You write three short spoken lines for a before-and-after video made by ${SKIN.name}, a UK waste removal company. Line 1 introduces the BEFORE photo. Line 2 introduces the AFTER photo. Line 3 is the sign-off and must say "${name}" and "${SKIN.tagline || ''}". Each line is at most 10 words, one sentence, plain words. ${rules} Do not mention prices, places, speed, quality claims, or anything not shown in a photo. Reply with exactly three lines, one per row, nothing else: no numbering, no quotes.`,
              messages: [{ role: 'user', content: `Job type: ${type || 'General'}. Write the three lines.` }] }), signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new Error('draft ' + r.status);
          const jr = await r.json(); const txt = (jr.content || []).map(c => c.text || '').join('').trim(); if (process.env.DRAFT_DEBUG && !txt) console.error('EMPTY', JSON.stringify(jr).slice(0, 300));
          const arr = txt.split(/\n+/).map(s => s.replace(/^\s*(line\s*\d\s*[:.-]\s*|\d[.)]\s*)/i, '').trim()).map(s => s.replace(/^["'“]|["'”]$/g, '').trim()).filter(Boolean);
          if (process.env.DRAFT_DEBUG) console.error(JSON.stringify(arr), JSON.stringify(sanitize(arr).notes));
          if (arr.length === 3 && sanitize(arr).ok) return { lines: arr, source: 'claude' };
        } catch (e) { console.error('draft failed:', e.message); }
      }
    }
    return { lines: templateLines(type), source: 'template' };
  }
  return { sanitize, sanitizeLine, draft, templateLines, MAX_WORDS };
};
