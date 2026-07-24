---
name: download-crossword
description: Download Washington Post Daily Cryptic Crossword PDFs (Blank Puzzle and With Solution) for any date in the last 30 days.
---

# Download Washington Post Daily Cryptic Crossword

This skill automates downloading daily cryptic crossword PDFs from https://games.washingtonpost.com/games/daily-cryptic-crossword to `~/crosswords`.

## Instructions

1. Run the downloader script with the target date (format `YYYY-MM-DD` or `YYYY.MM.DD`):
   ```bash
   node ~/crosswords/download_crossword.js <YYYY-MM-DD>
   ```
2. The script will output two files in `~/crosswords`:
   - `<YYYY.MM.DD> wpc.pdf` (Blank Puzzle)
   - `<YYYY.MM.DD> wpc ans.pdf` (With Solution)
