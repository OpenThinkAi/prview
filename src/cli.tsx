#!/usr/bin/env bun
// prview: review a pull request in the terminal. A model prepares the reading; you do the reviewing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { all, build, preparedBy, checkHead, exportDocument, Fail, filesOf, home, importDocument, load, remove, reopen, repoFor, writeup, type BuildOpts, type Review } from "./build.ts";
import { ConfigError, configPath, loadConfig, realLookups, resolveModel, ROLES, type Config } from "./config.ts";
import { describeKeymap, installKeymap } from "./keys.ts";
import { probe } from "./llm.ts";
import { besideIn, editor, editorArgs } from "./editor.ts";
import { show } from "./tui.tsx";
import { submit } from "./submit.ts";
import { clean } from "./sanitize.ts";
import type { Flow } from "./submit-flow.ts";

const USAGE = `usage: prview <PR# | PR url | base..head | branch> [--repo DIR] [--context N] [--ai MODEL | --no-ai] [--samples N] [--blind | --no-blind] [--fresh] [--dry-run]
  Opens the change in a full-screen review: a guide (a model) has ordered the hunks into chapters,
  core change first, tests last, and says what to verify in each; mechanical hunks (whitespace, lock
  files, pure moves, classified by rule) come last; a critic (a model) has raised findings, each
  checked again with more of the file, marked ▲ in the gutter. You read one hunk at a time, ask,
  take notes, and open the real file in your editor ($EDITOR, default hx) at the line under the cursor.

  With no target: the current branch against the default branch. Every open fetches the PR's current
  head; the guide and findings are redone only when the head moved (or with --fresh).
  --blind hides findings in a chapter until you have visited every hunk in it; blind = true in the config
  makes that the default, --no-blind turns it off for a run.
  --dry-run prints the API calls a submit would make and posts nothing (nothing is written or run either).
  --samples N runs the critic N times per chapter (default 2) and keeps what the runs agree on, with votes shown.
  Models are named in ~/.config/prview/config.toml ($PRVIEW_CONFIG) and assigned per role (guide, critic,
  refute, ask); with no config every role is claude -p on your subscription. --ai MODEL uses one named
  model for all four roles this run; --no-ai skips the models.

  Keys (the defaults; [keys] in the config remaps them, prview keys prints yours). Arrows move; the prefixes
  a (AI), f (filter), v (view) and g (go to) hold the rest, and the key panel (bottom right, always there) lists
  the keys for where you are, or a prefix's second keys once it is pressed. Esc backs out of anything.
  The screen: a status area (title, then PR, branches, read, findings by severity, comments, suggested verdict), the
  table of contents and the code, and a bottom panel: the content area (the summary, a chapter's why, a finding's
  detail, docs results, answers, prompts) beside the key panel. Below 60x20 it asks for a larger terminal.
    A review opens in the table of contents, on the first block; the content area shows its chapter's intent and why.
    Table of contents: ↓/↑ (j/k) block (a collapsed chapter is one stop)   ⇧↓/⇧↑ (J/K) chapter
      → (l) expand a chapter, or enter the block's code   ← (h) up to the chapter, then collapse it
      (the mechanical chapter starts collapsed)
    Code: ↓/↑ (j/k) line, running on into the next block   ⇧↓/⇧↑ (J/K) chapter
      → (l) open the finding on this line   ← (h) back to the table of contents
      Enter a finding of your own on this line, or on a file's "whole file" row (its diff starts and ends with one):
        pick a severity (↑/↓, Enter), write the comment (ctrl-n a new line, Enter saves, Esc cancels); it has its
        severity's default action, carried out as your own comment, and then acts like any finding
    Tab into the content area to scroll it, and back
    s submit, four steps (Tab next, ⇧Tab back, Esc leaves and sends nothing):
      1 findings: every finding with its action; block and comment ticked, ignore not (Space ticks one, a all).
        A ticked finding posts its comment on its line: yours from b/c, else the finding's text.
      2 verdict: the platform's verdicts (↑/↓), starting on what the ticks imply; suggestions shown beside it
      3 comment: the review's top-level comment (this is where the old N summary comment went); Enter adds a
        line, Esc stops typing, then v e writes it in your editor
      4 send: exactly what posts, then checkboxes (↑/↓, Space), both off: the document's on_submit command
        (shown in full; no shell) and a line saying how much you read. Enter sends.
      The document is written to $PRVIEW_HOME/submitted/<slug>.json (+ .md) first, then posted through the
      adapter for its target's platform (github: gh api), then the command runs if you ticked it
    y copy the content area (a finding, the summary, an answer) as clean text; with it empty, the line's path:line
      (pbcopy, wl-copy, xclip, else OSC 52; PRVIEW_CLIPBOARD=osc52 forces the terminal route)
    ? search the docs: type what you want to do, Enter lists the matching actions with your keys (offline, no model)
    q quit (everything is kept)
    a then: i the summary · ? ask the model about this block (or the open finding's)
    v then: z zen (hide or show the table of contents) · c the content area full-screen (Esc or v c restores)
            · e open the file here in your editor (inside tmux: in a split pane, this screen stays up) · w wrap
    g then: f/F next/previous finding (wrapping) · h/H next/previous by severity · g/e top/end of the file (the "whole file" rows)
            · <digits> Enter that line of this file (these land in the code)
            · c <digits> Enter that chapter's first block in the table of contents
    Findings are high, medium or low severity, and each has an action: block, comment or ignore. Until you pick
    one it is its severity's default ([defaults] in the config: high = "block", medium and low = "comment"), shown
    as "(default)"; a finding the second look (refute) dropped is shown too, ignored by default, with its reason.
    Inside a finding (→ or g f opens one; its detail fills the content area, a short box stays on its line):
      b block on it: your line comment at the finding's line, prefilled with its text (or your comment);
        edit, Enter saves (ctrl-u clears the line, Esc cancels); submit then defaults to request changes
      c comment: the same, not blocking   i ignore, with an optional private note (never posted)
      pressing b, c or i again changes the action   x or ← close it   y copy it   PgUp/PgDn page it
    \\ settings: every key (primary and secondary), the default action per severity, the model per role, the
      editor and wrap/blind defaults; Enter edits, Esc leaves and asks to save to the config (applied at once)
    Coming with later changes (they say so when pressed): a s drafts.

  prview prepare <target>     build it (fetch, guide, critic) without opening the screen; open it later
  prview models               list the configured models and roles, and check each model is reachable
  prview keys                 print the effective key bindings by state and prefix (action, primary, secondary,
                              description); a bad [keys] table is refused here exactly as at startup
  prview list                 reviews that still exist
  prview open <name>          reopen one (e.g. pm-pr-12), rebuilt at the PR's current head
  prview writeup <name>       print the compiled review without opening the screen
  prview export <name>        print its review document (prview-review/1 JSON; schema/ describes it)
  prview import <file | ->    merge a review document's findings and chapters into the review at its
                              head, or start one in this clone; any producer's document, no source named.
                              Its comments arrive as findings (kind comment) you decide on like any other:
                              c/b adopt one as your own comment to edit, i ignores it. Its verdict is shown
                              in the opening summary, never picked for you; nothing of it is posted as is.
  prview import --mine <file | ->
                              restore your own export: comments, actions and verdict kept as they were
  prview show [--mine] <file | ->
                              import a document, then open it
  prview done <name>          remove it (worktree, fetched refs, state)`;

