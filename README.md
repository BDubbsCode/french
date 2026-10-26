# French Before France

A personal iPhone web app for studying Language Transfer's free
[Introduction to French](https://www.languagetransfer.org/french) course:
lesson player, notes, drills and spaced-repetition review.

The lesson audio is not in this repo. The app downloads it on the device
straight from Language Transfer's official download link. All credit for the
course goes to Language Transfer; please support them if you use it.

- `app/`: the web app (deployed to GitHub Pages)
- `scripts/transcribe.py`: Whisper transcription of the lesson MP3s
- `scripts/build_lessons.py`: merges `data/notes` and `data/transcripts` into `app/lessons`
