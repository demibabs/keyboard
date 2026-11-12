#!/usr/bin/env python3
"""Add many songs as levels at once, quickly: no Whisper, no vocal separation.

usage: python3 charting/batch_levels.py FILE... [--workers 4] [--dry-run] [--force]
       python3 charting/batch_levels.py --newest 100 [...]     (the newest audio files in ~/Downloads)

For each audio file:
  1. identify the song from its tags, or from the file name minus "(Official Audio)", "Lyrics", "VEVO" etc.
  2. pick LRCLIB's main synced version: among entries within 3 s of the audio's length whose title is in the
     tags/file name, take the lyrics text most of them share, then a non-alternate version closest in length
  3. basic checks (flagged in the report, not fatal): length mismatch, few lines, censored words, text that
     can't be typed (non-Latin), timestamps past the end, weak agreement between versions
  4. write the chart, render all speeds (several songs in parallel), refresh the level index
Writes a report to charting/work/batch-report.md. Prints metadata only (never lyrics).
Songs with no usable match are skipped and listed so they can be done by hand with make_level.py."""
import argparse, collections, concurrent.futures as cf, glob, json, os, re, subprocess, sys, time, unicodedata, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_level import API, ROOT, clean_lines, get, render_speeds, slug, write_chart, write_index  # noqa: E402

AUDIO = (".mp3", ".m4a", ".ogg", ".opus", ".wav", ".flac", ".webm")
ALT = re.compile(r"a ?cappella|acapella|instrumental|karaoke|\blive\b|remix|sped up|slowed|sing-?along|cover|8d|nightcore", re.I)
JUNK = re.compile(r"\((?:[^)]*(?:official|audio|video|lyric|visuali[sz]er|explicit|clean|remaster|hd|hq|4k|music video|mv)[^)]*)\)|"
                  r"\[(?:[^\]]*(?:official|audio|video|lyric|visuali[sz]er|explicit|clean|remaster|hd|hq|4k|music video|mv)[^\]]*)\]", re.I)
CHANNEL = re.compile(r"vevo|topic$|records|recordings|official|lyrics?$|music now|^\w+bashers$", re.I)
key = lambda t: re.sub(r"[^a-z0-9]", "", (t or "").lower())
# same as the game's typedOf (src/chart.ts): NFKD, drop accents, map lookalike Cyrillic/Greek letters
LOOKALIKE = dict(zip("аеорсухіјѕԁһԛԝкмтвнοαειкνρτυ", "aeopcyxijsdhqwkmtbhoaeikvptu"))
def typed(s):
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]", "", "".join(LOOKALIKE.get(c, c) for c in s))


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:format_tags=title,artist",
                          "-of", "json", path], capture_output=True, text=True, check=True).stdout
    fmt = json.loads(out)["format"]
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    return float(fmt["duration"]), tags.get("artist", ""), tags.get("title", "")


def parts_of(text):
    """'Artist - Title (Official Audio) - Channel' -> ['Artist', 'Title'] (junk brackets and channel names removed)."""
    text = JUNK.sub(" ", text).replace("｜", "|")
    parts = [p.strip() for p in re.split(r"\s+-\s+|\|", text) if p.strip()]
    keep = [p for i, p in enumerate(parts) if not (i == len(parts) - 1 and len(parts) > 2 and CHANNEL.search(p))]
    return [p for p in keep if not CHANNEL.fullmatch(p) and not re.fullmatch(r"(?i)ncs|copyright free music|electronic pop", p)]


def guesses(path, tag_artist, tag_title):
    """Plausible (artist, title) pairs for LRCLIB's lookup, best first."""
    name = os.path.splitext(os.path.basename(path))[0]
    feat = lambda t: re.sub(r"(?i)\s*[\(\[]?\s*(?:ft|feat)\.?\s[^\)\]]*[\)\]]?", "", t).strip()
    out = []
    def add(artist, title):
        for a in {artist, artist.split(",")[0].split("&")[0].strip()}:
            for t in (title, feat(title), re.sub(r"\s*[\(\[].*", "", title).strip()):
                if a and t and (a, t) not in out:
                    out.append((a, t))
    for parts in (parts_of(name), parts_of(tag_title) if tag_title else []):
        parts = [feat(p) for p in parts]
        for i in range(min(3, len(parts))):
            for j in range(min(3, len(parts))):
                if i != j:
                    add(parts[i], parts[j])
    if tag_artist and tag_title and " - " not in tag_title:
        out.insert(0, (tag_artist, tag_title))
    return out[:12]


