# How to put Snake on the internet (no coding needed)

- **GitHub** is a folder in the cloud that holds the game's files.
- **Railway** is a computer in the cloud that runs the game 24/7 and gives it a web link.
- **The volume** is Railway's hard drive, where the leaderboard is saved.

About 20 minutes, all copy-paste.

## 1. Put the files on GitHub
1. Make a free account at **github.com**.
2. Click **+** (top right), then **New repository**. Name it `nokia-snake`, select **Private**, and click **Create repository**.
3. Click **"uploading an existing file"**.
4. In File Explorer, open **Documents → nokia-snake-simple**, press **Ctrl + A**, and drag everything onto the GitHub page.
5. Click **Commit changes**.

## 2. Get a Solana connection
1. Make a free account at **helius.dev**.
2. Copy your **Mainnet RPC URL**.

## 3. Launch on Railway
1. Sign in at **railway.com** with GitHub and pick the **Hobby** plan (needed for saved storage).
2. Click **New Project**, then **Deploy from GitHub repo**, and pick `nokia-snake`.

## 4. Add the hard drive
Right-click the empty area of the project, choose **Volume**, attach it to the game, and set the mount path to exactly `/app/data`.

## 5. Paste the settings
Click the game, open **Variables**, then **Raw Editor**. Paste this and fill in your values:
```
NODE_ENV=production
TRUST_PROXY=true
SESSION_SECRET=type-any-long-random-gibberish-at-least-32-characters
SOLANA_RPC_URL=your-helius-link
TOKEN_MINT=your-token-address
TOKEN_SYMBOL=SNAKE
MIN_HOLD=100000
STONKFUN_URL=your-token-page-on-stonkfun
VAULT_ADDRESS=your-prize-vault-wallet-address
PRIZE_SPLITS=50,30,20
```
Click **Update**.

`VAULT_ADDRESS` is only the **public address**, the one you'd share to receive money. Never put a private key anywhere in these settings.

## 6. Get your link
Open **Settings → Networking** and click **Generate Domain**. That's your game. You can add your own domain on the same screen.

## Paying winners each hour
1. Open your site and scroll to **Past rounds**.
2. The top entry is the round that just ended. Check the **holds / sold** badge, and skip anyone marked **sold**.
3. Click **Copy** next to a winner and paste the address into Phantom's **Send** screen, from your vault wallet.
4. The **Prize vault** box shows the vault's balance, so players can see the prizes are real.

## Testing before your token exists
Use these variables instead. Anyone can play ranked:
```
NODE_ENV=development
DEV_SKIP_HOLDER_CHECK=true
```

## If something goes wrong
- **"Could not reach the game server"**: open Railway's **Logs**. A line starting with `Config errors` says which setting is missing.
- **Vault balance shows —**: check `SOLANA_RPC_URL` and `VAULT_ADDRESS`.
