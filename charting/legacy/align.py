"""Line-by-line forced alignment (MMS_FA, char level) inside windows set by Whisper anchors.
usage: align.py lyrics.txt vocals.wav anchors.json out.json"""
import sys, json, torch, librosa, numpy as np
from torchaudio.pipelines import MMS_FA as B
from lyrics_parse import parse, typed

lyr, wav, ancf, outf = sys.argv[1:5]
sections = parse(lyr); anchors = json.load(open(ancf))
dev = "cuda" if torch.cuda.is_available() else "cpu"
model = B.get_model(with_star=True).to(dev); tok = B.get_tokenizer(); al = B.get_aligner()
SR = 16000
v, _ = librosa.load(wav, sr=SR)

lines = []  # flat list of (line, words, anchors)
for sec, anc in zip(sections, anchors):
    i = 0
    for l in sec["lines"]:
        n = len(l["words"]); lines.append((l, anc[i:i + n])); i += n

def est_start(anc):
    for k, a in enumerate(anc):
        if a: return a[0] - 0.3 * k
def est_end(anc):
    for k, a in enumerate(reversed(anc)):
        if a: return min(a[1], a[0] + 1.2) + 0.3 * k

for li, (l, anc) in enumerate(lines):
    s0 = est_start(anc); e0 = est_end(anc)
    nxt = est_start(lines[li + 1][1]) if li + 1 < len(lines) else e0 + 2
    prv = est_end(lines[li - 1][1]) if li else 0
    t0 = max(s0 - 0.7, prv - 0.3); t1 = min(max(e0 + 1.0, nxt - 0.2), nxt + 0.3) if nxt > e0 else e0 + 0.6
    norm = ["*"] + ["".join(typed(s) for s in w["syllables"]) for w in l["words"]] + ["*"]
    seg = torch.tensor(v[int(t0 * SR):int(t1 * SR)])[None].to(dev)
    with torch.inference_mode():
        em, _ = model(seg)
    spans = al(em[0], tok(norm))[1:-1]
    ratio = seg.shape[1] / em.shape[1] / SR
    for w, sp, a in zip(l["words"], spans, anc):
        i = 0; w["t"] = []
        for s in w["syllables"]:
            w["t"].append(round(t0 + sp[i].start * ratio, 3)); i += len(typed(s))
        w["end"] = round(t0 + sp[-1].end * ratio, 3)
        w["score"] = round(float(np.mean([x.score for x in sp])), 2)
        w["whisper"] = a
    l["window"] = [round(t0, 2), round(t1, 2)]

json.dump(sections, open(outf, "w"), indent=1)
for sec in sections:
    print("==", sec["name"])
    for l in sec["lines"]:
        def fmt(w):
            d = "" if not w["whisper"] else f"{w['t'][0]-w['whisper'][0]:+.2f}"
            return f"{'·'.join(w['syllables'])}@{'/'.join(f'{t:.2f}' for t in w['t'])}({d})"
        print("  " + " ".join(fmt(w) for w in l["words"]))
ts = [(t, w["syllables"][i]) for sec in sections for l in sec["lines"] for w in l["words"] for i, t in enumerate(w["t"])]
for (a, sa), (b, sb) in zip(ts, ts[1:]):
    if b - a < 0.06: print(f"TIGHT {sa}@{a:.2f} -> {sb}@{b:.2f}")
