import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/diff.ts";
import { CRITIC_SYSTEM, criticPrompt, earlierText, GUIDE_SYSTEM, hunksOf, REFUTE_SYSTEM, REREVIEW_RULE, settleAgainst, type Again, type Finding } from "../src/guide.ts";
import { earlierNotes, type Previous } from "../src/previous.ts";
import type { Resolved } from "../src/config.ts";
import type { Target } from "../src/document.ts";
import type { Since } from "../src/since.ts";

// A re-review's AI passes (issue #1): the critic reads only the blocks changed since the head last reviewed, with those
// lines marked and the earlier comments in hand, and what it raises on unchanged lines or repeats is set aside by rule.

const tmp = mkdtempSync(join(tmpdir(), "prview-rereview-ai-"));
process.env.PRVIEW_HOME = join(tmp, "store");
const { againOf, guideAndCritic } = await import("../src/build.ts");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Two files: core.ts did not move since the review; core.test.ts gained lines 4-5.
const DIFF = `diff --git a/src/core.ts b/src/core.ts
index 1..2 100644
--- a/src/core.ts
+++ b/src/core.ts
@@ -1,3 +1,4 @@
 export function parse(s: string) {
-  return s;
+  const t = s.trim();
+  return t;
 }
diff --git a/src/core.test.ts b/src/core.test.ts
index 1..2 100644
--- a/src/core.test.ts
+++ b/src/core.test.ts
@@ -1,2 +1,5 @@
 import { parse } from "./core";
 test("parse", () => expect(parse(" a ")).toBe("a"));
+test("empty", () => {
+  expect(parse("")).toBe("");
+});
`;
const files = parseDiff(DIFF);
const hunks = hunksOf(files);
const target: Target = { repo: "demo", base: "a", head: "c", label: "main..fix", title: "Trim input", body: "" };
const since: Since & { files: NonNullable<Since["files"]> } = {
  head: "b".repeat(40), at: "2026-11-01T10:00:00Z",
  files: [{ path: "src/core.test.ts", status: "modified", hunks: [{ oldStart: 2, oldCount: 0, newStart: 3, newCount: 3 }] }],
};
const coreId = hunks.find((h) => h.file.path === "src/core.ts")!.id;
const testId = hunks.find((h) => h.file.path === "src/core.test.ts")!.id;

const finding = (o: Partial<Finding>): Finding => ({ id: "0", source: "critic", hunk: coreId, side: "new", line: 2, severity: "medium", kind: "bug", claim: "x", evidence: "", status: "unrefuted", ...o });

test("only the changed blocks reach the critic, marked, with the re-review rule and the earlier comments", async () => {
  const prompts: { system: string; prompt: string }[] = [];
  const call = async (_m: Resolved, system: string, prompt: string) => {
    prompts.push({ system, prompt });
    const ids = [...prompt.matchAll(/^id: (\S+)$/gm)].map((m) => m[1]!);
    if (system === GUIDE_SYSTEM) return JSON.stringify({ summary: "Trims.", chapters: [{ title: "Core", check: "parse trims", why: "x", hunks: [coreId] }, { title: "Proof", check: "tests cover empty", why: "y", hunks: [testId] }] });
    if (system.startsWith(CRITIC_SYSTEM)) return JSON.stringify([{ hunk: ids[0], side: "new", line: 4, severity: "medium", kind: "test", title: "Empty test lacks a whitespace-only case", claim: "The new test does not cover a whitespace-only string.", evidence: "Only an empty string." }]);
    if (system === REFUTE_SYSTEM) return JSON.stringify({ verdict: "uphold", reason: "ok", lines: ["n4"] });
    throw new Error("unexpected system prompt");
  };
  const cli: Resolved = { def: { name: "stub", kind: "claude-cli", model: "stub-model" } };
  const wt = mkdtempSync(join(tmp, "wt-")); mkdirSync(join(wt, "src"));
  writeFileSync(join(wt, "src/core.test.ts"), `import { parse } from "./core";\ntest("parse", () => expect(parse(" a ")).toBe("a"));\ntest("empty", () => {\n  expect(parse("")).toBe("");\n});\n`);
  const again: Again = { since, earlier: [{ path: "src/core.ts", line: 2, text: "Trim drops tabs too; is that intended?", status: "unchanged", replies: [{ author: "dev", text: "Yes, on purpose." }], resolved: true }] };
  const said: string[] = [];
  const out = await guideAndCritic(target, files, wt, { guide: cli, critic: cli, refute: cli }, 1, (s) => said.push(s), call, { depth: "quick" }, again);

  const critic = prompts.filter((p) => p.system.startsWith(CRITIC_SYSTEM));
  expect(critic).toHaveLength(1); // the Core chapter did not change since the review: not read
  expect(critic[0]!.system).toContain(REREVIEW_RULE);
  expect(critic[0]!.prompt).toContain(`id: ${testId}`);
  expect(critic[0]!.prompt).not.toContain(`id: ${coreId}`);
  expect(critic[0]!.prompt).toMatch(/^\*n4 /m); // a line added since is marked
  expect(critic[0]!.prompt).toMatch(/^ n1 /m); // one the reviewer already read is not
  expect(critic[0]!.prompt).toContain("Trim drops tabs too");
  expect(critic[0]!.prompt).toContain("reply from dev: Yes, on purpose.");
  expect(critic[0]!.prompt).toContain('<pr_data name="earlier">');
  // The guide still orders the whole PR.
  expect(out.doc.plan.chapters.flatMap((c) => c.hunks)).toEqual([coreId, testId]);
  expect(out.doc.findings).toHaveLength(1);
  expect(out.doc.findings[0]!.status).toBe("upheld");
  expect(said.some((s) => s.includes("1 block changed since bbbbbbb, in 1 of 2 chapters"))).toBe(true);
});

