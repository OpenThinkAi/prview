import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff, type FileDiff } from "../src/diff.ts";
import { build } from "../src/build.ts";
import { SCHEMA, type Doc } from "../src/document.ts";
import type { Submitted } from "../src/history.ts";
import { latestSubmission, rereviewOf, reviewedRef } from "../src/rereview.ts";
import {
  blockChanged, changedBlocks, changedRanges, GONE_NOTE, lineChanged, lineMaps, mapLine, parseNameStatus, pathsToDiff, REBASED_NOTE,
  sinceFile, sinceFiles, sinceLabel, sinceOf, type Since, type SinceFile,
} from "../src/since.ts";

// "Since your review" (AGT-1512): the pure ranges and line mapping, then the git behind them in scratch repos (a rebase,
// a rename, a file removed or added since, a reviewed head that has to be fetched or is gone). No network: the "GitHub"
// remote is a local bare repo whose path reads as o/r.
let tmp = "", saved: string | undefined;
beforeAll(() => { saved = process.env.PRVIEW_HOME; tmp = mkdtempSync(join(tmpdir(), "prview-since-")); process.env.PRVIEW_HOME = join(tmp, "home"); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); if (saved === undefined) delete process.env.PRVIEW_HOME; else process.env.PRVIEW_HOME = saved; });

// ---------------------------------------------------------------- pure

const f = (over: Partial<SinceFile> & Pick<SinceFile, "hunks">): SinceFile => ({ path: "a.ts", status: "modified", ...over });
const at = (s: Partial<Since>): Since => ({ head: "a".repeat(40), at: "2026-09-30T10:00:00.000Z", ...s });

test("ranges: a stretch of new lines is its range, a removal the two lines either side; the gutter marks only new lines", () => {
  const x = f({ hunks: [{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 2 }, { oldStart: 20, oldCount: 3, newStart: 20, newCount: 0 }] });
  expect(changedRanges(x)).toEqual([[5, 6], [20, 21]]);
  expect([4, 5, 6, 7, 20, 21].map((n) => lineChanged(x, n))).toEqual([false, true, true, false, false, false]);
  expect(lineChanged(x, null)).toBe(false);
  expect(lineChanged(f({ status: "added", hunks: [] }), 99)).toBe(true);
  expect(lineChanged(undefined, 5)).toBe(false);
});

test("blocks: a PR block overlapping a changed range (context included) is changed; a file added or removed since is changed whole", () => {
  const x = f({ hunks: [{ oldStart: 15, oldCount: 1, newStart: 15, newCount: 1 }, { oldStart: 40, oldCount: 2, newStart: 39, newCount: 0 }] });
  expect(blockChanged(x, { newStart: 2, newCount: 7 })).toBe(false); // lines 2-8
  expect(blockChanged(x, { newStart: 12, newCount: 7 })).toBe(true); // 12-18 holds 15
  expect(blockChanged(x, { newStart: 16, newCount: 3 })).toBe(false);
  expect(blockChanged(x, { newStart: 36, newCount: 4 })).toBe(true); // 36-39 touches where two lines went
  expect(blockChanged(x, { newStart: 14, newCount: 0 })).toBe(true); // a block that only removes, between 14 and 15
  expect(blockChanged(f({ status: "added", hunks: [] }), { newStart: 1, newCount: 1 })).toBe(true);
  expect(blockChanged(f({ status: "removed", hunks: [] }), { newStart: 0, newCount: 0 })).toBe(true);
  expect(blockChanged(f({ status: "renamed", oldPath: "o.ts", hunks: [] }), { newStart: 1, newCount: 9 })).toBe(false); // a rename alone
  expect(blockChanged(undefined, { newStart: 1, newCount: 9 })).toBe(false);
  const items = [{ id: "a.ts@2:2", path: "a.ts", hunk: { newStart: 2, newCount: 7 } }, { id: "a.ts@12:12", path: "a.ts", hunk: { newStart: 12, newCount: 7 } }, { id: "b.ts@1:1", path: "b.ts", hunk: { newStart: 1, newCount: 3 } }];
  expect([...changedBlocks(items, at({ files: [x] }))]).toEqual(["a.ts@12:12"]);
  expect(changedBlocks(items, at({ gone: true })).size).toBe(0);
  expect(changedBlocks(items, undefined).size).toBe(0);
});

