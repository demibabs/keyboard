# startype

A typing rhythm game: each level is a song, and you type each lyric line as it's sung.

```
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # static release build in dist/ (level files only); pushes to main deploy it to GitHub Pages
CHROME=/path/to/chrome npm run e2e -- 1.5 0       # bot plays a level (dev server running); YT=1 to play the video
CHROME=/path/to/chrome node e2e/youtube.mjs <id>  # checks the game clock against the YouTube video
```

## What's in the repo (and what isn't)
The repo ships no song audio and no song lyrics (apart from the short excerpts on the landing page). Each level is `public/levels/<id>/level.json`:
- the [LRCLIB](https://lrclib.net) entry id, with a hash of the lyric text the level was timed for;
- the start time of each line and how many characters it types (for the song list's difficulty);
- the YouTube video the timing matches (`youtube.id`, `offsetMs` = video time of chart time 0).

When you play, the browser fetches the lyrics from LRCLIB (cached in localStorage) and checks them against the hash. If LRCLIB's entry has changed, the text is still used; if its line count changed, LRCLIB's own timing is used and the play screen says the timing may be off. The audio comes from the YouTube embed: it stays visible (bottom right) as YouTube's embed rules require, ads play if YouTube shows them (the song starts after), and its speed control gives the 0.5×–1.5× speeds. The game clock runs on `performance.now()` and is pulled towards the video's reported position.

For development, levels can also have local audio (`audio@<speed>.ogg`, pitch-preserved renders) and a full-text `chart.json`; both are gitignored. With local audio, **A** on the song list switches between the local file and YouTube, and the chart editor (needs the local audio for the waveform) is available.

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
- Speeds 0.5×–1.5× use YouTube's playback rate (or pre-rendered, pitch-preserved local audio). The difficulty shown is ~WPM needed at that speed.

## Screens
Pages have hash addresses (`#/` home, `#/play` song menu; anything else is a 404 page), so they work on any static host; the game's own screens live under `#/play`. The home and 404 pages share a navbar (star on the left = home; Play and About on the right; About is a 404 for now).
- **Landing**: the hero (wordmark, tagline, Play). Its lyric cards type a short excerpt (the hook and the line after) of a few featured songs, stored in `src/landing.ts` so they show instantly; album art is linked from Apple's artwork CDN. Full lyrics are still only fetched at play time. Enter or Play opens the song list.
- **Song select**: ↑↓ song, ←→ speed, Enter play, C calibrate; with local audio also A audio source, E chart editor.
- **Play**: Esc pause (R restart, Q quit), Tab (while waiting for a line) skip ahead to 1 s before it, Enter results when done.
- **Calibrate**: audio test (tap to clicks) sets the judging offset; visual test (tap to flashes) lines the visuals up with the audio.
- **Chart editor**: waveform + line-start markers. Drag markers, ↑↓ select, `[ ]` nudge 10 ms (Shift 50), Space play, Enter play from selected, T tap mode (press F/J as each line starts), C click track on line starts, 1–3 playback speed, Ctrl+Z undo, Ctrl+S save (writes `public/levels/<id>/chart.json` via the dev server, then regenerates `level.json`; the first save keeps `chart.orig.json`).

## Levels
`public/levels/<id>/level.json` is the committed level (above). Locally, the charting tools work on `chart.json` (`{format: 2, lines: [{t, text}], youtube, ...}`; empty text = end of vocals) and `audio@<speed>.ogg`. `node scripts/levels.ts sync` turns every `chart.json` into `level.json` and writes `index.json` (levels with a video or local audio) and `local.json` (levels with local audio; not committed). The charting tools run it for you. `node scripts/levels.ts verify` checks every level against LRCLIB's current text; `node scripts/levels.ts youtube <id> <videoId> [offsetMs]` sets a level's video.

### Adding a song
```
python3 charting/make_level.py "song.mp3" --artist "Ariana Grande" --title "twilight zone" [--id twilight-zone] [--lrclib-id N] [--offset-ms 0] [--youtube VIDEO_ID]
```
Pass `--youtube` with the video the audio file came from, so the release plays the same cut the timing was made for (otherwise set `youtube.offsetMs` to where the song starts in the video).
Looks the song up on [LRCLIB](https://lrclib.net) (line-synced lyrics), picks the entry whose duration matches the audio (skipping a cappella / instrumental / live versions when possible), writes the chart, renders every speed with rubberband, and refreshes the index. Needs `ffmpeg` and `rubberband`. If the timing is off, fix it in the chart editor or pass `--offset-ms`.

### Adding many songs at once
```
python3 charting/batch_levels.py --newest 100 [--workers 4] [--dry-run]     # or list the files, or --manifest songs.json
```
Fast path for well-known songs: no Whisper, no vocal separation. Each file is identified from its name/tags (junk like "(Official Audio)", channel names and "VEVO" removed), then LRCLIB's own lookup (`/api/get` with artist, title and length) gives the main synced version; if no guess hits, a search picks the most common text among clean-titled entries of the right length. Basic checks flag length mismatches, few lines, censored words, untypeable (non-Latin) text and broken timestamps; songs with no match are skipped. Several songs render at once; a report goes to `charting/work/batch-report.md`. Re-runs skip songs that already have a level unless `--force`. With `--manifest` (a JSON list with `lrclibId`, `audioPath`, `youtubeId`, ...) the given LRCLIB entries and videos are used.

To check the timing against the actual vocals (LRCLIB entries are sometimes early on a line or two):
```
~/.cache/lyric-align/.venv/bin/python charting/check_sync.py <id> [--fix]
```
It separates the vocals with demucs and flags lines whose time falls in vocal silence; `--fix` moves them to the vocal onset (the previous chart is kept as `chart.lrc.json`). `charting/song_offset.py <ids> [--apply]` finds songs whose whole timing is shifted against the audio (a different cut than the LRC was timed for) and shifts them; run it before `check_sync`. Whisper word timestamps were tried for this and are unreliable on sung audio (seconds off on Fly Me to the Moon).

`charting/legacy/` has the old syllable forced-alignment pipeline (demucs + Whisper + MMS_FA); it isn't used anymore.
