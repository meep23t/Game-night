# Game night tests

`suite.js` plays through the site in a simulated phone (Chromium via Playwright) and checks:

- every game end to end, with real taps and fast-forwarded timers
- player limits (2–12) and the error messages when there are too few players
- scoring, ties and game night points
- teams (team cards, colors, shuffle, locked teams on game night) and Word spies spymasters
- the game length estimate and the Word spies turn timer
- saving a game in progress, word history (fewer repeats) and the word files
- homepage and setup icon animations
- layout: no sideways scrolling on small phones, in light and dark mode

## Run it

```bash
cd tests
npm install
npx playwright install chromium   # first time only
npm test
```

It starts its own local server for the site, so nothing else needs to be running.
To test a deployed copy instead: `TEST_URL=https://ourgamenight.vercel.app/ npm test`

The 20 sections run several at a time (one per CPU core, up to 6), so a full run takes about a minute.
Set `TEST_WORKERS=1` to run them one at a time, which helps when chasing a flaky check.
Each section lives in a `section('Name', async AREA => { ... })` block. Every check inside is reported under that name,
even though sections overlap in time.

The run prints a pass/fail count per area, the total time, and exits with an error if anything fails.
Screenshots of failing sections and `results.json` are written to `tests/output/`.
