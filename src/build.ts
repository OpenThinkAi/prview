// Building a review: what to read (a PR or a base..head range), a worktree at its head so an editor
// can open the real files, the model passes (guide, critic, refute), and the state the reader adds
// (notes, what they've read, findings they dismissed), all kept under one slug.
//
// Store: ~/.cache/prview (or $PRVIEW_HOME)
//   <slug>/        worktree at the head: the editor runs here
//   <slug>.json    everything else

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseDiff, type FileDiff } from "./diff.ts";
import {
  applyRefute, classify, CRITIC_SYSTEM, criticPrompt, filePlan, GUIDE_SYSTEM, guidePrompt, hunksOf, numbered,
  parseCritic, parseGuide, REFUTE_SYSTEM, refutePrompt, type Finding, type Plan,
} from "./guide.ts";
import { complete, pool, type Provider } from "./llm.ts";

/** A mistake by the caller: printed without a stack trace. */
export class Fail extends Error {}

export type Note = { hunk: string | null; side: "new" | "old"; line: number | null; text: string; at: string };
export type Ai = { provider: Provider; at: string; errors: string[] };
export type Pos = { item: number; line: number };
export type Review = {
  slug: string; repo: string; target?: string; worktree: string; baseSha: string; headSha: string;
  title: string; body: string; url?: string; label: string; created: string; context: number;
  plan: Plan; findings: Finding[]; ai?: Ai;
  notes: Note[]; visited: string[]; dismissed: number[]; pos: Pos;
};

export const home = () => process.env.PRVIEW_HOME ?? join(homedir(), ".cache", "prview");
const metaOf = (slug: string) => join(home(), `${slug}.json`);

function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdin: "ignore" });
  if (r.exitCode !== 0) throw new Fail(`${cmd.slice(0, 3).join(" ")} failed: ${r.stderr.toString().trim() || r.stdout.toString().trim()}`);
  return r.stdout.toString();
}
const git = (args: string[], cwd: string) => run(["git", ...args], cwd).trim();

// ---------------------------------------------------------------- what to review

