// Key map v2, without a screen: the action tables, the user's [keys], the chord parser and the terminal's key
// sequences. The drift test at the end holds the key panel and the handler to one table, per state and per prefix.

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSequence, pendingText, step, tokenOf, type Pending } from "../src/chord.ts";
import { ConfigError, parseConfig } from "../src/config.ts";
import {
  ALL_ACTIONS, DEFAULT_ACTIONS, DEFAULT_KEYMAP, describeKeymap, effectiveKeys, installKeymap, keyOf, keysOf, NAMED_KEYS, normKey,
  PREFIXES, prefixesOf, prefixRows, RENAMED, rowById, rowsOf, STEP_ACTIONS, type KeyState, type Keymap, type Prefix,
} from "../src/keys.ts";
import { entriesOf, panelTitle } from "../src/panel.ts";

afterEach(() => installKeymap(DEFAULT_KEYMAP));

const CODE: KeyState = { state: "code" }, TOC: KeyState = { state: "toc" }, FINDING: KeyState = { state: "finding" }, CONTENT: KeyState = { state: "content" };
/** Every state a key can be pressed in, with each variant that changes what is listed. */
const ALL_STATES: KeyState[] = [
  TOC, CODE, FINDING, CONTENT, { state: "content", results: true }, { state: "settings" },
  { state: "prompt", kind: "ask" }, { state: "prompt", kind: "comment" }, { state: "prompt", kind: "comment", decide: true }, { state: "prompt", kind: "reason" }, { state: "prompt", kind: "docs" },
  { state: "submit", step: "verdict" },
  { state: "submit", step: "preview", dryRun: false, hook: null, coverage: null }, { state: "submit", step: "preview", dryRun: true, hook: false, coverage: true },
];
const name = (s: KeyState) => JSON.stringify(s);
/** Keys a terminal can send: every printable ASCII character and every named key. */
const UNIVERSE = [...Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)), ...NAMED_KEYS, "ctrl-d", "ctrl-u", "ctrl-w", "ctrl-x"];
const press = (ks: KeyState, keys: string[], km: Keymap = DEFAULT_KEYMAP) => {
  let pending: Pending | null = null;
  let out: ReturnType<typeof step>["out"] = { kind: "none" };
  for (const k of keys) ({ pending, out } = step(ks, pending, k, km));
  return { pending, out };
};

// ---------------------------------------------------------------- the tables

test("actions: unique ids, <state or group>.<action>, each with a key, a label, a one-line description, and the states it acts in", () => {
  const ids = DEFAULT_ACTIONS.map((a) => a.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const a of DEFAULT_ACTIONS) {
    expect(a.id, a.id).toMatch(/^[a-z]+\.[a-z_]+$/);
    const group = a.id.split(".")[0]!;
    if (a.prefix) expect(group, a.id).toBe(({ a: "ai", f: "filter", v: "view", g: "go" } as const)[a.prefix]);
    else if (a.states.length === 1) expect(group, a.id).toBe(a.states[0]!);
    else expect(group, a.id).toBe("review"); // shared by the table of contents and the code
    expect(a.key, a.id).not.toBe("");
    expect(a.label.trim(), a.id).not.toBe("");
    expect(a.description.trim(), a.id).not.toBe("");
    expect(a.description, a.id).not.toContain("\n");
    expect(a.states.length, a.id).toBeGreaterThan(0);
  }
});

