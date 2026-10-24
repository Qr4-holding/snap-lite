#!/usr/bin/env python3
"""Snap Lite video engine.

One job in, one branded before/after video out. Nothing of SnapTheJob appears in the output: the client's logo,
accent colour, phone, email and tagline only.

    python3 video/engine.py job.json

job.json (written by the server for every render):
  {
    "out": "/abs/video.mp4", "cover": "/abs/cover.jpg", "work": "/abs/tmp-dir",
    "orientation": "portrait" | "landscape" | "auto",       # follows the BEFORE photo
    "brand": {"logo": "/abs/logo.png", "accent": "#018603", "strap": "...", "web": "...", "phone": "...", "email": "..."},
    "end_card": {"headline": "...", "button": "...", "hold_seconds": 5},
    "photos": [{"kind": "before|during|after", "src": "/abs/photo.jpg"}, ...],
    "voice": null | "/abs/voice.mp3",
    "lines": [{"text": "caption text", "start": 0.0, "end": 3.1, "words": [["word", 0.0, 0.3], ...]}, ...]  # with a voice
  }

Timeline: cover (split thumbnail, play button) -> BEFORE -> DURING (each) -> reveal (before, wipe to a 50/50 split,
short hold, wipe on to the full AFTER, hold it) -> end card. With a voice, the photos change on the pauses between
the lines: line 1 plays over before/during, line 2 over the reveal, line 3 over the end card; captions follow the words.
Every segment is a whole number of frames, and the finished file is checked: audio and video lengths equal to the frame.
"""
import json, os, sys, re, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from PIL import Image, ImageDraw
import stj_ad as E
import stj_narrated as N

FPS, SR = E.FPS, E.SR
COVER_S, BEFORE_S, DURING_S, REVEAL_S = 0.8, 2.2, 1.6, 3.6
MIN_REVEAL_S, MIN_HOLD_S = 2.8, 1.2
INK = E.INK
ENC = ['-c:v', 'libx264', '-preset', os.environ.get('STJ_PRESET', 'veryfast'), '-crf', '19', '-pix_fmt', 'yuv420p']


def hexrgb(h): h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
def frames(sec): return max(1, round(sec * FPS))
def log(*a): print(*a, flush=True)


def photo_is_portrait(im): return im.height >= im.width


def plate_for(path, W, H):
    """Photo on a W x H canvas. Same shape as the video: fill the frame (crop). Different shape: whole photo over a blurred copy."""
    im = Image.open(path)
    from PIL import ImageOps
    im = ImageOps.exif_transpose(im).convert('RGB')
    same = photo_is_portrait(im) == (H >= W)
    return N._plate(im, W, H, 'cover' if same else 'fit')


def encoder(W, H, out, nf):
    silent = ['-f', 'lavfi', '-t', f'{nf / FPS:.4f}', '-i', f'anullsrc=r={SR}:cl=stereo']
    return subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-'] + silent +
                            ['-map', '0:v', '-map', '1:a'] + ENC + ['-frames:v', str(nf), '-c:a', 'aac', '-ar', str(SR), '-ac', '2', out], stdin=subprocess.PIPE)


def label(img, text, W, H):
    size = 64 if H > W else 52; ly = 120 if H > W else 100
    if text == 'DURING':
        d = ImageDraw.Draw(img); f = E.F('display', size)
        pw = f.getlength(text) + size * .66; ph = size * 1.38
        d.rounded_rectangle((32, ly, 32 + pw, ly + ph), int(size * .2), fill=INK)
        d.text((32 + size * .33, ly + size * .1), text, font=f, fill=E.WHITE)
    else:
        N._label(img, text, 32, ly, size)


