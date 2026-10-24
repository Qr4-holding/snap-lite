#!/usr/bin/env python3
"""SnapTheJob narrated ad engine v2 (pictures + one narrator voice), every format built natively.

Silent shot clips (VideoExpress video-only) are cut to a single narrator take: each
narrator line plays over its own shots, pictures change exactly as each line starts,
clip sound is muted, captions follow the voice, then the branded end card.

  python3 stj_narrated.py ad.json --check   # rules check on every line
  python3 stj_narrated.py ad.json --plan    # where each line starts and ends in the voice file
  python3 stj_narrated.py ad.json --stills  # contact sheet per format
  python3 stj_narrated.py ad.json           # render full ad in every format + .srt

ad.json (narrated):
  {"id": "...", "audience": "public", "live_claims": [], "voice": "vo.mp3",
   "lines": [{"text": "Narrator line", "shots": ["shots/shot-01.mp4", "shots/shot-02.mp4"]}, ...],
   "end_card": {"headline": "See the job before you hire.", "button": "Watch real jobs"},
   "end_line_on_card": true, "formats": ["9x16", "1x1", "16x9"], "out": "out"}
The voice file holds every line in order with a clear pause between lines (one take).
With "end_line_on_card": true the LAST line plays over the end card and lists no shots.
"""
import json, os, sys, re, math, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stj_ad as E

FPS, SR = E.FPS, E.SR


def ease(t): t = max(0.0, min(1.0, t)); return 1 - (1 - t) ** 3


def check(ad):
    """Reuse the ad rules by presenting the narrator lines as scenes."""
    fake = {'audience': ad.get('audience'), 'live_claims': ad.get('live_claims', []),
            'end_card': ad.get('end_card', {}), 'meta': ad.get('meta', {}), 'characters': {},
            'scenes': []}
    errs, warns = [], []
    texts = [(f'line {i}', l['text']) for i, l in enumerate(ad['lines'], 1)]
    texts += [('end card headline', ad['end_card'].get('headline', '')), ('end card button', ad['end_card'].get('button', ''))]
    for tag in ('captions', 'headlines'):
        for j, t in enumerate(ad.get('meta', {}).get(tag, []), 1): texts.append((f'meta {tag} {j}', t))
    live = set(ad.get('live_claims', []))
    for where, t in texts:
        low = E.lc(t); scan = low
        for ph in E.APPROVED_PHRASES: scan = scan.replace(ph, ' ')
        for pat in E.BANNED:
            if re.search(pat, scan): errs.append(f'{where}: banned word /{pat}/ in "{t}"')
        for pat in E.COMPETITORS:
            if re.search(pat, low): errs.append(f'{where}: names a competitor or platform in "{t}"')
        for key, pats in E.GATED.items():
            if key in live: continue
            if any(re.search(pat, low) for pat in pats):
                errs.append(f'{where}: claim "{key}" is not live yet ("{t}")')
        if re.search(E.CONTACT, low): errs.append(f'{where}: no phone numbers, emails or web addresses ("{t}")')
        if re.search(r'\d', t): warns.append(f'{where}: contains a figure ("{t}"); sourced numbers only')
    n = len(ad['lines'])
    words = [len(l['text'].split()) for l in ad['lines']]; total = sum(words) or 1
    for i, l in enumerate(ad['lines'], 1):
        share = sum(words[:i - 1]) / total   # how far through the narration this line starts
        if re.search(E.PRODUCT, E.lc(l['text'])) and share < 0.4:
            errs.append(f'line {i} mentions the product {share:.0%} of the way in (must be 40% or later)')
        if not l.get('shots') and not (ad.get('end_line_on_card') and i == n):
            errs.append(f'line {i} has no shots')
    tw = sum(words)
    target = ad.get('target_seconds', 30)
    est = tw / 2.4 + 1.5   # about 2.4 spoken words a second, plus pauses
    if est > target * 1.15: warns.append(f'{tw} narrator words is about {est:.0f} s; aim for about {int((target - 1.5) * 2.4)} words for {target} s')
    hl = ad['end_card'].get('headline')
    if not ad.get('brand') and hl and hl not in E.APPROVED_HEADLINES.get(ad.get('audience'), []):
        warns.append('end card headline is not one of the approved headlines in the Thesis')
    for e in errs: print('ERROR  ', e)
    for w in warns: print('warning', w)
    print(f'check: {len(errs)} errors, {len(warns)} warnings')
    return errs


