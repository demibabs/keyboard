#!/usr/bin/env python3
"""Find album art for levels via the iTunes Search API and store its URL as "art" in chart.json
(scripts/levels.ts copies it into level.json). Only a link is stored, nothing is downloaded.

usage: fetch_art.py [ids...] [--force]     (all levels without art by default; ~20 lookups a minute)"""
import json, os, re, subprocess, sys, time, unicodedata, urllib.parse, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "levels")
UA = "startype/0.1 (typing rhythm game)"


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\(.*?\)|\[.*?\]|feat\..*|ft\..*", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


def lookup(artist, title):
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
        s -= 1 if re.search(r"karaoke|tribute|cover|instrumental|live|remix|8d", col + " " + (x.get("trackName") or "").lower()) else 0
        return s
    best = max(res, key=score, default=None)
    if not best or score(best) < 4:
        return None
    return best["artworkUrl100"].replace("100x100bb", "300x300bb")


def main():
    force = "--force" in sys.argv
    ids = [a for a in sys.argv[1:] if not a.startswith("--")] or sorted(os.listdir(ROOT))
    found = missing = 0
    for lid in ids:
        p = os.path.join(ROOT, lid, "chart.json")
        if not os.path.exists(p):
            continue
        c = json.load(open(p))
        if c.get("art") and not force:
            continue
        art = lookup(c["artist"], c["title"])
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
