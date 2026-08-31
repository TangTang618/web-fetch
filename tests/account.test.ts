/**
 * Account-ID lookup from a Cloudflare API token.
 *
 * The Worker must not require operators to paste CF_ACCOUNT_ID by hand.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { lookupAccountId, resetAccountIdCache, resolveAccountId } from "../src/lib/account.js";
import { cfApiFromEnv } from "../src/lib/cf-api.js";
import { hasRestCredentials } from "../src/lib/fetch-page.js";
import { baseEnv } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetAccountIdCache();
});

function stubAccounts(result: unknown, status = 200) {
  const mock = vi.fn(async () =>
    new Response(JSON.stringify(result), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("lookupAccountId", () => {
  it("returns the single account the token can see", async () => {
    stubAccounts({ success: true, result: [{ id: "acct-1", name: "Mine" }] });
    const got = await lookupAccountId("tok");
    expect(got).toEqual({ ok: true, id: "acct-1" });
  });

  it("refuses to guess when the token can see several accounts", async () => {
    stubAccounts({
      result: [
        { id: "a", name: "Personal" },
        { id: "b", name: "Work" },
      ],
    });
    const got = await lookupAccountId("tok");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toMatch(/2 accounts/);
  });

  it("caches a successful lookup so the second call does not hit the network", async () => {
    const mock = stubAccounts({ result: [{ id: "acct-1", name: "Mine" }] });
    await lookupAccountId("tok");
    await lookupAccountId("tok");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("explains a 401 instead of throwing", async () => {
    stubAccounts({ errors: [{ message: "invalid token" }] }, 401);
    const got = await lookupAccountId("bad");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("401");
  });
});

describe("resolveAccountId", () => {
  it("uses an explicit CF_ACCOUNT_ID without calling the API", async () => {
    const mock = stubAccounts({ result: [{ id: "should-not-run" }] });
    const got = await resolveAccountId(baseEnv({ CF_ACCOUNT_ID: "explicit", CF_API_TOKEN: "tok" }));
    expect(got).toEqual({ ok: true, id: "explicit" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("falls back to looking the id up from CF_API_TOKEN", async () => {
    stubAccounts({ result: [{ id: "from-token" }] });
    const got = await resolveAccountId(baseEnv({ CF_API_TOKEN: "tok" }));
    expect(got).toEqual({ ok: true, id: "from-token" });
  });
});

describe("hasRestCredentials / cfApiFromEnv", () => {
  it("treats a token alone as enough — account ID is not required", () => {
    const env = baseEnv({ CF_API_TOKEN: "tok" });
    expect(hasRestCredentials(env)).toBe(true);
    expect(cfApiFromEnv(env)).not.toBeNull();
  });

  it("is unavailable when there is no token, even if an account ID is set", () => {
    const env = baseEnv({ CF_ACCOUNT_ID: "acct" });
    expect(hasRestCredentials(env)).toBe(false);
    expect(cfApiFromEnv(env)).toBeNull();
  });
});
