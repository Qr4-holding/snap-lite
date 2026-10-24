#!/usr/bin/env python3
"""Product shot: a phone on the SnapTheJob brand background playing a job video on its screen.

  python3 stj_phone.py job_site.mp4 out.mp4 [--seconds 8] [--format 9x16|1x1|16x9] [--caption "..."]

Uses the clean _site.mp4 from the snapthejob-video skill (no bars), so the phone shows what the
website player shows. Laid out natively for each shape: portrait = phone centred under the wordmark;
square = smaller phone centred; landscape = phone on the left, wordmark and strapline on the right.
Silent, slow push-in. The narrated engine calls make_phone() directly for {"phone": "..."} shots.
"""
import os, sys, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stj_ad as E
from PIL import Image, ImageDraw, ImageFilter

FORMATS = {'9x16': (1080, 1920), '1x1': (1080, 1080), '16x9': (1920, 1080)}


def layout(W, H):
    """Screen size and position, plus where the wordmark and strapline go."""
    if H > W:   # portrait
        SH = 1024; SW = SH * 9 // 16; x = (W - SW) // 2; y = 420
        return dict(SW=SW, SH=SH, SX=x, SY=y, mark=(W / 2, 180, 72), strap=(W / 2, H - 170, 40), cap=(W / 2, y + SH + 110, 52))
    if W > H:   # landscape
        SH = 820; SW = SH * 9 // 16; x = int(W * 0.30 - SW / 2); y = 150
        cx = W * 0.68
        return dict(SW=SW, SH=SH, SX=x, SY=y, mark=(cx, H / 2 - 120, 80), strap=(cx, H / 2 + 40, 46), cap=(cx, H / 2 + 130, 48))
    SH = 700; SW = SH * 9 // 16; x = (W - SW) // 2; y = 215   # square
    return dict(SW=SW, SH=SH, SX=x, SY=y, mark=(W / 2, 108, 54), strap=(W / 2, H - 90, 34), cap=None)


def frame_png(path, W, H, caption):
    L = layout(W, H); SW, SH, SX, SY = L['SW'], L['SH'], L['SX'], L['SY']
    BZ = max(14, SW // 26); PX, PY, PW, PH = SX - BZ, SY - BZ, SW + 2 * BZ, SH + 2 * BZ
    im = Image.new('RGBA', (W, H), (255, 255, 255, 255)); d = ImageDraw.Draw(im)
    cx, my, ms = L['mark']
    if E.BRAND:
        E.brand_mark(im, cx, my - ms * 0.4, ms * 6.5)
    else:
        fw = E.F('display', ms); parts = (('Snap', E.INK), ('The', E.RED), ('Job', E.INK))
        gap = ms * 1.2; tw = sum(fw.getlength(t) for t, _ in parts) + gap
        x = cx - tw / 2; E.logo(d, x, my + ms * 0.08, ms / 62); x += gap
        for t, c in parts: d.text((x, my), t, font=fw, fill=c); x += fw.getlength(t)
    sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((PX + 10, PY + 26, PX + PW + 10, PY + PH + 26), BZ * 3, fill=(0, 0, 0, 90))
    im.alpha_composite(sh.filter(ImageFilter.GaussianBlur(28)))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((PX, PY, PX + PW, PY + PH), BZ * 3, fill=(24, 25, 28, 255))
    mask = Image.new('L', (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle((SX, SY, SX + SW, SY + SH), BZ * 2, fill=255)
    im.paste(Image.new('RGBA', (W, H), (0, 0, 0, 0)), (0, 0), mask)
    d = ImageDraw.Draw(im)
    nw = SW // 5; d.rounded_rectangle((SX + SW / 2 - nw / 2, SY + 12, SX + SW / 2 + nw / 2, SY + 12 + SW // 22), SW // 44, fill=(24, 25, 28, 255))
    if caption and L['cap']:
        ccx, cy, cs = L['cap']; fc = E.F('display', cs)
        d.text((ccx - fc.getlength(caption) / 2, cy), caption, font=fc, fill=E.INK)
    sx, sy, ss = L['strap']; fs = E.F('display', ss); sp = (('Before, ', E.RED), ('After, ', E.INK), ('Share.', E.RED))
    if E.BRAND: sp = ((E.BRAND.get('strap', ''), E.INK),)
    x = sx - sum(fs.getlength(t) for t, _ in sp) / 2
    for t, c in sp: d.text((x, sy), t, font=fs, fill=c); x += fs.getlength(t)
    d.rectangle((0, H - 14, W, H), fill=E.BRAND['accent'] if E.BRAND else E.RED)
    im.save(path)
    return L


def make_phone(src, out, seconds, W, H, caption='', with_silent_audio=False):
    png = out + '.frame.png'; L = frame_png(png, W, H, caption)
    n = round(seconds * E.FPS)
    flt = (f"[1:v]scale={L['SW']}:{L['SH']}:force_original_aspect_ratio=increase,crop={L['SW']}:{L['SH']},fps={E.FPS},setsar=1,"
           f'tpad=stop_mode=clone:stop_duration={seconds + 1:.2f}[scr];'
           f"color=white:s={W}x{H}:r={E.FPS}[bg];[bg][scr]overlay={L['SX']}:{L['SY']}[s1];[s1][0:v]overlay=0:0,"
           f"scale={W * 2}:{H * 2},zoompan=z='1+0.05*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={E.FPS},"
           f'setsar=1,format=yuv420p[v]')
    audio = (['-f', 'lavfi', '-t', f'{n / E.FPS:.4f}', '-i', f'anullsrc=r={E.SR}:cl=stereo'] if with_silent_audio else [])
    amap = (['-map', '2:a', '-c:a', 'aac', '-ar', str(E.SR), '-ac', '2'] if with_silent_audio else ['-an'])
    E.run(['ffmpeg', '-y', '-loop', '1', '-i', png, '-i', src] + audio + ['-filter_complex', flt, '-map', '[v]'] + amap +
          ['-frames:v', str(n), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out])
    os.remove(png)
    return n / E.FPS


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('out')
    ap.add_argument('--seconds', type=float, default=8.0)
    ap.add_argument('--format', default='9x16', choices=list(FORMATS))
    ap.add_argument('--caption', default='')
    a = ap.parse_args()
    W, H = FORMATS[a.format]
    print('done', a.out, make_phone(a.src, a.out, a.seconds, W, H, a.caption), 's')


if __name__ == '__main__':
    main()