function defaultBranch(repo: string): string {
  const r = Bun.spawnSync(["git", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { cwd: repo });
  if (r.exitCode === 0) return r.stdout.toString().trim();
  for (const b of ["main", "master"]) if (Bun.spawnSync(["git", "rev-parse", "-q", "--verify", b], { cwd: repo }).exitCode === 0) return b;
  throw new Fail("no default branch found: pass a range like main..my-branch");
}

/** The remote that points at this GitHub repo, so a stamp-server origin still finds the PR refs. */
function githubRemote(repo: string, nwo: string): string {
  for (const name of git(["remote"], repo).split("\n").filter(Boolean)) {
    const url = git(["remote", "get-url", name], repo);
    if (url.replace(/\.git$/, "").toLowerCase().endsWith(nwo.toLowerCase())) return name;
  }
  return `https://github.com/${nwo}.git`;
}

type Source = { slug: string; baseSha: string; headSha: string; title: string; body: string; url?: string; label: string };

function fromPR(repo: string, ref: string): Source {
  const j = JSON.parse(run(["gh", "pr", "view", ref, "--json", "number,title,body,url,headRefOid,baseRefName"], repo));
  const nwo = (j.url as string).match(/github\.com\/([^/]+\/[^/]+)\/pull\//)![1]!;
  const ns = `refs/prview/pr-${j.number}`;
  git(["fetch", "-q", githubRemote(repo, nwo), `+refs/pull/${j.number}/head:${ns}/head`, `+refs/heads/${j.baseRefName}:${ns}/base`], repo);
  const headSha = git(["rev-parse", `${ns}/head`], repo);
  if (headSha !== j.headRefOid) throw new Fail(`fetched head ${headSha.slice(0, 8)} is not the PR head ${j.headRefOid.slice(0, 8)}; try again`);
  return {
    slug: `${basename(repo)}-pr-${j.number}`, headSha, baseSha: git(["merge-base", `${ns}/base`, headSha], repo),
    title: j.title, body: j.body ?? "", url: j.url, label: `${nwo}#${j.number}`,
  };
}

function fromRange(repo: string, spec: string | undefined): Source {
  let [base, head] = spec?.includes("..") ? spec.split(/\.{2,3}/) as [string, string] : [defaultBranch(repo), spec ?? "HEAD"];
  if (!base) base = defaultBranch(repo);
  if (!head) head = "HEAD";
  const headSha = git(["rev-parse", "--verify", `${head}^{commit}`], repo);
  const baseSha = git(["merge-base", base, headSha], repo);
  const title = git(["log", "-1", "--format=%s", headSha], repo);
  const body = git(["log", "--reverse", "--format=%s%n%n%b", `${baseSha}..${headSha}`], repo);
  const slug = `${basename(repo)}-${(head === "HEAD" ? git(["rev-parse", "--abbrev-ref", "HEAD"], repo) : head).replace(/[^\w.-]+/g, "-")}`;
  return { slug, baseSha, headSha, title, body, label: `${base}..${head}` };
}

export const isPR = (target: string | undefined) => !!target && (/^#?\d+$/.test(target) || /github\.com\/.+\/pull\/\d+/.test(target));

// ---------------------------------------------------------------- the model passes

export type Progress = (s: string) => void;

async function guideAndCritic(src: Source, files: FileDiff[], worktree: string, provider: Provider, say: Progress): Promise<{ plan: Plan; findings: Finding[]; errors: string[] }> {
  const errors: string[] = [];
  const mechanical = classify(files);
  const hunks = hunksOf(files);
  let plan: Plan;
  say(`guide: reading ${hunks.length - mechanical.length} hunks (${mechanical.length} mechanical)…`);
  try { plan = parseGuide(await complete(provider, GUIDE_SYSTEM, guidePrompt(src, hunks, mechanical)), hunks, mechanical); }
  catch (e) { errors.push(`guide: ${(e as Error).message}`); plan = filePlan(files, mechanical); }
  say(`guide: ${plan.chapters.length} chapters${plan.by === "files" ? " (by file: the guide failed)" : ""}`);

  say(`critic: ${plan.chapters.length} chapters in parallel…`);
  const reviews = await pool(plan.chapters.map((c, i) => async () => {
    const fs = parseCritic(await complete(provider, CRITIC_SYSTEM, criticPrompt(src, c, hunks)), c, hunks, i * 100);
    say(`critic: ${i + 1}. ${c.title} → ${fs.length} finding${fs.length === 1 ? "" : "s"}`);
    return fs;
  }));
  let findings: Finding[] = [];
  reviews.forEach((r, i) => { if (r instanceof Error) errors.push(`critic (${plan.chapters[i]!.title}): ${r.message}`); else findings.push(...r); });

  const contested = findings.filter((f) => f.severity !== "nit");
  if (contested.length) say(`refute: checking ${contested.length} finding${contested.length === 1 ? "" : "s"}…`);
  const at = new Map(hunks.map((h) => [h.id, h]));
  const verdicts = await pool(contested.map((f) => async () => {
    const h = at.get(f.hunk)!;
    const file = join(worktree, h.file.path);
    const text = f.side === "new" && existsSync(file) ? readFileSync(file, "utf8") : null;
    return applyRefute(f, await complete(provider, REFUTE_SYSTEM, refutePrompt(f, h.hunk!, text)));
  }));
  const settled = new Map<number, Finding>();
  verdicts.forEach((v, i) => { if (v instanceof Error) errors.push(`refute: ${v.message}`); else settled.set(contested[i]!.id, v); });
  findings = findings.map((f) => settled.get(f.id) ?? f);
  const kept = findings.filter((f) => f.status !== "withdrawn").length;
  say(`findings: ${kept} kept, ${findings.length - kept} withdrawn`);
  return { plan, findings, errors };
}

const ASK_SYSTEM = `You help a human reviewer understand one hunk of a code change. You know the change's summary and what the reviewer is meant to verify in this chapter. Answer their question about the hunk; with no question, explain what the hunk does, why it is probably written this way, and what could go wrong. Ground everything in the code shown; say so when you would need to see more. Plain text, short paragraphs, no markdown headers, under 180 words.`;

export async function ask(r: Review, files: FileDiff[], hunkId: string, question: string): Promise<string> {
  const h = hunksOf(files).find((x) => x.id === hunkId);
  if (!h?.hunk) throw new Fail("that hunk is not in the diff any more");
  const chapter = r.plan.chapters.find((c) => c.hunks.includes(h.id));
  const file = join(r.worktree, h.file.path);
  const around = existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(Math.max(0, h.hunk.newStart - 30), h.hunk.newStart + h.hunk.newCount + 30).join("\n") : "";
  const prompt = `# ${r.title}\n${r.plan.summary}\n\n## Chapter: ${chapter?.title ?? "?"}\n${chapter?.intent ?? ""}\n\n## Hunk ${h.id}\n${numbered(h.hunk)}\n\n## The file after the change, around it\n${around}\n\n## Question\n${question.trim() || "(none: explain the hunk)"}`;
  return (await complete(r.ai?.provider ?? "claude", ASK_SYSTEM, prompt)).trim();
}

// ---------------------------------------------------------------- the store

export const filesOf = (r: Pick<Review, "repo" | "baseSha" | "headSha" | "context">) =>
  parseDiff(run(["git", "diff", "-M", "--no-color", "--no-ext-diff", `-U${r.context}`, r.baseSha, r.headSha], r.repo));

export function save(r: Review): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(metaOf(r.slug), JSON.stringify(r));
}

export function load(slug: string): Review {
  if (!existsSync(metaOf(slug))) throw new Fail(`no review named ${slug} (prview list shows the built ones)`);
  return JSON.parse(readFileSync(metaOf(slug), "utf8"));
}

export function all(): Review[] {
  if (!existsSync(home())) return [];
  return readdirSync(home()).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(home(), f), "utf8")));
}