test("old line to new line: shifted by what was added or removed before it, changed inside a stretch, followed through a rename, gone with its file", () => {
  const s = at({ files: [
    f({ path: "b.ts", oldPath: "a.ts", status: "renamed", hunks: [{ oldStart: 3, oldCount: 0, newStart: 4, newCount: 2 }, { oldStart: 10, oldCount: 2, newStart: 12, newCount: 1 }] }),
    f({ path: "gone.ts", status: "removed", hunks: [{ oldStart: 1, oldCount: 4, newStart: 0, newCount: 0 }] }),
    f({ path: "new.ts", status: "added", hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 }] }),
  ] });
  expect(mapLine(s, "a.ts", 2)).toEqual({ kind: "same", path: "b.ts", line: 2 });
  expect(mapLine(s, "a.ts", 3)).toEqual({ kind: "same", path: "b.ts", line: 3 }); // two lines were added after line 3
  expect(mapLine(s, "a.ts", 4)).toEqual({ kind: "same", path: "b.ts", line: 6 });
  expect(mapLine(s, "a.ts", 10)).toEqual({ kind: "changed", path: "b.ts", near: 12 });
  expect(mapLine(s, "a.ts", 11)).toEqual({ kind: "changed", path: "b.ts", near: 12 });
  expect(mapLine(s, "a.ts", 12)).toEqual({ kind: "same", path: "b.ts", line: 13 }); // +2 then -1
  expect(mapLine(s, "gone.ts", 2)).toEqual({ kind: "removed", path: "gone.ts" });
  expect(mapLine(s, "other.ts", 7)).toEqual({ kind: "same", path: "other.ts", line: 7 });
  expect(mapLine(s, "new.ts", 1)).toEqual({ kind: "same", path: "new.ts", line: 1 }); // added since: no old lines to map
  expect(lineMaps(s)("a.ts", 4)).toEqual(mapLine(s, "a.ts", 4));
  expect(mapLine(undefined, "a.ts", 4)).toEqual({ kind: "same", path: "a.ts", line: 4 });
});

test("name-status: renames carry both names; the paths diffed are the PR's files and the paths commented on, upstream files left out", () => {
  const z = ["M", "a.ts", "R087", "old.ts", "new.ts", "D", "b.ts", "A", "up.ts", "M", "commented.ts", ""].join("\0");
  const e = parseNameStatus(z);
  expect(e).toEqual([{ status: "M", old: "a.ts", path: "a.ts" }, { status: "R", old: "old.ts", path: "new.ts" }, { status: "D", old: "b.ts", path: "b.ts" }, { status: "A", old: "up.ts", path: "up.ts" }, { status: "M", old: "commented.ts", path: "commented.ts" }]);
  const pr: FileDiff[] = ["a.ts", "new.ts", "b.ts"].map((path) => ({ path, status: "modified", binary: false, hunks: [] }));
  expect(pathsToDiff(e, pr)).toEqual(["a.ts", "b.ts", "new.ts", "old.ts"]);
  expect(pathsToDiff(e, pr, ["commented.ts"])).toEqual(["a.ts", "b.ts", "commented.ts", "new.ts", "old.ts"]);
});

