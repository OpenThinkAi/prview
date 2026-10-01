import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/cli.tsx");
const version = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).version;

test("--version, -V and `version` print the version and exit 0 without a terminal or a repo", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prview-version-"));
  try {
    for (const arg of ["--version", "-V", "version"]) {
      const r = Bun.spawnSync(["bun", cli, arg], { cwd, env: { ...process.env, PRVIEW_HOME: join(cwd, "home"), PRVIEW_NO_UPDATE: "1" } });
      expect(r.exitCode).toBe(0);
      // A test run is always a source checkout.
      expect(r.stdout.toString()).toBe(`prview ${version} (source checkout)\n`);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("the usage text lists the version flag and Azure DevOps PR URLs", () => {
  const r = Bun.spawnSync(["bun", cli, "--help"], { env: { ...process.env, PRVIEW_NO_UPDATE: "1" } });
  const out = r.stdout.toString();
  expect(out).toContain("Azure DevOps");
  expect(out).toContain("--version");
});
