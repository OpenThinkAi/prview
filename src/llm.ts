// One-shot model calls for prview. No streaming, no chat: each role asks once and parses JSON.
//
// What a model is (claude -p, the Anthropic API, any OpenAI-compatible server) comes from the config; nothing here names a
// provider or a role.

import { tmpdir } from "node:os";
import type { Resolved } from "./config.ts";

async function firstModel(url: string, key: string | undefined): Promise<string> {
  const r = await fetch(`${url}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(3000) }).catch(() => { throw new Error(`no model server at ${url}`); });
  const ids = ((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id);
  if (!ids[0]) throw new Error(`no models listed at ${url}`);
  return ids[0];
}

async function openai(url: string, key: string | undefined, model: string | undefined, system: string, prompt: string): Promise<string> {
  // A config that gives no model id gets whatever the server lists first: right for a one-model local server.
  model ??= await firstModel(url, key);
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

async function claude(model: string | undefined, system: string, prompt: string, cost: (usd: number) => void): Promise<string> {
  // Not --bare (that skips the subscription login). Tools, MCP and skills off, neutral cwd so no CLAUDE.md loads.
  const args = ["claude", "-p", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--system-prompt", system];
  if (model) args.push("--model", model);
  args.push(prompt);
  const p = Bun.spawn(args, { stdin: "ignore", cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
  const [raw, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  let j: any;
  try { j = JSON.parse(raw); } catch { throw new Error(`claude -p returned no JSON: ${(raw || err).slice(0, 300)}`); }
  if (j.is_error) throw new Error(`claude: ${j.result}`);
  if (typeof j.total_cost_usd === "number") cost(j.total_cost_usd);
  return String(j.result ?? "");
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

async function anthropic(base: string, key: string, model: string, system: string, prompt: string): Promise<string> {
  const r = await fetch(`${trimSlash(base)}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, system, messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 4000 }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!r.ok) throw new Error(`${base} returned ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
  const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  if (!text) throw new Error(`${base} returned no content`);
  if (j.stop_reason === "max_tokens") throw new Error("the model ran out of tokens before finishing");
  return text;
}

/** `usage` hears about each call that finishes: how long it took, and what it cost where the provider says. */
export async function complete(m: Resolved, system: string, prompt: string, usage?: (u: Usage) => void): Promise<string> {
  const t0 = Date.now();
  let cost: number | undefined;
  const text = await route(m, system, prompt, (usd) => { cost = usd; });
  usage?.({ ms: Date.now() - t0, cost });
  return text;
}

async function route(m: Resolved, system: string, prompt: string, setCost: (usd: number) => void): Promise<string> {
  const { def, key } = m;
  switch (def.kind) {
    case "claude-cli": return claude(def.model, system, prompt, setCost);
    case "anthropic": return anthropic(def.endpoint ?? "https://api.anthropic.com", key!, def.model!, system, prompt);
    case "openai-compatible": return openai(trimSlash(def.endpoint!), key, def.model, system, prompt);
  }
}

/** Is the model reachable right now? Never throws: the answer is the string. Used by `prview models`; a probe costs no tokens. */
export async function probe(m: Resolved): Promise<string> {
  const { def, key } = m;
  try {
    if (def.kind === "claude-cli") {
      const p = Bun.spawn(["claude", "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const out = (await new Response(p.stdout).text()).trim();
      return (await p.exited) === 0 ? `ok (claude ${out})` : "claude exited with an error";
    }
    const url = def.kind === "anthropic" ? `${trimSlash(def.endpoint ?? "https://api.anthropic.com")}/v1/models` : `${trimSlash(def.endpoint!)}/models`;
    const headers: Record<string, string> = def.kind === "anthropic" ? { "x-api-key": key!, "anthropic-version": "2023-06-01" } : key ? { Authorization: `Bearer ${key}` } : {};
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    return r.ok ? "ok" : `unreachable: ${r.status}`;
  } catch (e) {
    return `unreachable: ${e instanceof Error && e.name !== "TimeoutError" ? e.message : "timed out"}`;
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