test("the approved map: primary and secondary keys as specified", () => {
  const k = (id: string) => { const a = rowById(id)!; return [a.prefix ?? "", a.key, a.secondary ?? ""].join(" ").trim(); };
  expect(k("code.down")).toBe("down j");
  expect(k("code.up")).toBe("up k");
  expect(k("code.next_chapter")).toBe("shift-down J");
  expect(k("code.prev_chapter")).toBe("shift-up K");
  expect(k("code.open_finding")).toBe("right l");
  expect(k("code.to_toc")).toBe("left h");
  expect(k("toc.expand")).toBe("right l");
  expect(k("toc.collapse")).toBe("left h");
  expect(k("code.focus_content")).toBe("tab");
  expect(k("code.new_finding")).toBe("enter");
  for (const [id, key] of [["review.submit", "s"], ["review.copy", "y"], ["review.search_docs", "?"], ["review.settings", "\\"], ["review.quit", "q"]]) expect(k(id!)).toBe(key!);
  expect(["ai.info", "ai.ask", "ai.draft"].map(k)).toEqual(["a i", "a ?", "a s"]);
  expect(["filter.high", "filter.medium", "filter.all"].map(k)).toEqual(["f h", "f m", "f a"]);
  expect(["view.zen", "view.fullscreen", "view.editor", "view.wrap"].map(k)).toEqual(["v z", "v c", "v e", "v w"]);
  expect(["go.next_finding", "go.prev_finding", "go.next_severity", "go.prev_severity", "go.top", "go.end", "go.chapter"].map(k)).toEqual(["g f", "g F", "g h", "g H", "g g", "g e", "g c"]);
  expect(["finding.close", "finding.back", "finding.block", "finding.comment", "finding.ignore", "finding.copy", "ai.accept", "ai.discard"].map(k)).toEqual(["x", "left h", "b", "c", "i", "y", "a a", "a x"]);
  // g and v work inside a finding too; f does not.
  expect(prefixesOf(FINDING)).toEqual(["a", "v", "g"]);
  expect(prefixesOf(CODE)).toEqual(["a", "f", "v", "g"]);
  // Removed from the old map: none of these keys act in the code any more.
  for (const gone of ["u", "d", "n", "N", "W", "F", "H", "L", "w", "/", "S", "]", "["]) expect(rowsOf(CODE).some((r) => keysOf(r).includes(gone)), gone).toBe(false);
});

test("keyOf and the display: arrows as arrows, a prefixed action as its chord, unbound says so", () => {
  expect(keyOf("code.down")).toBe("↓");
  expect(keyOf("code.next_chapter")).toBe("⇧↓");
  expect(keyOf("go.next_finding")).toBe("g f");
  expect(keyOf("go.chapter")).toBe("g c <n> Enter");
  expect(keyOf("go.line")).toBe("g <n> Enter");
  expect(keyOf("code.new_finding")).toBe("Enter");
  expect(keyOf("nope")).toBe("(unbound)");
  installKeymap(effectiveKeys({ "view.wrap": { primary: "" } }));
  expect(keyOf("view.wrap")).toBe("(unbound)");
  installKeymap(effectiveKeys({ "code.down": { primary: "" } }));
  expect(keyOf("code.down")).toBe("j"); // the secondary still works, so it is what a hint names
});

// ---------------------------------------------------------------- [keys] in the config

test("config: a string sets the primary; a table sets either or both; secondary = \"\" removes it", () => {
  expect(parseConfig("").keymap).toEqual(DEFAULT_KEYMAP);
  const km = parseConfig(`[keys]
"finding.ignore" = "d"
"code.down" = { primary = "n", secondary = "J" }
"code.next_chapter" = { secondary = "" }
"view.wrap" = { primary = "W" }
"go.next_finding" = { secondary = "n" }`).keymap;
  const get = (id: string) => km.actions.find((a) => a.id === id)!;
  expect(get("finding.ignore")).toMatchObject({ key: "d" });
  expect(get("code.down")).toMatchObject({ key: "n", secondary: "J" });
  expect(get("code.next_chapter")).toMatchObject({ key: "shift-down", secondary: undefined });
  expect(get("view.wrap")).toMatchObject({ key: "W" });
  expect(get("go.next_finding")).toMatchObject({ key: "f", secondary: "n" });
  expect(get("finding.block")).toMatchObject({ key: "b" }); // untouched
  // Named keys, spelt as people write them.
  expect(parseConfig(`[keys]\n"code.to_toc" = { primary = "Shift+Left", secondary = "H" }`).keymap.actions.find((a) => a.id === "code.to_toc")).toMatchObject({ key: "shift-left", secondary: "H" });
  expect(parseConfig(`[keys]\n"review.copy" = "\\\\"\n"review.settings" = ","`).keymap.actions.find((a) => a.id === "review.copy")!.key).toBe("\\");
});

