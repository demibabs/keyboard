#!/usr/bin/env python3
"""Find album art for levels via the iTunes Search API and store its URL as "art" in chart.json
(scripts/levels.ts copies it into level.json). Only a link is stored, nothing is downloaded.

An empty "art" means none fits (e.g. the original isn't on iTunes); the song shows its video frame.

usage: fetch_art.py [ids...] [--force] [--manifest songs.json]
  (all levels without art by default; ~20 lookups a minute). A manifest with "album"/"preferredAlbum"
  per level id makes it prefer that album over compilations and other editions."""
import json, os, re, subprocess, sys, time, unicodedata, urllib.parse, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "levels")
UA = "startype/0.1 (typing rhythm game)"


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\(.*?\)|\[.*?\]|feat\..*|ft\..*", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


COMPILATION = re.compile(r"greatest hits|best of|the hits|\bhits\b|essential|collection|anthology|now that|"
                         r"karaoke|tribute|cover|instrumental|live|remix|8d|soundtrack|radio|deluxe edition of", re.I)


def lookup(artist, title, album=None):
    q = urllib.parse.urlencode({"term": f"{artist} {title}", "entity": "song", "limit": 15, "country": "US"})
    req = urllib.request.Request("https://itunes.apple.com/search?" + q, headers={"User-Agent": UA})
    for tries in range(4):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                res = json.load(r)["results"]
            break
        except Exception:
            time.sleep(10 * (tries + 1))
    else:
        return None
    a, t = norm(artist), norm(title)
    def score(x):
        xa, xt, col = norm(x.get("artistName")), norm(x.get("trackName")), (x.get("collectionName") or "").lower()
        s = (3 if xt == t else 1 if t in xt or xt in t else 0) + (2 if a[:6] and (a[:6] in xa or xa[:6] in a) else 0)
        if album and norm(album)[:10] and (norm(album)[:10] in norm(col) or norm(col)[:10] in norm(album)):
            s += 3  # the album the song is known from
        elif COMPILATION.search(col + " " + (x.get("trackName") or "")):
            s -= 2
        return s
    best = max(res, key=score, default=None)
    if not best or score(best) < 3:
        return None
    return best["artworkUrl100"].replace("100x100bb", "300x300bb")


def main():
    args = sys.argv[1:]
    force = "--force" in args
    albums = {}
    if "--manifest" in args:
        mpath = args[args.index("--manifest") + 1]
        args.remove(mpath)
        albums = {s["id"]: s.get("preferredAlbum") or s.get("album") for s in json.load(open(mpath)) if s.get("id")}
    ids = [a for a in args if not a.startswith("--")] or sorted(os.listdir(ROOT))
    found = missing = 0
    for lid in ids:
        p = os.path.join(ROOT, lid, "chart.json")
        if not os.path.exists(p):
            continue
        c = json.load(open(p))
        if "art" in c and not force:
            continue  # has art, or "" = checked by hand, none that fits
        art = lookup(c["artist"], c["title"], albums.get(lid))
        if art:
            c["art"] = art
            json.dump(c, open(p, "w"), indent=1, ensure_ascii=False)
            found += 1
        else:
            missing += 1
            print("no art:", lid, "|", c["artist"], "|", c["title"])
        time.sleep(3.2)  # iTunes allows ~20 requests a minute
    subprocess.run(["node", "scripts/levels.ts", "sync"], check=True, cwd=os.path.join(ROOT, "..", ".."))
    print(f"art found for {found}, missing {missing}")


if __name__ == "__main__":
    main()
