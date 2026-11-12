#!/usr/bin/env python3
"""Check a level's line timing against its vocals and fix lines that start too early.

usage: ~/.cache/lyric-align/.venv/bin/python charting/check_sync.py <level-id> [--fix]

demucs separates the vocals (cached in charting/work/<id>/). A line whose time falls in vocal silence that
lasts more than 0.4 s is flagged as early; --fix moves it to the vocal onset (previous chart kept as
chart.lrc.json). Lines sung straight on from the previous one can't be checked this way and are left alone.
Prints times only (no lyrics). Whisper word timestamps were tried for this and proved unreliable on sung audio."""
import argparse, json, os, shutil, subprocess, sys

ap = argparse.ArgumentParser()
ap.add_argument("id")
ap.add_argument("--fix", action="store_true")
a = ap.parse_args()
HERE = os.path.dirname(os.path.abspath(__file__))
LEVEL = os.path.join(HERE, "..", "public", "levels", a.id)
WORK = os.path.join(HERE, "work", a.id)
os.makedirs(WORK, exist_ok=True)
wav = os.path.join(WORK, "song.wav")
vocals = os.path.join(WORK, "sep", "htdemucs", "song", "vocals.wav")
if not os.path.exists(vocals):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", os.path.join(LEVEL, "audio@1.00.ogg"), "-ar", "44100", wav], check=True)
    subprocess.run([sys.executable, "-m", "demucs", "-n", "htdemucs", "--two-stems", "vocals", "-o", os.path.join(WORK, "sep"), wav],
                   check=True, capture_output=True)

import librosa
y, sr = librosa.load(vocals, sr=22050)
hop = 220
r = librosa.feature.rms(y=y, hop_length=hop)[0]
r /= r.max()
fps = sr / hop
ON = 0.06

chart = json.load(open(os.path.join(LEVEL, "chart.json")))
lines = chart["lines"]
fixed = 0
for i, l in enumerate(lines):
    if not l["text"].strip(): continue
    k = int(max(0, l["t"] - 0.2) * fps)
    while k < len(r) and r[k] <= ON: k += 1
    # walk back to where the onset starts rising (RMS above a third of the threshold)
    while k > 0 and r[k - 1] > ON / 3: k -= 1
    on = round(k / fps, 3)
    early = on > l["t"] + 0.4
    nxt = next((x["t"] for x in lines[i + 1:]), None)
    note = ""
    if early:
        if nxt is not None and on >= nxt - 0.3: note = "  <-- early, but the onset is past the next line; left alone"
        elif a.fix:
            note = f"  <-- early, moved to {on:.2f}"; l["t"] = on; fixed += 1
        else: note = "  <-- early"
    print(f"{i:3}  {l['t'] if not (early and a.fix and 'moved' in note) else on:7.2f}  vocal from {on:7.2f}{note}")

if a.fix and fixed:
    src = os.path.join(LEVEL, "chart.json")
    if not os.path.exists(os.path.join(LEVEL, "chart.lrc.json")):
        shutil.copyfile(src, os.path.join(LEVEL, "chart.lrc.json"))
    chart["source"] = chart.get("source", "") + "+synccheck"
    json.dump(chart, open(src, "w"), indent=1, ensure_ascii=False)
    print(f"fixed {fixed} line(s); wrote {src}")
