/**
 * Notifications (`docs/phases/P08-api-agents.md` § Webhooks et notifications).
 *
 * One channel, chosen in Settings › Integrations, told about the five events of
 * `@mm/contracts`. Distinct from webhooks in intent, not merely in code: a **webhook** is a
 * machine-to-machine callback with a signature, retries and a delivery log; a **notification**
 * is a sentence a human reads on their phone. They share the event vocabulary and nothing
 * else, which is why the message rendering lives here and the HMAC lives there.
 *
 * Three properties this module holds on to:
 *
 *  - **It never throws.** `notify()` is called from job handlers, at the end of an import that
 *    has just succeeded. An ntfy topic that 404s must not turn a finished import into a
 *    failed one, so a delivery failure is logged and swallowed. `send()` returns an outcome
 *    for the "Test" button, which *does* want to know.
 *  - **The transports are injectable.** `Deps.fetch` and `Deps.sendMail` default to the real
 *    ones; the tests pass mocks, and `CLAUDE.md` forbids network in unit tests.
 *  - **It reads settings, not the environment.** Which channel, which target, which events are
 *    operational facts that change without a deploy.
 *
 * SMTP is spoken directly over a TCP socket rather than through nodemailer. It is ~90 lines
 * for the one thing needed here — a single plain-text message to one recipient — against a
 * dependency that brings OAuth2, DKIM, attachment streaming and a Node-only socket stack into
 * a Bun app. If the requirements ever grow past "one paragraph to one address", that trade
 * flips; today it does not.
 */
import { connect } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import { MMError, type NotifiableEvent } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { serverEnv } from "#/server/env.ts";

export interface NotificationDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly sendMail?: (message: MailMessage, settings: Settings) => Promise<void>;
  readonly settings?: Settings;
  readonly db?: Database;
}

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** What the caller wants said. `data` becomes the detail line and the click-through link. */
export interface Notification {
  readonly event: NotifiableEvent;
  readonly title: string;
  readonly body: string;
  /** A Console path, appended to `MM_WEB_URL` to make the message actionable. */
  readonly path?: string;
  readonly priority?: "low" | "normal" | "high";
}

export type DeliveryOutcome =
  | { readonly delivered: true; readonly channel: string }
  | { readonly delivered: false; readonly channel: string; readonly reason: string };

/* ------------------------------------------------------------------ */
/* the entry point job handlers use                                    */
/* ------------------------------------------------------------------ */

/**
 * Tell the configured channel, if it is configured, enabled, and subscribed to this event.
 *
 * Deliberately returns nothing and never rejects — see the module note. The three reasons a
 * notification is skipped are all normal states, not errors: notifications off, channel
 * `none`, event not ticked.
 */
export async function notify(
  notification: Notification,
  deps: NotificationDeps = {},
): Promise<void> {
  try {
    const settings = deps.settings ?? (await loadSettings(deps.db ?? defaultDb()));
    if (!settings.notificationsEnabled) return;
    if (settings.notificationsChannel === "none") return;
    if (!settings.notificationsEvents.includes(notification.event)) return;
    const outcome = await send(notification, { ...deps, settings });
    if (!outcome.delivered) {
      console.warn(
        `[notifications] ${notification.event} not delivered over ${outcome.channel}: ${outcome.reason}`,
      );
    }
  } catch (error) {
    // A notification is the least important thing happening in this process.
    console.warn(`[notifications] ${notification.event} failed:`, MMError.from(error).message);
  }
}

/**
 * Deliver, ignoring the "is this event subscribed?" question.
 *
 * This is what the Test button calls: it wants to know whether the channel works, and
 * refusing to send because the operator has not ticked `import.done` yet would answer a
 * different question from the one the button asks.
 */
export async function send(
  notification: Notification,
  deps: NotificationDeps = {},
): Promise<DeliveryOutcome> {
  const settings = deps.settings ?? (await loadSettings(deps.db ?? defaultDb()));
  const channel = settings.notificationsChannel;
  const target = settings.notificationsTarget.trim();

  if (channel === "none") {
    return { delivered: false, channel, reason: "No channel is configured." };
  }
  if (channel !== "email" && target === "") {
    return { delivered: false, channel, reason: "The channel has no target URL." };
  }

  try {
    if (channel === "ntfy") return await sendNtfy(notification, target, deps);
    if (channel === "discord") return await sendDiscord(notification, target, deps);
    return await sendEmail(notification, settings, deps);
  } catch (error) {
    return { delivered: false, channel, reason: MMError.from(error).message };
  }
}

/**
 * The Console link a message points at, or `null` when there is nothing useful to open.
 *
 * `MM_WEB_URL` rather than the first trusted origin: a trusted origin is a hostname the
 * *browser* may present to Better Auth, which is a list that legitimately contains several
 * proxies. `MM_WEB_URL` is the one address this installation calls itself, which is the one
 * worth putting in a message somebody will tap on a phone.
 */
