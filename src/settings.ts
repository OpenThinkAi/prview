// The settings view (`\`): the keys, the default action per severity, the model per role, the editor command and the
// display defaults, edited on one screen and saved to config.toml. Pure apart from `saveSettings`, so every edit, refusal
// and save is tested without a terminal.
//
// Nothing here has rules of its own: a key is checked by `effectiveKeys` (the same check that refuses a bad [keys] at
// startup), a choice only steps through the values `parseConfig` accepts, and the file is re-read, edited and parsed
// with `parseConfig` before it is written. So the view can never save a config prview would refuse to start with.
//
// What a save rewrites: only the lines for the settings changed in the view. A changed line keeps its indentation and
// its trailing comment; a setting with no line yet is added at the end of its table (`[keys]`, `[defaults]`, `[roles]`),
// or among the top-level keys before the first table for `editor`, `wrap` and `blind`, and a table that does not exist
// yet is appended at the end of the file. A key put back to its default has its `[keys]` line removed, and so does a
// role put back to the default model and an emptied editor. Every other line (comments, blank lines, models, tables
// prview does not know) is left exactly as it was.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError, configPath, DEFAULT_MODEL, parseConfig, ROLES, splitKey, stripComment, type Config, type Role } from "./config.ts";
import { DEFAULT_ACTIONS, effectiveKeys, KeysError, rowById, showKey, type Action, type Binding } from "./keys.ts";
import { ACTION_KINDS, DEFAULTS, LABEL, type Defaults } from "./triage.ts";
import type { Severity } from "./guide.ts";

export type Field =
  | { kind: "key"; id: string }
  | { kind: "default"; severity: Severity }
  | { kind: "role"; role: Role }
  | { kind: "editor" }
  | { kind: "wrap" }
  | { kind: "blind" };

export const SECTIONS = { key: "Keys", default: "Default actions by severity", role: "Models per role", editor: "Editor command", wrap: "Display", blind: "Display" } as const;
export const sectionOf = (f: Field): string => SECTIONS[f.kind];

/** What the view edits, with every value spelled out: an unset role or editor is "". */
export type Values = {
  keys: Record<string, { primary: string; secondary: string }>;
  defaults: Defaults;
  roles: Partial<Record<Role, string>>;
  editor: string;
  wrap: boolean;
  blind: boolean;
};

/** A line being captured or typed, or the question on the way out. */
export type Sub = { kind: "capture" } | { kind: "typing"; text: string } | { kind: "confirm" };
export type Slot = "primary" | "secondary";

export type Settings = {
  fields: Field[];
  /** As loaded: what "unsaved changes" and a save compare against. */
  initial: Values;
  values: Values;
  cursor: number;
  /** On a key: which of its bindings the cursor is on. */
  slot: Slot;
  sub: Sub | null;
  /** The configured model names a role can be given (the built-in default is the unset choice). */
  models: string[];
  path: string;
  /** What the last key did, or why it was refused (`error`). */
  message?: { text: string; error?: boolean };
};

export const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];

/** Every action, in table order: the ones that cannot be rebound are listed too, and say so when edited. */
export function fieldsOf(): Field[] {
  return [
    ...DEFAULT_ACTIONS.map((a): Field => ({ kind: "key", id: a.id })),
    ...SEVERITIES.map((severity): Field => ({ kind: "default", severity })),
    ...ROLES.map((role): Field => ({ kind: "role", role })),
    { kind: "editor" }, { kind: "wrap" }, { kind: "blind" },
  ];
}

export function valuesOf(cfg: Config): Values {
  const roles: Partial<Record<Role, string>> = {};
  // Naming the default model is the same as naming none: both show (and save) as the default.
  for (const r of ROLES) if (cfg.roles[r] && cfg.roles[r] !== DEFAULT_MODEL) roles[r] = cfg.roles[r];
  return {
    keys: Object.fromEntries(cfg.keymap.actions.map((a) => [a.id, { primary: a.key, secondary: a.secondary ?? "" }])),
    defaults: { ...cfg.defaults }, roles, editor: cfg.editor ?? "", wrap: cfg.wrap, blind: cfg.blind,
  };
}

