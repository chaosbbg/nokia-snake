# Nokia Snake — hourly leaderboard for token holders

A Nokia 3310–style Snake site for a StonkFun (Solana) token.

- **Game:** 84×48 pixel LCD, keypad, keyboard and swipe controls. Anyone can play practice games.
- **Ranked:** players connect Phantom, Solflare or Backpack and sign a free message (no transaction). Wallets holding at least `MIN_HOLD` of your token go on the leaderboard.
- **Hourly rounds:** each UTC hour gets a fresh board, and the site shows a live countdown.
- **Anti-cheat:** the server replays every ranked game move by move, so made-up scores don't count.
- **Prize vault:** the site shows your vault wallet's live balance. **Past rounds** lists the top wallets of every finished hour from the last 24h, each with a Copy button, so you can pay them by hand. The latest round also shows whether each winner still holds the token.

No npm packages are needed. It runs on Node 22 alone.

Going live, step by step: see **HOW-TO-GO-LIVE.md**.

## Run on your own computer
```bash
cp .env.example .env    # fill it in (or set DEV_SKIP_HOLDER_CHECK=true + NODE_ENV=development to test)
npm start               # http://localhost:3000
npm test
```

## Files
```
shared/engine.js    game engine (runs in the browser and on the server)
server/index.js     website + API
server/db.js        leaderboard storage (SQLite, in data/)
server/solana.js    wallet sign-in + token balance checks
public/             the page (index.html, style.css, game.js)
test/               tests
```

## Things to know
- The replay check stops fake scores, but it can't stop a bot that really plays. Glance at winners before paying, and consider skipping a round when only one person played.
- A game counts toward the hour it **ends** in.
- Rules for crypto prizes differ by country. Check what applies to you before advertising rewards.