WORDS = []


def _norm(w): return re.sub(r'[^a-z]', '', w.lower())


def line_spans_by_words(mp3, texts):
    """Find each line's start by matching its first two words in a word-timed transcript (faster-whisper).
    Cuts sit halfway between the previous word's end and the line's first word. Returns None if unavailable."""
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except ImportError:
        return None
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', mp3, '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'],
                         capture_output=True).stdout
    segs, _ = WhisperModel('base.en', device='cpu', compute_type='int8').transcribe(
        np.frombuffer(raw, np.float32), word_timestamps=True)
    words = [(_norm(w.word), w.start, w.end) for s in segs for w in s.words if _norm(w.word)]
    WORDS[:] = words
    alias = {'snapthejob': ['snap', 'the', 'job']}
    def first_two(t):
        toks = []
        for w in t.split():
            toks += alias.get(_norm(w), [_norm(w)] if _norm(w) else [])
        return toks[:2]
    starts, k = [0.0], 0
    for t in texts[1:]:
        a, b = first_two(t); found = None
        for j in range(k + 1, len(words) - 1):
            if words[j][0] in (a, a.replace('neighbour', 'neighbor')) and words[j + 1][0] == b:
                found = j; break
        if found is None:
            print(f'ALIGN WARNING: could not find the start of "{t[:40]}"; falling back to pauses'); return None
        starts.append(round((words[found - 1][2] + words[found][1]) / 2, 3)); k = found
    dur = E.duration(mp3)
    return [(starts[i], starts[i + 1] if i + 1 < len(starts) else dur) for i in range(len(starts))]


