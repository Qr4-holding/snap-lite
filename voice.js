// Voice and lines: the voice screen, the three spoken lines, and the ElevenLabs recording (one generation per video, kept so a Redo is free).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { esc, sameOrigin } = require('./lib/util');

const MODEL = process.env.ELEVEN_MODEL || 'eleven_v4';
const FALLBACK_MODEL = 'eleven_multilingual_v2';

module.exports = function voice({ app, pool, SKIN, ui, acct, jobsMod, getRender, events, secrets, linesMod }) {
  const { page, msg } = ui;
  const { needUser } = acct;
  const form = express.urlencoded({ extended: false, limit: '10kb' });
  const voices = SKIN.voices || [];
  const spokenName = SKIN.spoken_name || SKIN.short_name || SKIN.name;
  const spoken = t => String(t).replace(/EKP\s?11/gi, spokenName);
  const splitScript = s => String(s || '').split(/\n\s*\n/).map(x => x.trim());

  const mine = (u, j) => j && (u.role === 'owner' || j.user_id === u.id);
  const open = (u, j) => mine(u, j) && ['draft', 'failed', 'ready'].includes(j.state);

  // ---------- ElevenLabs ----------
  async function generate(text, voiceId, model) {
    const key = await secrets.get('elevenlabs_key');
    if (!key) throw new Error('No ElevenLabs key is set on the server yet.');
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: model }), signal: AbortSignal.timeout(90000) });
    if (!r.ok) { let d = ''; try { d = (await r.json()).detail; d = typeof d === 'string' ? d : (d.message || d.status || ''); } catch (e) {} const err = new Error(`Voice service said ${r.status}${d ? ': ' + String(d).slice(0, 140) : ''}`); err.status = r.status; throw err; }
    return r.json();
  }
  // Characters with times in, per-line spans and words out.
  function spans(alignment, lines) {
    const ch = alignment.characters, st = alignment.character_start_times_seconds, en = alignment.character_end_times_seconds;
    const out = []; let pos = 0;
    for (const written of lines) {
      const sp = spoken(written); const a = pos, b = pos + sp.length; pos = b + 2;       // two newlines between lines
      const words = []; let cur = null;
      for (let i = a; i < b && i < ch.length; i++) {
        if (/\s/.test(ch[i])) { if (cur) { words.push(cur); cur = null; } continue; }
        if (!cur) cur = [ch[i], st[i], en[i]]; else { cur[0] += ch[i]; cur[2] = en[i]; }
      }
      if (cur) words.push(cur);
      const first = words[0], last = words[words.length - 1];
      out.push({ text: written, start: first ? first[1] : 0, end: last ? last[2] : 0, words: words.map(w => [w[0], +w[1].toFixed(3), +w[2].toFixed(3)]) });
    }
    return out;
  }
  // Returns { voice, lines } for the job, or null for a silent video. Reuses the saved recording when lines and voice are unchanged.
  async function ensure(j, dir) {
    if (!j.voice_id || j.voice_id === 'none' || !j.script) return null;
    const lines = splitScript(j.script); if (lines.length !== 3 || lines.some(l => !l)) return null;
    const text = lines.map(spoken).join('\n\n');
    const hash = crypto.createHash('sha256').update([text, j.voice_id, MODEL].join('|')).digest('hex');
    const mp3 = path.join(dir, 'voice.mp3'), js = path.join(dir, 'lines.json'), hf = path.join(dir, 'voice.key');
    if (fs.existsSync(hf) && fs.readFileSync(hf, 'utf8') === hash && fs.existsSync(mp3) && fs.existsSync(js)) return { voice: mp3, lines: JSON.parse(fs.readFileSync(js, 'utf8')), reused: true };
    let res, model = MODEL;
    try { res = await generate(text, j.voice_id, model); }
    catch (e) { if (e.status === 404 || e.status === 400 || e.status === 422) { model = FALLBACK_MODEL; res = await generate(text, j.voice_id, model); events('tts_model_fallback', null, j.id, model); } else throw e; }
    fs.writeFileSync(mp3, Buffer.from(res.audio_base64, 'base64'));
    const ln = spans(res.alignment || res.normalized_alignment, lines);
    fs.writeFileSync(js, JSON.stringify(ln)); fs.writeFileSync(hf, hash);
    events('tts_generated', null, j.id, `${model} ${text.length} chars`);
    return { voice: mp3, lines: ln };
  }

  // ---------- screens and routes ----------
  const rememberKey = u => 'lastvoice:' + u.id;
  async function lastVoice(u) { const r = (await pool.query('SELECT value FROM settings WHERE key=$1', [rememberKey(u)])).rows[0]; return r && r.value; }
  const saveJob = (id, script, voiceId) => pool.query('UPDATE jobs SET script=$2, voice_id=$3 WHERE id=$1', [id, script, voiceId]);

  async function screen(res, u, j, { lines, voiceId, notes = [], source = '' }) {
    const opts = voices.map(v => `<label class="vo"><input type="radio" name="voice" value="${esc(v.id)}"${voiceId === v.id ? ' checked' : ''}> <span>${esc(v.label.replace(/\s*TBC$/, ''))}</span></label>`).join('')
      + `<label class="vo"><input type="radio" name="voice" value="none"${voiceId === 'none' ? ' checked' : ''}> <span>No voice (silent video)</span></label>`;
    const noteHtml = notes.length ? `<div class="msg bad"><b>We changed your wording:</b><ul style="margin:6px 0 0;padding-left:20px">${notes.map(n => `<li>Line ${n.line}: removed “${esc(n.what)}” (${esc(n.why)})</li>`).join('')}</ul>Check the lines, then tap Make video again.</div>` : '';
    res.set('Cache-Control', 'no-store').send(page('Voice and lines', `
<h1>Voice and lines</h1>
${noteHtml}
<form method="post" action="/jobs/${j.id}/voice" class="card">
<b>Voice</b>${opts}
<b style="margin-top:6px">What the video says</b>
${[0, 1, 2].map(i => `<label class="f"><span class="small">Line ${i + 1}${i === 0 ? ' (over BEFORE)' : i === 1 ? ' (over AFTER)' : ' (over the end card)'}</span><textarea name="line${i + 1}" rows="2" maxlength="140" required>${esc(lines[i] || '')}</textarea></label>`).join('')}
<p class="small" id="src">${source === 'claude' ? 'Written for this job. Change anything you like.' : 'Standard lines. Change anything you like.'} Words like prices, “best” or promises are taken out automatically.</p>
<button type="button" class="sec" id="redo">Suggest new lines</button>
<button type="submit">Make video</button></form>
<a class="btn sec" href="/jobs/${j.id}">Back</a>
<style>.vo{display:flex;align-items:center;gap:12px;border:2px solid var(--line);border-radius:12px;padding:14px;font-weight:800}.vo input{width:24px;min-height:24px;height:24px;margin:0}textarea{resize:vertical}</style>`, { user: u, script: `
document.getElementById('redo').addEventListener('click',function(){var b=this;b.disabled=true;b.textContent='Writing…';fetch('/api/jobs/${j.id}/lines/draft',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}'}).then(function(r){return r.json()}).then(function(d){(d.lines||[]).forEach(function(t,i){document.querySelector('[name=line'+(i+1)+']').value=t;});b.disabled=false;b.textContent='Suggest new lines';}).catch(function(){b.disabled=false;b.textContent='Suggest new lines';});});` }));
  }

  app.get('/jobs/:id/voice', needUser(), async (req, res, next) => { try {
    const u = req.user, j = await jobsMod.getJob(u, req.params.id);
    if (!j) return res.redirect(303, '/');
    if (!open(u, j)) return res.redirect(303, `/jobs/${j.id}`);
    let lines = splitScript(j.script), source = '';
    if (lines.length !== 3) { const d = await linesMod.draft(j.job_type); lines = d.lines; source = d.source; await saveJob(j.id, lines.join('\n\n'), j.voice_id); events('lines_drafted', u.id, j.id, d.source); }
    const vid = j.voice_id || (await lastVoice(u)) || (voices[0] && voices[0].id) || 'none';
    await screen(res, u, j, { lines, voiceId: vid, source });
  } catch (e) { next(e); } });

  function readForm(req) {
    const v = String(req.body.voice || ''); const ok = v === 'none' || voices.some(x => x.id === v);
    return { voiceId: ok ? v : 'none', lines: [1, 2, 3].map(i => String(req.body['line' + i] || '').slice(0, 140)) };
  }
  app.post('/jobs/:id/voice', sameOrigin, needUser(), form, async (req, res, next) => { try {
    const u = req.user, j = await jobsMod.getJob(u, req.params.id);
    if (!j || !open(u, j)) return res.redirect(303, '/');
    const { voiceId, lines } = readForm(req); const s = linesMod.sanitize(lines);
    // anything missing after cleaning is refilled from the standard lines so a video can always be made
    const fb = linesMod.templateLines(j.job_type); const final = s.lines.map((l, i) => l || fb[i]);
    await saveJob(j.id, final.join('\n\n'), voiceId);
    await pool.query("INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [rememberKey(u), voiceId]);
    if (s.notes.length) return screen(res, u, { ...j, voice_id: voiceId }, { lines: final, voiceId, notes: s.notes });
    const r = await getRender().start(u, j.id);
    res.redirect(303, `/jobs/${j.id}${r.error ? '?m=err' : ''}`);
  } catch (e) { next(e); } });

  // JSON versions (also what the tests use)
  app.post('/api/jobs/:id/lines/draft', sameOrigin, needUser({ json: true }), express.json({ limit: '2kb' }), async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!open(req.user, j || {}) || !j) return res.status(404).json({ error: 'Job not found.' });
    const d = await linesMod.draft(j.job_type); await saveJob(j.id, d.lines.join('\n\n'), j.voice_id); events('lines_drafted', req.user.id, j.id, d.source);
    res.set('Cache-Control', 'no-store').json({ lines: d.lines, source: d.source });
  } catch (e) { next(e); } });
  app.post('/api/jobs/:id/lines', sameOrigin, needUser({ json: true }), express.json({ limit: '4kb' }), async (req, res, next) => { try {
    const j = await jobsMod.getJob(req.user, req.params.id);
    if (!j || !open(req.user, j)) return res.status(404).json({ error: 'Job not found.' });
    const b = req.body || {}; const v = String(b.voice || ''); const voiceId = v === 'none' || voices.some(x => x.id === v) ? v : (j.voice_id || 'none');
    const s = linesMod.sanitize(Array.isArray(b.lines) ? b.lines : []);
    const fb = linesMod.templateLines(j.job_type); const final = s.lines.map((l, i) => l || fb[i]);
    await saveJob(j.id, final.join('\n\n'), voiceId);
    res.set('Cache-Control', 'no-store').json({ ok: s.ok, lines: final, removed: s.notes, voice: voiceId });
  } catch (e) { next(e); } });

  return { ensure };
};
