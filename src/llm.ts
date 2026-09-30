// One-shot model calls for prview. No streaming, no chat: each role asks once and parses JSON.
//
// Providers mirror hxq's (the same box, the same servers): claude (claude -p on the subscription, the default: the best reader we
// have), qwen and gemma (local OpenAI-compatible servers), deepseek (API, key from the Keychain).

import { tmpdir } from "node:os";

export type Provider = "claude" | "qwen" | "gemma" | "deepseek";
export const PROVIDERS: Provider[] = ["claude", "qwen", "gemma", "deepseek"];

const env = (k: string, d: string) => process.env[k] ?? d;
const LOCAL: Record<"qwen" | "gemma", { url: string; model: string }> = {
  // Same pins as chat.ts: :8000 serves whichever id you ask for, and asking for another one swaps the production model out.
  qwen: { url: env("HXQ_QWEN_URL", "http://localhost:8000/v1"), model: env("HXQ_QWEN_MODEL", "mlx-community/Qwen3.8-27B-4bit") },
  gemma: { url: env("HXQ_GEMMA_URL", "http://localhost:8002/v1"), model: env("HXQ_GEMMA_MODEL", "") },
};

function deepseekKey(): string {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const r = Bun.spawnSync(["security", "find-generic-password", "-a", process.env.USER ?? "", "-s", "DEEPSEEK_API_KEY", "-w"]);
  const key = r.stdout.toString().trim();
  if (!key) throw new Error("no DEEPSEEK_API_KEY in the environment or Keychain");
  return key;
}

async function firstModel(url: string, pick: RegExp): Promise<string> {
  const r = await fetch(`${url}/models`, { signal: AbortSignal.timeout(3000) }).catch(() => { throw new Error(`no model server at ${url}`); });
  const ids = ((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id);
  const id = ids.find((i) => pick.test(i)) ?? ids[0];
  if (!id) throw new Error(`no models listed at ${url}`);
  return id;
}

async function openai(url: string, key: string | undefined, model: string, system: string, prompt: string): Promise<string> {
  const r = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], temperature: 0.2, max_tokens: 4000, stream: false }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!r.ok) throw new Error(`${url} returned ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  const c = j.choices?.[0];
  if (!c?.message?.content) throw new Error(`${url} returned no content`);
  if (c.finish_reason === "length") throw new Error("the model ran out of tokens before finishing");
  return c.message.content.replace(/<think>[\s\S]*?<\/think>/g, "");
}

export type Usage = { ms: number; cost?: number };

async function claude(system: string, prompt: string, cost: (usd: number) => void): Promise<string> {
  // Not --bare (that skips the subscription login). Tools, MCP and skills off, neutral cwd so no CLAUDE.md loads.
  const args = ["claude", "-p", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--system-prompt", system];
  if (process.env.HXQ_CLAUDE_MODEL) args.push("--model", process.env.HXQ_CLAUDE_MODEL);
  args.push(prompt);
  const p = Bun.spawn(args, { stdin: "ignore", cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
  const [raw, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  let j: any;
  try { j = JSON.parse(raw); } catch { throw new Error(`claude -p returned no JSON: ${(raw || err).slice(0, 300)}`); }
  if (j.is_error) throw new Error(`claude: ${j.result}`);
  if (typeof j.total_cost_usd === "number") cost(j.total_cost_usd);
  return String(j.result ?? "");
}

/** `usage` hears about each call that finishes: how long it took, and what it cost where the provider says. */
export async function complete(provider: Provider, system: string, prompt: string, usage?: (u: Usage) => void): Promise<string> {
  const t0 = Date.now();
  let cost: number | undefined;
  const text = await route(provider, system, prompt, (usd) => { cost = usd; });
  usage?.({ ms: Date.now() - t0, cost });
  return text;
}

async function route(provider: Provider, system: string, prompt: string, setCost: (usd: number) => void): Promise<string> {
  switch (provider) {
    case "claude": return claude(system, prompt, setCost);
    case "deepseek": return openai("https://api.deepseek.com/v1", deepseekKey(), env("HXQ_DEEPSEEK_MODEL", "deepseek-v4-pro"), system, prompt);
    case "qwen": return openai(LOCAL.qwen.url, undefined, LOCAL.qwen.model, system, prompt);
    case "gemma": return openai(LOCAL.gemma.url, undefined, LOCAL.gemma.model || await firstModel(LOCAL.gemma.url, /gemma/i), system, prompt);
  }
}

/** Run jobs a few at a time; a failure becomes an Error result, never a rejection, so one bad call can't sink the review. */
export async function pool<T>(jobs: (() => Promise<T>)[], width = 4): Promise<(T | Error)[]> {
  const out: (T | Error)[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => { for (let i = next++; i < jobs.length; i = next++) out[i] = await jobs[i]!().catch((e) => e instanceof Error ? e : new Error(String(e))); };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker));
  return out;
}