test("config: a wrong shape is refused and says what it should be", () => {
  expect(() => parseConfig(`[keys]\n"code.down" = 3`)).toThrow(/must be a key \("k"\) or \{ primary = "k", secondary = "j" \}/);
  expect(() => parseConfig(`[keys]\n"code.down" = { primary = "j", tertiary = "x" }`)).toThrow(/code\.down must be a key/);
  expect(() => parseConfig(`[keys]\n"code.down" = { primary = 1 }`)).toThrow(ConfigError);
  expect(() => parseConfig(`[keys]\n"code.down" = { primary = "j"`)).toThrow(/line 2: inline tables must open and close on one line/);
});

test("config: an old action is refused naming the action that replaced it, or saying it was removed", () => {
  expect(() => parseConfig(`[keys]\n"nav.line_down" = "n"`)).toThrow(/"nav\.line_down" is from the old key map; it is now "code\.down"/);
  expect(() => parseConfig(`[keys]\n"finding.not_an_issue" = "d"`)).toThrow(/now "finding\.ignore"/);
  expect(() => parseConfig(`[keys]\n"nav.ask_docs" = "Q"`)).toThrow(/now "review\.search_docs"/);
  expect(() => parseConfig(`[keys]\n"nav.bindings" = "!"`)).toThrow(/"nav\.bindings" was removed in the new key map/);
  expect(() => parseConfig(`[keys]\n"finding.undo" = "U"`)).toThrow(/was removed/);
  // Every old id is accounted for, and each replacement exists.
  for (const [old, now] of Object.entries(RENAMED)) {
    expect(() => effectiveKeys({ [old]: { primary: "z" } }), old).toThrow(now ? new RegExp(`now "${now.replace(".", "\\.")}"`) : /removed/);
    if (now) expect(rowById(now), old).toBeDefined();
  }
  expect(() => parseConfig(`[keys]\n"code.nope" = "d"`)).toThrow(/unknown action "code\.nope"/);
});

test("config: a key used twice in one state is refused naming both actions, across primary and secondary", () => {
  expect(() => parseConfig(`[keys]\n"review.copy" = "j"`)).toThrow(/code\.down \(secondary\) and review\.copy are both "j" in the (toc|code) state|toc\.down \(secondary\) and review\.copy/);
  expect(() => parseConfig(`[keys]\n"finding.close" = "b"`)).toThrow(/finding\.close and finding\.block are both "b" in the finding state/);
  expect(() => parseConfig(`[keys]\n"code.down" = { secondary = "down" }`)).toThrow(/code\.down has "down" as both primary and secondary/);
  expect(() => parseConfig(`[keys]\n"view.wrap" = "e"`)).toThrow(/view\.editor and view\.wrap are both "e" after v in the (toc|code|finding) state/);
  // A key that is a prefix where the action acts.
  expect(() => parseConfig(`[keys]\n"code.new_finding" = "g"`)).toThrow(/code\.new_finding = "g", but g is the go to prefix in the code state/);
  expect(() => parseConfig(`[keys]\n"finding.close" = "f"`)).not.toThrow(); // no filter prefix inside a finding
  // The same key in two states is fine, and a key freed by a remap can be taken.
  expect(() => parseConfig(`[keys]\n"finding.ignore" = "s"`)).not.toThrow();
  expect(() => parseConfig(`[keys]\n"view.editor" = "o"\n"view.wrap" = "e"`)).not.toThrow();
});

