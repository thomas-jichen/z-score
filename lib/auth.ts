import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { COOKIE_NAME } from "./session";
import { PROFILE_COOKIE, isProfileId, type ProfileId } from "./profiles";

export { COOKIE_NAME } from "./session";

/**
 * Signing secret.
 *
 * This used to fall back to a hardcoded string, which means a deploy that
 * forgot ZSCORE_SESSION_SECRET would sign session cookies with a value
 * published in the repo — anyone could mint a valid session. Development still
 * gets a convenience fallback; production fails closed instead.
 */
function secret(): string {
  const explicit = process.env.ZSCORE_SESSION_SECRET || process.env.ZSCORE_PASSPHRASE;
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ZSCORE_SESSION_SECRET is not set. Set it in the Vercel project before deploying."
    );
  }
  return "dev-only-insecure-secret";
}

/**
 * Signed cookie value rather than a raw flag, so it can't be forged by simply
 * setting the cookie in devtools. Content is just an issue timestamp.
 */
export function issueToken(): string {
  const payload = String(Date.now());
  const sig = createHmac("sha256", secret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;

  const expected = createHmac("sha256", secret()).update(payload).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const issued = Number(payload);
  return Number.isFinite(issued) && Date.now() - issued < MAX_AGE_MS;
}

export function checkPassphrase(input: string): boolean {
  const expected = process.env.ZSCORE_PASSPHRASE;
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The two gates every data route needs, resolved once.
 *
 * 409 rather than a redirect when no profile is chosen, so a fetch gets a
 * usable error instead of a page of HTML.
 */
export async function resolveProfile(): Promise<
  { profile: ProfileId } | { error: string; status: number }
> {
  const jar = await cookies();
  if (!verifyToken(jar.get(COOKIE_NAME)?.value)) {
    return { error: "Not signed in.", status: 401 };
  }
  const profile = jar.get(PROFILE_COOKIE)?.value;
  if (!isProfileId(profile)) return { error: "No profile selected.", status: 409 };
  return { profile };
}
