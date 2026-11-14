"""Build the app's word files from the spreadsheets in words/source/.

    python3 words/build.py          check the CSVs and write words/*.js
    python3 words/build.py --check  only check; fail if words/*.js are out of date

Rows whose Status is "draft" or "rejected" are left out of the app. Anything else
(including blank) counts as approved. The build stops on any problem it finds.
"""
import csv, json, os, re, sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "source")
LEVELS = {"1", "2", "3"}
FORBIDDEN_PER_LEVEL = {"1": 3, "2": 4, "3": 5}   # Describe it: forbidden words per card
# Whole-word screen over every word and detail. Add to it as needed; a hit stops the build.
BANNED = r"""sex sexy naked nude porn beer wine vodka whiskey drunk booze cocktail weed marijuana cocaine
heroin cigarette vape gun guns rifle pistol shoot shooting kill killed killing murder suicide blood bloody stab
damn hell crap shit fuck bitch ass butt bastard sucks stupid idiot dumb retard hate casino gamble gambling lottery""".split()
BANNED_RE = re.compile(r"\b(" + "|".join(map(re.escape, BANNED)) + r")\b", re.I)
# Phrases that contain a banned word but are fine.
ALLOWED = {"shooting star"}

problems = []

def read(name):
    with open(os.path.join(SRC, name + ".csv"), newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    head, out = rows[0], []
    for n, r in enumerate(rows[1:], start=2):
        if not any(c.strip() for c in r): continue
        r = [c.strip() for c in r] + [""] * (len(head) - len(r))
        row = dict(zip(head, r)); row["_line"] = f"{name}.csv line {n}"
        if row.get("Status", "").lower() in ("draft", "rejected"): continue
        out.append(row)
    return out

def screen(row, *texts):
    for t in texts:
        if t.lower() in ALLOWED: continue
        m = BANNED_RE.search(t)
        if m: problems.append(f'{row["_line"]}: "{t}" contains "{m.group(0)}" (content screen)')

def norm(s): return re.sub(r"\s+", " ", s.lower().replace("’", "'")).strip()

def need(row, *cols):
    for c in cols:
        if not row.get(c): problems.append(f'{row["_line"]}: "{c}" is empty')
    return all(row.get(c) for c in cols)

def no_dupes(groups, what):
    for key, items in groups.items():
        seen = {}
        for word, line in items:
            k = norm(word)
            if k in seen: problems.append(f'{line}: "{word}" is already in {what} {key} ({seen[k]})')
            else: seen[k] = line

# --- Act it out: {pack: [[easy, hard], ...]} -------------------------------------------
act, act_seen = OrderedDict(), OrderedDict()
for r in read("act-it-out"):
    if not need(r, "Pack", "Word", "Hard version"): continue
    screen(r, r["Word"], r["Hard version"])
    act.setdefault(r["Pack"], []).append([r["Word"], r["Hard version"]])
    act_seen.setdefault("(all packs)", []).append((r["Word"], r["_line"]))   # packs can be mixed in one game
no_dupes(act_seen, "Act it out")

# --- Describe it: {level: [[word, [forbidden...]], ...]} --------------------------------
desc, desc_seen = OrderedDict((l, []) for l in sorted(LEVELS)), OrderedDict()
for r in read("describe-it"):
    col = "Forbidden words (separate with ;)"
    if not need(r, "Level", "Word", col): continue
    if r["Level"] not in LEVELS: problems.append(f'{r["_line"]}: Level must be 1, 2 or 3'); continue
    forb = [x.strip() for x in r[col].split(";") if x.strip()]
    if len(forb) != FORBIDDEN_PER_LEVEL[r["Level"]]:
        problems.append(f'{r["_line"]}: level {r["Level"]} needs {FORBIDDEN_PER_LEVEL[r["Level"]]} forbidden words, found {len(forb)}')
    screen(r, r["Word"], *forb)
    desc[r["Level"]].append([r["Word"], forb])
    desc_seen.setdefault("(all levels)", []).append((r["Word"], r["_line"]))   # Word bowl mixes levels 1-2
no_dupes(desc_seen, "Describe it")

# --- Pass the doodle: {level: [word, ...]} -----------------------------------------------
tele, tele_seen = OrderedDict((l, []) for l in sorted(LEVELS)), OrderedDict()
for r in read("pass-the-doodle"):
    if not need(r, "Level", "Word"): continue
    if r["Level"] not in LEVELS: problems.append(f'{r["_line"]}: Level must be 1, 2 or 3'); continue
    screen(r, r["Word"]); tele[r["Level"]].append(r["Word"])
    tele_seen.setdefault("(all levels)", []).append((r["Word"], r["_line"]))
no_dupes(tele_seen, "Pass the doodle")

# --- In the range: {level: [[left, right], ...]} -----------------------------------------
wave, wave_seen = OrderedDict((l, []) for l in sorted(LEVELS)), OrderedDict()
for r in read("in-the-range"):
    if not need(r, "Level", "Left end", "Right end"): continue
    if r["Level"] not in LEVELS: problems.append(f'{r["_line"]}: Level must be 1, 2 or 3'); continue
    screen(r, r["Left end"], r["Right end"]); wave[r["Level"]].append([r["Left end"], r["Right end"]])
    wave_seen.setdefault("level " + r["Level"], []).append((r["Left end"] + " / " + r["Right end"], r["_line"]))
no_dupes(wave_seen, "In the range")

# --- Imposter: {category: [word, ...]} ---------------------------------------------------
imp, imp_seen = OrderedDict(), OrderedDict()
for r in read("imposter"):
    if not need(r, "Category", "Word"): continue
    screen(r, r["Word"]); imp.setdefault(r["Category"], []).append(r["Word"])
    imp_seen.setdefault(r["Category"], []).append((r["Word"], r["_line"]))
no_dupes(imp_seen, "Imposter")

# --- Word spies level 3 (levels 1-2 are built in the app from other games' words) --------
spy, spy_seen = [], OrderedDict()
for r in read("word-spies"):
    if not need(r, "Word"): continue
    if r.get("Level", "3") != "3": problems.append(f'{r["_line"]}: only level 3 has its own list (levels 1-2 come from other games)'); continue
    if " " in r["Word"]: problems.append(f'{r["_line"]}: Word spies words must be one word')
    screen(r, r["Word"]); spy.append(r["Word"]); spy_seen.setdefault("level 3", []).append((r["Word"], r["_line"]))
no_dupes(spy_seen, "Word spies")

# Small lists make a game repeat quickly; the app also needs every level/pack non-empty.
for name, groups in [("Describe it level", desc), ("Pass the doodle level", tele), ("In the range level", wave)]:
    for k, v in groups.items():
        if len(v) < 20: problems.append(f"{name} {k} has only {len(v)} entries (need at least 20)")
for k, v in imp.items():
    if len(v) < 10: problems.append(f"Imposter category {k} has only {len(v)} words (need at least 10)")
if len(spy) < 25: problems.append(f"Word spies level 3 has only {len(spy)} words (need at least 25)")

if problems:
    print(f"{len(problems)} problem(s), nothing written:\n  " + "\n  ".join(problems)); sys.exit(1)

OUT = {"act": act, "describe": desc, "doodle": tele, "range": wave, "imposter": imp, "spies": spy}
stale = []
for key, data in OUT.items():
    js = ("// Generated by words/build.py from words/source/. Edit the CSV, not this file.\n"
          "window.GN_WORDS = window.GN_WORDS || {};\n"
          f"GN_WORDS[{json.dumps(key)}] = {json.dumps(data, ensure_ascii=False)};\n")
    path = os.path.join(HERE, key + ".js")
    old = open(path, encoding="utf-8").read() if os.path.exists(path) else None
    if old != js:
        stale.append(key + ".js")
        if "--check" not in sys.argv: open(path, "w", encoding="utf-8").write(js)

count = sum(len(v) for v in act.values()) + sum(len(v) for v in desc.values()) + sum(len(v) for v in tele.values()) \
    + sum(len(v) for v in wave.values()) + sum(len(v) for v in imp.values()) + len(spy)
if "--check" in sys.argv:
    if stale: print("Out of date, run python3 words/build.py:", ", ".join(stale)); sys.exit(1)
    print(f"OK: {count} words, word files up to date")
else:
    print(f"OK: {count} words" + (f"; wrote {', '.join(stale)}" if stale else "; no changes"))
