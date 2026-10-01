// Building a review: what to read (a PR or a base..head range), a worktree at its head so an editor
// can open the real files, and the review document for it. The guide, critic and refute passes are
// the default producer: they write a document like any other producer would, and it is merged into
// the review the same way `prview import` merges one.
//
// Store: ~/.cache/prview (or $PRVIEW_HOME)
//   <slug>/        worktree at the head: the editor runs here
//   <slug>.json    the document, plus what only this machine needs (where the clone and worktree
//                  are, the cursor, which model ran)

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { earlyTitles } from "./blind.ts";
import { filterOf, type Filter } from "./filter.ts";
import { clean, visible } from "./sanitize.ts";
import { actionOf, actionText, DEFAULTS, IN_HOUSE, suggestVerdict, type Defaults } from "./triage.ts";
import { parseDiff, type FileDiff } from "./diff.ts";
import { readInTree } from "./intree.ts";
import { blank, Fail, fit, merge, parseDocument, SCHEMA, suggestions, type Comment, type Doc, type Suggested, type Target } from "./document.ts";
import {
  applyReask, applyRefute, classify, CRITIC_SYSTEM, criticPrompt, filePlan, GUIDE_SYSTEM, guidePrompt, hunksOf, refutable,
  mergeFindings, readCritic, readGuide, applyTitleReask, TITLE_REASK_SYSTEM, titleReaskPrompt, titleOf, REASK_SYSTEM, reaskPrompt, REFUTE_SYSTEM, refutePrompt, type Chapter, type Finding, type HunkAt, type Mechanical, type Plan,
} from "./guide.ts";
import { loadConfig, realLookups, resolveRoles, type Resolved, type Role } from "./config.ts";
import { complete, modelLabel, pool, type Usage } from "./llm.ts";
import { reviveAsks, type Asks } from "./deep.ts";
import { git, hasCommit, prSlug, remoteFor, run, type ResolveCtx, type Source } from "./pr.ts";
import type { Http } from "./azure-auth.ts";
import { isPR, parseRef, prIn, sourceOf } from "./registry.ts";
import { carry, type Carried } from "./carryover.ts";
import { rereviewOf } from "./rereview.ts";
import { sinceOf, type Since } from "./since.ts";

export { Fail };
/** One model call: which role, how long, what it cost where the provider reports it. */
export type Run = { role: "guide" | "critic" | "refute" | "deep" | "ask"; /** the configured model's name */ name?: string; /** the concrete id the model reported, or the config's */ model?: string; ms: number; cost?: number };

/**
 * "Prepared by claude-opus-5-5 (guide), claude-sonnet-5-5 (critic, refute)": one short local line, never part of anything posted.
 * A run with neither a model id nor a configured name (a review stored before ids were recorded) makes the whole line absent:
 * a line naming "unknown" tells the reader nothing.
 */
export function preparedBy(runs: Run[] | undefined): string | undefined {
  const by = new Map<string, string[]>();
  for (const role of ["guide", "critic", "refute"] as const) {
    const r = runs?.find((x) => x.role === role);
    if (!r) continue;
    const id = r.model ?? r.name;
    if (!id) return undefined;
    by.set(id, [...(by.get(id) ?? []), role]);
  }
  return by.size ? `Prepared by ${[...by].map(([id, roles]) => `${id} (${roles.join(", ")})`).join(", ")}` : undefined;
}
/** `models` names what each role used, so `ask` in a reopened review talks to the same model. */
export type Ai = { models: Partial<Record<Role, string>>; at: string; errors: string[]; samples?: number; runs?: Run[] };
export type Pos = { item: number; line: number };
/** `ref` is what was asked for (a PR's canonical URL, a PR number in a review stored before URLs were, or a range), so the review can be rebuilt at a newer head. */
/** `suggested`: the verdicts of documents imported at this head, shown in the opening summary as information only. */
/** `asks`: the `a ?` conversations, by subject, kept on this machine only (never in the document). */
export type Review = { slug: string; repo: string; ref?: string; worktree: string; context: number; created: string; pos: Pos; /** The severity filter (`f h`/`f m`/`f a`), kept here with the reader's place, never in the document; absent means all. */ filter?: Filter; ai?: Ai; doc: Doc; suggested?: Suggested[]; asks?: Asks; /** Where the reader's carried-over comments came from (carryover.ts), kept with the review, never in the document. */ carried?: Carried; /** A re-review (rereview.ts): the head last submitted at and what changed since; never in the document. */ since?: Since; /** `v s`: only the blocks changed since that review are shown, kept like the filter. */ sinceOnly?: true };

