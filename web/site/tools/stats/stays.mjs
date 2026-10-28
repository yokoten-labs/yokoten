// How long pages stay on screen: the times site/public/js/theme.js sends and worker/index.js records in
// Analytics Engine (dataset yokoten_stays).
//   npm run stays          the last 7 days
//   npm run stays -- 30    the last 30 days
// Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN, from the environment or from
// ~/.config/yokoten/keys.env (KEY=value lines). It never prints either of them.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEYS_FILE = join(homedir(), '.config', 'yokoten', 'keys.env');
const DATASET = 'yokoten_stays';

function fromKeysFile(name) {
  if (!existsSync(KEYS_FILE)) return undefined;
  for (const line of readFileSync(KEYS_FILE, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === name) return m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

const account = process.env.CLOUDFLARE_ACCOUNT_ID || fromKeysFile('CLOUDFLARE_ACCOUNT_ID');
const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN || fromKeysFile('CLOUDFLARE_ANALYTICS_TOKEN');
const missing = [!account && 'CLOUDFLARE_ACCOUNT_ID', !token && 'CLOUDFLARE_ANALYTICS_TOKEN'].filter(Boolean);
if (missing.length) {
  console.log(
    `stays: ${missing.join(' and ')} not set. Create a Cloudflare API token with "Account Analytics: Read", then put CLOUDFLARE_ACCOUNT_ID=… and CLOUDFLARE_ANALYTICS_TOKEN=… in ~/.config/yokoten/keys.env.`,
  );
  process.exit(1);
}

const days = Number(process.argv[2] ?? 7);
if (!Number.isInteger(days) || days < 1 || days > 90) {
  console.log('stays: the number of days must be a whole number from 1 to 90 (Analytics Engine keeps 90 days).');
  process.exit(1);
}

// Never show the account id or token, not even inside an error message from the API.
const hide = (s) => String(s).split(account).join('<account>').split(token).join('<token>');

async function sql(query) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: query,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`the Analytics Engine API answered ${res.status}: ${hide(text.slice(0, 300))}`);
  return JSON.parse(text).data;
}

// Each data point may stand for several page views when Analytics Engine samples: _sample_interval
// says how many, so every figure is weighted by it. The median, not the mean: one tab left open
// for an hour would pull a mean far off.
const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;
const by = (blob, label) =>
  sql(
    `SELECT ${blob} AS key, SUM(_sample_interval) AS views, ` +
      `quantileExactWeighted(0.5)(double1, _sample_interval) AS median, ` +
      `quantileExactWeighted(0.75)(double1, _sample_interval) AS p75, ` +
      `SUM(IF(double1 < 10, _sample_interval, 0)) AS quick ` +
      `FROM ${DATASET} WHERE ${since} GROUP BY key ORDER BY views DESC LIMIT 20 FORMAT JSON`,
  ).then((rows) => ({ label, rows }));

const secs = (n) => {
  const s = Math.round(Number(n));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

function table({ label, rows }) {
  console.log(`\n${label}`);
  if (!rows.length) return console.log('  (none yet)');
  const width = Math.max(5, ...rows.map((r) => (r.key || '(none)').length));
  console.log(`  ${''.padEnd(width)}  ${'views'.padStart(6)}  ${'median'.padStart(7)}  ${'3 in 4 under'.padStart(12)}  ${'left in <10s'.padStart(12)}`);
  for (const r of rows) {
    const views = Number(r.views);
    const quick = views ? Math.round((100 * Number(r.quick)) / views) : 0;
    console.log(
      `  ${(r.key || '(none)').padEnd(width)}  ${String(Math.round(views)).padStart(6)}  ${secs(r.median).padStart(7)}  ${secs(r.p75).padStart(12)}  ${(quick + '%').padStart(12)}`,
    );
  }
}

try {
  const tables = await Promise.all([by("'all pages'", 'All pages'), by('blob1', 'By page'), by('blob2', 'By page language'), by('blob3', 'By country')]);
  console.log(`yokoten.app time on screen, last ${days} day${days === 1 ? '' : 's'} (people only; bots are not counted)`);
  tables.forEach(table);
} catch (e) {
  console.log('stays: ' + hide(e.message));
  process.exit(1);
}