export function openSettings(cfg: Config, path: string = configPath()): Settings {
  const v = valuesOf(cfg);
  return { fields: fieldsOf(), initial: v, values: v, cursor: 0, slot: "primary", sub: null, models: Object.keys(cfg.models).filter((m) => m !== DEFAULT_MODEL), path };
}

/** Every value as `path → text`, so two Values compare, and a save names what it touches, one setting at a time. */
export function flat(v: Values): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, b] of Object.entries(v.keys)) { out[`keys.${id}.primary`] = b.primary; out[`keys.${id}.secondary`] = b.secondary; }
  for (const s of SEVERITIES) out[`defaults.${s}`] = v.defaults[s];
  for (const r of ROLES) out[`roles.${r}`] = v.roles[r] ?? "";
  out.editor = v.editor; out.wrap = String(v.wrap); out.blind = String(v.blind);
  return out;
}

/** The settings that differ from `a` in `b`. */
export function changed(a: Values, b: Values): string[] {
  const fa = flat(a), fb = flat(b);
  return Object.keys(fb).filter((k) => fa[k] !== fb[k]);
}
export const dirty = (s: Settings): boolean => changed(s.initial, s.values).length > 0;

// ---------------------------------------------------------------- keys

const defaultRow = (id: string): Action => DEFAULT_ACTIONS.find((a) => a.id === id)!;

/** The [keys] table these values amount to: every rebindable action whose keys differ from its default. */
export function overridesOf(v: Values): Record<string, Binding> {
  const out: Record<string, Binding> = {};
  for (const a of DEFAULT_ACTIONS) {
    const b = v.keys[a.id];
    if (a.fixed || !b) continue;
    if (b.primary !== a.key || b.secondary !== (a.secondary ?? "")) out[a.id] = { primary: b.primary, secondary: b.secondary };
  }
  return out;
}

/** `token` as `id`'s binding in `slot` ("" clears it), or why not, in the words the config check uses. */
export function bindKey(v: Values, id: string, slot: Slot, token: string): { values: Values } | { error: string } {
  const next: Values = { ...v, keys: { ...v.keys, [id]: { ...v.keys[id]!, [slot]: token } } };
  try { effectiveKeys(overridesOf(next)); } catch (e) {
    if (e instanceof KeysError) return { error: e.message.replace(/^\[keys\]: /, "") };
    throw e;
  }
  return { values: next };
}

const shown = (a: Action, token: string) => token ? (a.prefix ? `${a.prefix} ${showKey(token)}` : showKey(token)) : "-";

// ---------------------------------------------------------------- the keys of the view

export type Out = { s: Settings; out?: "leave" | "save" };

const say = (s: Settings, text: string, error = false): Settings => ({ ...s, message: { text, error } });
const field = (s: Settings): Field => s.fields[s.cursor]!;

/** Step a choice to its next value, wrapping round. */
function next<T>(list: readonly T[], at: T): T { return list[(list.indexOf(at) + 1) % list.length]!; }

