#!/usr/bin/env python3
"""Make a level from an audio file + line-synced lyrics from LRCLIB (https://lrclib.net).

usage: make_level.py song.mp3 --artist "Ariana Grande" --title "twilight zone" [--id twilight-zone]
                     [--lrclib-id N] [--offset-ms 0] [--force-audio]

Picks the LRCLIB entry with synced lyrics whose duration is closest to the audio (skipping a cappella /
instrumental versions unless nothing else fits), writes public/levels/<id>/chart.json, renders the audio
at every speed (pitch-preserved, rubberband), and refreshes public/levels/index.json.
Needs ffmpeg + rubberband on PATH. Standard library only."""
import argparse, difflib, glob, json, os, re, subprocess, sys, tempfile, urllib.parse, urllib.request

SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5]
API = "https://lrclib.net/api"
UA = "lyric-typer/0.1 (local typing rhythm game)"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "public", "levels")
VENV_PY = os.path.expanduser("~/.cache/lyric-align/.venv/bin/python")


def transcribe(audio):
    """Whisper words for the audio, or None if the Whisper env isn't available."""
    if not os.path.exists(VENV_PY):
        return None
    env = dict(os.environ)
    libs = glob.glob(os.path.expanduser("~/.cache/lyric-align/.venv/lib/python*/site-packages/nvidia/*/lib"))
    env["LD_LIBRARY_PATH"] = ":".join(libs + [env.get("LD_LIBRARY_PATH", "")])
    print("transcribing the audio to compare wording (Whisper)...")
    r = subprocess.run([VENV_PY, os.path.join(HERE, "transcribe.py"), audio], capture_output=True, text=True, env=env)
    if r.returncode != 0:
        print("  transcription failed; picking by duration only")
        return None
    return json.loads(r.stdout)


def text_match(lrc, words):
    """Share of words that line up between an LRC's text and the transcript (0..1)."""
    nums = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven",
            "8": "eight", "9": "nine", "10": "ten"}

    def norm(w):  # digits -> number words, "holdin'" == "holding"
        w = re.sub(r"[^a-z0-9]", "", w.lower())
        w = nums.get(w, w)
        return w[:-1] if w.endswith("ing") else w
    toks = [norm(w) for raw in lrc.splitlines() for w in re.sub(r"\[[^\]]*\]", "", raw).split() if norm(w)]
    words = [norm(w) for w in words]
    m = sum(n for _, _, n in difflib.SequenceMatcher(a=toks, b=words, autojunk=False).get_matching_blocks())
    return m / max(len(toks), len(words), 1)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def duration_of(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def parse_lrc(lrc):
    """[mm:ss.xx] text lines -> sorted [{t, text}]; a line may carry several timestamps."""
    out = []
    for raw in lrc.splitlines():
        stamps = re.findall(r"\[(\d+):(\d+(?:\.\d+)?)\]", raw)
        if not stamps:
            continue  # metadata tags like [ar:...] or junk
        text = re.sub(r"\[\d+:\d+(?:\.\d+)?\]", "", raw).strip()
        for m, s in stamps:
            out.append({"t": round(int(m) * 60 + float(s), 3), "text": text})
    out.sort(key=lambda x: x["t"])
    return out


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--artist", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--id")
    ap.add_argument("--lrclib-id", type=int)
    ap.add_argument("--offset-ms", type=int, default=0)
    ap.add_argument("--force-audio", action="store_true")
    ap.add_argument("--no-text-check", action="store_true", help="pick by duration only (skip Whisper)")
    a = ap.parse_args()
    lid = a.id or slug(a.title)
    dur = duration_of(a.audio)

    if a.lrclib_id:
        rec = get(f"{API}/get/{a.lrclib_id}")
    else:
        # artist/title search misses entries credited to several artists ("Frank Sinatra; Count Basie"),
        # so also run a free-text search and merge
        found = {}
        # and a title-only search, since game/film songs are often credited to a band name, not the singer
        key = lambda t: re.sub(r"[^a-z0-9]", "", (t or "").lower())  # compare titles ignoring punctuation
        for q in ({"artist_name": a.artist, "track_name": a.title}, {"q": f"{a.title} {a.artist}"}, {"q": a.title}):
            for c in get(f"{API}/search?{urllib.parse.urlencode(q)}"):
                if c.get("syncedLyrics") and key(a.title) in key(c.get("trackName")):
                    found[c["id"]] = c
        cands = list(found.values())
        for c in cands:  # some entries have no duration; treat as unknown (never "close")
            c["duration"] = c.get("duration") or 0.0
            c["albumName"] = c.get("albumName") or ""
            c["artistName"] = c.get("artistName") or ""
        if not cands:
            sys.exit("LRCLIB has no synced lyrics for that artist/title")
        alt = re.compile(r"a cappella|acapella|instrumental|karaoke|live|remix|sped up|slowed|sing-along|cover", re.I)
        close = [c for c in cands if abs(c["duration"] - dur) <= 3] or cands
        words = None if a.no_text_check else transcribe(a.audio)
        for c in close:
            c["_match"] = text_match(c["syncedLyrics"], words) if words else 0.0
        # best wording first (rounded so near-ties fall back to the other criteria), then album-version, then duration
        close.sort(key=lambda c: (-round(c["_match"], 2), bool(alt.search((c.get("albumName") or "") + " " + (c.get("trackName") or ""))),
                                  abs(c["duration"] - dur)))
        print("LRCLIB candidates (best first). If the text doesn't match the recording, rebuild with --lrclib-id <id>:")
        for c in close[:8]:
            m = f"  words {c['_match']:.0%}" if words else ""
            print(f"  {c['id']:>9}  {c['duration']:7.2f}s{m}  {c['artistName'][:30]} / {c['albumName'][:40]}")
        rec = close[0]
        if abs(rec["duration"] - dur) > 2:
            print(f"WARNING: best match is {rec['duration']:.1f}s but the audio is {dur:.1f}s; timing may be off")
        if words and rec["_match"] < 0.8:
            print(f"NOTE: best wording match is {rec['_match']:.0%}. Whisper mishears heavily processed or belted vocals,")
            print("      so check the lyrics by ear if the candidates' scores differ or the song has clear vocals")

    out = write_chart(lid, a.title, a.artist, dur, rec, a.offset_ms)
    render_speeds(a.audio, out, a.force_audio)
    write_index()