test("stored layer: read back whole, malformed parts dropped; a gone head keeps no files; the label is sha7 and day", () => {
  const s = at({ rebased: true, files: [f({ hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }] })] });
  expect(sinceOf(JSON.parse(JSON.stringify(s)))).toEqual(s);
  expect(sinceOf({ head: "nope", at: "x" })).toBeUndefined();
  expect(sinceOf(null)).toBeUndefined();
  expect(sinceOf({ ...s, files: [{ path: 1 }, { path: "x", status: "weird", hunks: [] }, { path: "y", status: "added", hunks: [{ oldStart: -1 }] }] })).toEqual({ head: s.head, at: s.at, rebased: true, files: [{ path: "y", status: "added", hunks: [] }] });
  expect(sinceOf({ ...s, gone: true })).toEqual({ head: s.head, at: s.at, rebased: true, gone: true });
  expect(sinceLabel({ head: "0123456789abcdef", at: "2026-09-30T10:00:00.000Z" })).toBe("0123456 2026-09-30");
  expect(sinceFile(s, "a.ts")?.status).toBe("modified");
  expect(sinceFile(at({ gone: true }), "a.ts")).toBeUndefined();
});

// ---------------------------------------------------------------- git

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
const lines = (n: number, tag = "l") => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join("\n") + "\n";
const edit = (text: string, line: number, to: string) => text.split("\n").map((l, i) => i === line - 1 ? to : l).join("\n");
let repos = 0;
function repoWith(files: Record<string, string>): string {
  const dir = join(tmp, `repo${++repos}`);
  mkdirSync(dir, { recursive: true });
  sh(["git", "init", "-q", "-b", "main"], dir);
  commit(dir, files, "base");
  return dir;
}
function commit(dir: string, files: Record<string, string | null>, msg: string): string {
  for (const [p, text] of Object.entries(files)) {
    if (text === null) sh(["git", "rm", "-q", p], dir);
    else { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), text); sh(["git", "add", p], dir); }
  }
  sh(["git", "commit", "-q", "-m", msg], dir);
  return sh(["git", "rev-parse", "HEAD"], dir);
}
const prFiles = (dir: string, base: string, head: string) => parseDiff(sh(["git", "diff", "-M", "--no-color", "-U3", base, head], dir) + "\n");
const latest = (head: string, extra: Partial<Submitted> = {}): Submitted => ({ file: "x", slug: "s", doc: { schema: SCHEMA, target: { repo: "r", base: "", head, title: "", body: "", label: "" }, plan: { summary: "", chapters: [], mechanical: [], by: "files" }, findings: [], human: { comments: [], visited: [] } } as Doc, at: "2026-09-30T10:00:00.000Z", head, legacy: false, ...extra });
const target = (base: string, head: string, url?: string) => ({ repo: "r", base, head, title: "t", body: "", label: "main..x", ...(url ? { url, platform: "github" } : {}) });

test("ancestor: only what moved since the reviewed head is marked; a file removed, added or renamed since; unchanged files left out", () => {
  const A20 = lines(20);
  const dir = repoWith({ "a.ts": A20, "b.ts": lines(10, "b"), "d.ts": lines(5, "d") });
  const base = sh(["git", "rev-parse", "HEAD"], dir);
  sh(["git", "checkout", "-q", "-b", "x"], dir);
  const reviewed = commit(dir, { "a.ts": edit(A20, 5, "five"), "b.ts": edit(lines(10, "b"), 2, "two"), "d.ts": edit(lines(5, "d"), 1, "one"), "r.ts": lines(8, "r") }, "reviewed");
  sh(["git", "mv", "r.ts", "s.ts"], dir);
  const head = commit(dir, { "a.ts": edit(edit(A20, 5, "five"), 15, "fifteen"), "b.ts": null, "s.ts": edit(lines(8, "r"), 3, "three"), "n.ts": lines(3, "n") }, "after review");
  const files = prFiles(dir, base, head), said: string[] = [];
  const s = rereviewOf(dir, "s", target(base, head), files, (x) => said.push(x), latest(reviewed))!;
  expect(s.head).toBe(reviewed);
  expect(s.rebased).toBeUndefined();
  expect(s.gone).toBeUndefined();
  const by = Object.fromEntries(s.files!.map((x) => [x.path, x]));
  expect(Object.keys(by).sort()).toEqual(["a.ts", "b.ts", "n.ts", "s.ts"]);
  expect(by["a.ts"]!.hunks).toEqual([{ oldStart: 15, oldCount: 1, newStart: 15, newCount: 1 }]);
  expect(by["b.ts"]!.status).toBe("removed");
  expect(by["n.ts"]!.status).toBe("added");
  expect(by["s.ts"]).toMatchObject({ status: "renamed", oldPath: "r.ts", hunks: [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 }] });
  // The PR's blocks: a.ts's block round line 5 was read and has not moved; the one round 15 is new; d.ts is as it was.
  const items = files.flatMap((x) => x.hunks.map((h) => ({ id: `${x.path}@${h.newStart}`, path: x.path, hunk: h })));
  expect([...changedBlocks(items, s)].sort()).toEqual(["a.ts@12", "b.ts@0", "n.ts@1", "s.ts@1"]);
  expect(mapLine(s, "r.ts", 5)).toEqual({ kind: "same", path: "s.ts", line: 5 });
  expect(mapLine(s, "b.ts", 2)).toEqual({ kind: "removed", path: "b.ts" });
  expect(said.join("\n")).toMatch(new RegExp(`re-review · since ${reviewed.slice(0, 7)} 2026-09-30: 4 files of the PR changed since your review; v s shows only those`));
  // Not a re-review: nothing submitted, or submitted at this very head.
  expect(rereviewOf(dir, "s", target(base, head), files, () => {}, undefined)).toBeUndefined();
  expect(rereviewOf(dir, "s", target(base, head), files, () => {}, latest(head))).toBeUndefined();
});

