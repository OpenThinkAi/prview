// The documents docs search looks through, built from two sources: the action tables (every action, described) and
// docs/recipes.toml (a reviewer's questions mapped to actions). Both describe actions, never keys, so a remapped
// binding cannot make a document stale; the key panel shows the live bindings next to whatever a search finds.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseToml } from "./config.ts";
import { ALL_ACTIONS, FINDING_KEYS, INFO_KEYS, NAV_KEYS } from "./keys.ts";

export const RECIPES_PATH = join(import.meta.dir, "..", "docs", "recipes.toml");

export type Recipe = { q: string[]; actions: string[]; why: string };

/** `text` is what gets embedded; `actions` is what a hit points at (an action doc points at its own id). */
export type Doc =
  | { kind: "action"; id: string; state: string; label: string; text: string; actions: string[] }
  | { kind: "recipe"; id: string; text: string; why: string; actions: string[] };

const STATES: [Set<string>, string][] = [
  [new Set(NAV_KEYS.map((a) => a.id)), "in the diff with no box open"],
  [new Set(FINDING_KEYS.map((a) => a.id)), "in a finding's box"],
  [new Set(INFO_KEYS.map((a) => a.id)), "in a notice or summary box"],
];
/** The screen state an action is pressed in, in words: its id's prefix says which table it is from. */
export const stateOf = (id: string): string => STATES.find(([ids]) => ids.has(id))?.[1] ?? "";

export function parseRecipes(text: string): Recipe[] {
  const list = parseToml(text).recipe;
  if (!Array.isArray(list)) throw new Error("recipes: no [[recipe]] entries");
  return list.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    const where = `recipe ${i + 1}`;
    const strings = (k: string): string[] => {
      const v = r[k];
      if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !x.trim())) throw new Error(`${where}: ${k} must be a non-empty list of strings`);
      return v.map((x) => x.trim());
    };
    if (typeof r.why !== "string" || !r.why.trim()) throw new Error(`${where}: why must be a non-empty string`);
    return { q: strings("q"), actions: strings("actions"), why: r.why.trim() };
  });
}

export const loadRecipes = (path = RECIPES_PATH): Recipe[] => parseRecipes(readFileSync(path, "utf8"));

/** One document per action, and one per phrasing of each recipe, so each way of asking is matched on its own. */
export function buildCorpus(recipes: Recipe[] = loadRecipes()): Doc[] {
  const docs: Doc[] = ALL_ACTIONS.map((a) => {
    const state = stateOf(a.id);
    return { kind: "action", id: a.id, state, label: a.label, text: `${a.label}: ${a.description} (${state})`, actions: [a.id] };
  });
  recipes.forEach((r, i) => r.q.forEach((q, j) => docs.push({ kind: "recipe", id: `recipe.${i + 1}.${j + 1}`, text: q, why: r.why, actions: r.actions })));
  return docs;
}
