// The GitHub source: a PR named by number or URL is read with `gh pr view`, and its head is fetched from
// the remote that points at its repository (a stamp-server origin still finds the PR refs through it).

import { Fail } from "./document.ts";
import { git, prSlug, remoteFor, run, type PrRef, type PrSource } from "./pr.ts";
import { clean } from "./sanitize.ts";

const has = (repo: string, c: string) => Bun.spawnSync(["git", "cat-file", "-e", `${c}^{commit}`], { cwd: repo, stdin: "ignore" }).exitCode === 0;

const PR_URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/** Fetch the head (and the base branch, when named) into refs/prview/pr-<n>; the namespace it used. */
function fetchHead(repo: string, ref: PrRef, base: string | undefined, known: boolean): string {
  const ns = `refs/prview/pr-${ref.number}`;
  const remote = remoteFor(repo, github, ref), nwo = ref.repoKey;
  if (!remote && known) throw new Fail(`no remote in ${repo} points at github.com/${nwo}, so prview will not fetch the PR from there: add one (git remote add <name> https://github.com/${nwo}.git) or fetch the commits yourself, then import again`);
  git(["fetch", "-q", remote ?? `https://github.com/${nwo}.git`, `+refs/pull/${ref.number}/head:${ns}/head`, ...(base ? [`+refs/heads/${base}:${ns}/base`] : [])], repo);
  return ns;
}

export const github: PrSource = {
  platform: "github",
  parse(url) {
    const m = url.match(PR_URL);
    if (!m) return undefined;
    const [, owner, name, n] = m as unknown as [string, string, string, string];
    return { platform: "github", url: `https://github.com/${owner}/${name}/pull/${Number(n)}`, repoKey: `${owner}/${name}`, number: Number(n), label: `${owner}/${name}#${Number(n)}` };
  },
  // Any host: the key is the path's last two parts, so a mirror (a stamp server) of o/r counts as o/r.
  remoteKey(remoteUrl) {
    return remoteUrl.replace(/\.git$/, "").replace(/:(?=[^/])/, "/").toLowerCase().match(/\/([^/]+\/[^/]+)$/)?.[1];
  },
  resolve(repo, ref) {
    const j = JSON.parse(run(["gh", "pr", "view", typeof ref === "number" ? String(ref) : ref.url, "--json", "number,title,body,url,headRefOid,baseRefName"], repo));
    const pr = github.parse(String(j.url ?? ""));
    if (!pr) throw new Fail(`gh pr view did not name a GitHub pull request URL (got ${JSON.stringify(j.url)})`);
    const ns = fetchHead(repo, pr, j.baseRefName, false);
    const headSha = git(["rev-parse", `${ns}/head`], repo);
    if (headSha !== j.headRefOid) throw new Fail(`fetched head ${headSha.slice(0, 8)} is not the PR head ${String(j.headRefOid).slice(0, 8)}; try again`);
    return {
      slug: prSlug(repo, j.number),
      target: { repo: pr.repoKey, base: git(["merge-base", `${ns}/base`, headSha], repo), head: headSha, url: j.url, platform: "github", title: clean(String(j.title ?? "")), body: clean(String(j.body ?? "")), label: `${pr.repoKey}#${j.number}` },
    };
  },
  // `head`: a commit the PR's head ref may no longer reach (the head a re-review reviewed, before a force-push). GitHub
  // serves a commit of the repository by id, so it is fetched by id into …/reviewed when the head ref did not bring it.
  fetch(repo, ref, known, head) {
    fetchHead(repo, ref, undefined, known);
    if (!head || has(repo, head)) return;
    git(["fetch", "-q", remoteFor(repo, github, ref) ?? `https://github.com/${ref.repoKey}.git`, `+${head}:refs/prview/pr-${ref.number}/reviewed`], repo);
  },
};
