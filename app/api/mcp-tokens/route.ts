import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { listTokens, mintToken, revokeToken } from "@/lib/mcpTokens";
import { migrateIfNeeded } from "@/lib/serverState";
import { isBad, readJson, str } from "@/lib/validate";
import { log } from "@/lib/log";

/**
 * Minting and revoking the MCP bearer tokens, from the browser only.
 *
 * Cookie-authenticated on purpose: a token is the thing that gets you in without
 * a cookie, so the door that hands them out cannot accept one. There is
 * deliberately no way to mint a token by presenting a token.
 */

type Body = { op: "create"; label?: unknown } | { op: "revoke"; hash?: unknown };

export async function GET() {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  try {
    await migrateIfNeeded();
    return NextResponse.json({ ok: true, tokens: await listTokens() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Store read failed." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  const body = await readJson<Body>(req);
  if (isBad(body)) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });

  try {
    await migrateIfNeeded();

    if (body.op === "create") {
      const { token, hash, record } = await mintToken(r.profile, str(body.label, 60));
      log.info("mcp.token.created", { owner: r.profile });
      // The only time the plain token exists outside the caller's clipboard.
      return NextResponse.json({ ok: true, token, hash, record });
    }

    if (body.op === "revoke") {
      const hash = str(body.hash, 64);
      const existing = (await listTokens()).find((t) => t.hash === hash);
      if (!existing) {
        return NextResponse.json({ ok: false, error: "No such token." }, { status: 404 });
      }
      /**
       * Anyone may revoke any token.
       *
       * Deliberate. A leaked credential is a team problem, and making Grace wait
       * for Cory to come back before she can close a door is the wrong trade.
       */
      await revokeToken(hash);
      log.warn("mcp.token.revoked", { by: r.profile, owner: existing.owner });
      return NextResponse.json({ ok: true, tokens: await listTokens() });
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Store write failed." },
      { status: 500 }
    );
  }
}
