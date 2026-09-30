import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cosine, embed, embedWith, loadModel, MODEL_DIR, normalize, preTokenize, tokenize } from "../src/embed.ts";

// The bundled embedder against model2vec itself: models/potion-base-8M/reference.json holds token ids and
// vectors the Python reference produced for the same weights (scripts/build-embedder.ts writes it).

type Case = { text: string; ids: number[]; vector: number[] };
const reference = JSON.parse(readFileSync(join(MODEL_DIR, "reference.json"), "utf8")) as { cases: Case[] };
const model = loadModel();
const ROOT = join(import.meta.dir, "..");

test("the tokenizer produces model2vec's token ids for every fixture", () => {
  for (const c of reference.cases) expect({ text: c.text, ids: tokenize(model, c.text) }).toEqual({ text: c.text, ids: c.ids });
});

test("every fixture embeds within cosine 0.99 of model2vec's vector", () => {
  for (const c of reference.cases) {
    const v = embedWith(model, c.text);
    if (!c.ids.length) { expect(v.every((x) => x === 0)).toBe(true); continue; }
    expect({ text: c.text, close: cosine(v, new Float32Array(c.vector)) >= 0.99 }).toEqual({ text: c.text, close: true });
  }
});

test("a vector is unit length, and text with no known token is all zeros rather than NaN", () => {
  const v = embed("open the file in my editor");
  expect(v.length).toBe(model.config.dim);
  expect(Math.hypot(...v)).toBeCloseTo(1, 5);
  for (const t of ["", "   ", "🙂🙂", "[UNK]"]) expect(embed(t).every((x) => x === 0)).toBe(true);
  expect(cosine(embed(""), v)).toBe(0);
});

test("related questions land closer than unrelated ones", () => {
  const q = embed("how do I leave a comment on a line");
  expect(cosine(q, embed("add a comment to the current line"))).toBeGreaterThan(cosine(q, embed("configure the model for the critic role")));
});

test("the tokenizer follows BERT: accents stripped, lowercased, CJK and punctuation split, special tokens verbatim", () => {
  expect(normalize("Café\tNAÏVE\u200b日本")).toBe("cafe naive 日  本 ");
  expect(preTokenize("don't stop, ok?")).toEqual(["don", "'", "t", "stop", ",", "ok", "?"]);
  const cls = model.vocab.get("[CLS]")!;
  expect(tokenize(model, "a [CLS] b")).toContain(cls);
  expect(tokenize(model, "a [cls] b")).not.toContain(cls);
  const long = "a".repeat(model.config.max_input_chars_per_word + 1);
  expect(tokenize(model, long)).toEqual([]); // one unknown word, dropped
});

test("a long text is cut to max_length tokens", () => {
  expect(tokenize(model, "word ".repeat(2000)).length).toBe(model.config.max_length);
});

// A fresh process, so the timing is a cold load: fetch and raw sockets are replaced with throwing stubs
// before the module is imported, and on macOS the process also runs under a sandbox that denies the network.
test("loads and embeds cold, offline, in under 200 ms", () => {
  const script = `
    const tried = [];
    const block = (what) => (...a) => { tried.push(what); throw new Error("network: " + what); };
    globalThis.fetch = block("fetch");
    Bun.connect = block("Bun.connect");
    const net = require("node:net"); net.connect = net.createConnection = block("net");
    const http = require("node:http"); http.request = http.get = block("http");
    const https = require("node:https"); https.request = https.get = block("https");
    const t = performance.now();
    const { embed } = await import(${JSON.stringify(join(ROOT, "src", "embed.ts"))});
    const v = embed("which key hides a finding?");
    console.log(JSON.stringify({ ms: performance.now() - t, n: v.length, tried }));
  `;
  const sandbox = process.platform === "darwin" && Bun.which("sandbox-exec") ? ["sandbox-exec", "-p", "(version 1)(allow default)(deny network*)"] : [];
  const r = Bun.spawnSync([...sandbox, process.execPath, "-e", script], { cwd: ROOT, env: { ...process.env, NO_PROXY: "*" } });
  expect(r.stderr.toString()).toBe("");
  const out = JSON.parse(r.stdout.toString()) as { ms: number; n: number; tried: string[] };
  expect(out.tried).toEqual([]);
  expect(out.n).toBe(256);
  expect(out.ms).toBeLessThan(200);
});

test("the committed model stays small", () => {
  const size = ["vocab.txt", "embeddings.i8", "scales.f32", "config.json", "reference.json"].reduce((a, f) => a + Bun.file(join(MODEL_DIR, f)).size, 0);
  expect(size).toBeLessThan(10 * 1024 * 1024);
});
