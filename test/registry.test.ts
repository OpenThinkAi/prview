// The platform registry (src/registry.ts) and the GitHub source (src/github.ts): parsing PR URLs and remotes is
// pure; resolving and reopening run against a stub `gh` on PATH and a local bare repo standing in for GitHub,
// so nothing here touches a network.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { github } from "../src/github.ts";
import { prSlug, remoteFor } from "../src/pr.ts";
import { isPR, parseRef, prIn, sourceOf, SOURCES } from "../src/registry.ts";
import { adapterFor } from "../src/platform.ts";

const tmp = mkdtempSync(join(tmpdir(), "prview-registry-"));
const saved = { home: process.env.PRVIEW_HOME, path: process.env.PATH };
beforeAll(() => { process.env.PRVIEW_HOME = join(tmp, "store"); });
afterAll(() => {
  if (saved.home === undefined) delete process.env.PRVIEW_HOME; else process.env.PRVIEW_HOME = saved.home;
  process.env.PATH = saved.path;
  rmSync(tmp, { recursive: true, force: true });
});

const g = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...a], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

test("github parses its PR URLs to a canonical ref; anything else is not its", () => {
  const want = { platform: "github", url: "https://github.com/o/r/pull/7", repoKey: "o/r", number: 7, label: "o/r#7" };
  expect(github.parse("https://github.com/o/r/pull/7")).toEqual(want);
  expect(github.parse("https://github.com/o/r/pull/7/files?diff=split#r1")).toEqual(want);
  expect(github.parse("http://www.github.com/o/r/pull/007")).toEqual(want);
  expect(github.parse("github.com/o/r/pull/7")).toEqual(want);
  expect(github.parse("https://github.com/Org/Repo.js/pull/12")?.repoKey).toBe("Org/Repo.js");
  for (const not of ["https://github.com/o/r", "https://github.com/o/r/issues/7", "https://gitlab.com/o/r/-/merge_requests/7", "main..feature", "7", "#7", ""]) expect(github.parse(not)).toBeUndefined();
});

