#!/usr/bin/env node
// The installed `prview` command. The app is TypeScript + Ink and runs on Bun, but npm links bins through
// their shebang, so a bun shebang would give a bare "env: bun: No such file or directory" to anyone without
// Bun. This file is plain JS that runs under either runtime: under Bun it loads the app; under Node it hands
// off to `bun` if there is one, and otherwise says what to install.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.tsx", import.meta.url));

if (process.versions.bun) {
  process.argv.splice(1, 1, cli);
  await import(cli);
} else {
  const r = spawnSync("bun", [cli, ...process.argv.slice(2)], { stdio: "inherit" });
  if (r.error?.code === "ENOENT") {
    console.error("prview needs Bun: https://bun.sh");
    process.exit(1);
  }
  if (r.error) {
    console.error(`prview: could not start bun: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? (r.signal ? 1 : 0));
}