function linkOf(notification: Notification): string | null {
  if (notification.path === undefined) return null;
  /*
   * A missing environment costs the link, not the message.
   *
   * `serverEnv()` parses the whole schema and throws when `DATABASE_URL` is absent. That is
   * right for the worker and wrong here: "the import failed" is worth saying even from a
   * process whose environment is half-configured, and swallowing the notification to protect
   * a hyperlink would lose the one thing the operator needed to hear.
   */
  let base: string;
  try {
    base = serverEnv().MM_WEB_URL.replace(/\/+$/, "");
  } catch {
    return null;
  }
  return `${base}${notification.path}`;
}

/* ------------------------------------------------------------------ */
/* ntfy                                                                */
/* ------------------------------------------------------------------ */

/**
 * ntfy takes the message as the body and everything else as headers.
 *
 * The target is a full topic URL (`https://ntfy.sh/my-topic`) rather than a bare topic, so a
 * self-hosted ntfy needs no second setting for its host.
 */
async function sendNtfy(
  notification: Notification,
  target: string,
  deps: NotificationDeps,
): Promise<DeliveryOutcome> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const link = linkOf(notification);
  const headers: Record<string, string> = {
    Title: notification.title,
    Tags: notification.event,
    Priority: notification.priority === "high" ? "4" : notification.priority === "low" ? "2" : "3",
  };
  if (link !== null) headers["Click"] = link;

  const response = await doFetch(target, {
    method: "POST",
    headers,
    body: notification.body,
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok
    ? { delivered: true, channel: "ntfy" }
    : {
        delivered: false,
        channel: "ntfy",
        reason: `ntfy answered ${String(response.status)}.`,
      };
}

/* ------------------------------------------------------------------ */
/* Discord                                                             */
/* ------------------------------------------------------------------ */

const DISCORD_COLOURS: Record<NotifiableEvent, number> = {
  "import.done": 0x4ade80,
  "import.failed": 0xf87171,
  "review.needed": 0xfbbf24,
  "ytdlp.updated": 0x60a5fa,
  "cookies.expiring": 0xfbbf24,
};

/** A Discord incoming webhook, as one embed. Discord answers 204 on success, not 200. */
async function sendDiscord(
  notification: Notification,
  target: string,
  deps: NotificationDeps,
): Promise<DeliveryOutcome> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const link = linkOf(notification);
  const response = await doFetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "Music Manager",
      embeds: [
        {
          title: notification.title,
          description: notification.body,
          color: DISCORD_COLOURS[notification.event],
          ...(link === null ? {} : { url: link }),
          footer: { text: notification.event },
          timestamp: new Date().toISOString(),
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok
    ? { delivered: true, channel: "discord" }
    : {
        delivered: false,
        channel: "discord",
        reason: `Discord answered ${String(response.status)}.`,
      };
}

/* ------------------------------------------------------------------ */
/* SMTP                                                                */
/* ------------------------------------------------------------------ */

async function sendEmail(
  notification: Notification,
  settings: Settings,
  deps: NotificationDeps,
): Promise<DeliveryOutcome> {
  const to = settings.notificationsTarget.trim();
  if (settings.smtpHost.trim() === "") {
    return { delivered: false, channel: "email", reason: "No SMTP host is configured." };
  }
  if (to === "") {
    return { delivered: false, channel: "email", reason: "No destination address." };
  }
  const link = linkOf(notification);
  const message: MailMessage = {
    to,
    subject: notification.title,
    body: link === null ? notification.body : `${notification.body}\n\n${link}\n`,
  };
  const deliver = deps.sendMail ?? smtpSend;
  await deliver(message, settings);
  return { delivered: true, channel: "email" };
}

/** Read one SMTP reply, which may be several `250-…` continuation lines then `250 …`. */
function readReply(socket: Socket | TLSSocket): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      // A reply is complete when a line's fourth character is a space rather than a hyphen.
      const lines = buffer.split(/\r?\n/).filter((line) => line !== "");
      const last = lines[lines.length - 1];
      if (last === undefined || last.length < 4 || last[3] === "-") return;
      cleanup();
      resolve({ code: Number.parseInt(last.slice(0, 3), 10), text: buffer });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/**
 * Send one message, then quit.
 *
 * No connection pooling, no pipelining, no MIME: this sends a single `text/plain` body to a
 * single recipient and hangs up. `465` is implicit TLS; anything else starts in clear and
 * issues `STARTTLS` when `smtpTls` is on, which is what every self-hosted relay expects.
 */
async function smtpSend(message: MailMessage, settings: Settings): Promise<void> {
  const host = settings.smtpHost.trim();
  const port = settings.smtpPort;
  const implicitTls = port === 465;

  let socket: Socket | TLSSocket = implicitTls
    ? connectTls({ host, port, servername: host })
    : connect({ host, port });

  const expect = async (wanted: number, what: string): Promise<void> => {
    const reply = await readReply(socket);
    if (Math.floor(reply.code / 100) !== Math.floor(wanted / 100)) {
      throw new MMError("UNKNOWN", `SMTP ${what} failed: ${reply.text.trim()}`, {
        hint: "Check the host, the port and the credentials in Settings › Integrations.",
      });
    }
  };
  const say = async (line: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      socket.write(`${line}\r\n`, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once(implicitTls ? "secureConnect" : "connect", () => {
        resolve();
      });
      socket.once("error", reject);
      socket.setTimeout(15_000, () => {
        reject(new MMError("TIMEOUT", `SMTP server ${host}:${String(port)} did not answer.`));
      });
    });

    await expect(220, "greeting");
    await say(`EHLO music-manager`);
    await expect(250, "EHLO");

    if (!implicitTls && settings.smtpTls) {
      await say("STARTTLS");
      await expect(220, "STARTTLS");
      socket = await new Promise<TLSSocket>((resolve, reject) => {
        const upgraded = connectTls({ socket: socket as Socket, servername: host }, () => {
          resolve(upgraded);
        });
        upgraded.once("error", reject);
      });
      await say(`EHLO music-manager`);
      await expect(250, "EHLO after STARTTLS");
    }

    const user = settings.smtpUser.trim();
    if (user !== "") {
      // AUTH PLAIN: one base64 of `\0user\0password`. AUTH LOGIN would be two more round
      // trips for the same result, and every relay that speaks one speaks the other.
      const token = Buffer.from(`\0${user}\0${settings.smtpPassword}`, "utf8").toString("base64");
      await say(`AUTH PLAIN ${token}`);
      await expect(235, "authentication");
    }

    const from = settings.smtpFrom.trim() === "" ? user : settings.smtpFrom.trim();
    await say(`MAIL FROM:<${from}>`);
    await expect(250, "MAIL FROM");
    await say(`RCPT TO:<${message.to}>`);
    await expect(250, "RCPT TO");
    await say("DATA");
    await expect(354, "DATA");

    const headers = [
      `From: Music Manager <${from}>`,
      `To: <${message.to}>`,
      `Subject: ${message.subject}`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
    ].join("\r\n");
    // Dot-stuffing: a line that is a single `.` would otherwise end the message early.
    const body = message.body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    await say(`${headers}\r\n\r\n${body}\r\n.`);
    await expect(250, "message body");

    await say("QUIT");
  } finally {
    socket.destroy();
  }
}

/* ------------------------------------------------------------------ */
/* the sentences                                                       */
/* ------------------------------------------------------------------ */

/**
 * Render one of the five events as a notification.
 *
 * Kept here, next to the transports, so the ntfy title and the Discord embed title are the
 * same string, and so a caller in a job handler passes facts rather than prose.
 */
export function describe(
  event: NotifiableEvent,
  data: Record<string, unknown>,
): Notification {
  const text = (key: string, fallback: string): string => {
    const value = data[key];
    return typeof value === "string" && value !== "" ? value : fallback;
  };

  switch (event) {
    case "import.done": {
      const title = text("title", "An import");
      return {
        event,
        title: `Import finished — ${title}`,
        body: `${title} is in the library${
          typeof data["tracks"] === "number" ? ` (${String(data["tracks"])} tracks)` : ""
        }.`,
        path: `/imports/${text("importId", "")}`,
        priority: "low",
      };
    }
    case "import.failed": {
      const title = text("title", "An import");
      return {
        event,
        title: `Import failed — ${title}`,
        body: `${text("step", "A step")} failed: ${text("message", "no detail given")}.`,
        path: `/imports/${text("importId", "")}`,
        priority: "high",
      };
    }
    case "review.needed": {
      const count = typeof data["count"] === "number" ? data["count"] : 1;
      return {
        event,
        title: "Review needed",
        body: `${String(count)} item${count === 1 ? "" : "s"} waiting for a decision: ${text(
          "reason",
          "the pipeline is blocked",
        )}.`,
        path: "/review",
        priority: "normal",
      };
    }
    case "ytdlp.updated": {
      const ok = data["ok"] !== false;
      return {
        event,
        title: ok ? "yt-dlp updated" : "yt-dlp update failed",
        body: ok
          ? `Now on ${text("version", "a new version")}.`
          : `The update did not apply: ${text("message", "no detail given")}.`,
        path: "/tools",
        priority: ok ? "low" : "high",
      };
    }
    case "cookies.expiring": {
      return {
        event,
        title: "YouTube cookies are expiring",
        body: text("message", "Export a fresh cookies.txt before downloads start failing."),
        path: "/settings/downloader",
        priority: "high",
      };
    }
  }
}
