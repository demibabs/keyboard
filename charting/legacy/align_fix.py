"""Re-align specific lines inside manual windows and patch a chart draft.
usage: align_fix.py draft.json vocals.wav sec:line:t0:t1 [...]"""
import sys, json, torch, librosa, numpy as np
from torchaudio.pipelines import MMS_FA as B
from lyrics_parse import typed
draft, wav, *specs = sys.argv[1:]
S = json.load(open(draft))
dev = "cuda" if torch.cuda.is_available() else "cpu"
model = B.get_model(with_star=True).to(dev); tok = B.get_tokenizer(); al = B.get_aligner()
SR = 16000; v, _ = librosa.load(wav, sr=SR)
for spec in specs:
    si, li, t0, t1 = spec.split(":"); si, li, t0, t1 = int(si), int(li), float(t0), float(t1)
    l = S[si]["lines"][li]
    toks = ["*"] + ["".join(typed(s) for s in w["syllables"]) for w in l["words"]] + ["*"]
    seg = torch.tensor(v[int(t0 * SR):int(t1 * SR)])[None].to(dev)
    with torch.inference_mode(): em, _ = model(seg)
    spans = al(em[0], tok(toks))[1:-1]; ratio = seg.shape[1] / em.shape[1] / SR
    for w, sp in zip(l["words"], spans):
        i = 0; w["t"] = []
        for s in w["syllables"]:
            w["t"].append(round(t0 + sp[i].start * ratio, 3)); i += len(typed(s))
        w["end"] = round(t0 + sp[-1].end * ratio, 3)
    print(l["text"], " ".join(f"{''.join(w['syllables'])}@{'/'.join(f'{t:.2f}' for t in w['t'])}" for w in l["words"]))
json.dump(S, open(draft, "w"), indent=1)
