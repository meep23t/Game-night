# Game night tests

`suite.js` plays through the site in a simulated phone (Chromium via Playwright) and checks:

- every game end to end, with real taps and fast-forwarded timers
- player limits (2–12) and the error messages when there are too few players
- scoring, ties and game night points
- teams (picker, random teams) and Word spies spymasters
- the game length estimate and the Word spies turn timer
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

The run prints a pass/fail count per area and exits with an error if anything fails.
Screenshots of failing sections and `results.json` are written to `tests/output/`.
