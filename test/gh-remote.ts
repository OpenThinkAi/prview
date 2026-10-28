// The clone's remotes as the GitHub adapter reads them before posting (`git remote -v`, through the injected runner):
// posting goes only to a PR of a repository one of them points at, so a fake gh answers this first.
import type { Runner } from "../src/platform.ts";

export const remoteOut = (url = "https://github.com/o/r.git") => ({ exit: 0, stdout: `origin\t${url} (fetch)\norigin\t${url} (push)\n`, stderr: "" });
export const isRemoteCall = (argv: string[]) => argv[0] === "git" && argv[1] === "remote";
/** `run`, with the clone's remotes answered: one origin at `url` (o/r by default). */
export const withRemote = (run: Runner, url?: string): Runner => (argv, o) => isRemoteCall(argv) ? remoteOut(url) : run(argv, o);
