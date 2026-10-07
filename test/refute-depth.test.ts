import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/diff.ts";
import { CRITIC_SYSTEM, GUIDE_SYSTEM, REFUTE_SYSTEM, type Finding } from "../src/guide.ts";
import { applyAgentRefute, REFUTE_AGENT_SYSTEM, type AgentRun, type Runner } from "../src/deep.ts";
import { DEEP_LIMITS, type RefuteDepth, type Resolved } from "../src/config.ts";
import type { Target } from "../src/document.ts";

// The refute depth (`refute = "..."`, `--refute`): off skips the second look, quick is the one call it always was,
// deep and thorough send what the quick look kept to the agent. The models and the agent are stubs.

const tmp = mkdtempSync(join(tmpdir(), "prview-refute-"));
process.env.PRVIEW_HOME = join(tmp, "store");
const { guideAndCritic, preparedBy } = await import("../src/build.ts");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const DIFF = `diff --git a/src/handler.ts b/src/handler.ts
index 1..2 100644
--- a/src/handler.ts
+++ b/src/handler.ts
@@ -1,3 +1,5 @@
 export function handle(req: Req) {
-  return ok();
+  const id = req.query.id;
+  log(id);
+  return ok();
 }
`;
const FILE = `export function handle(req: Req) {\n  const id = req.query.id;\n  log(id);\n  return ok();\n}\n`;
const files = parseDiff(DIFF);
const target: Target = { repo: "demo", base: "a", head: "b", label: "main..handler", title: "Log the id", body: "" };

/** Guide: one chapter. Critic: a high finding on line 2 and a low one on line 3. Refute (quick): upholds both, citing a shown line. */
function stub() {
  const systems: string[] = [];
  const call = async (_m: Resolved, system: string, prompt: string) => {
    systems.push(system);
    const ids = [...prompt.matchAll(/^id: (\S+)$/gm)].map((m) => m[1]!);
    if (system === GUIDE_SYSTEM) return JSON.stringify({ summary: "Logs the id.", chapters: [{ title: "Handler", check: "The id is validated", why: "Input.", hunks: ids }] });
    if (system === CRITIC_SYSTEM) return JSON.stringify([
      { hunk: ids[0], side: "new", line: 2, severity: "high", kind: "bug", title: "id is never validated", claim: "req.query.id is used unchecked.", evidence: "No check here." },
      { hunk: ids[0], side: "new", line: 3, severity: "low", kind: "style", title: "log call is noisy", claim: "Logging every id is noisy.", evidence: "One line per request." },
    ]);
    if (system === REFUTE_SYSTEM) return JSON.stringify({ verdict: "uphold", reason: "Nothing nearby checks it.", lines: ["n2"] });
    throw new Error(`unexpected system prompt: ${system.slice(0, 40)}`);
  };
  return { call, systems };
}

/** An agent that answers every finding with `reply`, recording what it was asked. */
function agent(reply: (prompt: string) => string) {
  const runs: AgentRun[] = [];
  const runner: Runner = async (o) => { runs.push(o); return { text: reply(o.prompt), steps: 3, model: "claude-stub-1" }; };
  return { runner, runs };
}

const cli: Resolved = { def: { name: "stub", kind: "claude-cli", model: "stub-model" } };
const api: Resolved = { def: { name: "api", kind: "anthropic", model: "claude-x" } };
function worktree(): string {
  const dir = mkdtempSync(join(tmp, "wt-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/handler.ts"), FILE);
  writeFileSync(join(dir, "src/router.ts"), `import { handle } from "./handler";\n// every route validates req.query.id first\nexport const route = validated(handle);\n`);
  return dir;
}
const WITHDRAW = JSON.stringify({ verdict: "withdraw", reason: "The router validates the id before handle runs.", cites: ["src/router.ts:3"] });

async function run(depth: RefuteDepth, reply: (p: string) => string = () => WITHDRAW, refuteModel: Resolved = cli) {
  const { call, systems } = stub(), a = agent(reply), said: string[] = [];
  const out = await guideAndCritic(target, files, worktree(), { guide: cli, critic: cli, refute: refuteModel }, 1, (s) => said.push(s), call, { depth, limits: DEEP_LIMITS, runner: a.runner });
  const by = (line: number) => out.doc.findings.find((f) => f.line === line)!;
  return { ...out, systems, runs: a.runs, said, high: by(2), low: by(3) };
}

test("off: no second look at all; findings stay unrefuted and nothing reads the code", async () => {
  const r = await run("off");
  expect(r.systems).not.toContain(REFUTE_SYSTEM);
  expect(r.runs).toEqual([]);
  expect([r.high.status, r.low.status]).toEqual(["unrefuted", "unrefuted"]);
  expect(r.said).toContain("refute: off (no second look)");
});

