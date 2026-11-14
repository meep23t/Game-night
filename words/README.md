# Word lists

Every word in the app lives in a spreadsheet here. Edit the spreadsheets, then rebuild.

| File in `source/` | Game | Columns |
|---|---|---|
| `act-it-out.csv` | Act it out | Pack, Word, Hard version |
| `describe-it.csv` | Describe it (Word bowl auto-fill uses levels 1–2) | Level, Word, Forbidden words (separate with `;`) |
| `pass-the-doodle.csv` | Pass the doodle | Level, Word |
| `in-the-range.csv` | In the range | Level, Left end, Right end |
| `imposter.csv` | Imposter | Category, Word |
| `word-spies.csv` | Word spies level 3 | Level, Word |

Each file also has **Status** and **Notes** columns:
- **Status:** set it to `draft` or `rejected` to keep a row out of the app. Anything else, including blank, counts as approved.
- **Notes:** for you only. The app ignores it.

A new Pack (Act it out) or Category (Imposter) shows up in the game automatically.

Word spies levels 1–2 have no list of their own. The game builds them from the one-word entries in Describe it, Pass the doodle and Imposter.

## Rebuild

```
python3 words/build.py
```

The build checks every row and stops, writing nothing, if it finds a problem:
- **Missing:** an empty word or detail.
- **Duplicate:** a word already in the same game. Act it out, Describe it and Pass the doodle are checked across all packs and levels; In the range and Word spies per level; Imposter per category.
- **Wrong forbidden-word count:** Describe it cards need 3, 4 or 5 forbidden words for levels 1, 2 or 3.
- **Banned word:** anything on the content-screen list in `build.py`.
- **Two-word spy word:** Word spies words must be a single word.
- **List too small:** fewer than 20 entries in a level, or 10 in an Imposter category.

Once it passes, it writes `words/*.js`, which the app loads. Commit both the CSV and the generated files.

To check that everything is up to date without writing anything, run `python3 words/build.py --check`.

To refresh the word-list workbook too, run `python3 docs/build-words-xlsx.py`.

Opening the CSVs in Excel is fine. Save as **CSV UTF-8** so curly apostrophes and accents survive.
