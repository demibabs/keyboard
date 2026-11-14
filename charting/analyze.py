#!/usr/bin/env python3
"""Music features for the play screen's visuals: public/levels/<id>/viz.json (numbers only, no audio).

usage: ~/.cache/lyric-align/.venv/bin/python charting/analyze.py <id>... [--all]

From the level's audio at 1x (audio@1.00.ogg, the same timeline as the chart and the YouTube video), at
10 frames a second, each 0..255:
  energy     loudness right now (RMS in dB, scaled between the song's quiet and loud ends)
  onset      how much new sound starts (attacks, drums): drives pulses
  bright     spectral centroid (dark/mellow .. bright/airy)
  intensity  energy over the last few seconds, slow: where the song builds (drives motion)
  color      how far the song is above/below its own usual level (0 blue .. ~0.5 purple .. 1 pink); starts
             at 0 (every song opens on the classic blue) and moves slowly
plus beat times (s) with a strength each, the tempo, and big "hits" (strong onsets after a build)."""
import json, os, sys
import numpy as np
import librosa

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "levels")
SR, HOP = 22050, 2205  # 10 frames/s


def scale(x, lo_pct=5, hi_pct=97):
    lo, hi = np.percentile(x, lo_pct), np.percentile(x, hi_pct)
    return np.clip((x - lo) / max(hi - lo, 1e-9), 0, 1)


def smooth(x, secs):
    n = max(1, int(secs * SR / HOP))
    k = np.hanning(2 * n + 1)
    k /= k.sum()
    return np.convolve(np.pad(x, n, mode="edge"), k, mode="valid")


def analyze(lid):
    y, _ = librosa.load(os.path.join(ROOT, lid, "audio@1.00.ogg"), sr=SR, mono=True)
    rms = librosa.feature.rms(y=y, frame_length=4096, hop_length=HOP)[0]
    db = librosa.amplitude_to_db(rms + 1e-6, ref=np.max)
    energy = smooth(scale(db, 10, 98), 0.15)
    # onset strength at a finer hop, pooled to 10 fps (max), so short attacks aren't averaged away
    on_fine = librosa.onset.onset_strength(y=y, sr=SR, hop_length=512)
    per = HOP / 512
    onset = np.array([on_fine[int(i * per):int((i + 1) * per) + 1].max(initial=0) for i in range(len(energy))])
    onset = scale(onset, 20, 99.5)
    cent = librosa.feature.spectral_centroid(y=y, sr=SR, n_fft=4096, hop_length=HOP)[0]
    bright = smooth(scale(np.log(cent + 1)), 0.5)
    # slow build: loudness over ~6 s, rescaled so each song uses the whole range (quiet verse .. big chorus)
    intensity = scale(smooth(energy, 3.0), 3, 99)
    # colour: loudness over ~6 s relative to the song's median, so verses sit blue/purple and choruses and
    # climaxes push to pink even in loudly-mastered songs; eased in from blue over the first ~10 s
    slow = smooth(energy, 3.0)
    color = np.clip(0.35 + 1.6 * (slow - np.median(slow)), 0, 1)
    color = smooth(color, 2.0)
    ramp = np.clip(np.arange(len(color)) / 100.0, 0, 1)
    color = color * ramp
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=SR, hop_length=512, units="frames")
    beats = librosa.frames_to_time(beat_frames, sr=SR, hop_length=512)
    strength = [float(on_fine[max(0, f - 1):f + 2].max()) for f in beat_frames]
    smax = max(strength) if strength else 1
    # hits: very strong onsets that land when the song is already loud (drops, big downbeats)
    hits = [round(i / 10, 2) for i in range(1, len(onset) - 1)
            if onset[i] > 0.8 and onset[i] >= onset[i - 1] and onset[i] >= onset[i + 1] and intensity[i] > 0.55]
    thinned = []
    for t in hits:  # at most one every 2.5 s
        if not thinned or t - thinned[-1] >= 2.5:
            thinned.append(t)
    q = lambda a: [int(round(v * 255)) for v in np.asarray(a)[: len(energy)]]
    out = {
        "fps": 10, "tempo": round(float(np.atleast_1d(tempo)[0]), 1),
        "beats": [[round(float(t), 2), round(s / smax, 2)] for t, s in zip(beats, strength)],
        "hits": thinned,
        "energy": q(energy), "onset": q(onset), "bright": q(bright), "intensity": q(intensity), "color": q(color),
    }
    with open(os.path.join(ROOT, lid, "viz.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"{lid}: {len(energy) / 10:.0f}s, tempo {out['tempo']}, {len(beats)} beats, {len(thinned)} hits, "
          f"mean intensity {np.mean(intensity):.2f}")


if __name__ == "__main__":
    ids = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--all" in sys.argv:
        ids = sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, "audio@1.00.ogg")))
    for lid in ids:
        analyze(lid)
