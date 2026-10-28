// Calls the app's cron endpoints on schedule. Unlike a plain URL pinger it waits for
// the answer, retries a failed call a couple of times, and logs every run (see
// `wrangler tail` or the Worker's logs in the Cloudflare dashboard).
const JOBS = {
  '0 * * * *': '/api/cron/bundles',
  '0 0 * * *': '/api/cron/dailyshop',
};

const ATTEMPTS = 3;
const TIMEOUT_MS = 65 * 1000; // a bit over the app's own 60s function limit

async function callJob(path, env) {
  const url = `${env.APP_URL}${path}`;
  let last = 'no attempt';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'x-scheduler-secret': env.SCHEDULER_SECRET },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await res.text()).slice(0, 300);
      last = `HTTP ${res.status} ${body}`;
      console.log(`[cron] ${path} attempt ${attempt}: ${last} (${Date.now() - t0}ms)`);
      // 2xx is success; 4xx (bad secret, wrong path) will not get better by retrying.
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500) return false;
    } catch (e) {
      last = String((e && e.message) || e);
      console.log(`[cron] ${path} attempt ${attempt} failed: ${last} (${Date.now() - t0}ms)`);
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 5000));
  }
  console.error(`[cron] ${path} gave up after ${ATTEMPTS} attempts: ${last}`);
  return false;
}

export default {
  async scheduled(event, env, ctx) {
    const path = JOBS[event.cron];
    if (!path) {
      console.error(`[cron] no job for schedule "${event.cron}"`);
      return;
    }
    ctx.waitUntil(callJob(path, env));
  },
};
