# valorant shop

An unofficial, fan-made tool to view your VALORANT daily shop, accessory shop, Night Market and featured bundles, keep a wishlist, get Discord DMs when something you want shows up, and share a read-only view of an account with friends.

It is not affiliated with, endorsed by, or supported by Riot Games, Inc. See [how it works and the risks](website/legal.html) before running or using it. Riot's rules for third-party tools can change, and using unofficial endpoints is at your own risk.

## What it is

- A single Express app (`app.js`) that serves the website (`website/`) and the Discord bot (slash commands over HTTP interactions).
- Runs on Vercel as one serverless function (`api/index.js`), or locally with `node server.js`.
- Storage is Supabase (Postgres). Without Supabase credentials everything stays in memory, which is fine for local development.
- Shop images for Discord are rendered server side to PNG or GIF (`src/grid.js`, using `@resvg/resvg-js`).

Request path: `api/index.js` or `server.js` -> `app.js` -> `src/shop.js` -> `src/riot.js` + `src/storage.js` -> `src/parse.js` -> `src/grid.js` / `src/discord/embeds.js`.

More detail on each part lives in [`.brain/`](.brain/index.md).

## Run it locally

Requires Node 20 or newer.

```bash
npm install
cp .env.example .env   # then fill it in
npm run dev
```

At minimum set `SESSION_SECRET` and `LINK_SECRET` (the app refuses to boot without them) and `ENCRYPTION_KEY` (64 hex characters). Discord sign-in needs the Discord variables. See `.env.example` for every setting.

## Database

Create a Supabase project and run [`schema.sql`](schema.sql) in the SQL editor. It is safe to run again. Row level security is on and only the service role key (used server side) has access. Never expose that key to the browser.

## Discord bot

1. Create an application in the Discord developer portal. Set the interactions endpoint URL to `<your site>/api/interactions`.
2. Fill in `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PUBLIC_KEY` and `DISCORD_BOT_TOKEN`.
3. Register the slash commands:

   ```bash
   node scripts/register-commands.js
   ```

   This registers them globally and clears any server-only copies, which would otherwise show every command twice. To audit what is registered, run `node scripts/check-commands.js`.

## Deploy

The project is set up for Vercel (`vercel.json` routes everything to `api/index.js` and defines the cron jobs). Set the same environment variables in the Vercel project settings. Cron routes are protected by `CRON_SECRET`; an external scheduler can use `SCHEDULER_SECRET` for exact timing.

## Security notes

- Riot refresh tokens are encrypted with AES-256-GCM before they are stored. Losing `ENCRYPTION_KEY` means every user has to re-link.
- Passwords are entered on Riot's own sign-in page and never reach this app.
- Share codes are stored only as HMAC digests.
- Never commit `.env` files. They are ignored by `.gitignore`.

## Contributing

Issues and pull requests are welcome. Keep changes small, run `npm run lint` before submitting, and do not add features that purchase items, automate gameplay or touch the game client.