export function remove(r: Review): string {
  Bun.spawnSync(["git", "worktree", "remove", "--force", r.worktree], { cwd: r.repo });
  rmSync(r.worktree, { recursive: true, force: true });
  const pr = r.slug.match(/-pr-(\d+)$/);
  if (pr) for (const end of ["head", "base"]) Bun.spawnSync(["git", "update-ref", "-d", `refs/prview/pr-${pr[1]}/${end}`], { cwd: r.repo });
  Bun.spawnSync(["git", "worktree", "prune"], { cwd: r.repo });
  rmSync(metaOf(r.slug), { force: true });
  return `removed ${r.slug}`;
}

const isRepo = (dir: string) => Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir }).exitCode === 0;
const knownRepos = () => [...new Set(all().map((r) => r.repo))].filter((d) => existsSync(d) && isRepo(d));

/** Which clone to build from: --repo, else a known clone of the PR's repo, else here, else the only clone we know. */
export function repoFor(target: string | undefined, explicit: string | undefined): string {
  if (explicit) return explicit;
  const nwo = target?.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1];
  if (nwo) {
    const clone = knownRepos().find((d) => git(["remote", "-v"], d).toLowerCase().includes(nwo.toLowerCase()));
    if (clone) return clone;
  }
  if (isRepo(process.cwd())) return process.cwd();
  const known = knownRepos();
  if (known.length === 1) return known[0]!;
  throw new Fail(known.length ? `which repo? run it inside one, or pass --repo: ${known.join(", ")}` : "run it inside the repo the first time (or pass --repo DIR); after that it works from anywhere");
}

// ---------------------------------------------------------------- building