/** One settings action from the key table (settings.down, settings.edit, ...), with no line or key being captured. */
export function settingsAct(s0: Settings, id: string): Out {
  const s: Settings = { ...s0, message: undefined };
  const f = field(s);
  switch (id) {
    case "settings.down": return { s: { ...s, cursor: Math.min(s.fields.length - 1, s.cursor + 1) } };
    case "settings.up": return { s: { ...s, cursor: Math.max(0, s.cursor - 1) } };
    case "settings.right": return { s: f.kind === "key" ? { ...s, slot: "secondary" } : s };
    case "settings.left": return { s: f.kind === "key" ? { ...s, slot: "primary" } : s };
    case "settings.leave": return dirty(s) ? { s: { ...s, sub: { kind: "confirm" } } } : { s, out: "leave" };
    case "settings.clear": {
      if (f.kind !== "key") return { s: say(s, "Backspace clears a key's secondary binding") };
      const a = defaultRow(f.id);
      if (a.fixed) return { s: say(s, `${f.id} is fixed and cannot be rebound`, true) };
      if (s.slot !== "secondary") return { s: say(s, `Backspace clears a secondary; Enter binds a new primary (→ for the secondary)`) };
      if (!s.values.keys[f.id]!.secondary) return { s: say(s, `${f.id} has no secondary`) };
      const r = bindKey(s.values, f.id, "secondary", "");
      return "error" in r ? { s: say(s, r.error, true) } : { s: say({ ...s, values: r.values }, `${f.id}: secondary cleared`) };
    }
    case "settings.edit": {
      const v = s.values;
      switch (f.kind) {
        case "key": {
          const a = defaultRow(f.id);
          if (a.fixed) return { s: say(s, `${f.id} is fixed (${shown(a, a.key)}) and cannot be rebound`, true) };
          return { s: { ...s, sub: { kind: "capture" } } };
        }
        case "default": return { s: { ...s, values: { ...v, defaults: { ...v.defaults, [f.severity]: next(ACTION_KINDS, v.defaults[f.severity]) } } } };
        case "role": {
          const choices: (string | undefined)[] = [undefined, ...s.models];
          const to = next(choices, v.roles[f.role]);
          const roles = { ...v.roles };
          if (to === undefined) delete roles[f.role]; else roles[f.role] = to;
          return { s: s.models.length ? { ...s, values: { ...v, roles } } : say(s, `only the built-in ${DEFAULT_MODEL} model is configured; add models under [models.<name>] in the config file`) };
        }
        case "editor": return { s: { ...s, sub: { kind: "typing", text: v.editor } } };
        case "wrap": return { s: { ...s, values: { ...v, wrap: !v.wrap } } };
        case "blind": return { s: { ...s, values: { ...v, blind: !v.blind } } };
      }
    }
  }
  return { s };
}

/**
 * A key while a binding is captured, the editor line is typed or the way out is asked: these take the key itself, not
 * the action it is bound to. Capturing: Esc cancels (it cannot be bound), Tab is refused, Backspace clears a secondary,
 * any other key is checked like a [keys] line and refused inline when it clashes.
 */
export function settingsKey(s0: Settings, token: string): Out {
  const s: Settings = { ...s0, message: undefined };
  const sub = s.sub;
  if (!sub) return { s };
  const done = (x: Settings): Settings => ({ ...x, sub: null });
  if (sub.kind === "confirm") {
    if (token === "y") return { s: done(s), out: "save" };
    if (token === "n") return { s: done(s), out: "leave" };
    if (token === "esc") return { s: done(s) };
    return { s: say(s, "y saves, n discards, Esc keeps editing") };
  }
  if (sub.kind === "typing") {
    if (token === "enter") return { s: done({ ...s, values: { ...s.values, editor: sub.text.trim() } }) };
    if (token === "esc") return { s: done(s) };
    const text = token === "backspace" ? sub.text.slice(0, -1) : token === "ctrl-u" ? "" : token === "ctrl-w" ? sub.text.replace(/\S+\s*$/, "") : token === "space" ? sub.text + " " : [...token].length === 1 ? sub.text + token : sub.text;
    return { s: { ...s, sub: { kind: "typing", text } } };
  }
  const f = field(s);
  if (f.kind !== "key") return { s: done(s) };
  const a = defaultRow(f.id);
  if (token === "esc") return { s: say(done(s), "Esc always backs out and cannot be bound; nothing changed") };
  if (token === "tab" || token === "shift-tab") return { s: say(done(s), "Tab moves focus to the content area and cannot be bound", true) };
  if (token === "backspace") {
    if (s.slot === "secondary") return settingsAct(done(s), "settings.clear");
    return { s: say(done(s), "Backspace clears a secondary; a primary needs a key", true) };
  }
  const r = bindKey(s.values, f.id, s.slot, token);
  if ("error" in r) return { s: say(done(s), `refused: ${r.error}`, true) };
  return { s: say(done({ ...s, values: r.values }), `${f.id} ${s.slot}: ${shown(a, token)}`) };
}