export const home = () => process.env.PRVIEW_HOME ?? join(homedir(), ".cache", "prview");
const metaOf = (slug: string) => join(home(), `${slug}.json`);

// ---------------------------------------------------------------- what to review

function defaultBranch(repo: string): string {
  const r = Bun.spawnSync(["git", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { cwd: repo });
  if (r.exitCode === 0) return r.stdout.toString().trim();
  for (const b of ["main", "master"]) if (Bun.spawnSync(["git", "rev-parse", "-q", "--verify", b], { cwd: repo }).exitCode === 0) return b;
  throw new Fail("no default branch found: pass a range like main..my-branch");
}

/** A branch name as a slug part; a full commit id is cut to twelve characters. */
const slugPart = (s: string) => s.replace(/^([0-9a-f]{12})[0-9a-f]{28}$/, "$1").replace(/[^\w.-]+/g, "-");

function fromRange(repo: string, spec: string | undefined): Source {
  let [base, head] = spec?.includes("..") ? spec.split(/\.{2,3}/) as [string, string] : [defaultBranch(repo), spec ?? "HEAD"];
  if (!base) base = defaultBranch(repo);
  if (!head) head = "HEAD";
  const headSha = git(["rev-parse", "--verify", `${head}^{commit}`], repo);
  const baseSha = git(["merge-base", base, headSha], repo);
  const title = clean(git(["log", "-1", "--format=%s", headSha], repo));
  const body = clean(git(["log", "--reverse", "--format=%s%n%n%b", `${baseSha}..${headSha}`], repo));
  const slug = `${basename(repo)}-${slugPart(head === "HEAD" ? git(["rev-parse", "--abbrev-ref", "HEAD"], repo) : head)}`;
  return { slug, target: { repo: basename(repo), base: baseSha, head: headSha, title, body, label: `${base}..${head}` } };
}

export { isPR };

/** A pull request through its platform's source (registry.ts): the canonical URL is what the review stores as its ref. */
function fromPR(repo: string, target: string, ctx: ResolveCtx): Source | Promise<Source> {
  const { source, ref } = prIn(repo, target);
  return source.resolve(repo, ref, ctx);
}

// ---------------------------------------------------------------- the model passes

export type Progress = (s: string) => void;
/** How a pass reaches a model: `complete` in use, a stub in tests (the fencing contract is tested through the whole pipeline). */
export type Call = typeof complete;

/**
 * The guide's pass: one call, and one more only if the parser had to cut a line to fit. A failed
 * re-ask keeps the cut plan; a failed first call throws, and the caller falls back to file order.
 */
export async function runGuide(model: Resolved, src: { title: string; body: string }, hunks: HunkAt[], mechanical: Mechanical[], say: Progress = () => {}, usage?: (u: Usage) => void, call: Call = complete): Promise<{ plan: Plan; reasked: number; errors: string[] }> {
  const { plan, cuts, summarySaid } = readGuide(await call(model, GUIDE_SYSTEM, guidePrompt(src, hunks, mechanical), usage), hunks, mechanical);
  if (!cuts.length) return { plan, reasked: 0, errors: [] };
  say(`guide: ${cuts.length} line${cuts.length === 1 ? "" : "s"} too long, asking once more…`);
  try { return { plan: applyReask(plan, cuts, await call(model, REASK_SYSTEM, reaskPrompt(src.title, cuts, summarySaid), usage)), reasked: cuts.length, errors: [] }; }
  catch (e) { return { plan, reasked: cuts.length, errors: [`guide re-ask: ${(e as Error).message}`] }; }
}

/** One critic run: parsed, with one re-ask for any title that had to be cut (a failed re-ask keeps the cut titles). */
export async function runCritic(model: Resolved, prompt: string, chapter: Chapter, hunks: HunkAt[], usage?: (u: Usage) => void, call: Call = complete): Promise<Finding[]> {
  const { findings, cuts } = readCritic(await call(model, CRITIC_SYSTEM, prompt, usage), chapter, hunks, 0);
  if (!cuts.length) return findings;
  try { return applyTitleReask(findings, cuts, await call(model, TITLE_REASK_SYSTEM, titleReaskPrompt(findings, cuts), usage)); }
  catch { return findings; }
}

/** The default producer: the guide orders the hunks, the critic raises findings, refute re-checks them. Exported for the pipeline tests. */
export async function guideAndCritic(src: Target, files: FileDiff[], worktree: string, models: Pick<Record<Role, Resolved>, "guide" | "critic" | "refute">, samples: number, say: Progress, call: Call = complete): Promise<{ doc: Doc; errors: string[]; runs: Run[] }> {
  const errors: string[] = [], runs: Run[] = [];
  // The id each role shows: the config's own until a reply says better, `default` if neither is known yet.
  // Keyed by model name, so a role sharing a model another role has already heard from starts with the real id.
  const seen: Record<string, string> = {};
  const tag = (role: Exclude<Run["role"], "deep" | "ask">) => `${role} [${modelLabel(models[role].def.name, seen[models[role].def.name] ?? models[role].def.model)}]`;
  const timed = (role: Exclude<Run["role"], "deep" | "ask">) => (u: Usage) => {
    if (u.model) seen[models[role].def.name] = u.model;
    runs.push({ role, name: models[role].def.name, ...u, model: u.model ?? models[role].def.model });
  };
  const mechanical = classify(files);
  const hunks = hunksOf(files);
  let plan: Plan;
  say(`${tag("guide")}: reading ${hunks.length - mechanical.length} hunks (${mechanical.length} mechanical)…`);
  try { const g = await runGuide(models.guide, src, hunks, mechanical, (m) => say(m.replace(/^guide:/, `${tag("guide")}:`)), timed("guide"), call); plan = g.plan; errors.push(...g.errors); }
  catch (e) { errors.push(`guide: ${(e as Error).message}`); plan = filePlan(files, mechanical); }
  say(`${tag("guide")}: ${plan.chapters.length} chapters${plan.by === "files" ? " (by file: the guide failed)" : ""}`);

  // One critic run is a coin flip on what it notices, so each chapter is read `samples` times and the
  // runs are merged; a run that fails costs a vote, not the chapter.
  say(`${tag("critic")}: ${plan.chapters.length} chapters x ${samples} run${samples === 1 ? "" : "s"}…`);
  const reviews = await pool(plan.chapters.map((c, i) => async () => {
    const prompt = criticPrompt(src, c, hunks);
    const each = await Promise.all(Array.from({ length: samples }, () =>
      runCritic(models.critic, prompt, c, hunks, timed("critic"), call).catch((e) => e instanceof Error ? e : new Error(String(e)))));
    const ok = each.filter((r): r is Finding[] => !(r instanceof Error));
    for (const r of each) if (r instanceof Error) errors.push(`critic (${c.title}): ${r.message}`);
    if (!ok.length) throw new Error("every run failed");
    const fs = mergeFindings(ok, i * 100);
    say(`${tag("critic")}: ${i + 1}. ${c.title} → ${fs.length} finding${fs.length === 1 ? "" : "s"}`);
    return fs;
  }));
  let findings: Finding[] = [];
  reviews.forEach((r, i) => { if (r instanceof Error) errors.push(`critic (${plan.chapters[i]!.title}): ${r.message}`); else findings.push(...r); });

  const contested = findings.filter((f) => f.severity !== "low");
  if (contested.length) say(`${tag("refute")}: checking ${contested.length} finding${contested.length === 1 ? "" : "s"}…`);
  const at = new Map(hunks.map((h) => [h.id, h]));
  // A symlink, or a path out of the worktree, is never read for the prompt (src/intree.ts); refute then sees only the hunk.
  const skipped = new Set<string>();
  const verdicts = await pool(contested.map((f) => async () => {
    const h = at.get(f.hunk)!;
    const got = f.side === "new" ? readInTree(worktree, h.file.path) : { missing: true as const };
    if ("skipped" in got && !skipped.has(got.skipped)) { skipped.add(got.skipped); say(`${tag("refute")}: ${visible(clean(got.skipped))}`); }
    const text = "text" in got ? got.text : null;
    // A withdrawal has to cite a line the prompt showed; `refutable` says which those were.
    return applyRefute(f, await call(models.refute, REFUTE_SYSTEM, refutePrompt(f, h.hunk!, text), timed("refute")), refutable(f, h.hunk!, text));
  }));
  const settled = new Map<string, Finding>();
  verdicts.forEach((v, i) => { if (v instanceof Error) errors.push(`refute: ${v.message}`); else settled.set(contested[i]!.id, v); });
  findings = findings.map((f) => settled.get(f.id) ?? f);
  const kept = findings.filter((f) => f.status !== "withdrawn").length;
  say(`findings: ${kept} kept, ${findings.length - kept} dropped by the second look (shown as ignored)`);
  return { doc: { ...blank(src), plan, findings }, errors, runs };
}

// ---------------------------------------------------------------- the store

export const filesOf = (r: Pick<Review, "repo" | "context" | "doc">) =>
  parseDiff(run(["git", "diff", "-M", "--no-color", "--no-ext-diff", `-U${r.context}`, r.doc.target.base, r.doc.target.head], r.repo));

/** The worktree has to be at the document's head: the diff, the editor and every anchor assume it. */
export function checkHead(r: Review): void {
  const at = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: r.worktree }).stdout.toString().trim();
  if (at !== r.doc.target.head) throw new Fail(`${r.slug}'s worktree is at ${at.slice(0, 8) || "nothing"}, the document at ${r.doc.target.head.slice(0, 8)}: prview open ${r.slug} rebuilds it`);
}

