"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { findProfile, PROFILE_COOKIE, type Profile } from "@/lib/profiles";
import { useApp } from "@/components/AppState";

/**
 * Top horizontal nav: wordmark left, links centre, identity and CTA right.
 * Derived from how zfellows.com structures its own navigation, deliberately not
 * a sidebar.
 *
 * The run indicator is the reason this reads app state: enrichment now continues
 * across navigation, so there has to be somewhere that says so from every screen.
 */

const LINKS = [
  { href: "/digest", label: "Digest" },
  { href: "/queue", label: "Queue" },
  { href: "/graph", label: "Graph" },
  { href: "/taxonomy", label: "Taxonomy" },
];

function readProfileCookie(): Profile | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${PROFILE_COOKIE}=([^;]*)`));
  return findProfile(match ? decodeURIComponent(match[1]) : undefined);
}

export function Nav() {
  const pathname = usePathname();
  const { job, analyzing, queue } = useApp();
  const [profile, setProfile] = useState<Profile | undefined>(undefined);

  // Read on the client only; the cookie is not available during SSR here and
  // rendering it server-side would mismatch on hydrate.
  useEffect(() => setProfile(readProfileCookie()), [pathname]);

  async function switchProfile() {
    await fetch("/api/profile", { method: "DELETE" });
    window.location.href = "/profiles";
  }

  const running = job.phase === "running";

  return (
    <header className="z-nav">
      <nav className="z-nav-inner">
        <Link href="/digest" className="z-wordmark">
          Z-Score
        </Link>

        <div className="z-nav-links">
          {LINKS.map((l) => {
            const active = pathname === l.href || pathname.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                className="z-nav-link"
                aria-current={active ? "page" : undefined}
              >
                {l.label}
                {l.href === "/queue" && queue.length > 0 && (
                  <span className="z-nav-count">{queue.length}</span>
                )}
              </Link>
            );
          })}
        </div>

        <div className="z-row" style={{ gap: "var(--z-space-3)" }}>
          {(running || analyzing) && (
            <Link href="/sweep" className="z-runpill" title="An enrichment run is in progress">
              <span className="z-runpill-dot" aria-hidden="true" />
              <span className="z-hide-mobile">
                {running ? `Enriching${job.count ? ` ${job.count}` : ""}` : "Tagging"}
              </span>
            </Link>
          )}
          {profile && (
            <button
              className="z-whoami"
              onClick={switchProfile}
              title={`Signed in as ${profile.name}. Click to switch.`}
            >
              <span className="z-whoami-avatar" aria-hidden="true">
                {profile.initial}
              </span>
              <span className="z-small z-hide-mobile" style={{ color: "var(--z-ink-nav)" }}>
                {profile.name}
              </span>
            </button>
          )}
          <Link href="/sweep" className="z-btn is-sm z-hide-mobile">
            Run sweep
          </Link>
        </div>
      </nav>
    </header>
  );
}
