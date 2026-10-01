import { describe, expect, test } from "bun:test";
import { azureHttp, type AzRunner, type Http, type HttpReq, type HttpRes } from "../src/azure-auth.ts";
import { parseConfig } from "../src/config.ts";
import { PostError, type Target } from "../src/document.ts";
import { adapterFor, postingOf, type Posting, type Runner } from "../src/platform.ts";
import { azure, azureAdapter, azureProblem, VOTE } from "../src/platforms/azure.ts";
import { submit } from "../src/submit.ts";
import { SCHEMA } from "../src/document.ts";
import type { Review } from "../src/build.ts";

// Every Azure DevOps call goes to a fake Http and every git/az command to a fake runner: no network, no az, no git.
const A = "a".repeat(40), B = "b".repeat(40);
const URL_ = "https://dev.azure.com/contoso/Fabrikam%20Web/_git/web/pullrequest/42";
const ROOT = "https://dev.azure.com/contoso/Fabrikam%20Web/_apis/git/repositories/web/pullRequests/42";
const t: Target = { repo: "contoso/Fabrikam Web/web", base: A, head: B, url: URL_, platform: "azure-devops", title: "A change", body: "", label: "web!42" };
const TOKEN = "eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";

type Over = { head?: string; me?: HttpRes; fail?: (req: HttpReq, n: number) => HttpRes | undefined; changes?: unknown[][] };
const res = (status: number, json: unknown): HttpRes => ({ status, json, text: JSON.stringify(json) });

function fakeAzure(over: Over = {}) {
  const calls: (HttpReq & { json?: any })[] = [];
  let threadId = 100;
  const pages = over.changes ?? [[
    { changeTrackingId: 7, item: { path: "/src/a.ts" } },
    { changeTrackingId: 8, item: { path: "/src/new.ts" }, originalPath: "/src/old.ts" },
  ]];
  const http: Http = async (req) => {
    calls.push({ ...req, ...(req.body ? { json: JSON.parse(req.body) } : {}) });
    const failed = over.fail?.(req, calls.length);
    if (failed) return failed;
    const u = req.url;
    if (u === `${ROOT}/iterations?api-version=7.1`) return res(200, { value: [{ id: 1, sourceRefCommit: { commitId: A } }, { id: 3, sourceRefCommit: { commitId: over.head ?? B } }, { id: 2, sourceRefCommit: { commitId: A } }] });
    const ch = u.match(/\/iterations\/3\/changes\?\$top=2000&\$skip=(\d+)&api-version=7\.1$/);
    if (ch) { const i = Number(ch[1]) / 2000; return res(200, { changeEntries: pages[i] ?? [], ...(i + 1 < pages.length ? { nextSkip: (i + 1) * 2000, nextTop: 2000 } : { nextSkip: 0, nextTop: 0 }) }); }
    if (u === "https://dev.azure.com/contoso/_apis/connectionData") return over.me ?? res(200, { authenticatedUser: { id: "me-123" } });
    if (u === `${ROOT}/threads?api-version=7.1` && req.method === "POST") { ++threadId; return res(200, { id: threadId, comments: [{ id: 1, parentCommentId: 0 }] }); }
    if (u === `${ROOT}/reviewers/me-123?api-version=7.1` && req.method === "PUT") return res(200, { vote: JSON.parse(req.body!).vote });
    return res(404, { message: `unexpected ${req.method} ${u}` });
  };
  const runs: string[][] = [];
  const run: Runner = (argv) => {
    runs.push(argv);
    if (argv[0] === "git" && argv[1] === "show") {
      const files: Record<string, string> = { [`${B}:src/a.ts`]: "one\ntwelve chars\n", [`${A}:src/a.ts`]: "old one\r\nold two!\n", [`${A}:src/old.ts`]: "renamed from\n", [`${B}:src/new.ts`]: "x\n" };
      const f = files[argv[2]!];
      return f === undefined ? { exit: 128, stdout: "", stderr: "fatal: path not in commit" } : { exit: 0, stdout: f, stderr: "" };
    }
    if (argv[0] === "az") return { exit: 0, stdout: "{}", stderr: "" };
    throw new Error(`unexpected command ${argv.join(" ")}`);
  };
  return { calls, http, run, runs, adapter: azureAdapter({ http: () => http }), writes: () => calls.filter((c) => c.method !== "GET") };
}

