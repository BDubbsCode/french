"""Merge hand-made notes (data/notes/NN.json) with Whisper transcripts into app/lessons/.

Usage: python build_lessons.py <french-app dir>
Also: python build_lessons.py <dir> --dump N   prints lesson N's transcript compactly.
"""
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
tx_dir, notes_dir, out_dir = root / "data/transcripts", root / "data/notes", root / "app/lessons"


def load(p):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


if "--dump" in sys.argv:
    n = int(sys.argv[sys.argv.index("--dump") + 1])
    sys.stdout.reconfigure(encoding="utf-8")
    for s in load(tx_dir / f"lesson{n:02d}.json")["segments"]:
        print(f"{s['start']:.0f} {s['text']}")
    sys.exit()

out_dir.mkdir(parents=True, exist_ok=True)
index = []
for n in range(1, 41):
    tx = load(tx_dir / f"lesson{n:02d}.json") or {"duration": 0, "segments": []}
    notes = load(notes_dir / f"{n:02d}.json") or {}
    lesson = {
        "n": n,
        "title": notes.get("title", ""),
        "summary": notes.get("summary", ""),
        "points": notes.get("points", []),
        "vocab": [{"fr": v[0], "en": v[1]} for v in notes.get("vocab", [])],
        "drills": [{"en": d[0], "fr": d[1], "t": d[2] if len(d) > 2 else None}
                   for d in notes.get("drills", [])],
        "transcript": [{"t": s["start"], "x": s["text"]} for s in tx["segments"]],
    }
    (out_dir / f"{n:02d}.json").write_text(
        json.dumps(lesson, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    index.append({"n": n, "title": lesson["title"], "dur": round(tx["duration"])})

(out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
print(f"built {len(index)} lessons; notes for "
      f"{sum(1 for n in range(1, 41) if (notes_dir / f'{n:02d}.json').exists())}")
