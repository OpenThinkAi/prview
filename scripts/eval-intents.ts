#!/usr/bin/env bun
// Runs the guide on a handful of real merged changes and holds every chapter intent to the rubric
// (src/guide.ts `rubric`): at most 12 words, names a concrete thing, no "verify that", not the title
// again. It is the check behind any change to GUIDE_SYSTEM or the limits: run it before and after.
//
//   bun scripts/eval-intents.ts                       the five default merges below, with claude
//   bun scripts/eval-intents.ts --ai NAME             another model from your config (prview models)
//   bun scripts/eval-intents.ts ~/src/x@abc123 ...    your own: DIR@MERGE (its two parents) or DIR@BASE..HEAD
//
// It calls the model for real (one guide call per change, one more when a line had to be cut), so
// it costs what a `prview prepare` of each change costs. Exit 0 when at least 90% of intents pass.

import { homedir } from "node:os";
import { join } from "node:path";
import { runGuide } from "../src/build.ts";
import { parseDiff } from "../src/diff.ts";
import { classify, hunksOf, MECHANICAL_INTENT, rubric, twoSentences } from "../src/guide.ts";
import { loadConfig, realLookups, resolveModel } from "../src/config.ts";
import { pool } from "../src/llm.ts";

// Recent merges across three repos of different shapes (a Rust CLI, a TypeScript CLI, a web app).
// Pinned so two runs read the same diffs; they live on the author's machine, so pass your own elsewhere.
const dev = join(homedir(), "Development");
const DEFAULTS = [
  `${dev}/pm@40f63a5`,        // hub login/status/logout
  `${dev}/pm@66f6976`,        // project doc identity travels in ops
  `${dev}/stamp-cli@fcd9f28`, // per-provider API keys
  `${dev}/stamp-cli@c783ec2`, // verdict provenance
  `${dev}/bloom@c07363f`,     // write verb dry-run summary
];
const PASS_RATE = 0.9;

const argv = process.argv.slice(2);
let name = "claude"; // the built-in claude -p model unless --ai names one from the config
const specs: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--ai") {
    const n = argv[++i];
    if (!n) { console.error("--ai takes a model name from your config"); process.exit(2); }
    name = n;
  } else specs.push(argv[i]!);
}

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** What prview itself would read for this range: the head's subject as title, the commits as body. */
function load(spec: string) {
  const at = spec.lastIndexOf("@");
  if (at < 0) throw new Error(`${spec}: expected DIR@MERGE or DIR@BASE..HEAD`);
  const dir = spec.slice(0, at), rev = spec.slice(at + 1);
  const [base, head] = rev.includes("..") ? rev.split(/\.{2,3}/) as [string, string] : [`${rev}^1`, `${rev}^2`];
  const headSha = git(["rev-parse", "--verify", `${head}^{commit}`], dir);
  const baseSha = git(["merge-base", base, headSha], dir);
  const files = parseDiff(git(["diff", "-M", "--no-color", "--no-ext-diff", "-U3", baseSha, headSha], dir) + "\n");
  return {
    label: `${dir.split("/").pop()}@${rev}`, files,
    title: git(["log", "-1", "--format=%s", headSha], dir),
    body: git(["log", "--reverse", "--format=%s%n%n%b", `${baseSha}..${headSha}`], dir),
  };
}

let model;
try { model = resolveModel(loadConfig(), name, realLookups()); } catch (e) { console.error((e as Error).message); process.exit(2); }
const srcs = (specs.length ? specs : DEFAULTS).map(load);
console.log(`guide: ${name} · ${srcs.length} changes, in parallel…\n`);
const runs = await pool(srcs.map((src) => async () => {
  const hunks = hunksOf(src.files), mechanical = classify(src.files);
  return runGuide(model, src, hunks, mechanical);
}), srcs.length);

let total = 0, passed = 0, failedRuns = 0;
runs.forEach((run, i) => {
  const src = srcs[i]!;
  console.log(`## ${src.label} · ${src.title}`);
  if (run instanceof Error) { failedRuns++; console.log(`   guide failed: ${run.message}\n`); return; }
  const summary = twoSentences(run.plan.summary);
  console.log(`   summary: ${run.plan.summary}${summary.cut ? "  [over two sentences]" : ""}`);
  if (run.reasked) console.log(`   re-asked for ${run.reasked} cut line${run.reasked === 1 ? "" : "s"}`);
  for (const e of run.errors) console.log(`   warning: ${e}`);
  for (const c of run.plan.chapters) {
    const fails = rubric(c.intent, src.title);
    total++; if (!fails.length) passed++;
    console.log(`   ${fails.length ? "FAIL" : "pass"}  ${c.title}`);
    console.log(`         intent: ${c.intent}${fails.length ? `  [${fails.join("; ")}]` : ""}`);
    console.log(`         why:    ${c.why}`);
  }
  if (run.plan.mechanical.length) console.log(`   (mechanical, ${run.plan.mechanical.length}: fixed intent "${MECHANICAL_INTENT}")`);
  console.log("");
});

const rate = total ? passed / total : 0;
console.log(`${passed}/${total} intents pass the rubric (${Math.round(rate * 100)}%, target ${PASS_RATE * 100}%)${failedRuns ? ` · ${failedRuns} guide call${failedRuns === 1 ? "" : "s"} failed` : ""}`);
process.exit(rate >= PASS_RATE && !failedRuns ? 0 : 1);
