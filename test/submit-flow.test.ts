// The submit flow without a screen: the checklist's ticks, the verdict the ticks imply, the steps, the comment box,
// and how a selection becomes the reader's layer (what the document records and what posts).

import { expect, test } from "bun:test";
import type { Finding } from "../src/guide.ts";
import type { Human, Verdict } from "../src/document.ts";
import { decide, linkedComment } from "../src/triage.ts";
import {
  applySelection, backspace, clearLine, deleteWord, generalText, impliedVerdict, move, newline, nextStep, prevStep, selectionOf,
  startFlow, stepLines, toggle, toggleAll, typeText, type Flow, type Show,
} from "../src/submit-flow.ts";

const F = (id: string, over: Partial<Finding> = {}): Finding => ({ id, source: "critic", hunk: "src/a.rs@10", side: "new", line: 11, severity: "medium", kind: "bug", title: `Title ${id}`, claim: `claim ${id}`, evidence: "", status: "upheld", ...over });
const high = F("h", { severity: "high" }), med = F("m"), low = F("l", { severity: "low" }), dropped = F("d", { status: "withdrawn" });
const all = [high, med, low, dropped];
const empty = (): Human => ({ comments: [], visited: [] });
const GH: Verdict[] = ["approve", "request_changes", "comment"];

test("the checklist ticks block and comment, not ignore; a draft's findings, verdict and comment win", () => {
  const fl = startFlow(all, empty(), GH);
  expect(fl).toMatchObject({ step: "findings", listed: ["h", "m", "l", "d"], ticked: ["h", "m", "l"], at: 0, picked: false, comment: "", hook: false, coverage: false });
  expect(fl.verdict).toBeUndefined();
  // A finding you ignored is unticked; one you moved to comment is ticked.
  const h = decide(decide(empty(), high, "ignore", { at: "" }), dropped, "comment", { text: "worth it", at: "" });
  expect(startFlow(all, h, GH).ticked).toEqual(["m", "l", "d"]);
  const drafted = startFlow(all, empty(), GH, undefined, { include: ["d", "nope"], verdict: "approve", comment: "drafted" });
  expect(drafted).toMatchObject({ ticked: ["d"], verdict: "approve", picked: true, comment: "drafted" });
  // A verdict the platform does not take is no verdict.
  expect(startFlow(all, empty(), ["comment"], undefined, { verdict: "approve" }).verdict).toBeUndefined();
});

test("the comment box starts from the summary comments already there (the old N)", () => {
  const h: Human = { ...empty(), comments: [{ hunk: null, side: "new", line: null, text: "one", at: "" }, { hunk: "x", side: "new", line: 1, text: "line", at: "" }, { hunk: null, side: "new", line: null, text: "two", at: "" }] };
  expect(generalText(h)).toBe("one\n\ntwo");
  expect(startFlow([], h, GH).comment).toBe("one\n\ntwo");
});

test("the implied verdict: any ticked block → request changes; else anything ticked → comment; nothing → none", () => {
  expect(impliedVerdict(all, empty(), ["h", "m"])).toBe("request_changes");
  expect(impliedVerdict(all, empty(), ["m", "l"])).toBe("comment");
  expect(impliedVerdict(all, empty(), ["d"])).toBe("comment"); // an ignore ticked back in goes as a comment
  expect(impliedVerdict(all, empty(), [])).toBeUndefined();
  expect(impliedVerdict(all, decide(empty(), med, "block", { text: "x", at: "" }), ["m"])).toBe("request_changes");
});

