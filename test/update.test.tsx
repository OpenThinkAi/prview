import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { availableNotice, backgroundCheck, CHECK_EVERY_MS, compare, installArgv, managerOf, newer, PACKAGE, REGISTRY, runningVersion, updateCommand, type UpdateDeps } from "../src/update.ts";
import { parseDiff } from "../src/diff.ts";
import { hunksOf } from "../src/guide.ts";
import type { Review } from "../src/build.ts";
import type { Doc } from "../src/document.ts";
import { App } from "../src/tui.tsx";

// Every test stubs the registry and the installer: nothing here touches the network or installs anything.

const tmp = mkdtempSync(join(tmpdir(), "prview-update-"));
const savedHome = process.env.PRVIEW_HOME;
afterAll(() => {
  cleanup(); rmSync(tmp, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PRVIEW_HOME; else process.env.PRVIEW_HOME = savedHome;
});

const USER = "/Users/u";
const NPM_DIR = "/usr/local/lib/node_modules/@openthink/prview/src";
const BUN_DIR = `${USER}/.bun/install/global/node_modules/@openthink/prview/src`;
const SOURCE_DIR = "/Users/u/Development/prview/src";
const DAY = CHECK_EVERY_MS;
let n = 0;

type Stub = { deps: UpdateDeps; fetched: string[]; ran: string[][] };
function stub(o: { latest?: unknown; body?: string; fetchFails?: boolean; ok?: boolean; code?: number; stderr?: string; dir?: string; version?: string; env?: Record<string, string>; now?: number; home?: string } = {}): Stub {
  const fetched: string[] = [], ran: string[][] = [];
  const home = o.home ?? join(tmp, `home-${++n}`);
  const deps: UpdateDeps = {
    fetch: async (url) => {
      fetched.push(url);
      if (o.fetchFails) throw new TypeError("fetch failed");
      return { ok: o.ok ?? true, text: async () => o.body ?? JSON.stringify({ name: PACKAGE, version: o.latest ?? "0.1.3" }) };
    },
    run: async (argv) => { ran.push(argv); return { code: o.code ?? 0, stderr: o.stderr ?? "" }; },
    now: () => o.now ?? 10 * DAY,
    home, moduleDir: o.dir ?? NPM_DIR, userHome: USER, env: o.env ?? {}, version: o.version ?? "0.1.3",
  };
  return { deps, fetched, ran };
}
const off = { autoUpdate: () => false }, on = { autoUpdate: () => true };

// ---------------------------------------------------------------- versions and where this copy came from

test("versions: only a strictly newer 1.2.3 release counts; older, equal, pre-release and junk are ignored", () => {
  expect(newer("0.1.4", "0.1.3")).toBe("0.1.4");
  expect(newer("0.2.0", "0.1.30")).toBe("0.2.0");
  expect(newer("0.1.10", "0.1.9")).toBe("0.1.10"); // numeric, not string, order
  for (const v of ["0.1.3", "0.1.2", "0.0.9", "0.1.4-rc.1", "v0.1.4", "0.1.4 ", "0.1", "latest", "0.1.4; rm -rf /", 14, null, undefined, {}]) expect(newer(v, "0.1.3")).toBeUndefined();
  // Already on a pre-release: its release is newer; another pre-release is never offered.
  expect(newer("0.1.4", "0.1.4-rc.1")).toBe("0.1.4");
  expect(newer("0.1.4-rc.2", "0.1.4-rc.1")).toBeUndefined();
  expect(compare("0.1.4-rc.1", "0.1.4")).toBe(-1);
  expect(newer("0.1.4", undefined)).toBeUndefined();
});

test("the running version is this package's own package.json, wherever prview is run from", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).version;
  expect(runningVersion(join(import.meta.dir, "../src"))).toBe(pkg);
  expect(runningVersion(join(tmp, "nowhere", "src"))).toBeUndefined();
});

test("an installed copy is told from a source checkout by its path; bun's global directory means bun, else npm", () => {
  expect(managerOf(SOURCE_DIR, USER, {})).toBeNull();
  expect(managerOf(`${USER}/Development/prview-auto-update/src`, USER, {})).toBeNull();
  expect(managerOf(NPM_DIR, USER, {})).toBe("npm");
  expect(managerOf(`${USER}/.nvm/versions/node/v22/lib/node_modules/@openthink/prview/src`, USER, {})).toBe("npm");
  expect(managerOf(BUN_DIR, USER, {})).toBe("bun");
  expect(managerOf("/opt/bun/install/global/node_modules/@openthink/prview/src", USER, { BUN_INSTALL: "/opt/bun" })).toBe("bun");
  // A project that merely depends on something with the name in it is not an install of prview.
  expect(managerOf("/x/node_modules/@openthink/prview-extra/src", USER, {})).toBeNull();
});

