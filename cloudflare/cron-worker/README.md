# valorant-shop-cron

Cloudflare Worker that replaces the cron-job.org jobs:

| Schedule (UTC) | Calls |
| --- | --- |
| `59 * * * *` | `/api/cron/bundles` (warm-up at :59, real call at :00) |
| `59 23 * * *` | `/api/cron/dailyshop` (real call at 00:00) |

Schedules fire one minute early; the Worker waits until the top of the hour, so the call lands at :00 and not at whatever second Cloudflare starts the cron. It calls the app at `https://xhv.sh/valorant-shop`, waits for the reply, retries up to 3 times, and logs each run (Workers & Pages -> valorant-shop-cron -> Logs). A manual run: `curl -H "x-scheduler-secret: $SCHEDULER_SECRET" "https://valorant-shop-cron.<your-subdomain>.workers.dev/?job=bundles"`.

## Deploy

```bash
cd cloudflare/cron-worker
export CLOUDFLARE_API_TOKEN=...      # needs "Edit Cloudflare Workers"
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler deploy
echo "$SCHEDULER_SECRET" | npx wrangler secret put SCHEDULER_SECRET
```

`SCHEDULER_SECRET` is the same value the app checks (`x-scheduler-secret` header).
Watch runs with `npx wrangler tail valorant-shop-cron`.
