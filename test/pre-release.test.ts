import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorArgs, tmuxSplit } from "../src/editor.ts";
import { linksIn, readInTree } from "../src/intree.ts";
import { claudeAgent, linkRules, readAround } from "../src/deep.ts";
import { parseDiff } from "../src/diff.ts";
import { CRITIC_SYSTEM, GUIDE_SYSTEM, REFUTE_SYSTEM } from "../src/guide.ts";
import type { Resolved } from "../src/config.ts";

// The pre-release audit's three findings, each proven against the hostile input it named: a PR file name an editor
// would run, a PR symlink that leads to a secret outside the worktree, and a release dispatched from a branch.

const tmp = mkdtempSync(join(tmpdir(), "prview-prerel-"));
process.env.PRVIEW_HOME = join(tmp, "store");
const { guideAndCritic } = await import("../src/build.ts");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
};

// ---------------------------------------------------------------- the editor

const HOSTILE = ["+:!touch pwned", "+!sh", "-c", "-c:!touch pwned", "--cmd", "--cmd=!id", "-", "--", "-u NONE"];

test("editor: a PR file name is always an absolute path, so vim/nvim/hx/$EDITOR can never read it as an option or a command", () => {
  for (const ed of [["vim"], ["/usr/bin/nvim"], ["vi"], ["hx"], ["nano"], ["emacs", "-nw"], ["kak"], ["code"], ["cursor"], ["zed"], ["subl"]]) {
    for (const name of HOSTILE) {
      const argv = editorArgs(ed, name, 7, "/wt");
      const rest = argv.slice(ed.length);
      // Every argument we add is ours (`+7`, `--`, `-g`, `--wait`) or starts with the worktree.
      for (const a of rest) expect(["+7", "--", "-g", "--wait"].includes(a) || a.startsWith("/wt/"), `${ed[0]} ${name}: ${a}`).toBe(true);
      expect(rest.some((a) => a === `/wt/${name}` || a === `/wt/${name}:7`), `${ed[0]} ${name}`).toBe(true);
      // The hostile name never stands alone in the argv, which is how an editor would take it as an option.
      expect(rest).not.toContain(name === "--" ? "\0" : name);
    }
  }
});

test("editor: per-editor forms keep our line; vi-likes and hx also get `--`; an unknown $EDITOR gets no `--` it might open as a file", () => {
  expect(editorArgs(["hx"], "a.rs", 7, "/wt")).toEqual(["hx", "+7", "--", "/wt/a.rs"]);
  expect(editorArgs(["vim"], "+:!touch x", 7, "/wt")).toEqual(["vim", "+7", "--", "/wt/+:!touch x"]);
  expect(editorArgs(["/opt/bin/nvim", "-u", "NONE"], "-c", 3, "/wt")).toEqual(["/opt/bin/nvim", "-u", "NONE", "+3", "--", "/wt/-c"]);
  expect(editorArgs(["nano"], "--foo", 2, "/wt")).toEqual(["nano", "+2", "/wt/--foo"]);
  expect(editorArgs(["code"], "a.rs", 7, "/wt")).toEqual(["code", "-g", "/wt/a.rs:7", "--wait"]);
  expect(editorArgs(["zed"], "-x", 7, "/wt")).toEqual(["zed", "/wt/-x:7"]);
  // An absolute path (the submit flow's comment file) stays as it is.
  expect(editorArgs(["vim"], "/home/me/.cache/prview/r.comment.md", 4, "/wt")).toEqual(["vim", "+4", "--", "/home/me/.cache/prview/r.comment.md"]);
  // Inside tmux, the pane gets the same argv, quoted for sh -c: the name is still one argument after `--`.
  expect(tmuxSplit(editorArgs(["vim"], "+:!touch x", 1, "/wt"), "/wt")[7]).toContain(`'\\''+1'\\'' '\\''--'\\'' '\\''/wt/+:!touch x'\\''`);
});

