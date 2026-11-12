# Lyric Typer

A typing rhythm game: each level is a song, and you type each lyric line as it's sung.

```
npm install
npm run dev        # http://localhost:5173
npm test           # engine unit tests
CHROME=~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome npm run e2e -- 1.5 0   # bot plays a level (dev server running)
```

## Rules
- Levels are timed per line (LRC-style). A line opens 0.3 s before its timestamp (keys before that are ignored, no penalty) and stays open until the next line starts (or until an empty LRC line, which marks the end of the vocals); anything left is dropped. The bar under the line shows the time left, and the "Next" box counts down to the next line.
- Text in parentheses (ad-libs, backing vocals) is shown but not typed. Case, punctuation and apostrophes aren't typed. Hyphens accept `-` or space.
- A wrong key always marks the letter missed and moves on. A forgotten space between words (after clean typing) is counted as missed and the key goes to the next word.
- Reaction time: for 0.5 s after a new line becomes current, wrong keys are ignored (right ones still count), so finishing the previous line's words as the next pops up isn't penalised. Not applied when you jump to the next line on purpose.
- Autocorrection runs after each typo. If 3+ of your recent keys fit another alignment (2+ of them marked wrong), it realigns the cursor. The options are a small forward shift of 1–3 letters (you skipped letters; they count as missed), a backward shift of 1–4 keys (you typed extra keys; each counts as a miss; never back over a word you'd already typed right; 2+ extra keys must include a wrong one), or a word skip to a later word in the line (skipped letters drop). It picks the option giving the line the best final accuracy; ties prefer small forward, then backward, then word skip. Letters accepted this way are **autocorrected**: shown in lavender and worth 75%.
- Typing the first letter of a later line once it's open drops what's left and continues there.
- **Score** (all × game speed):
  - letters: 10 each when typed right, 7.5 when autocorrected, 0 when wrong or dropped (accuracy = the same weights over all letters);
  - finishing a line: 5 per letter × line accuracy × (1 + speed), where speed runs from 0 (finished as the line closed) to 1 (instantly);
  - clean line (no mistakes, autocorrections or missed spaces): +5 per letter.
- Grade from accuracy: S ≥ 95%, A ≥ 90%, B ≥ 80%, C ≥ 70%, else D. Score only, no fail state.
- Speeds 0.5×–1.5× use pre-rendered, pitch-preserved audio (rubberband). The difficulty shown is ~WPM needed at that speed.

## Screens
- **Song select**: ↑↓ song, ←→ speed, Enter play, C calibrate, E chart editor.
- **Play**: Esc pause (R restart, Q quit), Tab (while waiting for a line) skip ahead to 1 s before it, Enter results when done.
- **Calibrate**: audio test (tap to clicks) sets the judging offset; visual test (tap to flashes) lines the visuals up with the audio.
- **Chart editor**: waveform + line-start markers. Drag markers, ↑↓ select, `[ ]` nudge 10 ms (Shift 50), Space play, Enter play from selected, T tap mode (press F/J as each line starts), C click track on line starts, 1–3 playback speed, Ctrl+Z undo, Ctrl+S save (writes `public/levels/<id>/chart.json` via the dev server; the first save keeps `chart.orig.json`).

## Levels
`public/levels/<id>/` holds `chart.json` (`{format: 2, lines: [{t, text}], ...}`; empty text = end of vocals) and `audio@<speed>.ogg` for each speed. `public/levels/index.json` lists the level ids. Audio isn't committed.

### Adding a song
```
python3 charting/make_level.py "song.mp3" --artist "Ariana Grande" --title "twilight zone" [--id twilight-zone] [--lrclib-id N] [--offset-ms 0]
```
Looks the song up on [LRCLIB](https://lrclib.net) (line-synced lyrics), picks the entry whose duration matches the audio (skipping a cappella / instrumental / live versions when possible), writes the chart, renders every speed with rubberband, and refreshes the index. Needs `ffmpeg` and `rubberband`. If the timing is off, fix it in the chart editor or pass `--offset-ms`.

### Adding many songs at once
```
python3 charting/batch_levels.py --newest 100 [--workers 4] [--dry-run]     # or list the files
```
Fast path for well-known songs: no Whisper, no vocal separation. Each file is identified from its name/tags (junk like "(Official Audio)", channel names and "VEVO" removed), then LRCLIB's own lookup (`/api/get` with artist, title and length) gives the main synced version; if no guess hits, a search picks the most common text among clean-titled entries of the right length. Basic checks flag length mismatches, few lines, censored words, untypeable (non-Latin) text and broken timestamps; songs with no match are skipped. Several songs render at once; a report goes to `charting/work/batch-report.md`. Re-runs skip songs that already have a level unless `--force`.

To check the timing against the actual vocals (LRCLIB entries are sometimes early on a line or two):
```
~/.cache/lyric-align/.venv/bin/python charting/check_sync.py <id> [--fix]
```
It separates the vocals with demucs and flags lines whose time falls in vocal silence; `--fix` moves them to the vocal onset (the previous chart is kept as `chart.lrc.json`). Whisper word timestamps were tried for this and are unreliable on sung audio (seconds off on Fly Me to the Moon).

`charting/legacy/` has the old syllable forced-alignment pipeline (demucs + Whisper + MMS_FA); it isn't used anymore.
