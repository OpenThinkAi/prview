#!/usr/bin/env bun
// prview: review a pull request in the terminal. A model prepares the reading; you do the reviewing.

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { all, build, Fail, filesOf, home, load, remove, reopen, repoFor, save, writeup, type BuildOpts, type Review } from "./build.ts";
import { PROVIDERS, type Provider } from "./llm.ts";
import { show } from "./tui.tsx";

const USAGE = `usage: prview <PR# | PR url | base..head | branch> [--repo DIR] [--context N] [--ai claude|qwen|gemma|deepseek | --no-ai] [--fresh]
  Opens the change in a full-screen review: a guide (a model) has ordered the hunks into chapters,
  core change first, tests last, and says what to verify in each; mechanical hunks (whitespace, lock
  files, pure moves, classified by rule) come last; a critic (a model) has raised findings, each
  checked again with more of the file, marked ▲ in the gutter. You read one hunk at a time, ask,
  take notes, and open the real file in your editor ($EDITOR, default hx) at the line under the cursor.

  With no target: the current branch against the default branch. Every open fetches the PR's current
  head; the guide and findings are redone only when the head moved (or with --fresh).
  --ai picks the model (claude, the default, is claude -p on your subscription); --no-ai skips the models.

  Keys:  j/k line   h/l hunk   J/K chapter   ? what to verify here   f next finding   d dismiss it
         a ask about this hunk   e open in the editor   n note on this line   N general note
         s write-up (notes + coverage, to stdout and <slug>.review.md)   q quit (everything is kept)

  prview prepare <target>     build it (fetch, guide, critic) without opening the screen; open it later
  prview list                 reviews that still exist
  prview open <name>          reopen one (e.g. pm-pr-12), rebuilt at the PR's current head
  prview writeup <name>       print the write-up without opening the screen
  prview done <name>          remove it (worktree, fetched refs, state)`;

function editor(): string[] {
  const e = process.env.PRVIEW_EDITOR ?? process.env.EDITOR ?? "hx";
  return e.split(/\s+/).filter(Boolean);
}

/** `hx +12 file`, `vim +12 file`, `code -g file:12`, `zed file:12`: the common ways to say "open here". */
function editorArgs(cmd: string[], path: string, line: number): string[] {
  const bin = cmd[0]!.split("/").pop()!;
  if (/^(code|cursor|codium)$/.test(bin)) return [...cmd, "-g", `${path}:${line}`, "--wait"];
  if (/^(zed|subl)$/.test(bin)) return [...cmd, `${path}:${line}`];
  return [...cmd, `+${line}`, path];
}

async function review(r: Review): Promise<void> {
  const files = filesOf(r);
  for (;;) {
    const o = await show(r, files);
    if (o.kind === "edit") {
      const cmd = editor();
      const p = Bun.spawnSync(editorArgs(cmd, o.path, o.line), { cwd: r.worktree, stdio: ["inherit", "inherit", "inherit"] });
      if (p.exitCode !== 0 && !existsSync(join(r.worktree, o.path))) console.error(`prview: ${o.path} is not in the worktree`);
      continue;
    }
    if (o.kind === "submit") {
      const md = writeup(r, files);
      const out = join(home(), `${r.slug}.review.md`);
      writeFileSync(out, md);
      process.stdout.write(md + `\n(written to ${out})\n`);
    }
    return;
  }
}

async function main(args: string[]): Promise<void> {
  const opts: BuildOpts & { repo?: string } = { context: 3, ai: "claude", fresh: false };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--repo") opts.repo = resolve(args[++i] ?? ".");
    else if (a === "--context") opts.context = Math.max(0, parseInt(args[++i] ?? "3", 10) || 0);
    else if (a === "--no-ai") opts.ai = null;
    else if (a === "--fresh") opts.fresh = true;
    else if (a === "--ai") {
      const p = args[++i] as Provider;
      if (!PROVIDERS.includes(p)) throw new Fail(`--ai takes one of ${PROVIDERS.join(", ")}`);
      opts.ai = p;
    }
    else if (a.startsWith("-") && a !== "-h" && a !== "--help") throw new Fail(`unknown flag ${a}`);
    else rest.push(a);
  }
  opts.say = (s) => process.stderr.write(`prview: ${s}\n`);
  const [cmd, a1] = rest;
  switch (cmd) {
    case "-h": case "--help": case "help": console.log(USAGE); return;
    case "list": console.log(all().map((r) => `${r.slug}\t${r.label}\t${r.visited.length} read · ${r.notes.length} notes\t${r.title}`).join("\n")); return;
    case "writeup": { if (!a1) throw new Fail("usage: prview writeup <name>"); const r = load(a1); process.stdout.write(writeup(r, filesOf(r))); return; }
    case "done": { if (!a1) throw new Fail("usage: prview done <name>"); console.log(remove(load(a1))); return; }
    case "open": { if (!a1) throw new Fail("usage: prview open <name> (prview list)"); return review(await reopen(a1, opts)); }
    case "prepare": { const r = await build(repoFor(a1, opts.repo), a1, opts); console.log(`${r.slug}: ${r.plan.chapters.length} chapters, ${r.findings.filter((f) => f.status !== "withdrawn").length} findings. Open it with: prview open ${r.slug}`); return; }
  }
  if (!process.stdout.isTTY) throw new Fail("prview needs a terminal");
  const r = await build(repoFor(cmd, opts.repo), cmd, opts);
  save(r);
  return review(r);
}

main(process.argv.slice(2)).then(() => process.exit(0), (e) => {
  if (e instanceof Fail) { console.error(`prview: ${e.message}`); process.exit(1); }
  throw e;
});