// ---------------------------------------------------------------- what a field reads as

/** The label and value a field shows; for a key, its states and the two bindings. */
export function describeField(s: Settings, f: Field): { label: string; value: string; changed: boolean; fixed?: boolean; states?: string; primary?: string; secondary?: string; description: string } {
  const fi = flat(s.initial), fv = flat(s.values);
  const ch = (...paths: string[]) => paths.some((p) => fi[p] !== fv[p]);
  switch (f.kind) {
    case "key": {
      const a = rowById(f.id, { actions: DEFAULT_ACTIONS })!, b = s.values.keys[f.id]!;
      return {
        label: f.id, value: "", changed: ch(`keys.${f.id}.primary`, `keys.${f.id}.secondary`), fixed: a.fixed,
        states: `${a.states.join(", ")}${a.prefix ? ` · ${a.prefix}` : ""}`, primary: b.primary ? shown(a, b.primary) : "(unbound)", secondary: shown(a, b.secondary),
        description: `${a.description}${a.coming ? ` (coming: ${a.coming})` : ""}`,
      };
    }
    case "default": return { label: f.severity, value: LABEL[s.values.defaults[f.severity]], changed: ch(`defaults.${f.severity}`), description: `The action a ${f.severity} finding starts with until you pick one (built-in: ${LABEL[DEFAULTS[f.severity]]}). Enter steps through block, comment and ignore.` };
    case "role": return { label: f.role, value: s.values.roles[f.role] ?? `${DEFAULT_MODEL} (default)`, changed: ch(`roles.${f.role}`), description: `The model the ${f.role} role uses; Enter steps through the models in the config.${f.role === "deep" ? " a ? uses it at once; only a claude-cli model reads the code, others answer in one call." : f.role === "ask" ? " a ? uses it at once when deep is not set." : " It runs when a review is next prepared."}` };
    case "editor": return { label: "editor", value: s.values.editor || "(from $PRVIEW_EDITOR or $EDITOR, else hx)", changed: ch("editor"), description: "The command v e runs, with the file and line added; $PRVIEW_EDITOR still wins when it is set. Empty: $EDITOR, else hx." };
    case "wrap": return { label: "wrap", value: s.values.wrap ? "on" : "off", changed: ch("wrap"), description: "Whether long lines wrap when a review opens (v w still toggles it)." };
    case "blind": return { label: "blind", value: s.values.blind ? "on" : "off", changed: ch("blind"), description: "Blind first pass: a chapter's findings stay hidden until you have read it (--blind / --no-blind still win for a run)." };
  }
}

// ---------------------------------------------------------------- saving

/** One line to set (`value` is TOML) or remove (null) in a table; `table` null is a top-level key. */
export type Edit = { table: string | null; key: string; value: string | null };

const q = (s: string) => JSON.stringify(s);

/** The config lines the changed settings need, one per setting (a key's two bindings are one [keys] line). */
export function editsOf(initial: Values, values: Values): Edit[] {
  const paths = changed(initial, values);
  const out: Edit[] = [];
  const ids = [...new Set(paths.filter((p) => p.startsWith("keys.")).map((p) => p.slice(5).replace(/\.(primary|secondary)$/, "")))];
  for (const id of ids) {
    const a = defaultRow(id), b = values.keys[id]!, sec = a.secondary ?? "";
    const value = b.primary === a.key && b.secondary === sec ? null : b.secondary === sec ? q(b.primary) : `{ primary = ${q(b.primary)}, secondary = ${q(b.secondary)} }`;
    out.push({ table: "keys", key: id, value });
  }
  for (const sev of SEVERITIES) if (paths.includes(`defaults.${sev}`)) out.push({ table: "defaults", key: sev, value: q(values.defaults[sev]) });
  for (const r of ROLES) if (paths.includes(`roles.${r}`)) out.push({ table: "roles", key: r, value: values.roles[r] ? q(values.roles[r]!) : null });
  if (paths.includes("editor")) out.push({ table: null, key: "editor", value: values.editor ? q(values.editor) : null });
  if (paths.includes("wrap")) out.push({ table: null, key: "wrap", value: String(values.wrap) });
  if (paths.includes("blind")) out.push({ table: null, key: "blind", value: String(values.blind) });
  return out;
}

