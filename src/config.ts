// prview's model configuration: named models, a model per role, credentials resolved per model.
//
// Pure apart from reading the file: parsing and resolution take their inputs (env, keychain lookup) as arguments so tests
// need neither a terminal, a network, nor the real Keychain.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { effectiveKeys, KeysError, type Keymap } from "./keys.ts";

export const ROLES = ["guide", "critic", "refute", "ask"] as const;
export type Role = (typeof ROLES)[number];
export const KINDS = ["claude-cli", "anthropic", "openai-compatible"] as const;
export type Kind = (typeof KINDS)[number];

export type ModelDef = { name: string; kind: Kind; endpoint?: string; model?: string; keyEnv?: string; keyKeychain?: string };
export type Config = { models: Record<string, ModelDef>; roles: Partial<Record<Role, string>>; /** Blind first pass: findings stay hidden in a chapter until it has been read. */ blind: boolean; /** The default bindings with the [keys] table laid over them, already validated. */ keymap: Keymap; path: string | null };
/** A model whose credential has been looked up and is ready to call. */
export type Resolved = { def: ModelDef; key?: string };
export type Lookups = { env: Record<string, string | undefined>; keychain: (service: string) => string | undefined };

export class ConfigError extends Error {}

/** Every role falls back to this model, so with no config file at all prview behaves as it always did: claude -p. */
export const DEFAULT_MODEL = "claude";

export const configPath = (env: Record<string, string | undefined> = process.env) =>
  env.PRVIEW_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "prview", "config.toml");

// ---------------------------------------------------------------- TOML subset

type Table = Record<string, unknown>;

/**
 * Tables, `[[array-of-tables]]` and `key = value` lines with strings, integers, booleans and one-line arrays of strings:
 * all the config and the docs recipes need. Anything else is an error with a line number.
 */
export function parseToml(text: string): Table {
  const root: Table = {};
  let cur = root;
  text.split(/\r?\n/).forEach((raw, i) => {
    const bad = (why: string) => new ConfigError(`config line ${i + 1}: ${why}`);
    const line = stripComment(raw).trim();
    if (!line) return;
    if (line.startsWith("[")) {
      const multi = line.startsWith("[[");
      if (!line.endsWith(multi ? "]]" : "]")) throw bad(multi ? "expected a [[table]] header" : "expected a [table] header");
      const parts = splitKey(line.slice(multi ? 2 : 1, multi ? -2 : -1), bad);
      cur = root;
      parts.forEach((part, n) => {
        if (multi && n === parts.length - 1) {
          const list = (cur[part] ??= []);
          if (!Array.isArray(list)) throw bad(`${part} is already a value`);
          list.push((cur = {}));
          return;
        }
        let next = (cur[part] ??= {});
        if (Array.isArray(next)) next = next[next.length - 1] as Table; // a [sub.table] of the latest [[array]] entry
        if (typeof next !== "object" || next === null) throw bad(`${part} is already a value`);
        cur = next as Table;
      });
      return;
    }
    const eq = line.indexOf("=");
    if (eq < 0) throw bad("expected key = value");
    const key = splitKey(line.slice(0, eq), bad);
    if (key.length !== 1) throw bad("dotted keys are not supported; use a [table]");
    if (key[0]! in cur) throw bad(`duplicate key ${key[0]}`);
    cur[key[0]!] = parseValue(line.slice(eq + 1).trim(), bad);
  });
  return root;
}

/** Drop a trailing `# comment`, but not a # inside a quoted string. */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "#") return s.slice(0, i);
  }
  return s;
}

function splitKey(s: string, bad: (w: string) => Error): string[] {
  const out: string[] = [];
  let rest = s.trim();
  while (rest) {
    const m = rest.match(/^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.\s*|$)/);
    if (!m) throw bad(`bad key ${JSON.stringify(s.trim())}`);
    out.push(m[1] !== undefined ? unescape(m[1], bad) : (m[2] ?? m[3])!);
    rest = rest.slice(m[0].length);
  }
  if (!out.length) throw bad("empty key");
  return out;
}

function unescape(s: string, bad: (w: string) => Error): string {
  try { return JSON.parse(`"${s}"`); } catch { throw bad("bad escape in string"); }
}

function parseValue(v: string, bad: (w: string) => Error): string | number | boolean | string[] {
  let m: RegExpMatchArray | null;
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) throw bad("arrays must open and close on one line");
    const items: string[] = [];
    let rest = v.slice(1, -1).trim();
    while (rest) {
      const x = rest.match(/^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:,\s*|$)/);
      if (!x) throw bad("arrays hold quoted strings only");
      items.push(x[1] !== undefined ? unescape(x[1], bad) : x[2]!);
      rest = rest.slice(x[0].length);
    }
    return items;
  }
  if ((m = v.match(/^"((?:[^"\\]|\\.)*)"$/))) return unescape(m[1]!, bad);
  if ((m = v.match(/^'([^']*)'$/))) return m[1]!;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^[+-]?\d+$/.test(v)) return parseInt(v, 10);
  throw bad(`unsupported value ${v || "(empty)"}; strings need quotes`);
}

// ---------------------------------------------------------------- config

const str = (t: Table, k: string, where: string): string | undefined => {
  const v = t[k];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new ConfigError(`${where}: ${k} must be a non-empty string`);
  return v.trim();
};

