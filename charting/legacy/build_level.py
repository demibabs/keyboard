"""Turn an aligned draft into a playable level folder.
usage: build_level.py draft.json song.wav vocals.wav out_dir --id ID --title T --artist A [--snap 0.05] [--no-audio]
Writes chart.json, audio@<speed>.ogg for each speed, vocals-env.json (for the editor)."""
import argparse, json, os, subprocess, tempfile, librosa, numpy as np
from lyrics_parse import typed

SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5]
ap = argparse.ArgumentParser()
ap.add_argument("draft"); ap.add_argument("song"); ap.add_argument("vocals"); ap.add_argument("out")
ap.add_argument("--id", required=True); ap.add_argument("--title", required=True); ap.add_argument("--artist", required=True)
ap.add_argument("--snap", type=float, default=0.05); ap.add_argument("--no-audio", action="store_true")
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
S = json.load(open(a.draft))

# vocal onset peaks for snapping + envelope for the editor
y, sr = librosa.load(a.vocals, sr=22050); hop = 220
env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
pk = librosa.util.peak_pick(env, pre_max=3, post_max=3, pre_avg=10, post_avg=10, delta=0.3, wait=4) * hop / sr
rms = librosa.feature.rms(y=y, hop_length=hop)[0]
json.dump({"rate": sr / hop, "rms": [round(float(x), 3) for x in rms / rms.max()]},
          open(os.path.join(a.out, "vocals-env.json"), "w"), separators=(",", ":"))

lines, sylls = [], []
for sec in S:
    for l in sec["lines"]:
        words = []
        for w in l["words"]:
            ws = [{"d": d, "t": t} for d, t in zip(w["syllables"], w["t"])]
            sylls.extend(ws)
            words.append({"s": ws, **({"join": True} if w.get("joinNext") else {}), "end": w["end"]})
        lines.append({"section": sec["name"], "words": words})

# snap onsets to nearby vocal onset peaks, keeping order and a 50 ms minimum gap
moved = 0
if a.snap > 0:
    for i, s in enumerate(sylls):
        d = pk - s["t"]; j = int(np.argmin(np.abs(d)))
        if abs(d[j]) <= a.snap:
            lo = sylls[i - 1]["t"] + 0.05 if i else 0
            hi = sylls[i + 1]["t"] - 0.05 if i + 1 < len(sylls) else 1e9
            nt = float(np.clip(pk[j], lo, hi))
            if abs(nt - s["t"]) > 0.005: moved += 1
            s["t"] = round(nt, 3)
for s, n in zip(sylls, sylls[1:]):
    assert n["t"] > s["t"], (s, n)

# line ends matter for line-timed play (a line closes shortly after its last word): forced-alignment word
# ends are often early on held notes, so extend each line's last word to where the vocal fades
# (RMS < 8% of max), never past the next line's start
rn = rms / rms.max()
for li, l in enumerate(lines):
    w = l["words"][-1]
    nxt = lines[li + 1]["words"][0]["s"][0]["t"] if li + 1 < len(lines) else w["end"] + 3
    i = int(w["s"][-1]["t"] * sr / hop); j = int(nxt * sr / hop)
    while i < j and rn[i] > 0.08: i += 1
    w["end"] = round(max(w["end"], min(i * hop / sr, nxt - 0.05)), 3)

# difficulty (line-timed play): each line must be typed between its first onset and 0.5 s after it ends.
# rate = chars / window; "needs" blends the 90th-percentile line with the overall rate. Mirrors chart.ts difficulty().
rates, tot_n, tot_w = [], 0, 0
for l in lines:
    n = sum(len(typed(s["d"])) for w in l["words"] for s in w["s"]) + len(l["words"]) - 1
    win = l["words"][-1]["end"] - l["words"][0]["s"][0]["t"] + 0.5
    rates.append(n / win); tot_n += n; tot_w += win
peak = max(rates); mean = tot_n / tot_w
rating = round(12 * (0.5 * float(np.percentile(rates, 90)) + 0.5 * mean))  # ~WPM needed at 1.0x
print(f"syllables {len(sylls)}  moved by snap {moved}  peak line {peak:.2f} cps  mean {mean:.2f} cps  rating {rating}")

dur = librosa.get_duration(path=a.song)
chart = {"format": 1, "id": a.id, "version": 1, "title": a.title, "artist": a.artist,
         "duration": round(dur, 3), "offsetMs": 0, "rating": rating, "peakWpm": round(peak * 12), "meanWpm": round(mean * 12), "speeds": SPEEDS,
         "audio": "audio@{speed}.ogg", "lines": lines}
json.dump(chart, open(os.path.join(a.out, "chart.json"), "w"), indent=1)

if not a.no_audio:
    with tempfile.TemporaryDirectory(dir=os.path.dirname(os.path.abspath(a.out))) as tmp:
        for sp in SPEEDS:
            src = a.song
            if sp != 1.0:
                src = os.path.join(tmp, f"s{sp}.wav")
                subprocess.run(["rubberband", "-3", "-q", "-T", str(sp), a.song, src], check=True)
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map_metadata", "-1",
                            "-c:a", "libvorbis", "-q:a", "6", os.path.join(a.out, f"audio@{sp:.2f}.ogg")], check=True)
            print("rendered", sp)

# refresh the level index next to the level folders
import glob
root = os.path.dirname(os.path.abspath(a.out))
ids = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(os.path.join(root, "*", "chart.json")))
json.dump({"levels": ids}, open(os.path.join(root, "index.json"), "w"))