test("install argv is fixed per package manager, and refuses anything but a release version", () => {
  expect(installArgv("bun", "0.1.4")).toEqual(["bun", "add", "-g", "@openthink/prview@0.1.4"]);
  expect(installArgv("npm", "0.1.4")).toEqual(["npm", "install", "-g", "@openthink/prview@0.1.4"]);
  expect(() => installArgv("npm", "0.1.4 --registry=evil")).toThrow();
});

// ---------------------------------------------------------------- the background check

test("off: a newer release gives the footer notice and installs nothing", async () => {
  const s = stub({ latest: "0.1.4" });
  expect(await backgroundCheck(s.deps, off)).toBe("prview 0.1.4 is available — run prview update, or turn on auto-update in \\ settings");
  expect(s.fetched).toEqual([REGISTRY]);
  expect(s.ran).toEqual([]);
});

test("on: a newer release installs in the background with the manager that installed this copy", async () => {
  const npm = stub({ latest: "0.1.4" });
  let started = "";
  expect(await backgroundCheck(npm.deps, { ...on, installing: (v) => { started = v; } })).toBe("updated to 0.1.4 — restart prview to use it");
  expect(npm.ran).toEqual([["npm", "install", "-g", "@openthink/prview@0.1.4"]]);
  expect(started).toBe("0.1.4");
  expect(existsSync(join(npm.deps.home, "update.lock"))).toBe(false); // released
  const bun = stub({ latest: "0.1.4", dir: BUN_DIR });
  await backgroundCheck(bun.deps, on);
  expect(bun.ran).toEqual([["bun", "add", "-g", "@openthink/prview@0.1.4"]]);
});

test("on: a failed install says so, with the installer's last line (control characters removed)", async () => {
  const s = stub({ latest: "0.1.4", code: 1, stderr: "npm ERR! code EACCES\nnpm ERR! permission denied \x1b[31m/usr/local/lib\x1b[0m\n" });
  expect(await backgroundCheck(s.deps, on)).toBe("update to 0.1.4 failed (npm exited 1): npm ERR! permission denied /usr/local/lib");
});

test("on: only one install at a time (a lock in $PRVIEW_HOME); a stale lock does not block forever", async () => {
  const s = stub({ latest: "0.1.4" });
  mkdirSync(s.deps.home, { recursive: true });
  writeFileSync(join(s.deps.home, "update.lock"), "123");
  expect(await backgroundCheck(s.deps, on)).toBe("an update is already being installed; prview 0.1.4 is available");
  expect(s.ran).toEqual([]);
  expect(existsSync(join(s.deps.home, "update.lock"))).toBe(true); // not ours to remove
  const later = stub({ latest: "0.1.4", home: s.deps.home, now: Date.now() + DAY });
  expect(await backgroundCheck(later.deps, on)).toBe("updated to 0.1.4 — restart prview to use it");
});

test("throttle: the registry is asked at most once a day; in between, a newer release seen is still noticed (not reinstalled)", async () => {
  const home = join(tmp, "throttle");
  const first = stub({ latest: "0.1.4", home, now: 10 * DAY });
  await backgroundCheck(first.deps, off);
  expect(JSON.parse(readFileSync(join(home, "update.json"), "utf8"))).toEqual({ checked: 10 * DAY, latest: "0.1.4" });
  const soon = stub({ latest: "0.1.5", home, now: 10 * DAY + DAY - 1 });
  expect(await backgroundCheck(soon.deps, off)).toBe(availableNotice("0.1.4"));
  expect(await backgroundCheck(soon.deps, on)).toBeNull();
  expect(soon.fetched).toEqual([]);
  expect(soon.ran).toEqual([]);
  const next = stub({ latest: "0.1.5", home, now: 11 * DAY });
  expect(await backgroundCheck(next.deps, off)).toBe(availableNotice("0.1.5"));
  expect(next.fetched).toHaveLength(1);
  // A stamp from the future (a clock put back) does not stop checks.
  const back = stub({ latest: "0.1.5", home, now: 5 * DAY });
  await backgroundCheck(back.deps, off);
  expect(back.fetched).toHaveLength(1);
});

test("skipped entirely: a source checkout, --dry-run, PRVIEW_NO_UPDATE=1, an unreadable version", async () => {
  for (const [s, o] of [
    [stub({ latest: "9.9.9", dir: SOURCE_DIR }), on],
    [stub({ latest: "9.9.9" }), { ...on, dryRun: true }],
    [stub({ latest: "9.9.9", env: { PRVIEW_NO_UPDATE: "1" } }), on],
    [stub({ latest: "9.9.9", version: "" }), on],
  ] as const) {
    expect(await backgroundCheck(s.deps, o)).toBeNull();
    expect(s.fetched).toEqual([]);
    expect(s.ran).toEqual([]);
    expect(existsSync(join(s.deps.home, "update.json"))).toBe(false);
  }
});

