#!/usr/bin/env bun
// prview: review a pull request in the terminal. A model prepares the reading; you do the reviewing.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { all, build, checkHead, exportDocument, Fail, filesOf, importDocument, load, remove, reopen, repoFor, writeup, type BuildOpts, type Review } from "./build.ts";
import { ConfigError, configPath, loadConfig, realLookups, resolveModel, ROLES } from "./config.ts";
import { probe } from "./llm.ts";
import { besideIn, editor, editorArgs } from "./editor.ts";
import { show } from "./tui.tsx";
import { submit } from "./submit.ts";

const USAGE = `usage: prview <PR# | PR url | base..head | branch> [--repo DIR] [--context N] [--ai MODEL | --no-ai] [--samples N] [--blind | --no-blind] [--fresh] [--dry-run]
  Opens the change in a full-screen review: a guide (a model) has ordered the hunks into chapters,
  core change first, tests last, and says what to verify in each; mechanical hunks (whitespace, lock
  files, pure moves, classified by rule) come last; a critic (a model) has raised findings, each
  checked again with more of the file, marked ▲ in the gutter. You read one hunk at a time, ask,
  take notes, and open the real file in your editor ($EDITOR, default hx) at the line under the cursor.

  With no target: the current branch against the default branch. Every open fetches the PR's current
  head; the guide and findings are redone only when the head moved (or with --fresh).
  --blind hides findings in a chapter until you have visited every hunk in it (F reveals early, and the
  write-up says so); blind = true in the config makes that the default, --no-blind turns it off for a run.
  --dry-run prints the API calls a submit would make and posts nothing (nothing is written or run either).
  --samples N runs the critic N times per chapter (default 2) and keeps what the runs agree on, with votes shown.
  Models are named in ~/.config/prview/config.toml ($PRVIEW_CONFIG) and assigned per role (guide, critic,
  refute, ask); with no config every role is claude -p on your subscription. --ai MODEL uses one named
  model for all four roles this run; --no-ai skips the models.

  Keys:  j/k line   h/l hunk   J/K chapter   123G go to file line   gg/G first/last   ]f [f next/previous finding
         F reveal this chapter's findings early (--blind only)
         ? why this chapter matters   f finding under the cursor   d dismiss it   a ask about this hunk
         y copy the open box (finding, ? why, ask answer) as clean text; with none open, the line's path:line
           (pbcopy, wl-copy, xclip, else OSC 52; PRVIEW_CLIPBOARD=osc52 forces the terminal route)
         e open the file here in your editor (inside tmux: in a split pane, this screen stays up)
         n comment on this line   N summary comment   w wrap long lines   H/L pan them sideways
         PgUp/PgDn (ctrl-u/ctrl-d) page an open box   below 100 columns the rail shows chapter numbers only
         s submit: pick a verdict, say whether to add your kept findings as comments (y/N; only the claim is
           posted, as your own comment), preview the review and what submit will do, Enter. The document is
           written to $PRVIEW_HOME/submitted/<slug>.json (+ .md), then posted through the adapter for its
           target's platform (github: gh api), then, if the document declares on_submit, its command runs
           only if you press x in the preview to allow it (shown in full first; no shell); v in the preview
           adds a line saying how much you read to the posted summary (off by default)
         q quit (everything is kept)

  prview prepare <target>     build it (fetch, guide, critic) without opening the screen; open it later
  prview models               list the configured models and roles, and check each model is reachable
  prview list                 reviews that still exist
  prview open <name>          reopen one (e.g. pm-pr-12), rebuilt at the PR's current head
  prview writeup <name>       print the compiled review without opening the screen
  prview export <name>        print its review document (prview-review/1 JSON; schema/ describes it)
  prview import <file | ->    merge a review document's findings and chapters into the review at its
                              head, or start one in this clone; any producer's document, no source named
  prview show <file | ->      import a document, then open it
  prview done <name>          remove it (worktree, fetched refs, state)`;

async function review(r: Review, blind: boolean, dryRun = false): Promise<void> {
  checkHead(r);
  const files = filesOf(r);
  for (;;) {
    const o = await show(r, files, besideIn(r.worktree), blind, dryRun);
    if (o.kind === "edit") {
      const cmd = editor();
      const p = Bun.spawnSync(editorArgs(cmd, o.path, o.line), { cwd: r.worktree, stdio: ["inherit", "inherit", "inherit"] });
      if (p.exitCode !== 0 && !existsSync(join(r.worktree, o.path))) console.error(`prview: ${o.path} is not in the worktree`);
      continue;
    }
    if (o.kind === "submit") {
      const res = submit(r, files, { allowHook: o.hook, findings: o.findings, coverage: o.coverage, dryRun });
      process.stdout.write((dryRun ? "" : writeup(r.doc, files) + "\n") + `${res.summary}\n`);
      if (!res.ok) process.exitCode = 1;
    }
    return;
  }
}

