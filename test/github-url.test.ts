import { expect, test } from "bun:test";
import { github, strictPrUrl } from "../src/github.ts";

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

test("strictPrUrl, what a review is posted to: only the canonical https://github.com/<owner>/<repo>/pull/<n>", () => {
  expect(strictPrUrl("https://github.com/o/r/pull/7")).toMatchObject({ repoKey: "o/r", number: 7, url: "https://github.com/o/r/pull/7" });
  expect(strictPrUrl("https://github.com/Open-Think_ai/pr.view/pull/1234567890")?.repoKey).toBe("Open-Think_ai/pr.view");
  for (const bad of [undefined, "", "--help", "-o/r/pull/7",
    // what the reader may type, but not what a review posts to
    "github.com/o/r/pull/7", "http://github.com/o/r/pull/7", "https://www.github.com/o/r/pull/7", "HTTPS://github.com/o/r/pull/7", "https://GitHub.com/o/r/pull/7",
    "https://github.com/o/r/pull/7/files", "https://github.com/o/r/pull/7/", "https://github.com/o/r/pull/7?x=1", "https://github.com/o/r/pull/7#issuecomment-1",
    "https://github.com/o/r/pull/7?../../repos/evil/pwn/pulls/1", "https://github.com/o/r/pull/7#/../../evil",
    // other hosts, userinfo, ports
    "https://github.com.evil.test/o/r/pull/7", "https://evil.test/o/r/pull/7", "https://user@github.com/o/r/pull/7", "https://github.com:443/o/r/pull/7",
    // traversal and odd segments
    "https://github.com/../r/pull/7", "https://github.com/o/../pull/7", "https://github.com/./r/pull/7", "https://github.com/o/./pull/7", "https://github.com/o/r%2e%2e/pull/7",
    "https://github.com/o/r/x/pull/7", "https://github.com/o r/r/pull/7", "https://github.com/o/r/pull/7\n",
    // PR numbers: no 0, no leading zeros, no huge ones
    "https://github.com/o/r/pull/0", "https://github.com/o/r/pull/07", "https://github.com/o/r/pull/12345678901", "https://github.com/o/r/pull/-1", "https://github.com/o/r/pull/"]) {
    expect(strictPrUrl(bad), String(bad)).toBeUndefined();
  }
});
