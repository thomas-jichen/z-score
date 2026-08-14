import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME } from "@/lib/session";
import { PROFILE_COOKIE } from "@/lib/profiles";

/**
 * Two gates, in order: the shared passphrase, then which of us is using it.
 *
 * Presence checks only — the cryptographic verification happens in the route
 * handlers, which run on Node and can use node:crypto.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always reachable: the gate itself, and the endpoints that open it.
  if (
    pathname.startsWith("/unlock") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/profile")
  ) {
    return NextResponse.next();
  }

  const redirect = (to: string) => {
    const url = req.nextUrl.clone();
    url.pathname = to;
    url.search = "";
    return NextResponse.redirect(url);
  };

  if (!req.cookies.get(COOKIE_NAME)?.value) return redirect("/unlock");

  // Signed in but nobody picked yet. /api/state answers 409 instead of
  // redirecting, so a fetch gets a usable error rather than HTML.
  if (!req.cookies.get(PROFILE_COOKIE)?.value && !pathname.startsWith("/profiles")) {
    if (pathname.startsWith("/api/")) return NextResponse.next();
    return redirect("/profiles");
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png).*)"],
};
