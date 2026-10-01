import { describe, expect, test } from "bun:test";
import { azArgv, azureCredential, azureHttp, redact, type AzRunner, type Http, type HttpReq } from "../src/azure-auth.ts";
import { parseConfig, type Lookups } from "../src/config.ts";

const TOKEN = "eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
const PAT = "s3cretpat0123456789";
const noLookups: Lookups = { env: {}, keychain: () => undefined };
const cfgOf = (toml = "") => parseConfig(toml);
const ok = (stdout = TOKEN + "\n"): AzRunner => () => ({ exit: 0, stdout, stderr: "" });
const fails = (stderr: string, exit = 1): AzRunner => () => ({ exit, stdout: "", stderr });
const msg = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } throw new Error("did not throw"); };

describe("[azure] config", () => {
  test("defaults to az", () => expect(cfgOf().azure).toEqual({ auth: "az" }));
  test("parses pat and tenant", () => {
    expect(cfgOf('[azure]\nauth = "pat"\npat_env = "X"\npat_keychain = "k"\ntenant = "t"').azure).toEqual({ auth: "pat", tenant: "t", patEnv: "X", patKeychain: "k" });
  });
  test("rejects bad auth and a pat with nothing named", () => {
    expect(() => cfgOf('[azure]\nauth = "basic"')).toThrow("auth must be");
    expect(() => cfgOf('[azure]\nauth = "pat"')).toThrow("needs pat_env or pat_keychain");
  });
});

describe("az path", () => {
  test("token comes from stdout, the argv carries none of it", () => {
    const seen: string[][] = [];
    const run: AzRunner = (argv) => { seen.push(argv); return { exit: 0, stdout: TOKEN, stderr: "" }; };
    expect(azureCredential(cfgOf(), noLookups, run)).toEqual({ header: `Bearer ${TOKEN}` });
    expect(seen[0]).toEqual(azArgv());
    expect(seen[0]!.join(" ")).not.toContain(TOKEN);
    expect(seen[0]).toContain("499b84ac-1321-427f-aa17-267ca6975798");
  });
  test("tenant is passed as an argument", () => {
    const seen: string[][] = [];
    azureCredential(cfgOf('[azure]\ntenant = "contoso"'), noLookups, (a) => { seen.push(a); return { exit: 0, stdout: TOKEN, stderr: "" }; });
    expect(seen[0]!.slice(-2)).toEqual(["--tenant", "contoso"]);
  });
  test("az missing", () => {
    expect(msg(() => azureCredential(cfgOf(), noLookups, () => { throw new Error("ENOENT"); }))).toContain("az CLI was not found");
    expect(msg(() => azureCredential(cfgOf(), noLookups, fails("not found", 127)))).toContain("az CLI was not found");
  });
  test("not logged in", () => expect(msg(() => azureCredential(cfgOf(), noLookups, fails("ERROR: Please run 'az login' to setup account.")))).toContain("az login"));
  test("wrong tenant", () => expect(msg(() => azureCredential(cfgOf('[azure]\ntenant = "t1"'), noLookups, fails("AADSTS90002: Tenant 't1' not found")))).toContain("wrong tenant"));
  test("empty output", () => expect(msg(() => azureCredential(cfgOf(), noLookups, ok("\n")))).toContain("no access token"));
  test("a token echoed in stderr never reaches the message", () => {
    const m = msg(() => azureCredential(cfgOf(), noLookups, () => ({ exit: 1, stdout: TOKEN, stderr: `boom Bearer ${TOKEN} ${TOKEN}` })));
    expect(m).not.toContain(TOKEN);
  });
});

describe("pat path", () => {
  const cfg = cfgOf('[azure]\nauth = "pat"\npat_env = "AZ_PAT"\npat_keychain = "svc"');
  const run = fails("must not run");
  test("env first, then keychain", () => {
    const want = { header: `Basic ${Buffer.from(`:${PAT}`).toString("base64")}` };
    expect(azureCredential(cfg, { env: { AZ_PAT: ` ${PAT} ` }, keychain: () => "other" }, run)).toEqual(want);
    expect(azureCredential(cfg, { env: {}, keychain: (s) => (s === "svc" ? PAT : undefined) }, run)).toEqual(want);
  });
  test("env named but empty", () => {
    expect(msg(() => azureCredential(cfgOf('[azure]\nauth = "pat"\npat_env = "AZ_PAT"'), { env: { AZ_PAT: "  " }, keychain: () => undefined }, run))).toContain("$AZ_PAT is set but empty");
  });
  test("nothing found names where it looked", () => {
    expect(msg(() => azureCredential(cfg, noLookups, run))).toContain("$AZ_PAT or Keychain service svc");
  });
});

describe("azureHttp", () => {
  const req: HttpReq = { method: "GET", url: "https://example.invalid/pr" };
  test("adds the header, never puts the token in the url or body, and re-mints once on 401", async () => {
    const tokens = ["tok-one", "tok-two"];
    let mints = 0;
    const run: AzRunner = () => ({ exit: 0, stdout: tokens[mints++]!, stderr: "" });
    const log: HttpReq[] = [];
    const http: Http = async (r) => { log.push(r); return r.headers!.Authorization === "Bearer tok-two" ? { status: 200, json: { ok: 1 }, text: "{}" } : { status: 401, json: undefined, text: "" }; };
    const res = await azureHttp(cfgOf(), noLookups, run, http)(req);
    expect(res.status).toBe(200);
    expect(mints).toBe(2);
    expect(log.map((r) => r.headers!.Authorization)).toEqual(["Bearer tok-one", "Bearer tok-two"]);
    for (const r of log) { expect(r.url).not.toContain("tok-"); expect(r.body ?? "").not.toContain("tok-"); }
  });
  test("a second 401 is returned, not looped", async () => {
    let n = 0;
    const http: Http = async () => { n++; return { status: 401, json: undefined, text: "" }; };
    expect((await azureHttp(cfgOf(), noLookups, ok(), http)(req)).status).toBe(401);
    expect(n).toBe(2);
  });
  test("a PAT 401 is not retried; response text is redacted", async () => {
    let n = 0;
    const cfg = cfgOf('[azure]\nauth = "pat"\npat_env = "AZ_PAT"');
    const http: Http = async (r) => { n++; return { status: 401, json: undefined, text: `denied ${r.headers!.Authorization}` }; };
    const res = await azureHttp(cfg, { env: { AZ_PAT: PAT }, keychain: () => undefined }, ok(), http)(req);
    expect(n).toBe(1);
    expect(res.text).not.toContain(Buffer.from(`:${PAT}`).toString("base64"));
  });
  test("az failure surfaces redacted and makes no request", async () => {
    let n = 0;
    const http: Http = async () => { n++; return { status: 200, json: {}, text: "" }; };
    await expect(azureHttp(cfgOf(), noLookups, fails("Please run 'az login'"), http)(req)).rejects.toThrow("az login");
    expect(n).toBe(0);
  });
});

describe("redact", () => {
  test("strips auth headers, JWTs and known secrets", () => {
    const out = redact(`Authorization: Bearer abc.def Basic Zm9v ${TOKEN} plain ${PAT}`, [PAT]);
    for (const s of ["abc.def", "Zm9v", TOKEN, PAT]) expect(out).not.toContain(s);
    expect(out).toContain("plain");
  });
});