export function save(r: Review): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(metaOf(r.slug), JSON.stringify(r));
}

/** A stored review, re-read through the document parser; one kept by an older prview (no document yet) is upgraded. */
function revive(j: any): Review | undefined {
  if (typeof j?.slug !== "string" || typeof j?.worktree !== "string") return undefined;
  const raw = j.doc ?? (typeof j.headSha === "string" ? {
    schema: SCHEMA, plan: j.plan,
    target: { repo: basename(String(j.repo)), base: j.baseSha, head: j.headSha, url: j.url, platform: parseRef(j.url)?.platform, title: j.title, body: j.body, label: j.label },
    findings: (j.findings ?? []).map((f: any) => ({ ...f, source: "critic" })),
    human: { comments: j.notes, dismissals: j.dismissed, visited: j.visited, verdict: j.verdict },
  } : undefined);
  const suggested = (Array.isArray(j.suggested) ? j.suggested : []).flatMap((v: any): Suggested[] =>
    typeof v?.by === "string" && v.by && ["approve", "request_changes", "comment"].includes(v.verdict) ? [{ by: v.by.slice(0, 40), verdict: v.verdict, ...(typeof v.reason === "string" && v.reason.trim() ? { reason: v.reason.trim().slice(0, 240) } : {}) }] : []);
  try {
    const asks = reviveAsks(j.asks);
    return { slug: j.slug, repo: j.repo, ref: j.ref ?? j.target, worktree: j.worktree, context: j.context ?? 3, created: j.created, pos: j.pos ?? { item: 0, line: 0 }, ...(filterOf(j.filter) !== "all" ? { filter: filterOf(j.filter) } : {}), ...(sinceOf(j.since) ? { since: sinceOf(j.since) } : {}), ...(j.sinceOnly === true ? { sinceOnly: true as const } : {}), ai: j.ai, doc: parseDocument(raw), ...(suggested.length ? { suggested } : {}), ...(asks ? { asks } : {}), ...(carriedOf(j.carried) ? { carried: carriedOf(j.carried) } : {}) };
  } catch { return undefined; }
}

