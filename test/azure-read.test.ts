// The Azure DevOps read path (src/azure.ts resolve/fetch, src/azure-api.ts): a fake Http answers the REST calls and a
// local bare repo stands in for the Azure remote. The clone's remote has an Azure SSH shape (an ssh-config style alias),
// and GIT_SSH_COMMAND is a script that serves the bare repo with git-upload-pack, so git really fetches, with no network.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Http, HttpReq } from "../src/azure-auth.ts";
import { headOf, prApi } from "../src/azure-api.ts";
import { azure } from "../src/azure.ts";

const tmp = mkdtempSync(join(tmpdir(), "prview-azure-read-"));
const saved = { home: process.env.PRVIEW_HOME, ssh: process.env.GIT_SSH_COMMAND, variant: process.env.GIT_SSH_VARIANT, bare: process.env.PRVIEW_TEST_BARE, mark: process.env.PRVIEW_TEST_REFUSE };
process.env.PRVIEW_HOME = join(tmp, "store");
const { build, exportDocument, importDocument, load, remove } = await import("../src/build.ts");

const g = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...a], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

const URL_ = "https://dev.azure.com/org/Proj/_git/Repo/pullrequest/7";
const REMOTE = "git@azure-test:v3/org/Proj/Repo";
const MARK = join(tmp, "refuse-once");
let src = "", head = "", main = "", mergeSha = "";

/** A bare repo standing in for the Azure remote: main, and optionally the source branch, the merge ref, sha-by-id. */
function bare(name: string, o: { branch?: boolean; merge?: boolean; bySha?: boolean }): string {
  const b = join(tmp, `${name}.git`);
  g(tmp, "init", "-q", "--bare", b);
  g(src, "push", "-q", b, "main:refs/heads/main", ...(o.branch ? ["feature:refs/heads/feature"] : []), ...(o.merge ? [`${mergeSha}:refs/pull/7/merge`] : []), ...(!o.branch && !o.merge ? [`${head}:refs/keep/x`] : []));
  if (o.bySha) g(b, "config", "uploadpack.allowReachableSHA1InWant", "true");
  return b;
}

function clone(name: string, remote = REMOTE): string {
  const d = join(tmp, name);
  mkdirSync(d);
  g(d, "init", "-q");
  g(d, "remote", "add", "origin", remote);
  return d;
}

