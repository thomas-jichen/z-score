"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PROFILES, type ProfileId } from "@/lib/profiles";

export default function ProfilePicker() {
  const router = useRouter();
  const [busy, setBusy] = useState<ProfileId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(id: ProfileId) {
    setBusy(id);
    setError(null);
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: id }),
    });
    if (res.ok) {
      router.push("/digest");
      router.refresh();
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "That didn't work.");
      setBusy(null);
    }
  }

  return (
    <main className="z-picker-wrap">
      <div className="z-picker">
        <h1 className="z-h2" style={{ textAlign: "center" }}>
          Who&apos;s looking?
        </h1>

        <div className="z-picker-row">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              className="z-profile"
              onClick={() => choose(p.id)}
              disabled={busy !== null}
              aria-busy={busy === p.id}
            >
              <span className="z-profile-avatar" aria-hidden="true">
                {p.initial}
              </span>
              <span className="z-profile-name">{p.name}</span>
            </button>
          ))}
        </div>

        {error && (
          <p className="z-small" style={{ color: "var(--z-navy)", textAlign: "center" }}>
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
