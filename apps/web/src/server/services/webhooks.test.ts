import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { WEBHOOK_SIGNATURE_HEADER } from "@mm/contracts";
import { newSecret, signPayload, verifySignature } from "./webhooks.ts";

/**
 * The signature, without a database.
 *
 * The scheme's whole value is in three properties, and each one is a thing a subscriber will
 * eventually depend on: the digest is over the timestamp *and* the body, an old signature is
 * refused however valid its digest, and a wrong secret never verifies.
 */

const BODY = JSON.stringify({ id: "evt_1", event: "import.done", data: { tracks: 14 } });
const SECRET = "whsec_test";

describe("signPayload", () => {
  it("produces `t=<unix>,v1=<hex>`", () => {
    const header = signPayload(BODY, SECRET, new Date("2026-01-01T00:00:00Z"));
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(header.startsWith("t=1767225600,")).toBe(true);
  });

  it("signs the timestamp together with the body, not the body alone", () => {
    // The property that makes a replay useless: the same body at a different second has a
    // different digest, so a captured delivery cannot simply be resent.
    const a = signPayload(BODY, SECRET, new Date("2026-01-01T00:00:00Z"));
    const b = signPayload(BODY, SECRET, new Date("2026-01-01T00:00:01Z"));
    expect(a.split(",")[1]).not.toEqual(b.split(",")[1]);

    // And it is genuinely HMAC over `"<t>.<body>"`, which is what a subscriber will implement
    // from the documentation.
    const expected = createHmac("sha256", SECRET).update(`1767225600.${BODY}`).digest("hex");
    expect(a).toBe(`t=1767225600,v1=${expected}`);
  });
});

describe("verifySignature", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("accepts what it just signed", () => {
    expect(verifySignature(BODY, signPayload(BODY, SECRET, now), SECRET, { now })).toBe(true);
  });

  it("refuses a body that changed by one character", () => {
    const header = signPayload(BODY, SECRET, now);
    expect(verifySignature(`${BODY} `, header, SECRET, { now })).toBe(false);
  });

  it("refuses the wrong secret", () => {
    const header = signPayload(BODY, SECRET, now);
    expect(verifySignature(BODY, header, "whsec_other", { now })).toBe(false);
  });

  it("refuses a signature from outside the tolerance window", () => {
    const header = signPayload(BODY, SECRET, now);
    const later = new Date(now.getTime() + 10 * 60 * 1000);
    expect(verifySignature(BODY, header, SECRET, { now: later })).toBe(false);
    // Inside the window it still passes, so the check is a window and not a clock equality.
    const soon = new Date(now.getTime() + 60 * 1000);
    expect(verifySignature(BODY, header, SECRET, { now: soon })).toBe(true);
  });

  it("refuses a signature from the future, not only a stale one", () => {
    const ahead = new Date(now.getTime() + 10 * 60 * 1000);
    const header = signPayload(BODY, SECRET, ahead);
    expect(verifySignature(BODY, header, SECRET, { now })).toBe(false);
  });

  it("refuses a malformed header rather than throwing", () => {
    for (const header of ["", "nonsense", "t=abc,v1=def", "v1=deadbeef", "t=1767225600"]) {
      expect(verifySignature(BODY, header, SECRET, { now }), header).toBe(false);
    }
  });
});

describe("newSecret", () => {
  it("is prefixed, long, and never repeats", () => {
    const a = newSecret();
    expect(a).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(newSecret()).not.toBe(a);
  });
});

describe("the header name", () => {
  it("is the one the documentation and the Settings page quote", () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("x-mm-signature");
  });
});
