import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifyToken } from "@/lib/auth";
import { PROFILE_COOKIE, isProfileId } from "@/lib/profiles";

/**
 * Which of the three people is using the tool. Deliberately not httpOnly —
 * this is a preference, not a credential. The passphrase cookie is the gate.
 */

async function signedIn() {
  const jar = await cookies();
  return verifyToken(jar.get(COOKIE_NAME)?.value);
}

export async function POST(req: Request) {
  if (!(await signedIn())) {
    return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  const { profile } = (await req.json().catch(() => ({}))) as { profile?: string };
  if (!isProfileId(profile)) {
    return NextResponse.json({ ok: false, error: "Unknown profile." }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true, profile });
  res.cookies.set(PROFILE_COOKIE, profile, {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PROFILE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