test("editor: a real vim given the argv opens a file named `+:!touch pwned` and runs nothing", () => {
  const vim = Bun.which("vim");
  if (!vim) return; // no vim here: the argv tests above stand
  const dir = mkdtempSync(join(tmp, "vim-"));
  writeFileSync(join(dir, "+:!touch pwned"), "one\ntwo\n");
  // -es: silent Ex mode, no terminal; the script writes the buffer's name and line count, then quits.
  const argv = editorArgs([vim, "-u", "NONE", "-i", "NONE", "-es"], "+:!touch pwned", 2, dir);
  const p = Bun.spawnSync([...argv.slice(0, -2), "+redir! > out.txt | silent echo expand('%:t') line('$') | redir END | qa!", ...argv.slice(-2)], { cwd: dir, stdin: "ignore", timeout: 10_000 });
  expect(p.exitCode).toBe(0);
  expect(existsSync(join(dir, "pwned"))).toBe(false);
  expect(readFileSync(join(dir, "out.txt"), "utf8").trim()).toBe("+:!touch pwned 2");
});

// ---------------------------------------------------------------- symlinks in the worktree

/** A worktree (a real git repo) with a plain file, a symlink to a secret outside, a symlinked directory leading out, and an in-tree link. */
function tree() {
  const root = mkdtempSync(join(tmp, "tree-"));
  const outside = join(root, "outside"), wt = join(root, "wt");
  mkdirSync(outside); mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(outside, "credentials"), "aws_secret_access_key = SECRET-KEY-123\n");
  writeFileSync(join(wt, "src/ok.ts"), "export const ok = 1;\nconst two = 2;\n");
  symlinkSync(join(outside, "credentials"), join(wt, "src/x.ts"));
  symlinkSync("../../outside", join(wt, "src/dir"));
  symlinkSync("ok.ts", join(wt, "src/alias.ts"));
  git(["init", "-q"], wt); git(["add", "-A"], wt); git(["commit", "-qm", "c"], wt);
  return { wt, outside };
}

test("readInTree: a regular file is read; a symlink, a symlinked directory leading out, `..` and an absolute path are skipped, saying why", () => {
  const { wt, outside } = tree();
  expect(readInTree(wt, "src/ok.ts")).toEqual({ text: "export const ok = 1;\nconst two = 2;\n" });
  expect(readInTree(wt, "src/x.ts")).toEqual({ skipped: "src/x.ts is a symlink; not read" });
  expect(readInTree(wt, "src/alias.ts")).toEqual({ skipped: "src/alias.ts is a symlink; not read" });
  expect(readInTree(wt, "src/dir/credentials")).toEqual({ skipped: "src/dir/credentials leads out of the worktree through a symlinked directory; not read" });
  expect(readInTree(wt, "../outside/credentials")).toEqual({ skipped: "../outside/credentials is a path out of the worktree; not read" });
  expect(readInTree(wt, "src/../../outside/credentials")).toMatchObject({ skipped: expect.stringContaining("path out of the worktree") });
  expect(readInTree(wt, join(outside, "credentials"))).toMatchObject({ skipped: expect.stringContaining("path out of the worktree") });
  expect(readInTree(wt, "src/gone.ts")).toEqual({ missing: true });
  expect(readInTree(wt, "src")).toEqual({ missing: true }); // a directory is not a file
});

test("a model without tools (a ?) never sees a symlinked file's target: the prompt gets a note instead", () => {
  const { wt } = tree();
  expect(readAround(wt)("src/ok.ts", 2, 2)).toBe("const two = 2;");
  const via = readAround(wt)("src/x.ts", 1, 80);
  expect(via).toBe("(src/x.ts is a symlink; not read)");
  expect(readAround(wt)("src/dir/credentials", 1, 80)).not.toContain("SECRET");
  expect(readAround(wt)("src/gone.ts", 1, 80)).toBe("");
});

