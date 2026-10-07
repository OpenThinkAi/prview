import { expect, test } from "bun:test";
import { github } from "../src/github.ts";

test("github.parse takes a PR URL and nothing else: anchored, owner/repo limited to GitHub's characters", () => {
  expect(github.parse("https://github.com/o/r/pull/7")).toMatchObject({ repoKey: "o/r", number: 7, url: "https://github.com/o/r/pull/7" });
  expect(github.parse("https://github.com/Open-Think_ai/pr.view/pull/12/files")?.repoKey).toBe("Open-Think_ai/pr.view");
  expect(github.parse("github.com/o/r/pull/7")?.number).toBe(7);
  for (const bad of ["https://github.com/../r/pull/7", "https://github.com/o/../pull/7", "https://github.com/./r/pull/7", "https://github.com/o/./pull/7",
    "https://github.com/o r/x/pull/7", "https://github.com/o/r;rm/pull/7", "https://github.com/o/r%2e%2e/pull/7", "https://github.com/o:x/r/pull/7",
    "https://evil.test/github.com/o/r/pull/7", "see https://github.com/o/r/pull/7", "https://github.com/o/r/pull/7x", "https://github.com/o/r/pull/"]) {
    expect(github.parse(bad), bad).toBeUndefined();
  }
});
