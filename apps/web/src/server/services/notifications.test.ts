import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NotifiableEvent } from "@mm/contracts";
import { resetServerEnv } from "#/server/env.ts";
import { defaults, type Settings } from "./settings.ts";
import { describe as describeEvent, notify, send } from "./notifications.ts";

/*
 * A message carries a link, and the link comes from `MM_WEB_URL`.
 *
 * `serverEnv()` parses the *whole* schema, so `DATABASE_URL` has to be present even though
 * nothing here opens a connection — it is a string, not a socket. The cache is cleared on both
 * sides so this suite neither inherits another's environment nor leaks its own.
 */
beforeAll(() => {
  resetServerEnv();
  vi.stubEnv("DATABASE_URL", "postgres://unit:test@localhost:5432/mm");
  vi.stubEnv("MM_WEB_URL", "http://localhost:3600");
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetServerEnv();
});

/**
 * The three transports, against a mock `fetch`.
 *
 * `CLAUDE.md` forbids network in unit tests, and these are exactly the tests that would be
 * tempted — so the transport is injected. What is worth asserting is not "it called fetch" but
 * the three promises the module makes: it respects the subscription, it never throws at a job
 * handler, and it reports honestly to the Test button.
 */

function settingsWith(patch: Partial<Settings>): Settings {
  return { ...defaults(), ...patch };
}

/** A `fetch` that records what it was asked and answers however the test says. */
function mockFetch(response: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(response.ok === false ? "no" : "ok", {
      status: response.status ?? (response.ok === false ? 500 : 200),
    });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

describe("send", () => {
  const note = {
    event: "import.done" as const,
    title: "Import finished — Discovery",
    body: "14 tracks are in the library.",
    path: "/imports/imp_1",
  };

  it("posts the body to an ntfy topic, with the title and a click-through as headers", async () => {
    const fetch = mockFetch();
    const outcome = await send(note, {
      fetch: fetch.fn,
      settings: settingsWith({
        notificationsChannel: "ntfy",
        notificationsTarget: "https://ntfy.example/mm",
      }),
    });

    expect(outcome).toEqual({ delivered: true, channel: "ntfy" });
    const call = fetch.calls[0];
    expect(call?.url).toBe("https://ntfy.example/mm");
    expect(call?.init.body).toBe(note.body);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["Title"]).toBe(note.title);
    expect(headers["Tags"]).toBe("import.done");
    // The link makes the message actionable on a phone, which is the point of the channel.
    expect(headers["Click"]).toMatch(/\/imports\/imp_1$/);
  });

  it("posts a Discord embed as JSON", async () => {
    const fetch = mockFetch();
    const outcome = await send(note, {
      fetch: fetch.fn,
      settings: settingsWith({
        notificationsChannel: "discord",
        notificationsTarget: "https://discord.example/api/webhooks/1/x",
      }),
    });

    expect(outcome.delivered).toBe(true);
    const body = JSON.parse(String(fetch.calls[0]?.init.body)) as {
      embeds: { title: string; description: string; footer: { text: string } }[];
    };
    expect(body.embeds[0]?.title).toBe(note.title);
    expect(body.embeds[0]?.description).toBe(note.body);
    expect(body.embeds[0]?.footer.text).toBe("import.done");
  });

  it("reports the status when the endpoint refuses, rather than pretending", async () => {
    const fetch = mockFetch({ ok: false, status: 404 });
    const outcome = await send(note, {
      fetch: fetch.fn,
      settings: settingsWith({
        notificationsChannel: "ntfy",
        notificationsTarget: "https://ntfy.example/gone",
      }),
    });
    expect(outcome).toEqual({
      delivered: false,
      channel: "ntfy",
      reason: "ntfy answered 404.",
    });
  });

  it("says so when nothing is configured, instead of silently succeeding", async () => {
    const none = await send(note, { settings: settingsWith({ notificationsChannel: "none" }) });
    expect(none.delivered).toBe(false);

    const targetless = await send(note, {
      settings: settingsWith({ notificationsChannel: "ntfy", notificationsTarget: "" }),
    });
    expect(targetless).toMatchObject({
      delivered: false,
      reason: "The channel has no target URL.",
    });

    const hostless = await send(note, {
      settings: settingsWith({
        notificationsChannel: "email",
        notificationsTarget: "me@example.test",
        smtpHost: "",
      }),
    });
    expect(hostless).toMatchObject({ delivered: false, channel: "email" });
  });

  it("hands the e-mail channel a rendered message and lets SMTP be injected", async () => {
    const sent: { to: string; subject: string; body: string }[] = [];
    const sendMail = vi.fn(async (message: { to: string; subject: string; body: string }) => {
      sent.push(message);
    });
    const outcome = await send(note, {
      sendMail,
      settings: settingsWith({
        notificationsChannel: "email",
        notificationsTarget: "me@example.test",
        smtpHost: "smtp.example.test",
      }),
    });

    expect(outcome).toEqual({ delivered: true, channel: "email" });
    const message = sent[0];
    expect(message?.to).toBe("me@example.test");
    expect(message?.subject).toBe(note.title);
    expect(message?.body).toContain(note.body);
    expect(message?.body).toContain("/imports/imp_1");
  });
});