test("Tab and shift-Tab move through the steps; the verdict starts implied until one is picked; the comment box types on entry", () => {
  let fl = startFlow(all, empty(), GH);
  fl = nextStep(fl, all, empty());
  expect(fl).toMatchObject({ step: "verdict", verdict: "request_changes", picked: false });
  fl = prevStep(fl, all, empty());
  fl = toggle(fl); // untick the high one
  fl = nextStep(fl, all, empty());
  expect(fl.verdict).toBe("comment");
  fl = move(fl, -1); // the reader picks: request changes (above comment)
  expect(fl).toMatchObject({ verdict: "request_changes", picked: true });
  fl = nextStep(prevStep(fl, all, empty()), all, empty());
  expect(fl.verdict).toBe("request_changes"); // picked stays
  fl = nextStep(fl, all, empty());
  expect(fl).toMatchObject({ step: "comment", typing: true });
  fl = nextStep(fl, all, empty());
  expect(fl).toMatchObject({ step: "send", typing: false });
  expect(nextStep(fl, all, empty())).toBe(fl); // the last step
  expect(prevStep(startFlow(all, empty(), GH), all, empty()).step).toBe("findings"); // and the first
  // Nothing ticked: no selection until the radio moves; ↓ takes the first, ↑ the last, and it stops at the ends.
  let none = nextStep(toggleAll(toggleAll(startFlow(all, empty(), GH))), all, empty());
  expect(none.verdict).toBeUndefined();
  expect(move(none, 1).verdict).toBe("approve");
  expect(move(none, -1).verdict).toBe("comment");
  none = move(move(move(move(none, 1), 1), 1), 1);
  expect(none.verdict).toBe("comment");
});

test("the checklist's cursor, Space and a; the send step's checkboxes", () => {
  let fl = startFlow(all, empty(), GH);
  fl = move(move(move(move(move(fl, 1), 1), 1), 1), 1);
  expect(fl.at).toBe(3);
  fl = toggle(fl);
  expect(fl.ticked).toEqual(["h", "m", "l", "d"]);
  expect(toggleAll(fl).ticked).toEqual([]);
  expect(toggleAll(toggleAll(fl)).ticked).toEqual(["h", "m", "l", "d"]);
  expect(toggle(move(fl, -1)).ticked).toEqual(["h", "m", "d"]); // order stays the listing's
  const send: Flow = { ...fl, step: "send" };
  expect(toggle(send, ["hook", "coverage"])).toMatchObject({ hook: true, coverage: false });
  expect(toggle(move(send, 1, ["hook", "coverage"]), ["hook", "coverage"])).toMatchObject({ hook: false, coverage: true });
  expect(toggle(send, ["coverage"])).toMatchObject({ hook: false, coverage: true });
  expect(toggle(send, [])).toBe(send);
});

test("the comment box: text, new lines, backspace, clear the line, delete a word", () => {
  let fl: Flow = { ...startFlow([], empty(), GH), step: "comment", typing: true };
  fl = typeText(newline(typeText(fl, "First line.")), "second  words here");
  expect(fl.comment).toBe("First line.\nsecond  words here");
  expect(deleteWord(fl).comment).toBe("First line.\nsecond  words");
  expect(deleteWord(deleteWord(deleteWord(fl))).comment).toBe("First line.\n");
  expect(clearLine(fl).comment).toBe("First line.\n");
  expect(backspace(fl).comment).toBe("First line.\nsecond  words her");
});

