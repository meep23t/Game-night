// Keeps the offline helper's VERSION (sw.js) in step with the files it saves for offline use.
//
//   node tools/sw-version.js          update VERSION in sw.js if the saved files changed
//   node tools/sw-version.js --check  only report; exit 1 if VERSION is out of date (used by the tests)
//
// Installed apps only refresh their saved copies when VERSION changes. The page itself ("/") and the word
// files are fetched fresh whenever the phone is online, so only the other saved files (icons, manifest)
// go into the fingerprint.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const SW = path.join(ROOT, 'sw.js');

function expected(src) {
  const line = src.match(/const PRECACHE = \[([^\]]*)\]/);
  if (!line) throw new Error('PRECACHE list not found in sw.js');
  const files = [...line[1].matchAll(/"(\/[^"]+)"/g)].map(m => m[1]).filter(f => f !== '/');
  const h = crypto.createHash('sha1');
  for (const f of files) { h.update(f); h.update(fs.readFileSync(path.join(ROOT, f))); }
  return { version: 'v6-' + h.digest('hex').slice(0, 8), files };
}

function current(src) { const m = src.match(/const VERSION = "([^"]+)";/); return m && m[1]; }

module.exports = { expected, current };

if (require.main === module) {
  const src = fs.readFileSync(SW, 'utf8');
  const { version, files } = expected(src), now = current(src);
  if (process.argv.includes('--check')) {
    if (now !== version) { console.log(`sw.js VERSION is ${now}, should be ${version}: run node tools/sw-version.js`); process.exit(1); }
    console.log(`OK: sw.js VERSION ${now} matches ${files.length} saved files`);
  } else if (now === version) console.log(`No change: ${now}`);
  else { fs.writeFileSync(SW, src.replace(/const VERSION = "[^"]+";/, `const VERSION = "${version}";`)); console.log(`sw.js VERSION ${now} -> ${version}`); }
}
