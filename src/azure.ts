// The Azure DevOps source: which URLs and remotes are Azure's and the {org, project, repo} they name (pure), and reading
// a PR: its words and head from the REST API (azure-api.ts, through the credentialed Http of azure-auth.ts), its commits
// fetched with git from the remote already configured for its repo, with the user's own git credentials. A key is
// "org/project/repo", percent-decoded; remoteKey lowercases it (names match case-insensitively), a parsed PR keeps the
// case the URL gave.
//
// Azure has no refs/pull/<n>/head. The head is fetched by its commit id; if the server refuses that, through the trial
// merge refs/pull/<n>/merge (whose second parent is the head; it exists only while the PR merges cleanly); then through
// the source branch. Whichever worked, the result must be the head the API named, or the PR moved and it fails.

import { azSpawn, azureHttp, type Http } from "./azure-auth.ts";
import { getIterations, getPr, headOf } from "./azure-api.ts";
import { loadConfig, realLookups } from "./config.ts";
import { Fail } from "./document.ts";
import { git, prSlug, remoteFor, remotesOf, type PrRef, type PrSource } from "./pr.ts";
import { clean, visible } from "./sanitize.ts";

type Repo = { org: string; project: string; repo: string };

const dec = (s: string): string | undefined => { try { return decodeURIComponent(s); } catch { return undefined; } };
const GIT = (s: string | undefined) => s?.toLowerCase() === "_git";

/** The web forms' host and path segments → the repo they name; the project is the repo's name when the URL omits it. */
function fromWeb(host: string, segs: string[]): { at: Repo; rest: string[] } | undefined {
  let org: string | undefined, path = segs;
  if (host === "dev.azure.com") { org = path[0]; path = path.slice(1); }
  else { org = host.match(/^([^.]+)\.visualstudio\.com$/)?.[1]; if (path[0]?.toLowerCase() === "defaultcollection") path = path.slice(1); }
  if (!org) return undefined;
  const g = path.findIndex(GIT);
  if (g < 0 || g > 1 || !path[g + 1]) return undefined;
  const [project, repo] = [g === 1 ? path[0] : path[g + 1], path[g + 1]].map((s) => dec(s!));
  const o = dec(org);
  if (!o || !project || !repo) return undefined;
  return { at: { org: o, project, repo }, rest: path.slice(g + 2) };
}

const keyOf = (r: Repo) => `${r.org}/${r.project}/${r.repo}`;
const urlOf = (r: Repo, n: number) => `https://dev.azure.com/${[r.org, r.project].map(encodeURIComponent).join("/")}/_git/${encodeURIComponent(r.repo)}/pullrequest/${n}`;

function webUrl(s: string): URL | undefined {
  try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return undefined; }
}

