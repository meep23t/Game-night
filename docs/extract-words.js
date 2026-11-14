// Reads the app's generated word files (words/*.js) and writes them as one JSON file for build-words-xlsx.py.
const fs = require('fs'), path = require('path');
const W = path.join(__dirname, '..', 'words');
global.window = global;
for (const f of ['act', 'describe', 'doodle', 'range', 'imposter', 'spies']) eval(fs.readFileSync(path.join(W, f + '.js'), 'utf8'));
const G = global.GN_WORDS;
const out = { PACKS: G.act, TABOO: G.describe, IMP: G.imposter, TELE: G.doodle, WAVE: G.range, SPY_L3: G.spies };
// Word spies levels 1-2 are built in the app from other games' one-word entries (same rule as spyPool in index.html).
const single = s => !/\s/.test(s);
const pool = src => [...new Set(src.filter(single).map(w => w.toLowerCase()))];
out.SPY1 = pool([...out.TABOO[1].map(c => c[0]), ...out.TELE[1], ...out.IMP['Animals'], ...out.IMP['Food'], ...out.IMP['Things at home']]);
out.SPY2 = pool([...out.TABOO[2].map(c => c[0]), ...out.TELE[2], ...out.IMP['Places'], ...out.IMP['Jobs'], ...out.IMP['Sports & games']]);
out.SPY3 = pool(out.SPY_L3);
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
