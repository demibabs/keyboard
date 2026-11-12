#!/usr/bin/env python3
"""Estimate a whole-song timing offset between a level's lyric timestamps and its audio's vocals.

usage: ~/.cache/lyric-align/.venv/bin/python charting/song_offset.py ID... [--apply]

Uses the vocal stem check_sync.py left in charting/work/<id>/. Vocal phrase starts are where the vocals come
back after >= 0.3 s of quiet; for each candidate offset (-1.5..+6 s) it counts line starts that land within
0.25 s of a phrase start. A song gets an offset only if it clearly beats no offset (>= 3 more lines and at
least a third of lines). --apply shifts the original LRC times (chart.lrc.json, else chart.json) by it and
writes chart.json; run check_sync.py --fix again afterwards. Prints times and counts only."""
import json, os, shutil, sys
import librosa, numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ids = [a for a in sys.argv[1:] if not a.startswith("--")]
apply = "--apply" in sys.argv

def phrase_starts(vocals):
    y, sr = librosa.load(vocals, sr=22050)
    hop = 220
    r = librosa.feature.rms(y=y, hop_length=hop)[0]
    r /= r.max()
    on = r > 0.06
    starts, quiet = [], 0
    for i, v in enumerate(on):
        if v:
            if quiet * hop / sr >= 0.3:
                starts.append(i * hop / sr)
            quiet = 0
        else:
            quiet += 1
    return np.array(starts)

for lid in ids:
    level = os.path.join(HERE, "..", "public", "levels", lid)
    vocals = os.path.join(HERE, "work", lid, "sep", "htdemucs", "song", "vocals.wav")
    if not os.path.exists(vocals):
        print(f"{lid}: no vocal stem (run check_sync.py first)"); continue
    src = os.path.join(level, "chart.lrc.json") if os.path.exists(os.path.join(level, "chart.lrc.json")) else os.path.join(level, "chart.json")
    base = json.load(open(src))
    ts = np.array([l["t"] for l in base["lines"] if l["text"].strip()])
    ps = phrase_starts(vocals)
    def score(o):
        return int(sum(np.min(np.abs(ps - (t + o))) <= 0.25 for t in ts)) if len(ps) else 0
    offsets = np.round(np.arange(-1.5, 6.0001, 0.02), 2)
    scores = np.array([score(o) for o in offsets])
    best = offsets[int(np.argmax(scores))]
    s0, sb = score(0.0), int(scores.max())
    use = abs(best) >= 0.3 and sb >= s0 + 3 and sb >= len(ts) / 3
    print(f"{lid:55} lines {len(ts):3}  at 0: {s0:3}  best {best:+.2f}s: {sb:3}  {'-> OFFSET' if use else ''}")
    if use and apply:
        chart = json.load(open(os.path.join(level, "chart.json")))
        if not os.path.exists(os.path.join(level, "chart.lrc.json")):
            shutil.copyfile(os.path.join(level, "chart.json"), os.path.join(level, "chart.lrc.json"))
        chart["lines"] = [{**l, "t": round(l["t"] + float(best), 3)} for l in base["lines"]]
        chart["source"] = base.get("source", "").split("+")[0] + f"+offset{best:+.2f}"
        json.dump(chart, open(os.path.join(level, "chart.json"), "w"), indent=1, ensure_ascii=False)