/** A stored `carried` map: post keys to commit ids, anything else dropped. */
function carriedOf(v: unknown): Carried | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v).filter(([, h]) => typeof h === "string" && /^[0-9a-f]{7,64}$/.test(h)));
  return Object.keys(out).length ? out as Carried : undefined;
}

export function load(slug: string): Review {
  if (!existsSync(metaOf(slug))) throw new Fail(`no review named ${slug} (prview list shows the built ones)`);
  const r = revive(JSON.parse(readFileSync(metaOf(slug), "utf8")));
  if (!r) throw new Fail(`${metaOf(slug)} is not a review prview can read; prview done ${slug} removes it`);
  return r;
}

export function all(): Review[] {
  if (!existsSync(home())) return [];
  return readdirSync(home()).filter((f) => f.endsWith(".json")).flatMap((f) => {
    try { return revive(JSON.parse(readFileSync(join(home(), f), "utf8"))) ?? []; } catch { return []; }
  });
}

export function remove(slug: string): string {
  if (!existsSync(metaOf(slug))) throw new Fail(`no review named ${slug} (prview list shows the built ones)`);
  // An unreadable state file is still removed; only its worktree, which it would have named, is left.
  const r = revive(JSON.parse(readFileSync(metaOf(slug), "utf8")));
  if (r) {
    Bun.spawnSync(["git", "worktree", "remove", "--force", r.worktree], { cwd: r.repo });
    rmSync(r.worktree, { recursive: true, force: true });
    const pr = r.slug.match(/-pr-(\d+)$/);
    if (pr) for (const end of ["head", "base", "merge", "reviewed"]) Bun.spawnSync(["git", "update-ref", "-d", `refs/prview/pr-${pr[1]}/${end}`], { cwd: r.repo });
    Bun.spawnSync(["git", "worktree", "prune"], { cwd: r.repo });
  }
  rmSync(metaOf(slug), { force: true });
  return `removed ${slug}`;
}

