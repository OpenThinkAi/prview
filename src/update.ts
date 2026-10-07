// Keeping an installed prview up to date: a daily check of the npm registry, a footer notice when a newer release is
// out, and (with `auto_update = true`) its installation in the background, by the package manager that installed this
// copy. `prview update` does the same at once, whatever the setting.
//
// Pure apart from `realDeps`: the registry fetch, the install runner, the clock and the paths are passed in, so every
// rule is tested with stubs and no network or install.
//
// What it trusts: nothing from the registry but a version string of the form 1.2.3, and only one strictly newer than
// the version this copy's own package.json says it is. The package name is a constant and the install argv is fixed;
// there is no shell. A source checkout (anything not inside an installed node_modules/@openthink/prview) never checks
// and never updates itself.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { clean } from "./sanitize.ts";

export const PACKAGE = "@openthink/prview";
export const REGISTRY = `https://registry.npmjs.org/${PACKAGE}/latest`;
/** At most one registry check per this long. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** After a version is listed but its tarball is not downloadable yet (npm's post-publish processing), look again this soon. */
export const NOT_READY_RECHECK_MS = 15 * 60 * 1000;
/** After a failed install the next launch tries again, but at most this many failed installs in one 24h window. */
export const MAX_INSTALL_FAILURES_PER_DAY = 3;
export const FETCH_TIMEOUT_MS = 4000;
export const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
/** A lock older than this is from an install that died; it no longer blocks one. */
const STALE_LOCK_MS = INSTALL_TIMEOUT_MS + 60_000;

const RELEASE = /^\d+\.\d+\.\d+$/;
const RUNNING = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export type Manager = "bun" | "npm";
export type Fetcher = (url: string, init: { signal: AbortSignal; method?: "HEAD" }) => Promise<{ ok: boolean; status?: number; text(): Promise<string> }>;
export type Runner = (argv: string[], timeoutMs: number) => Promise<{ code: number; stderr: string }>;
export type UpdateDeps = {
  fetch: Fetcher;
  run: Runner;
  now: () => number;
  /** `$PRVIEW_HOME`: where update.json and the install lock live. */
  home: string;
  /** The directory this module is in: tells an installed copy from a source checkout, and how it was installed. */
  moduleDir: string;
  /** The user's home directory (for ~/.bun/install/global). */
  userHome: string;
  env: Record<string, string | undefined>;
  /** The running version, from this package's package.json; undefined when it cannot be read (then nothing updates). */
  version: string | undefined;
};

// ---------------------------------------------------------------- versions

/** `a` compared with `b` (-1, 0, 1); a release sorts after its own pre-releases. Undefined if either is not a version. */
export function compare(a: string, b: string): number | undefined {
  const x = a.match(RUNNING), y = b.match(RUNNING);
  if (!x || !y) return undefined;
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return Math.sign(d); }
  if (!x[4] !== !y[4]) return x[4] ? -1 : 1;
  return x[4] === y[4] ? 0 : (x[4]! < y[4]! ? -1 : 1);
}

/** The registry's version, if it is a release (1.2.3, no pre-release) strictly newer than `running`; otherwise undefined. */
export function newer(candidate: unknown, running: string | undefined): string | undefined {
  if (typeof candidate !== "string" || !RELEASE.test(candidate) || !running) return undefined;
  return compare(candidate, running) === 1 ? candidate : undefined;
}

/** The version in this package's own package.json (beside src/, not the current directory's). */
export function runningVersion(moduleDir: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(join(moduleDir, "..", "package.json"), "utf8")).version;
    return typeof v === "string" && RUNNING.test(v) ? v : undefined;
  } catch { return undefined; }
}

// ---------------------------------------------------------------- where this copy came from

/** How this copy was installed: null for a source checkout, which never updates itself. */
export function managerOf(moduleDir: string, userHome: string, env: Record<string, string | undefined>): Manager | null {
  const dir = resolve(moduleDir) + sep;
  if (!dir.includes(`${sep}node_modules${sep}@openthink${sep}prview${sep}`)) return null;
  const roots = [env.BUN_INSTALL && join(env.BUN_INSTALL, "install", "global"), join(userHome, ".bun", "install", "global")].filter(Boolean) as string[];
  return roots.some((r) => dir.startsWith(resolve(r) + sep)) ? "bun" : "npm";
}

/** The install command, argv fixed: the package name is a constant and the version has been checked. */
export function installArgv(manager: Manager, version: string): string[] {
  if (!RELEASE.test(version)) throw new Error(`not a release version: ${version}`);
  return manager === "bun" ? ["bun", "add", "-g", "--no-cache", `${PACKAGE}@${version}`] : ["npm", "install", "-g", `${PACKAGE}@${version}`];
}

// ---------------------------------------------------------------- the registry and the daily throttle

