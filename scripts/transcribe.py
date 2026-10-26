"""Transcribe Language Transfer lessons to JSON segments with faster-whisper.

Usage: python transcribe.py <audio_dir> <out_dir> [model] [lesson numbers...]
Skips lessons whose JSON already exists, so it can be re-run after interruption.
"""
import json
import sys
import time
from pathlib import Path

from faster_whisper import WhisperModel

PROMPT = (
    "A French lesson taught in English. The teacher asks the student to say "
    "phrases in French, e.g. c'est possible, je veux, je ne sais pas, "
    "pourquoi, aujourd'hui, ce n'est pas, je voudrais, nous avons, "
    "qu'est-ce que c'est, il faut, maintenant."
)

audio_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
model_name = sys.argv[3] if len(sys.argv) > 3 else "small"
only = {int(n) for n in sys.argv[4:]}
out_dir.mkdir(parents=True, exist_ok=True)

model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=6)

for mp3 in sorted(audio_dir.glob("*.mp3")):
    num = int(mp3.stem[-2:])
    if only and num not in only:
        continue
    out = out_dir / f"lesson{num:02d}.json"
    if out.exists():
        continue
    t0 = time.time()
    segments, info = model.transcribe(
        str(mp3),
        language="en",
        initial_prompt=PROMPT,
        vad_filter=True,
        beam_size=5,
    )
    segs = [
        {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
        for s in segments
    ]
    out.write_text(
        json.dumps({"lesson": num, "duration": info.duration, "segments": segs},
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"lesson {num:02d}: {info.duration/60:.1f} min audio in "
          f"{(time.time()-t0)/60:.1f} min", flush=True)