/** The fake REST side: the PR and its iterations, every request recorded. */
function fakeHttp(pr: Record<string, unknown> = {}, iterHead: string | null = head): Http & { calls: HttpReq[] } {
  const calls: HttpReq[] = [];
  const http = (async (req: HttpReq) => {
    calls.push(req);
    if (req.url.includes("/pullRequests/7/iterations?")) return { status: 200, json: { value: iterHead ? [{ id: 1, sourceRefCommit: { commitId: "1".repeat(40) } }, { id: 2, sourceRefCommit: { commitId: iterHead } }] : [] }, text: "" };
    if (req.url.includes("/pullRequests/7?")) {
      const body = { pullRequestId: 7, title: "Add \x1b[31mthe\x1b[0m thing", description: "Why it matters.", status: "active", isDraft: false, sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", lastMergeSourceCommit: { commitId: head }, forkSource: null, ...pr };
      return { status: 200, json: body, text: JSON.stringify(body) };
    }
    return { status: 404, json: { message: "nope" }, text: "nope" };
  }) as Http & { calls: HttpReq[] };
  http.calls = calls;
  return http;
}

const refs = (repo: string) => Bun.spawnSync(["git", "for-each-ref", "--format=%(refname)", "refs/prview"], { cwd: repo }).stdout.toString().trim().split("\n").filter(Boolean);

beforeAll(() => {
  src = join(tmp, "src");
  mkdirSync(src);
  g(src, "init", "-q");
  writeFileSync(join(src, "a.txt"), "one\ntwo\n");
  g(src, "add", "."); g(src, "commit", "-qm", "init");
  g(src, "checkout", "-qb", "feature");
  writeFileSync(join(src, "a.txt"), "one\nTWO\nthree\n");
  g(src, "commit", "-qam", "change");
  head = g(src, "rev-parse", "HEAD");
  g(src, "checkout", "-q", "main");
  writeFileSync(join(src, "b.txt"), "b\n");
  g(src, "add", "."); g(src, "commit", "-qm", "main moves on");
  main = g(src, "rev-parse", "HEAD");
  g(src, "merge", "-q", "--no-ff", "feature", "-m", "trial merge");
  mergeSha = g(src, "rev-parse", "HEAD");
  g(src, "reset", "-q", "--hard", main);
  const ssh = join(tmp, "fake-ssh");
  writeFileSync(ssh, `#!/bin/sh\nif [ -f "$PRVIEW_TEST_REFUSE" ]; then rm -f "$PRVIEW_TEST_REFUSE"; echo "fatal: refused" >&2; exit 128; fi\nexec git-upload-pack "$PRVIEW_TEST_BARE"\n`);
  chmodSync(ssh, 0o755);
  process.env.GIT_SSH_COMMAND = ssh;
  process.env.GIT_SSH_VARIANT = "simple";
  process.env.PRVIEW_TEST_REFUSE = MARK;
});

afterEach(() => rmSync(MARK, { force: true }));

afterAll(() => {
  for (const [k, v] of [["PRVIEW_HOME", saved.home], ["GIT_SSH_COMMAND", saved.ssh], ["GIT_SSH_VARIANT", saved.variant], ["PRVIEW_TEST_BARE", saved.bare], ["PRVIEW_TEST_REFUSE", saved.mark]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

test("the REST URL is the repo route, names encoded, api-version 7.1", () => {
  expect(prApi({ repoKey: "org/Proj/Repo", number: 7 })).toBe("https://dev.azure.com/org/Proj/_apis/git/repositories/Repo/pullRequests/7?api-version=7.1");
  expect(prApi({ repoKey: "my org/My Project/My Repo", number: 3 }, "iterations", { $top: 2000 })).toBe("https://dev.azure.com/my%20org/My%20Project/_apis/git/repositories/My%20Repo/pullRequests/3/iterations?%24top=2000&api-version=7.1");
  // The latest iteration is the head; the last merge's source commit only when there are none.
  expect(headOf({ lastMergeSourceCommit: { commitId: "a".repeat(40) } }, [{ id: 2, sourceRefCommit: { commitId: "C".repeat(40) } }, { id: 1, sourceRefCommit: { commitId: "b".repeat(40) } }])).toBe("c".repeat(40));
  expect(headOf({ lastMergeSourceCommit: { commitId: "a".repeat(40) } }, [])).toBe("a".repeat(40));
  expect(headOf({ lastMergeSourceCommit: { commitId: "nope" } }, [])).toBeUndefined();
});

test("a PR URL opens a review with --no-ai: GETs the PR and its iterations, fetches the head by commit id", async () => {
  process.env.PRVIEW_TEST_BARE = bare("by-sha", { bySha: true });
  const c = clone("c-sha");
  const http = fakeHttp();
  const r = await build(c, URL_ + "?_a=files", { ai: null, http });
  expect(http.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
    "GET https://dev.azure.com/org/Proj/_apis/git/repositories/Repo/pullRequests/7?api-version=7.1",
    "GET https://dev.azure.com/org/Proj/_apis/git/repositories/Repo/pullRequests/7/iterations?api-version=7.1",
  ]);
  expect(r.slug).toBe("c-sha-pr-7");
  expect(r.ref).toBe(URL_); // the canonical URL, so reopening never relies on a bare number
  const t = r.doc.target;
  expect(t).toMatchObject({ platform: "azure-devops", url: URL_, repo: "org/Proj/Repo", head, title: "Add the thing", body: "Why it matters.", label: "Repo!7" });
  expect(t.base).toBe(g(src, "merge-base", "main", head)); // the merge base, not the target's tip
  expect(t.base).not.toBe(main);
  expect(refs(c).sort()).toEqual(["refs/prview/pr-7/base", "refs/prview/pr-7/head"]); // no merge ref was needed
  expect(load(r.slug).doc.target.url).toBe(URL_);
  remove(r.slug);
  expect(refs(c)).toEqual([]);
});

test("a refused commit-id fetch falls back to the merge ref's second parent", async () => {
  process.env.PRVIEW_TEST_BARE = bare("merge-only", { merge: true });
  const c = clone("c-merge");
  const r = await build(c, URL_, { ai: null, http: fakeHttp() });
  expect(r.doc.target.head).toBe(head);
  expect(refs(c)).toContain("refs/prview/pr-7/merge");
  remove(r.slug);
  expect(refs(c)).toEqual([]); // the merge ref is cleaned up with the others
});

test("no merge ref (a conflicting PR): falls back to the source branch", async () => {
  process.env.PRVIEW_TEST_BARE = bare("branch-only", { branch: true });
  writeFileSync(MARK, ""); // the server refuses the first fetch, the one by commit id
  const c = clone("c-branch");
  const r = await build(c, URL_, { ai: null, http: fakeHttp() });
  expect(existsSync(MARK)).toBe(false);
  expect(r.doc.target.head).toBe(head);
  expect(refs(c)).not.toContain("refs/prview/pr-7/merge");
  remove(r.slug);
});

test("the fetched head is not the one the API names: Fail, the PR moved", async () => {
  process.env.PRVIEW_TEST_BARE = bare("moved", { branch: true });
  const c = clone("c-moved");
  const other = "d".repeat(40); // a head the remote does not have: the id and merge fetches fail, the branch lands elsewhere
  await expect(build(c, URL_, { ai: null, http: fakeHttp({ lastMergeSourceCommit: { commitId: other } }, other) })).rejects.toThrow(/fetched head [0-9a-f]{8} is not the PR head dddddddd: the PR moved/);
});

test("nothing fetchable at all: Fail names what was tried", async () => {
  process.env.PRVIEW_TEST_BARE = bare("nothing", { merge: false });
  writeFileSync(MARK, "");
  const c = clone("c-nothing");
  await expect(build(c, URL_, { ai: null, http: fakeHttp({ sourceRefName: "refs/heads/gone" }) })).rejects.toThrow(/could not fetch Repo!7's head from origin: commit [0-9a-f]{8}: .*refs\/pull\/7\/merge: .*refs\/heads\/gone: /);
});

test("no remote for the PR's repo: an actionable Fail naming the expected remote, before any request", async () => {
  const c = clone("c-elsewhere", "git@ssh.dev.azure.com:v3/org/Proj/Other");
  const http = fakeHttp();
  await expect(build(c, URL_, { ai: null, http })).rejects.toThrow(/no remote in \S*c-elsewhere points at https:\/\/dev\.azure\.com\/org\/Proj\/_git\/Repo, so prview will not fetch Repo!7 from anywhere: add one \(git remote add azure https:\/\/dev\.azure\.com\/org\/Proj\/_git\/Repo\)/);
  expect(http.calls).toEqual([]);
  expect(refs(c)).toEqual([]);
});

test("a PR from a fork is refused before anything is fetched", async () => {
  process.env.PRVIEW_TEST_BARE = bare("fork", { bySha: true });
  const c = clone("c-fork");
  const http = fakeHttp({ forkSource: { repository: { name: "Repo-fork", remoteUrl: "https://dev.azure.com/someone/Proj/_git/Repo-fork" } } });
  await expect(build(c, URL_, { ai: null, http })).rejects.toThrow("Repo!7 comes from a fork (Repo-fork), which prview does not read yet");
  expect(refs(c)).toEqual([]);
});

test("a bare number in an Azure clone is that repo's PR, in the case the remote gives", async () => {
  process.env.PRVIEW_TEST_BARE = bare("bare-number", { bySha: true });
  const c = clone("c-number");
  const http = fakeHttp();
  const r = await build(c, "#7", { ai: null, http });
  expect(http.calls[0]!.url).toBe("https://dev.azure.com/org/Proj/_apis/git/repositories/Repo/pullRequests/7?api-version=7.1");
  expect(r.doc.target).toMatchObject({ platform: "azure-devops", url: URL_, label: "Repo!7", head });
  expect(r.ref).toBe(URL_);
  remove(r.slug);
});

test("an abandoned, completed or draft PR still opens, with a warning", async () => {
  process.env.PRVIEW_TEST_BARE = bare("warn", { bySha: true });
  const c = clone("c-warn");
  for (const [pr, want] of [[{ status: "abandoned" }, "warning: Repo!7 is abandoned"], [{ status: "completed" }, "warning: Repo!7 is completed"], [{ isDraft: true }, "warning: Repo!7 is a draft"]] as const) {
    const said: string[] = [];
    const r = await build(c, URL_, { ai: null, http: fakeHttp(pr), say: (s) => said.push(s), fresh: true });
    expect(said).toContain(want);
    expect(r.doc.target.head).toBe(head);
  }
  remove("c-warn-pr-7");
});

test("a request Azure did not answer with JSON (its sign-in page) or with an error status is a clear Fail", async () => {
  const c = clone("c-auth");
  const page: Http = async () => ({ status: 203, json: undefined, text: "<html>Sign in</html>" });
  await expect(build(c, URL_, { ai: null, http: page })).rejects.toThrow("did not come back as JSON (HTTP 203); usually that means the request was not signed in");
  const denied: Http = async () => ({ status: 401, json: { message: "TF400813: Bearer abc.def denied" }, text: "" });
  const err = await build(c, URL_, { ai: null, http: denied }).catch((e: Error) => e.message);
  expect(err).toContain("not allowed to read pull request Repo!7 (HTTP 401)");
  expect(err).not.toContain("abc.def"); // Azure's words are redacted all the same
  const missing: Http = async () => ({ status: 404, json: { message: "TF401180: no such PR" }, text: "" });
  await expect(build(c, URL_, { ai: null, http: missing })).rejects.toThrow("pull request Repo!7 was not found, or you cannot see it (HTTP 404): TF401180: no such PR");
  expect(refs(c)).toEqual([]);
});

test("import fetches an Azure document's head by id from the configured remote only; none: refused", async () => {
  process.env.PRVIEW_TEST_BARE = bare("import", { bySha: true });
  const first = clone("c-import-src");
  const r = await build(first, URL_, { ai: null, http: fakeHttp() });
  const text = exportDocument(r);
  remove(r.slug);

  const stranger = clone("c-import-none", "git@ssh.dev.azure.com:v3/evil/Proj/Repo");
  expect(() => importDocument(text, stranger)).toThrow("no remote in");
  expect(refs(stranger)).toEqual([]);

  const there = clone("c-import");
  const got = importDocument(text, there, true);
  expect(got.doc.target).toMatchObject({ head, platform: "azure-devops", url: URL_ });
  expect(got.ref).toBe(URL_);
  expect(got.slug).toBe("c-import-pr-7");
  remove(got.slug);

  // A remote that serves neither the id nor the merge ref: the commit is reported missing, nothing invented.
  process.env.PRVIEW_TEST_BARE = bare("import-none", { branch: true });
  const bare2 = clone("c-import-missing");
  const moved = JSON.stringify({ ...JSON.parse(text), target: { ...JSON.parse(text).target, head: "e".repeat(40) } });
  expect(() => importDocument(moved, bare2)).toThrow(/commit [0-9a-f]{8} is not in \S*c-import-missing: fetch it/);
  expect(refs(bare2)).toEqual([]); // the branch is never a fallback without the API's word for it
});

test("azure.fetch with no head still refuses a clone with no matching remote", () => {
  const c = clone("c-fetch-none", "https://github.com/org/Repo");
  expect(() => azure.fetch(c, azure.parse(URL_)!, true)).toThrow("no remote in");
});