// ssh://[user@]host[:port]/v3/o/p/r, or scp-style user@host:v3/o/p/r. The host may be an ssh-config alias, so the
// v3/<org>/<project>/<repo> path shape is what counts, with GitHub's hosts excluded.
const SSH = /^(?:ssh:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

/** A remote URL → the repo it names, in the case it gave (an SSH path or a web URL, with .git dropped). */
function remoteRepo(remote: string): Repo | undefined {
  const t = remote.trim();
  const ssh = t.match(SSH);
  if (ssh && !/(^|\.)github\.com$/i.test(ssh[1]!)) {
    const [o, p, r] = [ssh[2]!, ssh[3]!, ssh[4]!].map(dec);
    return o && p && r ? { org: o, project: p, repo: r } : undefined;
  }
  if (!/^https?:\/\//i.test(t)) return undefined;
  const u = webUrl(t);
  const w = u && fromWeb(u.hostname.toLowerCase(), u.pathname.split("/").filter(Boolean));
  return w ? { ...w.at, repo: w.at.repo.replace(/\.git$/i, "") } : undefined;
}

const refOf = (r: Repo, n: number): PrRef => ({ platform: "azure-devops", url: urlOf(r, n), repoKey: keyOf(r), number: n, label: `${r.repo}!${n}` });

/** A bare number typed in a clone: a PR of the repo its origin (else its only remote) names. */
function bareRef(repo: string, n: number): PrRef {
  const remotes = remotesOf(repo);
  const home = remotes.find((r) => r.name === "origin") ?? (remotes.length === 1 ? remotes[0] : undefined);
  const at = home && remoteRepo(home.url);
  if (!at) throw new Fail(`${repo}'s origin is not an Azure DevOps repository, so PR ${n} means nothing here: pass the PR's URL`);
  return refOf(at, n);
}

/** The configured remote for the ref's repo, or an actionable Fail naming the one prview expected. Never a URL of its own choosing. */
function remoteOrFail(repo: string, ref: PrRef): string {
  const remote = remoteFor(repo, azure, ref);
  if (remote) return remote;
  const want = ref.url.replace(/\/pullrequest\/\d+$/, "");
  throw new Fail(`no remote in ${repo} points at ${want}, so prview will not fetch ${ref.label} from anywhere: add one (git remote add azure ${want}) or run it in a clone of that repo`);
}

const ok = (args: string[], repo: string) => Bun.spawnSync(["git", ...args], { cwd: repo, stdin: "ignore", env: process.env });
const gitOk = (args: string[], repo: string) => ok(args, repo).exitCode === 0;

/**
 * Fetch the PR's head into refs/prview/pr-<n>/head (and the target branch into …/base when named): by commit id, else
 * the merge ref's second parent, else the source branch when named. The head that landed must be `head`.
 */
function fetchHead(repo: string, ref: PrRef, head: string, opts: { target?: string; source?: string }): string {
  const remote = remoteOrFail(repo, ref);
  const ns = `refs/prview/pr-${ref.number}`;
  const base = opts.target ? [`+${opts.target}:${ns}/base`] : [];
  const tried: string[] = [];
  const attempt = (what: string, specs: string[]) => {
    const r = ok(["fetch", "-q", "--no-tags", remote, ...specs, ...base], repo);
    if (r.exitCode !== 0) tried.push(`${what}: ${visible(clean(r.stderr.toString().trim().split("\n").at(-1) ?? ""))}`);
    return r.exitCode === 0;
  };
  const landed =
    attempt(`commit ${head.slice(0, 8)}`, [`+${head}:${ns}/head`]) ||
    (attempt(`refs/pull/${ref.number}/merge`, [`+refs/pull/${ref.number}/merge:${ns}/merge`]) && gitOk(["update-ref", `${ns}/head`, `${ns}/merge^2`], repo)) ||
    (!!opts.source && attempt(opts.source, [`+${opts.source}:${ns}/head`]));
  if (!landed) throw new Fail(`could not fetch ${ref.label}'s head from ${remote}: ${tried.join("; ") || "nothing to try"}`);
  const got = git(["rev-parse", `${ns}/head`], repo);
  if (got !== head) throw new Fail(`fetched head ${got.slice(0, 8)} is not the PR head ${head.slice(0, 8)}: the PR moved; try again`);
  return ns;
}

/** The credentialed Http for a real run: [azure] from the config, the token or PAT resolved on first use. */
const realHttp = (): Http => azureHttp(loadConfig(), realLookups(), azSpawn);

export const azure: PrSource = {
  platform: "azure-devops",
  parse(url) {
    const u = webUrl(url.trim());
    if (!u) return undefined;
    const w = fromWeb(u.hostname.toLowerCase(), u.pathname.split("/").filter(Boolean));
    if (!w || w.rest[0]?.toLowerCase() !== "pullrequest" || !/^\d+$/.test(w.rest[1] ?? "") || w.rest.length > 2) return undefined;
    const n = Number(w.rest[1]);
    if (!n) return undefined;
    return refOf(w.at, n);
  },
  remoteKey(remote) {
    const r = remoteRepo(remote);
    return r ? keyOf(r).toLowerCase() : undefined;
  },
  async resolve(repo, r, ctx = {}) {
    const ref = typeof r === "number" ? bareRef(repo, r) : r;
    remoteOrFail(repo, ref); // before any network: a clone that cannot fetch it costs nothing
    const http = ctx.http ?? realHttp();
    const pr = await getPr(http, ref);
    if (pr.forkSource) throw new Fail(`${ref.label} comes from a fork${pr.forkSource.repository?.name ? ` (${visible(clean(pr.forkSource.repository.name))})` : ""}, which prview does not read yet: fetch the fork's commits yourself, then prview import a document for it`);
    const head = headOf(pr, await getIterations(http, ref));
    if (!head) throw new Fail(`azure: ${ref.label} names no head commit`);
    if (!pr.targetRefName) throw new Fail(`azure: ${ref.label} names no target branch`);
    const say = ctx.say ?? (() => {});
    if (pr.status === "abandoned" || pr.status === "completed") say(`warning: ${ref.label} is ${pr.status}`);
    if (pr.isDraft) say(`warning: ${ref.label} is a draft`);
    const ns = fetchHead(repo, ref, head, { target: pr.targetRefName, source: pr.sourceRefName });
    return {
      slug: prSlug(repo, ref.number),
      target: { repo: ref.repoKey, base: git(["merge-base", `${ns}/base`, head], repo), head, url: ref.url, platform: "azure-devops", title: clean(String(pr.title ?? "")), body: clean(String(pr.description ?? "")), label: ref.label },
    };
  },
  // An import: only a configured remote (Azure has no public URL to fall back on), by commit id or the merge ref.
  // Without the API there is no branch name; a head neither reaches is reported by the caller as a missing commit.
  fetch(repo, ref, _known, head) {
    if (!head) { remoteOrFail(repo, ref); return; }
    try { fetchHead(repo, ref, head, {}); } catch (e) { if (!(e instanceof Fail) || /no remote in/.test(e.message)) throw e; }
  },
};