const isRepo = (dir: string) => Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir }).exitCode === 0;
const knownRepos = () => [...new Set(all().map((r) => r.repo))].filter((d) => existsSync(d) && isRepo(d));

/** Which clone to build from: --repo, else a known clone of the PR's repo, else here, else the only clone we know. */
export function repoFor(target: string | undefined, explicit: string | undefined): string {
  if (explicit) return explicit;
  const pr = parseRef(target);
  if (pr) {
    const clone = knownRepos().find((d) => remoteFor(d, sourceOf(pr.platform)!, pr) !== undefined);
    if (clone) return clone;
  }
  if (isRepo(process.cwd())) return process.cwd();
  const known = knownRepos();
  if (known.length === 1) return known[0]!;
  throw new Fail(known.length ? `which repo? run it inside one, or pass --repo: ${known.join(", ")}` : "run it inside the repo the first time (or pass --repo DIR); after that it works from anywhere");
}

function worktreeAt(repo: string, slug: string, head: string): string {
  mkdirSync(home(), { recursive: true });
  const worktree = join(home(), slug);
  if (existsSync(join(worktree, ".git"))) git(["checkout", "-q", "--detach", "-f", head], worktree);
  else {
    Bun.spawnSync(["git", "worktree", "prune"], { cwd: repo });
    rmSync(worktree, { recursive: true, force: true });
    git(["worktree", "add", "-q", "--detach", worktree, head], repo);
  }
  return worktree;
}

// ---------------------------------------------------------------- building

export type BuildOpts = { context?: number; /** a model name (--ai) for every role, undefined for the configured roles, null for no models. */ ai?: string | null; fresh?: boolean; samples?: number; say?: Progress; /** REST for a platform that needs it (Azure DevOps); the credentialed real one when absent, a fake in tests. */ http?: Http };