def still_segment(plate, text, nf, out, W, H, zoom_dir='in'):
    """A photo held for nf frames with a slow push-in and its label."""
    big = plate.resize((round(W * 1.08), round(H * 1.08)), Image.LANCZOS)
    p = encoder(W, H, out, nf)
    for k in range(nf):
        t = k / max(1, nf - 1); z = (t if zoom_dir == 'in' else 1 - t) * 0.08 / 1.08
        cw, ch = big.width * (1 - z), big.height * (1 - z); l, tp = (big.width - cw) / 2, (big.height - ch) / 2
        fr = big.crop((round(l), round(tp), round(l + cw), round(tp + ch))).resize((W, H), Image.BILINEAR)
        label(fr, text, W, H); p.stdin.write(fr.tobytes())
    p.stdin.close(); p.wait()


def cover_frame(B, A, W, H):
    fr = B.copy(); fr.paste(A.crop((W // 2, 0, W, H)), (W // 2, 0))
    d = ImageDraw.Draw(fr); d.rectangle((W // 2 - 4, 0, W // 2 + 4, H), fill=E.WHITE)
    size = 64 if H > W else 52; ly = 120 if H > W else 100
    N._label(fr, 'BEFORE', 32, ly, size); N._label(fr, 'AFTER', W - 32, ly, size, right=True)
    r = int(min(W, H) * .085); cx, cy = W // 2, H // 2
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=E.WHITE)
    d.polygon([(cx - r * .32, cy - r * .5), (cx - r * .32, cy + r * .5), (cx + r * .55, cy)], fill=INK)
    return fr


def still_frame_segment(fr, nf, out, W, H):
    p = encoder(W, H, out, nf); raw = fr.tobytes()
    for _ in range(nf): p.stdin.write(raw)
    p.stdin.close(); p.wait()


def reveal_segment(B, A, nf, out, W, H):
    """Before, wipe to a 50/50 split, short hold, wipe on to the full AFTER, hold the clean result (never ends on the split)."""
    size = 64 if H > W else 52; ly = 120 if H > W else 100
    p = encoder(W, H, out, nf)
    for k in range(nf):
        t = k / max(1, nf - 1)
        if t < 0.45: x = int(W - (W // 2) * N.ease((t - 0.08) / 0.22))
        else: x = int((W // 2) * (1 - N.ease((t - 0.45) / 0.17)))
        fr = B.copy()
        if x < W: fr.paste(A.crop((x, 0, W, H)), (x, 0))
        if 0 < x < W: ImageDraw.Draw(fr).rectangle((x - 4, 0, x + 4, H), fill=E.WHITE)
        if x > W * 0.3: N._label(fr, 'BEFORE', 32, ly, size)
        if x < W * 0.75: N._label(fr, 'AFTER', W - 32, ly, size, right=True)
        p.stdin.write(fr.tobytes())
    p.stdin.close(); p.wait()


def concat(files, out):
    lst = out + '.txt'; open(lst, 'w').write(''.join(f"file '{os.path.abspath(f)}'\n" for f in files))
    E.run(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', out]); os.remove(lst)


# ---------------------------------------------------------------- voice timing
def line_cuts(lines):
    """Where each line starts in the voice: halfway through the pause before it. Returns [start1, start2, start3, ...]."""
    starts = [0.0]
    for prev, cur in zip(lines, lines[1:]):
        starts.append(round((prev['end'] + cur['start']) / 2, 3))
    return starts


def caption_cues(lines, offset):
    """Caption chunks (never across a sentence end, at most 5 words) timed to the spoken words. The written text may have a
    different number of words from what was spoken (EKP11 is spoken 'E K P eleven'), so chunks are mapped by position."""
    cues = []
    for ln in lines:
        words = ln.get('words') or []
        parts = E.chunks(ln['text'])
        nw = sum(len(p.split()) for p in parts)
        if not parts or nw == 0: continue
        k = 0
        for i, part in enumerate(parts):
            n = len(part.split())
            if words:
                s_idx = min(len(words) - 1, round(k * len(words) / nw)); e_idx = min(len(words) - 1, max(s_idx, round((k + n) * len(words) / nw) - 1))
                a = words[s_idx][1]; b = words[e_idx][2]
                if i + 1 < len(parts):
                    nxt = min(len(words) - 1, round((k + n) * len(words) / nw)); b = max(b, min(words[nxt][1] - 0.02, b + 0.5))
                else: b += 0.35
            else:
                span = ln['end'] - ln['start']; a = ln['start'] + span * k / nw; b = ln['start'] + span * (k + n) / nw
            cues.append((a + offset - 0.05, b + offset, part)); k += n
    cues.sort(key=lambda c: c[0])
    return [(a, min(b, cues[i + 1][0] - 0.02) if i + 1 < len(cues) else b, t) for i, (a, b, t) in enumerate(cues)]   # never two captions at once


# ---------------------------------------------------------------- main
def render(cfg):
    work = cfg['work']; os.makedirs(work, exist_ok=True)
    photos = cfg['photos']
    before = next(p for p in photos if p['kind'] == 'before'); after = next(p for p in photos if p['kind'] == 'after')
    during = [p for p in photos if p['kind'] == 'during'][:3]
    b0 = Image.open(before['src'])
    from PIL import ImageOps
    portrait = cfg.get('orientation', 'auto') == 'portrait' or (cfg.get('orientation', 'auto') == 'auto' and photo_is_portrait(ImageOps.exif_transpose(b0)))
    fmt, (W, H) = ('9x16', E.FORMATS['9x16']) if portrait else ('16x9', E.FORMATS['16x9'])
    br = cfg['brand']
    E.BRAND = {'logo': br['logo'], 'accent': hexrgb(br['accent']), 'strap': br.get('strap', ''), 'web': br.get('web', ''), 'phone': br.get('phone', ''), 'email': br.get('email', '')}
    ec = cfg['end_card']
    B, A = plate_for(before['src'], W, H), plate_for(after['src'], W, H)

    voice = cfg.get('voice') or None
    lines = cfg.get('lines') or []
    vdur = E.duration(voice) if voice else 0.0
    # ---- durations in whole frames
    cover_f = frames(COVER_S)
    hold_s = float(ec.get('hold_seconds', 5))
    if voice and len(lines) >= 3:
        cuts = line_cuts(lines)                                     # line starts in the voice
        mid = frames(max(len(during) + 1, 1) * 1.4)                 # never shorter than 1.4 s per photo
        first_end = max(frames(cuts[1]), mid)                       # before + during end where line 2 starts
        reveal_f = max(frames(MIN_REVEAL_S), frames(cuts[2]) - first_end)
        end_f = max(frames(hold_s), frames(vdur - cuts[2] + 0.8) if vdur - cuts[2] + 0.8 > 0 else 0)
        n_still = 1 + len(during)
        each = [first_end // n_still + (1 if i < first_end % n_still else 0) for i in range(n_still)]
    else:
        each = [frames(BEFORE_S)] + [frames(DURING_S)] * len(during)
        reveal_f = frames(REVEAL_S); end_f = frames(hold_s)
        if voice:   # a single recording with no line timings: spread over the photos
            extra = max(0, frames(vdur + 0.6) - (sum(each) + reveal_f)); each = [e + extra // len(each) for e in each]
    segs = []
    def add(name, fn): out = os.path.join(work, f'{name}.mp4'); fn(out); segs.append(out)
    fr0 = cover_frame(B, A, W, H)
    add('cover', lambda o: still_frame_segment(fr0, cover_f, o, W, H))
    add('before', lambda o: still_segment(B, 'BEFORE', each[0], o, W, H))
    for i, d in enumerate(during):
        add(f'during{i}', lambda o, d=d, i=i: still_segment(plate_for(d['src'], W, H), 'DURING', each[1 + i], o, W, H))
    add('reveal', lambda o: reveal_segment(B, A, reveal_f, o, W, H))
    png = os.path.join(work, 'end.png'); E.end_card_png(ec, fmt, png)
    endmp4 = os.path.join(work, 'end.mp4'); p = encoder(W, H, endmp4, end_f); raw = Image.open(png).convert('RGB').tobytes()
    for _ in range(end_f): p.stdin.write(raw)
    p.stdin.close(); p.wait(); segs.append(endmp4)
    joined = os.path.join(work, 'joined.mp4'); concat(segs, joined)
    total = (cover_f + sum(each) + reveal_f + end_f) / FPS

    # ---- captions and voice, in one pass
    cmd = ['ffmpeg', '-y', '-v', 'error', '-i', joined]
    cues = []
    if voice and lines:
        end_of_pictures = (cover_f + sum(each) + reveal_f) / FPS
        cues = [c for c in caption_cues(lines[:2], COVER_S) if c[0] < end_of_pictures]       # the closing line is on the end card itself
    nin = 1; filt = []; last = '0:v'
    if voice: cmd += ['-i', voice]; nin = 2
    for k, (a, b, text) in enumerate(cues):
        cp = os.path.join(work, f'cap{k}.png'); x, y = E.caption_png(text, fmt, cp)
        cmd += ['-i', cp]; filt.append(f"[{last}][{nin + k}:v]overlay={x}:{y}:enable='between(t,{a:.3f},{b:.3f})'[o{k}]"); last = f'o{k}'
    if voice:
        filt.append(f'[1:a]adelay={int(COVER_S * 1000)}:all=1,aresample={SR},loudnorm=I=-16:TP=-1.5:LRA=11,aresample={SR},apad=whole_dur={total:.3f},atrim=end={total:.3f}[a]')
    if filt: cmd += ['-filter_complex', ';'.join(filt)]
    cmd += ['-map', f'[{last}]' if cues else '0:v']
    cmd += ['-map', '[a]'] if voice else ['-map', '0:a']
    cmd += (ENC if cues else ['-c:v', 'copy']) + ['-c:a', 'aac', '-b:a', '160k', '-ar', str(SR), '-ac', '2', '-t', f'{total:.3f}', '-movflags', '+faststart', cfg['out']]
    E.run(cmd)

    # ---- cover image for the job list
    fr0.resize((540, 960) if portrait else (960, 540)).save(cfg['cover'], quality=85)

    # ---- the checks: every cut on a frame, audio and video the same length, right size
    def probe(stream, key):
        return float(E.run(['ffprobe', '-v', 'error', '-select_streams', stream, '-show_entries', f'stream={key}', '-of', 'csv=p=0', cfg['out']]).stdout.strip().split('\n')[0] or 0)
    vd, ad = probe('v', 'duration'), probe('a', 'duration')
    size = E.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', cfg['out']]).stdout.strip()
    errs = []
    if abs(vd - ad) > 1.0 / FPS + 1e-3: errs.append(f'audio {ad:.3f}s and video {vd:.3f}s differ by more than one frame')
    if abs(vd - total) > 1.0 / FPS + 1e-3: errs.append(f'length {vd:.3f}s, planned {total:.3f}s')
    if size != f'{W},{H}': errs.append(f'size {size}, expected {W}x{H}')
    result = {'ok': not errs, 'duration': round(vd, 3), 'audio': round(ad, 3), 'size': f'{W}x{H}', 'orientation': 'portrait' if portrait else 'landscape',
              'cuts_s': [round(x / FPS, 2) for x in (cover_f, cover_f + sum(each[:1]), cover_f + sum(each), cover_f + sum(each) + reveal_f)], 'errors': errs}
    for f in segs + [joined]:
        try: os.remove(f)
        except OSError: pass
    return result


def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    cfg = json.load(open(sys.argv[1]))
    res = render(cfg)
    print('RESULT ' + json.dumps(res))
    sys.exit(0 if res['ok'] else 1)


if __name__ == '__main__':
    main()
