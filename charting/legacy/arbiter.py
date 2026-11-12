"""Pick, per line, the alignment candidate whose syllable onsets best agree with vocal onset peaks.
usage: arbiter.py vocals.wav out.json cand1.json cand2.json ..."""
import sys, json, librosa, numpy as np
wav, outf, *cands = sys.argv[1:]
C = [json.load(open(c)) for c in cands]
y, sr = librosa.load(wav, sr=22050); hop = 220
env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
peaks = librosa.util.peak_pick(env, pre_max=3, post_max=3, pre_avg=10, post_avg=10, delta=0.3, wait=4)
pt = peaks * hop / sr
def score(line):
    ts = [t for w in line["words"] for t in w["t"]]
    if any(b <= a for a, b in zip(ts, ts[1:])): return -1
    d = np.array([np.min(np.abs(pt - t)) for t in ts])
    return float(np.mean(np.exp(-(d / 0.05) ** 2)))
out = C[0]
for si, sec in enumerate(out):
    for li in range(len(sec["lines"])):
        sc = [score(c[si]["lines"][li]) for c in C]
        best = int(np.argmax(sc))
        sec["lines"][li] = C[best][si]["lines"][li]
        flag = "  <-- low" if max(sc) < 0.45 else ""
        print(f"{sec['name'][:10]:10} {li:2} {' '.join(f'{s:.2f}' for s in sc)} -> {best}{flag}  {sec['lines'][li]['text'][:40]}")
json.dump(out, open(outf, "w"), indent=1)