test("rebased: the reviewed head is not an ancestor; still diffed old → new for the PR's files, with the note; upstream-only files left out", () => {
  const A20 = lines(20);
  const dir = repoWith({ "a.ts": A20, "e.ts": lines(4, "e") });
  const base = sh(["git", "rev-parse", "HEAD"], dir);
  sh(["git", "checkout", "-q", "-b", "x"], dir);
  const reviewed = commit(dir, { "a.ts": edit(A20, 5, "five") }, "reviewed");
  sh(["git", "checkout", "-q", "main"], dir);
  const main2 = commit(dir, { "a.ts": edit(A20, 18, "upstream"), "e.ts": lines(6, "e") }, "upstream");
  sh(["git", "checkout", "-q", "-B", "x", main2], dir);
  const head = commit(dir, { "a.ts": edit(edit(A20, 18, "upstream"), 5, "five") }, "rebased");
  const said: string[] = [];
  const s = rereviewOf(dir, "s", target(main2, head), prFiles(dir, main2, head), (x) => said.push(x), latest(reviewed))!;
  expect(s.rebased).toBe(true);
  expect(s.files!.map((x) => x.path)).toEqual(["a.ts"]);
  expect(s.files![0]!.hunks).toEqual([{ oldStart: 18, oldCount: 1, newStart: 18, newCount: 1 }]); // upstream's change shows as new
  expect(said.join("\n")).toContain(REBASED_NOTE);
});

test("gone: a reviewed head the clone does not have and nothing can fetch is no layer, with the note", () => {
  const dir = repoWith({ "a.ts": lines(3) });
  const base = sh(["git", "rev-parse", "HEAD"], dir);
  const head = commit(dir, { "a.ts": lines(4) }, "x");
  const said: string[] = [];
  const s = rereviewOf(dir, "s", target(base, head), prFiles(dir, base, head), (x) => said.push(x), latest("f".repeat(40)))!;
  expect(s).toEqual({ head: "f".repeat(40), at: "2026-09-30T10:00:00.000Z", gone: true });
  expect(said.join("\n")).toContain(GONE_NOTE);
  // A PR whose clone has no remote for its repository cannot fetch it either.
  const pr = rereviewOf(dir, "s", target(base, head, "https://github.com/o/r/pull/7"), prFiles(dir, base, head), () => {}, latest("f".repeat(40)))!;
  expect(pr.gone).toBe(true);
});

