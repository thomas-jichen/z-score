"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Person, Marks } from "@/lib/people";

/**
 * Watches one enrichment run.
 *
 * Polls until the run reaches a terminal state, then hands the results to
 * `onDone` exactly once. The server has already written them to the roster by
 * that point; this delivery is so the UI can react — refresh the local copy and
 * offer the next hop.
 *
 * `delivered` guards against React re-running the effect and applying the same
 * batch twice, which would double-count a hop.
 *
 * Reattaching to a stored job id is the same code path as starting one, which is
 * what makes a mid-run reload recoverable. This lives in the app-wide provider
 * rather than on the sweep screen, so navigating away no longer kills the poll.
 */

export type JobPhase = "idle" | "running" | "done" | "error";

export type JobResult = { people: Person[]; marks?: Marks; newSlugs: string[] };

const POLL_MS = 3000;
/** ~10 minutes. A run still alive past this is stuck, not slow. */
const MAX_POLLS = 200;

export function useEnrichJob(onDone: (result: JobResult) => void) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [phase, setPhase] = useState<JobPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  const delivered = useRef<Set<string>>(new Set());
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const watch = useCallback((id: string, expected = 0) => {
    setJobId(id);
    setPhase("running");
    setError(null);
    setNote(null);
    setCount(expected);
  }, []);

  const reset = useCallback(() => {
    setJobId(null);
    setPhase("idle");
    setError(null);
    setNote(null);
    setCount(0);
  }, []);

  useEffect(() => {
    if (!jobId || phase !== "running") return;

    let alive = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      if (!alive) return;

      if (++polls > MAX_POLLS) {
        setPhase("error");
        setError("Enrichment is taking unusually long. Check the run in your Apify console.");
        return;
      }

      try {
        const res = await fetch(`/api/enrich?jobId=${encodeURIComponent(jobId!)}`);
        const data = await res.json().catch(() => ({}));
        if (!alive) return;

        if (!res.ok) {
          /**
           * A 5xx with no explanation is the server having a bad moment, not the
           * run failing. Keep polling: Apify is still working and the run is
           * already paid for. Only a 4xx is a real verdict — the job is gone, or
           * this teammate cannot see it.
           */
          if (res.status >= 500) {
            setNote("Lost contact with the server. Still watching the run.");
            timer = setTimeout(tick, POLL_MS);
            return;
          }
          setPhase("error");
          setError(data.error ?? `Enrichment failed (${res.status})`);
          return;
        }
        if (data.status === "error") {
          setPhase("error");
          setError(data.error ?? "The enrichment run failed.");
          return;
        }

        if (data.status === "done") {
          if (!delivered.current.has(jobId!)) {
            delivered.current.add(jobId!);
            onDoneRef.current({
              people: (data.people ?? []) as Person[],
              marks: data.marks as Marks | undefined,
              newSlugs: (data.newSlugs ?? []) as string[],
            });
          }
          setPhase("done");
          return;
        }

        // A transient poll failure is surfaced without ending the run.
        setNote(data.note ?? null);
        timer = setTimeout(tick, POLL_MS);
      } catch {
        if (!alive) return;
        setNote("Lost contact while polling. Retrying.");
        timer = setTimeout(tick, POLL_MS);
      }
    }

    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [jobId, phase]);

  return { jobId, phase, error, note, count, watch, reset };
}