/** `due`: when the registry is next asked (default `checked` + a day). `failures`: failed installs since `since`. */
type Stamp = { checked: number; latest?: string; due?: number; failures?: { since: number; n: number } };
const stampPath = (home: string) => join(home, "update.json");

function readStamp(home: string): Stamp | null {
  try {
    const s = JSON.parse(readFileSync(stampPath(home), "utf8"));
    if (typeof s?.checked !== "number") return null;
    const f = s.failures, num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
    return {
      checked: s.checked, latest: typeof s.latest === "string" && RELEASE.test(s.latest) ? s.latest : undefined,
      due: num(s.due) ? s.due : undefined, failures: num(f?.since) && num(f?.n) ? { since: f.since, n: f.n } : undefined,
    };
  } catch { return null; }
}

function writeStamp(home: string, s: Stamp): void {
  try {
    mkdirSync(home, { recursive: true });
    const tmp = `${stampPath(home)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s) + "\n");
    renameSync(tmp, stampPath(home));
  } catch { /* the check runs again next time */ }
}

/** The registry's latest release, or why it could not be read. The response is untrusted: only a release string is kept. */
export async function latest(deps: Pick<UpdateDeps, "fetch">): Promise<{ version: string; tarball: string } | { error: string }> {
  try {
    const res = await deps.fetch(REGISTRY, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { error: "the npm registry did not answer" };
    const text = await res.text();
    if (text.length > 1_000_000) return { error: "the npm registry's answer was not understood" };
    const doc = JSON.parse(text) as { version?: unknown; dist?: { tarball?: unknown } } | null;
    const v = doc?.version;
    return typeof v === "string" && RELEASE.test(v) ? { version: v, tarball: tarballUrl(v, doc?.dist?.tarball) } : { error: "the npm registry's answer was not understood" };
  } catch (e) {
    return { error: (e as Error)?.name === "SyntaxError" ? "the npm registry's answer was not understood" : "the npm registry could not be reached" };
  }
}

/** The tarball to probe: the packument's `dist.tarball` if it is on the npm registry over https, else the canonical URL. */
export function tarballUrl(version: string, advertised: unknown): string {
  const canonical = `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE.split("/")[1]}-${version}.tgz`;
  return typeof advertised === "string" && advertised.startsWith("https://registry.npmjs.org/") && !/[\s\x00-\x1f]/.test(advertised) ? advertised : canonical;
}

/** Is the version's tarball downloadable yet? npm can list a version as latest while its tarball still 404s. Only a 200 counts. */
export async function tarballReady(deps: Pick<UpdateDeps, "fetch">, tarball: string): Promise<boolean> {
  try { return (await deps.fetch(tarball, { method: "HEAD", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })).status === 200; }
  catch { return false; }
}

export const notReadyMessage = (v: string) => `prview ${v} is listed on npm but not downloadable yet; try again in a few minutes`;

// ---------------------------------------------------------------- installing

const lockPath = (home: string) => join(home, "update.lock");

/** Take the install lock, or false when another install holds it (a lock older than an install can take is broken). */
function lock(home: string, now: number): boolean {
  mkdirSync(home, { recursive: true });
  const p = lockPath(home);
  try { if (existsSync(p) && now - statSync(p).mtimeMs > STALE_LOCK_MS) rmSync(p, { force: true }); } catch { /* raced: try anyway */ }
  try { closeSync(openSync(p, "wx")); writeFileSync(p, String(process.pid)); return true; } catch { return false; }
}

/** Install `version` with the manager that installed this copy: the message for the footer or the terminal. */
export async function install(deps: UpdateDeps, manager: Manager, version: string): Promise<{ ok: boolean; message: string; /** The installer ran (or could not start) and failed: worth retrying soon. */ failed?: boolean }> {
  if (!newer(version, deps.version)) return { ok: false, message: `not updating to ${clean(String(version))}: not newer than ${deps.version}` };
  try { if (!lock(deps.home, deps.now())) return { ok: false, message: `an update is already being installed; prview ${version} is available` }; }
  catch { return { ok: false, message: `update to ${version} failed: cannot write to ${deps.home}` }; }
  try {
    const r = await deps.run(installArgv(manager, version), INSTALL_TIMEOUT_MS);
    if (r.code === 0) return { ok: true, message: `updated to ${version} — restart prview to use it` };
    const why = clean(r.stderr).split("\n").map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 160);
    return { ok: false, failed: true, message: `update to ${version} failed (${manager} exited ${r.code})${why ? `: ${why}` : ""}` };
  } catch (e) {
    return { ok: false, failed: true, message: `update to ${version} failed: ${clean((e as Error).message ?? String(e)).slice(0, 160)}` };
  } finally { rmSync(lockPath(deps.home), { force: true }); }
}

// ---------------------------------------------------------------- the two ways in

export const availableNotice = (v: string) => `prview ${v} is available — run prview update, or turn on auto-update in \\ settings`;

/**
 * The background check a review screen starts: the footer note it ends with, or null for nothing to say. Never throws.
 * Skipped under --dry-run, with PRVIEW_NO_UPDATE=1 and in a source checkout; the registry is asked at most once a day,
 * sooner after a failed install or a tarball not up yet (in between, a newer release seen last time is still noticed, but not installed again). `autoUpdate` is read when the
 * answer is in, so turning it on in the settings meanwhile counts.
 */
export async function backgroundCheck(deps: UpdateDeps, opts: { dryRun?: boolean; autoUpdate: () => boolean; /** An install is starting: quitting should wait for it rather than cut it short. */ installing?: (version: string) => void }): Promise<string | null> {
  try {
    if (opts.dryRun || deps.env.PRVIEW_NO_UPDATE === "1" || !deps.version) return null;
    const manager = managerOf(deps.moduleDir, deps.userHome, deps.env);
    if (!manager) return null;
    const now = deps.now(), stamp = readStamp(deps.home);
    if (stamp && stamp.checked <= now && now < (stamp.due ?? stamp.checked + CHECK_EVERY_MS)) {
      const v = newer(stamp.latest, deps.version);
      return v && !opts.autoUpdate() ? availableNotice(v) : null;
    }
    const got = await latest(deps);
    const next: Stamp = { checked: now, latest: "version" in got ? got.version : stamp?.latest, failures: stamp?.failures };
    const v = "version" in got ? newer(got.version, deps.version) : undefined;
    if (!v || !("tarball" in got)) { writeStamp(deps.home, next); return null; }
    if (!opts.autoUpdate()) { writeStamp(deps.home, next); return availableNotice(v); }
    if (!(await tarballReady(deps, got.tarball))) { writeStamp(deps.home, { ...next, due: now + NOT_READY_RECHECK_MS }); return null; }
    writeStamp(deps.home, next);
    opts.installing?.(v);
    const r = await install(deps, manager, v);
    if (!r.ok && r.failed) {
      const f = stamp?.failures && now - stamp.failures.since < CHECK_EVERY_MS && stamp.failures.since <= now ? stamp.failures : { since: now, n: 0 };
      const failures = { since: f.since, n: f.n + 1 };
      // Retry on the next launch until the day's failures are used up; then wait out the rest of the day.
      writeStamp(deps.home, { ...next, failures, due: failures.n < MAX_INSTALL_FAILURES_PER_DAY ? now : f.since + CHECK_EVERY_MS });
    } else if (r.ok) writeStamp(deps.home, { checked: now, latest: next.latest });
    return r.message;
  } catch { return null; }
}

/** `prview update`: check now and install if newer, whatever the setting. Lines to print, and whether it went well. */
export async function updateCommand(deps: UpdateDeps, opts: { dryRun?: boolean } = {}): Promise<{ ok: boolean; lines: string[] }> {
  if (!deps.version) return { ok: false, lines: ["cannot tell which version this is (no readable package.json beside it)"] };
  const manager = managerOf(deps.moduleDir, deps.userHome, deps.env);
  if (!manager) return { ok: false, lines: [
    `this is a source checkout (${resolve(deps.moduleDir, "..")}), version ${deps.version}; it never updates itself.`,
    `update it with git, or install the release: npm install -g ${PACKAGE}`,
  ] };
  const got = await latest(deps);
  if ("error" in got) return { ok: false, lines: [`cannot check for updates: ${got.error}`] };
  writeStamp(deps.home, { checked: deps.now(), latest: got.version });
  const v = newer(got.version, deps.version);
  if (!v) return { ok: true, lines: [`already on the latest (${deps.version})`] };
  const argv = installArgv(manager, v);
  if (opts.dryRun) return { ok: true, lines: [`${deps.version} → ${v}: would run ${argv.join(" ")} (--dry-run: nothing installed)`] };
  if (!(await tarballReady(deps, got.tarball))) return { ok: false, lines: [`${deps.version} → ${v}: ${notReadyMessage(v)}`] };
  const r = await install(deps, manager, v);
  return { ok: r.ok, lines: [`${deps.version} → ${v}: ${argv.join(" ")}`, r.message] };
}

// ---------------------------------------------------------------- the real world

/** The installer, with no shell: argv as given, killed if it outlives `timeoutMs`. */
export const spawnRunner: Runner = async (argv, timeoutMs) => {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    return { code: p.signalCode ? 1 : code, stderr: p.signalCode ? `timed out after ${Math.round(timeoutMs / 1000)}s` : stderr };
  } finally { clearTimeout(timer); }
};

export function realDeps(home: string, env: Record<string, string | undefined> = process.env): UpdateDeps {
  const moduleDir = import.meta.dir;
  return { fetch: (url, init) => fetch(url, init), run: spawnRunner, now: Date.now, home, moduleDir, userHome: homedir(), env, version: runningVersion(moduleDir) };
}
