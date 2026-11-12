#!/usr/bin/env python3
"""Transcribe an audio file with Whisper and print the words as JSON (used by make_level.py to pick the
LRCLIB version whose wording matches the recording). Whisper's words are reliable; its timestamps on sung
audio are not, so only the text is used.
usage: ~/.cache/lyric-align/.venv/bin/python charting/transcribe.py audio > words.json"""
import json, re, sys
import librosa, torch
from faster_whisper import WhisperModel

cuda = torch.cuda.is_available()
m = WhisperModel("large-v3", device="cuda" if cuda else "cpu", compute_type="float16" if cuda else "int8")
# decode ourselves: this env's PyAV doesn't match faster-whisper's file decoder
audio, _ = librosa.load(sys.argv[1], sr=16000)
segs, _ = m.transcribe(audio, language="en", word_timestamps=False, condition_on_previous_text=False)
words = [w for s in segs for w in (re.sub(r"[^a-z0-9]", "", x.lower()) for x in s.text.split()) if w]
json.dump(words, sys.stdout)
