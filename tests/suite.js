// Automated test suite for Game night.
//
// Drives the real site in a simulated phone browser (Playwright + Chromium) and checks every
// game end to end, player limits, scoring, teams, game night, timers and layout.
//
//   npm test                 run everything (starts its own local server)
//   TEST_URL=https://... npm test   run against an already-running site instead
//
// Screenshots of failing sections and results.json go to tests/output/ (git-ignored).
const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });
let URL = process.env.TEST_URL || '';

// Minimal static server for the repo root, so the suite needs nothing else running.
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };
function serve(){
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let f = decodeURIComponent(req.url.split('?')[0]); if (f.endsWith('/')) f += 'index.html';
      const file = path.join(ROOT, path.normalize(f));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const results = []; // {area, name, ok, detail}
// Sections run in parallel; AsyncLocalStorage tells check() which section the current code belongs to.
const { AsyncLocalStorage } = require('async_hooks');
const areaOf = new AsyncLocalStorage();
const check = (name, ok, detail = '') => { results.push({ area: areaOf.getStore(), name, ok: !!ok, detail: String(detail) }); };
const SECTIONS = []; // [area, async fn]
const section = (area, fn) => SECTIONS.push([area, fn]);

async function fresh(browser, opts = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone SE'], colorScheme: opts.dark ? 'dark' : 'light' });
  const p = await ctx.newPage();
  p.errs = [];
  p.on('pageerror', e => p.errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) p.errs.push(m.text()); });
  await p.clock.install();
  await p.goto(URL);
  await p.evaluate(() => { localStorage.clear(); });
  await p.reload();
  return p;
}
const ev = (p, f, a) => p.evaluate(f, a);
const screen = p => ev(p, () => G.screen);
const txt = (p, sel) => p.locator(sel).innerText();
async function setPlayers(p, names) { await ev(p, n => { S.players = n.slice(); S.playerIds = n.map(() => null); save(); }, names); }
// Put a player on team k (0/1) with the team cards: tap their chip if they're on the other team.
async function team(p, scope, name, k) {
  const chip = p.locator(`${scope} .tc-col.t${1 - k} button[aria-label^="Move ${name} to "]`);
  if (await chip.count()) await chip.click();
}
async function open(p, mode) { await ev(p, () => show('home')); await p.click({ act:'#goAct', taboo:'#goTaboo', fb:'#goFb', tele:'#goTele', wave:'#goWave', imp:'#goImp', spy:'#goSpy' }[mode]); }
async function noHScroll(p, label) {
  const o = await ev(p, () => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
  check(`No sideways scrolling: ${label}`, o.sw <= o.w + 1, `${o.sw}px content in ${o.w}px screen`);
}
// Word spies: the spymaster types a clue and a number before the team can guess.
async function giveClue(p, n = 1, word = 'zebrafish') {
  await ev(p, n => { G.clueNum = n; renderClue(); }, n);
  await p.fill('#sbClueWord', word); await p.click('#sbClueGo');
}
async function shotFail(p, name) { try { await p.screenshot({ path: `${OUT}/fail-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 50)}.png` }); } catch (e) {} }

(async () => {
  const srv = URL ? null : await serve();
  if (srv) URL = `http://127.0.0.1:${srv.address().port}/`;
  const b = await chromium.launch();

  /* ================= CODE CHECK (no browser) ================= */
  section('Code check', async AREA => {
    const { spawnSync } = require('child_process');
    // offline helper version matches the files it saves
    const swv = require(path.join(ROOT, 'tools', 'sw-version.js')), swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const want = swv.expected(swSrc).version, have = swv.current(swSrc);
    check('Offline helper version matches its saved files', have === want, `sw.js has ${have}, should be ${want}: run node tools/sw-version.js`);
    // no class name is both switched by code and used as a regular style
    const cl = require(path.join(ROOT, 'tools', 'class-clash.js')).clashes(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    check('No CSS class name is used for two different jobs', !cl.length, cl.map(c => `"${c.name}" (${c.switched} / ${c.styled})`).join('; '));
    // quick bug check: undefined names, typos, duplicate keys, dead code
    const lint = spawnSync(process.execPath, [path.join(__dirname, 'node_modules', 'eslint', 'bin', 'eslint.js'), '-c', 'tests/eslint.config.js', 'index.html', 'sw.js', 'words'], { cwd: ROOT, encoding: 'utf8' });
    check('ESLint finds no problems', lint.status === 0, (lint.stdout || lint.stderr || '').trim().split('\n').slice(0, 5).join(' | '));
    // word files are up to date with the spreadsheets
    const wb = spawnSync('python3', [path.join(ROOT, 'words', 'build.py'), '--check'], { encoding: 'utf8' });
    if (wb.error) check('Word files match the spreadsheets (skipped: python3 not found)', true);
    else check('Word files match the spreadsheets', wb.status === 0, (wb.stdout || wb.stderr).trim());
  });

  /* ================= GAME LIST: every game's entry is complete ================= */
  section('Game list', async AREA => {
    const p = await fresh(b);
    const gaps = await ev(p, () => {
      const out = [];
      for (const [k, g] of Object.entries(GAMES)) {
        for (const f of ['name', 'intro', 'tile', 'color', 'players', 'teams', 'saves', 'ends']) if (g[f] == null) out.push(`${k}: no ${f}`);
        if (!document.getElementById(g.tile)) out.push(`${k}: homepage card #${g.tile} missing`);
        if (!ICON[k]) out.push(`${k}: no ICON`);
        if (!SETTINGS[k]) out.push(`${k}: no SETTINGS`);
        if (!['choice', 'auto', 'none'].includes(g.teams)) out.push(`${k}: teams must be choice, auto or none`);
        if (!(g.players[0] >= 2 && g.players[1] <= 12 && g.players[0] <= g.players[1])) out.push(`${k}: odd player range`);
        for (const sc of g.saves) { if (!RESUME[sc]) out.push(`${k}: save screen ${sc} has no RESUME`); if (!document.getElementById(sc)) out.push(`${k}: no screen #${sc}`); }
        for (const sc of g.ends) if (!document.getElementById(sc)) out.push(`${k}: no screen #${sc}`);
      }
      for (const sc of Object.keys(RESUME)) if (!CHECKPOINT.has(sc)) out.push(`RESUME.${sc} isn't any game's save screen`);
      return out;
    });
    check('Every game has a complete entry (card, icon, rules, screens, save points)', !gaps.length, gaps.join('; '));
    check('Seven games on the homepage, in list order', (await ev(p, () => JSON.stringify([...document.querySelectorAll('#home .game-tile')].map(t => TILE_MODE[t.id])) === JSON.stringify(Object.keys(GAMES)))));
    check('Lists built from the game entries match', await ev(p, () => TEAM_CAPABLE.join() === 'act,taboo,wave' && GAME_OVER.size === 5 && CHECKPOINT.size === 14 && PLAYER_RANGE.imp[0] === 3 && INTROS.spy[0] === 'Word spies'));
    check('No page errors', p.errs.length === 0, p.errs.join(' | '));
    await p.context().close();
  });

  /* ================= ACT IT OUT ================= */
  section('Act it out', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana', 'Ben']);
      await ev(p, () => { S.rounds = 1; S.perTurn = 2; S.easy = 20; S.hard = 30; save(); });
      await open(p, 'act');
      await p.click('#startGame');
      check('Starts on the pass screen with the first player', (await screen(p)) === 'pass' && (await txt(p, '#passName')) === 'Ana');
      await p.click('#startTurn');
      check('Shows an easy/hard card choice', (await screen(p)) === 'pick');
      await p.click('#pickEasy');
      check('Easy card starts a 20s timer', (await screen(p)) === 'act' && (await txt(p, '#actTime')).trim() === '20', await txt(p, '#actTime'));
      // pause
      await p.click('#pauseBtn');
      await p.clock.runFor(60000);
      check('Pause stops the clock (60s later still on the card)', (await screen(p)) === 'act' && await p.locator('#gotBtn').isDisabled());
      await p.click('#pauseBtn');
      await p.click('#gotBtn'); await p.clock.runFor(1000);
      check('Got it → next card', (await screen(p)) === 'pick');
      await p.click('#pickHard');
      check('Hard card has a 30s timer', (await txt(p, '#actTime')).trim() === '30');
      await p.click('#skipBtn'); await p.clock.runFor(1500);
      check('After the last card: turn summary', (await screen(p)) === 'summary', await screen(p));
      check('Summary shows +1 for Ana', (await txt(p, '#sumTitle')).includes('+1'), await txt(p, '#sumTitle'));
      await p.click('#nextTurn');
      check('Phone passes to Ben', (await txt(p, '#passName')) === 'Ben');
      await p.click('#startTurn'); await p.click('#pickHard'); await p.click('#gotBtn'); await p.clock.runFor(1000);
      await p.click('#pickEasy'); await p.clock.runFor(21000); await p.clock.runFor(1500);
      check('Timer running out ends the card', (await screen(p)) === 'summary', await screen(p));
      await p.click('#nextTurn');
      check('Final screen after the last turn', (await screen(p)) === 'final');
      check('Winner is Ben (2 vs 1)', (await txt(p, '#winner')).includes('Ben'), await txt(p, '#winner'));
      const missed = await p.locator('#review span').count();
      check('Missed words listed (2)', missed === 2, missed);
      await noHScroll(p, 'Act it out results');
      await p.click('#playAgain');
      check('Play again resets scores and restarts', (await screen(p)) === 'pass' && (await ev(p, () => G.scores.join(','))) === '0,0');
      // tie
      await ev(p, () => { G.scores = [3, 3]; toFinal(); });
      check('Tie shows "It’s a tie"', (await txt(p, '#winner')).includes('tie'), await txt(p, '#winner'));
      // no packs
      await open(p, 'act');
      await ev(p, () => { S.packs = []; S.custom = ''; renderPacks(); $('custom').value = ''; });
      await p.click('#startGame');
      check('No word packs + no custom words → clear error', (await txt(p, '#setupError')).length > 5 && (await screen(p)) === 'setup', await txt(p, '#setupError'));
      // custom words only
      await ev(p, () => { S.custom = 'banana dance, moonwalk'; $('custom').value = S.custom; });
      await p.click('#startGame');
      check('Custom words alone can start a game', (await screen(p)) === 'pass', await txt(p, '#setupError'));
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'act');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= DESCRIBE IT ================= */
  section('Describe it', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana', 'Ben']);
      await ev(p, () => { S.rounds = 1; S.turnSec = 30; S.level = 3; save(); });
      await open(p, 'taboo');
      await p.click('#startGame'); await p.click('#startTurn');
      check('Shows a word and forbidden words', (await screen(p)) === 'tplay' && await p.locator('#tDont li').count() >= 3);
      await p.click('#tGot'); await p.click('#tGot'); await p.click('#tBuzz'); await p.click('#tSkip');
      check('Buzz penalty on by default: 2 got − 1 buzz, skip free = 1', (await ev(p, () => G.scores[0])) === 1, await ev(p, () => G.scores[0]));
      check('Live score shows the penalty', /Ana: 1 pts/.test(await txt(p, '#tPts')), await txt(p, '#tPts'));
      await p.click('#tPause'); await p.clock.runFor(60000);
      check('Pause holds the timer', (await screen(p)) === 'tplay');
      await p.click('#tPause');
      await p.clock.runFor(31000); await p.clock.runFor(2000);
      check('Timer ends the turn → summary', (await screen(p)) === 'summary', await screen(p));
      check('Summary marks the buzz as −1', (await txt(p, '#sumList')).includes('Buzzed −1'));
      const rows = await p.locator('#sumList li').count();
      check('Summary lists every card (2 got, buzz, skip, time ran out = 5)', rows === 5, rows);
      await p.click('#nextTurn'); await p.click('#startTurn'); await p.click('#tGot');
      await p.clock.runFor(31000); await p.clock.runFor(2000);
      await p.click('#nextTurn');
      check('Final: 1–1 tie', (await screen(p)) === 'final' && /tie/i.test(await txt(p, '#winner')), await txt(p, '#winner'));
      // penalty off + negative turn
      await open(p, 'taboo');
      await p.locator('.setting', { hasText: 'Lose a point for a buzz' }).locator('button').click();
      check('Penalty toggle switches off and is saved', (await ev(p, () => S.tabooPenalty)) === false);
      await p.click('#startGame'); await p.click('#startTurn'); await p.click('#tBuzz'); await p.click('#tSkip');
      check('Penalty off: a buzz costs nothing', (await ev(p, () => G.scores[0])) === 0);
      await open(p, 'taboo');
      await p.locator('.setting', { hasText: 'Lose a point for a buzz' }).locator('button').click();
      await p.click('#startGame'); await p.click('#startTurn'); await p.click('#tBuzz'); await p.click('#tBuzz');
      await p.clock.runFor(31000); await p.clock.runFor(2000);
      check('A turn can go negative and shows as −2', (await txt(p, '#sumTitle')).includes('−2'), await txt(p, '#sumTitle'));
      for (const lv of [1, 2, 3]) {
        const n = await ev(p, l => TABOO[l].length, lv);
        check(`Level ${lv} has a full deck`, n >= 40, `${n} cards`);
      }
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= WORD BOWL ================= */
  section('Word bowl', async AREA => {
    try {
      const p = await fresh(b);
      // co-op with 2 players: auto words, clear all 3 rounds
      await setPlayers(p, ['Ana', 'Ben']);
      await ev(p, () => { S.fbWrite = false; S.fbPer = 3; S.fbSec = 45; save(); });
      await open(p, 'fb');
      check('2 players: setup explains co-op and hides team picker', await p.locator('#fbCoopNote').isVisible() && await p.locator('#teamsBlock').isHidden());
      await p.click('#startGame');
      check('2 players start an every-player-for-themselves game', (await screen(p)) === 'fbround' && (await ev(p, () => G.fbCoop)) === true && /Ana/.test(await txt(p, '#frScores')) && /Ben/.test(await txt(p, '#frScores')), await txt(p, '#frScores'));
      const describers = [];
      // round 1: Ana gets 4 then time runs out; Ben clears the last 2. rounds 2–3: one player clears all 6.
      await p.click('#frGo'); describers.push(await txt(p, '#fpName'));
      check('Pass screen says everyone else guesses', /Everyone else guesses/.test(await txt(p, '#fpTeam')));
      await p.click('#fpGo'); for (let k = 0; k < 4; k++) await p.click('#fbGot');
      await p.clock.runFor(46000); await p.clock.runFor(1500); await p.click('#ftNext');
      describers.push(await txt(p, '#fpName')); await p.click('#fpGo');
      for (let k = 0; k < 2; k++) await p.click('#fbGot'); await p.clock.runFor(1500); await p.click('#ftNext');
      for (let round = 2; round <= 3; round++) {
        await p.click('#frGo'); describers.push(await txt(p, '#fpName'));
        await p.click('#fpGo'); for (let k = 0; k < 6; k++) await p.click('#fbGot');
        await p.clock.runFor(1500); await p.click('#ftNext');
      }
      check('Describer keeps rotating across rounds', describers.join(',') === 'Ana,Ben,Ana,Ben', describers.join(','));
      const ind = await ev(p, () => G.fbInd.join(','));
      check('Each player scores the words they described (Ana 4+6=10, Ben 2+6=8)', ind === '10,8', ind);
      check('Final names the winner and lists scores', /Ana wins/.test(await txt(p, '#ftTitle')) && /10/.test(await txt(p, '#ftScores')), await txt(p, '#ftTitle'));
      check('No par or timer on the final screen', !/par|Cleared/i.test(await txt(p, '#fbturn')));
      await setPlayers(p, ['Ana', 'Ben', 'Cy']);
      await ev(p, () => { S.fbWrite = true; S.fbPer = 2; save(); });
      await open(p, 'fb'); await p.click('#startGame');
      check('3 players also play co-op (word writing first)', (await screen(p)) === 'fbsub' && (await ev(p, () => G.fbCoop)) === true);
      await ev(p, () => { S.players.push('Dee'); S.playerIds.push(null); save(); });
      await open(p, 'fb');
      await p.click('#startGame');
      check('4 players: word-writing screen', (await screen(p)) === 'fbsub');
      check('Teams alternate by seat (Ana+Cy vs Ben+Dee)', (await ev(p, () => JSON.stringify(G.teams))) === '[[0,2],[1,3]]');
      check('Start is locked until everyone adds words', await p.locator('#fbStart').isDisabled());
      await p.locator('#fbNames button').nth(0).click();
      await p.locator('#fbInputs input').nth(0).fill('pizza');
      await p.click('#fbwSave');
      check('Empty word → error, not saved', /Fill in/.test(await txt(p, '#fbwErr')));
      const words = [['pizza', 'kite'], ['moon', 'tiger'], ['robot', 'castle'], ['drum', 'cloud']];
      await p.locator('#fbInputs input').nth(1).fill('kite'); await p.click('#fbwSave');
      for (let i = 1; i < 4; i++) {
        await p.locator('#fbNames button').nth(i).click();
        await p.locator('#fbInputs input').nth(0).fill(words[i][0]);
        await p.locator('#fbInputs input').nth(1).fill(words[i][1]);
        await p.click('#fbwSave');
      }
      check('All words in → Start unlocks, bowl has 8', !(await p.locator('#fbStart').isDisabled()) && /8 words/.test(await txt(p, '#fbsubStatus')));
      await p.click('#fbStart');
      const sameWords = [];
      for (let round = 1; round <= 3; round++) {
        check(`Round ${round} intro`, (await txt(p, '#frNo')).includes(`Round ${round}`));
        await p.click('#frGo'); await p.click('#fpGo');
        const bowl = await ev(p, () => G.bowl.slice().sort().join(','));
        sameWords.push(bowl);
        // skip once, then get all 8
        await p.click('#fbSkip');
        for (let k = 0; k < 8; k++) await p.click('#fbGot');
        await p.clock.runFor(1500);
        check(`Round ${round}: emptying the bowl ends the round`, (await screen(p)) === 'fbturn' && /empty/i.test(await txt(p, '#ftRound')), await txt(p, '#ftRound'));
        await p.click('#ftNext');
      }
      check('All 3 rounds reuse the same 8 words', new Set(sameWords).size === 1 && sameWords[0].split(',').length === 8);
      check('Final screen with a winner', (await screen(p)) === 'fbturn' && /wins|tie/i.test(await txt(p, '#ftTitle')), await txt(p, '#ftTitle'));
      const ts = await ev(p, () => G.teamScores.join(','));
      check('Team scores add up to 24 (8 words × 3 rounds)', ts.split(',').reduce((a, c) => a + +c, 0) === 24, ts);
      // timer + turn passing
      await p.click('#ftNext');
      await p.locator('#fbNames button').nth(0).click(); // just confirm Play again returns to word writing
      check('Play again goes back to writing words', (await screen(p)) === 'fbwrite');
      // auto words + odd team size
      await setPlayers(p, ['A', 'B', 'C', 'D', 'E']);
      await ev(p, () => { S.fbWrite = false; S.fbPer = 3; save(); });
      await open(p, 'fb'); await p.click('#startGame');
      check('Auto-fill mode: bowl gets players × words (15)', (await ev(p, () => G.fbWords.length)) === 15);
      check('5 players → teams of 3 and 2', (await ev(p, () => G.teams.map(t => t.length).join('v'))) === '3v2');
      await p.click('#frGo'); await p.click('#fpGo'); await p.click('#fbGot');
      await p.clock.runFor(46000); await p.clock.runFor(1500);
      check('Turn timer ends the turn and passes to the other team', (await screen(p)) === 'fbturn' && /Pass to/.test(await txt(p, '#ftNext')), await txt(p, '#ftNext'));
      // tie
      await ev(p, () => { G.teamScores = [5, 5]; fbFinal(); });
      check('Tie shows "It’s a tie!"', /tie/i.test(await txt(p, '#ftTitle')));
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'fb');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= PASS THE DOODLE ================= */
  section('Pass the doodle', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana', 'Ben']);
      await ev(p, () => { S.teleBooks = 1; S.teleTimerOn = false; save(); });
      await open(p, 'tele'); await p.click('#startGame');
      check('2 players → blocked with an error', (await screen(p)) === 'setup' && /3/.test(await txt(p, '#setupError')));
      await setPlayers(p, ['Ana', 'Ben', 'Cy']);
      await ev(p, () => { S.teleBooks = 4; save(); });
      await open(p, 'tele'); await p.click('#startGame');
      check('More sketchbooks than players → error', (await screen(p)) === 'setup' && /at most 3/.test(await txt(p, '#setupError')), await txt(p, '#setupError'));
      await ev(p, () => { S.teleBooks = 1; save(); });
      await p.click('#startGame');
      check('Turn order: 3 turns for 3 players', (await ev(p, () => G.seq.length)) === 3);
      await p.click('#tpGo');
      check('First player sees a secret word to draw', (await screen(p)) === 'tdraw' && (await txt(p, '#tdPrompt')).length > 1);
      const box = await p.locator('#pad').boundingBox();
      await p.mouse.move(box.x + 30, box.y + 30); await p.mouse.down(); await p.mouse.move(box.x + 150, box.y + 120, { steps: 8 }); await p.mouse.up();
      await p.click('#undoBtn');
      await p.mouse.move(box.x + 40, box.y + 160); await p.mouse.down(); await p.mouse.move(box.x + 200, box.y + 60, { steps: 8 }); await p.mouse.up();
      await p.click('#tdDone');
      check('Drawing saved → next player guesses', (await screen(p)) === 'tpass' && (await txt(p, '#tpName')) === 'Ben');
      await p.click('#tpGo');
      check('Guesser sees the drawing', (await screen(p)) === 'tguess' && (await p.locator('#tgImg').getAttribute('src')).startsWith('data:image'));
      await p.click('#tgDone');
      check('Empty guess → friendly error', /Type a guess/.test(await txt(p, '#tgErr')));
      await p.fill('#tgInput', 'a dog'); await p.click('#tgDone');
      await p.click('#tpGo');
      check('Third player draws the guess', (await screen(p)) === 'tdraw' && (await txt(p, '#tdPrompt')) === 'a dog');
      check('Swap word only offered on the first drawing', await p.locator('#tdSwap').isHidden());
      await p.click('#tdDone');
      check('Reveal: sketchbook pages', (await screen(p)) === 'treveal');
      await p.click('#trAll');
      const items = await p.locator('#trList .chain-item').count();
      check('Reveal shows all 4 pages (word, drawing, guess, drawing)', items === 4, items);
      // scoring (on by default): Ana started the book; Cy drew after her, Ben guessed
      check('Scoring panel asks the starter for favorites', /Ana, pick your favorites/.test(await txt(p, '#trScore')));
      check('Only other players’ drawings and guesses are offered', (await p.locator('#trScore button').allInnerTexts()).join(',') === 'Cy,Ben', (await p.locator('#trScore button').allInnerTexts()).join(','));
      check('Next is locked until both favorites are picked', await p.locator('#trNext').isDisabled() && (await txt(p, '#trNext')) === 'See scores');
      await p.click('button[aria-label="Favorite drawing: Cy"]');
      check('Still locked with one pick', await p.locator('#trNext').isDisabled());
      await p.click('button[aria-label="Favorite guess: Ben"]');
      await p.click('#trNext');
      check('Final scores screen', (await screen(p)) === 'teleEnd' && /tie/i.test(await txt(p, '#teWinner')), await txt(p, '#teWinner'));
      check('Favorites score 1 each (Cy 1, Ben 1, Ana 0)', (await ev(p, () => G.teleScore.join(','))) === '0,1,1');
      await p.click('#teleAgain');
      check('Play again starts a new game with scores reset', (await screen(p)) === 'tpass' && (await ev(p, () => G.teleScore.join(','))) === '0,0,0');
      // all the way around bonus
      await ev(p, () => { G.books = [{ start: 1, word: 'cat', entries: [{ type: 'word', text: 'cat' }, { type: 'draw', by: 1, img: '' }, { type: 'guess', by: 2, text: 'Cat!' }] }]; G.rb = 0; renderBook(); $('trAll').click(); });
      check('Made it all the way around: starter +1 shown', /all the way around! Ben \+1/.test(await txt(p, '#trScore')));
      check('No drawings by others → only a guess to pick', (await p.locator('#trScore button').count()) === 1);
      await p.click('button[aria-label="Favorite guess: Cy"]'); await p.click('#trNext');
      check('Bonus and favorite counted (Ben 1, Cy 1)', (await ev(p, () => G.teleScore.join(','))) === '0,1,1');
      // scoring off: old behaviour
      await ev(p, () => { S.teleScoring = false; save(); });
      await open(p, 'tele'); await p.click('#startGame');
      await ev(p, () => { G.books = [{ start: 0, word: 'cat', entries: [{ type: 'word', text: 'cat' }, { type: 'draw', by: 0, img: '' }] }]; G.rb = 0; renderBook(); $('trAll').click(); });
      check('Scoring off: no panel and Play again', (await p.locator('#trScore').count()) === 0 && (await txt(p, '#trNext')) === 'Play again');
      await ev(p, () => { S.teleScoring = true; save(); });
      // 2 books, timer on
      await ev(p, () => { S.teleBooks = 2; S.teleTimerOn = true; S.teleSec = 20; save(); });
      await open(p, 'tele'); await p.click('#startGame');
      check('2 sketchbooks × 3 players = 6 turns', (await ev(p, () => G.seq.length)) === 6);
      await p.click('#tpGo');
      await p.clock.runFor(21000);
      check('Drawing timer ends the drawing automatically', (await screen(p)) === 'tpass', await screen(p));
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'tele');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= IN THE RANGE ================= */
  section('In the range', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana']);
      await open(p, 'wave');
      await ev(p, () => { S.players = ['Ana']; S.playerIds = [null]; });
      await p.click('#startGame');
      check('1 player → blocked with an error', (await screen(p)) === 'setup' && /2/.test(await txt(p, '#setupError')));
      await setPlayers(p, ['Ana', 'Ben']);
      await ev(p, () => { S.wRounds = 2; save(); });
      await open(p, 'wave'); await p.click('#startGame');
      check('2 players × 2 rounds = 4 turns', (await ev(p, () => G.wTotal)) === 4);
      const expected = [];
      const offsets = [0, 7, 13, 30];      // → 4, 3, 2, 0 points
      for (let t = 0; t < 4; t++) {
        await p.click('#wpGo');
        const d = await p.locator('#wsDial').boundingBox();
        await p.mouse.move(d.x + d.width / 2, d.y + d.height / 2); await p.mouse.down(); await p.mouse.up();
        await p.clock.runFor(2000);
        check(`Turn ${t + 1}: tapping the dial reveals the target to the cluegiver`, await p.locator('#wsAfter').isVisible());
        await p.fill('#wClue', 'hint' + t); await p.click('#wsDone');
        check(`Turn ${t + 1}: guessers see the clue but not the target`, (await screen(p)) === 'wguess' && (await txt(p, '#wgClue')) === 'hint' + t);
        await p.click('#wgR'); await p.click('#wgL');
        await ev(p, o => { G.needle = G.target <= 50 ? G.target + o : G.target - o; drawGuess(); }, offsets[t]);
        await p.click('#wgDone');
        expected.push([4, 3, 2, 0][t]);
        const got = await ev(p, () => G.wLog.at(-1).pts);
        check(`Turn ${t + 1}: ${offsets[t]} away scores ${expected[t]}`, got === expected[t], `scored ${got}`);
        await p.click('#wrNext');
      }
      check('Final group score = 9 of 16', (await screen(p)) === 'wfinal' && (await txt(p, '#wfScore')) === '9 of 16', await txt(p, '#wfScore'));
      check('Clue log lists all 4 turns', (await p.locator('#wfList li').count()) === 4);
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'wave');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= IMPOSTER ================= */
  section('Imposter', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana', 'Ben']);
      await open(p, 'imp'); await p.click('#startGame');
      check('2 players → blocked with an error', (await screen(p)) === 'setup' && /3/.test(await txt(p, '#setupError')));
      await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee']);
      await ev(p, () => { S.imposters = 2; save(); });
      await open(p, 'imp'); await p.click('#startGame');
      check('4 players with 2 imposters → error (max 1)', /at most 1/.test(await txt(p, '#setupError')), await txt(p, '#setupError'));
      await setPlayers(p, ['Ana', 'Ben', 'Cy']);
      await ev(p, () => { S.imposters = 1; S.impHint = true; S.discOn = true; S.discSec = 30; save(); });
      await open(p, 'imp'); await p.click('#startGame');
      check('Everyone must see their role before clues', await p.locator('#toCluesBtn').isDisabled());
      const roles = [];
      for (let i = 0; i < 3; i++) {
        await p.locator('#nameList button').nth(i).click();
        roles.push([await txt(p, '#roleWord'), await txt(p, '#roleHint')]);
        await p.click('#roleCard');
      }
      const impRoles = roles.filter(r => r[0] === 'Imposter');
      check('Exactly 1 player is told they’re the imposter', impRoles.length === 1, roles.map(r => r[0]).join(','));
      check('The others all see the same secret word', new Set(roles.filter(r => r[0] !== 'Imposter').map(r => r[0])).size === 1);
      check('Imposter gets the category hint when on', /category/i.test(impRoles[0][1]));
      await p.click('#toCluesBtn');
      check('Clue order lists all 3 players', (await p.locator('#order li').count()) === 3);
      await p.click('#discBtn'); await p.clock.runFor(10000);
      await p.click('#discBtn');
      const paused = await txt(p, '#discTime'); await p.clock.runFor(10000);
      check('Discussion timer pauses', (await txt(p, '#discTime')) === paused, paused);
      await p.click('#discBtn'); await p.clock.runFor(25000);
      check('Discussion timer runs out', (await txt(p, '#discTime')) === '0:00');
      await p.click('#toVote');
      const vplus = i => p.locator('#voteList .row').nth(i).locator('button').nth(1).click();
      const vminus = i => p.locator('#voteList .row').nth(i).locator('button').nth(0).click();
      const imp = await ev(p, () => [...G.imps][0]), o1 = (imp + 1) % 3, o2 = (imp + 2) % 3;
      check('Vote screen starts at 0 with Reveal locked', (await txt(p, '#voteCount')).startsWith('0 of 3') && await p.locator('#revealBtn').isDisabled());
      check('− is disabled at 0', await p.locator('#voteList .row').nth(0).locator('button').nth(0).isDisabled());
      await vplus(o1); await vplus(imp);
      check('A 1–1 tie asks the group to pick', await p.locator('#voteTie').isVisible() && await p.locator('#revealBtn').isDisabled(), await txt(p, '#voteTieMsg'));
      await vplus(imp);
      check('Breaking the tie with a vote clears the question', await p.locator('#voteTie').isHidden());
      check('Leader is tagged "Most votes"', (await p.locator('#voteList .row.lead').count()) === 1 && /Most votes/.test(await p.locator('#voteList .row.lead').innerText()));
      check('Counts all votes', /3 of 3 votes counted/.test(await txt(p, '#voteCount')), await txt(p, '#voteCount'));
      await vminus(o1); await vplus(o2); await vplus(o2);
      check('− and + update the leader', (await p.locator('#voteList .row.lead').count()) === 2, await p.locator('#voteList .row.lead').count());
      await p.locator('#voteTieBtns button', { hasText: await ev(p, i => name(i), imp) }).click();
      check('Picking from the tie names who is accused', (await txt(p, '#revealBtn')).includes(await ev(p, i => name(i), imp)), await txt(p, '#revealBtn'));
      await p.click('#revealBtn');
      check('Voting the imposter → "Imposter caught!"', /caught/i.test(await txt(p, '#resTitle')), await txt(p, '#resTitle'));
      check('Caught: secret word stays hidden until the imposter guesses', await p.locator('#resWordWrap').isHidden() && await p.locator('#resGuess').isVisible());
      check('Caught: Play again is held until the guess is answered', await p.locator('#impAgain').isHidden());
      await p.click('#resGuessNo');
      check('"They missed it" → group wins, word revealed', /group wins/i.test(await txt(p, '#resNote')) && await p.locator('#resWordWrap').isVisible() && await p.locator('#impAgain').isVisible(), await txt(p, '#resNote'));
      await p.click('#impAgain');
      await ev(p, () => { for (let i = 0; i < 3; i++) G.seen.add(i); showReveal(); });
      await p.click('#toCluesBtn'); await p.click('#toVote');
      await p.locator('#voteList .row').nth(await ev(p, () => [...G.imps][0])).locator('button').nth(1).click();
      await p.click('#revealBtn'); await p.click('#resGuessYes');
      check('"They guessed it" → imposter wins, word revealed', /guessed the word/i.test(await txt(p, '#resTitle')) && await p.locator('#resWordWrap').isVisible(), await txt(p, '#resTitle'));
      await p.click('#impAgain');
      check('Play again deals a new round', (await screen(p)) === 'reveal' && (await ev(p, () => G.seen.size)) === 0);
      // 5 players, 2 imposters, partial catch
      await setPlayers(p, ['A', 'B', 'C', 'D', 'E']);
      await ev(p, () => { S.imposters = 2; save(); });
      await open(p, 'imp'); await p.click('#startGame');
      check('5 players allow 2 imposters', (await screen(p)) === 'reveal' && (await ev(p, () => G.imps.size)) === 2);
      await ev(p, () => { for (let i = 0; i < 5; i++) G.seen.add(i); showReveal(); });
      await p.click('#toCluesBtn'); await p.click('#toVote');
      const [i1] = await ev(p, () => [...G.imps]);
      const crew = await ev(p, () => [0, 1, 2, 3, 4].find(i => !G.imps.has(i)));
      const vp = i => p.locator('#voteList .row').nth(i).locator('button').nth(1).click();
      await vp(i1); await vp(i1); await vp(crew); await vp(crew);
      check('With 2 imposters, the top 2 are accused', (await ev(p, () => G.votes.size)) === 2 && /and/.test(await txt(p, '#revealBtn')), await txt(p, '#revealBtn'));
      await p.click('#revealBtn', { timeout: 3000 });
      check('Catching 1 of 2 → "Caught 1 of 2"', /1 of 2/.test(await txt(p, '#resTitle')), await txt(p, '#resTitle'));
      check('Not all caught → word shown right away, no guess buttons', await p.locator('#resWordWrap').isVisible() && await p.locator('#resGuess').isHidden());
      // speaking order: non-imposter first
      await ev(p, () => { S.impFirst = false; S.impRandOrder = true; S.imposters = 1; save(); });
      let bad = 0;
      for (let k = 0; k < 40; k++) bad += await ev(p, () => { impRound(); return G.imps.has(G.order[0]) ? 1 : 0; });
      check('"Imposter can go first" off: imposter never speaks first (40 deals)', bad === 0, `${bad} bad`);
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'imp');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= WORD SPIES ================= */
  section('Word spies', async AREA => {
    try {
      const p = await fresh(b);
      // co-op with 2–3 players
      await setPlayers(p, ['Ana', 'Ben']);
      await ev(p, () => { S.spyBig = false; S.spyTrap = true; save(); });
      await open(p, 'spy');
      check('2 players: setup explains co-op and hides team picker', await p.locator('#spyCoopNote').isVisible() && await p.locator('#teamsBlock').isHidden());
      await p.click('#startGame');
      check('2 players start a co-op game', (await screen(p)) === 'spyround' && (await ev(p, () => G.coop)) === true, await txt(p, '#setupError'));
      check('Co-op: one spymaster with Change', (await p.locator('#srSpies .sm-row').count()) === 1 && /Co-op/.test(await txt(p, '#srFirst')));
      const cb = await ev(p, () => { const c = r => G.board.filter(x => x.r === r).length; return [G.spyTurn, c(0), c(1)].join(','); });
      check('Co-op: you are Blue with 6 words, 5 pink clock words', cb === '0,6,5', cb);
      await p.click('#srGo');
      check('Co-op: bar shows Blue and Clock counts', /Clock 5/.test(await txt(p, '#sbCount')), await txt(p, '#sbCount'));
      await p.click('#sbKey');
      check('Co-op key names the single spymaster and explains the clock', /^Spymaster:/.test(await txt(p, '#skWho')) && /clock/.test(await txt(p, '#skTip')));
      await p.click('#skHide');
      await giveClue(p, 1);
      await p.click('#sbEnd');
      check('Co-op: ending a turn keeps Blue and the clock takes a pink word', (await ev(p, () => G.spyTurn)) === 0 && /Clock 4/.test(await txt(p, '#sbCount')) && /clock took/.test(await txt(p, '#sbMsg')), await txt(p, '#sbMsg'));
      await giveClue(p, 1);
      const pk = await ev(p, () => G.board.findIndex(c => c.r === 1 && !c.open));
      await p.locator('#sbGrid button').nth(pk).click(); await p.click('#sbReveal');
      check('Co-op: guessing a pink word ends the turn and the clock also ticks (2 gone)', /Clock 2/.test(await txt(p, '#sbCount')), await txt(p, '#sbCount'));
      for (let k = 0; k < 2 && (await screen(p)) === 'spyboard'; k++) { await giveClue(p, 1); await p.click('#sbEnd'); }
      check('Co-op: clock running out loses', (await screen(p)) === 'spyend' && /clock ran out/i.test(await txt(p, '#seReason')), await txt(p, '#seReason'));
      await p.click('#seAgain'); await p.click('#srGo');
      await giveClue(p, 6);
      for (const i of await ev(p, () => G.board.map((c, i) => [c, i]).filter(([c]) => c.r === 0).map(([, i]) => i))) { await p.locator('#sbGrid button').nth(i).click(); await p.click('#sbReveal'); }
      check('Co-op: finding all blue words wins', (await screen(p)) === 'spyend' && /You win/.test(await txt(p, '#seWin')), await txt(p, '#seWin'));
      await setPlayers(p, ['Ana', 'Ben', 'Cy']);
      await open(p, 'spy'); await p.click('#startGame');
      check('3 players also play co-op', (await ev(p, () => G.coop)) === true);
      await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee', 'Eve']);
      await ev(p, () => { S.spyBig = false; S.spyTrap = true; save(); });
      await open(p, 'spy'); await p.click('#startGame');
      check('5 players → teams of 3 and 2', (await ev(p, () => G.teams.map(t => t.length).join('v'))) === '3v2');
      const small = await ev(p, () => { const c = r => G.board.filter(x => x.r === r).length; return [G.board.length, Math.max(c(0), c(1)), Math.min(c(0), c(1)), c('by'), c('trap')].join(','); });
      check('Small board: 16 cards = 6 + 5 + 4 bystanders + 1 trap', small === '16,6,5,4,1', small);
      const words = await ev(p, () => new Set(G.board.map(c => c.w)).size);
      check('No duplicate words on the board', words === 16);
      await p.click('#srGo');
      await p.click('#sbKey');
      check('Spymaster key shows every card’s color', (await p.locator('#skGrid .spy-card').count()) === 16);
      await p.click('#skHide');
      // clue entry
      check('Cards are locked until the spymaster gives a clue', await ev(p, () => [...document.querySelectorAll('#sbGrid button')].every(b => b.disabled)) && await p.locator('#sbEnd').isHidden());
      await p.click('#sbClueGo');
      check('Blank clue → error', /one-word clue/.test(await txt(p, '#sbClueErr')));
      await p.fill('#sbClueWord', 'two words'); await p.click('#sbClueGo');
      check('Clue with a space → error', /One word only/.test(await txt(p, '#sbClueErr')));
      await p.fill('#sbClueWord', (await ev(p, () => G.board[0].w)).toUpperCase()); await p.click('#sbClueGo');
      check('Clue that is on the board → error (any capitalisation)', /on the board/.test(await txt(p, '#sbClueErr')));
      const leftNow = await ev(p, () => spyLeft(G.spyTurn));
      for (let k = 0; k < 10 && !(await p.locator('#sbNumPlus').isDisabled()); k++) await p.click('#sbNumPlus');
      check('Number can’t go above the team’s words left', (await txt(p, '#sbNum')) === String(leftNow), `${await txt(p, '#sbNum')} vs ${leftNow}`);
      for (let k = 0; k < 10 && !(await p.locator('#sbNumMinus').isDisabled()); k++) await p.click('#sbNumMinus');
      check('…or below 1', (await txt(p, '#sbNum')) === '1');
      await p.fill('#sbClueWord', 'zebrafish'); await p.click('#sbClueGo');
      check('Valid clue shows with guesses left (number + 1)', /ZEBRAFISH · 1/.test(await txt(p, '#sbClueOn')) && /2 guesses left/.test(await txt(p, '#sbClueOn')), await txt(p, '#sbClueOn'));
      const tg = await ev(p, () => G.spyTurn);
      for (let g = 0; g < 2; g++) { const i = await ev(p, () => G.board.findIndex(c => c.r === G.spyTurn && !c.open)); await p.locator('#sbGrid button').nth(i).click(); await p.click('#sbReveal'); }
      check('After number + 1 correct guesses the turn passes', (await ev(p, () => G.spyTurn)) === 1 - tg && await p.locator('#sbClueForm').isVisible());
      // wrong guess passes the turn
      const t0 = await ev(p, () => G.spyTurn);
      await giveClue(p, 1);
      const by = await ev(p, () => G.board.findIndex(c => c.r === 'by'));
      await p.locator('#sbGrid button').nth(by).click(); await p.click('#sbReveal');
      check('Revealing a bystander ends the turn', (await ev(p, () => G.spyTurn)) === 1 - t0);
      await giveClue(p, 1);
      await p.click('#sbEnd');
      check('"End turn" passes back', (await ev(p, () => G.spyTurn)) === t0);
      // team finds all its words
      await giveClue(p, await ev(p, () => spyLeft(G.spyTurn)));
      const mine = await ev(p, () => G.board.map((c, i) => [c.r, i, c.open]).filter(([r, , o]) => r === G.spyTurn && !o).map(([, i]) => i));
      for (const i of mine) { await p.locator('#sbGrid button').nth(i).click(); await p.click('#sbReveal'); }
      check('Finding all your words wins', (await screen(p)) === 'spyend' && (await txt(p, '#seWin')).includes(await ev(p, t => TEAMS[t], t0)), await txt(p, '#seWin'));
      const sm1 = await ev(p, () => G.spymasters.join(','));
      await p.click('#seAgain');
      check('Play again rotates the spymasters', (await ev(p, () => G.spymasters.join(','))) !== sm1, `${sm1} → ${await ev(p, () => G.spymasters.join(','))}`);
      // trap
      await p.click('#srGo'); await giveClue(p, 1);
      const turn = await ev(p, () => G.spyTurn);
      const trap = await ev(p, () => G.board.findIndex(c => c.r === 'trap'));
      await p.locator('#sbGrid button').nth(trap).click(); await p.click('#sbReveal');
      check('Revealing the trap loses immediately', (await screen(p)) === 'spyend' && (await txt(p, '#seWin')).includes(await ev(p, t => TEAMS[1 - t], turn)));
      // big board, no trap
      await ev(p, () => { S.spyBig = true; S.spyTrap = false; save(); });
      await open(p, 'spy'); await p.click('#startGame');
      const big = await ev(p, () => { const c = r => G.board.filter(x => x.r === r).length; return [G.board.length, c('by'), c('trap')].join(','); });
      check('Big board, trap off: 25 cards, 8 bystanders, no trap', big === '25,8,0', big);
      await p.click('#srGo'); await noHScroll(p, 'Word spies big board');
      for (const lv of [1, 2, 3]) {
        const n = await ev(p, l => new Set(spyPool(l)).size, lv);
        check(`Level ${lv} has enough unique words for a big board`, n >= 25, `${n} words`);
      }
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'spy');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= TEAMS ================= */
  section('Teams', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay']);
      await open(p, 'fb');
      check('Teams section shows for Word bowl', await p.locator('#teamsBlock').isVisible());
      check('Default split alternates by seat', (await txt(p, '#teamCount')).includes('Team 1: 3') && (await ev(p, () => JSON.stringify(makeTeams()))) === '[[0,2,4],[1,3,5]]');
      // move Ben, Dee to Blue → Blue 5, Pink 1 → error
      await team(p, '#teamList', 'Ben', 0); await team(p, '#teamList', 'Dee', 0);
      check('Tapping a player moves them to the other team', (await txt(p, '#teamCount')).includes('Team 1: 5 · Team 2: 1'), await txt(p, '#teamCount'));
      await p.click('#startGame');
      check('A 1-player team blocks the start with a clear message', (await screen(p)) === 'setup' && /Team 2 needs at least 2/.test(await txt(p, '#setupError')), await txt(p, '#setupError'));
      await team(p, '#teamList', 'Ana', 1);
      await p.click('#startGame');
      check('Picked teams are used in the game', (await ev(p, () => JSON.stringify(G.teams))) === '[[1,2,3,4],[0,5]]', await ev(p, () => JSON.stringify(G.teams)));
      await p.reload();
      check('Team picks are remembered after reload', (await ev(p, () => JSON.stringify(makeTeams()))) === '[[1,2,3,4],[0,5]]');
      // same picks apply in Word spies
      await open(p, 'spy');
      check('Teams section shows for Word spies with the same picks', await p.locator('#teamsBlock').isVisible() && (await txt(p, '#teamCount')).includes('Team 1: 4'));
      // spymasters are chosen on the New board screen, not in setup
      check('Word spies setup has no spymaster buttons', (await p.locator('.role-btn').count()) === 0);
      await p.click('#startGame');
      const sm0 = await ev(p, () => G.spymasters.slice());
      check('New board shows both spymasters with Change', (await p.locator('#srSpies .sm-row').count()) === 2 && /Change/.test(await txt(p, '#srSpies')));
      await p.click('button[aria-label="Change Team 1 spymaster"]');
      const other = await ev(p, s => G.teams[0].find(i => i !== s[0]), sm0);
      const otherName = await ev(p, i => name(i), other);
      await p.locator('#srSpies .sm-row').nth(0).locator('.pick button', { hasText: otherName }).click();
      check('Change picks a new spymaster', (await ev(p, () => G.spymasters[0])) === other && (await txt(p, '#srSpies')).includes(otherName));
      await p.click('#srGo'); await p.click('#sbKey');
      check('Spymaster key names the chosen spymaster', (await txt(p, '#skWho')).includes(otherName), await txt(p, '#skWho'));
      await ev(p, () => spyEnd(0, 'x')); await p.click('#seAgain');
      const nextExp = await ev(p, o => { const t = G.teams[0]; return t[(t.indexOf(o) + 1) % t.length]; }, other);
      check('Play again rotates on from the chosen spymaster', (await ev(p, () => G.spymasters[0])) === nextExp);
      await open(p, 'act');
      check('Teams section hidden for non-team games', await p.locator('#teamsBlock').isHidden());
      // Shuffle teams button
      await open(p, 'fb');
      check('No Random teams switch in Rules', (await p.locator('#settings .setting', { hasText: 'Random teams' }).count()) === 0);
      const splits = new Set(); let even = true;
      for (let k = 0; k < 15; k++) { await p.click('#teamShuffle'); const t = await ev(p, () => makeTeams()); splits.add(JSON.stringify(t)); if (t[0].length !== 3 || t[1].length !== 3) even = false; }
      check('Shuffle always makes even teams (3 v 3)', even);
      check('Shuffle actually varies', splits.size > 3, `${splits.size} different splits in 15`);
      const shown = await ev(p, () => JSON.stringify(makeTeams()));
      await ev(p, () => { S.fbWrite = false; save(); });
      await p.click('#startGame');
      check('The game uses the shuffled teams you saw', (await ev(p, () => JSON.stringify(G.teams))) === shown);
      await setPlayers(p, ['A', 'B', 'C', 'D', 'E']);
      await open(p, 'spy'); await p.click('#teamShuffle'); await p.click('#startGame');
      check('Random with 5 players → 3 v 2', (await ev(p, () => G.teams.map(t => t.length).sort().join('v'))) === '2v3');
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'teams');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0]); }
  });

  /* ================= PLAYER RANGES ================= */
  section('Player ranges', async AREA => {
    try {
      const p = await fresh(b);
      const want = { goAct:'2–12', goTaboo:'2–12', goFb:'2–12', goTele:'3–12', goWave:'2–12', goImp:'3–12', goSpy:'2–12' };
      for (const [id, r] of Object.entries(want)) check(`${id.slice(2)} tile shows ${r}`, (await txt(p, `#${id} .ppl`)).includes(r));
      for (const [m, r] of [['spy', '2–12'], ['tele', '3–12'], ['act', '2–12']]) { await open(p, m); check(`${m} setup shows ${r}`, (await txt(p, '#playerRange')) === r); }
      await ev(p, () => show('home')); await noHScroll(p, 'home with player chips');
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0]); }
  });

  /* ================= 12 PLAYERS, ESTIMATES, SPY TIMER ================= */
  section('12 players & timing', async AREA => {
    try {
      const p = await fresh(b);
      const twelve = Array.from({ length: 12 }, (_, i) => ['Alexandria', 'Benjamin', 'Christopher', 'Dominique', 'Evangeline', 'Francesca', 'Gabriel', 'Harriet', 'Isabella', 'Jonathan', 'Katherine', 'Leonardo'][i]);
      await setPlayers(p, twelve);
      for (const [g, r] of [['act', '2–12'], ['fb', '2–12'], ['spy', '2–12']]) { await open(p, g); check(`${g} setup shows ${r}`, (await txt(p, '#playerRange')) === r); }
      // every game starts with 12 and has no sideways scrolling on its busiest screen
      await open(p, 'imp'); await p.click('#startGame');
      check('Imposter starts with 12', (await screen(p)) === 'reveal'); await noHScroll(p, 'Imposter role list, 12 players');
      await ev(p, () => { for (let i = 0; i < 12; i++) G.seen.add(i); showReveal(); }); await p.click('#toCluesBtn'); await p.click('#toVote');
      await noHScroll(p, 'Imposter vote, 12 players');
      await open(p, 'fb'); await noHScroll(p, 'Word bowl team picker, 12 players');
      await ev(p, () => { S.fbWrite = false; save(); }); await p.click('#startGame');
      check('Word bowl 12 → 6 v 6', (await ev(p, () => G.teams.map(t => t.length).join('v'))) === '6v6'); await noHScroll(p, 'Word bowl scores, 12 players');
      await open(p, 'tele'); await p.click('#startGame');
      check('Pass the doodle with 12 → 12 turns per book', (await ev(p, () => G.seq.length)) === 12);
      await open(p, 'act'); await ev(p, () => { S.rounds = 1; S.perTurn = 1; save(); }); await p.click('#startGame');
      await ev(p, () => { G.scores = G.scores.map((_, i) => i); toFinal(); }); await noHScroll(p, 'Act it out results, 12 players');
      // estimates
      await setPlayers(p, ['A', 'B', 'C', 'D']);
      await ev(p, () => { S.rounds = 3; S.perTurn = 4; S.easy = 20; S.hard = 30; save(); });
      await open(p, 'act');
      const e4 = await txt(p, '#estText');
      check('Estimate shows a range with the player count', /About \d+–\d+ min with 4 players/.test(e4), e4);
      await p.click('#addPlayer'); await p.click('#addPlayer');
      await p.locator('#players input').nth(4).fill('E'); await p.locator('#players input').nth(5).fill('F');
      const e6 = await txt(p, '#estText');
      check('Estimate updates when players are added', /with 6 players/.test(e6) && e6 !== e4, e6);
      check('No "Make it shorter" suggestion', (await p.locator('#estShorter').count()) === 0);
      await p.locator('.setting', { hasText: 'Rounds' }).locator('button[aria-label="Less"]').click();
      check('Lowering rounds lowers the estimate', (await txt(p, '#estText')) !== e6, await txt(p, '#estText'));
      await open(p, 'taboo');
      check('Describe it shows a single time (fixed timer)', /About \d+ min/.test(await txt(p, '#estText')) && !/–/.test(await txt(p, '#estText')), await txt(p, '#estText'));
      await open(p, 'imp'); check('Imposter estimate is per round', /per round/.test(await txt(p, '#estText')));
      const before = await txt(p, '#estText');
      await p.locator('.setting', { hasText: 'Timer length' }).locator('button[aria-label="More"]').click();
      check('Changing a setting updates the estimate', (await txt(p, '#estText')) !== before);
      // word spies timer
      await open(p, 'spy');
      check('Word spies timer is off by default', (await ev(p, () => S.spyTimerOn)) === false);
      await p.click('#startGame'); await p.click('#srGo');
      check('Timer off: no clock on the board', await p.locator('#sbTime').isHidden());
      await open(p, 'spy');
      await p.locator('.setting', { hasText: 'Turn timer' }).locator('button[role="switch"]').click();
      check('Turning the timer on lengthens nothing for small boards but shows timing', /per board/.test(await txt(p, '#estText')));
      await ev(p, () => { S.spySec = 60; save(); });
      await p.click('#startGame'); await p.click('#srGo');
      check('Timer on: clock shows 1:00', (await txt(p, '#sbTime')) === '1:00');
      const t0 = await ev(p, () => G.spyTurn);
      await p.clock.runFor(30000);
      check('Clock counts down', ['0:30', '0:31'].includes(await txt(p, '#sbTime')), await txt(p, '#sbTime'));
      await p.clock.runFor(31000);
      check('Time running out passes the turn', (await ev(p, () => G.spyTurn)) === 1 - t0 && /Time’s up/.test(await txt(p, '#sbMsg')), await txt(p, '#sbMsg'));
      check('…and restarts the clock for the next team', ['1:00', '0:59'].includes(await txt(p, '#sbTime')), await txt(p, '#sbTime'));
      await giveClue(p, 1);
      await p.clock.runFor(20000);
      await p.click('#sbEnd');
      check('End turn restarts the clock', ['1:00', '0:59'].includes(await txt(p, '#sbTime')), await txt(p, '#sbTime'));
      await giveClue(p, 1);
      await p.clock.runFor(20000);
      const by = await ev(p, () => G.board.findIndex(c => c.r === 'by' && !c.open));
      await p.locator('#sbGrid button').nth(by).click(); await p.click('#sbReveal');
      check('A wrong guess restarts the clock for the other team', ['1:00', '0:59'].includes(await txt(p, '#sbTime')), await txt(p, '#sbTime'));
      await giveClue(p, 1);
      const trap = await ev(p, () => G.board.findIndex(c => c.r === 'trap'));
      await p.locator('#sbGrid button').nth(trap).click(); await p.click('#sbReveal');
      const turnAtEnd = await ev(p, () => G.spyTurn);
      await p.clock.runFor(120000);
      check('Game over stops the clock', (await screen(p)) === 'spyend' && (await ev(p, () => G.spyTurn)) === turnAtEnd);
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'twelve');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0]); }
  });

  /* ================= PLAY AS TEAMS (Act it out, Describe it, In the range) ================= */
  section('Play as teams', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee', 'Eve']);
      await ev(p, () => { S.rounds = 2; S.perTurn = 1; S.teamPick = {}; save(); });
      await open(p, 'act');
      check('Act it out shows Play as, Individuals by default', await p.locator('#playAsBlock').isVisible() && (await p.locator('#paInd').getAttribute('aria-pressed')) === 'true' && await p.locator('#teamsBlock').isHidden());
      await p.click('#paTeam');
      check('Teams shows the team cards and Shuffle', await p.locator('#teamsBlock').isVisible() && await p.locator('#teamShuffle').isVisible());
      await p.click('#startGame');
      check('Turns alternate teams, smaller team takes the extra turn', (await ev(p, () => G.seq.map(name).join(','))) === 'Ana,Ben,Cy,Dee,Eve,Ben', await ev(p, () => G.seq.map(name).join(',')));
      check('Pass screen names the team', /Team 1: you’re acting for your team/.test(await txt(p, '#passNote')));
      check('Scores show team totals', /Team 1/.test(await txt(p, '#passScores')) && /Team 2/.test(await txt(p, '#passScores')));
      let turns = 0;
      while ((await screen(p)) === 'pass' && turns < 20) {
        turns++;
        const team = await ev(p, () => teamOfPlayer(cur()));
        await p.click('#startTurn'); await p.click('#pickEasy');
        await p.click(team === 0 ? '#gotBtn' : '#skipBtn'); await p.clock.runFor(1500); await p.click('#nextTurn');
      }
      check('2 rounds × 6 turns = 12 turns', turns === 12, turns);
      check('Final names the winning team', /Team 1 wins/.test(await txt(p, '#winner')) && /6/.test(await txt(p, '#finalScores')), await txt(p, '#winner'));
      // Describe it teams
      await open(p, 'taboo'); await p.click('#paTeam');
      check('Describe it hint: other team buzzes', /other team watches the screen and taps Buzz/.test(await txt(p, '#playAsHint')));
      await ev(p, () => { S.rounds = 1; S.turnSec = 30; save(); });
      await p.click('#startGame');
      check('Describe it pass screen tells the other team to buzz', /Team 2, watch the screen and tap Buzz/.test(await txt(p, '#passNote')), await txt(p, '#passNote'));
      await p.click('#startTurn'); await p.click('#tGot'); await p.click('#tGot');
      check('Describe it points go to the describer’s team', (await ev(p, () => teamTotals().join(','))) === '2,0');
      await ev(p, () => stopTimer());
      // In the range teams
      await open(p, 'wave'); await p.click('#paTeam'); await ev(p, () => { S.wRounds = 1; save(); });
      await p.click('#startGame');
      check('In the range: teams alternate clue givers', (await ev(p, () => G.wOrder.map(name).join(','))) === 'Ana,Ben,Cy,Dee,Eve,Ben');
      await p.click('#wpGo'); await ev(p, () => wSpin()); await p.clock.runFor(2000);
      check('Cluegiver passes to their team', /pass to your team/.test(await txt(p, '#wsDone')));
      await p.click('#wsDone'); await ev(p, () => { G.needle = G.target; drawGuess(); }); await p.click('#wgDone');
      check('In the range points go to the cluegiver’s team', (await ev(p, () => G.wTeam.join(','))) === '4,0' && /Team 1: 4 · Team 2: 0/.test(await txt(p, '#wrScore')), await txt(p, '#wrScore'));
      // under 4 players
      await setPlayers(p, ['Ana', 'Ben', 'Cy']);
      await open(p, 'act'); await p.click('#paTeam'); await p.click('#startGame');
      check('Teams with 3 players → clear error', /at least 4 players/.test(await txt(p, '#setupError')) && (await screen(p)) === 'setup');
      await p.click('#paInd'); await p.click('#startGame');
      check('Switching back to Individuals plays as before', (await screen(p)) === 'pass' && (await ev(p, () => G.seq.join(','))) === '0,1,2');
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'playas');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0]); }
  });

  /* ================= PLAYER SETUP ================= */
  section('Player setup', async AREA => {
    try {
      const p = await fresh(b);
      await open(p, 'act');
      for (let i = 0; i < 10; i++) await p.click('#addPlayer');
      check('Can add up to 12 players, then Add disappears', (await p.locator('#players input').count()) === 12 && await p.locator('#addPlayer').isHidden());
      check('Added players start blank with a "Player N" hint', (await p.locator('#players input').nth(11).inputValue()) === '' && (await p.locator('#players input').nth(11).getAttribute('placeholder')) === 'Player 12');
      for (let i = 6; i < 12; i++) await p.locator('#players input').nth(i).fill('P' + (i + 1));
      await p.locator('#players input').nth(2).fill('');
      await p.click('#startGame');
      check('Blank name blocks the start', /name/i.test(await txt(p, '#setupError')) && (await screen(p)) === 'setup');
      await p.locator('#players input').nth(2).fill('Bartholomew-Maximilian Jr');
      await p.locator('#players input').nth(3).fill('Ana');
      await p.locator('#players input').nth(4).fill('Ana');
      await p.locator('#players input').nth(5).fill('🎉 Zoë');
      const v = await p.locator('#players input').nth(2).inputValue();
      check('Names are capped at 24 characters', v.length === 24, v);
      await p.locator('#players .player-row').nth(5).locator('.up').click();
      check('↑ moves a player up a seat', (await ev(p, () => S.players[4])) === '🎉 Zoë');
      await p.locator('#players .player-row').nth(11).locator('button[aria-label^="Remove"]').click();
      check('× removes a player', (await p.locator('#players input').count()) === 11);
      await ev(p, () => { S.rounds = 1; S.perTurn = 1; save(); });
      await p.click('#startGame');
      check('Duplicate names and emoji are allowed', (await screen(p)) === 'pass');
      await ev(p, () => { G.scores = G.scores.map((_, i) => i); toFinal(); });
      await noHScroll(p, 'results with a long name');
      await p.reload();
      check('Players are remembered after reload', (await ev(p, () => S.players.length)) === 11 && (await ev(p, () => S.players[2])) === 'Bartholomew-Maximilian J');
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= GAME NIGHT ================= */
  section('Game night', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee']);
      await ev(p, () => show('home'));
      await p.click('#nightStrip button'); await p.click('#nsGo');
      check('Night starts with 4 players', (await ev(p, () => S.night.roster.length)) === 4);
      const night = () => ev(p, () => Object.fromEntries(nightStandings().map(r => [r.name, r.pts])));
      const log = () => ev(p, () => S.night.log.length);
      // act: nobody scores → no points
      await open(p, 'act'); await p.click('#startGame');
      await ev(p, () => { G.scores = [0, 0, 0, 0]; toFinal(); });
      check('Game where nobody scores gives no night points', JSON.stringify(await night()) === '{"Ana":0,"Ben":0,"Cy":0,"Dee":0}');
      // tie for 2nd
      await open(p, 'act'); await p.click('#startGame');
      await ev(p, () => { G.scores = [9, 5, 5, 1]; toFinal(); });
      const n1 = await night();
      check('Act it out 9/5/5/1 → 3/2/2/0 (ties share 2nd)', n1.Ana === 3 && n1.Ben === 2 && n1.Cy === 2 && n1.Dee === 0, JSON.stringify(n1));
      // imposter: got away
      await open(p, 'imp'); await p.click('#startGame');
      await ev(p, () => { G.imps = new Set([3]); G.votes = new Set([0]); $('revealBtn').onclick(); });
      const n2 = await night();
      check('Imposter got away → imposter +2 only', n2.Dee === 2 && n2.Ana === 3, JSON.stringify(n2));
      // imposter: caught but guessed the word
      await ev(p, () => { impRound(); G.imps = new Set([1]); G.votes = new Set([1]); $('revealBtn').onclick(); });
      check('All caught → no night points until the guess is answered', (await night()).Ben === 2 && await p.locator('#nightBox').isHidden());
      await p.click('#resGuessYes');
      check('Imposter guessed it → imposter +2', (await night()).Ben === 4);
      // sit out below minimum
      await open(p, 'imp');
      await p.locator('#players .player-row').nth(3).locator('button[aria-label^="Sit out"]').click();
      await p.locator('#players .player-row').nth(2).locator('button[aria-label^="Sit out"]').click();
      await p.click('#startGame');
      check('Sitting someone out below the minimum shows the error', (await screen(p)) === 'setup' && /3/.test(await txt(p, '#setupError')), await txt(p, '#setupError'));
      await p.locator('#sitOutChips button').nth(0).click(); await p.locator('#sitOutChips button').nth(0).click();
      check('Adding them back works', (await ev(p, () => S.players.length)) === 4);
      // rename mid-night keeps points
      await p.locator('#players input').nth(0).fill('Anna');
      check('Renaming keeps the same person’s points', (await night()).Anna === 3);
      // early exit
      const before = await log();
      await open(p, 'spy'); await p.click('#startGame'); await p.click('#srGo'); await ev(p, () => show('home'));
      check('Leaving a game early adds nothing', (await log()) === before);
      // don't count
      await ev(p, () => { S.teleScoring = false; save(); });
      await open(p, 'tele'); await p.click('#startGame');
      await ev(p, () => { G.books = [{ start: 0, word: 'cat', entries: [{ type: 'word', text: 'cat' }] }]; G.rb = 0; renderBook(); });
      const withTele = await log();
      await p.click('#nightBox >> text=Don’t count this game');
      check('"Don’t count" removes the game', (await log()) === withTele - 1);
      await p.click('#nightBox >> text=Count it after all');
      check('"Count it after all" puts it back', (await log()) === withTele);
      // persistence
      await p.reload();
      check('Night survives a reload', (await ev(p, () => nightOn())) && (await log()) === withTele);
      // end with standings
      await p.click('#nightStrip button');
      await noHScroll(p, 'night standings');
      await p.click('#nightEnd'); await p.click('#nightEnd');
      check('End night crowns a winner', /wins|tie/i.test(await txt(p, '#nightSub')), await txt(p, '#nightSub'));
      // new night with zero games, then end it
      await p.click('#nightEnd'); await p.click('#nsGo');
      check('A new night starts empty', (await log()) === 0);
      await p.click('#nightStrip button'); await p.click('#nightEnd'); await p.click('#nightEnd');
      check('Ending a night with no games is handled', /No games/.test(await txt(p, '#nightSub')), await txt(p, '#nightSub'));
      await open(p, 'act');
      check('Casual mode afterwards has no night controls', await p.locator('#sitOut').isHidden());
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'night');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= UNDO THE LAST GAME'S POINTS ================= */
  section('Remove last game', async AREA => {
    const p = await fresh(b);
    await setPlayers(p, ['Ana', 'Ben', 'Cy']);
    await ev(p, () => show('home')); await p.click('#nightStrip button'); await p.click('#nsGo');
    // two finished games: Ana wins the first, Ben the second
    await open(p, 'act'); await ev(p, () => { S.rounds = 1; S.perTurn = 1; save(); }); await p.click('#startGame');
    await ev(p, () => { G.scores = [3, 1, 0]; toFinal(); });
    await open(p, 'act'); await p.click('#startGame');
    await ev(p, () => { G.scores = [0, 5, 1]; toFinal(); });
    await ev(p, () => openNight());
    const pts = () => ev(p, () => Object.fromEntries(nightStandings().map(r => [r.name, r.pts])));
    const before = await pts();
    check('Only the latest game has a Remove button', (await p.locator('#nightLog .nl-remove').count()) === 1 && (await p.locator('#nightLog li').first().locator('.nl-remove').count()) === 1);
    await p.click('#nightLog .nl-remove');
    check('First tap asks to confirm and removes nothing', /Tap again/.test(await txt(p, '#nightLog .nl-remove')) && (await ev(p, () => S.night.log.length)) === 2);
    await p.click('#nightLog .nl-remove');
    const after = await pts();
    check('Second tap removes that game and its points', (await ev(p, () => S.night.log.length)) === 1 && after.Ana === 3 && after.Ben === 2 && after.Cy === 1 && before.Ben === 5, JSON.stringify([before, after]));   // only game 1 is left: Ana 3, Ben 2, Cy 1
    check('The game before it can now be removed', (await p.locator('#nightLog .nl-remove').count()) === 1);
    check('Removal is saved', await ev(p, () => JSON.parse(localStorage.getItem(KEY)).night.log.length === 1));
    await p.click('#nightLog .nl-remove'); await p.clock.runFor(3500);
    check('An unconfirmed tap resets after a few seconds', (await txt(p, '#nightLog .nl-remove')) === 'Remove' && (await ev(p, () => S.night.log.length)) === 1);
    await p.click('#nightEnd'); await p.click('#nightEnd');
    check('No Remove once the night has ended', (await p.locator('#nightLog .nl-remove').count()) === 0);
    check('No page errors', p.errs.length === 0, p.errs.join(' | '));
    await p.context().close();
  });

  /* ================= TEAMS GAME NIGHT ================= */
  section('Teams game night', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee', 'Eve']);
      await ev(p, () => show('home'));
      await p.click('#nightStrip button'); await p.click('#nsTeam');
      check('Start screen explains points for each mode', /winning team gets the points/.test(await (async () => { await p.click('#nsInd'); const t = await txt(p, '#nsModeHint'); await p.click('#nsTeam'); return t; })()) && /points go to your team/.test(await txt(p, '#nsModeHint')));
      check('Start screen: teams split with count', /Team 1: 3 · Team 2: 2/.test(await txt(p, '#nsTeamCount')));
      await team(p, '#nsStyleBox', 'Ben', 0); await team(p, '#nsStyleBox', 'Dee', 0);
      await p.click('#nsGo');
      check('Teams night needs 2+ per team', /at least 2 players on each team/.test(await txt(p, '#nsError')));
      await team(p, '#nsStyleBox', 'Ben', 1); await team(p, '#nsStyleBox', 'Dee', 1);
      await p.click('#nsShuffle');
      const sh = await ev(p, () => G.nightDraftTeam.filter(t => t === 0).length);
      check('Shuffle keeps teams even (3 v 2)', sh === 3 || sh === 2, sh);
      await ev(p, () => { G.nightDraftTeam = [0, 1, 0, 1, 0]; renderDraft(); });
      await p.click('#nsGo');
      check('Teams night starts with roster teams', (await ev(p, () => S.night.mode)) === 'teams' && (await ev(p, () => S.night.roster.map(r => r.team).join(''))) === '01010');
      check('Strip shows Team 1 vs Team 2', /Team 1 vs Team 2/.test(await txt(p, '#nightStrip')));
      // Act it out forced into teams
      await open(p, 'act');
      check('Act it out is locked to teams tonight', await p.locator('#paInd').isDisabled() && /teams game night/.test(await txt(p, '#playAsHint')));
      await ev(p, () => { S.rounds = 1; S.perTurn = 1; save(); });
      await p.click('#startGame');
      while ((await screen(p)) === 'pass') { const k = await ev(p, () => teamOfPlayer(cur())); await p.click('#startTurn'); await p.click('#pickEasy'); await p.click(k === 0 ? '#gotBtn' : '#skipBtn'); await p.clock.runFor(1500); await p.click('#nextTurn'); }
      check('Team game win = 2 × smaller team size (Blue +4)', (await ev(p, () => S.night.log.at(-1).team.join(','))) === '4,0');
      // Imposter: individual → top N
      await open(p, 'imp'); await p.click('#startGame');
      await ev(p, () => { G.imps = new Set([1]); G.votes = new Set([0]); $('revealBtn').onclick(); });
      check('Individual game: each team’s top 2 count (Ben +2 for Pink)', (await ev(p, () => S.night.log.at(-1).team.join(','))) === '0,2');
      // Pass the doodle: everyone +1, top 2 each
      await open(p, 'tele'); await ev(p, () => { S.teleBooks = 1; S.teleScoring = false; save(); }); await p.click('#startGame');
      await ev(p, () => { G.books = [{ start: 0, word: 'cat', entries: [{ type: 'word', text: 'cat' }] }]; G.rb = 0; renderBook(); });
      check('Bigger team’s 3rd scorer doesn’t count (2 v 2)', (await ev(p, () => S.night.log.at(-1).team.join(','))) === '2,2');
      check('Results box shows team points only', /Team 1 \+2 · Team 2 \+2/.test(await txt(p, '#nightBox')) && !/Ana|didn’t count/.test(await txt(p, '#nightBox')), await txt(p, '#nightBox'));
      // tonight's teams are locked in game setup; newcomers can be placed; a short team unlocks moves
      await open(p, 'wave');
      check('Tonight’s teams are locked in game setup', (await p.locator('#teamList button.tc-chip').count()) === 0 && (await p.locator('#teamList div.tc-chip').count()) === 5 && /set for the night/.test(await txt(p, '#teamsHint')));
      await p.click('#addPlayer');
      const nid = await ev(p, () => S.playerIds.at(-1));
      check('Newcomer joins the smaller team', (await ev(p, id => rosterTeam(id), nid)) === 1);
      check('Only the newcomer can be moved', (await p.locator('#teamList button.tc-chip').count()) === 1);
      await p.click('#teamList button.tc-chip');
      check('Moving the newcomer updates tonight’s teams', (await ev(p, id => rosterTeam(id), nid)) === 0);
      await p.click('#teamList button.tc-chip');
      await p.click('button[aria-label="Sit out Ben"]'); await p.click('button[aria-label="Sit out Dee"]');
      check('A team left short by sit-outs is flagged in red', /needs at least 2/.test(await txt(p, '#teamCount')) && await p.locator('#teamCount.short').count() === 1, await txt(p, '#teamCount'));
      check('…and players can then be moved to fix it', (await p.locator('#teamList button.tc-chip').count()) > 1);
      check('Shuffle is hidden tonight (teams are set for the night)', await p.locator('#teamShuffle').isHidden());
      // leaderboard
      await ev(p, () => show('home'));
      check('Strip shows the leading team', /Team 1 leads 6–4/.test(await txt(p, '#nightStrip')), await txt(p, '#nightStrip'));
      await p.click('#nightStrip button');
      check('Leaderboard shows team cards with totals', (await p.locator('#nightTeams .tcard').count()) === 2 && /Team 1[\s\S]*6/.test(await txt(p, '#nightTeams')) && await p.locator('#nightStand').isHidden());
      check('Team cards list player names without individual points', /Ana, Cy, Eve/.test(await txt(p, '#nightTeams')) && !/didn’t count/.test(await txt(p, '#nightTeams')), await txt(p, '#nightTeams'));
      check('Game log shows team points', /Team 1 \+4/.test(await txt(p, '#nightLog')) && /Team 2 \+2/.test(await txt(p, '#nightLog')));
      await noHScroll(p, 'teams leaderboard');
      await p.click('#nightEnd'); await p.click('#nightEnd');
      check('Ending crowns the winning team', /Team 1 wins game night/.test(await txt(p, '#nightSub')));
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'teamsnight');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0]); }
  });

  /* ================= TEAM NAMES & COLORS ================= */
  section('Team names & colors', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee']);
      await ev(p, () => { save(); });
      await open(p, 'spy');
      check('Team games show the team cards', (await p.locator('#teamList .tc-col').count()) === 2);
      check('Palette is closed until a dot is tapped', (await p.locator('#teamList .tc-pal').count()) === 0);
      await p.locator('#teamList .tc-name').nth(0).fill('Giraffes');
      await p.click('#teamList .tc-col.t0 .tc-dot');
      check('Tapping a team dot opens the 36-color grid', (await p.locator('#teamList .tc-pal button').count()) === 36 && (await p.locator('#teamList .tc-pal input').count()) === 0);
      await p.click('button[aria-label="Team 1 color: Green"]');
      check('Picking a color closes the palette', (await p.locator('#teamList .tc-pal').count()) === 0);
      await p.click('#teamList .tc-col.t0 .tc-dot');
      check('The grid opens right under the tapped dot', await ev(p, () => { const d = document.querySelector('#teamList .tc-col.t0 .tc-dot').getBoundingClientRect(), g = document.querySelector('#teamList .tc-pal').getBoundingClientRect(); return g.top > d.bottom && g.top - d.bottom < 20 && g.left <= d.left; }));
      await p.click('#teamsHint');
      check('Tapping elsewhere closes the grid', (await p.locator('#teamList .tc-pal').count()) === 0);
      await p.click('#teamList .tc-col.t1 .tc-dot');
      check('Team 2 can’t pick team 1’s color', await p.locator('button[aria-label="Team 2 color: Green"]').isDisabled());
      check('Colors close to the other team are faded too, not just the same one', await p.locator('button[aria-label="Team 2 color: Light green"]').isDisabled() && await p.locator('button[aria-label="Team 2 color: Deep green"]').isDisabled());
      await p.click('button[aria-label="Team 2 color: Light gold"]');
      check('A grid color is saved for the team', (await ev(p, () => G.teamStyle[1].color)) === '#E0BE3A');
      check('Light colors get shades dark enough to read', await ev(p, () => COLOR_GRID.every(([h]) => { const c = teamPalette(h); return contrastOf(hexRgb(c.text), hexRgb(c.tint)) >= 4.5 && contrastOf(hexRgb(c.edge), [255,255,255]) >= 3 && contrastOf(hexRgb(c.dtext), [32,29,60]) >= 4.5; })));
      check('Names flow into the picker and count', /Giraffes: 2 · Team 2: 2/.test(await txt(p, '#teamCount')) && (await p.locator('#teamList button[aria-label$="to Giraffes"]').count()) === 2);
      await p.click('#startGame'); await p.click('#srGo'); await ev(p, () => { G.spyTurn = 0; renderSpy(); });
      check('Word spies uses the team name with correct grammar', /Giraffes’ turn/.test(await txt(p, '#sbTurn')) && /Giraffes: \d+ ·/.test(await txt(p, '#sbCount')), await txt(p, '#sbTurn'));
      check('Team color applies to the board', (await ev(p, () => getComputedStyle($('sbTurn')).backgroundColor)) === 'rgb(198, 240, 216)');
      await ev(p, () => spyEnd(0, 'x'));
      check('Plural custom name: "Giraffes win!"', /Giraffes win!/.test(await txt(p, '#seWin')), await txt(p, '#seWin'));
      await open(p, 'act');
      check('Not shown for individual play', await p.locator('#teamsBlock').isHidden());
      await p.reload();
      await open(p, 'spy');
      check('Casual names and colors reset when the app reopens', /Team 1: 2 · Team 2: 2/.test(await txt(p, '#teamCount')));
      // game night
      await ev(p, () => show('home')); await p.click('#nightStrip button'); await p.click('#nsTeam');
      await p.locator('#nsStyleBox .tc-name').nth(1).fill('Owls'); await p.click('#nsStyleBox .tc-col.t1 .tc-dot'); await p.click('#nsStyleBox button[aria-label="Team 2 color: Orange"]');
      await p.click('#nsGo');
      check('Night keeps its team names', /Team 1: 2 · Owls: 2/.test(await (async () => { await open(p, 'act'); return txt(p, '#teamCount'); })()));
      check('Night names & colors are locked in game setup', (await p.locator('#teamList input.tc-name').count()) === 0 && (await p.locator('#teamList button.tc-dot').count()) === 0 && /Owls/.test(await txt(p, '#teamList')));
      await ev(p, () => show('home'));
      await p.click('#nightStrip button'); await p.click('#nightEnd'); await p.click('#nightEnd');
      await p.click('#nightEnd'); await p.click('#nsTeam');
      check('A new game night starts with default names', /Team 1: 2 · Team 2: 2/.test(await txt(p, '#nsTeamCount')));
      await noHScroll(p, 'night start with team editor');
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'teamstyle');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= SAVE A GAME IN PROGRESS ================= */
  section('Save & resume', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana', 'Ben', 'Cy']);
      // Act it out: reload between turns, continue
      await open(p, 'act'); await ev(p, () => { S.rounds = 2; S.perTurn = 1; save(); }); await p.click('#startGame');
      await p.click('#startTurn'); await p.click('#pickEasy'); await p.click('#gotBtn'); await p.clock.runFor(1500);
      const before = await ev(p, () => JSON.stringify([G.scores, G.turn, G.round, G.deck.length]));
      await p.reload();
      check('Reopening shows the game to continue', await p.locator('#resumeBox').isVisible() && /Act it out in progress/.test(await txt(p, '#resumeBox')), await txt(p, '#resumeBox'));
      await p.click('#resumeGo');
      check('Continue picks up after the finished turn', (await screen(p)) === 'pass' && (await ev(p, () => G.turn)) === 1 && /Ben/.test(await txt(p, '#passName')), await txt(p, '#passName'));
      check('Scores and deck come back intact', (await ev(p, () => JSON.stringify([G.scores, G.round, G.deck.length]))) === JSON.stringify([JSON.parse(before)[0], 1, JSON.parse(before)[3]]));
      // a turn cut off mid-way starts over
      await p.click('#startTurn'); await p.click('#pickEasy'); await p.click('#gotBtn');
      await p.reload(); await p.click('#resumeGo');
      check('A turn cut off mid-way starts over', (await screen(p)) === 'pass' && /Ben/.test(await txt(p, '#passName')) && (await ev(p, () => G.scores[1])) === 0);
      // Start over clears it
      await p.click('#startOver'); await p.click('#startOver');
      await p.reload();
      check('Ending the game clears the save', await p.locator('#resumeBox').isHidden());
      // Discard
      await open(p, 'act'); await p.click('#startGame'); await p.reload();
      await p.click('#resumeX');
      check('Discard removes the offer', await p.locator('#resumeBox').isHidden() && (await ev(p, () => localStorage.getItem(GAME_KEY))) === null);
      // Word spies: board progress saved when the phone locks
      await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee']);
      await open(p, 'spy'); await p.click('#startGame'); await p.click('#srGo');
      await ev(p, () => { G.spyTurn = 0; renderSpy(); });
      await giveClue(p, 2);
      const mine = await ev(p, () => G.board.findIndex(c => c.r === 0 && !c.open));
      await p.locator('#sbGrid button').nth(mine).click(); await p.click('#sbReveal');
      await ev(p, () => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
      const board = await ev(p, () => JSON.stringify(G.board));
      await p.reload(); await p.click('#resumeGo');
      check('Word spies: same board, opened cards and clue after reopening', (await screen(p)) === 'spyboard' && (await ev(p, () => JSON.stringify(G.board))) === board && /ZEBRAFISH/.test(await txt(p, '#sbClueOn')), await txt(p, '#sbClueOn'));
      // Imposter: vote tally kept
      await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee']);
      await open(p, 'imp'); await p.click('#startGame');
      await ev(p, () => { for (let i = 0; i < 4; i++) G.seen.add(i); showReveal(); }); await p.click('#toCluesBtn'); await p.click('#toVote');
      await ev(p, () => { G.tally[2] = 3; renderVote(); gameSnap(); });
      await p.reload(); await p.click('#resumeGo');
      check('Imposter: votes come back', (await screen(p)) === 'vote' && (await ev(p, () => G.tally[2])) === 3 && (await ev(p, () => G.seen instanceof Set && G.seen.size)) === 4);
      // game night: once points are recorded the game can't be resumed (no double counting)
      await ev(p, () => show('home')); await p.click('#nightStrip button'); await p.click('#nsGo');
      await setPlayers(p, ['Ana', 'Ben', 'Cy']);
      await ev(p, () => { S.playerIds = [1, 2, 3]; save(); });
      await open(p, 'act'); await ev(p, () => { S.rounds = 1; S.perTurn = 1; save(); }); await p.click('#startGame');
      await ev(p, () => { G.scores = [3, 1, 0]; toFinal(); });
      await p.reload();
      check('A finished, counted game is not offered again', await p.locator('#resumeBox').isHidden() && (await ev(p, () => S.night.log.length)) === 1);
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'resume');
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= WORD HISTORY (fewer repeats) ================= */
  section('Word history', async AREA => {
    try {
      const p = await fresh(b);
      await setPlayers(p, ['Ana', 'Ben', 'Cy']);
      // Describe it: the words shown in one game don't come first in the next one, even after reopening the app
      await open(p, 'taboo'); await p.click('#startGame'); await p.click('#startTurn');
      for (let i = 0; i < 4; i++) await p.click('#tGot');
      const shown = await ev(p, () => Object.keys(seenAll().taboo || {}));
      check('Words shown on screen are remembered', shown.length >= 5, shown.length + ' remembered');
      await p.reload();
      await open(p, 'taboo'); await p.click('#startGame');
      const next = await ev(p, () => G.deck.slice(-40).map(wordKey));
      check('After reopening, a new game starts with words not played yet', next.every(w => !shown.includes(w)), next.filter(w => shown.includes(w)).join(','));
      // a small list cycles back oldest-first instead of running out
      const order = await ev(p, () => {
        G.mode = 'test'; const pool = ['a','b','c','d'].map(w => [w]);
        markSeen([['c']]); const t = Date.now(); SEEN.test.c = t - 3000; SEEN.test.a = t - 2000; SEEN.test.d = t - 1000;   // b never played
        return freshOrder(pool).map(x => x[0]).join('');
      });
      check('Unplayed words first, then the oldest played', order === 'bcad', order);
      check('Each game keeps its own history', await ev(p, () => !(seenAll().act) && !!seenAll().taboo));
      check('History older than a year is forgotten', await ev(p, () => { SEEN.test.old = Date.now() - 400 * 864e5; markSeen([['x']], 'test'); return !('old' in SEEN.test); }));
      // Word spies: the next board avoids the last board's words
      await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee']);
      await open(p, 'spy'); await p.click('#startGame');
      const b1 = await ev(p, () => G.board.map(c => c.w));
      await ev(p, () => spyDeal());
      const b2 = await ev(p, () => G.board.map(c => c.w));
      check('Word spies: a new board uses fresh words', b2.every(w => !b1.includes(w)), b2.filter(w => b1.includes(w)).join(','));
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }
  });

  /* ================= WORD HISTORY (fewer repeats) ================= */
  AREA = 'Word history';
  try {
    const p = await fresh(b);
    await setPlayers(p, ['Ana', 'Ben', 'Cy']);
    // Describe it: the words shown in one game don't come first in the next one, even after reopening the app
    await open(p, 'taboo'); await p.click('#startGame'); await p.click('#startTurn');
    for (let i = 0; i < 4; i++) await p.click('#tGot');
    const shown = await ev(p, () => Object.keys(seenAll().taboo || {}));
    check('Words shown on screen are remembered', shown.length >= 5, shown.length + ' remembered');
    await p.reload();
    await open(p, 'taboo'); await p.click('#startGame');
    const next = await ev(p, () => G.deck.slice(-40).map(wordKey));
    check('After reopening, a new game starts with words not played yet', next.every(w => !shown.includes(w)), next.filter(w => shown.includes(w)).join(','));
    // a small list cycles back oldest-first instead of running out
    const order = await ev(p, () => {
      G.mode = 'test'; const pool = ['a','b','c','d'].map(w => [w]);
      markSeen([['c']]); const t = Date.now(); SEEN.test.c = t - 3000; SEEN.test.a = t - 2000; SEEN.test.d = t - 1000;   // b never played
      return freshOrder(pool).map(x => x[0]).join('');
    });
    check('Unplayed words first, then the oldest played', order === 'bcad', order);
    check('Each game keeps its own history', await ev(p, () => !(seenAll().act) && !!seenAll().taboo));
    check('History older than a year is forgotten', await ev(p, () => { SEEN.test.old = Date.now() - 400 * 864e5; markSeen([['x']], 'test'); return !('old' in SEEN.test); }));
    // Word spies: the next board avoids the last board's words
    await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee']);
    await open(p, 'spy'); await p.click('#startGame');
    const b1 = await ev(p, () => G.board.map(c => c.w));
    await ev(p, () => spyDeal());
    const b2 = await ev(p, () => G.board.map(c => c.w));
    check('Word spies: a new board uses fresh words', b2.every(w => !b1.includes(w)), b2.filter(w => b1.includes(w)).join(','));
    check('No page errors', p.errs.length === 0, p.errs.join(' | '));
    await p.context().close();
  } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0] + ' @ line ' + (((e.stack||'').match(/suite\.js:(\d+)/)||[])[1])); }

  /* ================= WORD FILES ================= */
  section('Word files', async AREA => {
    try {
      const p = await fresh(b);
      check('All six word files load', await ev(p, () => ['act','describe','doodle','range','imposter','spies'].every(k => window.GN_WORDS && GN_WORDS[k])));
      check('Games read their words from the files', await ev(p, () => PACKS === GN_WORDS.act && TABOO === GN_WORDS.describe && IMP_WORDS === GN_WORDS.imposter && TELE_WORDS === GN_WORDS.doodle && WAVE === GN_WORDS.range && SPY_L3 === GN_WORDS.spies));
      check('Word counts are intact', await ev(p, () => Object.values(PACKS).flat().length + Object.values(TABOO).flat().length + Object.values(TELE_WORDS).flat().length + Object.values(WAVE).flat().length + Object.values(IMP_WORDS).flat().length + SPY_L3.length) >= 1757);
      check('Every pack and level has words', await ev(p, () => [...Object.values(PACKS), ...Object.values(TABOO), ...Object.values(TELE_WORDS), ...Object.values(WAVE), ...Object.values(IMP_WORDS)].every(a => a.length > 0)));
      const sw = require('fs').readFileSync(require('path').join(ROOT, 'sw.js'), 'utf8');
      check('The offline helper saves every word file', ['act','describe','doodle','range','imposter','spies'].every(k => sw.includes('"' + k + '"')) && /words/.test(sw));
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      await p.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0]); }
  });

  /* ================= HOME ICON MOTION ================= */
  section('Home icons', async AREA => {
    try {
      const p = await fresh(b);
      const moving = () => ev(p, () => [...document.querySelectorAll('#home .tile-icon.ic-go')].map(e => e.dataset.icon));
      await ev(p, () => { const t = document.querySelector('#goSpy'); scrollTo(0, t.getBoundingClientRect().top + scrollY - innerHeight / 2 + 40); });
      await p.waitForTimeout(150);
      const m = await moving();
      check('The card in the middle of the screen animates its icon', m.includes('spy'), m.join(','));
      check('Only the drawing moves (Word spies squares pop), not the white tile', await ev(p, () => { const el = document.querySelector('#home .tile-icon.ic-go[data-icon="spy"]'); return getComputedStyle(el).animationName === 'none' && [...el.querySelectorAll('.p-sq')].every(q => getComputedStyle(q).animationName === 'ic-sq'); }));
      check('The white tile doesn’t shift while its drawing animates', await ev(p, () => { const i = document.querySelector('#goSpy .tile-icon'), t = document.getElementById('goSpy'); const d = i.getBoundingClientRect().top - t.getBoundingClientRect().top; i.classList.remove('ic-go'); const d0 = i.getBoundingClientRect().top - t.getBoundingClientRect().top; i.classList.add('ic-go'); return Math.abs(d - d0) < .5; }));
      check('Squares pop in a random order', await ev(p, () => new Set([...document.querySelectorAll('#home .tile-icon[data-icon="spy"] .p-sq')].map(q => q.style.getPropertyValue('--d'))).size > 3));
      check('Every icon has its moving part', await ev(p, () => ['act .p-fig','taboo .p-bubble','imp .p-eyes','tele .p-pencil','wave .p-needle','fb .p-cards','spy .p-sq'].every(x => { const [k, c] = x.split(' '); return document.querySelector(`#home .tile-icon[data-icon="${k}"] ${c}`); })));
      check('Cards near the top or bottom don’t', !m.includes('act'), m.join(','));
      await p.click('#goWave'); await p.waitForTimeout(100);
      check('Opening a game plays its icon once at the top of the setup screen', await ev(p, () => document.getElementById('setupIcon').classList.contains('ic-go') && getComputedStyle(document.querySelector('#setupIcon .p-needle')).animationName === 'ic-swipe'));
      await p.clock.runFor(1600);
      check('…and then it stops', await ev(p, () => !document.getElementById('setupIcon').classList.contains('ic-go')));
      const o = await fresh(b); await o.clock.runFor(600);
      check('The trophy shines and pops when the app opens', await ev(o, () => { const t = document.querySelector('#nightStrip .trophy'); return t.classList.contains('tr-go') && getComputedStyle(t, '::after').animationName === 'tr-sweep'; }));
      check('The shine uses the trophy’s own shape (no sparkles)', await ev(o, () => { const t = document.querySelector('#nightStrip .trophy'); return t.dataset.e === '🏆' && getComputedStyle(t, '::before').content === 'none'; }));
      await o.context().close();
      await ev(p, () => show('home'));
      await ev(p, () => scrollTo(0, 800)); await p.waitForTimeout(80);
      check('Trophy is still while scrolled down', await ev(p, () => !document.querySelector('#nightStrip .trophy').classList.contains('tr-go')));
      await ev(p, () => scrollTo(0, 0)); await p.waitForTimeout(80);
      check('Back at the very top, the game night trophy shines and pops', await ev(p, () => { const t = document.querySelector('#nightStrip .trophy'); return t.classList.contains('tr-go') && getComputedStyle(t).animationName.includes('tr-pop'); }));
      const tall = await (await b.newContext({ viewport: { width: 412, height: 915 } })).newPage();
      await tall.goto(URL); await tall.waitForTimeout(300);
      await tall.evaluate(() => scrollTo(0, document.body.scrollHeight)); await tall.waitForTimeout(200);
      check('Scrolled to the bottom on a tall phone, Word spies reaches the middle and animates', await tall.evaluate(() => document.querySelector('#goSpy .tile-icon').classList.contains('ic-go')));
      await tall.context().close();
      const r = await fresh(b, {}); await r.emulateMedia({ reducedMotion: 'reduce' });
      await ev(r, () => { const t = document.querySelector('#goAct'); scrollTo(0, t.getBoundingClientRect().top + scrollY - innerHeight / 2 + 40); });
      await r.waitForTimeout(150);
      check('No animation with Reduce motion on', await ev(r, () => [...document.querySelectorAll('#home .tile-icon, #home .tile-icon *')].every(e => getComputedStyle(e).animationName === 'none')));
      check('No page errors', p.errs.length === 0 && r.errs.length === 0, [...p.errs, ...r.errs].join(' | '));
      await p.context().close(); await r.context().close();
    } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0]); }
  });

  /* ================= LAYOUT: small phone, dark mode ================= */
  section('Layout', async AREA => {
    for (const dark of [false, true]) {
      const p = await fresh(b, { dark });
      const mode = dark ? 'dark' : 'light';
      await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee']);
      await ev(p, () => show('home'));
      await noHScroll(p, `home (${mode})`);
      for (const g of ['act', 'taboo', 'fb', 'tele', 'wave', 'imp', 'spy']) { await open(p, g); await noHScroll(p, `${g} setup (${mode})`); }
      const bg = await ev(p, () => getComputedStyle(document.body).backgroundColor);
      check(`Page background follows ${mode} mode`, dark ? bg !== 'rgb(244, 241, 255)' : bg === 'rgb(244, 241, 255)', bg);
      await p.screenshot({ path: `${OUT}/layout-${mode}.png` });
      check('No page errors', p.errs.length === 0, p.errs.join(' | '));
      await p.context().close();
    }
  });

  // Run the sections a few at a time, each in its own browser windows (they share one browser and server).
  const WORKERS = Math.max(1, Math.min(+process.env.TEST_WORKERS || require('os').cpus().length, 6));
  const queue = SECTIONS.slice();
  const t0 = Date.now();
  await Promise.all([...Array(WORKERS)].map(async () => {
    while (queue.length) {
      const [area, fn] = queue.shift();
      await areaOf.run(area, async () => {
        try { await fn(area); }
        catch (e) { check('Section ran to completion', false, (e.message || e).split('\n')[0] + ' @ line ' + (((e.stack || '').match(/suite\.js:(\d+)/) || [])[1])); }
      });
    }
  }));

  await b.close();
  if (srv) srv.close();
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
  const fails = results.filter(r => !r.ok);
  const areas = SECTIONS.map(([a]) => a);
  for (const a of areas) {
    const rs = results.filter(r => r.area === a);
    console.log(`\n## ${a}: ${rs.filter(r => r.ok).length}/${rs.length}`);
    rs.filter(r => !r.ok).forEach(r => console.log(`  FAIL ${r.name} — ${r.detail}`));
  }
  console.log(`\nTOTAL ${results.length - fails.length}/${results.length} passed in ${Math.round((Date.now() - t0) / 1000)}s (${WORKERS} at a time)`);
  process.exitCode = fails.length ? 1 : 0;
})().catch(e => { console.error('SUITE CRASHED', e); process.exit(1); });