describe("notify", () => {
  const note = {
    event: "import.failed" as const,
    title: "Import failed",
    body: "download failed.",
  };

  it("stays silent when notifications are off", async () => {
    const fetch = mockFetch();
    await notify(note, {
      fetch: fetch.fn,
      settings: settingsWith({
        notificationsEnabled: false,
        notificationsChannel: "ntfy",
        notificationsTarget: "https://ntfy.example/mm",
        notificationsEvents: ["import.failed"],
      }),
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it("stays silent for an event nobody subscribed to", async () => {
    const fetch = mockFetch();
    await notify(note, {
      fetch: fetch.fn,
      settings: settingsWith({
        notificationsEnabled: true,
        notificationsChannel: "ntfy",
        notificationsTarget: "https://ntfy.example/mm",
        notificationsEvents: ["import.done"],
      }),
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it("delivers a subscribed event", async () => {
    const fetch = mockFetch();
    await notify(note, {
      fetch: fetch.fn,
      settings: settingsWith({
        notificationsEnabled: true,
        notificationsChannel: "ntfy",
        notificationsTarget: "https://ntfy.example/mm",
        notificationsEvents: ["import.failed"],
      }),
    });
    expect(fetch.calls).toHaveLength(1);
  });

  it("never throws at its caller, whatever the transport does", async () => {
    // The promise this module makes to every job handler: a dead ntfy must not turn a
    // finished import into a failed one.
    const exploding = vi.fn(async () => {
      throw new Error("DNS is on fire");
    }) as unknown as typeof globalThis.fetch;

    await expect(
      notify(note, {
        fetch: exploding,
        settings: settingsWith({
          notificationsEnabled: true,
          notificationsChannel: "ntfy",
          notificationsTarget: "https://ntfy.example/mm",
          notificationsEvents: ["import.failed"],
        }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("describe", () => {
  it("renders all five events with a title, a body and somewhere to go", () => {
    const events: NotifiableEvent[] = [
      "import.done",
      "import.failed",
      "review.needed",
      "ytdlp.updated",
      "cookies.expiring",
    ];
    for (const event of events) {
      const rendered = describeEvent(event, { importId: "imp_1", title: "Discovery", count: 2 });
      expect(rendered.event, event).toBe(event);
      expect(rendered.title.length, event).toBeGreaterThan(5);
      expect(rendered.body.length, event).toBeGreaterThan(5);
      expect(rendered.path, event).toBeDefined();
    }
  });

  it("says what failed, and raises the priority when it matters", () => {
    const failure = describeEvent("import.failed", {
      importId: "imp_1",
      title: "Discovery",
      step: "download",
      message: "yt-dlp said no",
    });
    expect(failure.title).toContain("Discovery");
    expect(failure.body).toContain("download");
    expect(failure.body).toContain("yt-dlp said no");
    expect(failure.priority).toBe("high");

    // A success is not worth waking anyone up for.
    expect(describeEvent("import.done", { title: "Discovery" }).priority).toBe("low");
  });

  it("reads `ok: false` on a yt-dlp update as a failure", () => {
    expect(describeEvent("ytdlp.updated", { ok: true, version: "2026.01.01" }).title).toBe(
      "yt-dlp updated",
    );
    const failed = describeEvent("ytdlp.updated", { ok: false, message: "no network" });
    expect(failed.title).toBe("yt-dlp update failed");
    expect(failed.priority).toBe("high");
  });
});