const words = (verdict: Posting["verdict"], extra: Partial<Posting> = {}): Posting => ({ verdict, body: "Looks right.", comments: [], ...extra });
const msg = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } throw new Error("did not reject"); };

describe("azure adapter", () => {
  test("is registered under the read side's platform id, with the same three verdicts", () => {
    expect(adapterFor("azure-devops")).toBe(azure);
    expect(adapterFor("Azure-DevOps")?.verdicts).toEqual(["approve", "request_changes", "comment"]);
  });

  test("preflight, then line threads, whole-file threads, the summary, and the vote last", async () => {
    const f = fakeAzure();
    const p = words("approve", {
      comments: [{ path: "src/a.ts", side: "new", line: 2, text: "why twelve?" }, { path: "src/a.ts", side: "old", line: 1, text: "was this used?" }],
      files: [{ path: "src/new.ts", text: "rename it back?" }],
      coverage: "I read 2 of 3 hunks.",
    });
    expect(await f.adapter.post(t, p, f.run, "/wt")).toEqual({ url: URL_, items: [
      { kind: "line", path: "src/a.ts", line: 2, side: "new", text: "why twelve?", thread_id: 101, comment_id: 1 },
      { kind: "line", path: "src/a.ts", line: 1, side: "old", text: "was this used?", thread_id: 102, comment_id: 1 },
      { kind: "file", path: "src/new.ts", text: "rename it back?", thread_id: 103, comment_id: 1 },
      { kind: "summary", text: "Looks right.\n\nI read 2 of 3 hunks.", thread_id: 104, comment_id: 1 },
    ] });
    expect(f.calls.map((c) => `${c.method} ${c.url.replace(ROOT, "").replace("https://dev.azure.com/contoso", "")}`)).toEqual([
      "GET /iterations?api-version=7.1",
      "GET /iterations/3/changes?$top=2000&$skip=0&api-version=7.1",
      "GET /_apis/connectionData",
      "POST /threads?api-version=7.1",
      "POST /threads?api-version=7.1",
      "POST /threads?api-version=7.1",
      "POST /threads?api-version=7.1",
      "PUT /reviewers/me-123?api-version=7.1",
    ]);
    const ctx = { changeTrackingId: 7, iterationContext: { firstComparingIteration: 1, secondComparingIteration: 3 } };
    expect(f.calls[3]!.json).toEqual({
      comments: [{ parentCommentId: 0, content: "why twelve?", commentType: 1 }], status: 1,
      threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 2, offset: 1 }, rightFileEnd: { line: 2, offset: 13 } },
      pullRequestThreadContext: ctx,
    });
    // The old side is left*, its length read at the base (a CRLF line's \r is not a column).
    expect(f.calls[4]!.json.threadContext).toEqual({ filePath: "/src/a.ts", leftFileStart: { line: 1, offset: 1 }, leftFileEnd: { line: 1, offset: 8 } });
    expect(f.calls[5]!.json).toEqual({ comments: [{ parentCommentId: 0, content: "rename it back?", commentType: 1 }], status: 1, threadContext: { filePath: "/src/new.ts" }, pullRequestThreadContext: { ...ctx, changeTrackingId: 8 } });
    expect(f.calls[6]!.json).toEqual({ comments: [{ parentCommentId: 0, content: "Looks right.\n\nI read 2 of 3 hunks.", commentType: 1 }], status: 1 });
    expect(f.calls[7]!.json).toEqual({ vote: 10, id: "me-123" });
    expect(f.runs).toEqual([["git", "show", `${B}:src/a.ts`], ["git", "show", `${A}:src/a.ts`]]);
  });

  test("each verdict maps to its vote; a comment makes no PUT and does not ask who you are", async () => {
    expect(VOTE).toEqual({ approve: 10, request_changes: -5, comment: undefined });
    for (const [verdict, vote] of [["approve", 10], ["request_changes", -5]] as const) {
      const f = fakeAzure();
      await f.adapter.post(t, words(verdict), f.run, "/wt");
      expect(f.calls.at(-1)).toMatchObject({ method: "PUT", json: { vote, id: "me-123" } });
    }
    const f = fakeAzure();
    await f.adapter.post(t, words("comment"), f.run, "/wt");
    expect(f.calls.filter((c) => c.method === "PUT")).toEqual([]);
    expect(f.calls.some((c) => c.url.includes("connectionData"))).toBe(false);
    expect(f.writes().map((c) => c.json)).toEqual([{ comments: [{ parentCommentId: 0, content: "Looks right.", commentType: 1 }], status: 1 }]);
  });

  test("approve with no words is the vote alone; no summary thread, no change list read", async () => {
    const f = fakeAzure();
    await f.adapter.post(t, { verdict: "approve", body: "", comments: [] }, f.run, "/wt");
    expect(f.writes().map((c) => c.method)).toEqual(["PUT"]);
    expect(f.calls.some((c) => c.url.includes("/changes"))).toBe(false);
  });

  test("a renamed file's old side is read at the base under its original path", async () => {
    const f = fakeAzure();
    await f.adapter.post(t, words("comment", { comments: [{ path: "src/new.ts", side: "old", line: 1, text: "keep" }] }), f.run, "/wt");
    expect(f.runs).toEqual([["git", "show", `${A}:src/old.ts`]]);
    expect(f.writes()[0]!.json.threadContext).toEqual({ filePath: "/src/new.ts", leftFileStart: { line: 1, offset: 1 }, leftFileEnd: { line: 1, offset: 13 } });
  });

  test("the change list is read page by page", async () => {
    const f = fakeAzure({ changes: [[{ changeTrackingId: 1, item: { path: "/x.ts" } }], [{ changeTrackingId: 7, item: { path: "/src/a.ts" } }]] });
    await f.adapter.post(t, words("comment", { files: [{ path: "src/a.ts", text: "fine" }] }), f.run, "/wt");
    expect(f.calls.filter((c) => c.url.includes("/changes")).map((c) => c.url.match(/skip=(\d+)/)![1])).toEqual(["0", "2000"]);
    expect(f.writes()[0]!.json.pullRequestThreadContext.changeTrackingId).toBe(7);
  });

  test("a path missing from the change list, or a line its file does not have, folds into the summary under its path", async () => {
    const f = fakeAzure();
    await f.adapter.post(t, words("request_changes", {
      comments: [{ path: "gone.ts", side: "new", line: 3, text: "stale" }, { path: "src/a.ts", side: "new", line: 9, text: "past the end" }],
      files: [{ path: "docs/x.md", text: "whole file" }],
    }), f.run, "/wt");
    const w = f.writes();
    expect(w.map((c) => c.method)).toEqual(["POST", "PUT"]);
    expect(w[0]!.json).toEqual({ comments: [{ parentCommentId: 0, content: "Looks right.\n\ngone.ts:3: stale\n\nsrc/a.ts:9: past the end\n\ndocs/x.md: whole file", commentType: 1 }], status: 1 });
  });

  test("head moved: refused before anything is posted", async () => {
    const f = fakeAzure({ head: "c".repeat(40) });
    expect(await msg(f.adapter.post(t, words("approve", { comments: [{ path: "src/a.ts", side: "new", line: 1, text: "x" }] }), f.run, "/wt"))).toContain("head is now cccccccc, but this review is of bbbbbbbb");
    expect(f.writes()).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });

  test("any preflight failure posts nothing: change list, identity server error, a base that is not a commit", async () => {
    const files = { comments: [{ path: "src/a.ts", side: "new" as const, line: 1, text: "x" }] };
    let f = fakeAzure({ fail: (r) => r.url.includes("/changes") ? res(403, { message: "TF401027: You need the Git 'PullRequestContribute' permission" }) : undefined });
    expect(await msg(f.adapter.post(t, words("approve", files), f.run, "/wt"))).toContain("changed files: HTTP 403: TF401027");
    expect(f.writes()).toEqual([]);
    f = fakeAzure({ me: res(503, { message: "down" }) });
    expect(await msg(f.adapter.post(t, words("approve", files), f.run, "/wt"))).toContain("who you are");
    expect(f.writes()).toEqual([]);
    f = fakeAzure();
    expect(await msg(f.adapter.post({ ...t, base: "--output=/tmp/x" }, words("approve", files), f.run, "/wt"))).toContain("not a commit id");
    expect(f.writes()).toEqual([]);
    expect(f.runs).toEqual([]);
  });

  test("a failure at the 2nd thread: stops, casts no vote, and the error names thread 1", async () => {
    const f = fakeAzure({ fail: (r) => r.method === "POST" && f.calls.filter((c) => c.method === "POST").length === 2 ? res(400, { message: "TF401181: bad position" }) : undefined });
    const p = words("approve", { comments: [{ path: "src/a.ts", side: "new", line: 1, text: "one" }, { path: "src/a.ts", side: "new", line: 2, text: "two" }], files: [{ path: "src/new.ts", text: "three" }] });
    const m = await msg(f.adapter.post(t, p, f.run, "/wt"));
    expect(m).toContain("line comment on src/a.ts:2 failed: HTTP 400: TF401181: bad position");
    expect(m).toContain(`already posted (left in place): thread 101 (line comment on src/a.ts:1, ${URL_}?discussionId=101)`);
    expect(m).toContain("No vote was cast.");
    expect(f.writes().map((c) => c.method)).toEqual(["POST", "POST"]);
  });

  test("a partial failure is a PostError listing what was posted, with thread and comment ids", async () => {
    let posts = 0;
    const f = fakeAzure({ fail: (r) => r.method === "POST" && ++posts === 2 ? res(400, { message: "TF401181: bad position" }) : undefined });
    const p = words("approve", { comments: [{ path: "src/a.ts", side: "new", line: 1, text: "one" }, { path: "src/a.ts", side: "new", line: 2, text: "two" }] });
    const e = await f.adapter.post(t, p, f.run, "/wt").then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(PostError);
    expect((e as PostError).items).toEqual([{ kind: "line", path: "src/a.ts", line: 1, side: "new", text: "one", thread_id: 101, comment_id: 1 }]);
  });

  test("a failed vote names every thread already on the PR", async () => {
    const f = fakeAzure({ fail: (r) => r.method === "PUT" ? res(403, { message: "no" }) : undefined });
    const m = await msg(f.adapter.post(t, words("approve"), f.run, "/wt"));
    expect(m).toContain("the vote failed: HTTP 403: no");
    expect(m).toContain("thread 101 (summary");
  });

  test("identity refused (4xx): the vote goes through az repos pr set-vote, after the threads", async () => {
    for (const [verdict, v] of [["approve", "approve"], ["request_changes", "wait-for-author"]] as const) {
      const f = fakeAzure({ me: res(404, { message: "not found" }) });
      await f.adapter.post(t, words(verdict), f.run, "/wt");
      expect(f.writes().map((c) => c.method)).toEqual(["POST"]);
      expect(f.runs).toEqual([["az", "repos", "pr", "set-vote", "--id", "42", "--vote", v, "--org", "https://dev.azure.com/contoso"]]);
    }
  });

  test("dry run: the planned calls with placeholders, zero Http calls, no credential", () => {
    let made = 0;
    const adapter = azureAdapter({ http: () => { made++; return async () => { made++; return res(200, {}); }; } });
    const out = adapter.dryRun(t, words("request_changes", { comments: [{ path: "src/a.ts", side: "old", line: 4, text: "hm" }], files: [{ path: "src/b.ts", text: "whole" }] })).join("\n\n");
    expect(made).toBe(0);
    expect(out).toContain(`GET ${ROOT}/iterations?api-version=7.1`);
    expect(out).toContain(`POST ${ROOT}/threads?api-version=7.1`);
    expect(out).toContain(`"filePath": "/src/a.ts"`);
    expect(out).toContain(`"leftFileStart"`);
    expect(out).toContain("<tracking id of /src/a.ts>");
    expect(out).toContain("<last iteration>");
    expect(out).toContain(`PUT ${ROOT}/reviewers/<your identity id>?api-version=7.1`);
    expect(out).toContain('"vote": -5');
    expect(out).not.toMatch(/Authorization|Bearer|Basic/i);
    expect(adapter.dryRun(t, words("comment")).join("\n")).toContain("no vote: a comment leaves your vote as it is");
    expect(adapter.dryRun(t, words("comment")).join("\n")).not.toContain("PUT");
  });

  test("the token: only ever in the Authorization header, never in a URL, a body, a dry run or an error", async () => {
    const f = fakeAzure({ fail: (r) => r.method === "POST" ? res(500, { message: `echo ${r.headers?.Authorization}` }) : undefined });
    const mint: AzRunner = () => ({ exit: 0, stdout: TOKEN, stderr: "" });
    const authed = azureHttp(parseConfig(""), { env: {}, keychain: () => undefined }, mint, f.http);
    const adapter = azureAdapter({ http: () => authed });
    const m = await msg(adapter.post(t, words("comment"), f.run, "/wt"));
    expect(f.calls.every((c) => c.headers?.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(f.calls.map((c) => [c.url, c.body]))).not.toContain(TOKEN);
    expect(f.runs.flat().join(" ")).not.toContain(TOKEN);
    expect(m).toContain("summary failed: HTTP 500");
    expect(m).not.toContain(TOKEN);
    expect(adapter.dryRun(t, words("comment")).join("\n")).not.toContain(TOKEN);
  });

  test("submit --dry-run through the registered adapter: no command, no request, nothing recorded", async () => {
    const r: Review = { slug: "az", repo: "/nonexistent", worktree: "/nonexistent", context: 3, created: "now", pos: { item: 0, line: 0 },
      doc: { schema: SCHEMA, target: t, plan: { summary: "", chapters: [], mechanical: [], by: "files" }, findings: [], human: { comments: [{ hunk: null, side: "new", line: null, text: "Fine.", at: "now" }], visited: [], verdict: "approve" } } };
    const res = await submit(r, [], { allowHook: false, dryRun: true, run: () => { throw new Error("nothing may run"); }, hook: () => { throw new Error("no hook"); } });
    expect(res.summary).toContain(`PUT ${ROOT}/reviewers/<your identity id>?api-version=7.1`);
    expect(res.summary).not.toMatch(/Authorization|Bearer/);
    expect(r.doc.submissions).toBeUndefined();
  });

  test("describe says where, how, and what posts", () => {
    expect(azure.describe(t, words("request_changes", { comments: [{ path: "a", side: "new", line: 1, text: "x" }, { path: "a", side: "new", line: 2, text: "y" }, { path: "a", side: "new", line: 3, text: "z" }] })))
      .toBe(`posts to ${URL_} with your Azure DevOps login: wait for author (vote -5), your summary, 3 line comments; each thread is visible as soon as it is posted`);
    expect(azure.describe(t, words("comment"))).toContain("your vote is left as it is");
    expect(azure.describe({ ...t, url: undefined }, words("approve"))).toBe("not posted: no Azure DevOps pull request URL in the document's target");
  });
});

