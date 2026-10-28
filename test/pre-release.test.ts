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

/** A stub claude on PATH that records its argv and a copy of the --settings file (prview removes the file after exit). */
function stubClaude(name: string): { argv: () => string[]; settings: () => { permissions: { deny: string[] } }; restore: () => void } {
  const bin = join(tmp, `${name}-bin`); mkdirSync(bin);
  const log = join(tmp, `${name}.argv`), copy = join(tmp, `${name}.settings.json`);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$@" > ${log}\nwhile [ $# -gt 0 ]; do [ "$1" = --settings ] && cp "$2" ${copy}; shift; done\nprintf '%s\\n' '{"type":"result","subtype":"success","result":"ok"}'\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  return { argv: () => readFileSync(log, "utf8").split("\n"), settings: () => JSON.parse(readFileSync(copy, "utf8")), restore: () => { process.env.PATH = path; } };
}

test("claudeAgent runs claude --restricted in the worktree with the link and [deep] deny rules in a settings file it removes afterwards (stub claude)", async () => {
  const { wt } = tree();
  const stub = stubClaude("agent");
  try {
    const out = await claudeAgent({ cwd: wt, system: "S", prompt: "P", limits: { steps: 3, timeoutMs: 10_000, deny: [".env*"] }, onStep: () => {} });
    expect(out.text).toBe("ok");
  } finally { stub.restore(); }
  const argv = stub.argv();
  expect(argv).toContain("--restricted");
  expect(argv).not.toContain("--disallowedTools");
  const file = argv[argv.indexOf("--settings") + 1]!;
  expect(file.startsWith(`${wt}/`)).toBe(false); // outside the worktree, where --restricted keeps the agent from it
  const denied = stub.settings().permissions.deny;
  expect(denied).toContain(`Read(/${wt}/src/x.ts)`);
  expect(denied).toContain(`Read(/${wt}/src/dir/**)`);
  expect(denied).not.toContain(`Read(/${wt}/src/ok.ts)`);
  expect(denied).toContain(`Read(/${wt}/**/.env*)`); // [deep] deny
  // It is gone once claude has exited.
  for (let i = 0; i < 50 && existsSync(file); i++) await Bun.sleep(10);
  expect(existsSync(file)).toBe(false);
});

test("claudeAgent: a crowded directory on the way to the worktree (thousands of siblings) still spawns claude; neither argv nor rules grow with it", async () => {
  const crowd = join(tmp, "crowd"), wt = join(crowd, "wt");
  mkdirSync(wt, { recursive: true });
  // Long names so the old argv form (two rules per sibling) is far past ARG_MAX (1 MiB on macOS): 6000 × ~2 × 220 bytes.
  const long = "s".repeat(200);
  for (let i = 0; i < 6000; i++) writeFileSync(join(crowd, `${long}-${i}`), "");
  const stub = stubClaude("crowd");
  try {
    const out = await claudeAgent({ cwd: wt, system: "S", prompt: "P", limits: { steps: 3, timeoutMs: 30_000 }, onStep: () => {} });
    expect(out.text).toBe("ok");
  } finally { stub.restore(); }
  const argv = stub.argv();
  expect(argv).toContain("--restricted"); // what confines it: claude refuses every path outside its working directory
  expect(argv.join("\n").length).toBeLessThan(20_000); // argv no longer grows with the siblings (it held 12k rules before)
  // Nor does the settings file: no rule names a sibling.
  expect(stub.settings().permissions.deny.filter((r) => r.includes(long))).toEqual([]);
  expect(JSON.stringify(stub.settings()).length).toBeLessThan(10_000);
});

// ---------------------------------------------------------------- the embedder build

test("build-embedder: every downloaded file has a pinned sha256, checked before anything is converted (download or --from)", () => {
  const src = readFileSync(join(import.meta.dir, "../scripts/build-embedder.ts"), "utf8");
  const pins = src.slice(src.indexOf("const SHA256"), src.indexOf("const FILES"));
  for (const f of ["config.json", "tokenizer.json", "model.safetensors"]) expect(pins, f).toMatch(new RegExp(`"${f.replace(".", "\\.")}": "[0-9a-f]{64}"`));
  expect(src).toContain("const FILES = Object.keys(SHA256);");
  const main = src.slice(src.indexOf("async function main("));
  // verify() is the first thing after choosing the source, before any file is read.
  expect(main.indexOf("verify(src);")).toBeGreaterThan(0);
  expect(main.indexOf("verify(src);")).toBeLessThan(main.indexOf("readFileSync"));
});

// ---------------------------------------------------------------- release

const RELEASE = readFileSync(join(import.meta.dir, "../.github/workflows/release.yml"), "utf8");

test("release: only a dispatch on main publishes; there is no tag trigger; the header says so", () => {
  const publish = RELEASE.slice(RELEASE.indexOf("\n  publish:"));
  const guard = publish.match(/^ {4}if: (.+)$/m)?.[1];
  expect(guard).toBe("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
  // The guard is on the job, before its steps, not on one step.
  expect(publish.indexOf("    if:")).toBeLessThan(publish.indexOf("    steps:"));
  // Evaluated as Actions would: only a dispatch from main runs; a branch dispatch or any tag push is skipped.
  const runs = (event: string, ref: string) => event === "workflow_dispatch" && ref === "refs/heads/main";
  expect(runs("workflow_dispatch", "refs/heads/evil")).toBe(false);
  expect(runs("workflow_dispatch", "refs/heads/main")).toBe(true);
  expect(runs("push", "refs/tags/v0.1.0")).toBe(false);
  // The only trigger is workflow_dispatch: a v* tag can point at an unreviewed commit, so no push trigger.
  const on = RELEASE.slice(RELEASE.indexOf("\non:\n") + 1, RELEASE.indexOf("\npermissions:"));
  expect(on.trim()).toBe("on:\n  workflow_dispatch:");
  expect(RELEASE).not.toMatch(/^\s*(push|tags|release):/m);
  expect(RELEASE).not.toContain("ref_type == 'tag'");
  expect(RELEASE.slice(0, RELEASE.indexOf("\non:"))).toContain("deliberately no `push: tags` trigger");
});

test("version: this release is 0.1.10", () => {
  expect(JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).version).toBe("0.1.10");
});
