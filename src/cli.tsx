#!/usr/bin/env bun
// prview: review a pull request in the terminal. A model prepares the reading; you do the reviewing.

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { all, build, checkHead, exportDocument, Fail, filesOf, home, importDocument, load, remove, reopen, repoFor, writeup, type BuildOpts, type Review } from "./build.ts";
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

  Keys:  j/k line   h/l hunk   J/K chapter   123G go to file line   gg/G first/last   ]f [f next/previous finding
         ? why this chapter matters   f finding under the cursor   d dismiss it   a ask about this hunk
         e open the file here in your editor   n comment on this line   N summary comment
         s submit: pick a verdict, preview the review, Enter (saved as <slug>.review.md; posting comes with
         the platform adapters)   q quit (everything is kept)

  prview prepare <target>     build it (fetch, guide, critic) without opening the screen; open it later
  prview list                 reviews that still exist
  prview open <name>          reopen one (e.g. pm-pr-12), rebuilt at the PR's current head
  prview writeup <name>       print the compiled review without opening the screen
  prview export <name>        print its review document (prview-review/1 JSON; schema/ describes it)
  prview import <file | ->    merge a review document's findings and chapters into the review at its
                              head, or start one in this clone; any producer's document, no source named
  prview show <file | ->      import a document, then open it
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
  checkHead(r);
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
      const md = writeup(r.doc, files);
      const out = join(home(), `${r.slug}.review.md`);
      writeFileSync(out, md);
      process.stdout.write(md + `\nSaved to ${out}. Posting to the PR's platform is not built yet; the markdown above is the review.\n`);
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
    else if (a.startsWith("-") && a !== "-" && a !== "-h" && a !== "--help") throw new Fail(`unknown flag ${a}`);
    else rest.push(a);
  }
  opts.say = (s) => process.stderr.write(`prview: ${s}\n`);
  const [cmd, a1] = rest;
  const doc = async () => { if (!a1) throw new Fail(`usage: prview ${cmd} <file | ->`); return a1 === "-" ? Bun.stdin.text() : Bun.file(resolve(a1)).text().catch(() => { throw new Fail(`cannot read ${a1}`); }); };
  switch (cmd) {
    case "-h": case "--help": case "help": console.log(USAGE); return;
    case "list": console.log(all().map(({ slug, doc: { target: t, human: h } }) => `${slug}\t${t.label}\t${h.visited.length} read · ${h.comments.length} notes\t${t.title}`).join("\n")); return;
    case "writeup": { if (!a1) throw new Fail("usage: prview writeup <name>"); const r = load(a1); process.stdout.write(writeup(r.doc, filesOf(r))); return; }
    case "export": { if (!a1) throw new Fail("usage: prview export <name>"); process.stdout.write(exportDocument(load(a1))); return; }
    case "import": { const r = importDocument(await doc(), opts.repo); console.log(`${r.slug}: ${r.doc.plan.chapters.length} chapters, ${r.doc.findings.filter((f) => f.status !== "withdrawn").length} findings. Open it with: prview open ${r.slug}`); return; }
    case "show": { if (!process.stdout.isTTY) throw new Fail("prview needs a terminal"); return review(importDocument(await doc(), opts.repo)); }
    case "done": { if (!a1) throw new Fail("usage: prview done <name>"); console.log(remove(a1)); return; }
    case "open": { if (!a1) throw new Fail("usage: prview open <name> (prview list)"); return review(await reopen(a1, opts)); }
    case "prepare": { const r = await build(repoFor(a1, opts.repo), a1, opts); console.log(`${r.slug}: ${r.doc.plan.chapters.length} chapters, ${r.doc.findings.filter((f) => f.status !== "withdrawn").length} findings. Open it with: prview open ${r.slug}`); return; }
  }
  if (!process.stdout.isTTY) throw new Fail("prview needs a terminal");
  return review(await build(repoFor(cmd, opts.repo), cmd, opts));
}

main(process.argv.slice(2)).then(() => process.exit(0), (e) => {
  if (e instanceof Fail) { console.error(`prview: ${e.message}`); process.exit(1); }
  throw e;
});