def clean_lines(lrc):
    """LRC text -> chart lines: drop leading blanks and collapse repeated blanks (end-of-vocals markers)."""
    clean = []
    for l in parse_lrc(lrc):
        if not l["text"] and (not clean or not clean[-1]["text"]):
            continue
        clean.append(l)
    return clean


def write_chart(lid, title, artist, dur, rec, offset_ms=0, quiet=False):
    lines = clean_lines(rec["syncedLyrics"])
    out = os.path.join(ROOT, lid)
    os.makedirs(out, exist_ok=True)
    chart = {"format": 2, "id": lid, "version": 1, "title": title, "artist": artist, "duration": round(dur, 3),
             "offsetMs": offset_ms, "speeds": SPEEDS, "audio": "audio@{speed}.ogg",
             "source": f"lrclib:{rec['id']}", "lines": lines}
    with open(os.path.join(out, "chart.json"), "w") as f:
        json.dump(chart, f, indent=1, ensure_ascii=False)
    if not quiet:
        print(f"chart: {sum(1 for l in lines if l['text'])} lines from LRCLIB #{rec['id']} -> {out}/chart.json")
    return out


def render_speeds(audio, out, force=False, quiet=False):
    """Pitch-preserved renders of the audio at every speed (skips ones that exist unless force)."""
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "song.wav")
        for sp in SPEEDS:
            dst = os.path.join(out, f"audio@{sp:.2f}.ogg")
            if os.path.exists(dst) and not force:
                continue
            if not os.path.exists(wav):
                subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", audio, "-vn", "-ar", "44100", wav], check=True)
            src = wav
            if sp != 1.0:
                src = os.path.join(tmp, f"s{sp}.wav")
                subprocess.run(["rubberband", "-3", "-q", "-T", str(sp), wav, src], check=True, capture_output=True)
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map_metadata", "-1",
                            "-c:a", "libvorbis", "-q:a", "6", dst], check=True)
            if not quiet:
                print("rendered", os.path.basename(dst))


def write_index():
    """List every level whose chart and audio at all speeds exist (half-rendered levels stay hidden)."""
    ids = sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, "chart.json"))
                 and all(os.path.exists(os.path.join(ROOT, d, f"audio@{sp:.2f}.ogg")) for sp in SPEEDS))
    with open(os.path.join(ROOT, "index.json"), "w") as f:
        json.dump({"levels": ids}, f)


if __name__ == "__main__":
    main()