test("the registry is untrusted: errors, bad JSON, older, pre-release and odd versions are silent and install nothing", async () => {
  for (const o of [{ fetchFails: true }, { ok: false }, { body: "<html>" }, { body: "null" }, { latest: "0.1.2" }, { latest: "0.1.3" }, { latest: "0.1.4-beta.1" }, { latest: "0.1.4\n" }, { latest: ["0.1.4"] }, { body: "x".repeat(2_000_000) }]) {
    const s = stub(o);
    expect(await backgroundCheck(s.deps, on)).toBeNull();
    expect(s.ran).toEqual([]);
  }
});

// ---------------------------------------------------------------- prview update

test("prview update: installs a newer release whatever the setting, printing current → new", async () => {
  const s = stub({ latest: "0.1.4", dir: BUN_DIR });
  expect(await updateCommand(s.deps)).toEqual({ ok: true, lines: ["0.1.3 → 0.1.4: bun add -g @openthink/prview@0.1.4", "updated to 0.1.4 — restart prview to use it"] });
  expect(s.ran).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(s.deps.home, "update.json"), "utf8")).latest).toBe("0.1.4");
});

test("prview update: already on the latest, a failure, --dry-run, no registry", async () => {
  expect(await updateCommand(stub({ latest: "0.1.3" }).deps)).toEqual({ ok: true, lines: ["already on the latest (0.1.3)"] });
  expect((await updateCommand(stub({ latest: "0.1.4", code: 243, stderr: "boom" }).deps)).lines[1]).toBe("update to 0.1.4 failed (npm exited 243): boom");
  const dry = stub({ latest: "0.1.4" });
  expect(await updateCommand(dry.deps, { dryRun: true })).toEqual({ ok: true, lines: ["0.1.3 → 0.1.4: would run npm install -g @openthink/prview@0.1.4 (--dry-run: nothing installed)"] });
  expect(dry.ran).toEqual([]);
  expect(await updateCommand(stub({ fetchFails: true }).deps)).toEqual({ ok: false, lines: ["cannot check for updates: the npm registry could not be reached"] });
});

test("prview update: a source checkout refuses to update itself and asks nothing of the registry", async () => {
  const s = stub({ latest: "0.1.4", dir: SOURCE_DIR });
  const u = await updateCommand(s.deps);
  expect(u.ok).toBe(false);
  expect(u.lines[0]).toBe("this is a source checkout (/Users/u/Development/prview), version 0.1.3; it never updates itself.");
  expect(s.fetched).toEqual([]);
  expect(s.ran).toEqual([]);
});

test("prview update from this checkout (the real CLI): says it is a source checkout, exits 1, installs nothing", () => {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.tsx"), "update"], { env: { ...process.env, PRVIEW_HOME: join(tmp, "cli-home") } });
  expect(p.exitCode).toBe(1);
  expect(p.stderr.toString()).toContain("is a source checkout");
  expect(p.stderr.toString()).toContain("it never updates itself");
  expect(existsSync(join(tmp, "cli-home", "update.json"))).toBe(false);
});

// ---------------------------------------------------------------- the footer

test("screen: the check's note arrives in the footer when it finishes, without holding up the screen", async () => {
  const files = parseDiff("diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n");
  const [h] = hunksOf(files);
  const doc: Doc = {
    schema: "prview-review/1",
    target: { repo: "/nowhere", base: "a", head: "b", title: "A change", body: "", label: "main..x" },
    plan: { summary: "", by: "guide", mechanical: [], chapters: [{ title: "Core", intent: "Check it", why: "Because.", hunks: [h!.id] }] },
    findings: [], human: { comments: [], visited: [] },
  };
  const review: Review = { slug: "update", repo: "/nowhere", worktree: "/nowhere", context: 3, created: "now", pos: { item: 0, line: 0 }, doc };
  process.env.PRVIEW_HOME = join(tmp, "screen-home");
  let answer!: (t: string | null) => void;
  const update = new Promise<string | null>((r) => { answer = r; });
  const app = render(<App review={review} files={files} onDone={() => {}} update={update} size={{ cols: 120, rows: 30 }} />);
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  expect(app.lastFrame()).toContain("A change");
  expect(app.lastFrame()).not.toContain("is available");
  answer(availableNotice("0.1.4"));
  await settle();
  expect(app.lastFrame()).toContain("prview 0.1.4 is available — run prview update, or turn on auto-update in \\ settings");
  app.unmount();
});