// The same cases githubProblem is tested on (test/submit.test.ts, "github: refused before sending").
describe("azureProblem mirrors githubProblem", () => {
  const silent = (verdict: Posting["verdict"], extra: Partial<Posting> = {}): Posting => ({ verdict, body: "", comments: [], ...extra });
  test.each([
    ["request changes with no words", silent("request_changes"), "requesting changes needs a top-level comment or a ticked finding to post"],
    ["a comment with no words", silent("comment"), "a comment needs a top-level comment or a ticked finding to post"],
    ["a comment with only a coverage line", silent("comment", { coverage: "I read 1 of 2 hunks." }), "needs a top-level comment"],
    ["approve with only a coverage line", silent("approve", { coverage: "I read 1 of 2 hunks." }), "a coverage line needs a top-level comment or a ticked finding to go with it"],
  ])("%s is refused", async (_, p, why) => {
    expect(azureProblem(t, p)).toContain(why);
    const f = fakeAzure();
    expect(await msg(f.adapter.post(t, p, f.run, "/wt"))).toContain(why);
    expect(f.calls).toEqual([]);
  });
  test("approve alone, or a line comment alone, may go", () => {
    expect(azureProblem(t, silent("approve"))).toBeUndefined();
    expect(azureProblem(t, silent("comment", { files: [{ path: "a", text: "x" }] }))).toBeUndefined();
    expect(azureProblem(t, silent("request_changes", { comments: [{ path: "a", side: "new", line: 1, text: "x" }] }))).toBeUndefined();
  });
  test("no Azure PR URL: missing, a GitHub URL, a repo URL without a PR", () => {
    for (const url of [undefined, "https://github.com/o/r/pull/7", "https://dev.azure.com/contoso/p/_git/web"]) expect(azureProblem({ ...t, url }, silent("approve"))).toBe("no Azure DevOps pull request URL in the document's target");
  });
  test("the posting from a document is the same platform-neutral one GitHub gets", () => {
    const p = postingOf("comment", [{ hunk: null, side: "new", line: null, text: "Mostly fine.", at: "now" }], () => undefined);
    expect(azureProblem(t, p)).toBeUndefined();
  });
});
