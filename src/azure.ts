// The Azure DevOps source, parsing half (reading the PR itself is AGT-1506): which URLs and remotes are Azure's,
// and the {org, project, repo} they name. Pure. A key is "org/project/repo", percent-decoded; remoteKey lowercases it
// (names match case-insensitively), a parsed PR keeps the case the URL gave.

import { Fail } from "./document.ts";
import type { PrRef, PrSource } from "./pr.ts";

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

const NOT_YET = "Azure DevOps reviews are not supported yet";

export const azure: PrSource = {
  platform: "azure-devops",
  parse(url) {
    const u = webUrl(url.trim());
    if (!u) return undefined;
    const w = fromWeb(u.hostname.toLowerCase(), u.pathname.split("/").filter(Boolean));
    if (!w || w.rest[0]?.toLowerCase() !== "pullrequest" || !/^\d+$/.test(w.rest[1] ?? "") || w.rest.length > 2) return undefined;
    const n = Number(w.rest[1]);
    if (!n) return undefined;
    return { platform: "azure-devops", url: urlOf(w.at, n), repoKey: keyOf(w.at), number: n, label: `${w.at.repo}!${n}` };
  },
  remoteKey(remote) {
    const t = remote.trim();
    const ssh = t.match(SSH);
    if (ssh && !/(^|\.)github\.com$/i.test(ssh[1]!)) {
      const [o, p, r] = [ssh[2]!, ssh[3]!, ssh[4]!].map(dec);
      return o && p && r ? keyOf({ org: o, project: p, repo: r }).toLowerCase() : undefined;
    }
    if (!/^https?:\/\//i.test(t)) return undefined;
    const u = webUrl(t);
    const w = u && fromWeb(u.hostname.toLowerCase(), u.pathname.split("/").filter(Boolean));
    if (!w) return undefined;
    return keyOf({ ...w.at, repo: w.at.repo.replace(/\.git$/i, "") }).toLowerCase();
  },
  resolve() { throw new Fail(NOT_YET); },
  fetch() { throw new Fail(NOT_YET); },
};
