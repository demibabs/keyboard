"""Parse a syllabified lyrics file into sections -> lines -> words -> syllables."""
import re

def typed(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())

def parse(path):
    sections = []
    for raw in open(path, encoding="utf-8"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            sections.append({"name": line[1:-1], "lines": []})
            continue
        words = []
        for tok in line.split():
            parts = tok.split("-")
            for i, p in enumerate(parts):
                disp = p + ("-" if i < len(parts) - 1 else "")
                sylls = disp.split("|")
                # keep punctuation-only chunks attached to a neighbour
                words.append({"syllables": sylls, "joinNext": i < len(parts) - 1})
        for w in words:
            assert all(typed(s) for s in w["syllables"]), (line, w)
        sections[-1]["lines"].append({"text": line.replace("|", ""), "words": words})
    return sections