test("github's remote key is the path's last two parts on any host, so a mirror of o/r still counts", () => {
  for (const url of ["https://github.com/o/r", "https://github.com/O/R.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "ssh://git@stamp.example:2222/srv/o/r.git", "file:///nowhere/o/r"]) expect(github.remoteKey(url)).toBe("o/r");
  expect(github.remoteKey("file:///nowhere/notevil/pwn")).toBe("notevil/pwn");
  expect(github.remoteKey("o/r")).toBeUndefined();
});

test("the registry: a URL goes to the platform that claims it, a number or #n is a PR, a range is not", () => {
  expect(SOURCES.at(-1)).toBe(github); // the fallback for a bare number goes last
  expect(sourceOf("GitHub")).toBe(github);
  expect(sourceOf("gitlab")).toBeUndefined();
  expect(sourceOf(undefined)).toBeUndefined();
  expect(adapterFor(sourceOf("github")!.platform)?.platform).toBe("github"); // the read and post sides share the id
  expect(parseRef("https://github.com/o/r/pull/7/files")?.url).toBe("https://github.com/o/r/pull/7");
  expect(parseRef(undefined)).toBeUndefined();
  expect(parseRef("https://example.com/o/r/pull/7")).toBeUndefined();
  for (const yes of ["7", "#7", "https://github.com/o/r/pull/7"]) expect(isPR(yes)).toBe(true);
  for (const no of [undefined, "", "main..feature", "feature", "7a", "https://example.com/o/r/pull/7"]) expect(isPR(no)).toBe(false);
});

test("prIn: a URL keeps its ref; a bare number in a clone is the clone's PR, on GitHub when no other platform claims it", () => {
  const clone = join(tmp, "prin");
  mkdirSync(clone); g(clone, "init", "-q");
  g(clone, "remote", "add", "origin", "ssh://git@stamp.example/srv/o/r.git");
  expect(prIn(clone, "#12")).toEqual({ source: github, ref: 12 });
  expect(prIn(clone, "12").source).toBe(github);
  const viaUrl = prIn(clone, "https://github.com/o/r/pull/5");
  expect(viaUrl.source).toBe(github);
  expect(viaUrl.ref).toEqual(github.parse("https://github.com/o/r/pull/5")!);
});

test("remoteFor finds the clone's remote for a ref by the platform's key, case-insensitively, and nothing that merely ends alike", () => {
  const clone = join(tmp, "remotes");
  mkdirSync(clone); g(clone, "init", "-q");
  const ref = github.parse("https://github.com/Evil/Pwn/pull/9")!;
  expect(remoteFor(clone, github, ref)).toBeUndefined();
  g(clone, "remote", "add", "other", "file:///nowhere/notevil/pwn");
  g(clone, "remote", "add", "fork", "https://github.com/evil/pwn-fork.git");
  expect(remoteFor(clone, github, ref)).toBeUndefined();
  g(clone, "remote", "add", "gh", "git@github.com:evil/pwn.git");
  expect(remoteFor(clone, github, ref)).toBe("gh");
});

// A clone whose remote stands in for github.com/o/r: a local bare repo at .../o/r.git with the PR head under refs/pull/7/head,
// and a stub `gh` that answers `pr view` the way GitHub would and logs every argv it got.
function stubGitHub() {
  const work = join(tmp, "work"), bare = join(tmp, "o", "r.git"), clone = join(tmp, "clone"), bin = join(tmp, "bin");
  mkdirSync(work, { recursive: true }); mkdirSync(join(tmp, "o"), { recursive: true }); mkdirSync(bin, { recursive: true });
  g(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "1\n"); g(work, "add", "."); g(work, "commit", "-qm", "init");
  g(work, "checkout", "-qb", "feature");
  writeFileSync(join(work, "a.txt"), "1\n2\n"); g(work, "commit", "-qam", "add two");
  const head = g(work, "rev-parse", "HEAD");
  g(tmp, "clone", "-q", "--bare", work, bare);
  g(bare, "update-ref", "refs/pull/7/head", head);
  g(tmp, "clone", "-q", "--no-local", "-b", "main", bare, clone);
  g(clone, "remote", "rename", "origin", "upstream"); // not called origin: the remote is found by its key, not its name
  const log = join(tmp, "gh.log");
  writeFileSync(log, "");
  const reply = JSON.stringify({ number: 7, title: "Add two", body: "the body", url: "https://github.com/o/r/pull/7", headRefOid: head, baseRefName: "main" });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf '%s' '${reply}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${saved.path}`;
  return { clone, head, log: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

test("github resolves a PR through gh, fetches its head from the matching remote, and the review stores the canonical URL as its ref", async () => {
  const { clone, head, log } = stubGitHub();
  const { build, load, reopen, save } = await import("../src/build.ts");
  const r = await build(clone, "#7", { ai: null });
  expect(log()).toEqual(["pr view 7 --json number,title,body,url,headRefOid,baseRefName"]);
  expect(r.slug).toBe(prSlug(clone, 7));
  expect(r.ref).toBe("https://github.com/o/r/pull/7");
  expect(r.doc.target).toMatchObject({ repo: "o/r", head, url: "https://github.com/o/r/pull/7", platform: "github", title: "Add two", body: "the body", label: "o/r#7" });
  expect(g(clone, "rev-parse", "refs/prview/pr-7/head")).toBe(head);

  // Reopening asks gh for the URL, not a number that would mean whatever PR 7 is in the clone it runs in.
  await reopen(r.slug, { ai: null });
  expect(log().at(-1)).toBe("pr view https://github.com/o/r/pull/7 --json number,title,body,url,headRefOid,baseRefName");

  // A review stored before refs were URLs, with a bare number, still reopens on GitHub.
  save({ ...load(r.slug), ref: "7" });
  const old = await reopen(r.slug, { ai: null });
  expect(log().at(-1)).toBe("pr view 7 --json number,title,body,url,headRefOid,baseRefName");
  expect(old.doc.target.platform).toBe("github");
  expect(old.ref).toBe("https://github.com/o/r/pull/7"); // and is stored with the URL from then on
});
