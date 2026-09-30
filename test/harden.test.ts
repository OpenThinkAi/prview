import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean, isClean } from "../src/sanitize.ts";
import { argvOf, parseDocument, SCHEMA } from "../src/document.ts";
import { claudeArgs, complete } from "../src/llm.ts";

const tmp = mkdtempSync(join(tmpdir(), "prview-harden-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const A = "a".repeat(40), B = "b".repeat(40);

test("clean strips OSC, CSI, other ESC and C0/C1 controls; keeps text, newline, tab and unicode", () => {
  expect(clean("a\x1b]0;owned title\x07b")).toBe("ab");
  expect(clean("a\x1b]8;;http://evil\x1b\\link\x1b]8;;\x1b\\b")).toBe("alinkb");
  expect(clean("red \x1b[31;1mtext\x1b[0m \x1b[2J\x1b[Hgone")).toBe("red text gone");
  expect(clean("x\x9b31mred\x9d0;t\x9cy")).toBe("xredy");
  expect(clean("a\x1bPdcs payload\x1b\\b\x1b_apc\x1b\\c")).toBe("abc");
  expect(clean("a\x1bcb\x1b7c")).toBe("abc");
  expect(clean("a\x00b\x07c\x08d\re\x7ff\x85g")).toBe("abcdefg");
  expect(clean("line1\nline2\tx é 日本 🙂")).toBe("line1\nline2\tx é 日本 🙂");
  expect(clean("a\x1b]0;unterminated\nnext line stays")).toBe("a\nnext line stays");
  expect(isClean("plain")).toBe(true);
  expect(isClean("x\x1b[31m")).toBe(false);
});

test("a document is cleaned at the parse boundary: title, body, claims, comments, reasons, ids", () => {
  const ESC = "\x1b[31mBAD\x1b[0m\x1b]0;t\x07";
  const d = parseDocument({
    schema: SCHEMA, target: { base: A, head: B, title: `T${ESC}`, body: `B${ESC}`, repo: `r${ESC}`, label: `l${ESC}` },
    plan: { summary: `S${ESC}`, chapters: [{ title: `C${ESC}`, intent: `i${ESC}`, why: `w${ESC}`, hunks: [] }] },
    findings: [{ id: `f${ESC}`, hunk: "h", line: 1, claim: `claim${ESC}`, evidence: `e${ESC}`, title: `t${ESC}`, source: `s${ESC}` }],
    human: { comments: [{ text: `note${ESC}`, hunk: null }], visited: [], decisions: {} },
  });
  expect(JSON.stringify(d)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  expect(d.target.title).toBe("TBAD");
  expect(d.human.comments[0]!.text).toBe("noteBAD");
  expect(argvOf(["cat", "a\x1b[31mb"])).toBeNull();
});

test("claude -p gets the prompt on stdin and no PR text in argv (stub claude)", async () => {
  const bin = join(tmp, "bin"); (await import("node:fs")).mkdirSync(bin);
  const log = join(tmp, "call.json");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nstdin=$(cat)\nprintf '%s\\n' "$*" > ${log}.argv\nprintf '%s' "$stdin" > ${log}.stdin\nprintf '%s' '{"result":"ok\\u001b[31m!","total_cost_usd":0}'\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const secret = "PR-BODY-SECRET-TEXT do not leak";
    const out = await complete({ def: { name: "c", kind: "claude-cli", model: "m1" } } as any, "SYSTEM PROMPT", secret);
    expect(readFileSync(`${log}.argv`, "utf8")).not.toContain("PR-BODY-SECRET");
    expect(readFileSync(`${log}.argv`, "utf8")).toContain("SYSTEM PROMPT");
    expect(readFileSync(`${log}.stdin`, "utf8")).toBe(secret);
    expect(out).toBe("ok!"); // the model's reply is cleaned too
  } finally { process.env.PATH = path; }
  expect(claudeArgs(undefined, "s")).not.toContain("--model");
});
