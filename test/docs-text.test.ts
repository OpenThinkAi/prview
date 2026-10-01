import { expect, test } from "bun:test";
import { BEGIN, END } from "../scripts/build-readme-keys.ts";
import { keysMarkdown } from "../src/keys.ts";

const readme = await Bun.file(new URL("../README.md", import.meta.url).pathname).text();
const usage = new TextDecoder().decode(Bun.spawnSync([process.execPath, new URL("../src/cli.tsx", import.meta.url).pathname, "--help"]).stdout);

test("the README's key map is the one generated from src/keys.ts", () => {
  const a = readme.indexOf("<!-- keys:begin"), b = readme.indexOf(END);
  expect(a).toBeGreaterThan(0);
  expect(readme.slice(a, b).trim()).toBe(`${BEGIN}\n\n${keysMarkdown()}`.trim());
});

// Keys of the old map that no longer exist (AGT-1469); none may be taught. Each is a whole backticked token, so `g F`
// and `ctrl-u` (which are keys now) do not trip it.
const REMOVED = ["u", "d", "n", "N", "W", "F", "H", "L", "w", "S", "/", "]f", "[f", "]c"];

for (const [name, text] of [["README", readme], ["usage", usage]] as const) {
  test(`${name} mentions no removed key`, () => {
    expect(usage.length).toBeGreaterThan(500);
    const ticked = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
    for (const k of REMOVED) expect(ticked, `\`${k}\``).not.toContain(k);
    expect(text).not.toMatch(/\b\d+[jk]\b/); // counts like 3j
    expect(text).not.toMatch(/\bold [A-Za-z]\b|\bthe old `/); // "the old N", "the old `W`"
  });
}

test("the README and usage describe the layout, the key map, settings and the submit flow", () => {
  for (const t of [readme, usage]) for (const w of ["status area", "content area", "key panel", "60"]) expect(t).toContain(w);
  for (const w of ["settings", "submit"]) { expect(readme.toLowerCase()).toContain(w); expect(usage.toLowerCase()).toContain(w); }
});
