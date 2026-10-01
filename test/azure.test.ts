// Azure DevOps URL and remote parsing (src/azure.ts): pure, table-driven, no network.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { azure } from "../src/azure.ts";
import { github } from "../src/github.ts";
import { Fail } from "../src/document.ts";
import { isPR, parseRef, prIn, SOURCES } from "../src/registry.ts";
import { prSlug } from "../src/pr.ts";

const tmp = mkdtempSync(join(tmpdir(), "prview-azure-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const E = "https://dev.azure.com/anglepoint/Elevate/_git/Elevate/pullrequest/10479";

// [input, repoKey, canonical url, number]
const URLS: [string, string, string, number][] = [
  [E, "anglepoint/Elevate/Elevate", E, 10479],
  [E + "?_a=files&path=%2Fsrc%2Fa.ts", "anglepoint/Elevate/Elevate", E, 10479],
  [E + "#discussionId=5", "anglepoint/Elevate/Elevate", E, 10479],
  [E + "?_a=overview&discussionId=9", "anglepoint/Elevate/Elevate", E, 10479],
  ["https://dev.azure.com/anglepoint/Elevate/_git/Elevate/PullRequest/10479", "anglepoint/Elevate/Elevate", E, 10479],
  ["https://dev.azure.com/anglepoint/Elevate/_git/Elevate/pullrequest/10479/", "anglepoint/Elevate/Elevate", E, 10479],
  ["dev.azure.com/anglepoint/Elevate/_git/Elevate/pullrequest/10479", "anglepoint/Elevate/Elevate", E, 10479],
  ["https://anglepoint@dev.azure.com/anglepoint/Elevate/_git/Elevate/pullrequest/10479", "anglepoint/Elevate/Elevate", E, 10479],
  ["https://dev.azure.com/anglepoint/_git/Elevate/pullrequest/10479", "anglepoint/Elevate/Elevate", E, 10479],
  ["https://anglepoint.visualstudio.com/Elevate/_git/Elevate/pullrequest/10479", "anglepoint/Elevate/Elevate", E, 10479],
  ["https://anglepoint.visualstudio.com/DefaultCollection/Elevate/_git/Elevate/pullrequest/10479", "anglepoint/Elevate/Elevate", E, 10479],
  ["https://anglepoint.visualstudio.com/_git/Elevate/pullrequest/10479", "anglepoint/Elevate/Elevate", E, 10479],
  ["https://AnglePoint.VisualStudio.com/defaultcollection/Elevate/_GIT/Elevate/pullrequest/10479", "anglepoint/Elevate/Elevate", "https://dev.azure.com/anglepoint/Elevate/_git/Elevate/pullrequest/10479", 10479],
  ["https://dev.azure.com/my%20org/My%20Project/_git/My%20Repo/pullrequest/7", "my org/My Project/My Repo", "https://dev.azure.com/my%20org/My%20Project/_git/My%20Repo/pullrequest/7", 7],
  ["https://dev.azure.com/o/p/_git/r/pullrequest/0042", "o/p/r", "https://dev.azure.com/o/p/_git/r/pullrequest/42", 42],
  ["http://dev.azure.com/o/p/_git/r.js/pullrequest/3", "o/p/r.js", "https://dev.azure.com/o/p/_git/r.js/pullrequest/3", 3],
];

test("azure parses every PR URL form to one canonical ref", () => {
  for (const [input, repoKey, url, number] of URLS) {
    const ref = azure.parse(input);
    expect({ input, ref }).toEqual({ input, ref: { platform: "azure-devops", url, repoKey, number, label: `${repoKey.split("/")[2]}!${number}` } });
  }
});

test("the trigger URL is {anglepoint, Elevate, Elevate, 10479}", () => {
  const r = azure.parse(E)!;
  expect(r.repoKey.split("/")).toEqual(["anglepoint", "Elevate", "Elevate"]);
  expect(r.number).toBe(10479);
  expect(r.label).toBe("Elevate!10479");
  expect(prSlug("/x/Elevate", r.number)).toBe("Elevate-pr-10479");
  expect(azure.parse(r.url)).toEqual(r); // the canonical URL re-parses to itself
});

test("azure claims no URL that is not an Azure PR, and never a GitHub one", () => {
  for (const not of [
    "https://github.com/o/r/pull/7", "https://dev.azure.com/o/p/_git/r", "https://dev.azure.com/o/p/_git/r/pullrequests",
    "https://dev.azure.com/o/p/_git/r/pullrequest/abc", "https://dev.azure.com/o/p/_git/r/pullrequest/", "https://dev.azure.com/o/p/_git/r/pullrequest/0",
    "https://dev.azure.com/o/p/_git/r/pullrequest/1/extra", "https://dev.azure.com/o/p/q/_git/r/pullrequest/1", "https://dev.azure.com/o/p/r/pullrequest/1",
    "https://example.com/o/p/_git/r/pullrequest/1", "https://visualstudio.com/p/_git/r/pullrequest/1", "https://dev.azure.com/o/p/_git/%E0%A4%A/pullrequest/1",
    "main..feature", "7", "#7", "",
  ]) expect(azure.parse(not)).toBeUndefined();
});

// [remote, key]
const REMOTES: [string, string | undefined][] = [
  ["https://dev.azure.com/anglepoint/Elevate/_git/Elevate", "anglepoint/elevate/elevate"],
  ["https://anglepoint@dev.azure.com/anglepoint/Elevate/_git/Elevate", "anglepoint/elevate/elevate"],
  ["https://user:tok@dev.azure.com/anglepoint/Elevate/_git/Elevate", "anglepoint/elevate/elevate"],
  ["https://dev.azure.com/anglepoint/Elevate/_git/Elevate.git", "anglepoint/elevate/elevate"],
  ["https://dev.azure.com/anglepoint/_git/Elevate", "anglepoint/elevate/elevate"],
  ["https://anglepoint.visualstudio.com/Elevate/_git/Elevate", "anglepoint/elevate/elevate"],
  ["https://anglepoint.visualstudio.com/DefaultCollection/Elevate/_git/Elevate", "anglepoint/elevate/elevate"],
  ["https://anglepoint.visualstudio.com/_git/Elevate", "anglepoint/elevate/elevate"],
  ["git@ssh.dev.azure.com:v3/anglepoint/Elevate/Elevate", "anglepoint/elevate/elevate"],
  ["git@ssh.dev.azure.com:v3/anglepoint/Elevate/Elevate.git", "anglepoint/elevate/elevate"],
  ["ssh://git@ssh.dev.azure.com/v3/anglepoint/Elevate/Elevate", "anglepoint/elevate/elevate"],
  ["anglepoint@vs-ssh.visualstudio.com:v3/anglepoint/Elevate/Elevate", "anglepoint/elevate/elevate"],
  ["git@azure-work:v3/anglepoint/Elevate/Elevate", "anglepoint/elevate/elevate"],
  ["git@ssh.dev.azure.com:v3/anglepoint/My%20Project/My%20Repo", "anglepoint/my project/my repo"],
  ["https://dev.azure.com/AnglePoint/My%20Project/_git/My%20Repo", "anglepoint/my project/my repo"],
  // not Azure
  ["https://github.com/o/r", undefined],
  ["https://github.com/o/r.git", undefined],
  ["git@github.com:o/r.git", undefined],
  ["git@github.com:v3/o/r", undefined],
  ["ssh://git@stamp.example:2222/srv/o/r.git", undefined],
  ["https://gitlab.com/o/r", undefined],
  ["https://dev.azure.com/o/p", undefined],
  ["file:///nowhere/o/r", undefined],
  ["/local/path/repo", undefined],
  ["", undefined],
];

test("azure's remote key normalises every remote form, and reads nothing else", () => {
  for (const [remote, key] of REMOTES) expect({ remote, key: azure.remoteKey(remote) }).toEqual({ remote, key });
});

test("a parsed PR's repoKey matches the remote key of its own repo, case-insensitively", () => {
  const ref = azure.parse("https://AnglePoint.visualstudio.com/Elevate/_git/Elevate/pullrequest/5")!;
  for (const [remote] of REMOTES.slice(0, 13)) expect(azure.remoteKey(remote)).toBe(ref.repoKey.toLowerCase());
});

test("the registry routes Azure URLs to azure and GitHub URLs to github, azure first", () => {
  expect(SOURCES[0]).toBe(azure);
  expect(SOURCES.at(-1)).toBe(github);
  expect(parseRef(E)?.platform).toBe("azure-devops");
  expect(parseRef("https://github.com/o/r/pull/7")?.platform).toBe("github");
  expect(github.parse(E)).toBeUndefined();
  expect(isPR(E)).toBe(true);
  expect(prIn(tmp, E).source).toBe(azure);
});

test("a bare number in an Azure clone is Azure's; elsewhere GitHub's", () => {
  const g = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", ...a], { cwd }); if (r.exitCode !== 0) throw new Error(String(r.stderr)); };
  for (const [name, url, want] of [["az", "git@ssh.dev.azure.com:v3/o/p/r", azure], ["gh", "https://github.com/o/r", github]] as const) {
    const d = join(tmp, name);
    Bun.spawnSync(["mkdir", "-p", d]);
    g(d, "init", "-q"); g(d, "remote", "add", "origin", url);
    expect(prIn(d, "12").source).toBe(want);
    expect(prIn(d, "#12").ref).toBe(12);
  }
});

test("a recognised Azure URL in a clone with no remote for it fails cleanly, never falling through to a range", async () => {
  const ref = azure.parse(E)!;
  const d = join(tmp, "plain");
  Bun.spawnSync(["git", "init", "-q", d]);
  // Refused before any request: the Http here would throw if it were called.
  await expect(Promise.resolve().then(() => azure.resolve(d, ref, { http: () => { throw new Error("no request expected"); } }))).rejects.toThrow(Fail);
  expect(() => azure.fetch(d, ref, true, "a".repeat(40))).toThrow("no remote in");
  expect(isPR(E)).toBe(true);
});