export async function build(repo: string, target: string | undefined, opts: BuildOpts = {}): Promise<Review> {
  const context = opts.context ?? 3, say = opts.say ?? (() => {});
  repo = git(["rev-parse", "--show-toplevel"], repo);
  // Roles and credentials are resolved before anything is fetched or checked out, so a missing key costs nothing.
  const models = opts.ai === null ? null : resolveRoles(loadConfig(), realLookups(), opts.ai);
  const { slug, target: t } = isPR(target) ? await fromPR(repo, target!, { say, http: opts.http }) : fromRange(repo, target);
  if (t.base === t.head) throw new Fail(`${t.label} has no changes`);
  const worktree = worktreeAt(repo, slug, t.head);
  const files = filesOf({ repo, context, doc: blank(t) });
  const prior = existsSync(metaOf(slug)) ? revive(JSON.parse(readFileSync(metaOf(slug), "utf8"))) : undefined;
  // The document is anchored on its head: while the head is the same it is reused whole (whoever
  // produced it); once the head moves only the reader's own comments carry over (re-anchored where their line still is,
  // marked with the head they came from: carryover.ts), with the record of what was submitted before.
  const same = !!prior && prior.doc.target.head === t.head && !opts.fresh;
  const r: Review = { slug, repo, ref: isPR(target) ? t.url ?? target!.replace(/^#/, "") : target, worktree, context, created: new Date().toISOString(), pos: { item: 0, line: 0 }, doc: fit(blank(t), files) };
  if (same) {
    // The conversations are about blocks and findings of this head, so they carry over only while it is the same.
    Object.assign(r, { pos: prior.pos, ...(prior.filter ? { filter: prior.filter } : {}), ai: prior.ai, doc: fit(prior.doc, files), ...(prior.suggested ? { suggested: prior.suggested } : {}), ...(prior.asks ? { asks: prior.asks } : {}), ...(prior.carried ? { carried: prior.carried } : {}) });
    say(`reusing the review document from ${prior.ai?.at.slice(0, 16).replace("T", " ") ?? "before"} (--fresh redoes it)`);
  } else {
    if (prior) {
      const c = carry({ human: prior.doc.human, head: prior.doc.target.head, ...(prior.carried ? { carried: prior.carried } : {}) }, files);
      r.doc.human.comments = c.comments;
      if (c.comments.length) r.carried = c.carried;
      if (prior.doc.submissions?.length) r.doc.submissions = prior.doc.submissions;
    }
    if (models) {
      const samples = Math.max(1, Math.floor(opts.samples ?? 2));
      const { doc, errors, runs } = await guideAndCritic(t, files, worktree, models, samples, say);
      r.doc = merge(r.doc, fit(doc, files));
      r.ai = { models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, v.def.name])) as Record<Role, string>, at: new Date().toISOString(), errors, samples, runs };
      for (const e of errors) say(`warning: ${e}`);
      // By rule, from the findings that survived refute; information only, never the verdict submit starts from.
      r.suggested = [suggestVerdict(r.doc.findings), ...(prior && prior.doc.target.head === t.head ? prior.suggested ?? [] : []).filter((v) => v.by !== IN_HOUSE)];
    }
  }
  // A re-review: the layer is worked out on every open (the head reviewed is the latest submission's), and `v s` stays
  // on while the head does, like the filter.
  const since = rereviewOf(repo, slug, t, files, say);
  if (since) { r.since = since; if (same && prior.sinceOnly && since.files) r.sinceOnly = true; }
  save(r);
  return r;
}

/** A review by name, rebuilt at the PR's current head. A review stored with a bare PR number (before refs were URLs) still reopens: the number means a PR of its clone. */
export async function reopen(slug: string, opts: BuildOpts): Promise<Review> {
  const r = load(slug);
  return build(r.repo, r.ref ?? r.slug.match(/-pr-(\d+)$/)?.[1], opts);
}

// ---------------------------------------------------------------- importing a document

/**
 * Make sure the clone has the document's commits; a PR's head can be fetched (by its platform's source), anything else
 * has to be there. Only the head is fetched: the base is the merge base, an ancestor of the head,
 * so fetching the head brings it too (in any clone that is not shallow).
 */
function haveCommits(repo: string, t: Target): void {
  const has = (c: string) => hasCommit(repo, c);
  const pr = parseRef(t.url);
  if (!has(t.head) && pr) sourceOf(pr.platform)!.fetch(repo, pr, true, t.head);
  for (const c of [t.base, t.head]) if (!has(c)) throw new Fail(`commit ${c.slice(0, 8)} is not in ${repo}: fetch it, then import again`);
}

/**
 * A document from anywhere, folded into the review at its head: merged into the one already there,
 * or opened as a new review in this clone. A review of the same change at another head refuses it.
 * Its human layer is someone else's, so it arrives as suggestions (see `suggestions`) unless `mine`
 * says the reader is restoring their own export, which keeps it as it is.
 */
