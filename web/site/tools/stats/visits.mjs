// Where the site's visitors come from: the page views worker/index.js records in Analytics Engine.
//   npm run visits          the last 7 days
//   npm run visits -- 30    the last 30 days
// Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN, from the environment or from
// ~/.config/yokoten/keys.env (KEY=value lines). It never prints either of them.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEYS_FILE = join(homedir(), '.config', 'yokoten', 'keys.env');
const DATASET = 'yokoten_visits';

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
    `visits: ${missing.join(' and ')} not set. Create a Cloudflare API token with "Account Analytics: Read", then put CLOUDFLARE_ACCOUNT_ID=… and CLOUDFLARE_ANALYTICS_TOKEN=… in ~/.config/yokoten/keys.env.`,
  );
  process.exit(1);
}

const days = Number(process.argv[2] ?? 7);
if (!Number.isInteger(days) || days < 1 || days > 90) {
  console.log('visits: the number of days must be a whole number from 1 to 90 (Analytics Engine keeps 90 days).');
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

// Each data point may stand for several page views when Analytics Engine samples: _sample_interval says how many.
const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;
const by = (blob, label, where = "blob6 = 'human'") =>
  sql(
    `SELECT ${blob} AS key, SUM(_sample_interval) AS views FROM ${DATASET} WHERE ${since} AND ${where} ` +
      `GROUP BY key ORDER BY views DESC LIMIT 20 FORMAT JSON`,
  ).then((rows) => ({ label, rows }));

function table({ label, rows }) {
  console.log(`\n${label}`);
  if (!rows.length) return console.log('  (none)');
  const width = Math.max(...rows.map((r) => (r.key || '(none)').length));
  for (const r of rows) console.log(`  ${(r.key || '(none)').padEnd(width)}  ${String(Math.round(Number(r.views))).padStart(6)}`);
}

try {
  const tables = await Promise.all([
    by('blob6', 'Humans and bots', '1 = 1'),
    by('blob2', 'Came from (people only; none = typed, bookmarked, or this site)'),
    by('blob3', 'From tag (?from=…)'),
    by('blob1', 'Pages'),
    by('blob4', 'Page language'),
    by('blob5', 'Country'),
  ]);
  console.log(`yokoten.app page views, last ${days} day${days === 1 ? '' : 's'}`);
  tables.forEach(table);
} catch (e) {
  console.log('visits: ' + hide(e.message));
  process.exit(1);
}
