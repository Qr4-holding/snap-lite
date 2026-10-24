#!/usr/bin/env python3
"""Independent check of a finished video: finds the picture cuts (scene changes) and the speech onsets (silence ends) in the file itself,
then compares the cuts to the first spoken word of lines 2 and 3 given as video-time seconds.   cuts_check.py video.mp4 t2 t3"""
import re, subprocess, sys
f = sys.argv[1]; want = [float(x) for x in sys.argv[2:4]]
v = subprocess.run(['ffmpeg', '-i', f, '-vf', "select='gt(scene,0.25)',showinfo", '-an', '-f', 'null', '-'], capture_output=True, text=True).stderr
cuts = [float(x) for x in re.findall(r'pts_time:([\d.]+)', v)]
a = subprocess.run(['ffmpeg', '-i', f, '-af', 'silencedetect=noise=-35dB:d=0.12', '-vn', '-f', 'null', '-'], capture_output=True, text=True).stderr
onsets = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', a)]
print('cuts', cuts); print('onsets', onsets)
bad = 0
for k, t in enumerate(want, start=2):
    c = min(cuts, key=lambda x: abs(x - t)) if cuts else None
    o = min(onsets, key=lambda x: abs(x - t)) if onsets else None
    ce = abs(c - t) * 1000 if c is not None else 9999; oe = abs(o - c) * 1000 if (o is not None and c is not None) else 9999
    print(f'line {k}: first word {t:.3f}s  cut {c}  ({ce:.0f} ms)  audio onset {o} ({oe:.0f} ms from the cut)')
    if ce > 40: bad += 1
sys.exit(1 if bad else 0)