test("fetched: a reviewed head force-pushed away is fetched from the PR's remote by commit id and kept by a ref", () => {
  // The "GitHub" remote: a bare repo at …/o/r.git (its path reads as o/r), which serves any commit by id as GitHub does.
  const origin = join(tmp, "gh", "o", "r.git");
  mkdirSync(origin, { recursive: true });
  sh(["git", "init", "-q", "--bare"], origin);
  sh(["git", "config", "uploadpack.allowAnySHA1InWant", "true"], origin);
  const work = repoWith({ "a.ts": lines(20) });
  const base = sh(["git", "rev-parse", "HEAD"], work);
  const reviewed = commit(work, { "a.ts": edit(lines(20), 5, "five") }, "reviewed");
  sh(["git", "push", "-q", origin, `${reviewed}:refs/heads/tmp`], work);
  sh(["git", "reset", "-q", "--hard", base], work);
  const head = commit(work, { "a.ts": edit(edit(lines(20), 5, "five"), 15, "fifteen") }, "force-pushed");
  sh(["git", "push", "-q", "-f", origin, `${head}:refs/pull/7/head`, `${head}:refs/heads/main`], work);
  sh(["git", "push", "-q", origin, ":refs/heads/tmp"], work);
  // A clone that never saw the reviewed head.
  const clone = join(tmp, "clone");
  sh(["git", "clone", "-q", "--no-local", origin, clone], tmp);
  expect(Bun.spawnSync(["git", "cat-file", "-e", `${reviewed}^{commit}`], { cwd: clone }).exitCode).not.toBe(0);
  const s = rereviewOf(clone, "s", target(base, head, "https://github.com/o/r/pull/7"), prFiles(work, base, head), () => {}, latest(reviewed))!;
  expect(s.gone).toBeUndefined();
  expect(s.rebased).toBe(true);
  expect(s.files![0]!.hunks).toEqual([{ oldStart: 15, oldCount: 1, newStart: 15, newCount: 1 }]);
  expect(sh(["git", "rev-parse", reviewedRef(7)], clone)).toBe(reviewed);
});

test("build: a review opened again after a submit at an older head is a re-review (the legacy flat record too), said at startup", async () => {
  const dir = repoWith({ "a.ts": lines(20) });
  sh(["git", "checkout", "-q", "-b", "feat"], dir);
  const reviewed = commit(dir, { "a.ts": edit(lines(20), 5, "five") }, "reviewed");
  const first = await build(dir, "main..feat", { ai: null });
  expect(first.since).toBeUndefined();
  // The submit before every submit was kept: one flat submitted/<slug>.json, its document at the head it reviewed.
  mkdirSync(join(process.env.PRVIEW_HOME!, "submitted"), { recursive: true });
  writeFileSync(join(process.env.PRVIEW_HOME!, "submitted", `${first.slug}.json`), JSON.stringify({ ...first.doc, submissions: [{ at: "2026-09-29T08:00:00.000Z", file: "x" }] }));
  expect(latestSubmission(first.doc.target, first.slug)?.head).toBe(reviewed);
  const same = await build(dir, "main..feat", { ai: null });
  expect(same.since).toBeUndefined(); // submitted at this head: not a re-review
  const head = commit(dir, { "a.ts": edit(edit(lines(20), 5, "five"), 15, "fifteen") }, "after");
  const said: string[] = [];
  const again = await build(dir, "main..feat", { ai: null, say: (x) => said.push(x) });
  expect(again.doc.target.head).toBe(head);
  expect(again.since).toMatchObject({ head: reviewed, at: "2026-09-29T08:00:00.000Z", files: [{ path: "a.ts", status: "modified" }] });
  expect(said).toContain(`re-review · since ${reviewed.slice(0, 7)} 2026-09-29: 1 file of the PR changed since your review; v s shows only those`);
  // Never part of the document (nothing of it can be posted or exported).
  expect(JSON.stringify(again.doc)).not.toContain("since");
  // `v s` stays on while the head does.
  again.sinceOnly = true;
  (await import("../src/build.ts")).save(again);
  expect((await build(dir, "main..feat", { ai: null })).sinceOnly).toBe(true);
});
