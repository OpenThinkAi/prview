// The Azure DevOps REST calls prview makes about one pull request, shared by the read side (azure.ts) and the post side.
// Every call goes through an injected Http (azure-auth.ts adds the credential), so tests use a fake and never the network.
// Nothing here sees the Authorization header: errors carry the status and Azure's own message, redacted all the same.

import { redact, type Http } from "./azure-auth.ts";
import { Fail } from "./document.ts";
import type { PrRef } from "./pr.ts";

export const API_VERSION = "7.1";

/** The org, project and repo a ref names (its repoKey, "org/project/repo"; Azure allows no "/" in any of them). */
export function repoOf(ref: Pick<PrRef, "repoKey">): { org: string; project: string; repo: string } {
  const [org, project, repo] = ref.repoKey.split("/");
  if (!org || !project || !repo) throw new Fail(`not an Azure DevOps repository: ${ref.repoKey}`);
  return { org, project, repo };
}

/**
 * The REST URL of the PR, or of something under it (`path` like "iterations", "threads", "reviewers/<id>"), with the
 * api-version and any extra query. Names are encoded, so a project or repo with spaces is fine.
 */
export function prApi(ref: Pick<PrRef, "repoKey" | "number">, path = "", query: Record<string, string | number> = {}): string {
  const { org, project, repo } = repoOf(ref);
  // Keys are Azure's own literals ($top, $skip) and go in as written; values are encoded.
  const q = [...Object.entries(query), ["api-version", API_VERSION] as const].map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${ref.number}${path ? `/${path}` : ""}?${q}`;
}

/** Azure's own words about a failed call: its JSON `message` when it sent one, else the start of the text. */
const said = (json: unknown, text: string): string => {
  const m = (json as { message?: unknown } | undefined)?.message;
  return redact(typeof m === "string" && m ? m : text.replace(/\s+/g, " ").trim()).slice(0, 300);
};

/**
 * GET a JSON resource. A non-2xx, or a 2xx that is not JSON (Azure answers an unsigned request with a 203 sign-in page),
 * is a Fail naming what was asked for; 401/403/404 say what usually causes them.
 */
export async function getJson<T>(http: Http, url: string, what: string): Promise<T> {
  const res = await http({ method: "GET", url, headers: { Accept: "application/json" } });
  const why = said(res.json, res.text);
  if (res.status === 401 || res.status === 403) throw new Fail(`azure: not allowed to read ${what} (HTTP ${res.status}); check that you are signed in to that organization ([azure] auth)${why ? `: ${why}` : ""}`);
  if (res.status === 404) throw new Fail(`azure: ${what} was not found, or you cannot see it (HTTP 404)${why ? `: ${why}` : ""}`);
  if (res.status < 200 || res.status > 299) throw new Fail(`azure: reading ${what} failed (HTTP ${res.status})${why ? `: ${why}` : ""}`);
  if (res.json === undefined || res.json === null || typeof res.json !== "object") throw new Fail(`azure: ${what} did not come back as JSON (HTTP ${res.status}); usually that means the request was not signed in ([azure] auth)`);
  return res.json as T;
}

type Commit = { commitId?: string };

/** The fields of a GitPullRequest prview reads. */
export type AzPr = {
  pullRequestId?: number;
  title?: string;
  description?: string;
  status?: "active" | "abandoned" | "completed" | string;
  isDraft?: boolean;
  mergeStatus?: string;
  sourceRefName?: string;
  targetRefName?: string;
  lastMergeSourceCommit?: Commit;
  lastMergeTargetCommit?: Commit;
  lastMergeCommit?: Commit;
  forkSource?: { repository?: { name?: string; remoteUrl?: string } } | null;
  repository?: { id?: string; name?: string; project?: { id?: string; name?: string } };
};

/** One push to the PR. `sourceRefCommit` is the head after it. */
export type AzIteration = { id: number; sourceRefCommit?: Commit; targetRefCommit?: Commit; commonRefCommit?: Commit; reason?: string };

export const getPr = (http: Http, ref: PrRef) => getJson<AzPr>(http, prApi(ref), `pull request ${ref.label}`);

export async function getIterations(http: Http, ref: PrRef): Promise<AzIteration[]> {
  const j = await getJson<{ value?: unknown }>(http, prApi(ref, "iterations"), `the pushes (iterations) of ${ref.label}`);
  return (Array.isArray(j.value) ? j.value : []).filter((i): i is AzIteration => typeof i?.id === "number");
}

/** The latest iteration (the highest id), if any. */
export const lastIteration = (its: AzIteration[]): AzIteration | undefined =>
  its.reduce<AzIteration | undefined>((a, b) => (!a || b.id > a.id ? b : a), undefined);

const SHA = /^[0-9a-f]{40}$/i;
const sha = (c: Commit | undefined) => (typeof c?.commitId === "string" && SHA.test(c.commitId) ? c.commitId.toLowerCase() : undefined);

/** The PR's head: the latest iteration's source commit (authoritative), else the last merge's source commit (it can lag a push). */
export const headOf = (pr: AzPr, its: AzIteration[]): string | undefined => sha(lastIteration(its)?.sourceRefCommit) ?? sha(pr.lastMergeSourceCommit);