def line_spans(mp3, n, texts=None):
    """Start/end of each line: by matching words when possible, else at the n-1 longest pauses."""
    if texts:
        spans = line_spans_by_words(mp3, texts)
        if spans: return spans
    err = subprocess.run(['ffmpeg', '-i', mp3, '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    st = [float(x) for x in re.findall(r'silence_start: (-?[\d.]+)', err)]
    en = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', err)]
    dur = E.duration(mp3)
    gaps = sorted([(e - s, s, e) for s, e in zip(st, en) if s > 0.2 and e < dur - 0.2], reverse=True)
    if len(gaps) < n - 1:
        sys.exit(f'VOICE ERROR: found {len(gaps)} pauses, need {n - 1}. Regenerate the voice with a blank line between lines.')
    cuts = sorted(gaps[:n - 1], key=lambda g: g[1])
    starts = [0.0] + [round((g[1] + g[2]) / 2, 3) for g in cuts]   # cut in the middle of each pause
    return [(starts[i], starts[i + 1] if i + 1 < n else dur) for i in range(n)]


GRADES = {'memory': 'eq=saturation=0.45:contrast=0.92:brightness=0.02,vignette=PI/4.5',
          'none': 'null'}
IMG_EXT = ('.png', '.jpg', '.jpeg', '.webp')
FIT_RATIO = 1.3   # if image and frame shapes differ by more than this, fit over a blurred fill instead of cropping


def _plate(img, W, H, mode):
    """Image placed on a W x H canvas: 'cover' crops to fill; 'fit' shows it whole over a blurred, darkened copy."""
    from PIL import Image, ImageFilter, ImageEnhance
    im = img.convert('RGB')
    r_img, r_out = im.width / im.height, W / H
    if mode == 'auto': mode = 'fit' if max(r_img, r_out) / min(r_img, r_out) > FIT_RATIO else 'cover'
    def cover(x):
        s = max(W / x.width, H / x.height); x = x.resize((round(x.width * s), round(x.height * s)), Image.LANCZOS)
        l, t = (x.width - W) // 2, (x.height - H) // 2
        return x.crop((l, t, l + W, t + H))
    if mode == 'cover': return cover(im)
    bg = cover(im).filter(ImageFilter.GaussianBlur(W // 25)); bg = ImageEnhance.Brightness(bg).enhance(0.72)
    s = min(W / im.width, H / im.height); fg = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    bg.paste(fg, ((W - fg.width) // 2, (H - fg.height) // 2))
    return bg


def shot_segment(shot, d, out, W, H, work):
    """d seconds of one shot as silent W x H video.
    shot = path, or {"src": path, "motion": "in|out|left|right|none", "grade": "memory", "fit": "auto|fit|cover"},
    or {"split": [before, after]} for a before/after reveal that ends on the full AFTER ("finish": "split" holds the split),
    or {"phone": "job_site.mp4"} for the product shot (a SnapTheJob job video on a phone).
    Stills get slow camera motion; clips are held on their last frame if shorter than d."""
    from PIL import Image
    if isinstance(shot, str): shot = {'src': shot}
    nf = max(1, round(d * FPS))
    silent_audio = ['-f', 'lavfi', '-t', f'{nf / FPS:.4f}', '-i', f'anullsrc=r={SR}:cl=stereo']
    enc = ['-frames:v', str(nf), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19',
           '-c:a', 'aac', '-ar', str(SR), '-ac', '2', out]
    if 'split' in shot:
        return split_segment(shot, nf, out, W, H, silent_audio, enc)
    if 'phone' in shot:   # product shot: a SnapTheJob job video playing on a phone, laid out for this shape
        import stj_phone
        return stj_phone.make_phone(E.p(shot['phone']), out, nf / FPS, W, H, shot.get('caption', ''), with_silent_audio=True)
    src, motion = shot['src'], shot.get('motion', 'in')
    grade = GRADES.get(shot.get('grade', 'none'), 'null')
    if src.lower().endswith(IMG_EXT):
        plate = _plate(Image.open(E.p(src)), W * 2, H * 2, shot.get('fit', 'auto'))
        pp = os.path.join(work, os.path.basename(out) + '.plate.png'); plate.save(pp)
        Z = 0.08
        z = {'in': f"1+{Z}*on/{nf}", 'out': f"1+{Z}-{Z}*on/{nf}"}.get(motion, f"1+{Z / 2}")
        x = {'left': f"(iw-iw/zoom)*(1-on/{nf})", 'right': f"(iw-iw/zoom)*on/{nf}"}.get(motion, "iw/2-(iw/zoom/2)")
        flt = (f"[0:v]zoompan=z='{z}':x='{x}':y='ih/2-(ih/zoom/2)':d={nf}:s={W}x{H}:fps={FPS},"
               f'{grade},setsar=1,format=yuv420p[v]')
        E.run(['ffmpeg', '-y', '-loop', '1', '-t', f'{nf / FPS + 0.2:.3f}', '-i', pp] + silent_audio +
              ['-filter_complex', flt, '-map', '[v]', '-map', '1:a'] + enc)
        os.remove(pp)
    else:
        vw, vh = map(int, E.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height',
                                 '-of', 'csv=p=0', E.p(src)]).stdout.strip().split(','))
        mode = shot.get('fit', 'auto')
        if mode == 'auto': mode = 'fit' if max(vw / vh, W / H) / min(vw / vh, W / H) > FIT_RATIO else 'cover'
        hold = f'tpad=stop_mode=clone:stop_duration={d + 1:.3f},trim=end_frame={nf},setpts=PTS-STARTPTS'
        if mode == 'cover':
            flt = (f'[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},{grade},setsar=1,'
                   f'{hold},format=yuv420p[v]')
        else:
            flt = (f'[0:v]fps={FPS},{grade},split[a][b];[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},'
                   f'gblur=sigma=40,eq=brightness=-0.12[bg];[b]scale={W}:{H}:force_original_aspect_ratio=decrease,setsar=1[fg];'
                   f'[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,{hold},format=yuv420p[v]')
        E.run(['ffmpeg', '-y', '-i', E.p(src)] + silent_audio + ['-filter_complex', flt, '-map', '[v]', '-map', '1:a'] + enc)
    return nf / FPS


def _label(img, text, x, y, size, right=False):
    from PIL import ImageDraw
    d = ImageDraw.Draw(img); f = E.F('display', size)
    acc = E.BRAND['accent'] if E.BRAND else E.RED
    bg, fg = (E.WHITE, acc) if text == 'BEFORE' else (acc, E.WHITE)
    pw = f.getlength(text) + size * 0.66; ph = size * 1.38
    x0 = x - pw if right else x
    d.rounded_rectangle((x0, y, x0 + pw, y + ph), int(size * 0.2), fill=bg)
    d.text((x0 + size * 0.33, y + size * 0.1), text, font=f, fill=fg)


def split_segment(shot, nf, out, W, H, silent_audio, enc):
    """Before/after reveal: the BEFORE frame, then AFTER wipes in from the right and holds as a 50/50 split."""
    from PIL import Image, ImageDraw
    b_src, a_src = shot['split']
    mode = shot.get('fit', 'cover')
    B = _plate(Image.open(E.p(b_src)), W, H, mode); A = _plate(Image.open(E.p(a_src)), W, H, mode)
    size = 64 if H > W else 52; ly = 120 if H > W else 100
    p = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
                          '-r', str(FPS), '-i', '-'] + silent_audio + ['-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p'] + enc,
                         stdin=subprocess.PIPE)
    finish = shot.get('finish', 'full')   # 'full' ends on the whole AFTER frame; 'split' holds the 50/50 split
    for k in range(nf):
        t = k / max(1, nf - 1)
        if finish == 'split':
            x = int(W - (W // 2) * ease((t - 0.15) / 0.4))
        else:   # before, wipe to the middle, hold the split, wipe on to the full after, hold the clean result
            if t < 0.45: x = int(W - (W // 2) * ease((t - 0.08) / 0.22))
            else: x = int((W // 2) * (1 - ease((t - 0.45) / 0.17)))
        fr = B.copy()
        if x < W: fr.paste(A.crop((x, 0, W, H)), (x, 0))
        d = ImageDraw.Draw(fr)
        if 0 < x < W: d.rectangle((x - 4, 0, x + 4, H), fill=E.WHITE)
        if x > W * 0.3: _label(fr, 'BEFORE', 32, ly, size)
        if x < W * 0.75: _label(fr, 'AFTER', W - 32, ly, size, right=True)
        p.stdin.write(fr.tobytes())
    p.stdin.close(); p.wait()
    return nf / FPS


def plan_shots(ad):
    """Timeline shared by every format: per line, its shots and their exact frame-locked durations."""
    n = len(ad['lines'])
    spans = line_spans(E.p(ad['voice']), n, [l['text'] for l in ad['lines']])
    items, cues, t = [], [], 0.0
    for i, (line, (a, b)) in enumerate(zip(ad['lines'], spans), 1):
        target_end = round(b * FPS) / FPS
        length = target_end - t
        if ad.get('end_line_on_card') and i == n:
            items.append({'kind': 'end', 'dur': max(float(ad.get('end_seconds', E.END_SECONDS)), length)})
        else:
            shots = line['shots']
            wts = [s.get('weight', 1) if isinstance(s, dict) else 1 for s in shots]; tot = sum(wts); made = 0.0; acc = 0
            for k, shot in enumerate(shots):
                acc += wts[k]
                d = (round((t + length * acc / tot) * FPS) / FPS) - (t + made); made += d
                items.append({'kind': 'shot', 'n': f'{i:02d}_{k}', 'shot': shot, 'dur': d})
        cues.append((a, b, line['text']))
        t = target_end
    return items, cues


def caption_cues_abs(cues):
    """Caption chunks timed to the spoken words when a word-timed transcript exists, else spread by length."""
    out = []
    for a, b, text in cues:
        parts = E.chunks(text)
        inside = [w for w in WORDS if a - 0.05 <= w[1] < b]
        times, k = [], 0
        for x in parts:  # start of each chunk = time of its first spoken word
            first = next((t for t in (_norm(t) for t in x.split()) if t), '')
            first = {'snapthejob': 'snap'}.get(first, first)
            while k < len(inside) and inside[k][0] != first and not inside[k][0].startswith(first[:4]): k += 1
            times.append(inside[k][1] if k < len(inside) else None); k += 1
        if inside and all(t is not None for t in times):
            for i, x in enumerate(parts):
                end = times[i + 1] - 0.02 if i + 1 < len(parts) else min(b - 0.05, inside[-1][2] + 0.6)
                out.append((max(a, times[i] - 0.05), end, x))
        else:
            total = sum(len(x) for x in parts); s0 = a + 0.05
            for x in parts:
                d = (b - a - 0.15) * len(x) / total; out.append((s0, s0 + d, x)); s0 += d
    return out


def render_format(ad, items, cues, fmt, work, out):
    W, H = E.FORMATS[fmt]
    files = []
    for it in items:
        if it['kind'] == 'end':
            png = os.path.join(work, f'end_{fmt}.png'); E.end_card_png(ad['end_card'], fmt, png)
            f = os.path.join(work, f'end_{fmt}.mp4'); d = it['dur']
            E.run(['ffmpeg', '-y', '-loop', '1', '-t', f'{d:.3f}', '-i', png, '-f', 'lavfi', '-t', f'{d:.3f}',
                   '-i', f'anullsrc=r={SR}:cl=stereo', '-map', '0:v', '-map', '1:a', '-shortest'] + E.norm_args(W, H) + [f])
        else:
            f = os.path.join(work, f's_{it["n"]}_{fmt}.mp4')
            shot_segment(it['shot'], it['dur'], f, W, H, work)
        files.append(f)
    segs = items
    silent = out + '.pics.mp4'
    E.concat(files, silent)
    # lay the narrator take over the pictures and burn the captions in one pass
    inputs, filt, last = ['-i', silent, '-i', E.p(ad['voice'])], [], '[0:v]'
    if ad.get('disclaimer'):  # small always-on label, e.g. "Dramatisation. AI-generated people and scenes."
        from PIL import Image, ImageDraw
        f = E.F('body', 26 if fmt == '9x16' else 24); t = ad['disclaimer']
        tw = int(f.getlength(t)) + 28; im = Image.new('RGBA', (tw, 44), (0, 0, 0, 0))
        dr = ImageDraw.Draw(im); dr.rounded_rectangle((0, 0, tw - 1, 43), 12, fill=E.INK + (150,))
        dr.text((14, 7), t, font=f, fill=(255, 255, 255, 230))
        dp = os.path.join(work, f'disclaimer_{fmt}.png'); im.save(dp)
        inputs += ['-i', dp]; filt.append(f'{last}[2:v]overlay=36:40[d0]'); last = '[d0]'
    for k, (a, b, text) in enumerate(caption_cues_abs(cues)):
        if ad.get('end_line_on_card') and a >= sum(s['dur'] for s in segs if s['kind'] != 'end') - 0.05: continue
        png = os.path.join(work, f'ncap_{fmt}_{k}.png'); x, y = E.caption_png(text, fmt, png)
        inputs += ['-i', png]; idx = len(inputs) // 2 - 1
        filt.append(f"{last}[{idx}:v]overlay={x}:{y}:enable='between(t,{a:.3f},{b:.3f})'[c{k}]"); last = f'[c{k}]'
    filt.append(f'{last}format=yuv420p[v]')
    total = E.duration(silent)
    filt.append(f'[1:a]aresample={SR},apad=whole_dur={total:.3f},atrim=end={total:.3f}[a]')
    E.run(['ffmpeg', '-y'] + inputs + ['-filter_complex', ';'.join(filt), '-map', '[v]', '-map', '[a]',
           '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', str(FPS), '-c:a', 'aac', '-b:a', '160k',
           '-movflags', '+faststart', out])
    os.remove(silent)


def write_srt(cues, path):
    def ts(x):
        ms = int(round(x * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
        return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'
    open(path, 'w').write('\n'.join(f'{k}\n{ts(a)} --> {ts(b)}\n{t}\n' for k, (a, b, t) in enumerate(caption_cues_abs(cues), 1)))


def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    jp = sys.argv[1]; E.AD_DIR = os.path.dirname(os.path.abspath(jp))
    ad = json.load(open(jp))
    if ad.get('brand'):   # client-branded ad: their logo, accent colour, tagline and web address replace SnapTheJob's
        b = ad['brand']; h = b['accent'].lstrip('#')
        E.BRAND = {'logo': E.p(b['logo']), 'accent': tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)),
                   'strap': b.get('strap', ''), 'web': b.get('web', ''), 'phone': b.get('phone', ''), 'email': b.get('email', '')}
    errs = check(ad)
    if '--check' in sys.argv: sys.exit(1 if errs else 0)
    if errs: sys.exit('Fix the errors above first.')
    if '--plan' in sys.argv:
        for i, (a, b) in enumerate(line_spans(E.p(ad['voice']), len(ad['lines']), [l['text'] for l in ad['lines']]), 1):
            print(f'line {i}: {a:6.2f}s to {b:6.2f}s  {ad["lines"][i - 1]["text"]}')
        return
    work = os.path.join(E.AD_DIR, 'work_n'); os.makedirs(work, exist_ok=True)
    outdir = E.p(ad.get('out', 'out')); os.makedirs(outdir, exist_ok=True)
    items, cues = plan_shots(ad)
    fmts = ad.get('formats', list(E.FORMATS))
    if '--stills' in sys.argv:
        from PIL import Image
        for fmt in fmts:
            out = os.path.join(work, f'preview_{fmt}.mp4'); render_format(ad, items, cues, fmt, work, out)
            ims, t = [], 0.0
            for seg in items:
                png = os.path.join(work, f'still_{fmt}_{len(ims)}.png')
                E.run(['ffmpeg', '-y', '-ss', f'{t + seg["dur"] / 2:.2f}', '-i', out, '-frames:v', '1', png])
                im = Image.open(png); im.thumbnail((360, 360)); ims.append(im); t += seg['dur']
            cols = min(6, len(ims)); rows = math.ceil(len(ims) / cols)
            sheet = Image.new('RGB', (ims[0].width * cols, ims[0].height * rows), (200, 200, 200))
            for k, im in enumerate(ims): sheet.paste(im, ((k % cols) * ims[0].width, (k // cols) * ims[0].height))
            sp = os.path.join(E.AD_DIR, f'stills_{fmt}.png'); sheet.save(sp); print('stills ->', sp)
        return
    for fmt in fmts:
        out = os.path.join(outdir, f"{ad['id']}_{fmt}.mp4")
        render_format(ad, items, cues, fmt, work, out)
        print(f'done {out}  {E.duration(out):.1f}s')
    write_srt(cues, os.path.join(outdir, f"{ad['id']}.srt"))


if __name__ == '__main__':
    main()
