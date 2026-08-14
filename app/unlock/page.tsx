"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/primitives";

export default function Unlock() {
  const router = useRouter();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      router.push("/digest");
      router.refresh();
    } else {
      setError(data.error ?? "That didn't work.");
      setBusy(false);
    }
  }

  return (
    <main className="z-unlock-wrap">
      <form className="z-unlock-card" onSubmit={submit}>
        <h1 className="z-h2">Z-Score</h1>
        <p className="z-body" style={{ marginTop: "var(--z-space-3)" }}>
          Every credential weighted by hand, and added up.
        </p>

        <input
          className="z-input"
          type="password"
          autoFocus
          placeholder="Passphrase"
          aria-label="Passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          style={{ margin: "var(--z-space-10) 0 var(--z-space-3)" }}
        />

        {error && (
          <p className="z-small" style={{ color: "var(--z-navy)", marginBottom: "var(--z-space-3)" }}>
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy || !passphrase} style={{ width: "100%" }}>
          {busy ? "Checking" : "Continue"}
        </Button>
      </form>
    </main>
  );
}
