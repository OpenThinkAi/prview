import { expect, test } from "bun:test";
import { checklistNote, DEFAULT_FILTER, filtered, filterLabel, filterOf, FILTERS, shownAt } from "../src/filter.ts";
import type { Severity } from "../src/guide.ts";

const at = (severity: Severity) => ({ severity });

test("filter: high shows high, medium shows high and medium, all shows everything", () => {
  const fs = [at("low"), at("high"), at("medium"), at("high")];
  expect(filtered(fs, "high").map((f) => f.severity)).toEqual(["high", "high"]);
  expect(filtered(fs, "medium").map((f) => f.severity)).toEqual(["high", "medium", "high"]);
  expect(filtered(fs, "all")).toEqual(fs);
  expect(shownAt("low", "medium")).toBe(false);
  expect(shownAt("medium", "high")).toBe(false);
  expect(shownAt("high", "high")).toBe(true);
});

test("filter: a stored value that is not a level is the default, and the wording names the level", () => {
  expect(DEFAULT_FILTER).toBe("all");
  for (const l of FILTERS) expect(filterOf(l)).toBe(l);
  for (const bad of [undefined, null, "", "low", "HIGH", 3, {}]) expect(filterOf(bad)).toBe("all");
  expect(FILTERS.map(filterLabel)).toEqual(["high only", "high and medium", "all"]);
  expect(checklistNote("all")).toBe("");
  expect(checklistNote("high")).toContain("every finding is listed here");
  expect(checklistNote("medium")).toContain("high and medium");
});