export type BuildOpts = { context?: number; ai?: Provider | null; fresh?: boolean; say?: Progress };

export async function build(repo: string, target: string | undefined, opts: BuildOpts = {}): Promise<Review> {
  const context = opts.context ?? 3, say = opts.say ?? (() => {});
  repo = git(["rev-parse", "--show-toplevel"], repo);
  const src = isPR(target) ? fromPR(repo, target!.replace(/^#/, "")) : fromRange(repo, target);
  if (src.baseSha === src.headSha) throw new Fail(`${src.label} has no changes`);
  mkdirSync(home(), { recursive: true });
  const worktree = join(home(), src.slug);
  if (existsSync(join(worktree, ".git"))) git(["checkout", "-q", "--detach", "-f", src.headSha], worktree);
  else {
    Bun.spawnSync(["git", "worktree", "prune"], { cwd: repo });
    rmSync(worktree, { recursive: true, force: true });
    git(["worktree", "add", "-q", "--detach", worktree, src.headSha], repo);
  }
  const files = filesOf({ repo, context, ...src });
  const prior = existsSync(metaOf(src.slug)) ? load(src.slug) : undefined;
  // What the reader added always carries over; the model's work only while the head it read is still the head.
  const same = !!prior && prior.headSha === src.headSha && !opts.fresh;
  let r: Review = {
    ...src, repo, target: isPR(target) ? target!.replace(/^#/, "") : target, worktree, created: new Date().toISOString(), context,
    plan: filePlan(files, classify(files)), findings: [],
    notes: prior?.notes ?? [], visited: same ? prior.visited : [], dismissed: same ? prior.dismissed : [], pos: same ? prior.pos : { item: 0, line: 0 },
  };
  if (same) { r.plan = prior.plan; r.findings = prior.findings; r.ai = prior.ai; say(`reusing the guide and findings from ${prior.ai?.at.slice(0, 16).replace("T", " ") ?? "before"} (--fresh redoes them)`); }
  else if (opts.ai) {
    const { plan, findings, errors } = await guideAndCritic(src, files, worktree, opts.ai, say);
    r = { ...r, plan, findings, ai: { provider: opts.ai, at: new Date().toISOString(), errors } };
    for (const e of errors) say(`warning: ${e}`);
  }
  save(r);
  return r;
}

/** A review by name, rebuilt at the PR's current head. */
export async function reopen(slug: string, opts: BuildOpts): Promise<Review> {
  const r = load(slug);
  return build(r.repo, r.target ?? r.slug.match(/-pr-(\d+)$/)?.[1], opts);
}

// ---------------------------------------------------------------- the write-up

/** Notes and coverage as markdown: what you would paste into a review. */
export function writeup(r: Review, files: FileDiff[]): string {
  const hunks = hunksOf(files);
  const total = hunks.filter((h) => h.hunk).length, seen = r.visited.length;
  const place = (n: Note) => {
    if (!n.hunk) return "General";
    const h = hunks.find((x) => x.id === n.hunk);
    return `${h?.file.path ?? n.hunk}${n.line !== null ? `:${n.line}` : ""}`;
  };
  const out = [`# ${r.title}`, ``, `${r.url ?? r.label} · read ${seen} of ${total} hunks`, ``];
  const general = r.notes.filter((n) => !n.hunk), placed = r.notes.filter((n) => n.hunk);
  for (const n of general) out.push(n.text, ``);
  for (const n of placed) out.push(`**${place(n)}**`, n.text, ``);
  const kept = r.findings.filter((f) => f.status !== "withdrawn" && !r.dismissed.includes(f.id));
  if (kept.length) {
    out.push(`## Findings you kept`, ``);
    for (const f of kept) out.push(`- ${f.hunk.split("@")[0]} ${f.side} ${f.line} · ${f.severity} · ${f.claim}`);
  }
  return out.join("\n") + "\n";
}
