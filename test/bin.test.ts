import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const BIN = join(import.meta.dir, "..", "bin", "prview.js");
const node = Bun.which("node");
// Node's directory is the whole PATH below, so a bun installed beside it would defeat the test.
const bunBesideNode = !!node && existsSync(join(dirname(node), "bun"));

test("the bin runs the app under Bun", () => {
  const r = Bun.spawnSync([process.execPath, BIN, "--help"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("prview");
});

test.skipIf(!node || bunBesideNode)("under plain Node with no Bun on PATH it says it needs Bun and exits 1", () => {
  // PATH holds only node's directory, so `bun` can't be found.
  const dir = dirname(node!);
  const r = Bun.spawnSync([node!, BIN, "--help"], { env: { PATH: dir } });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString().trim()).toBe("prview needs Bun: https://bun.sh");
});
