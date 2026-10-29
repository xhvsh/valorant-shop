// Calls the app's cron endpoints on schedule. Unlike a plain URL pinger it waits for
// the answer, retries a failed call a couple of times, and logs every run (see
// `wrangler tail` or the Worker's logs in the Cloudflare dashboard).
//
// Timing: Cloudflare starts a cron up to ~a minute off its minute, and `scheduledTime`
// is not minute-aligned. So the schedules fire at :58, the bundle check gets a warm-up
// call first (fresh token, warm instance; a cold one takes ~8s), and the Worker then
// waits until the top of the hour for the real call.
//
// The daily shop runs twice: at 00:00 UTC, and again at 00:10 as a catch-up for
// accounts Riot had not rotated yet. The app's sent-markers stop a second DM.
const JOBS = {
  '58 * * * *': { path: '/api/cron/bundles', warm: true },
  '58 23 * * *': { path: '/api/cron/dailyshop', warm: false },
  '8 0 * * *': { path: '/api/cron/dailyshop', warm: false },
};

const ATTEMPTS = 3;
const TIMEOUT_MS = 65 * 1000; // a bit over the app's own 60s function limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One JSON line per event, so runs can be filtered in Workers Logs. `msg` keeps the
// readable text for `wrangler tail`.
function log(fields, msg) {
  console.log(JSON.stringify({ ...fields, msg: `[cron] ${msg}` }));
}

async function warmUp(path, env) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${env.APP_URL}${path}?warm=1`, {
      headers: { 'x-scheduler-secret': env.SCHEDULER_SECRET },
      signal: AbortSignal.timeout(20 * 1000),
    });
    const ms = Date.now() - t0;
    log({ event: 'warmup', path, status: res.status, ms }, `warm-up ${path}: HTTP ${res.status} (${ms}ms)`);
  } catch (e) {
    const ms = Date.now() - t0;
    const error = String((e && e.message) || e);
    log({ event: 'warmup', path, status: 0, error, ms }, `warm-up ${path} failed: ${error} (${ms}ms)`);
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
      const ms = Date.now() - t0;
      log({ event: 'call', path, attempt, status: res.status, ms, body }, `${path} attempt ${attempt}: ${last} (${ms}ms)`);
      // 2xx is success; 4xx (bad secret, wrong path) will not get better by retrying.
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500) return false;
    } catch (e) {
      last = String((e && e.message) || e);
      const ms = Date.now() - t0;
      log({ event: 'call', path, attempt, status: 0, error: last, ms }, `${path} attempt ${attempt} failed: ${last} (${ms}ms)`);
    }
    if (attempt < ATTEMPTS) await sleep(attempt * 5000);
  }
  console.error(JSON.stringify({ event: 'giveup', path, attempts: ATTEMPTS, error: last, msg: `[cron] ${path} gave up after ${ATTEMPTS} attempts: ${last}` }));
  return false;
}

async function run(job, event, env) {
  if (job.warm) await warmUp(job.path, env);
  // The schedule is two minutes before the real time: wait for the top of the hour.
  const target = Math.floor(event.scheduledTime / 60000) * 60000 + 120 * 1000;
  const wait = target - Date.now();
  if (wait > 0 && wait <= 150 * 1000) await sleep(wait);
  const at = new Date().toISOString();
  log({ event: 'start', path: job.path, at, target: new Date(target).toISOString() }, `calling ${job.path} at ${at} (target ${new Date(target).toISOString()})`);
  return callJob(job.path, env);
}

// Constant-time secret check: compare SHA-256 digests so neither length nor content
// leaks through timing.
async function secretMatches(given, expected) {
  if (!expected || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  // Manual run for testing or to re-run a missed day: GET /?job=bundles (or dailyshop)
  // with the x-scheduler-secret header. Anything else gets a plain status line, so the
  // public URL reveals nothing.
  async fetch(request, env, ctx) {
    const job = new URL(request.url).searchParams.get('job');
    const path = job === 'bundles' ? '/api/cron/bundles' : job === 'dailyshop' ? '/api/cron/dailyshop' : null;
    if (path && (await secretMatches(request.headers.get('x-scheduler-secret'), env.SCHEDULER_SECRET))) {
      const ok = await callJob(path, env);
      return new Response(ok ? 'ok\n' : 'failed\n', { status: ok ? 200 : 502 });
    }
    return new Response('valorant-shop-cron\n', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    const job = JOBS[event.cron];
    if (!job) {
      console.error(JSON.stringify({ event: 'nojob', cron: event.cron, msg: `[cron] no job for schedule "${event.cron}"` }));
      return;
    }
    ctx.waitUntil(run(job, event, env));
  },
};