test("quick: the one call for medium and high findings, as before; the agent is never run", async () => {
  const r = await run("quick");
  expect(r.systems.filter((s) => s === REFUTE_SYSTEM)).toHaveLength(1);
  expect(r.runs).toEqual([]);
  expect(r.high.status).toBe("upheld");
  expect(r.low.status).toBe("unrefuted");
});

test("deep: a high finding the quick look kept goes to the agent, which withdraws it with a citation from another file", async () => {
  const r = await run("deep");
  expect(r.runs).toHaveLength(1);
  expect(r.runs[0]!.system).toBe(REFUTE_AGENT_SYSTEM);
  expect(r.runs[0]!.prompt).toContain("claim: req.query.id is used unchecked.");
  expect(r.runs[0]!.prompt).toContain("second look: Nothing nearby checks it. (cites n2)"); // the quick look's reason goes with it
  expect(r.high.status).toBe("withdrawn");
  expect(r.high.refute).toBe("The router validates the id before handle runs. (read the code; cites src/router.ts:3)");
  expect(r.low.status).toBe("unrefuted"); // deep leaves low findings alone
  expect(r.runs.filter((x) => x.model === "stub-model")).toHaveLength(1);
  expect(r.said.some((s) => /reading the code for 1 finding \(deep\)/.test(s))).toBe(true);
  expect(r.said.some((s) => /the deeper look dropped 1 of 1/.test(s))).toBe(true);
  expect(r.errors).toEqual([]);
});

test("thorough: every finding still standing goes to the agent, low ones included", async () => {
  const r = await run("thorough", (p) => p.includes("Logging every id is noisy.") ? JSON.stringify({ verdict: "uphold", reason: "It does log every request.", cites: ["src/handler.ts:3"] }) : WITHDRAW);
  expect(r.runs).toHaveLength(2);
  expect(r.high.status).toBe("withdrawn");
  expect(r.low.status).toBe("upheld");
  expect(r.low.refute).toBe("It does log every request. (read the code; cites src/handler.ts:3)");
  // Each agent run is recorded for the refute role.
  expect(r.runs.length).toBe(2);
});

test("deep: a withdrawal citing a line that is not in the worktree leaves the finding standing", async () => {
  const r = await run("deep", () => JSON.stringify({ verdict: "withdraw", reason: "Validated upstream.", cites: ["src/nope.ts:1", "src/router.ts:99"] }));
  expect(r.high.status).toBe("upheld");
  expect(r.high.refute).toBe("The deeper look's withdrawal cited no line in the repository, so the finding stands. Validated upstream.");
});

test("deep: a refute model that is not claude-cli cannot read the code; the quick look stands and the review says why", async () => {
  const r = await run("deep", () => WITHDRAW, api);
  expect(r.runs).toEqual([]);
  expect(r.high.status).toBe("upheld");
  expect(r.errors).toEqual(["refute: deep reads the code with an agent, which needs a claude-cli refute model; api is anthropic, so the quick look stood"]);
});

test("the agent's verdict: the last JSON line wins, prose before it is fine; a downgrade lowers one step", () => {
  const f: Finding = { id: "f1", source: "critic", hunk: "h", side: "new", line: 2, severity: "high", kind: "bug", claim: "c", evidence: "e", status: "upheld" };
  const ok = (c: string) => c === "src/a.ts:10";
  const reply = `I opened src/a.ts and the check is there {not json}.\n${JSON.stringify({ verdict: "downgrade", reason: "Only on an admin path.", cites: ["src/a.ts:10"] })}`;
  expect(applyAgentRefute(f, reply, ok)).toMatchObject({ status: "upheld", severity: "medium", refute: "Only on an admin path. (read the code; cites src/a.ts:10)" });
  expect(applyAgentRefute(f, "I ran out of steps", ok, "steps")).toMatchObject({ status: "upheld", severity: "high", refute: "The deeper look stopped at the step cap before it settled, so the finding stands." });
});

test("preparedBy names a depth other than quick", () => {
  const runs = [{ role: "guide" as const, model: "m", ms: 1 }, { role: "refute" as const, model: "m", ms: 1 }];
  expect(preparedBy(runs, "deep")).toBe("Prepared by m (guide, refute) · refute deep");
  expect(preparedBy(runs, "quick")).toBe("Prepared by m (guide, refute)");
  expect(preparedBy(runs)).toBe("Prepared by m (guide, refute)");
});
