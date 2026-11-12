"""Section-level forced alignment with star tokens between lines (absorbs ad-libs / backing vocals).
usage: align_sec.py lyrics.txt vocals.wav windows.json out.json"""
import sys, json, torch, librosa, numpy as np
from torchaudio.pipelines import MMS_FA as B
from lyrics_parse import parse, typed
lyr, wav, winf, outf = sys.argv[1:5]
sections = parse(lyr); windows = json.load(open(winf))
dev = "cuda" if torch.cuda.is_available() else "cpu"
model = B.get_model(with_star=True).to(dev); tok = B.get_tokenizer(); al = B.get_aligner()
SR = 16000
v, _ = librosa.load(wav, sr=SR)
for sec, (t0, t1) in zip(sections, windows):
    toks, refs = ["*"], [None]
    for l in sec["lines"]:
        for w in l["words"]:
            toks.append("".join(typed(s) for s in w["syllables"])); refs.append(w)
        toks.append("*"); refs.append(None)
    seg = torch.tensor(v[int(t0 * SR):int(t1 * SR)])[None].to(dev)
    with torch.inference_mode():
        em, _ = model(seg)
    spans = al(em[0], tok(toks))
    ratio = seg.shape[1] / em.shape[1] / SR
    for w, sp in zip(refs, spans):
        if w is None: continue
        i = 0; w["t"] = []
        for s in w["syllables"]:
            w["t"].append(round(t0 + sp[i].start * ratio, 3)); i += len(typed(s))
        w["end"] = round(t0 + sp[-1].end * ratio, 3)
        w["score"] = round(float(np.mean([x.score for x in sp])), 2)
json.dump(sections, open(outf, "w"), indent=1)
