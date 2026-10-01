// The environment a `claude` child process gets, and where a claude-cli model's credential comes from.
//
// A claude-cli model with no key runs `claude` on process.env as it is: your claude login (or whatever your shell sets).
// With key_env or key_keychain, every `claude` prview spawns for it (the one-shot roles, the `a ?` agent, the
// `prview models` probe) gets this env instead, so that token is what gets billed, not the logged-in session.
//
// Credential precedence, from the Claude Code docs (checked 2026-10-01):
//   https://code.claude.com/docs/en/authentication#authentication-precedence
//   https://code.claude.com/docs/en/env-vars
//   https://code.claude.com/docs/en/headless#start-faster-with-bare-mode
// claude picks the first of: (1) a cloud provider when CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY is set (Claude
// Platform on AWS is CLAUDE_CODE_USE_ANTHROPIC_AWS); (2) ANTHROPIC_AUTH_TOKEN; (3) ANTHROPIC_API_KEY, which "in
// non-interactive mode (-p) ... is always used when present" (no approval prompt, so no flag is needed); (4) the
// apiKeyHelper setting; (5) CLAUDE_CODE_OAUTH_TOKEN (a `claude setup-token` token, "takes precedence over
// keychain-stored credentials"); (6) Anthropic profiles / federation (ANTHROPIC_PROFILE, ANTHROPIC_FEDERATION_RULE_ID +
// ANTHROPIC_ORGANIZATION_ID); (7) the /login subscription. ANTHROPIC_BASE_URL redirects every request.
//
// So the key goes in as ANTHROPIC_API_KEY (an API key, sk-ant-api…) or CLAUDE_CODE_OAUTH_TOKEN (an OAuth token,
// sk-ant-oat…), and everything that outranks it, redirects it or picks another provider is removed from the child's env.
// Not --bare: bare mode never reads CLAUDE_CODE_OAUTH_TOKEN, and it would change what else the call loads.
//
// What env cannot reach, because it lives in settings files, not the environment: an `apiKeyHelper` setting outranks an
// OAuth token (not an API key); a settings file's `env` block can set any of the variables below again; a signed-in
// Claude apps gateway session, or managed settings that force a login method or org, override or refuse an env
// credential. Those are the user's own claude configuration; `prview models` names the credential prview passes.

import type { ModelDef, Resolved } from "./config.ts";

export type Env = Record<string, string | undefined>;

/** The variable the key goes in: an OAuth token (`sk-ant-oat…`) is CLAUDE_CODE_OAUTH_TOKEN; anything else is an API key. */
export const credentialVar = (key: string): "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN" =>
  key.startsWith("sk-ant-oat") ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";

/** Credentials, providers and routing a configured key must not lose to (see the precedence above). */
const STRIP = new Set([
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES",
  "AWS_BEARER_TOKEN_BEDROCK",
]);
/** CLAUDE_CODE_USE_* picks a provider; ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY,AWS}_* configures one; CLAUDE_CODE_SKIP_*_AUTH turns its auth off. */
const STRIP_PATTERNS = [/^CLAUDE_CODE_USE_/, /^ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY|AWS)_/, /^CLAUDE_CODE_SKIP_.*AUTH$/];

export const stripped = (name: string): boolean => STRIP.has(name) || STRIP_PATTERNS.some((p) => p.test(name));

/**
 * The env for a `claude` child run for `m`. No key (or not a claude-cli model): `base` itself, unchanged. A key: a copy
 * of `base` with every stripped variable gone and the key in exactly one credential variable.
 */
export function claudeEnv(m: Resolved, base: Env = process.env): Env {
  if (m.def.kind !== "claude-cli" || !m.key) return base;
  const out: Env = {};
  for (const [k, v] of Object.entries(base)) if (!stripped(k)) out[k] = v;
  out[credentialVar(m.key)] = m.key;
  return out;
}

/** Where a model's credential comes from, by name only (never the value): for `prview models`. */
export function credentialSource(def: ModelDef): string {
  const from = [def.keyEnv && `env ${def.keyEnv}`, def.keyKeychain && `keychain ${def.keyKeychain}`].filter(Boolean);
  if (from.length) return `key from ${from.join(", else ")}`;
  return def.kind === "claude-cli" ? "your claude login" : def.kind === "anthropic" ? "no key" : "none";
}

/** The same as the config lines that set it (`key_keychain = "NAME"`): for the settings view. */
export function credentialSetting(def: ModelDef): string {
  const from = [def.keyEnv && `key_env = ${JSON.stringify(def.keyEnv)}`, def.keyKeychain && `key_keychain = ${JSON.stringify(def.keyKeychain)}`].filter(Boolean);
  if (from.length) return from.join(", ");
  return def.kind === "claude-cli" ? "your claude login" : "no key";
}