test("config: Esc and Tab cannot be rebound, fixed actions cannot be remapped, and digits after g are line numbers", () => {
  expect(() => parseConfig(`[keys]\n"code.down" = "escape"`)).toThrow(/Esc always backs out and cannot be rebound/);
  expect(() => parseConfig(`[keys]\n"code.down" = { secondary = "Tab" }`)).toThrow(/Tab .* cannot be rebound/);
  expect(() => parseConfig(`[keys]\n"code.focus_content" = "c"`)).toThrow(/code\.focus_content is fixed \(Tab\)/);
  expect(() => parseConfig(`[keys]\n"prompt.send" = "x"`)).toThrow(/is fixed/);
  expect(() => parseConfig(`[keys]\n"go.line" = "l"`)).toThrow(/is fixed/);
  expect(() => parseConfig(`[keys]\n"go.top" = "1"`)).toThrow(/after g a digit starts a line number/);
  expect(() => parseConfig(`[keys]\n"code.down" = "ab"`)).toThrow(/code\.down primary = "ab": a key is one printable character or a name/);
  for (const [raw, token] of [["x", "x"], ["Down", "down"], ["shift+down", "shift-down"], ["Return", "enter"], ["PageDown", "pgdn"], [" ", "space"], ["ctrl-d", "ctrl-d"], ["é", "é"]]) expect(normKey(raw!), raw).toBe(token!);
  for (const bad of ["ab", "\t", "ctrl-", "hyper-x"]) expect(normKey(bad), JSON.stringify(bad)).toBeNull();
});

test("prview keys: primary and secondary per action, by state and by prefix, with the effective keys", () => {
  const km = effectiveKeys({ "finding.ignore": { primary: "d" }, "view.wrap": { primary: "" }, "code.down": { secondary: "" } });
  const out = describeKeymap(km);
  expect(out).toMatch(/action\s+primary\s+secondary\s+description/);
  expect(out).toMatch(/code\.up\s+↑\s+k\s+Move up a line/);
  expect(out).toMatch(/code\.down\s+↓\s+-\s+Move down/);
  expect(out).toMatch(/finding\.ignore\s+d\s+-\s/);
  expect(out).toMatch(/view\.wrap\s+\(unbound\)/);
  expect(out).toMatch(/go\.next_finding\s+g f\s/);
  expect(out).toMatch(/filter\.high\s+f h\s+-\s+.*\(coming: filters\)/);
  for (const heading of ["toc:", "code:", "finding:", "content:", "prompt:", "submit:", "a then: AI", "f then: filter", "v then: view", "g then: go to"]) expect(out, heading).toContain(heading);
  expect(out.indexOf("code:")).toBeLessThan(out.indexOf("finding:"));
  expect(out).toContain("Esc and Tab cannot be rebound");
  for (const a of DEFAULT_ACTIONS) expect(out, a.id).toContain(a.id);
});

// ---------------------------------------------------------------- chords

test("chords: a prefix waits for its second key; Esc or an unknown key cancels it and does nothing else", () => {
  expect(step(CODE, null, "g")).toEqual({ pending: { prefix: "g" }, out: { kind: "pending" } });
  expect(press(CODE, ["g", "f"]).out).toEqual({ kind: "act", id: "go.next_finding" });
  expect(press(CODE, ["v", "w"]).out).toEqual({ kind: "act", id: "view.wrap" });
  expect(press(CODE, ["a", "?"]).out).toEqual({ kind: "act", id: "ai.ask" });
  expect(press(CODE, ["f", "h"]).out).toEqual({ kind: "act", id: "filter.high" });
  expect(press(CODE, ["g", "esc"])).toEqual({ pending: null, out: { kind: "cancel" } });
  expect(press(CODE, ["g", "z"])).toEqual({ pending: null, out: { kind: "cancel" } }); // not a g key: nothing happens
  expect(press(CODE, ["g", "j"])).toEqual({ pending: null, out: { kind: "cancel" } }); // not even a top-level key
  expect(press(CODE, ["esc"]).out).toEqual({ kind: "escape" }); // nothing pending: the screen backs out
  // Inside a finding, a's second keys are the finding's own; f is not a prefix there.
  expect(press(FINDING, ["a", "a"]).out).toEqual({ kind: "act", id: "ai.accept" });
  expect(press(FINDING, ["a", "i"]).out).toEqual({ kind: "cancel" });
  expect(press(FINDING, ["f"]).out).toEqual({ kind: "none" });
  expect(press(FINDING, ["g", "f"]).out).toEqual({ kind: "act", id: "go.next_finding" });
});

