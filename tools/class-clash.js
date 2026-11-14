// Finds CSS class names used for two different jobs in index.html: switched on and off by code
// (classList.add/toggle/remove, e.g. to start an animation) AND written into markup as a regular style.
// That's what made the home icons jump: the animation class "go" was also the card's "Play →" label class.
//
//   node tools/class-clash.js   prints any clashes (exit 1 if there are some)
const fs = require('fs'), path = require('path');

function clashes(html) {
  const NAME = /^[a-zA-Z_][\w-]*$/;
  const state = new Map(), markup = new Map();
  const add = (map, name, where) => { if (NAME.test(name)) { if (!map.has(name)) map.set(name, where); } };
  const lineOf = i => html.slice(0, i).split('\n').length;

  // switched by code: every quoted name in classList.add/remove(...) and the first argument of toggle(...)
  for (const m of html.matchAll(/classList\.(add|remove|toggle)\(([^;]*?)\)/g)) {
    let args = m[2];
    if (m[1] === 'toggle') args = args.split(/,(?![^(]*\))/)[0];
    for (const q of args.matchAll(/["'`]([^"'`$]+)["'`]/g)) add(state, q[1], `line ${lineOf(m.index)}`);
  }
  // regular styles in markup: class="..." (HTML and templates) and className = "..." / `...`
  for (const m of html.matchAll(/class="([^"]*)"/g))
    for (const c of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) add(markup, c, `line ${lineOf(m.index)}`);
  for (const m of html.matchAll(/className\s*=\s*(["'`])([^"'`]*)\1/g))
    for (const c of m[2].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) add(markup, c, `line ${lineOf(m.index)}`);

  return [...state.keys()].filter(c => markup.has(c)).map(c => ({ name: c, switched: state.get(c), styled: markup.get(c) }));
}
module.exports = { clashes };

if (require.main === module) {
  const found = clashes(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
  if (!found.length) { console.log('OK: no class name is used both as a switched state and as a regular style'); return; }
  found.forEach(c => console.log(`"${c.name}": switched by code (${c.switched}) and used as a style (${c.styled})`));
  process.exit(1);
}