async function review(r: Review, cfg: Config, blind: boolean, dryRun = false): Promise<void> {
  checkHead(r);
  const files = filesOf(r);
  let blindNow = blind;
  let resume: Flow | undefined;
  for (;;) {
    // A save in the settings view updates `cfg` in place, so the editor and the defaults below are the saved ones.
    const o = await show(r, files, besideIn(r.worktree, process.env, () => cfg.editor), blindNow, dryRun, cfg.defaults, cfg, (c) => { if (c.blind !== cfg.blind) blindNow = c.blind; Object.assign(cfg, c); }, resume);
    resume = undefined;
    if (o.kind === "edit") {
      const cmd = editor(process.env, cfg.editor);
      const p = Bun.spawnSync(editorArgs(cmd, o.path, o.line), { cwd: r.worktree, stdio: ["inherit", "inherit", "inherit"] });
      if (p.exitCode !== 0 && !existsSync(join(r.worktree, o.path))) console.error(`prview: ${o.path} is not in the worktree`);
      continue;
    }
    // The submit flow's comment, written in the editor (always in this terminal: prview waits for it), then back to the flow.
    if (o.kind === "edit_comment") {
      resume = { ...o.flow, comment: editComment(r, o.flow.comment, cfg.editor), typing: false };
      continue;
    }
    if (o.kind === "submit") {
      const res = submit(r, files, { allowHook: o.hook, coverage: o.coverage, selection: o.selection, dryRun, defaults: o.defaults });
      process.stdout.write((dryRun ? "" : writeup(r.doc, files, o.defaults) + "\n") + `${res.summary}\n`);
      if (!res.ok) process.exitCode = 1;
    }
    return;
  }
}