type LineInfo = { kind: "header"; table: string } | { kind: "kv"; table: string | null; key: string } | { kind: "other" };

/** What each line is, and which table a key line is in. An `[[array]]` entry is a table no edit names. */
function scan(lines: string[]): LineInfo[] {
  let table: string | null = null;
  const never = () => new Error("unreadable");
  return lines.map((raw): LineInfo => {
    const line = stripComment(raw).trim();
    if (!line) return { kind: "other" };
    try {
      if (line.startsWith("[[")) { table = `[[${line}]]`; return { kind: "header", table }; }
      if (line.startsWith("[")) { table = splitKey(line.slice(1, -1), never).join("."); return { kind: "header", table }; }
      const eq = line.indexOf("=");
      if (eq < 0) return { kind: "other" };
      const key = splitKey(line.slice(0, eq), never);
      return key.length === 1 ? { kind: "kv", table, key: key[0]! } : { kind: "other" };
    } catch { return { kind: "other" }; }
  });
}

const keyText = (k: string) => /^[A-Za-z0-9_-]+$/.test(k) ? k : q(k);

/** `text` with each edit made in place, as the header of this file describes; every other line is untouched. */
export function editToml(text: string, edits: Edit[]): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const e of edits) {
    const info = scan(lines);
    const at = info.findIndex((l) => l.kind === "kv" && l.table === e.table && l.key === e.key);
    const fresh = `${keyText(e.key)} = ${e.value}`;
    if (at >= 0) {
      if (e.value === null) { lines.splice(at, 1); continue; }
      const raw = lines[at]!, body = stripComment(raw), comment = raw.slice(body.length);
      lines[at] = `${raw.match(/^\s*/)![0]}${fresh}${comment ? (body.match(/\s*$/)![0] || " ") + comment : ""}`;
      continue;
    }
    if (e.value === null) continue;
    const lastKv = (from: number, table: string | null) => { let last = -1; for (let i = from; i < info.length; i++) { const l = info[i]!; if (l.kind === "header" && i > from) break; if (l.kind === "kv" && l.table === table) last = i; } return last; };
    if (e.table === null) {
      const firstHeader = info.findIndex((l) => l.kind === "header");
      const last = lastKv(0, null);
      if (last >= 0) lines.splice(last + 1, 0, fresh);
      else if (firstHeader >= 0) lines.splice(0, 0, fresh, "");
      else lines.push(fresh);
      continue;
    }
    const h = info.findIndex((l) => l.kind === "header" && l.table === e.table);
    if (h >= 0) { const last = lastKv(h, e.table); lines.splice((last >= 0 ? last : h) + 1, 0, fresh); continue; }
    if (lines.length && lines[lines.length - 1]!.trim()) lines.push("");
    lines.push(`[${e.table}]`, fresh);
  }
  return lines.length ? lines.join(nl) + nl : "";
}

/**
 * Write the changed settings into the config file as it is on disk now, and return the config as prview reads it
 * from there. The new text is parsed with the startup check first and must read back as what the view shows; if it
 * does not (the file was changed underneath, say) nothing is written and a ConfigError says why.
 */
export function saveSettings(s: Settings, env: Record<string, string | undefined> = process.env): Config {
  const path = s.path || configPath(env);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const text = editToml(before, editsOf(s.initial, s.values));
  const cfg = parseConfig(text, path);
  const got = flat(valuesOf(cfg)), want = flat(s.values);
  const off = changed(s.initial, s.values).filter((p) => got[p] !== want[p]);
  if (off.length) throw new ConfigError(`${path} would not read back as set (${off.join(", ")}); nothing was written`);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return cfg;
}
