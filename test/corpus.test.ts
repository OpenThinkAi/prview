import { expect, test } from "bun:test";
import { buildCorpus, loadRecipes, parseRecipes } from "../src/corpus.ts";
import { parseToml } from "../src/config.ts";
import { ALL_ACTIONS } from "../src/keys.ts";

const recipes = loadRecipes();

test("every action has a description", () => {
  expect(ALL_ACTIONS.filter((a) => !a.description.trim()).map((a) => a.id)).toEqual([]);
});

test("every action is named by at least one recipe", () => {
  const covered = new Set(recipes.flatMap((r) => r.actions));
  expect(ALL_ACTIONS.filter((a) => !covered.has(a.id)).map((a) => a.id)).toEqual([]);
});

test("no recipe names an action that does not exist", () => {
  const known = new Set(ALL_ACTIONS.map((a) => a.id));
  expect(recipes.flatMap((r) => r.actions).filter((id) => !known.has(id))).toEqual([]);
});

test("every recipe has 2-4 phrasings, a one-line why, and each phrasing is unique", () => {
  for (const r of recipes) {
    expect({ q: r.q[0], ok: r.q.length >= 2 && r.q.length <= 4 }).toEqual({ q: r.q[0], ok: true });
    expect(r.why).not.toContain("\n");
  }
  const all = recipes.flatMap((r) => r.q.map((q) => q.toLowerCase()));
  expect(new Set(all).size).toBe(all.length);
});

test("every action is covered by a recipe with 2-4 phrasings", () => {
  for (const a of ALL_ACTIONS) {
    const n = recipes.filter((r) => r.actions.includes(a.id)).reduce((s, r) => s + r.q.length, 0);
    expect({ id: a.id, ok: n >= 2 }).toEqual({ id: a.id, ok: true });
  }
});

test("the how-tos a reviewer asks for are there", () => {
  const asks = recipes.flatMap((r) => r.q).join("\n").toLowerCase();
  for (const phrase of ["submit a review", "post a finding as a comment", "open the file in my editor", "copy a finding"]) expect(asks).toContain(phrase);
});

test("corpus: one doc per action plus one per phrasing, and no doc's text carries a key", () => {
  const docs = buildCorpus(recipes);
  expect(docs.length).toBe(ALL_ACTIONS.length + recipes.reduce((n, r) => n + r.q.length, 0));
  expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length);
  const keys = [...new Set(ALL_ACTIONS.map((a) => a.key))];
  // Punctuation keys (] [ ?) must not appear at all, which also catches a chord like ]f. Letter keys are words in prose,
  // so they are checked as the forms a writer would use to name one: quoted, or "key x".
  const punct = [...new Set(keys.join("").replace(/[A-Za-z0-9\s]/g, ""))];
  expect(punct.sort()).toEqual(["?", "[", "]"]);
  for (const d of docs) {
    const text = d.text + "\n" + (d.kind === "recipe" ? d.why : "");
    for (const ch of punct) expect({ id: d.id, ch, has: text.includes(ch) }).toEqual({ id: d.id, ch, has: false });
    expect({ id: d.id, bad: /[`\\]|\b(press|presses|pressing|ctrl)\b/i.test(text) }).toEqual({ id: d.id, bad: false });
    for (const k of keys.filter((k) => /^[A-Za-z]$/.test(k))) expect({ id: d.id, k, named: new RegExp(`['"]${k}['"]|\\bkey ${k}\\b`).test(text) }).toEqual({ id: d.id, k, named: false });
  }
});

test("action docs say which state they act in, and recipes point at action ids", () => {
  const docs = buildCorpus(recipes);
  expect(docs.find((d) => d.id === "finding.block")).toMatchObject({ kind: "action", state: "in a finding's box" });
  expect(docs.find((d) => d.id === "nav.submit")!.text).toContain("verdict");
  const r = docs.find((d) => d.kind === "recipe")!;
  expect(r.actions.length).toBeGreaterThan(0);
});

test("recipes file errors are specific", () => {
  expect(() => parseRecipes("")).toThrow(/no \[\[recipe\]\]/);
  expect(() => parseRecipes('[[recipe]]\nq = []\nactions = ["nav.quit"]\nwhy = "x"')).toThrow(/recipe 1: q/);
  expect(() => parseRecipes('[[recipe]]\nq = ["a"]\nactions = ["nav.quit"]')).toThrow(/why/);
});

test("toml subset: arrays of tables and string arrays", () => {
  expect(parseToml(`[[r]]\nq = ["a, b", 'c']\n[[r]]\nq = []`)).toEqual({ r: [{ q: ["a, b", "c"] }, { q: [] }] });
  expect(() => parseToml("a = [\n1]")).toThrow(/line 1/);
  expect(() => parseToml("[[r]")).toThrow(/line 1/);
});