test("chords: g <digits> Enter goes to a line, g c <digits> Enter to a chapter; Backspace edits, Esc or another key cancels", () => {
  expect(press(CODE, ["g", "1", "2", "0", "enter"]).out).toEqual({ kind: "act", id: "go.line", n: 120 });
  expect(press(CODE, ["g", "1", "2"]).pending).toEqual({ prefix: "g", digits: "12" });
  expect(press(CODE, ["g", "1", "2", "backspace", "enter"]).out).toEqual({ kind: "act", id: "go.line", n: 1 });
  expect(press(CODE, ["g", "c", "3", "enter"]).out).toEqual({ kind: "act", id: "go.chapter", n: 3 });
  expect(press(CODE, ["g", "c"]).pending).toEqual({ prefix: "g", digits: "", chapter: true });
  expect(press(CODE, ["g", "c", "enter"])).toEqual({ pending: null, out: { kind: "cancel" } }); // no number typed
  expect(press(CODE, ["g", "4", "esc"])).toEqual({ pending: null, out: { kind: "cancel" } });
  expect(press(CODE, ["g", "4", "x"])).toEqual({ pending: null, out: { kind: "cancel" } });
  expect(pendingText({ prefix: "g" })).toBe("g");
  expect(pendingText({ prefix: "g", digits: "12" })).toBe("g 12");
  expect(pendingText({ prefix: "g", digits: "3", chapter: true })).toBe("g c 3");
  expect(pendingText(null)).toBe("");
  // With no prefix a digit does nothing: counts are gone.
  expect(press(CODE, ["3"]).out).toEqual({ kind: "none" });
});

test("chords: a remap moves the chord, and a key freed by a remap acts no more", () => {
  const km = effectiveKeys({ "go.next_finding": { primary: "n", secondary: "f" }, "view.wrap": { primary: "r" } });
  expect(press(CODE, ["g", "n"], km).out).toEqual({ kind: "act", id: "go.next_finding" });
  expect(press(CODE, ["g", "f"], km).out).toEqual({ kind: "act", id: "go.next_finding" });
  expect(press(CODE, ["v", "r"], km).out).toEqual({ kind: "act", id: "view.wrap" });
  expect(press(CODE, ["v", "w"], km).out).toEqual({ kind: "cancel" });
});

test("steps with Esc of their own (a prompt's cancel, the submit's back) act on it", () => {
  expect(press({ state: "prompt", kind: "comment" }, ["esc"]).out).toEqual({ kind: "act", id: "prompt.cancel" });
  expect(press({ state: "submit", step: "verdict" }, ["esc"]).out).toEqual({ kind: "act", id: "submit.cancel" });
  expect(press({ state: "submit", step: "preview", dryRun: false, hook: null, coverage: null }, ["esc"]).out).toEqual({ kind: "act", id: "submit.back" });
  // In a prompt, letters are text: they resolve to nothing, and a/f/v/g are not prefixes there.
  for (const k of ["a", "g", "j", "?", "\\", "q"]) expect(press({ state: "prompt", kind: "comment" }, [k]).out, k).toEqual({ kind: "none" });
});

// ---------------------------------------------------------------- the terminal's keys

