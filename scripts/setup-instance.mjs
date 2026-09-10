#!/usr/bin/env node
/**
 * Check an Unbent instance, then fill in what is missing.
 *
 *   pnpm setup:instance            # check everything, then offer to fix each gap
 *   pnpm setup:instance --check    # report only; exits 1 if anything required is missing
 *   pnpm setup:instance --dry-run  # print every command it would run instead of running it
 *   pnpm setup:instance --url https://notes.example.com   # the address, when it cannot be found
 *
 * One script rather than a setup script and a doctor, because they are the same list read
 * two ways. On a fresh fork every check fails and the fills are the setup flow: log in,
 * create the database, migrate, build, deploy with the auth secret, ask who may sign in,
 * offer push-to-deploy. On a working instance every check passes and it prints a report.
 * On a half-configured one it asks only about the gaps. Running it twice is safe.
 *
 * What it will not do: anything with no API. Enabling R2 on an account, minting an API
 * token for GitHub Actions, and owning a domain are dashboard actions; it links to each
 * and waits. And it never prints a secret's value — it reads names from `wrangler secret
 * list`, and what it sets comes from the person at the keyboard or from `openssl rand`.
 *
 * No dependencies: node, the pinned wrangler under apps/api, and `gh` if it is installed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(ROOT, 'apps', 'api');
const WRANGLER = join(API, 'node_modules', '.bin', 'wrangler');

// ---------------------------------------------------------------------------------------
// Arguments

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const CHECK_ONLY = flag('--check');
const DRY_RUN = flag('--dry-run');
const CONFIG = option('--config') ?? 'wrangler.toml';
const URL_ARG = option('--url');

if (flag('--help') || flag('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n'));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------
// Output

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const say = (s = '') => console.log(s);
const line = (mark, label, detail) => say(`  ${mark}  ${label.padEnd(22)} ${detail ?? ''}`);
const OK = c.ok('✓');
const BAD = c.bad('✗');
const WARN = c.warn('!');
const INFO = c.dim('·');

// ---------------------------------------------------------------------------------------
// Running things

/** Runs wrangler in apps/api and returns stdout; throws with stderr on failure. */
function wrangler(argv, { input, env } = {}) {
  return execFileSync(WRANGLER, ['--config', CONFIG, ...argv], {
    cwd: API,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

/** Same, but shown to the person and allowed to be interactive (login, deploy). */
function wranglerVisible(argv, { input } = {}) {
  const shown = `wrangler ${argv.map((a) => (a === '' ? '""' : a)).join(' ')}`;
  say(c.dim(`  $ ${shown}`));
  if (DRY_RUN) return { status: 0, stdout: '' };
  const result = spawnSync(WRANGLER, ['--config', CONFIG, ...argv], {
    cwd: API,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'],
  });
  process.stdout.write(result.stdout ?? '');
  return result;
}

function pnpm(argv) {
  say(c.dim(`  $ pnpm ${argv.join(' ')}`));
  if (DRY_RUN) return;
  const result = spawnSync('pnpm', argv, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`pnpm ${argv.join(' ')} failed`);
}

function ghAvailable() {
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  return r.status === 0;
}

function gh(argv, { input } = {}) {
  return execFileSync('gh', argv, { cwd: ROOT, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------------------------------
// Asking

const tty = process.stdin.isTTY && process.stdout.isTTY;
let rl;
async function ask(question, fallback = '') {
  if (!tty) {
    // A dry run has nothing to lose by assuming the default, and it is how the whole path
    // gets exercised from a script; a real run must not guess on someone's behalf.
    if (DRY_RUN) {
      say(`  ${question}: ${c.dim(fallback || '(no answer, dry run)')}`);
      return fallback;
    }
    throw new Error(`cannot ask "${question}" without a terminal; pass --check, or run interactively`);
  }
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  ${question}${fallback ? c.dim(` [${fallback}]`) : ''}: `)).trim();
  return answer || fallback;
}
async function confirm(question, dflt = true) {
  if (!tty && DRY_RUN) {
    // Walk every branch a dry run can, so the printed commands show the full setup.
    say(`  ${question} ${c.dim('(yes, dry run)')}`);
    return true;
  }
  const a = (await ask(`${question} ${dflt ? '(Y/n)' : '(y/N)'}`)).toLowerCase();
  if (!a) return dflt;
  return a.startsWith('y');
}
/** A value typed without echo, for tokens. Readline cannot hide input; raw mode can. */
function askHidden(question) {
  return new Promise((resolvePromise) => {
    if (!tty) {
      if (DRY_RUN) {
        say(`  ${question}: ${c.dim('(nothing, dry run)')}`);
        return resolvePromise('');
      }
      throw new Error('cannot read a secret without a terminal');
    }
    process.stdout.write(`  ${question}: `);
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '\u0003') process.exit(130); // Ctrl-C
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        resolvePromise(buf);
      } else if (ch === '\u007f' || ch === '\b') { // backspace
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------------------
// The configuration this checkout deploys

/**
 * The top-level names in wrangler.toml, read without a TOML parser: only three keys are
 * needed, all scalar, all above the first `[env.` block.
 */
function readTopLevelConfig() {
  const text = readFileSync(join(API, CONFIG), 'utf8');
  const out = { name: undefined, database: undefined, bucket: undefined };
  let section = '';
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('[')) {
      section = l;
      if (section.startsWith('[env.')) break;
      continue;
    }
    const m = /^([a-z_]+)\s*=\s*"([^"]*)"/.exec(l);
    if (!m) continue;
    const [, key, value] = m;
    if (section === '' && key === 'name') out.name = value;
    if (section === '[[d1_databases]]' && key === 'database_name') out.database = value;
    if (section === '[[r2_buckets]]' && key === 'bucket_name') out.bucket = value;
  }
  for (const [k, v] of Object.entries(out)) {
    if (!v) throw new Error(`could not read the top-level ${k} from apps/api/${CONFIG}`);
  }
  return out;
}

/** Where a deploy this script performed left the instance's address, for later checks. */
const REMEMBERED = join(API, '.wrangler', `instance-${basename(CONFIG, '.toml')}.json`);
function rememberedUrl() {
  try {
    return JSON.parse(readFileSync(REMEMBERED, 'utf8')).url;
  } catch {
    return undefined;
  }
}
function rememberUrl(url) {
  mkdirSync(dirname(REMEMBERED), { recursive: true });
  writeFileSync(REMEMBERED, `${JSON.stringify({ url }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------
// Checks. Each returns a plain object; nothing here changes anything.

function checkLogin() {
  try {
    const who = JSON.parse(wrangler(['whoami', '--json']));
    const account = who.accounts?.[0];
    return { ok: Boolean(who.authenticated ?? account), email: who.email, account };
  } catch {
    return { ok: false };
  }
}

function checkDatabase(name) {
  try {
    const info = JSON.parse(wrangler(['d1', 'info', name, '--json']));
    return { ok: true, id: info.uuid ?? info.id };
  } catch {
    return { ok: false };
  }
}

function checkMigrations() {
  try {
    const out = wrangler(['d1', 'migrations', 'list', 'DB', '--remote', '--env', '']);
    if (/No migrations to apply/i.test(out)) return { ok: true, pending: [] };
    const pending = [...out.matchAll(/^\s*│?\s*(\d{4}_[\w-]+\.sql)/gm)].map((m) => m[1]);
    return { ok: pending.length === 0, pending };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message).split('\n').find((l) => /error/i.test(l)) };
  }
}

/** The names of the secrets on the Worker, or `missing` when there is no Worker yet. */
function checkWorker() {
  try {
    const names = JSON.parse(wrangler(['secret', 'list', '--env', '', '--format', 'json'])).map((s) => s.name);
    return { ok: true, names: new Set(names) };
  } catch (e) {
    const text = String(e.stderr || e.message);
    if (/not found|10007|does not exist/i.test(text)) return { ok: false, missing: true, names: new Set() };
    return { ok: false, names: new Set(), error: text.split('\n').find((l) => /error/i.test(l)) };
  }
}

/**
 * What the secret names say, by the same rules the Worker applies. The Worker is the
 * authority on what is offered — `/api/config` below reports that — so this only flags
 * shapes the Worker would silently ignore: half a pair, and an allowlist nobody set.
 */
function readSecrets(names) {
  const has = (n) => names.has(n);
  const pair = (a, b) => (has(a) && has(b) ? 'set' : has(a) || has(b) ? 'half' : 'unset');
  const providers = [...names]
    .filter((n) => n.endsWith('_CLIENT_ID'))
    .map((n) => n.slice(0, -'_CLIENT_ID'.length));
  const halfProviders = [...names]
    .filter((n) => n.endsWith('_CLIENT_ID') || n.endsWith('_CLIENT_SECRET'))
    .map((n) => n.replace(/_CLIENT_(ID|SECRET)$/, ''))
    .filter((p, i, all) => all.indexOf(p) === i)
    .filter((p) => !(has(`${p}_CLIENT_ID`) && has(`${p}_CLIENT_SECRET`)));
  return {
    auth: has('BETTER_AUTH_SECRET'),
    allowlist: has('ALLOWED_EMAILS') ? 'set' : has('PUBLIC_SIGNUPS') ? 'public' : 'unset',
    operator: pair('OPERATOR_NAME', 'OPERATOR_EMAIL'),
    legal: pair('LEGAL_PRIVACY_URL', 'LEGAL_TERMS_URL'),
    mail: pair('RESEND_API_KEY', 'EMAIL_FROM'),
    providers: providers.filter((p) => has(`${p}_CLIENT_SECRET`)),
    halfProviders,
    appUrl: has('APP_URL'),
    assetLinks: has('ANDROID_ASSET_LINKS'),
    posthog: has('POSTHOG_KEY'),
  };
}

async function checkLive(url) {
  if (!url) return { ok: false, unknown: true };
  try {
    const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (!health.ok) return { ok: false, status: health.status };
    const config = await (await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(10_000) })).json();
    return { ok: true, config };
  } catch (e) {
    return { ok: false, error: e.cause?.code ?? e.name };
  }
}

function checkGithub() {
  if (!ghAvailable()) return { available: false };
  let remote = '';
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return { available: true, repo: undefined };
  }
  if (!/github\.com/.test(remote)) return { available: true, repo: undefined };
  try {
    const names = new Set(JSON.parse(gh(['secret', 'list', '--json', 'name'])).map((s) => s.name));
    return { available: true, repo: remote, names };
  } catch {
    return { available: true, repo: remote, names: undefined };
  }
}

// ---------------------------------------------------------------------------------------
// Report

function report(state) {
  const { config, login, database, migrations, worker, secrets, url, live, github } = state;
  say();
  say(c.bold(`Unbent instance: ${config.name}`) + c.dim(`  (apps/api/${CONFIG})`));
  say();

  line(login.ok ? OK : BAD, 'Cloudflare login', login.ok ? `${login.email ?? ''} — ${login.account?.name ?? 'account'} ${c.dim(login.account?.id ?? '')}` : 'not logged in');
  line(database.ok ? OK : BAD, `D1 "${config.database}"`, database.ok ? c.dim(database.id ?? 'exists') : 'does not exist on this account');
  if (database.ok) {
    line(
      migrations.ok ? OK : migrations.pending?.length ? WARN : BAD,
      'Migrations',
      migrations.ok ? 'all applied' : migrations.pending?.length ? `${migrations.pending.length} pending: ${migrations.pending.join(', ')}` : migrations.error ?? 'could not list',
    );
  }
  line(worker.ok ? OK : BAD, 'Worker', worker.ok ? 'deployed' : worker.missing ? 'never deployed' : worker.error ?? 'could not reach');
  line(INFO, `R2 "${config.bucket}"`, c.dim('provisioned by the deploy; R2 must be enabled on the account first'));

  if (worker.ok) {
    say();
    say(c.bold('  Secrets') + c.dim('  (names only)'));
    line(secrets.auth ? OK : BAD, 'BETTER_AUTH_SECRET', secrets.auth ? '' : 'missing — nobody can sign in');
    line(
      secrets.allowlist === 'unset' ? WARN : OK,
      'Who may sign in',
      secrets.allowlist === 'set' ? 'ALLOWED_EMAILS' : secrets.allowlist === 'public' ? 'anyone, by choice (PUBLIC_SIGNUPS)' : 'anyone — ALLOWED_EMAILS is unset',
    );
    line(secrets.operator === 'half' ? BAD : secrets.operator === 'set' ? OK : INFO, 'Operator', secrets.operator === 'half' ? 'half a pair — both OPERATOR_NAME and OPERATOR_EMAIL, or neither' : secrets.operator === 'set' ? 'named; built-in legal pages render' : c.dim('unset; no privacy policy or terms are published'));
    line(secrets.legal === 'half' ? BAD : secrets.legal === 'set' ? OK : INFO, 'External legal pages', secrets.legal === 'half' ? 'half a pair — both LEGAL_PRIVACY_URL and LEGAL_TERMS_URL, or neither' : secrets.legal === 'set' ? 'linked' : c.dim('not used'));
    line(secrets.mail === 'half' ? BAD : secrets.mail === 'set' ? OK : INFO, 'Mail', secrets.mail === 'half' ? 'half a pair — both RESEND_API_KEY and EMAIL_FROM, or neither' : secrets.mail === 'set' ? 'Resend configured' : c.dim('none; codes by email and password reset are off'));
    line(secrets.halfProviders.length ? BAD : INFO, 'OAuth providers', secrets.providers.length ? secrets.providers.map((p) => p.toLowerCase()).join(', ') + (secrets.halfProviders.length ? c.bad(`  half-configured: ${secrets.halfProviders.join(', ')}`) : '') : secrets.halfProviders.length ? c.bad(`half-configured: ${secrets.halfProviders.join(', ')}`) : c.dim('none'));
    line(INFO, 'APP_URL', secrets.appUrl ? 'pinned to one origin' : c.dim('derived from each request; pin it if the Worker answers on two hostnames'));
    line(INFO, 'Android app-links', secrets.assetLinks ? 'published' : c.dim('none; only needed for an Android build of your own'));
    line(INFO, 'Error tracking', secrets.posthog ? 'PostHog' : c.dim('off'));
  }

  say();
  say(c.bold('  Live'));
  if (live.unknown) {
    line(WARN, 'Address', 'unknown — pass --url https://… (the deploy prints it; a custom domain is in the dashboard)');
  } else if (!live.ok) {
    line(BAD, url, live.status ? `health answered ${live.status}` : `unreachable (${live.error})`);
  } else {
    line(OK, url, 'healthy');
    const cfg = live.config ?? {};
    line(INFO, 'Sign-in methods', (cfg.providers ?? []).join(', ') || c.bad('none'));
    line(INFO, 'Legal pages', cfg.legal ? `${cfg.legal.privacy} and ${cfg.legal.terms}` : c.dim('none published'));
    if (cfg.operator) line(INFO, 'Operated by', `${cfg.operator.name} <${cfg.operator.email}> at ${cfg.operator.host}`);
  }

  say();
  say(c.bold('  Push to deploy') + c.dim('  (GitHub Actions)'));
  if (!github.available) {
    line(INFO, 'gh', c.dim('not installed or not logged in; skipping'));
  } else if (!github.repo) {
    line(INFO, 'origin', c.dim('is not on GitHub; skipping'));
  } else if (!github.names) {
    line(WARN, github.repo, 'could not list repository secrets (no admin access?)');
  } else {
    const have = (n) => github.names.has(n);
    const both = have('CLOUDFLARE_API_TOKEN') && have('CLOUDFLARE_ACCOUNT_ID');
    line(both ? OK : INFO, 'Cloudflare secrets', both ? 'set; pushes to main deploy' : c.dim('unset; deploy from this machine with `pnpm release`, or set them below'));
    if (both && !worker.ok) line(INFO, 'BETTER_AUTH_SECRET', have('BETTER_AUTH_SECRET') ? 'set; the first push can create the Worker' : c.warn('unset — the first push cannot create a Worker without it'));
  }
  say();
}

function requiredMissing(state) {
  const { login, database, migrations, worker, secrets } = state;
  const missing = [];
  if (!login.ok) missing.push('login');
  if (!database.ok) missing.push('database');
  if (database.ok && !migrations.ok && migrations.pending?.length) missing.push('migrations');
  if (!worker.ok) missing.push('worker');
  if (worker.ok && !secrets.auth) missing.push('BETTER_AUTH_SECRET');
  for (const [k, v] of Object.entries(secrets ?? {})) if (v === 'half') missing.push(`${k} (half a pair)`);
  if (secrets?.halfProviders?.length) missing.push(`providers half-configured: ${secrets.halfProviders.join(', ')}`);
  return missing;
}

// ---------------------------------------------------------------------------------------
// Fills. Each one changes exactly one thing, and says what it is about to do first.

function putSecret(name, value) {
  say(c.dim(`  $ wrangler secret put ${name} --env ""`));
  if (DRY_RUN) return;
  wrangler(['secret', 'put', name, '--env', ''], { input: value });
}

async function fillLogin() {
  say(c.bold('\nLog in to Cloudflare.') + ' A browser opens; approve wrangler there.');
  const r = wranglerVisible(['login']);
  if (!DRY_RUN && r.status !== 0) throw new Error('login failed');
}

async function fillDatabase(name) {
  say(c.bold(`\nCreate the D1 database "${name}".`) + ' Migrations run before the deploy that would otherwise create it.');
  const r = wranglerVisible(['d1', 'create', name]);
  if (!DRY_RUN && r.status !== 0) throw new Error('d1 create failed');
}

async function fillMigrations() {
  say(c.bold('\nApply migrations.'));
  const r = wranglerVisible(['d1', 'migrations', 'apply', 'DB', '--remote', '--env', '']);
  if (!DRY_RUN && r.status !== 0) throw new Error('migrations failed');
}

/**
 * The first deploy, which is the only one this script performs. Later deploys are
 * `pnpm release` or a push, and both inherit what this one sets.
 *
 * Returns the address the deploy printed, and the generated auth secret, which the GitHub
 * step may want — only a secret this run created can safely be handed to CI, because CI
 * sends it on every push and a different value would sign everyone out.
 */
async function fillFirstDeploy(login, secretsAlready) {
  say(c.bold('\nDeploy the Worker for the first time.'));
  say('  The auth secret is generated here and travels with the deploy; a Worker that does');
  say('  not exist yet cannot have one put on it afterwards.');
  const generated = secretsAlready.auth ? undefined : randomBytes(32).toString('base64');
  const allowed = await ask('Email addresses allowed to sign in, comma-separated (empty means anyone)');
  const lines = [];
  if (generated) lines.push(`BETTER_AUTH_SECRET=${generated}`);
  if (allowed) lines.push(`ALLOWED_EMAILS=${allowed}`);
  // Under .wrangler, which is gitignored, readable by this user only, and deleted below
  // the moment the deploy has read it. A dry run writes nothing.
  const file = join(API, '.wrangler', 'first-deploy-secrets.env');
  if (!DRY_RUN) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  }

  say('\n  Building the web app first; the Worker serves it.');
  pnpm(['build']);

  let url;
  for (;;) {
    const argv = ['deploy', '--env', ''];
    if (lines.length) argv.push('--secrets-file', file);
    const r = wranglerVisible(argv);
    if (DRY_RUN) break;
    if (r.status === 0) {
      url = /https:\/\/[\w.-]+\.workers\.dev/.exec(r.stdout ?? '')?.[0];
      break;
    }
    if (/10042/.test(r.stdout ?? '')) {
      say(c.warn('\n  R2 is not enabled on this account, and the bucket cannot be created until it is.'));
      say(`  Enable it here, then press Enter to retry: https://dash.cloudflare.com/${login.account?.id ?? ''}/r2`);
      await ask('Enter to retry');
      continue;
    }
    throw new Error('deploy failed; see wrangler\'s output above');
  }
  rmSync(file, { force: true });
  return { url, generated, allowed };
}

async function fillAllowlist() {
  say(c.bold('\nWho may sign in?') + ' Empty leaves the instance open to anyone with a working method.');
  const allowed = await ask('Email addresses allowed to sign in, comma-separated');
  if (allowed) putSecret('ALLOWED_EMAILS', allowed);
  else if (await confirm('Leave it open on purpose, and say so with PUBLIC_SIGNUPS=1?', false)) putSecret('PUBLIC_SIGNUPS', '1');
}

async function fillOperator() {
  say(c.bold('\nWho runs this instance?') + ' Names the built-in privacy policy and terms. Skip to publish neither.');
  const name = await ask('Operator name (a person or a company), or empty to skip');
  if (!name) return;
  const email = await ask('Contact email');
  if (!email) return;
  putSecret('OPERATOR_NAME', name);
  putSecret('OPERATOR_EMAIL', email);
}

async function fillGithub(github, login, generated) {
  say(c.bold('\nPush to deploy.') + ` Every push to main then deploys ${github.repo}.`);
  say('  It needs an API token, which only the dashboard can mint. Create one with the');
  say('  "Edit Cloudflare Workers" template, and add D1:Edit and Workers R2 Storage:Edit:');
  say(`  https://dash.cloudflare.com/${login.account?.id ?? ''}/api-tokens`);
  if (!(await confirm('Set the repository secrets now?'))) return;
  const token = await askHidden('API token (not echoed)');
  if (!token) return;
  const set = (name, value) => {
    say(c.dim(`  $ gh secret set ${name}`));
    if (!DRY_RUN) gh(['secret', 'set', name], { input: value });
  };
  set('CLOUDFLARE_API_TOKEN', token);
  set('CLOUDFLARE_ACCOUNT_ID', login.account?.id ?? (await ask('Account id')));
  if (generated) set('BETTER_AUTH_SECRET', generated);
}

// ---------------------------------------------------------------------------------------

async function gather() {
  const config = readTopLevelConfig();
  const login = checkLogin();
  const database = login.ok ? checkDatabase(config.database) : { ok: false };
  const migrations = database.ok ? checkMigrations() : { ok: false };
  const worker = login.ok ? checkWorker() : { ok: false, names: new Set() };
  const secrets = readSecrets(worker.names);
  const url = URL_ARG ?? rememberedUrl();
  const live = await checkLive(url);
  const github = checkGithub();
  return { config, login, database, migrations, worker, secrets, url, live, github };
}

async function main() {
  if (!existsSync(WRANGLER)) throw new Error('wrangler is not installed; run `pnpm install` first');
  if (DRY_RUN) say(c.warn('Dry run: commands are printed, nothing is changed.'));

  let state = await gather();
  report(state);

  if (CHECK_ONLY) {
    const missing = requiredMissing(state);
    if (missing.length) {
      say(c.bad(`Missing: ${missing.join(', ')}`));
      process.exit(1);
    }
    say(c.ok('Nothing required is missing.'));
    return;
  }

  let generated;
  if (!state.login.ok) {
    await fillLogin();
    state = await gather();
  }
  if (!state.database.ok) {
    await fillDatabase(state.config.database);
    state.database = DRY_RUN ? state.database : checkDatabase(state.config.database);
  }
  if (state.database.ok || DRY_RUN) {
    const m = DRY_RUN ? state.migrations : checkMigrations();
    if (!m.ok && (m.pending?.length || !state.worker.ok)) {
      await fillMigrations();
    }
  }
  if (!state.worker.ok) {
    const first = await fillFirstDeploy(state.login, state.secrets);
    generated = first.generated;
    if (first.url) {
      rememberUrl(first.url);
      state.url = first.url;
      say(c.ok(`\n  Deployed: ${first.url}`));
      say('  To serve it from your own domain, add the domain to the Worker in the dashboard');
      say('  under Settings → Domains & Routes; Cloudflare makes the record and certificate.');
    }
    state.worker = DRY_RUN ? state.worker : checkWorker();
    state.secrets = readSecrets(state.worker.names);
    // The first deploy already asked; an empty answer there was an answer.
    state.secrets.allowlist = first.allowed ? 'set' : 'asked';
  }
  if (state.worker.ok || DRY_RUN) {
    if (state.secrets.allowlist === 'unset') await fillAllowlist();
    if (state.secrets.operator === 'unset' && (await confirm('Name the operator so the built-in legal pages render?', false))) {
      await fillOperator();
    }
  }
  if (state.github.available && state.github.repo && state.github.names) {
    const have = (n) => state.github.names.has(n);
    if (!(have('CLOUDFLARE_API_TOKEN') && have('CLOUDFLARE_ACCOUNT_ID'))) {
      if (await confirm('Set up push-to-deploy from GitHub Actions?', false)) {
        await fillGithub(state.github, state.login, generated);
      }
    }
  }

  say(c.bold('\nDone. The report again, as things are now:'));
  if (!DRY_RUN) report(await gather());
  rl?.close();
}

main().catch((e) => {
  rl?.close();
  say(c.bad(`\n${e.message}`));
  process.exit(1);
});
