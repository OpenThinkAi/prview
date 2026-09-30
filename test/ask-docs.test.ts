import { afterEach, expect, test } from "bun:test";
import { answersBody, answersFor, answerText, ANSWERS } from "../src/ask-docs.ts";
import { DEFAULT_KEYMAP, effectiveKeys, installKeymap } from "../src/keys.ts";

afterEach(() => installKeymap(DEFAULT_KEYMAP));

test("a question finds the action, its key, where it works and the why", () => {
  const a = answersFor("mark this finding as wrong");
  expect(a.length).toBeGreaterThanOrEqual(3);
  expect(a.length).toBeLessThanOrEqual(5);
  expect(a.length).toBeLessThanOrEqual(ANSWERS);
  expect(a[0]).toMatchObject({ id: "finding.not_an_issue", label: "not an issue", key: "n", state: "in a finding's box" });
  expect(a[0]!.why).not.toBe("");
});

test("keys are read at display time: a remap and an unbind show", () => {
  installKeymap(effectiveKeys({ "finding.not_an_issue": "d" }));
  expect(answersFor("mark this finding as wrong")[0]!.key).toBe("d");
  installKeymap(effectiveKeys({ "finding.not_an_issue": "" }));
  expect(answersFor("mark this finding as wrong")[0]!.key).toBe("(unbound)");
});

test("the docs are found by asking for them", () => {
  expect(answersFor("search the docs for a shortcut").map((a) => a.id)).toContain("nav.ask_docs");
});

test("no words, no answers; the text forms", () => {
  expect(answersFor("   ")).toEqual([]);
  const a = answersFor("copy a finding");
  expect(answerText(a[0]!)).toBe(`${a[0]!.label}: ${a[0]!.key}, ${a[0]!.state}\n${a[0]!.why}`);
  expect(answersBody(a, 1).split("\n\n")[1]).toMatch(/^› 2\. /);
  expect(answersBody([], 0)).toContain("Nothing matched");
});