test("shift-arrows and friends: the sequences terminals send, and Ink's reading of them", () => {
  expect(parseSequence("\x1b[1;2A")).toBe("shift-up");
  expect(parseSequence("\x1b[1;2B")).toBe("shift-down");
  expect(parseSequence("\x1b[1;2C")).toBe("shift-right");
  expect(parseSequence("\x1b[1;2D")).toBe("shift-left");
  expect(parseSequence("\x1b[1;5B")).toBe("down"); // ctrl-down: no shift bit
  expect(parseSequence("\x1b[1;6B")).toBe("shift-down"); // ctrl-shift-down: the shift bit is set
  expect(parseSequence("\x1b[a")).toBe("shift-up"); // rxvt
  expect(parseSequence("\x1b[b")).toBe("shift-down");
  expect(parseSequence("\x1b[A")).toBe("up");
  expect(parseSequence("\x1bOB")).toBe("down"); // application cursor mode
  expect(parseSequence("\x1b[Z")).toBe("shift-tab");
  expect(parseSequence("\x1b[6~")).toBe("pgdn");
  expect(parseSequence("\x1b[5~")).toBe("pgup");
  expect(parseSequence("\x1b[99~")).toBeNull();
  expect(tokenOf("", { downArrow: true, shift: true })).toBe("shift-down");
  expect(tokenOf("", { upArrow: true })).toBe("up");
  expect(tokenOf("[1;2B", {})).toBe("shift-down"); // a sequence Ink left unread, ESC stripped
  expect(tokenOf("J", { shift: true })).toBe("J");
  expect(tokenOf("", { tab: true })).toBe("tab");
  expect(tokenOf("", { return: true })).toBe("enter");
  expect(tokenOf("", { escape: true })).toBe("esc");
  expect(tokenOf("u", { ctrl: true })).toBe("ctrl-u");
  expect(tokenOf("\x15", {})).toBe("ctrl-u"); // raw, as a split chunk delivers it
  expect(tokenOf("\r", {})).toBe("enter");
  expect(tokenOf(" ", {})).toBe("space");
  expect(tokenOf("", { pageDown: true })).toBe("pgdn");
  expect(tokenOf("", { backspace: true })).toBe("backspace");
  // Shift-down and J are one action, however the terminal sends it.
  expect(press(CODE, [tokenOf("", { downArrow: true, shift: true })!]).out).toEqual({ kind: "act", id: "code.next_chapter" });
  expect(press(CODE, [parseSequence("\x1b[1;2B")!]).out).toEqual({ kind: "act", id: "code.next_chapter" });
  expect(press(CODE, ["J"]).out).toEqual({ kind: "act", id: "code.next_chapter" });
  expect(press(CODE, ["K"]).out).toEqual({ kind: "act", id: "code.prev_chapter" });
});

// ---------------------------------------------------------------- drift: the panel is what acts

/** Every action a state's panel lists, top level and behind each prefix, as the handler resolves the listed keys. */
function listedActs(ks: KeyState, km: Keymap): Set<string> {
  const ids = new Set<string>();
  for (const r of rowsOf(ks, km)) for (const k of keysOf(r)) {
    const { out } = step(ks, null, k, km);
    expect(out, `${name(ks)} ${k}`).toEqual({ kind: "act", id: r.id });
    ids.add(r.id);
  }
  for (const p of prefixesOf(ks, km)) {
    expect(step(ks, null, p, km).out, `${name(ks)} prefix ${p}`).toEqual({ kind: "pending" });
    for (const r of prefixRows(ks, p, km)) {
      const keys = r.id === "go.line" ? ["7", "enter"] : r.id === "go.chapter" ? [r.key, "2", "enter"] : keysOf(r);
      if (r.id === "go.line" || r.id === "go.chapter") {
        expect(press(ks, [p, ...keys], km).out, `${name(ks)} ${p} ${keys}`).toMatchObject({ kind: "act", id: r.id });
      } else for (const k of keys) expect(press(ks, [p, k], km).out, `${name(ks)} ${p} ${k}`).toEqual({ kind: "act", id: r.id });
      ids.add(r.id);
    }
  }
  return ids;
}