/** Opens `text` in the editor as a file beside the review's state and returns what was saved; on any failure, `text` as it was. */
function editComment(r: Review, text: string, configured?: Config["editor"]): string {
  const file = join(home(), `${r.slug}.comment.md`);
  try { mkdirSync(home(), { recursive: true }); writeFileSync(file, text ? text + "\n" : ""); } catch { return text; }
  const lines = text.split("\n").length;
  const p = Bun.spawnSync(editorArgs(editor(process.env, configured), file, lines), { cwd: r.worktree, stdio: ["inherit", "inherit", "inherit"] });
  if (p.exitCode !== 0) console.error(`prview: the editor exited with ${p.exitCode}; the comment is as it was saved`);
  // Typed by the reader, but through a file: control characters go, as for anything read back from disk.
  try { return clean(readFileSync(file, "utf8")).replace(/\s+$/, ""); } catch { return text; }
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

/** `3 findings`, and how many of them the second look dropped (they open as ignored). */
function findingCount(r: Review): string {
  const n = r.doc.findings.length, dropped = r.doc.findings.filter((f) => f.status === "withdrawn").length;
  return `${n} finding${n === 1 ? "" : "s"}${dropped ? ` (${dropped} dropped by the second look, ignored by default)` : ""}`;
}

/** What opens the screen reads the config first, so a bad [keys] stops prview before any model has been called. */
function start() {
  const cfg = loadConfig();
  installKeymap(cfg.keymap);
  return cfg;
}

async function main(args: string[]): Promise<void> {
  const opts: BuildOpts & { repo?: string; blind?: boolean; dryRun?: boolean; mine?: boolean } = { context: 3, fresh: false };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--repo") opts.repo = resolve(args[++i] ?? ".");
    else if (a === "--context") opts.context = Math.max(0, parseInt(args[++i] ?? "3", 10) || 0);
    else if (a === "--no-ai") opts.ai = null;
    else if (a === "--blind") opts.blind = true;
    else if (a === "--no-blind") opts.blind = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--mine") opts.mine = true;
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
  if (opts.mine && cmd !== "import" && cmd !== "show") throw new Fail("--mine only goes with import or show: prview import --mine <file>");
  // The flag wins over the config either way; the config is only read when a screen is about to open.
  const doc = async () => { if (!a1) throw new Fail(`usage: prview ${cmd} <file | ->`); return a1 === "-" ? Bun.stdin.text() : Bun.file(resolve(a1)).text().catch(() => { throw new Fail(`cannot read ${a1}`); }); };
  switch (cmd) {
    case "-h": case "--help": case "help": console.log(USAGE); return;
    case "models": return models();
    case "keys": console.log(describeKeymap(loadConfig().keymap)); return;
    case "list": console.log(all().map(({ slug, doc: { target: t, human: h } }) => `${slug}\t${t.label}\t${h.visited.length} read · ${h.comments.length} notes\t${t.title}`).join("\n")); return;
    case "writeup": { if (!a1) throw new Fail("usage: prview writeup <name>"); const r = load(a1); process.stdout.write(writeup(r.doc, filesOf(r), loadConfig().defaults)); const by = preparedBy(r.ai?.runs); if (by) process.stderr.write(`${by}\n`); return; }
    case "export": { if (!a1) throw new Fail("usage: prview export <name>"); process.stdout.write(exportDocument(load(a1))); return; }
    case "import": { const r = importDocument(await doc(), opts.repo, opts.mine); console.log(`${r.slug}: ${r.doc.plan.chapters.length} chapters, ${findingCount(r)}. Open it with: prview open ${r.slug}`); return; }
    case "show": { if (!process.stdout.isTTY) throw new Fail("prview needs a terminal"); const cfg = start(); return review(importDocument(await doc(), opts.repo, opts.mine), cfg, opts.blind ?? cfg.blind, opts.dryRun); }
    case "done": { if (!a1) throw new Fail("usage: prview done <name>"); console.log(remove(a1)); return; }
    case "open": { if (!a1) throw new Fail("usage: prview open <name> (prview list)"); const cfg = start(); return review(await reopen(a1, opts), cfg, opts.blind ?? cfg.blind, opts.dryRun); }
    case "prepare": { const r = await build(repoFor(a1, opts.repo), a1, opts); console.log(`${r.slug}: ${r.doc.plan.chapters.length} chapters, ${findingCount(r)}. Open it with: prview open ${r.slug}`); return; }
  }
  const cfg = start();
  if (!process.stdout.isTTY) throw new Fail("prview needs a terminal");
  return review(await build(repoFor(cmd, opts.repo), cmd, opts), cfg, opts.blind ?? cfg.blind, opts.dryRun);
}

main(process.argv.slice(2)).then(() => process.exit(Number(process.exitCode ?? 0)), (e) => {
  if (e instanceof Fail || e instanceof ConfigError) { console.error(`prview: ${e.message}`); process.exit(1); }
  throw e;
});
