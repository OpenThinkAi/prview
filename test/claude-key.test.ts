// AGT-1510: a claude-cli model with key_env / key_keychain bills that key. Every credential here is a fake string, every
// `claude` is a shell stub on PATH that records its env and argv, and the Keychain is a fake lookup: nothing reaches
// a network, a real claude, or the user's Keychain.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, resolveModel, resolveRoles, ROLES, type Lookups, type Resolved } from "../src/config.ts";
import { claudeEnv, credentialSetting, credentialSource, credentialVar, stripped } from "../src/claude-env.ts";
import { complete, probe } from "../src/llm.ts";
import { askAbout, claudeAgent, type AgentRun, type Runner } from "../src/deep.ts";
import { openSettings, settingsAct, describeField } from "../src/settings.ts";
import type { Review } from "../src/build.ts";

const OAT = "sk-ant-oat01-FAKE-OAUTH-TOKEN-for-tests";
const API = "sk-ant-api03-FAKE-API-KEY-for-tests";
/** What could outrank or redirect the configured key, set in the parent's env. */
const AMBIENT = {
  ANTHROPIC_API_KEY: "ambient-api", CLAUDE_CODE_OAUTH_TOKEN: "ambient-oat", ANTHROPIC_AUTH_TOKEN: "ambient-bearer",
  ANTHROPIC_BASE_URL: "https://proxy.invalid", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1",
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "1", ANTHROPIC_PROFILE: "work", ANTHROPIC_CUSTOM_HEADERS: "x: y", ANTHROPIC_FEDERATION_RULE_ID: "r",
  ANTHROPIC_ORGANIZATION_ID: "o", ANTHROPIC_VERTEX_PROJECT_ID: "p", AWS_BEARER_TOKEN_BEDROCK: "b",
};
const MUST_GO = Object.keys(AMBIENT);

let tmp = "", bin = "", savedPath: string | undefined;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "prview-claude-key-"));
  bin = join(tmp, "bin"); mkdirSync(bin);
  // The stub: its env (NUL-separated, so values may hold anything) and argv go to files; it answers as claude -p would,
  // as stream-json for the agent and as a version line for --version.
  writeFileSync(join(bin, "claude"), `#!/bin/sh
env -0 > "${tmp}/env"
printf '%s\\n' "$*" > "${tmp}/argv"
case "$1" in --version) echo "9.9.9 (stub)"; exit 0;; esac
cat > /dev/null
case "$*" in *stream-json*) printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"stub answer","total_cost_usd":0}';;
*) printf '%s' '{"result":"stub answer","total_cost_usd":0}';; esac
`);
  chmodSync(join(bin, "claude"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
});
afterAll(() => { process.env.PATH = savedPath; rmSync(tmp, { recursive: true, force: true }); });

/** The env the stub last ran with. */
function lastEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of readFileSync(join(tmp, "env"), "utf8").split("\0")) { const i = kv.indexOf("="); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1); }
  return out;
}

