import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { inkTestHooks } from "./ink-hooks.ts";
import { parseDiff } from "../src/diff.ts";
import { hunksOf, type Finding } from "../src/guide.ts";
import type { Review } from "../src/build.ts";
import type { Doc } from "../src/document.ts";
import { loadConfig, parseConfig, type Config } from "../src/config.ts";
import { DEFAULT_ACTIONS, DEFAULT_KEYMAP, describeKeymap, installKeymap, keyOf } from "../src/keys.ts";
import { editsOf, editToml, fieldsOf, openSettings, saveSettings, settingsAct, settingsKey, type Settings } from "../src/settings.ts";
import { settingsEntries } from "../src/settings-view.tsx";
import { App, type Outcome } from "../src/tui.tsx";
import { editor } from "../src/editor.ts";

// Settings are saved to $PRVIEW_CONFIG; every test here points it (and $PRVIEW_HOME) at a scratch directory.
let tmp = "";
const savedEnv = { home: process.env.PRVIEW_HOME, config: process.env.PRVIEW_CONFIG };
let n = 0;
const freshConfig = (text?: string) => { const p = join(tmp, `config-${++n}.toml`); if (text !== undefined) writeFileSync(p, text); process.env.PRVIEW_CONFIG = p; return p; };
inkTestHooks();
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "prview-settings-")); process.env.PRVIEW_HOME = join(tmp, "home"); });
afterEach(() => installKeymap(DEFAULT_KEYMAP));
afterAll(() => {
  cleanup(); rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["PRVIEW_HOME", savedEnv.home], ["PRVIEW_CONFIG", savedEnv.config]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const at = (s: Settings, pred: (f: Settings["fields"][number]) => boolean): Settings => ({ ...s, cursor: s.fields.findIndex(pred) });
const onKey = (s: Settings, id: string) => at(s, (f) => f.kind === "key" && f.id === id);
/** Enter, then `token` as the captured key. */
const bind = (s: Settings, token: string) => settingsKey(settingsAct(s, "settings.edit").s, token).s;
const open = (text = "", path = "/nowhere/config.toml") => openSettings(parseConfig(text), path);

// ---------------------------------------------------------------- the fields

test("fields: every action (fixed ones too), then the defaults by severity, the model per role, the editor, the display and updates", () => {
  const f = fieldsOf();
  expect(f.filter((x) => x.kind === "key").map((x) => (x as { id: string }).id)).toEqual(DEFAULT_ACTIONS.map((a) => a.id));
  expect(f.slice(DEFAULT_ACTIONS.length).map((x) => x.kind)).toEqual(["default", "default", "default", "role", "role", "role", "role", "role", "editor", "wrap", "blind", "auto_update"]);
  const s = open(`editor = "nvim"\nwrap = true\n[keys]\n"code.down" = { primary = "down", secondary = "n" }\n[defaults]\nlow = "ignore"`);
  expect(s.values.keys["code.down"]).toEqual({ primary: "down", secondary: "n" });
  expect(s.values.defaults).toEqual({ high: "block", medium: "comment", low: "ignore" });
  expect([s.values.editor, s.values.wrap, s.values.blind, s.values.autoUpdate]).toEqual(["nvim", true, false, false]);
});

test("auto_update: read and checked like wrap, off by default; Enter toggles it and the save writes one top-level line", () => {
  expect(parseConfig("").autoUpdate).toBe(false);
  expect(parseConfig("auto_update = true").autoUpdate).toBe(true);
  expect(() => parseConfig(`auto_update = "yes"`)).toThrow("auto_update must be true or false");
  const s = settingsAct(at(open(), (f) => f.kind === "auto_update"), "settings.edit").s;
  expect(s.values.autoUpdate).toBe(true);
  expect(editsOf(s.initial, s.values)).toEqual([{ table: null, key: "auto_update", value: "true" }]);
  expect(editToml(`wrap = true  # mine\n\n[keys]\n"view.wrap" = "W"\n`, editsOf(s.initial, s.values))).toBe(`wrap = true  # mine\nauto_update = true\n\n[keys]\n"view.wrap" = "W"\n`);
  expect(editToml("auto_update = true # yes\n", editsOf(open("auto_update = true").values, open().values))).toBe("auto_update = false # yes\n");
  const path = freshConfig("# mine\n");
  const cfg = saveSettings({ ...s, path });
  expect(cfg.autoUpdate).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("# mine\nauto_update = true\n");
});

test("config: editor and wrap are read and checked like the rest; $PRVIEW_EDITOR beats the config, which beats $EDITOR", () => {
  expect(() => parseConfig(`wrap = "yes"`)).toThrow("wrap must be true or false");
  expect(() => parseConfig(`editor = ""`)).toThrow("editor");
  expect(editor({ PRVIEW_EDITOR: "vim", EDITOR: "nano" }, "zed -w")).toEqual(["vim"]);
  expect(editor({ EDITOR: "nano" }, "zed -w")).toEqual(["zed", "-w"]);
  expect(editor({ EDITOR: "nano" })).toEqual(["nano"]);
});

// ---------------------------------------------------------------- keys

test("a key: Enter captures the next keypress as the binding, primary or (→) secondary", () => {
  let s = bind(onKey(open(), "finding.ignore"), "d");
  expect(s.values.keys["finding.ignore"]).toEqual({ primary: "d", secondary: "" });
  expect(s.message?.text).toBe("finding.ignore primary: d");
  s = settingsAct(onKey(s, "view.wrap"), "settings.right").s;
  expect(s.slot).toBe("secondary");
  s = bind(s, "W");
  expect(s.values.keys["view.wrap"]).toEqual({ primary: "w", secondary: "W" });
  expect(s.message?.text).toBe("view.wrap secondary: v W"); // a prefixed action's key is its second key
  expect(settingsAct(s, "settings.left").s.slot).toBe("primary");
});

test("a key: a conflict in the same state is refused inline, naming the other action; nothing changes", () => {
  const s0 = onKey(open(), "code.down");
  const s = bind(s0, "k");
  expect(s.values).toEqual(s0.values);
  expect(s.message).toEqual({ text: expect.stringContaining("code.up"), error: true });
  expect(s.message!.text).toMatch(/^refused: .*"k".*code state/);
  // A prefix key is taken in that state too; the same key in another state is fine.
  expect(bind(onKey(open(), "review.quit"), "g").message?.text).toMatch(/refused: .*go to prefix/);
  expect(bind(onKey(open(), "finding.close"), "q").values.keys["finding.close"]!.primary).toBe("q");
});

test("a key: Esc and Tab cannot be bound, Backspace clears a secondary, a fixed action says so", () => {
  const s0 = onKey(open(), "code.down");
  const esc = bind(s0, "esc");
  expect([esc.sub, esc.values]).toEqual([null, s0.values]);
  expect(esc.message?.text).toContain("cannot be bound");
  const tab = bind(s0, "tab");
  expect(tab.values).toEqual(s0.values);
  expect(tab.message).toEqual({ text: expect.stringContaining("Tab"), error: true });
  const sec = settingsAct(s0, "settings.right").s;
  expect(settingsAct(sec, "settings.clear").s.values.keys["code.down"]).toEqual({ primary: "down", secondary: "" });
  expect(bind(sec, "backspace").values.keys["code.down"]).toEqual({ primary: "down", secondary: "" }); // while capturing, too
  expect(settingsAct(s0, "settings.clear").s.values).toEqual(s0.values); // the primary is not cleared
  const fixed = settingsAct(onKey(open(), "toc.focus_content"), "settings.edit").s;
  expect([fixed.sub, fixed.message?.error]).toEqual([null, true]);
  expect(fixed.message?.text).toContain("fixed");
});

// ---------------------------------------------------------------- the other fields

test("choices step through what the config accepts; the editor takes a line; wrap and blind toggle", () => {
  let s = at(open(`[models.qwen]\nkind = "openai-compatible"\nendpoint = "http://localhost:1/v1"`), (f) => f.kind === "default" && f.severity === "medium");
  for (const want of ["ignore", "block", "comment"]) { s = settingsAct(s, "settings.edit").s; expect(s.values.defaults.medium).toBe(want as never); }
  s = at(s, (f) => f.kind === "role" && f.role === "critic");
  s = settingsAct(s, "settings.edit").s;
  expect(s.values.roles.critic).toBe("qwen");
  s = settingsAct(s, "settings.edit").s;
  expect(s.values.roles.critic).toBeUndefined(); // back to the default model
  s = settingsAct(at(s, (f) => f.kind === "editor"), "settings.edit").s;
  for (const k of ["z", "e", "d", "space", "-", "w"]) s = settingsKey(s, k).s;
  s = settingsKey(s, "enter").s;
  expect([s.sub, s.values.editor]).toEqual([null, "zed -w"]);
  s = settingsAct(at(s, (f) => f.kind === "wrap"), "settings.edit").s;
  s = settingsAct(at(s, (f) => f.kind === "blind"), "settings.edit").s;
  expect([s.values.wrap, s.values.blind]).toEqual([true, true]);
  // With only the built-in model there is nothing to step to, and the view says where models come from.
  expect(settingsAct(at(open(), (f) => f.kind === "role"), "settings.edit").s.message?.text).toContain("[models.");
});

test("leaving: no changes leaves at once; changes ask, y saves, n discards, Esc keeps editing", () => {
  expect(settingsAct(open(), "settings.leave").out).toBe("leave");
  const s = bind(onKey(open(), "finding.ignore"), "d");
  const asked = settingsAct(s, "settings.leave");
  expect([asked.out, asked.s.sub]).toEqual([undefined, { kind: "confirm" }]);
  expect(settingsEntries(asked.s).map((e) => `${e.keys} ${e.label}`)).toEqual(["y save", "n discard", "Esc keep editing"]);
  expect(settingsKey(asked.s, "y").out).toBe("save");
  expect(settingsKey(asked.s, "n").out).toBe("leave");
  const kept = settingsKey(asked.s, "esc");
  expect([kept.out, kept.s.sub, kept.s.values]).toEqual([undefined, null, s.values]);
});

// ---------------------------------------------------------------- the file

const FILE = `# my prview config
blind = true   # read first

[models.qwen]
kind = "openai-compatible"
endpoint = "http://localhost:8000/v1"   # the mlx server

[roles]
critic = "qwen"

[keys]
"finding.ignore" = "d"   # d for dismiss
"view.wrap" = "W"

[someday]
unknown = "kept"
`;

test("save: only the changed lines are rewritten, comments and unknown tables kept; new lines go in their table", () => {
  let s = open(FILE);
  s = bind(onKey(s, "finding.ignore"), "e"); // changes a line that has a comment
  s = bind(onKey(s, "view.wrap"), "w"); // back to its default: the line goes
  s = bind(settingsAct(onKey(s, "code.down"), "settings.right").s, "n"); // a new [keys] line with both keys
  s = settingsAct(at(s, (f) => f.kind === "default" && f.severity === "low"), "settings.edit").s; // no [defaults] yet
  s = settingsAct(at(s, (f) => f.kind === "wrap"), "settings.edit").s; // a top-level key
  s = settingsAct(at(s, (f) => f.kind === "role" && f.role === "critic"), "settings.edit").s; // back to the default model: removed
  const out = editToml(FILE, editsOf(s.initial, s.values));
  expect(out).toBe(`# my prview config
blind = true   # read first
wrap = true

[models.qwen]
kind = "openai-compatible"
endpoint = "http://localhost:8000/v1"   # the mlx server

[roles]

[keys]
"finding.ignore" = "e"   # d for dismiss
"code.down" = { primary = "down", secondary = "n" }

[someday]
unknown = "kept"

[defaults]
low = "ignore"
`);
  const cfg = parseConfig(out);
  expect(cfg.keymap.actions.find((a) => a.id === "finding.ignore")!.key).toBe("e");
  expect(cfg.defaults.low).toBe("ignore");
  expect(cfg.roles.critic).toBeUndefined();
});

test("save: an empty or missing file gets just the changed settings; a file with only tables gets top-level keys first", () => {
  const e = (text: string, s: Settings) => editToml(text, editsOf(s.initial, s.values));
  const s = settingsAct(at(open(), (f) => f.kind === "blind"), "settings.edit").s;
  expect(e("", s)).toBe("blind = true\n");
  expect(e("[keys]\n\"view.wrap\" = \"W\"\n", s)).toBe("blind = true\n\n[keys]\n\"view.wrap\" = \"W\"\n");
});

test("save: writes $PRVIEW_CONFIG, reads back as shown, and prview keys shows the result", () => {
  const path = freshConfig(FILE);
  let s = openSettings(loadConfig(), path);
  s = bind(onKey(s, "go.next_finding"), "n");
  const cfg = saveSettings(s);
  expect(readFileSync(path, "utf8")).toContain(`"go.next_finding" = "n"`);
  expect(readFileSync(path, "utf8")).toContain("[someday]\nunknown = \"kept\"");
  expect(cfg.keymap.actions.find((a) => a.id === "go.next_finding")!.key).toBe("n");
  expect(describeKeymap(loadConfig().keymap)).toMatch(/go\.next_finding\s+g n\s/);
  // And the CLI itself, reading the same file.
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.tsx"), "keys"], { env: { ...process.env, PRVIEW_CONFIG: path } });
  expect(p.stdout.toString()).toMatch(/finding\.ignore\s+d\s/);
  expect(p.stdout.toString()).toMatch(/go\.next_finding\s+g n\s/);
});

test("save: no file yet creates it (and its directory)", () => {
  const path = join(tmp, "new", "dir", "config.toml");
  const s = bind(onKey(openSettings(parseConfig(""), path), "review.quit"), "Q");
  saveSettings(s);
  expect(readFileSync(path, "utf8")).toBe(`[keys]\n"review.quit" = "Q"\n`);
});

test("save: a file changed underneath into something that clashes is refused and left as it was", () => {
  const path = freshConfig("");
  const s = bind(onKey(openSettings(loadConfig(), path), "finding.ignore"), "d");
  writeFileSync(path, `[keys]\n"finding.close" = "d"\n`); // someone took d meanwhile
  expect(() => saveSettings(s)).toThrow(/finding\.close and finding\.ignore/);
  expect(readFileSync(path, "utf8")).toBe(`[keys]\n"finding.close" = "d"\n`);
});

// ---------------------------------------------------------------- the screen

const DIFF = `diff --git a/src/a.rs b/src/a.rs
index 1..2 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -10,2 +10,2 @@ fn main() {
 keep
-old
+new
`;
const files = parseDiff(DIFF);
const [h1] = hunksOf(files);
const finding: Finding = { id: "1", source: "critic", hunk: h1!.id, side: "new", line: 11, severity: "high", kind: "bug", title: "A finding", claim: "it is wrong", evidence: "look", status: "upheld" };
function fixture(): Review {
  const doc: Doc = {
    schema: "prview-review/1",
    target: { repo: "/nowhere", base: "a", head: "b", title: "A change", body: "", label: "main..x" },
    plan: { summary: "", by: "guide", mechanical: [], chapters: [{ title: "Core", intent: "Check it", why: "Because.", hunks: [h1!.id] }] },
    findings: [finding], human: { comments: [], visited: [] },
  };
  return { slug: "settings", repo: "/nowhere", worktree: "/nowhere", context: 3, created: "now", pos: { item: 0, line: 0 }, doc };
}
const DOWN = "\x1b[B", RIGHT = "\x1b[C", ESC = "\x1b";
const KEY = /\x1b\[[0-9;]*[A-Za-z~]|./gsu;
const settle = () => new Promise((r) => setTimeout(r, 30));
async function screen(config: Config) {
  const saved: Config[] = [], outcomes: Outcome[] = [];
  const app = render(<App review={fixture()} files={files} onDone={(o) => outcomes.push(o)} config={config} onConfig={(c) => saved.push(c)} defaults={config.defaults} size={{ cols: 140, rows: 40 }} />);
  await settle();
  const press = async (keys: string) => { for (const k of keys.match(KEY) ?? []) { app.stdin.write(k); await settle(); } };
  return { app, press, saved, outcomes, frame: () => (app.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "") };
}

test("screen: \\ opens the settings full-screen with every section, the cursor's field lit and the settings keys in the panel", async () => {
  const path = freshConfig();
  const t = await screen(loadConfig());
  await t.press("\\");
  const f = t.frame();
  expect(f).toContain("Settings");
  expect(f).toContain(`saved to ${path}`);
  expect(f).toContain("Keys");
  expect(f).toMatch(/toc\.down\s+toc\s+ ↓ \s+ j /);
  expect(f).not.toContain("READ IN ORDER"); // the review is not drawn under it
  expect(f).toMatch(/↓\/↑ j\/k\s+field/);
  expect(f).toMatch(/Enter\s+edit/);
  // The later sections are reached with the arrows.
  for (let i = 0; i < DEFAULT_ACTIONS.length; i++) await t.press(DOWN);
  expect(t.frame()).toContain("Default actions by severity");
  expect(t.frame()).toMatch(/high\s+ block /);
  for (let i = 0; i < 12; i++) await t.press(DOWN);
  for (const s of ["Models per role", "Editor command", "Display", "Updates"]) expect(t.frame()).toContain(s);
  expect(t.frame()).toMatch(/blind\s+ off$/m);
  expect(t.frame()).toMatch(/auto_update\s+ off /); // the cursor's row: lit
});

test("screen: rebinding a key, a refused conflict, then Esc → y saves to the config and the new key acts at once", async () => {
  const path = freshConfig("# mine\n");
  const t = await screen(loadConfig());
  await t.press("\\");
  const down = DEFAULT_ACTIONS.findIndex((a) => a.id === "review.quit");
  for (let i = 0; i < down; i++) await t.press(DOWN);
  await t.press("\r");
  expect(t.frame()).toContain("Press the new primary key for review.quit");
  await t.press("g"); // the go to prefix
  expect(t.frame()).toMatch(/refused: .*go to prefix/);
  await t.press("\rQ");
  expect(t.frame()).toContain("review.quit primary: Q");
  expect(t.frame()).toMatch(/\*review\.quit/);
  expect(t.frame()).toContain("1 unsaved change");
  await t.press(ESC);
  expect(t.frame()).toContain("Save changes? y / n / Esc to keep editing");
  await t.press("y");
  expect(readFileSync(path, "utf8")).toBe(`# mine\n\n[keys]\n"review.quit" = "Q"\n`);
  expect(t.frame()).toContain(`settings saved to ${path}`);
  expect(t.saved).toHaveLength(1);
  expect(keyOf("review.quit")).toBe("Q");
  expect(t.frame()).toMatch(/Q\s+quit/); // the key panel shows it
  await t.press("q");
  expect(t.outcomes).toEqual([]); // q no longer quits
  await t.press("Q");
  expect(t.outcomes).toEqual([{ kind: "quit" }]);
});

test("screen: n discards; nothing is written and the keys stay as they were", async () => {
  const path = freshConfig();
  const t = await screen(loadConfig());
  await t.press("\\" + RIGHT + "\rn"); // toc.down's secondary becomes n
  expect(t.frame()).toContain("toc.down secondary: n");
  await t.press(ESC + "n");
  expect(existsSync(path)).toBe(false);
  expect(t.frame()).toContain("READ IN ORDER"); // back in the review
  expect(keyOf("toc.down")).toBe("↓");
  expect(t.saved).toEqual([]);
});

test("screen: saved defaults and display settings apply without restarting", async () => {
  freshConfig();
  const t = await screen(loadConfig());
  await t.press("\\");
  for (let i = 0; i < DEFAULT_ACTIONS.length; i++) await t.press(DOWN);
  await t.press("\r"); // high: block → comment
  for (let i = 0; i < 9; i++) await t.press(DOWN);
  await t.press("\r"); // wrap on
  await t.press(ESC + "y");
  expect(t.saved[0]!.defaults.high).toBe("comment");
  expect(t.saved[0]!.wrap).toBe(true);
  await t.press(RIGHT); // into the code: the header says wrapped
  expect(t.frame()).toContain("· wrapped");
  await t.press("gf"); // the high finding now starts as a comment
  expect(t.frame()).toMatch(/high · comment/);
});

test("screen: a paste into the editor line keeps every character", async () => {
  const path = freshConfig();
  const t = await screen(loadConfig());
  await t.press("\\");
  for (let i = 0; i < DEFAULT_ACTIONS.length + 8; i++) await t.press(DOWN);
  await t.press("\r");
  t.app.stdin.write("zed -w"); // one chunk, as a paste arrives
  await settle();
  await t.press("\r" + ESC + "y");
  expect(readFileSync(path, "utf8")).toBe(`editor = "zed -w"\n`);
  expect(t.saved[0]!.editor).toBe("zed -w");
});
