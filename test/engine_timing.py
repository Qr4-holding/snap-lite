#!/usr/bin/env python3
"""Engine timing tests that need no server: a made-up voice with known word times, five photos (three DURING), and a very short line 1.
Checks: every photo is shown (silence is added instead), no still is under 0.6 s, each cut is on the first word of its line (40 ms),
audio and video are the same length.   python3 test/engine_timing.py"""
import json, os, re, subprocess, sys, tempfile, base64
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
tmp = tempfile.mkdtemp(prefix='sl-eng-'); fails = 0
def ok(name, cond, extra=''):
    global fails
    print(('PASS  ' if cond else 'FAIL  ') + name + ('' if cond else '  ' + str(extra)))
    if not cond: fails += 1
logo = os.path.join(ROOT, 'skins/ekp11/logo.png')
if not os.path.exists(logo): open(logo, 'wb').write(base64.b64decode(open(logo + '.b64').read()))
cols = [(200, 30, 30), (30, 160, 30), (30, 30, 200), (200, 200, 30), (30, 200, 200)]
def photo(i, size): p = os.path.join(tmp, f'p{i}.jpg'); Image.new('RGB', size, cols[i]).save(p); return p
# voice: line 1 is short (0.30-1.00 s), line 2 at 2.0-3.2 s, line 3 at 3.7-5.5 s; speech is a tone, the rest silence
voice = os.path.join(tmp, 'v.mp3')
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=6', '-af', "volume='if(between(t,0.3,1.0)+between(t,2.0,3.2)+between(t,3.7,5.5),1,0)':eval=frame", voice], check=True)
def words(txt, a, b):
    w = txt.split(); step = (b - a) / len(w); return [[x, round(a + i * step, 3), round(a + (i + 1) * step, 3)] for i, x in enumerate(w)]
LINES = [{'text': 'Here it was.', 'start': 0.3, 'end': 1.0, 'words': words('Here it was.', 0.3, 1.0)},
         {'text': 'And now it is clear.', 'start': 2.0, 'end': 3.2, 'words': words('And now it is clear.', 2.0, 3.2)},
         {'text': 'EKP11. Skip the skip.', 'start': 3.7, 'end': 5.5, 'words': words('EKP11 Skip the skip', 3.7, 5.5)}]
def run(name, nduring, lines):
    cfg = {'out': f'{tmp}/{name}.mp4', 'cover': f'{tmp}/{name}.jpg', 'work': f'{tmp}/w{name}', 'orientation': 'auto',
           'brand': {'logo': logo, 'accent': '#018603', 'strap': 'Skip the skip.', 'web': 'ekp11.co.uk', 'phone': '0785 046 4204', 'email': 'info@ekp11.co.uk'},
           'end_card': {'headline': 'See the job before you book.', 'button': 'Get a free quote', 'hold_seconds': 5},
           'photos': [{'kind': 'before', 'src': photo(0, (900, 1200))}] + [{'kind': 'during', 'src': photo(1 + i, (900, 1200))} for i in range(nduring)] + [{'kind': 'after', 'src': photo(4, (900, 1200))}],
           'voice': voice, 'lines': lines}
    json.dump(cfg, open(f'{tmp}/{name}.json', 'w'))
    r = subprocess.run([sys.executable, '-I', os.path.join(ROOT, 'video/engine.py'), f'{tmp}/{name}.json'], capture_output=True, text=True)
    m = re.search(r'RESULT (\{.*\})', r.stdout)
    return (json.loads(m.group(1)) if m else None), cfg['out'], r.stderr[-300:]
def frames(f):
    import numpy as np
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-vf', 'scale=24:40,format=rgb24', '-f', 'rawvideo', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, 24 * 40 * 3).astype(float)
def runs(f):
    """Lengths in seconds of the runs of near-identical pictures (each photo is a flat colour plus a label)."""
    fr = frames(f); cuts = [0] + [i for i in range(1, len(fr)) if abs(fr[i] - fr[i - 1]).mean() > 12] + [len(fr)]
    return [(cuts[i], (cuts[i + 1] - cuts[i]) / 25) for i in range(len(cuts) - 1)]

res, out, err = run('short', 3, LINES)
ok('a very short line 1 with three DURING photos still renders', res is not None and res['ok'], err or res)
if res:
    ok('all five photos are shown (BEFORE, three DURING, reveal)', res['stills'] == 4, res['stills'])
    ok('silence was added before line 2 to make room', any(p['before_line'] == 2 and p['seconds'] > 0 for p in res['padding']), res['padding'])
    ok('every cut is within 40 ms of its line\'s first word', all(t['err_ms'] <= 40 for t in res['timing']) and len(res['timing']) == 3, res['timing'])
    r = runs(out)
    first_cut = res['timing'][1]['cut_s']; before_reveal = [x for x in r if 0.8 - 0.001 <= x[0] / 25 < first_cut - 0.001]
    ok('four stills before the reveal, none under 0.6 s', len(before_reveal) >= 4 and all(x[1] >= 0.6 - 0.001 for x in before_reveal[:4]), before_reveal)
    ok('audio and video are the same length', abs(res['audio'] - res['duration']) <= 0.041, res)
res2, out2, err2 = run('roomy', 1, [dict(LINES[0], end=2.2, start=0.3, words=words('Here is the yard before we started.', 0.3, 2.2))] + LINES[1:])
ok('a long enough line 1 needs no padding', res2 is not None and res2['ok'] and res2['padding'] == [], res2 and res2['padding'])
# a line with no word timings falls back to the pause
nolw = json.loads(json.dumps(LINES)); nolw[1]['words'] = []
res3, _, err3 = run('nowords', 1, nolw)
ok('a line without word timings falls back to the pause before it', res3 is not None and res3['timing'][1]['source'] == 'pause', err3 or res3)
print(f'\n{fails} failed' if fails else '\nall engine timing tests passed')
sys.exit(1 if fails else 0)
