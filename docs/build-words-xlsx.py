"""Rebuild docs/game-night-words.xlsx from index.html.
Run from the repo root:  python3 docs/build-words-xlsx.py   (needs node and openpyxl)"""
import json, os, subprocess, tempfile
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.comments import Comment
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
tmp = os.path.join(tempfile.mkdtemp(), "words.json")
subprocess.run(["node", os.path.join(HERE, "extract-words.js"), tmp], check=True, stdout=subprocess.DEVNULL)
d = json.load(open(tmp))
LV = {"1": "Level 1 (Kids)", "2": "Level 2 (Medium)", "3": "Level 3 (Tricky/Classic)"}

rows = []  # game, group, word, details, derived, note
for p, cards in d["PACKS"].items():
    for e, h in cards: rows.append(("Act it out", p, e, h, False, ""))
for l, cards in d["TABOO"].items():
    for w, f in cards: rows.append(("Describe it", LV[l], w, "Don’t say: " + ", ".join(f), False, ""))
for l, ws in d["TELE"].items():
    for w in ws: rows.append(("Pass the doodle", LV[l], w, "", False, ""))
for l, ps in d["WAVE"].items():
    for a, b in ps: rows.append(("In the range", LV[l], a, b, False, ""))
for c, ws in d["IMP"].items():
    for w in ws: rows.append(("Imposter", c, w, "", False, ""))
SRC = {"1": "Built automatically: one-word entries from Describe it L1, Pass the doodle L1, Imposter Animals/Food/Things at home",
       "2": "Built automatically: one-word entries from Describe it L2, Pass the doodle L2, Imposter Places/Jobs/Sports & games"}
for l in ("1", "2"):
    for w in d["SPY" + l]: rows.append(("Word spies", LV[l], w, "", True, SRC[l]))
for w in d["SPY_L3"]: rows.append(("Word spies", LV["3"], w, "", False, ""))

wb = Workbook()
H = Font(bold=True, color="FFFFFF"); HF = PatternFill("solid", fgColor="2B44D6")
DF = PatternFill("solid", fgColor="EDEDED"); DI = Font(italic=True, color="666666")
def head(ws, cols, widths):
    ws.append(cols)
    for i, c in enumerate(cols, 1):
        cell = ws.cell(1, i); cell.font = H; cell.fill = HF
        ws.column_dimensions[get_column_letter(i)].width = widths[i - 1]
    ws.freeze_panes = "A2"

r = wb.active; r.title = "README"
for t, b in [("Game night word lists", True), ("", False),
    ("Words: every word/card in the app, one per row (source data). Filter by Game and Level / pack.", False),
    ("Inventory: counts per game and level/pack. All counts are COUNTIFS formulas on the Words sheet, so they update if you edit Words.", False),
    ("Content review: entries changed in the appropriateness check.", False), ("", False),
    ("Column meanings on Words:", True),
    ("Act it out → Details = the hard (2-point) version of the card.", False),
    ("Describe it → Details = the forbidden words.", False),
    ("In the range → Word = left end of the dial, Details = right end.", False),
    ("Word spies Level 1 & 2 rows are NOT a separate list in the app: the game builds them from other games’ one-word entries (duplicates removed). They are shaded gray and labeled “Derived” so they aren’t mistaken for their own list.", False),
    ("Word bowl has no list of its own: players write the words, or with “Players write the words” off it draws from Describe it Levels 1–2 (see Inventory).", False),
    ("Source: index.html in the Game-night repo. Rebuild with: python3 docs/build-words-xlsx.py", False)]:
    r.append([t]); r.cell(r.max_row, 1).font = Font(bold=b, size=14 if t == "Game night word lists" else 11)
r.column_dimensions["A"].width = 120

w = wb.create_sheet("Words")
head(w, ["Game", "Level / pack", "Word", "Details", "Type", "Notes"], [18, 26, 30, 60, 10, 70])
for g, grp, word, det, der, note in rows:
    w.append([g, grp, word, det, "Derived" if der else "List", note])
    if der:
        for c in w[w.max_row]: c.fill = DF; c.font = DI
w.auto_filter.ref = f"A1:F{w.max_row}"
N = w.max_row