/** Every action any key reaches in a state, pressed alone or after each prefix. */
function actingActs(ks: KeyState, km: Keymap): Set<string> {
  const ids = new Set<string>();
  for (const k of UNIVERSE) {
    const one = step(ks, null, k, km);
    if (one.out.kind === "act") ids.add(one.out.id);
    if (one.out.kind !== "pending") continue;
    for (const k2 of UNIVERSE) {
      const two = step(ks, one.pending, k2, km);
      if (two.out.kind === "act") ids.add(two.out.id);
      if (two.out.kind !== "pending") continue;
      const three = press(ks, [k, k2, "1", "enter"], km).out;
      if (three?.kind === "act") ids.add(three.id);
    }
  }
  return ids;
}

for (const [label, km] of [["defaults", DEFAULT_KEYMAP], ["remapped", effectiveKeys({ "go.next_finding": { primary: "n" }, "finding.ignore": { primary: "d", secondary: "I" }, "code.down": { secondary: "" }, "view.wrap": { primary: "" } })]] as const) {
  test(`drift (${label}): per state and per prefix, the panel lists exactly what acts`, () => {
    installKeymap(km);
    for (const ks of ALL_STATES) {
      const listed = listedActs(ks, km), acting = actingActs(ks, km);
      expect([...acting].sort(), name(ks)).toEqual([...listed].sort());
      // The panel's entries are those rows: one per label group, then one per prefix, and each prefix's second keys once pressed.
      const entries = entriesOf(ks);
      const prefixEntries = entries.filter((e) => e.label.endsWith("…"));
      expect(prefixEntries.map((e) => e.keys), name(ks)).toEqual(prefixesOf(ks, km));
      for (const p of prefixesOf(ks, km)) {
        const second = entriesOf(ks, { prefix: p });
        expect(second.map((e) => e.label), `${name(ks)} ${p}`).toEqual(prefixRows(ks, p, km).map((r) => r.label));
        expect(panelTitle(ks, { prefix: p })).toBe(`${p} ${PREFIXES[p as Prefix]}`);
      }
    }
    // An unbound action is neither listed nor reachable.
    if (label === "remapped") for (const ks of [TOC, CODE, FINDING]) expect(actingActs(ks, km).has("view.wrap")).toBe(false);
  });
}

test("drift: every action is listed in some state, and the handler has a case for every id", () => {
  const everywhere = new Set(ALL_STATES.flatMap((ks) => [...listedActs(ks, DEFAULT_KEYMAP)]));
  expect(DEFAULT_ACTIONS.map((a) => a.id).filter((id) => !everywhere.has(id))).toEqual([]);
  const src = readFileSync(join(import.meta.dir, "../src/tui.tsx"), "utf8");
  for (const { id } of DEFAULT_ACTIONS) expect(src, id).toContain(`case "${id}"`);
  // No key is written into the handler: it switches on ids, never on characters.
  expect(src).not.toMatch(/ch === "[a-zA-Z]"/);
  expect(ALL_ACTIONS.length + STEP_ACTIONS.length).toBe(DEFAULT_ACTIONS.length);
});

test("the panel: entries show primary then secondary, grouped by label; a pending number shows how to finish it", () => {
  const e = entriesOf(CODE).map((x) => `${x.keys} ${x.label}`);
  expect(e.slice(0, 4)).toEqual(["↓/↑ j/k line", "⇧↓/⇧↑ J/K chapter", "→ l open finding", "← h contents"]);
  expect(e.slice(-4)).toEqual(["a AI…", "f filter…", "v view…", "g go to…"]);
  expect(entriesOf(CODE, { prefix: "g" }).map((x) => `${x.keys} ${x.label}`)).toContain("0-9 line");
  expect(entriesOf(CODE, { prefix: "g", digits: "1" }).map((x) => x.keys)).toEqual(["0-9", "Enter", "Esc"]);
  expect(panelTitle(CODE)).toBe("keys");
  expect(panelTitle(FINDING)).toBe("finding");
  expect(panelTitle(CONTENT)).toBe("content");
});
