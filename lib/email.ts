import { log, timed } from "./log";

/**
 * Sending mail, through Resend.
 *
 * Shaped like `lib/apify.ts` and `lib/groq.ts` deliberately: the key is read per
 * call rather than captured at import, `hasEmail()` is the public gate, the result
 * is a discriminated union rather than a throw, the body is read as text and parsed
 * inside a guard, and the error is a sentence truncated to 200 characters. A new
 * outbound call in this repo should look like the ones already here.
 *
 * ── No SDK ────────────────────────────────────────────────────────────────
 * The request is four fields and a bearer token. `resend` the package would be a
 * dependency, a version to track and a bundle to carry, for a `fetch` call that fits
 * on a screen. This repo has six runtime dependencies and the reason it has six is
 * that it keeps asking this question.
 *
 * ── What Resend needs before any of this works ────────────────────────────
 * A verified sending domain. Without one it will send only from
 * `onboarding@resend.dev`, and only to the address the account was registered with:
 * a sandbox, not a limit that can be argued with. So `hasEmail()` being false is a
 * normal state, not a failure, and every caller treats it as one.
 */

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;

function apiKey(): string | null {
  return process.env.RESEND_API_KEY || null;
}

/**
 * Who it comes from.
 *
 * Falls back to Resend's sandbox address so the whole path is exercisable before a
 * domain exists. That address can only reach the account owner, which is the right
 * behaviour for an unconfigured install: it works for whoever set it up and reaches
 * nobody else by accident.
 */
export function emailFrom(): string {
  return process.env.ZSCORE_EMAIL_FROM || "Z-Score <onboarding@resend.dev>";
}

export function hasEmail(): boolean {
  return Boolean(apiKey());
}

/** Where links in an email should point. Absolute, because an email has no origin. */
export function emailOrigin(): string {
  const raw =
    process.env.ZSCORE_PUBLIC_ORIGIN ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null) ||
    "http://localhost:3737";
  return raw.replace(/\/$/, "");
}

/**
 * Whether a string is an address worth storing.
 *
 * Deliberately narrower than the RFC, which permits quoted local parts containing
 * almost anything. The first version here asked only for something either side of an
 * `@` with a dot in it, and accepted `<script>@x.com`. Nothing renders a recipient
 * today, so that was unreachable rather than safe, and unreachable is not a property
 * to rely on: the moment any screen says who a digest went to, it is stored XSS.
 *
 * Plus-addressing works, subdomains work, and a domain label cannot start with a
 * hyphen or sit next to an empty one.
 */
export function isEmailAddress(value: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(value);
}

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

export async function sendEmail(m: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const key = apiKey();
  if (!key) return { ok: false, error: "RESEND_API_KEY is not set." };
  if (!isEmailAddress(m.to)) return { ok: false, error: "That is not an email address." };

  return timed("email.send", { subject: m.subject.slice(0, 60) }, async () => {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: emailFrom(),
          to: [m.to],
          subject: m.subject,
          html: m.html,
          /**
           * The plain part is not optional in practice. A message with no text
           * alternative is a spam signal on its own, and it is the version that gets
           * read on a watch or by anyone with images and HTML turned off.
           */
          text: m.text,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });

      const body = await res.text();
      if (!res.ok) {
        return { ok: false as const, error: `Resend ${res.status}: ${body.slice(0, 200)}` };
      }

      const data = JSON.parse(body) as { id?: string };
      if (!data.id) return { ok: false as const, error: "Resend did not return a message id." };
      return { ok: true as const, id: data.id };
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        return { ok: false as const, error: "Resend timed out." };
      }
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Could not reach Resend.",
      };
    }
  });
}

/**
 * Send, and never let the failure escape.
 *
 * Every caller of this feature is doing something else that matters more: finishing
 * a campaign, answering a cron, saving a preference. A rate limit or a bad key must
 * not turn any of those into a 500, and must not stop the next recipient getting
 * theirs. Same posture as `autoPromote` in the tagging route.
 *
 * The address is never logged. `lib/log.ts` bans candidate PII because the
 * population is minors; a teammate's address is a lesser matter and the same rule
 * costs nothing to keep.
 */
export async function trySend(
  who: string,
  m: { to: string; subject: string; html: string; text: string }
): Promise<boolean> {
  try {
    const r = await sendEmail(m);
    if (!r.ok) {
      log.warn("email.failed", { who, error: r.error });
      return false;
    }
    log.info("email.sent", { who, id: r.id });
    return true;
  } catch (e) {
    log.warn("email.failed", { who, error: e instanceof Error ? e.message : "unknown" });
    return false;
  }
}