def lookup(path, dur, tag_artist, tag_title):
    """LRCLIB's own match (its /api/get endpoint) for the first guessed artist/title that has synced lyrics."""
    for artist, title in guesses(path, tag_artist, tag_title):
        q = urllib.parse.urlencode({"artist_name": artist, "track_name": title, "duration": round(dur)})
        try:
            rec = get(f"{API}/get?{q}")
        except Exception:
            rec = None  # 404: no match for this guess
        time.sleep(0.1)
        if rec and rec.get("syncedLyrics") and not rec.get("instrumental") and abs((rec.get("duration") or 0) - dur) <= 3:
            return rec
    return None


def describe(path):
    """Search text for a file: its name without extension, junk brackets and channel names."""
    name = os.path.splitext(os.path.basename(path))[0]
    name = JUNK.sub(" ", name).replace("｜", "|")
    parts = [p.strip() for p in re.split(r"\s+-\s+|\|", name) if p.strip()]
    keep = [p for i, p in enumerate(parts) if not (i == len(parts) - 1 and len(parts) > 2 and CHANNEL.search(p))]
    keep = [p for p in keep if not CHANNEL.fullmatch(p)]
    text = " ".join(keep)
    text = re.sub(r"\b(ft|feat)\.?\s", " ", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()


def candidates(desc, artist, title):
    queries = [{"q": desc}]
    if title:
        queries.insert(0, {"track_name": title, **({"artist_name": artist} if artist else {})})
        queries.append({"q": f"{title} {artist}".strip()})
    found = {}
    for q in queries:
        try:
            for c in get(f"{API}/search?{urllib.parse.urlencode(q)}"):
                if c.get("syncedLyrics") and not c.get("instrumental"):
                    found[c["id"]] = c
        except Exception as e:  # network hiccup: try the next query
            print("   search failed:", e)
        time.sleep(0.15)
    return list(found.values())


def pick(cands, dur, desc, title):
    """The main LRCLIB version for this audio, plus notes about how confident the pick is."""
    hay = key(f"{title} {desc}")
    near = [c for c in cands if c.get("duration") and abs(c["duration"] - dur) <= 3 and key(c.get("trackName")) and key(c["trackName"]) in hay]
    # titles like "Song (feat. X)" may not appear whole in the file name: fall back to the part before "("
    if not near:
        near = [c for c in cands if c.get("duration") and abs(c["duration"] - dur) <= 3
                and key(re.sub(r"\s*[\(\[].*", "", c.get("trackName") or "")) in hay]
    if not near:
        return None, []
    groups = collections.defaultdict(list)  # versions sharing the same text
    for c in near:
        groups[key(re.sub(r"\[[^\]]*\]", "", c["syncedLyrics"]))].append(c)
    clean = lambda c: not re.search(r"(?i)official|audio|video|lyric", c.get("trackName") or "") and \
        key(c.get("artistName")) not in key(c.get("trackName"))
    main = max(groups.values(), key=lambda g: (sum(map(clean, g)), len(g)))
    main.sort(key=lambda c: (not clean(c), bool(ALT.search(f"{c.get('albumName') or ''} {c.get('trackName') or ''}")), abs(c["duration"] - dur)))
    notes = []
    if len(groups) > 1 and len(main) <= len(near) / 2:
        notes.append(f"versions disagree on the text ({len(groups)} variants, main has {len(main)}/{len(near)})")
    return main[0], notes


def clean_title(rec):
    """Track title without an 'Artist - ' prefix or '(Official Audio)'-style junk."""
    t = JUNK.sub(" ", rec.get("trackName") or "")
    a = rec.get("artistName") or ""
    if a and t.lower().startswith(a.lower() + " - "):
        t = t[len(a) + 3:]
    return re.sub(r"\s+", " ", t).strip()


def checks(rec, dur):
    lines = clean_lines(rec["syncedLyrics"])
    text = [l for l in lines if l["text"]]
    notes = []
    if abs(rec["duration"] - dur) > 2:
        notes.append(f"length differs by {rec['duration'] - dur:+.1f}s")
    if len(text) < 8:
        notes.append(f"only {len(text)} lines")
    if any("*" in l["text"] for l in text):
        notes.append("censored words (*)")
    filler = "\u3164\u115f\u1160\uffa0"  # invisible "blank" characters some lyric files use; they hide no letters
    nonlatin = sum(1 for l in text for ch in l["text"] if unicodedata.category(ch).startswith("L") and not typed(ch) and ch not in filler)
    if nonlatin:
        notes.append(f"{nonlatin} non-Latin characters (can't be typed)")
    if lines and lines[-1]["t"] > dur:
        notes.append("timestamps past the end of the audio")
    if any(b["t"] < a["t"] for a, b in zip(lines, lines[1:])):
        notes.append("timestamps out of order")
    return len(text), notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*")
    ap.add_argument("--newest", type=int, help="take the N newest audio files in ~/Downloads")
    ap.add_argument("--manifest", help="songs.json with audioPath, lrclibId, artist, title, id per song (no matching needed)")
    ap.add_argument("--workers", type=int, default=4, help="songs rendered in parallel")
    ap.add_argument("--dry-run", action="store_true", help="match and check only; write nothing")
    ap.add_argument("--force", action="store_true", help="redo songs that already have a level")
    a = ap.parse_args()
    files = list(a.files)
    manifest = {}
    if a.manifest:
        for e in json.load(open(a.manifest)):
            manifest[e["audioPath"]] = e
            files.append(e["audioPath"])
    if a.newest:
        dl = [f for f in glob.glob(os.path.expanduser("~/Downloads/*")) if f.lower().endswith(AUDIO)]
        files += sorted(dl, key=os.path.getmtime, reverse=True)[:a.newest]
    if not files:
        sys.exit("no audio files given")

    existing = {}
    for d in glob.glob(os.path.join(ROOT, "*", "chart.json")):
        c = json.load(open(d))
        existing[c.get("source", "").split("+")[0]] = c["id"]
    taken = {os.path.basename(os.path.dirname(d)) for d in glob.glob(os.path.join(ROOT, "*", "chart.json"))}

    rows, jobs = [], []
    for i, f in enumerate(files, 1):
        dur, artist, title = probe(f)
        desc = describe(f)
        m = manifest.get(f)
        if m:  # supplied LRCLIB id: fetch it directly
            rec, notes, how = None, [], "manifest"
            for attempt in range(5):  # LRCLIB rate-limits bursts: back off and retry
                try:
                    rec = get(f"{API}/get/{m['lrclibId']}")
                    break
                except Exception as e:
                    notes = [f"LRCLIB #{m['lrclibId']} fetch failed: {e}"]
                    time.sleep(1.5 * 2 ** attempt)
            if rec:
                notes = []
            time.sleep(0.15)
            if rec and not rec.get("syncedLyrics"):
                rec = None
            if not m.get("canonicalMatch", True):
                notes.append("not LRCLIB's canonical album match")
        else:
            rec, notes = lookup(f, dur, artist, title), []
            how = "lookup"
            if not rec:
                rec, notes = pick(candidates(desc, artist, title), dur, desc, title)
                how = "search"
        name = os.path.basename(f)
        if not rec:
            rows.append((name, "-", "-", f"{dur:.0f}s", "-", "SKIPPED: " + ("; ".join(notes) or "no synced LRCLIB match within 3 s")))
            print(f"[{i}/{len(files)}] {name}: no match")
            continue
        src = f"lrclib:{rec['id']}"
        if src in existing and not a.force:
            rows.append((name, existing[src], rec["id"], f"{dur:.0f}s", "-", "already a level (use --force to redo)"))
            print(f"[{i}/{len(files)}] {name}: already a level ({existing[src]})")
            continue
        n, more = checks(rec, dur)
        notes += more
        shown_title = m["title"] if m else clean_title(rec)
        lid = (m and m.get("id")) or slug(shown_title) or slug(desc)
        if lid in taken and existing.get(src) != lid:
            lid = f"{lid}-{slug(rec.get('artistName') or '')}"[:60].strip("-")
        taken.add(lid)
        rows.append((name, lid, rec["id"], f"{dur:.0f}s", str(n), "; ".join(notes) or "ok"))
        print(f"[{i}/{len(files)}] {name} -> {lid} (LRCLIB #{rec['id']} by {how}, {n} lines){'  !! ' + '; '.join(notes) if notes else ''}")
        if not a.dry_run:
            write_chart(lid, shown_title, (m and m["artist"]) or rec.get("artistName") or artist, dur, rec, quiet=True)
            jobs.append((f, os.path.join(ROOT, lid), lid))

    if jobs:
        print(f"rendering {len(jobs)} songs x 5 speeds with {a.workers} workers...")
        with cf.ThreadPoolExecutor(a.workers) as ex:
            futs = {ex.submit(render_speeds, f, out, a.force, True): lid for f, out, lid in jobs}
            for k, fut in enumerate(cf.as_completed(futs), 1):
                err = fut.exception()
                print(f"  [{k}/{len(jobs)}] {futs[fut]} {'FAILED: ' + str(err) if err else 'rendered'}")
                if not err:
                    write_index()  # playable as soon as it's rendered
        write_index()

    os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), "work"), exist_ok=True)
    report = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work", "batch-report.md")
    with open(report, "w") as fh:
        fh.write("| file | level id | LRCLIB | length | lines | notes |\n|---|---|---|---|---|---|\n")
        for r in rows:
            fh.write("| " + " | ".join(str(x).replace("|", "/") for x in r) + " |\n")
    flagged = [r for r in rows if r[5] != "ok"]
    print(f"\n{len(rows)} files: {sum(1 for r in rows if r[5] == 'ok')} clean, {len(flagged)} flagged/skipped. Report: {report}")


if __name__ == "__main__":
    main()