export function importDocument(text: string, explicitRepo?: string, mine = false): Review {
  const doc = parseDocument(text);
  const take = (r: Review, files: FileDiff[]): Doc => {
    if (mine) return fit(doc, files);
    const s = suggestions(doc, files);
    if (s.suggested && !r.suggested?.some((v) => v.by === s.suggested!.by && v.verdict === s.suggested!.verdict)) r.suggested = [...(r.suggested ?? []), s.suggested];
    return fit(s.doc, files);
  };
  const existing = all().find((r) => r.doc.target.head === doc.target.head);
  if (existing) {
    checkHead(existing);
    existing.doc = merge(existing.doc, take(existing, filesOf(existing)));
    save(existing);
    return existing;
  }
  const repo = git(["rev-parse", "--show-toplevel"], repoFor(doc.target.url, explicitRepo));
  const pr = parseRef(doc.target.url);
  const slug = pr ? prSlug(repo, pr.number) : `${basename(repo)}-${slugPart(doc.target.head)}`;
  if (existsSync(metaOf(slug))) {
    const at = load(slug).doc.target.head;
    throw new Fail(`the document is for ${doc.target.head.slice(0, 8)} but ${slug} is at ${at.slice(0, 8)}: a document only opens against its own head`);
  }
  haveCommits(repo, doc.target);
  const r: Review = {
    slug, repo, ref: pr ? pr.url : `${doc.target.base}..${doc.target.head}`, worktree: worktreeAt(repo, slug, doc.target.head),
    context: 3, created: new Date().toISOString(), pos: { item: 0, line: 0 }, doc,
  };
  r.doc = take(r, filesOf(r));
  save(r);
  return r;
}

/**
 * The document as a producer or another clone would read it: nothing about this machine. `redact` is the copy a
 * producer's `on_submit` hook gets: the reader's private ignore notes are dropped, since they were never meant to leave.
 */
export function exportDocument(r: Review, opts: { redact?: boolean } = {}): string {
  let d = r.doc;
  if (opts.redact && d.human.decisions) {
    d = structuredClone(d);
    for (const v of Object.values(d.human.decisions!)) delete v.reason;
  }
  return JSON.stringify(d, null, 2) + "\n";
}

// ---------------------------------------------------------------- the write-up

export const VERDICT = { approve: "Approve", request_changes: "Request changes", comment: "Comment" } as const;

/** The compiled review as markdown: verdict, summary, comments with file and line, coverage, and the findings not ignored with their action. */
export function writeup(d: Doc, files: FileDiff[], defaults: Defaults = DEFAULTS): string {
  const hunks = hunksOf(files);
  const { target: t, human: h } = d;
  const total = hunks.filter((x) => x.hunk).length, seen = h.visited.length;
  const place = (c: Comment) => {
    if (!c.hunk) return "General";
    const x = hunks.find((y) => y.id === c.hunk);
    return `${visible(x?.file.path ?? c.hunk)}${c.file ? " (whole file)" : c.line !== null ? `:${c.line}` : ""}`;
  };
  const out = [`# ${t.title}`, ``, `${h.verdict ? `**${VERDICT[h.verdict]}** · ` : ""}${t.url ?? t.label} · read ${seen} of ${total} hunks`, ``];
  const general = h.comments.filter((c) => !c.hunk), placed = h.comments.filter((c) => c.hunk);
  for (const c of general) out.push(c.text, ``);
  if (placed.length) out.push(`## Comments`, ``);
  for (const c of placed) out.push(`**${place(c)}**`, c.text, ``);
  const early = earlyTitles([...d.plan.chapters.map((c) => ({ title: c.title, ids: c.hunks })), { title: "Mechanical", ids: d.plan.mechanical.map((m) => m.id) }], h);
  if (early.length) out.push(`Findings seen before reading: ${early.join(", ")}`, ``);
  // An ignored finding (by the reader, or by default after the refute step dropped it) is left out; every other one is
  // listed with its action, marked when it is still the default.
  const kept = d.findings.map((f) => ({ f, a: actionOf(h, f, defaults) })).filter(({ a }) => a.kind !== "ignore");
  if (kept.length) {
    out.push(`## Findings you kept`, ``);
    for (const { f, a } of kept) out.push(`- ${visible(f.hunk.split("@")[0]!)} ${f.file ? "whole file" : `${f.side} ${f.line}`} · ${f.severity} · ${titleOf(f)} · ${actionText(a)}`);
  }
  return out.join("\n") + "\n";
}
