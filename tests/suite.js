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
let AREA = '';
const check = (name, ok, detail = '') => { results.push({ area: AREA, name, ok: !!ok, detail: String(detail) }); };

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

  /* ================= ACT IT OUT ================= */
  AREA = 'Act it out';
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
    check('Missed words listed to talk through (2)', missed === 2, missed);
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

  /* ================= DESCRIBE IT ================= */
  AREA = 'Describe it';
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

  /* ================= WORD BOWL ================= */
  AREA = 'Word bowl';
  try {
    const p = await fresh(b);
    await setPlayers(p, ['Ana', 'Ben', 'Cy']);
    await ev(p, () => { S.fbWrite = true; S.fbPer = 2; S.fbSec = 45; save(); });
    await open(p, 'fb'); await p.click('#startGame');
    check('3 players → blocked with an error', (await screen(p)) === 'setup' && /4/.test(await txt(p, '#setupError')), await txt(p, '#setupError'));
    await ev(p, () => { S.players.push('Dee'); S.playerIds.push(null); renderPlayers(); });
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

  /* ================= PASS THE DOODLE ================= */
  AREA = 'Pass the doodle';
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
    check('Last button offers Play again', (await txt(p, '#trNext')) === 'Play again');
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

  /* ================= IN THE RANGE ================= */
  AREA = 'In the range';
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

  /* ================= IMPOSTER ================= */
  AREA = 'Imposter';
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

  /* ================= WORD SPIES ================= */
  AREA = 'Word spies';
  try {
    const p = await fresh(b);
    await setPlayers(p, ['A', 'B', 'C']);
    await open(p, 'spy'); await p.click('#startGame');
    check('3 players → blocked with an error', (await screen(p)) === 'setup' && /4/.test(await txt(p, '#setupError')));
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

  /* ================= TEAMS ================= */
  AREA = 'Teams';
  try {
    const p = await fresh(b);
    await setPlayers(p, ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay']);
    await open(p, 'fb');
    check('Teams section shows for Word bowl (Random teams off by default)', await p.locator('#teamsBlock').isVisible() && (await ev(p, () => S.randomTeams)) === false);
    check('Default split alternates by seat', (await txt(p, '#teamCount')).includes('Blue: 3') && (await ev(p, () => JSON.stringify(makeTeams()))) === '[[0,2,4],[1,3,5]]');
    // move Ben, Dee to Blue → Blue 5, Pink 1 → error
    await p.click('button[aria-label="Ben on Team Blue"]'); await p.click('button[aria-label="Dee on Team Blue"]');
    check('Tapping Blue/Pink moves players', (await txt(p, '#teamCount')).includes('Blue: 5 · Team Pink: 1'), await txt(p, '#teamCount'));
    await p.click('#startGame');
    check('A 1-player team blocks the start with a clear message', (await screen(p)) === 'setup' && /Team Pink needs at least 2/.test(await txt(p, '#setupError')), await txt(p, '#setupError'));
    await p.click('button[aria-label="Ana on Team Pink"]');
    await p.click('#startGame');
    check('Picked teams are used in the game', (await ev(p, () => JSON.stringify(G.teams))) === '[[1,2,3,4],[0,5]]', await ev(p, () => JSON.stringify(G.teams)));
    await p.reload();
    check('Team picks are remembered after reload', (await ev(p, () => JSON.stringify(makeTeams()))) === '[[1,2,3,4],[0,5]]');
    // same picks apply in Word spies
    await open(p, 'spy');
    check('Teams section shows for Word spies with the same picks', await p.locator('#teamsBlock').isVisible() && (await txt(p, '#teamCount')).includes('Blue: 4'));
    // spymasters are chosen on the New board screen, not in setup
    check('Word spies setup has no spymaster buttons', (await p.locator('.role-btn').count()) === 0);
    await p.click('#startGame');
    const sm0 = await ev(p, () => G.spymasters.slice());
    check('New board shows both spymasters with Change', (await p.locator('#srSpies .sm-row').count()) === 2 && /Change/.test(await txt(p, '#srSpies')));
    await p.click('button[aria-label="Change Team Blue spymaster"]');
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
    // random teams
    await open(p, 'fb');
    await p.locator('.setting', { hasText: 'Random teams' }).locator('button').click();
    check('Random teams on hides the picker', await p.locator('#teamsBlock').isHidden() && (await ev(p, () => S.randomTeams)) === true);
    const splits = new Set(); let even = true;
    for (let k = 0; k < 15; k++) { const t = await ev(p, () => makeTeams()); splits.add(JSON.stringify(t)); if (t[0].length !== 3 || t[1].length !== 3) even = false; }
    check('Random teams are always even (3 v 3)', even);
    check('Random teams actually vary', splits.size > 3, `${splits.size} different splits in 15`);
    await ev(p, () => { S.fbWrite = false; save(); });
    await p.click('#startGame');
    const g1 = await ev(p, () => JSON.stringify(G.teams));
    check('Random Word bowl starts with even teams', JSON.parse(g1).every(t => t.length === 3), g1);
    await setPlayers(p, ['A', 'B', 'C', 'D', 'E']);
    await open(p, 'spy'); await p.click('#startGame');
    await setPlayers(p, ['A', 'B', 'C', 'D', 'E']);
    await ev(p, () => { S.randomTeams = true; save(); });
    await open(p, 'spy'); await p.click('#startGame');
    const sms = new Set(); for (let k = 0; k < 12; k++) { await ev(p, () => spyStart()); sms.add(await ev(p, () => G.spymasters.join(','))); }
    check('Random teams: spymasters are picked at random', sms.size > 2, `${sms.size} different picks`);
    check('Random with 5 players → 3 v 2', (await ev(p, () => G.teams.map(t => t.length).sort().join('v'))) === '2v3');
    check('No page errors', p.errs.length === 0, p.errs.join(' | '));
    if (results.some(r => r.area === AREA && !r.ok)) await shotFail(p, 'teams');
    await p.context().close();
  } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0]); }

  /* ================= PLAYER RANGES ================= */
  AREA = 'Player ranges';
  try {
    const p = await fresh(b);
    const want = { goAct:'2–12', goTaboo:'2–12', goFb:'4–12', goTele:'3–12', goWave:'2–12', goImp:'3–12', goSpy:'4–12' };
    for (const [id, r] of Object.entries(want)) check(`${id.slice(2)} tile shows ${r}`, (await txt(p, `#${id} .ppl`)).includes(r));
    for (const [m, r] of [['spy', '4–12'], ['tele', '3–12'], ['act', '2–12']]) { await open(p, m); check(`${m} setup shows ${r}`, (await txt(p, '#playerRange')) === r); }
    await ev(p, () => show('home')); await noHScroll(p, 'home with player chips');
    check('No page errors', p.errs.length === 0, p.errs.join(' | '));
    await p.context().close();
  } catch (e) { check('Section ran to completion', false, (e.message||e).split('\n')[0]); }

  /* ================= 12 PLAYERS, ESTIMATES, SPY TIMER ================= */
  AREA = '12 players & timing';
  try {
    const p = await fresh(b);
    const twelve = Array.from({ length: 12 }, (_, i) => ['Alexandria', 'Benjamin', 'Christopher', 'Dominique', 'Evangeline', 'Francesca', 'Gabriel', 'Harriet', 'Isabella', 'Jonathan', 'Katherine', 'Leonardo'][i]);
    await setPlayers(p, twelve);
    for (const [g, r] of [['act', '2–12'], ['fb', '4–12'], ['spy', '4–12']]) { await open(p, g); check(`${g} setup shows ${r}`, (await txt(p, '#playerRange')) === r); }
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

  /* ================= PLAYER SETUP ================= */
  AREA = 'Player setup';
  try {
    const p = await fresh(b);
    await open(p, 'act');
    for (let i = 0; i < 10; i++) await p.click('#addPlayer');
    check('Can add up to 12 players, then Add disappears', (await p.locator('#players input').count()) === 12 && await p.locator('#addPlayer').isHidden());
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

  /* ================= GAME NIGHT ================= */
  AREA = 'Game night';
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
    await open(p, 'spy');
    await p.locator('#players .player-row').nth(3).locator('button[aria-label^="Sit out"]').click();
    await p.click('#startGame');
    check('Sitting someone out below the minimum shows the error', (await screen(p)) === 'setup' && /4/.test(await txt(p, '#setupError')));
    await p.click('#sitOutChips button');
    check('Adding them back works', (await ev(p, () => S.players.length)) === 4);
    // rename mid-night keeps points
    await p.locator('#players input').nth(0).fill('Anna');
    check('Renaming keeps the same person’s points', (await night()).Anna === 3);
    // early exit
    const before = await log();
    await p.click('#startGame'); await p.click('#srGo'); await ev(p, () => show('home'));
    check('Leaving a game early adds nothing', (await log()) === before);
    // don't count
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

  /* ================= LAYOUT: small phone, dark mode ================= */
  AREA = 'Layout';
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

  await b.close();
  if (srv) srv.close();
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
  const fails = results.filter(r => !r.ok);
  const areas = [...new Set(results.map(r => r.area))];
  for (const a of areas) {
    const rs = results.filter(r => r.area === a);
    console.log(`\n## ${a}: ${rs.filter(r => r.ok).length}/${rs.length}`);
    rs.filter(r => !r.ok).forEach(r => console.log(`  FAIL ${r.name} — ${r.detail}`));
  }
  console.log(`\nTOTAL ${results.length - fails.length}/${results.length} passed`);
  process.exitCode = fails.length ? 1 : 0;
})().catch(e => { console.error('SUITE CRASHED', e); process.exit(1); });
