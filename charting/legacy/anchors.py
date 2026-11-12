"""Whisper each section (prompted with its own lyrics) and match its words to the lyric words.
usage: anchors.py lyrics.txt vocals.wav windows.json out.json  -> per-word whisper start/end (or null)"""
import sys, json, difflib, librosa
from faster_whisper import WhisperModel
from lyrics_parse import parse, typed
lyr, wav, winf, outf = sys.argv[1:5]
sections = parse(lyr); windows = json.load(open(winf))
m = WhisperModel("large-v3", device="cuda", compute_type="float16")
A, _ = librosa.load(wav, sr=16000)
out = []
for sec, (t0, t1) in zip(sections, windows):
    words = [w for l in sec["lines"] for w in l["words"]]
    lw = ["".join(typed(s) for s in w["syllables"]) for w in words]
    prompt = " ".join(l["text"] for l in sec["lines"])
    segs, _ = m.transcribe(A[int(t0*16000):int(t1*16000)], language="en", word_timestamps=True,
                           condition_on_previous_text=False, initial_prompt=prompt)
    ww = [(t0 + w.start, t0 + w.end, typed(w.word)) for s in segs for w in s.words]
    ww = [x for x in ww if x[2]]
    sm = difflib.SequenceMatcher(a=lw, b=[x[2] for x in ww], autojunk=False)
    anc = [None] * len(lw)
    for a, b, n in sm.get_matching_blocks():
        for k in range(n):
            anc[a + k] = [round(ww[b + k][0], 3), round(ww[b + k][1], 3)]
    out.append(anc)
    print(sec["name"], f"{sum(x is not None for x in anc)}/{len(anc)} matched")
json.dump(out, open(outf, "w"))
