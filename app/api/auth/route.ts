import { NextResponse } from "next/server";
import { COOKIE_NAME, checkPassphrase, issueToken } from "@/lib/auth";

export async function POST(req: Request) {
  const { passphrase } = (await req.json().catch(() => ({}))) as { passphrase?: string };

  if (!process.env.ZSCORE_PASSPHRASE) {
    return NextResponse.json(
      { ok: false, error: "ZSCORE_PASSPHRASE is not configured on the server." },
      { status: 500 }
    );
  }

  if (!passphrase || !checkPassphrase(passphrase)) {
    return NextResponse.json({ ok: false, error: "That passphrase doesn't match." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, issueToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