inv = wb.create_sheet("Inventory", 1)
head(inv, ["Game", "Level / pack", "Count", "Notes"], [18, 36, 10, 80])
order, games = [], []
for g, grp, *_ in rows:
    if (g, grp) not in order: order.append((g, grp))
    if g not in games: games.append(g)
totals = {}
for g in games:
    start = inv.max_row + 1
    for gg, grp in [x for x in order if x[0] == g]:
        i = inv.max_row + 1
        inv.append([gg, grp, f"=COUNTIFS(Words!$A$2:$A${N},A{i},Words!$B$2:$B${N},B{i})", ""])
        if g == "Word spies" and "Level 3" not in grp:
            inv.cell(i, 4).value = "Derived from other games (see README). Not its own list."
            for c in inv[i]: c.fill = DF; c.font = DI
    end = inv.max_row; i = end + 1
    inv.append([g, "Total (incl. derived Levels 1–2)" if g == "Word spies" else "Total", f"=SUM(C{start}:C{end})", ""])
    for c in inv[i]: c.font = Font(bold=True)
    totals[g] = i
i = inv.max_row + 1
inv.append(["Word bowl", "Auto-fill (when players don’t write words)",
    f'=COUNTIFS(Words!$A$2:$A${N},"Describe it",Words!$B$2:$B${N},"{LV["1"]}")+COUNTIFS(Words!$A$2:$A${N},"Describe it",Words!$B$2:$B${N},"{LV["2"]}")',
    "Uses Describe it Levels 1 + 2. Not a separate list; not added to the grand total."])
for c in inv[i]: c.fill = DF; c.font = DI
i = inv.max_row + 2
inv.cell(i, 1, "Grand total (games’ own lists)").font = Font(bold=True)
inv.cell(i, 3, "=SUM(" + ",".join(f"C{totals[g]}" for g in games if g != "Word spies") +
    f')+COUNTIFS(Words!$A$2:$A${N},"Word spies",Words!$E$2:$E${N},"List")').font = Font(bold=True)
inv.cell(i, 3).comment = Comment("Each game total except Word spies, plus Word spies rows of Type “List” (Level 3).", "Claude")
inv.cell(i, 4, "Excludes derived Word spies Levels 1–2 and the Word bowl auto-fill.")

cr = wb.create_sheet("Content review")
head(cr, ["Game", "Level / pack", "Before", "After", "Why"], [16, 26, 52, 52, 60])
for x in [
    ("Act it out", "Bible stories", "Joseph’s coat / coat of many colors", "Joseph’s dreams / sheaves of wheat bowing down", "Duplicate of the existing Joseph card"),
    ("Act it out", "Bible stories", "the walls of Jericho / marching around Jericho", "Rahab / red rope hanging from a window", "Duplicate of the existing Jericho card"),
    ("Act it out", "Bible stories", "Paul / shipwrecked on an island", "Paul / blinded on the road to Damascus", "Duplicate of “Paul’s shipwreck”"),
    ("Act it out", "Everyday actions", "shower / sing in the shower", "shower / shampoo your hair", "Same hard version as “sing”"),
    ("Act it out", "School life", "dodgeball / dodge a dodgeball", "show and tell / show and tell with a pet snake", "Overlapped “gym class / dodgeball”"),
    ("Act it out", "Feelings", "thrilled / win the lottery", "thrilled / win the grand prize", "Gambling reference; family-friendly swap"),
    ("Pass the doodle", "Level 3", "jump the gun", "pie in the sky", "Avoid drawing a gun"),
    ("Describe it", "Level 3", "bucket list: don’t say “die”", "“someday”", "Softer forbidden word"),
    ("Describe it", "Level 3", "karaoke: don’t say “bar”", "“party”", "Avoid alcohol setting"),
    ("Describe it", "Level 3", "side effect: don’t say “drug”", "“pills”", "Softer wording")]:
    cr.append(list(x))
cr.append([]); cr.append(["Scan result: no profanity, sexual content, alcohol/drug or violent words found in any list. Words like police, ghost, werewolf, election, taxes were reviewed and kept as family-appropriate."])
for ws in (r, w, inv, cr):
    for row in ws.iter_rows():
        for c in row: c.alignment = Alignment(wrap_text=True, vertical="top")
out = os.path.join(HERE, "game-night-words.xlsx"); wb.save(out); print("saved", out, N - 1, "rows")