test("a selection applied: ticked defaults get the finding's text, yours stays, unticked goes to ignore, hidden ones are untouched", () => {
  const mine = F("x", { severity: "high" }), hidden = F("z", { severity: "high" });
  let h: Human = { ...empty(), comments: [{ hunk: null, side: "new", line: null, text: "old summary", at: "" }] };
  h = decide(h, mine, "block", { text: "my own words", at: "" });
  h = decide(h, med, "comment", { text: "unticked words", at: "" });
  const findings = [high, med, low, dropped, mine, hidden];
  const out = applySelection(h, findings, { listed: ["h", "m", "l", "d", "x"], include: ["h", "l", "d", "x"], comment: "  New top-level.\nTwo lines.  ", verdict: "request_changes" }, undefined, "T");
  expect(out.verdict).toBe("request_changes");
  expect(out.comments.filter((c) => !c.hunk).map((c) => c.text)).toEqual(["New top-level.\nTwo lines."]); // replaces the summary comments
  expect(out.decisions!.h).toMatchObject({ kind: "block" }); // default block, ticked: the finding's text posts as a block
  expect(linkedComment(out, "h")!.text).toBe("claim h");
  expect(out.decisions!.l).toMatchObject({ kind: "comment" });
  expect(linkedComment(out, "l")!.text).toBe("claim l");
  expect(out.decisions!.d).toMatchObject({ kind: "comment" }); // an ignore ticked in posts as a comment
  expect(linkedComment(out, "d")!.text).toBe("claim d");
  expect(linkedComment(out, "x")!.text).toBe("my own words"); // yours, untouched
  expect(out.decisions!.m).toEqual({ kind: "ignore" }); // unticked: ignore, its comment gone
  expect(out.comments.some((c) => c.text === "unticked words")).toBe(false);
  expect(out.decisions!.z).toBeUndefined(); // not listed (a blind chapter): left alone
  // Never the finding's source or anything of tooling in the comments that will post.
  expect(JSON.stringify(out.comments)).not.toMatch(/critic|prview/);
  // A blank comment means no top-level comment at all; no verdict leaves none.
  const bare = applySelection(h, findings, { listed: [], include: [], comment: " \n " }, undefined, "T");
  expect(bare.comments.filter((c) => !c.hunk)).toEqual([]);
  expect(bare.verdict).toBeUndefined();
  // Applying the same selection again changes nothing more.
  const again = applySelection(out, findings, { listed: ["h", "m", "l", "d", "x"], include: ["h", "l", "d", "x"], comment: "New top-level.\nTwo lines.", verdict: "request_changes" }, undefined, "T");
  expect(again.comments).toEqual(out.comments);
  expect(again.decisions).toEqual(out.decisions);
});

test("what the steps show", () => {
  const show: Show = { findings: all, h: empty(), place: (f) => `src/a.rs:${f.line}`, label: (v) => v, keys: { tick: "Space", all: "a", editor: "v e", next: "Tab", back: "⇧Tab" }, suggested: "suggested, information only: prview comment" };
  let fl = startFlow(all, empty(), GH);
  const one = stepLines(fl, show).map((l) => l.text);
  expect(one).toContain("[x] high · block (default) · src/a.rs:11 · Title h");
  expect(one).toContain("[ ] medium · ignore (default) · src/a.rs:11 · Title d");
  expect(stepLines(fl, show).find((l) => l.cursor)!.text).toContain("Title h");
  expect(stepLines(fl, { ...show, hidden: true }).at(-1)!.text).toContain("still hide their findings");
  fl = nextStep(fl, all, empty());
  const two = stepLines(fl, show).map((l) => l.text);
  expect(two.slice(0, 3)).toEqual(["( ) approve", "(•) request_changes", "( ) comment"]);
  expect(two).toContain("What you ticked implies request_changes.");
  expect(two).toContain("suggested, information only: prview comment");
  fl = typeText(newline(typeText(nextStep(fl, all, empty()), "a")), "b");
  expect(stepLines(fl, show).map((l) => l.text).slice(1)).toEqual(["│ a", "│ b"]);
  fl = nextStep(fl, all, empty());
  const four = stepLines(fl, { ...show, boxes: [{ box: "hook", text: "Run it" }], preview: "── What posts\nVerdict: x" });
  expect(four.map((l) => l.text)).toEqual(["[ ] Run it", "", "── What posts", "Verdict: x"]);
  expect(four[2]!.head).toBe(true);
  expect(stepLines({ ...fl, verdict: undefined }, show)[0]!.text).toBe("Pick a verdict first: ⇧Tab goes back to it.");
  expect(selectionOf(fl)).toEqual({ listed: ["h", "m", "l", "d"], include: ["h", "m", "l"], comment: "a\nb", verdict: "request_changes" });
});