/** Validate the parsed file into a Config. Unknown keys are ignored (a newer config on an older prview); wrong shapes are errors. */
export function parseConfig(text: string, path: string | null = null): Config {
  const t = parseToml(text);
  const models: Record<string, ModelDef> = { [DEFAULT_MODEL]: { name: DEFAULT_MODEL, kind: "claude-cli" } };
  const table = (k: string): Table => {
    const v = t[k];
    if (v === undefined) return {};
    if (typeof v !== "object" || v === null) throw new ConfigError(`${k} must be a table`);
    return v as Table;
  };
  for (const [name, raw] of Object.entries(table("models"))) {
    const where = `[models.${name}]`;
    if (typeof raw !== "object" || raw === null) throw new ConfigError(`${where} must be a table`);
    const m = raw as Table;
    const kind = str(m, "kind", where);
    if (!kind || !(KINDS as readonly string[]).includes(kind)) throw new ConfigError(`${where}: kind must be one of ${KINDS.join(", ")}`);
    const def: ModelDef = { name, kind: kind as Kind, endpoint: str(m, "endpoint", where), model: str(m, "model", where), keyEnv: str(m, "key_env", where), keyKeychain: str(m, "key_keychain", where) };
    if (def.kind === "openai-compatible" && !def.endpoint) throw new ConfigError(`${where}: openai-compatible needs an endpoint`);
    if (def.kind === "anthropic" && !def.model) throw new ConfigError(`${where}: anthropic needs a model`);
    if (def.kind === "claude-cli" && (def.keyEnv || def.keyKeychain)) throw new ConfigError(`${where}: claude-cli uses your claude login; it takes no key`);
    models[name] = def;
  }
  const roles: Partial<Record<Role, string>> = {};
  const rt = table("roles");
  for (const role of ROLES) {
    const n = str(rt, role, "[roles]");
    if (n === undefined) continue;
    if (!models[n]) throw new ConfigError(`[roles]: ${role} names ${n}, which is not a [models.${n}]`);
    roles[role] = n;
  }
  if (t.blind !== undefined && typeof t.blind !== "boolean") throw new ConfigError("blind must be true or false");
  const overrides: Record<string, string> = {};
  for (const [id, v] of Object.entries(table("keys"))) {
    if (typeof v !== "string") throw new ConfigError(`[keys]: ${id} must be a string: the key, or "" to unbind`);
    overrides[id] = v;
  }
  let keymap: Keymap;
  try { keymap = effectiveKeys(overrides); } catch (e) { throw e instanceof KeysError ? new ConfigError(e.message) : e; }
  return { models, roles, blind: t.blind === true, keymap, path };
}

/** The user's config, or the built-in (claude -p for everything) when there is no file. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const path = configPath(env);
  if (!existsSync(path)) return parseConfig("", null);
  return parseConfig(readFileSync(path, "utf8"), path);
}

// ---------------------------------------------------------------- credentials and roles

export function keychainLookup(service: string): string | undefined {
  const r = Bun.spawnSync(["security", "find-generic-password", "-a", process.env.USER ?? "", "-s", service, "-w"]);
  return r.exitCode === 0 ? r.stdout.toString().trim() || undefined : undefined;
}

/**
 * A model's credential comes only from what that model names: its own env var, then its own Keychain service. There is
 * deliberately no fallback to some ambient key, so a request meant for a local server can never carry a cloud key.
 */
export function resolveCredential(def: ModelDef, l: Lookups): string | undefined {
  const fromEnv = def.keyEnv ? l.env[def.keyEnv]?.trim() : undefined;
  if (fromEnv) return fromEnv;
  const fromKeychain = def.keyKeychain ? l.keychain(def.keyKeychain)?.trim() : undefined;
  if (fromKeychain) return fromKeychain;
  const named = [def.keyEnv && `$${def.keyEnv}`, def.keyKeychain && `Keychain service ${def.keyKeychain}`].filter(Boolean).join(" or ");
  if (named) throw new ConfigError(`model ${def.name}: no credential found in ${named}`);
  if (def.kind === "anthropic") throw new ConfigError(`model ${def.name}: the anthropic kind needs key_env or key_keychain`);
  return undefined; // a local server or claude -p: no key needed
}

export function resolveModel(cfg: Config, name: string, l: Lookups): Resolved {
  const def = cfg.models[name];
  if (!def) throw new ConfigError(`no model named ${name} (have: ${Object.keys(cfg.models).join(", ")})`);
  return { def, key: resolveCredential(def, l) };
}

/** Which model each role uses: `override` (from --ai) for all four, else [roles], else the default. Fails on any missing credential. */
export function resolveRoles(cfg: Config, l: Lookups, override?: string): Record<Role, Resolved> {
  const cache = new Map<string, Resolved>();
  const get = (n: string) => { let r = cache.get(n); if (!r) cache.set(n, (r = resolveModel(cfg, n, l))); return r; };
  return Object.fromEntries(ROLES.map((role) => [role, get(override ?? cfg.roles[role] ?? DEFAULT_MODEL)])) as Record<Role, Resolved>;
}

export const realLookups = (): Lookups => ({ env: process.env, keychain: keychainLookup });