test("refute never reads a symlinked file's target into its prompt; the build says it skipped it", async () => {
  const { wt } = tree();
  const DIFF = `diff --git a/src/x.ts b/src/x.ts\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+/outside/credentials\n\\ No newline at end of file\n`;
  const files = parseDiff(DIFF);
  const prompts: string[] = [];
  const call = async (_m: Resolved, system: string, prompt: string) => {
    prompts.push(prompt);
    const ids = [...prompt.matchAll(/^id: (\S+)$/gm)].map((m) => m[1]!);
    if (system === GUIDE_SYSTEM) return JSON.stringify({ summary: "Adds a link.", chapters: [{ title: "Link", check: "c", why: "w", hunks: ids }] });
    if (system === CRITIC_SYSTEM) return JSON.stringify([{ hunk: ids[0], side: "new", line: 1, severity: "high", kind: "bug", title: "t", claim: "c", evidence: "e" }]);
    if (system === REFUTE_SYSTEM) return JSON.stringify({ verdict: "uphold", reason: "stands", lines: ["n1"] });
    throw new Error("unexpected");
  };
  const said: string[] = [];
  const model: Resolved = { def: { name: "stub", kind: "claude-cli" } };
  const { doc, errors } = await guideAndCritic({ repo: "demo", base: "a", head: "b", label: "a..b", title: "t", body: "" }, files, wt, { guide: model, critic: model, refute: model }, 1, (s) => said.push(s), call);
  expect(errors).toEqual([]);
  expect(doc.findings).toHaveLength(1);
  expect(prompts.length).toBeGreaterThanOrEqual(3);
  for (const p of prompts) expect(p).not.toContain("SECRET-KEY-123");
  expect(said.some((s) => /refute.*src\/x\.ts is a symlink; not read/.test(s))).toBe(true);
});

test("the agent (a ? on claude): every symlink git checked out is denied, at the given and the real path; plain files are not", () => {
  const { wt } = tree();
  expect(linksIn(wt).sort()).toEqual(["src/alias.ts", "src/dir", "src/x.ts"]);
  expect(linksIn(join(tmp, "not-a-repo"))).toEqual([]);
  const rules = linkRules("/tmp/wt", ["src/x.ts", "a(1)/l"], () => "/private/tmp/wt");
  for (const r of ["//tmp/wt/src/x.ts", "//private/tmp/wt/src/x.ts", "//tmp/wt/a?1?/l"]) {
    expect(rules).toContain(`Read(${r})`);
    expect(rules).toContain(`Read(${r}/**)`);
  }
  expect(rules.some((r) => r.includes("ok.ts"))).toBe(false);
});

test("claudeAgent hands claude the link rules with the outside rules (stub claude)", async () => {
  const { wt } = tree();
  const bin = join(tmp, "agent-bin"); mkdirSync(bin);
  const log = join(tmp, "agent.argv");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$@" > ${log}\nprintf '%s\\n' '{"type":"result","subtype":"success","result":"ok"}'\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const out = await claudeAgent({ cwd: wt, system: "S", prompt: "P", limits: { steps: 3, timeoutMs: 10_000 }, onStep: () => {} });
    expect(out.text).toBe("ok");
  } finally { process.env.PATH = path; }
  const argv = readFileSync(log, "utf8").split("\n");
  const denied = argv.slice(argv.indexOf("--disallowedTools") + 1);
  expect(denied).toContain(`Read(/${wt}/src/x.ts)`);
  expect(denied).toContain(`Read(/${wt}/src/dir/**)`);
  expect(denied).not.toContain(`Read(/${wt}/src/ok.ts)`);
});

// ---------------------------------------------------------------- release

const RELEASE = readFileSync(join(import.meta.dir, "../.github/workflows/release.yml"), "utf8");

test("release: a dispatch publishes only from main; tag runs are unchanged; the header says so", () => {
  const publish = RELEASE.slice(RELEASE.indexOf("\n  publish:"));
  const guard = publish.match(/^ {4}if: (.+)$/m)?.[1];
  expect(guard).toBe("github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main'");
  // The guard is on the job, before its steps, not on one step.
  expect(publish.indexOf("    if:")).toBeLessThan(publish.indexOf("    steps:"));
  // Evaluated as Actions would: dispatch from a branch is skipped, from main runs; a v* tag push runs.
  const runs = (event: string, ref: string) => event !== "workflow_dispatch" || ref === "refs/heads/main";
  expect(runs("workflow_dispatch", "refs/heads/evil")).toBe(false);
  expect(runs("workflow_dispatch", "refs/heads/main")).toBe(true);
  expect(runs("push", "refs/tags/v0.1.0")).toBe(true);
  expect(RELEASE).toMatch(/^on:\n {2}workflow_dispatch:\n {2}push:\n {4}tags: \["v\*"\]$/m);
  expect(RELEASE.slice(0, RELEASE.indexOf("\non:"))).toContain("A dispatch publishes only when run on main");
});

test("version: this release is 0.1.8", () => {
  expect(JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).version).toBe("0.1.8");
});