/** Run `f` with AMBIENT in process.env, then put process.env back as it was. */
async function withAmbient<T>(f: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(MUST_GO.map((k) => [k, process.env[k]]));
  Object.assign(process.env, AMBIENT);
  try { return await f(); } finally { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

/** Exactly one credential variable, holding `key`, and none of the stripped ones. */
function expectOnly(env: Record<string, string | undefined>, key: string) {
  const want = credentialVar(key);
  expect(env[want]).toBe(key);
  for (const k of MUST_GO) if (k !== want) expect(env[k], k).toBeUndefined();
}

const keyed = (key: string): Resolved => ({ def: { name: "claude", kind: "claude-cli", keyEnv: "PRVIEW_TEST_KEY" }, key });

// ---------------------------------------------------------------- config

test("config: a claude-cli model takes key_env or key_keychain; redefining the built-in claude covers every role", () => {
  expect(() => parseConfig(`[models.a]\nkind = "claude-cli"\nkey_env = "X"`)).not.toThrow();
  const cfg = parseConfig(`[models.claude]\nkind = "claude-cli"\nkey_keychain = "prview-anthropic"`);
  expect(Object.keys(cfg.models)).toEqual(["claude"]);
  const l: Lookups = { env: {}, keychain: (s) => (s === "prview-anthropic" ? ` ${OAT} ` : undefined) };
  const roles = resolveRoles(cfg, l);
  for (const r of ROLES) expect(roles[r].key, r).toBe(OAT);
  // A missing or empty credential fails before anything runs, naming where it looked, not a value.
  expect(() => resolveModel(cfg, "claude", { env: {}, keychain: () => "  " })).toThrow(/claude: no credential found in Keychain service prview-anthropic/);
  const both = parseConfig(`[models.claude]\nkind = "claude-cli"\nkey_env = "WORK_KEY"\nkey_keychain = "kc"`);
  expect(() => resolveModel(both, "claude", { env: { WORK_KEY: "" }, keychain: () => undefined })).toThrow(/\$WORK_KEY or Keychain service kc/);
  expect(resolveModel(both, "claude", { env: { WORK_KEY: API }, keychain: () => OAT }).key).toBe(API); // env first
  // No key named: your claude login, as before; an ambient key is never picked up.
  expect(resolveModel(parseConfig(""), "claude", { env: { ANTHROPIC_API_KEY: "ambient" }, keychain: () => "kc" }).key).toBeUndefined();
});

// ---------------------------------------------------------------- the env

test("claudeEnv: an OAuth token goes in CLAUDE_CODE_OAUTH_TOKEN, an API key (or anything else) in ANTHROPIC_API_KEY; rivals are stripped", () => {
  const base = { ...AMBIENT, PATH: "/bin", HOME: "/home/x", ANTHROPIC_MODEL: "opus", CLAUDE_CONFIG_DIR: "/c" };
  for (const key of [OAT, API, "some-other-shape"]) {
    const env = claudeEnv(keyed(key), base);
    expectOnly(env, key);
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/x", ANTHROPIC_MODEL: "opus", CLAUDE_CONFIG_DIR: "/c" }); // the rest is kept
  }
  expect(credentialVar(OAT)).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  expect(credentialVar(API)).toBe("ANTHROPIC_API_KEY");
  expect(credentialVar("weird")).toBe("ANTHROPIC_API_KEY");
  expect(base.ANTHROPIC_API_KEY).toBe("ambient-api"); // the parent's env is not touched
  // No key: the parent's env itself, unchanged. Another kind never gets one.
  expect(claudeEnv({ def: { name: "claude", kind: "claude-cli" } }, base)).toBe(base);
  expect(claudeEnv({ def: { name: "s", kind: "anthropic", model: "m" }, key: API }, base)).toBe(base);
  for (const k of ["ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_AWS_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN"]) expect(stripped(k), k).toBe(true);
  for (const k of ["PATH", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CONFIG_DIR"]) expect(stripped(k), k).toBe(false);
});

test("llm: claude -p for a keyed model runs with exactly that credential, for both token shapes, and the key is not in argv", async () => {
  for (const key of [OAT, API]) {
    const out = await withAmbient(() => complete(keyed(key), "SYS", "prompt"));
    expect(out).toBe("stub answer");
    expectOnly(lastEnv(), key);
    expect(readFileSync(join(tmp, "argv"), "utf8")).not.toContain(key);
  }
  // No key: process.env as it is (ambient variables included), as before.
  await withAmbient(() => complete({ def: { name: "claude", kind: "claude-cli" } }, "SYS", "prompt"));
  expect(lastEnv()).toMatchObject(AMBIENT);
});

test("prview models probe: claude --version runs with the keyed env too, and its answer holds no key", async () => {
  const got = await withAmbient(() => probe(keyed(OAT)));
  expect(got).toBe("ok (claude 9.9.9 (stub))");
  expectOnly(lastEnv(), OAT);
});

test("deep: the a ? agent's claude -p gets the keyed env (askAbout builds it, claudeAgent spawns with it)", async () => {
  const wt = join(tmp, "wt"); mkdirSync(wt, { recursive: true });
  const r: Review = {
    slug: "k", repo: wt, worktree: wt, context: 3, created: "now", pos: { item: 0, line: 0 },
    doc: { schema: "prview-review/1", target: { repo: wt, base: "a", head: "b", title: "t", body: "", label: "l" }, plan: { summary: "s", by: "guide", mechanical: [], chapters: [{ title: "c", intent: "i", why: "w", hunks: [] }] }, findings: [], human: { comments: [], visited: [] } },
  };
  const cfg = parseConfig(`[models.claude]\nkind = "claude-cli"\nkey_env = "WORK_KEY"`);
  const lookups: Lookups = { env: { WORK_KEY: API }, keychain: () => undefined };
  // With a stub runner: what it is handed.
  const runs: AgentRun[] = [];
  const runner: Runner = async (o) => { runs.push(o); return { text: "fine", steps: 0 }; };
  const turn = await withAmbient(() => askAbout(r, [], { kind: "chapter", chapter: 0 }, "q?", { cfg, lookups, runner }));
  expectOnly(runs[0]!.env!, API);
  expect(JSON.stringify(turn)).not.toContain(API);
  expect(JSON.stringify(r)).not.toContain(API); // asks and ai.runs: names only
  expect(r.ai?.runs?.[0]?.name).toBe("claude");
  // And the real runner, on the stub claude: the spawned process sees it.
  const res = await withAmbient(() => claudeAgent({ ...runs[0]!, onStep: () => {} }));
  expect(res.text).toBe("stub answer");
  expectOnly(lastEnv(), API);
  expect(readFileSync(join(tmp, "argv"), "utf8")).not.toContain(API);
  // No key: the agent is handed process.env itself.
  runs.length = 0;
  await askAbout(r, [], { kind: "chapter", chapter: 0 }, "q?", { cfg: parseConfig(""), lookups, runner });
  expect(runs[0]!.env).toBe(process.env);
});

// ---------------------------------------------------------------- where it shows

test("prview models and the settings view name the credential's source, never its value", async () => {
  expect(credentialSource({ name: "claude", kind: "claude-cli" })).toBe("your claude login");
  expect(credentialSource({ name: "claude", kind: "claude-cli", keyKeychain: "prview-anthropic" })).toBe("key from keychain prview-anthropic");
  expect(credentialSource({ name: "claude", kind: "claude-cli", keyEnv: "WORK_KEY", keyKeychain: "kc" })).toBe("key from env WORK_KEY, else keychain kc");
  expect(credentialSetting({ name: "claude", kind: "claude-cli", keyKeychain: "prview-anthropic" })).toBe('key_keychain = "prview-anthropic"');
  expect(credentialSetting({ name: "claude", kind: "claude-cli", keyEnv: "WORK_KEY" })).toBe('key_env = "WORK_KEY"');
  expect(credentialSetting({ name: "claude", kind: "claude-cli" })).toBe("your claude login");

  const s = openSettings(parseConfig(`[models.claude]\nkind = "claude-cli"\nkey_keychain = "prview-anthropic"\n[models.q]\nkind = "openai-compatible"\nendpoint = "http://localhost:1"`), join(tmp, "c.toml"));
  const at = s.fields.findIndex((f) => f.kind === "model" && f.name === "claude");
  expect(describeField(s, s.fields[at]!).value).toBe('claude-cli · key_keychain = "prview-anthropic"');
  expect(describeField(s, s.fields.find((f) => f.kind === "model" && f.name === "q")!).value).toBe("openai-compatible · no key");
  const after = settingsAct({ ...s, cursor: at }, "settings.edit").s;
  expect(after.values).toEqual(s.values); // read-only
  expect(after.message?.text).toContain("edit [models.claude]");

  // `prview models`, end to end on the stub claude: the source by name, and the key nowhere in the output.
  const cfgFile = join(tmp, "models.toml");
  writeFileSync(cfgFile, `[models.claude]\nkind = "claude-cli"\nkey_env = "WORK_KEY"\n`);
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.tsx"), "models"], { env: { ...process.env, PRVIEW_CONFIG: cfgFile, PRVIEW_HOME: tmp, WORK_KEY: OAT }, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString() + p.stderr.toString();
  expect(out).toMatch(/claude\tclaude-cli\t-\t-\tkey from env WORK_KEY\tok \(claude 9\.9\.9/);
  expect(out).not.toContain(OAT);
  expectOnly(lastEnv(), OAT);
});