async function models(): Promise<void> {
  const cfg = loadConfig();
  console.log(`config: ${cfg.path ?? `none at ${configPath()}; using the built-in claude model`}`);
  const rows = await Promise.all(Object.values(cfg.models).map(async (def) => {
    // A missing credential is reported per model here rather than aborting the list.
    let status: string;
    try { status = await probe(resolveModel(cfg, def.name, realLookups())); } catch (e) { status = (e as Error).message.replace(/^model \S+: /, ""); }
    return [def.name, def.kind, def.endpoint ?? "-", def.model ?? "-", status];
  }));
  for (const r of [["name", "kind", "endpoint", "model", "status"], ...rows]) console.log(r.join("\t"));
  console.log(`roles: ${ROLES.map((r) => `${r}=${cfg.roles[r] ?? "claude"}`).join(" ")}`);
}

async function main(args: string[]): Promise<void> {
  const opts: BuildOpts & { repo?: string; blind?: boolean; dryRun?: boolean } = { context: 3, fresh: false };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--repo") opts.repo = resolve(args[++i] ?? ".");
    else if (a === "--context") opts.context = Math.max(0, parseInt(args[++i] ?? "3", 10) || 0);
    else if (a === "--no-ai") opts.ai = null;
    else if (a === "--blind") opts.blind = true;
    else if (a === "--no-blind") opts.blind = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--fresh") opts.fresh = true;
    else if (a === "--samples") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 9) throw new Fail("--samples takes a whole number from 1 to 9");
      opts.samples = n;
    }
    else if (a === "--ai") {
      const n = args[++i];
      if (!n || n.startsWith("-")) throw new Fail("--ai takes a model name from your config (prview models)");
      opts.ai = n;
    }
    else if (a.startsWith("-") && a !== "-" && a !== "-h" && a !== "--help") throw new Fail(`unknown flag ${a}`);
    else rest.push(a);
  }
  opts.say = (s) => process.stderr.write(`prview: ${s}\n`);
  const [cmd, a1] = rest;
  // The flag wins over the config either way; the config is only read when a screen is about to open.
  const blind = () => opts.blind ?? loadConfig().blind;
  const doc = async () => { if (!a1) throw new Fail(`usage: prview ${cmd} <file | ->`); return a1 === "-" ? Bun.stdin.text() : Bun.file(resolve(a1)).text().catch(() => { throw new Fail(`cannot read ${a1}`); }); };
  switch (cmd) {
    case "-h": case "--help": case "help": console.log(USAGE); return;
    case "models": return models();
    case "list": console.log(all().map(({ slug, doc: { target: t, human: h } }) => `${slug}\t${t.label}\t${h.visited.length} read · ${h.comments.length} notes\t${t.title}`).join("\n")); return;
    case "writeup": { if (!a1) throw new Fail("usage: prview writeup <name>"); const r = load(a1); process.stdout.write(writeup(r.doc, filesOf(r))); return; }
    case "export": { if (!a1) throw new Fail("usage: prview export <name>"); process.stdout.write(exportDocument(load(a1))); return; }
    case "import": { const r = importDocument(await doc(), opts.repo); console.log(`${r.slug}: ${r.doc.plan.chapters.length} chapters, ${r.doc.findings.filter((f) => f.status !== "withdrawn").length} findings. Open it with: prview open ${r.slug}`); return; }
    case "show": { if (!process.stdout.isTTY) throw new Fail("prview needs a terminal"); return review(importDocument(await doc(), opts.repo), blind(), opts.dryRun); }
    case "done": { if (!a1) throw new Fail("usage: prview done <name>"); console.log(remove(a1)); return; }
    case "open": { if (!a1) throw new Fail("usage: prview open <name> (prview list)"); return review(await reopen(a1, opts), blind(), opts.dryRun); }
    case "prepare": { const r = await build(repoFor(a1, opts.repo), a1, opts); console.log(`${r.slug}: ${r.doc.plan.chapters.length} chapters, ${r.doc.findings.filter((f) => f.status !== "withdrawn").length} findings. Open it with: prview open ${r.slug}`); return; }
  }
  if (!process.stdout.isTTY) throw new Fail("prview needs a terminal");
  return review(await build(repoFor(cmd, opts.repo), cmd, opts), blind(), opts.dryRun);
}

main(process.argv.slice(2)).then(() => process.exit(Number(process.exitCode ?? 0)), (e) => {
  if (e instanceof Fail || e instanceof ConfigError) { console.error(`prview: ${e.message}`); process.exit(1); }
  throw e;
});
