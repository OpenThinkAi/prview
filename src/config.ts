// prview's model configuration: named models, a model per role, credentials resolved per model.
//
// Pure apart from reading the file: parsing and resolution take their inputs (env, keychain lookup) as arguments so tests
// need neither a terminal, a network, nor the real Keychain.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { effectiveKeys, KeysError, type Binding, type Keymap } from "./keys.ts";
import { ACTION_KINDS, DEFAULTS, type Defaults } from "./triage.ts";
import type { DecisionKind } from "./document.ts";
import type { Severity } from "./guide.ts";

/** `deep` is the model `a ?` uses; only a claude-cli one runs tools. Unset, it is the `ask` role's model (the name it had before tools). */
export const ROLES = ["guide", "critic", "refute", "ask", "deep"] as const;
export type Role = (typeof ROLES)[number];
export const KINDS = ["claude-cli", "anthropic", "openai-compatible"] as const;
export type Kind = (typeof KINDS)[number];

/** The step cap and timeout of one `a ?` agent run: `[deep] max_steps` and `timeout` (seconds) in the config. */
export type DeepLimits = { steps: number; timeoutMs: number };
export const DEEP_LIMITS: DeepLimits = { steps: 24, timeoutMs: 180_000 };

export type ModelDef = { name: string; kind: Kind; endpoint?: string; model?: string; keyEnv?: string; keyKeychain?: string };
export type Config = { models: Record<string, ModelDef>; roles: Partial<Record<Role, string>>; /** Blind first pass: findings stay hidden in a chapter until it has been read. */ blind: boolean; /** The default bindings with the [keys] table laid over them, already validated. */ keymap: Keymap;
  /** The action each finding starts with, by severity: DEFAULTS with the [defaults] table laid over it. */ defaults: Defaults;
  /** The editor command `v e` runs (after $PRVIEW_EDITOR, before $EDITOR). */ editor?: string; /** Long lines wrap from the start (`v w` still toggles). */ wrap: boolean;
  /** The `a ?` agent's step cap and timeout: DEEP_LIMITS with the [deep] table laid over it. */ deep: DeepLimits;
  /** Install a newer release in the background when the daily check finds one (update.ts); off, it is only noticed. */ autoUpdate: boolean; path: string | null };
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
 * Tables, `[[array-of-tables]]` and `key = value` lines with strings, integers, booleans, one-line arrays of strings
 * and one-line inline tables of strings (`{ primary = "k", secondary = "j" }`): all the config and the docs recipes need. Anything else is an error with a line number.
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
export function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "#") return s.slice(0, i);
  }
  return s;
}

export function splitKey(s: string, bad: (w: string) => Error): string[] {
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

function parseValue(v: string, bad: (w: string) => Error): string | number | boolean | string[] | Record<string, string> {
  let m: RegExpMatchArray | null;
  if (v.startsWith("{")) {
    if (!v.endsWith("}")) throw bad("inline tables must open and close on one line");
    const out: Record<string, string> = {};
    let rest = v.slice(1, -1).trim();
    while (rest) {
      const x = rest.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:,\s*|$)/);
      if (!x) throw bad("inline tables hold key = \"string\" pairs only");
      if (x[1]! in out) throw bad(`duplicate key ${x[1]}`);
      out[x[1]!] = x[2] !== undefined ? unescape(x[2], bad) : x[3]!;
      rest = rest.slice(x[0].length);
    }
    return out;
  }
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
  if (t.wrap !== undefined && typeof t.wrap !== "boolean") throw new ConfigError("wrap must be true or false");
  if (t.auto_update !== undefined && typeof t.auto_update !== "boolean") throw new ConfigError("auto_update must be true or false");
  const editor = str(t, "editor", "editor");
  // [keys]: "<action>" = "k" sets the primary; { primary = "k", secondary = "j" } either or both; secondary = "" removes it.
  const overrides: Record<string, Binding> = {};
  const shape = (id: string) => new ConfigError(`[keys]: ${id} must be a key ("k") or { primary = "k", secondary = "j" }`);
  for (const [id, v] of Object.entries(table("keys"))) {
    if (typeof v === "string") { overrides[id] = { primary: v }; continue; }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw shape(id);
    const t = v as Record<string, unknown>;
    if (Object.keys(t).some((k) => k !== "primary" && k !== "secondary") || Object.values(t).some((x) => typeof x !== "string")) throw shape(id);
    overrides[id] = t as Binding;
  }
  let keymap: Keymap;
  try { keymap = effectiveKeys(overrides); } catch (e) { throw e instanceof KeysError ? new ConfigError(e.message) : e; }
  // [defaults]: high = "block", medium = "comment", low = "comment"; a severity left out keeps its built-in default.
  const defaults: Defaults = { ...DEFAULTS };
  for (const [sev, v] of Object.entries(table("defaults"))) {
    if (!(sev in DEFAULTS)) throw new ConfigError(`[defaults]: ${sev} is not a severity; use high, medium or low`);
    if (typeof v !== "string" || !(ACTION_KINDS as readonly string[]).includes(v)) throw new ConfigError(`[defaults]: ${sev} must be one of ${ACTION_KINDS.map((k) => `"${k}"`).join(", ")}`);
    defaults[sev as Severity] = v as DecisionKind;
  }
  // [deep]: max_steps = 24, timeout = 180 (seconds): what bounds one `a ?` agent run.
  const deep: DeepLimits = { ...DEEP_LIMITS };
  const dt = table("deep");
  for (const [k, v] of Object.entries(dt)) {
    if (k !== "max_steps" && k !== "timeout") continue;
    if (typeof v !== "number" || v < 1 || v > (k === "max_steps" ? 200 : 3600)) throw new ConfigError(`[deep]: ${k} must be a whole number from 1 to ${k === "max_steps" ? 200 : 3600}`);
    if (k === "max_steps") deep.steps = v; else deep.timeoutMs = v * 1000;
  }
  return { models, roles, blind: t.blind === true, keymap, defaults, editor, wrap: t.wrap === true, deep, autoUpdate: t.auto_update === true, path };
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

/** The model a role names in [roles]: `deep` falls back to `ask`, which it replaced; unset, the default. */
export const roleModel = (cfg: Pick<Config, "roles">, role: Role): string => cfg.roles[role] ?? (role === "deep" ? cfg.roles.ask : undefined) ?? DEFAULT_MODEL;

/** Which model each role uses: `override` (from --ai) for all of them, else [roles], else the default. Fails on any missing credential. */
export function resolveRoles(cfg: Config, l: Lookups, override?: string): Record<Role, Resolved> {
  const cache = new Map<string, Resolved>();
  const get = (n: string) => { let r = cache.get(n); if (!r) cache.set(n, (r = resolveModel(cfg, n, l))); return r; };
  return Object.fromEntries(ROLES.map((role) => [role, get(override ?? roleModel(cfg, role))])) as Record<Role, Resolved>;
}

export const realLookups = (): Lookups => ({ env: process.env, keychain: keychainLookup });
