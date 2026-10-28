// Calls the app's cron endpoints on schedule. Unlike a plain URL pinger it waits for
// the answer, retries a failed call a couple of times, and logs every run (see
// `wrangler tail` or the Worker's logs in the Cloudflare dashboard).
//
// Timing: Cloudflare starts a cron up to ~a minute off its minute, and `scheduledTime`
// is not minute-aligned. So the schedules fire at :58, the bundle check gets a warm-up
// call first (fresh token, warm instance; a cold one takes ~8s), and the Worker then
// waits until the top of the hour for the real call.
const JOBS = {
  '58 * * * *': { path: '/api/cron/bundles', warm: true },
  '58 23 * * *': { path: '/api/cron/dailyshop', warm: false },
};

const ATTEMPTS = 3;
const TIMEOUT_MS = 65 * 1000; // a bit over the app's own 60s function limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function warmUp(path, env) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${env.APP_URL}${path}?warm=1`, {
      headers: { 'x-scheduler-secret': env.SCHEDULER_SECRET },
      signal: AbortSignal.timeout(20 * 1000),
    });
    console.log(`[cron] warm-up ${path}: HTTP ${res.status} (${Date.now() - t0}ms)`);
  } catch (e) {
    console.log(`[cron] warm-up ${path} failed: ${String((e && e.message) || e)} (${Date.now() - t0}ms)`);
  }
}

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
    if (attempt < ATTEMPTS) await sleep(attempt * 5000);
  }
  console.error(`[cron] ${path} gave up after ${ATTEMPTS} attempts: ${last}`);
  return false;
}

async function run(job, event, env) {
  if (job.warm) await warmUp(job.path, env);
  // The schedule is two minutes before the real time: wait for the top of the hour.
  const target = Math.floor(event.scheduledTime / 60000) * 60000 + 120 * 1000;
  const wait = target - Date.now();
  if (wait > 0 && wait <= 150 * 1000) await sleep(wait);
  console.log(`[cron] calling ${job.path} at ${new Date().toISOString()} (target ${new Date(target).toISOString()})`);
  return callJob(job.path, env);
}

export default {
  // Manual run for testing: GET /?job=bundles (or dailyshop) with the x-scheduler-secret
  // header. Anything else gets a plain status line, so the public URL reveals nothing.
  async fetch(request, env, ctx) {
    const job = new URL(request.url).searchParams.get('job');
    const path = job === 'bundles' ? '/api/cron/bundles' : job === 'dailyshop' ? '/api/cron/dailyshop' : null;
    if (path && request.headers.get('x-scheduler-secret') === env.SCHEDULER_SECRET) {
      const ok = await callJob(path, env);
      return new Response(ok ? 'ok\n' : 'failed\n', { status: ok ? 200 : 502 });
    }
    return new Response('valorant-shop-cron\n', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    const job = JOBS[event.cron];
    if (!job) {
      console.error(`[cron] no job for schedule "${event.cron}"`);
      return;
    }
    ctx.waitUntil(run(job, event, env));
  },
};
