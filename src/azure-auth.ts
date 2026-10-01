// Azure DevOps credentials: an Entra token from `az`, or an org-scoped PAT named in config. Resolved only from what is named.
//
// The secret lives in memory for the length of one command. It is never in an argv (ours or git's), never in an error message
// (everything thrown here goes through redact()), and nothing here writes a file. Runner and Http are injected, so tests need
// neither `az` nor a network.

import { ConfigError, type AzureConfig, type Lookups } from "./config.ts";

/** Same shape as platform.ts's Runner (structurally), kept here so this module does not depend on the platform registry. */
export type AzRunner = (argv: string[], opts: { cwd: string; stdin?: string }) => { exit: number | null; stdout: string; stderr: string };
export type HttpReq = { method: string; url: string; headers?: Record<string, string>; body?: string };
export type HttpRes = { status: number; json: unknown; text: string };
export type Http = (req: HttpReq) => Promise<HttpRes>;
export type Credential = { header: string };

/** The Azure DevOps resource id the Entra token is minted for. */
export const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

export class AzureAuthError extends ConfigError {}

/** The argv for minting a token: nothing secret in it, only the resource and an optional tenant. */
export const azArgv = (tenant?: string): string[] =>
  ["az", "account", "get-access-token", "--resource", AZURE_DEVOPS_RESOURCE, "--query", "accessToken", "-o", "tsv", ...(tenant ? ["--tenant", tenant] : [])];

/** Strip anything that looks like a credential from text bound for an error or a log: auth headers, JWTs, and any known secrets. */
export function redact(text: string, secrets: Iterable<string | undefined> = []): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("[redacted]");
    out = out.split(Buffer.from(`:${s}`).toString("base64")).join("[redacted]");
  }
  return out
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]");
}

const basic = (pat: string) => `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;

function mintFromAz(az: AzureConfig, run: AzRunner): Credential {
  let r: ReturnType<AzRunner>;
  try { r = run(azArgv(az.tenant), { cwd: process.cwd() }); }
  catch { throw new AzureAuthError("azure: the az CLI was not found; install it and run `az login`, or set [azure] auth = \"pat\""); }
  const token = r.stdout.trim();
  if (r.exit === 0 && token && !/\s/.test(token)) return { header: `Bearer ${token}` };
  if (r.exit === 127) throw new AzureAuthError("azure: the az CLI was not found; install it and run `az login`, or set [azure] auth = \"pat\"");
  const err = redact(r.stderr, [token]).trim().split("\n")[0] ?? "";
  if (r.exit === 0) throw new AzureAuthError("azure: az returned no access token; run `az login` and try again");
  if (/AADSTS|tenant/i.test(err)) throw new AzureAuthError(`azure: az could not get a token for ${az.tenant ? `tenant ${az.tenant}` : "the default tenant"} (wrong tenant?); check [azure] tenant or run \`az login --tenant <id>\`${err ? `: ${err.slice(0, 200)}` : ""}`);
  if (/az login|not logged in|no subscription|please run/i.test(err)) throw new AzureAuthError("azure: not logged in to az; run `az login`");
  throw new AzureAuthError(`azure: az failed to mint a token (exit ${r.exit})${err ? `: ${err.slice(0, 200)}` : ""}`);
}

function fromPat(az: AzureConfig, l: Lookups): Credential {
  const fromEnv = az.patEnv ? l.env[az.patEnv]?.trim() : undefined;
  if (fromEnv) return { header: basic(fromEnv) };
  const fromKeychain = az.patKeychain ? l.keychain(az.patKeychain)?.trim() : undefined;
  if (fromKeychain) return { header: basic(fromKeychain) };
  if (az.patEnv && l.env[az.patEnv] !== undefined && !fromEnv) throw new AzureAuthError(`azure: $${az.patEnv} is set but empty`);
  const named = [az.patEnv && `$${az.patEnv}`, az.patKeychain && `Keychain service ${az.patKeychain}`].filter(Boolean).join(" or ");
  throw new AzureAuthError(named ? `azure: no PAT found in ${named}` : "azure: auth = \"pat\" needs pat_env or pat_keychain");
}

/** The Authorization header value, built in memory from what [azure] names. Throws AzureAuthError with a message free of the secret. */
export function azureCredential(cfg: { azure: AzureConfig }, l: Lookups, run: AzRunner): Credential {
  return cfg.azure.auth === "pat" ? fromPat(cfg.azure, l) : mintFromAz(cfg.azure, run);
}

/** The real Http: fetch, with the response read as text and parsed as JSON when it is. Errors are redacted. */
export const fetchHttp: Http = async ({ method, url, headers, body }) => {
  try {
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, json, text };
  } catch (e) {
    throw new AzureAuthError(`azure: request failed: ${redact(e instanceof Error ? e.message : String(e))}`);
  }
};

/**
 * An Http that adds the Authorization header, minting lazily and once per command. A 401 re-mints once and retries
 * (an az token lives about an hour); a PAT cannot change, so a 401 on one is returned as it is.
 */
export function azureHttp(cfg: { azure: AzureConfig }, l: Lookups, run: AzRunner, http: Http = fetchHttp): Http {
  let cred: Credential | undefined;
  return async (req) => {
    const send = async (c: Credential) => {
      const res = await http({ ...req, headers: { ...req.headers, Authorization: c.header } });
      return { ...res, text: redact(res.text, [c.header]) };
    };
    cred ??= azureCredential(cfg, l, run);
    const res = await send(cred);
    if (res.status !== 401 || cfg.azure.auth === "pat") return res;
    cred = azureCredential(cfg, l, run);
    return send(cred);
  };
}

/** The real runner for `az`: a missing binary is exit 127, not a throw. */
export const azSpawn: AzRunner = (argv, { cwd, stdin }) => {
  try {
    const r = Bun.spawnSync(argv, { cwd, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
    return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (e) {
    return { exit: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};