test("without a re-review nothing changes: the plain critic system prompt, every chapter, no marks", () => {
  const p = criticPrompt(target, { title: "Proof", intent: "x", why: "y", hunks: [testId] }, hunks);
  expect(p).toMatch(/^n1 /m);
  expect(p).not.toContain("earlier");
});

test("a finding repeating an earlier comment near its line is set aside, whatever changed", () => {
  const again: Again = { since, earlier: [{ path: "src/core.test.ts", line: 4, text: "The new test does not cover a whitespace-only string.", replies: [] }] };
  const [f] = settleAgainst([finding({ hunk: testId, line: 5, claim: "The new test does not cover a whitespace-only string.", severity: "high" })], hunks, again);
  expect(f!.status).toBe("withdrawn");
  expect(f!.refute).toContain("already raised this at src/core.test.ts:4");
  // Far from the earlier line it is a different place: kept.
  const [g] = settleAgainst([finding({ hunk: testId, line: 1, claim: "The new test does not cover a whitespace-only string.", severity: "high" })], hunks, { since, earlier: [{ path: "src/core.test.ts", line: 9, text: "The new test does not cover a whitespace-only string.", replies: [] }] });
  expect(g!.status).toBe("unrefuted");
});

test("a finding on a line unchanged since the review is set aside unless it is high", () => {
  const again: Again = { since, earlier: [] };
  const [medium, high, changed] = settleAgainst([
    finding({ hunk: coreId, line: 2, severity: "medium", claim: "Trim is wrong here" }),
    finding({ hunk: coreId, line: 2, severity: "high", claim: "Trim is wrong here" }),
    finding({ hunk: testId, line: 4, severity: "low", claim: "Name the test better" }),
  ], hunks, again);
  expect(medium!.status).toBe("withdrawn");
  expect(medium!.refute).toContain("unchanged since your last review (at bbbbbbb)");
  expect(high!.status).toBe("unrefuted");
  expect(changed!.status).toBe("unrefuted");
});

test("earlier notes follow where each comment is now, with its thread when it was read", () => {
  const p: Previous = { head: "b".repeat(40), at: "2026-11-01", round: 1, platform: "github", items: [
    { kind: "line", path: "src/a.ts", line: 3, side: "new", text: "one", status: "moved", to: { path: "src/b.ts", line: 7 } },
    { kind: "file", path: "src/c.ts", text: "two", status: "unchanged", to: { path: "src/c.ts" } },
    { kind: "summary", text: "three" },
  ] };
  const notes = earlierNotes(p, { ok: true, threads: [{ found: true, replies: [{ author: "dev", at: "x", text: "done" }], resolved: true }, { found: false, replies: [] }, { found: false, replies: [] }] });
  expect(notes[0]).toEqual({ path: "src/b.ts", line: 7, text: "one", status: "moved to src/b.ts:L7", replies: [{ author: "dev", text: "done" }], resolved: true });
  expect(notes[1]).toEqual({ path: "src/c.ts", file: true, text: "two", status: "unchanged", replies: [] });
  expect(notes[2]).toEqual({ text: "three", replies: [] });
  expect(earlierText(notes)).toContain("- src/b.ts:7 (moved to src/b.ts:L7, resolved): one\n  reply from dev: done");
});

test("--full and a gone head review the whole PR, and say so; otherwise the earlier comments come with their replies", async () => {
  const said: string[] = [];
  expect(await againOf(since, undefined, { full: true }, tmp, (s) => said.push(s))).toBeUndefined();
  expect(await againOf({ head: since.head, at: since.at, gone: true }, undefined, {}, tmp, (s) => said.push(s))).toBeUndefined();
  expect(said).toEqual(["AI review: the whole PR (--full)", "AI review: the whole PR, not incremental: the head you reviewed is gone"]);

  const prev: Previous = { head: since.head, at: since.at, round: 1, url: "https://github.com/o/r/pull/1", platform: "github", items: [{ kind: "line", path: "src/core.ts", line: 2, side: "new", text: "Is the trim intended?", comment_id: 11 }] };
  const run = async (argv: string[]) => ({ exit: 0, stderr: "", stdout: argv.includes("graphql")
    ? JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: true, comments: { nodes: [{ databaseId: 11 }] } }] } } } } })
    : JSON.stringify([{ id: 11, path: "src/core.ts", line: 2, body: "Is the trim intended?" }, { id: 12, in_reply_to_id: 11, user: { login: "dev" }, created_at: "2026-11-02", body: "Yes." }]) });
  const a = await againOf(since, prev, { remote: { run } }, tmp, (s) => said.push(s));
  expect(a?.earlier).toEqual([{ path: "src/core.ts", line: 2, text: "Is the trim intended?", replies: [{ author: "dev", text: "Yes." }], resolved: true }]);
  expect(said.at(-1)).toContain("AI review: incremental, only what changed since bbbbbbb, knowing your 1 earlier comment");
});
