"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Archetype, Candidate } from "@/lib/zscore";
import type { Hit } from "@/lib/types";
import type { Selection } from "@/lib/query";
import type { Marks, Person, PersonStatus, Roster } from "@/lib/people";
import type { HopCandidate } from "@/lib/enrichment";
import { emptyState, emptyTeam, type ProfileState, type TeamState } from "@/lib/state";
import { scoreOne } from "@/lib/candidates";
import { useEnrichJob, type JobResult } from "@/components/useEnrichJob";

/**
 * One provider for the whole app, mounted in app/(app)/layout.tsx.
 *
 * Two things this fixes beyond deduplicating fetches.
 *
 * 1. **Enrichment survives navigation.** The poll used to live inside the sweep
 *    screen, so walking over to the queue mid-run unmounted the watcher and
 *    orphaned the job until you came back. It lives here now, and the nav shows
 *    its progress from any screen.
 * 2. **Writes cannot race.** Sends are serialised through a promise chain, and
 *    patches made before the initial GET resolves are buffered and replayed on
 *    top of the loaded document rather than overwriting it with a value derived
 *    from nothing.
 *
 * Roster operations go through /api/people, which owns the merge, so the client
 * never ships a copy of the roster back. Marks are applied optimistically and
 * rolled back if the write fails, because a star should feel instant.
 */

type MarkChange = { status?: PersonStatus; pinned?: boolean; note?: string };

type AppStateValue = {
  loading: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  storage: "redis" | "file" | null;
  /** Writes will not survive. Shown as a banner rather than failing silently. */
  ephemeral: boolean;

  state: ProfileState;
  team: TeamState;
  roster: Roster;
  marks: Marks;

  patch: (p: Partial<ProfileState>) => void;
  patchTeam: (p: Partial<TeamState>) => void;

  addHits: (hits: Hit[], query: string, selection: Selection) => Promise<boolean>;
  addSlugs: (slugs: string[], via?: { seedSlug: string; seedName: string }) => Promise<boolean>;
  /** Queue People Also Viewed neighbours, keeping the name and position they came with. */
  addNeighbors: (people: HopCandidate[], hop: number) => Promise<boolean>;
  mark: (slugs: string[], change: MarkChange) => Promise<boolean>;
  setCluster: (slug: string, cluster: Archetype | null) => Promise<boolean>;
  editTerms: (slug: string, change: { add?: string[]; remove?: string[] }) => Promise<boolean>;
  removePeople: (slugs: string[]) => Promise<boolean>;
  resetAll: () => Promise<boolean>;

  enrich: (
    slugs: string[],
    opts: { kind: "serp" | "seed"; hop: number; query?: string; via?: Record<string, { seedSlug: string; seedName: string }> }
  ) => Promise<boolean>;
  job: ReturnType<typeof useEnrichJob>;
  /** The most recent completed batch, so the sweep screen can offer the next hop. */
  lastBatch: { people: Person[]; at: number } | null;

  analyze: (slugs: string[], force?: boolean) => Promise<{ tagged: number; terms: number } | null>;
  analyzing: boolean;
  taggerEnabled: boolean | null;

  candidates: Candidate[];
  bySlug: Map<string, Candidate>;
  /** Everything the viewer has queued, pinned first then by score. */
  queue: Candidate[];
  knownCount: number;
  rejectedCount: number;
};

const Ctx = createContext<AppStateValue | null>(null);

export function useApp(): AppStateValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside <AppStateProvider>");
  return v;
}

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ProfileState>(emptyState);
  const [team, setTeam] = useState<TeamState>(emptyTeam);
  const [roster, setRoster] = useState<Roster>({});
  const [marks, setMarks] = useState<Marks>({});
  const [loading, setLoading] = useState(true);
  const [storage, setStorage] = useState<"redis" | "file" | null>(null);
  const [ephemeral, setEphemeral] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastBatch, setLastBatch] = useState<{ people: Person[]; at: number } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [taggerEnabled, setTaggerEnabled] = useState<boolean | null>(null);

  const loaded = useRef(false);
  const buffered = useRef<Partial<ProfileState>[]>([]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  /* ── Personal document ────────────────────────────────────────────────── */

  const send = useCallback((update: Partial<ProfileState>) => {
    queue.current = queue.current
      .then(() =>
        fetch("/api/state", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        })
      )
      .then(async (res) => {
        if (res && !res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error ?? "Could not save.");
        } else {
          setError(null);
        }
      })
      .catch(() => setError("Could not save."));
  }, []);

  const patch = useCallback(
    (update: Partial<ProfileState>) => {
      setState((prev) => ({ ...prev, ...update }));
      if (!loaded.current) {
        buffered.current.push(update);
        return;
      }
      send(update);
    },
    [send]
  );

  const patchTeam = useCallback((update: Partial<TeamState>) => {
    setTeam((prev) => ({
      ...prev,
      ...update,
      taxonomy: { ...prev.taxonomy, ...(update.taxonomy ?? {}) },
      customTerms: { ...prev.customTerms, ...(update.customTerms ?? {}) },
    }));
    queue.current = queue.current
      .then(() =>
        fetch("/api/team", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        })
      )
      .then(async (res) => {
        if (res && !res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error ?? "Could not save the taxonomy.");
        }
      })
      .catch(() => setError("Could not save the taxonomy."));
  }, []);

  /* ── Initial load ─────────────────────────────────────────────────────── */

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/state");
        const data = await res.json().catch(() => ({}));
        if (!alive) return;

        if (res.status === 409) {
          window.location.href = "/profiles";
          return;
        }
        if (!res.ok || !data.state) {
          setError(data.error ?? "Could not load your data.");
          setLoading(false);
          return;
        }

        // Replay anything done while this was in flight, so the action is not
        // lost and the stored document is not clobbered.
        const replay = buffered.current;
        buffered.current = [];
        const merged = replay.reduce<ProfileState>(
          (acc, p) => ({ ...acc, ...p }),
          data.state as ProfileState
        );

        setState(merged);
        setRoster((data.roster ?? {}) as Roster);
        setTeam((data.team ?? emptyTeam()) as TeamState);
        setMarks((data.state as ProfileState).marks ?? {});
        setStorage(data.storage ?? null);
        setEphemeral(Boolean(data.ephemeral));
        loaded.current = true;
        setLoading(false);

        for (const p of replay) send(p);
      } catch {
        if (alive) {
          setError("Could not load your data.");
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [send]);

  // Whether new-term discovery is available, so screens can say so instead of
  // showing an empty panel that looks broken.
  useEffect(() => {
    let alive = true;
    fetch("/api/tag")
      .then((r) => r.json())
      .then((d) => alive && setTaggerEnabled(Boolean(d?.enabled)))
      .catch(() => alive && setTaggerEnabled(false));
    return () => {
      alive = false;
    };
  }, []);

  /* ── Roster operations ────────────────────────────────────────────────── */

  const op = useCallback(async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "That did not work.");
        return null;
      }
      setError(null);
      if (data.marks) setMarks(data.marks as Marks);
      return data as Record<string, unknown>;
    } catch {
      setError("Network error.");
      return null;
    }
  }, []);

  /** Pull the roster again after the server has changed it. */
  const refreshRoster = useCallback(async () => {
    try {
      const res = await fetch("/api/people");
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.roster) {
        setRoster(data.roster as Roster);
        if (data.team) setTeam(data.team as TeamState);
        if (data.marks) setMarks(data.marks as Marks);
      }
    } catch {
      /* a failed refresh leaves the last good copy in place */
    }
  }, []);

  const addHits = useCallback(
    async (hits: Hit[], query: string, selection: Selection) => {
      const r = await op({ op: "addHits", hits, query, selection });
      if (r) await refreshRoster();
      return Boolean(r);
    },
    [op, refreshRoster]
  );

  const addSlugs = useCallback(
    async (slugs: string[], via?: { seedSlug: string; seedName: string }) => {
      const r = await op({ op: "addSlugs", slugs, ...(via ?? {}) });
      if (r) await refreshRoster();
      return Boolean(r);
    },
    [op, refreshRoster]
  );

  /**
   * Queue neighbours rather than bare slugs.
   *
   * People Also Viewed already told us each neighbour's name and position, and
   * each one may have come from a different profile, so attribution is per person
   * instead of one value shared across the batch.
   */
  const addNeighbors = useCallback(
    async (people: HopCandidate[], hop: number) => {
      if (people.length === 0) return true;
      const r = await op({
        op: "addSlugs",
        people: people.map((n) => ({
          slug: n.slug,
          name: n.name,
          position: n.position,
          seedSlug: n.seedSlug,
          seedName: n.seedName,
        })),
        hop,
      });
      if (r) await refreshRoster();
      return Boolean(r);
    },
    [op, refreshRoster]
  );

  /**
   * Optimistic: a star has to feel instant. The previous marks are held so a
   * failed write puts the row back rather than leaving the UI lying.
   */
  const mark = useCallback(
    async (slugs: string[], change: MarkChange) => {
      const previous = marks;
      const at = new Date().toISOString();
      const next: Marks = { ...marks };
      for (const slug of slugs) {
        next[slug] = { ...(next[slug] ?? { status: "queued", at }), ...change, at };
      }
      setMarks(next);

      const r = await op({ op: "mark", slugs, ...change });
      if (!r) setMarks(previous);
      return Boolean(r);
    },
    [marks, op]
  );

  const setCluster = useCallback(
    async (slug: string, cluster: Archetype | null) => {
      const r = await op({ op: "setCluster", slug, cluster });
      if (r?.person) setRoster((prev) => ({ ...prev, [slug]: r.person as Person }));
      return Boolean(r);
    },
    [op]
  );

  const editTerms = useCallback(
    async (slug: string, change: { add?: string[]; remove?: string[] }) => {
      const r = await op({ op: "terms", slug, ...change });
      if (r?.person) setRoster((prev) => ({ ...prev, [slug]: r.person as Person }));
      return Boolean(r);
    },
    [op]
  );

  /**
   * Erase people for good: the roster row, the archived payload, and the mark.
   *
   * The server also blocks the slugs so nothing re-adds them, and hands back the fresh
   * team document with the response — otherwise the restore list on the taxonomy
   * screen would not show the deletion until a reload. `op` applies the marks.
   */
  const removePeople = useCallback(
    async (slugs: string[]) => {
      const r = await op({ op: "delete", slugs });
      if (r) {
        setRoster((prev) => {
          const next = { ...prev };
          for (const s of slugs) delete next[s];
          return next;
        });
        if (r.team) setTeam(r.team as TeamState);
      }
      return Boolean(r);
    },
    [op]
  );

  const resetAll = useCallback(async () => {
    const r = await op({ op: "reset" });
    if (r) setRoster({});
    return Boolean(r);
  }, [op]);

  /* ── Tagger ───────────────────────────────────────────────────────────── */

  const analyze = useCallback(
    async (slugs: string[], force = false) => {
      if (slugs.length === 0) return null;
      setAnalyzing(true);
      try {
        const res = await fetch("/api/tag", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slugs, force }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error ?? "Tagging failed.");
          return null;
        }
        if (Array.isArray(data.people)) {
          setRoster((prev) => {
            const next = { ...prev };
            for (const p of data.people as Person[]) next[p.slug] = p;
            return next;
          });
        }
        return { tagged: Number(data.tagged ?? 0), terms: Number(data.terms ?? 0) };
      } catch {
        setError("Network error while tagging.");
        return null;
      } finally {
        setAnalyzing(false);
      }
    },
    []
  );

  /* ── Enrichment ───────────────────────────────────────────────────────── */

  const onJobDone = useCallback(
    (result: JobResult) => {
      if (result.marks) setMarks(result.marks);
      if (result.people.length > 0) {
        setRoster((prev) => {
          const next = { ...prev };
          for (const p of result.people) next[p.slug] = p;
          return next;
        });
        setLastBatch({ people: result.people, at: Date.now() });
      }
      patch({ activeJobId: null });

      // Tag the new profiles straight away, so the graph and the taxonomy
      // review queue are populated without anyone remembering to ask.
      if (result.newSlugs.length > 0) void analyze(result.newSlugs);
    },
    [patch, analyze]
  );

  const job = useEnrichJob(onJobDone);

  const enrich = useCallback(
    async (
      slugs: string[],
      opts: {
        kind: "serp" | "seed";
        hop: number;
        query?: string;
        via?: Record<string, { seedSlug: string; seedName: string }>;
      }
    ) => {
      if (slugs.length === 0) return false;
      try {
        const res = await fetch("/api/enrich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slugs, ...opts }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error ?? `Could not start enrichment (${res.status})`);
          return false;
        }
        setError(null);
        patch({ activeJobId: data.jobId });
        job.watch(data.jobId, slugs.length);
        return true;
      } catch {
        setError("Network error.");
        return false;
      }
    },
    [job, patch]
  );

  // Reattach to a run that was still going when the tab was closed.
  const reattached = useRef(false);
  useEffect(() => {
    if (loading || reattached.current) return;
    reattached.current = true;
    if (state.activeJobId) job.watch(state.activeJobId);
    // Read once on the load transition; job.watch is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  /* ── Derived ──────────────────────────────────────────────────────────── */

  const candidates = useMemo(
    () => Object.values(roster).map((p) => scoreOne(p, team.taxonomy)),
    [roster, team.taxonomy]
  );

  const bySlug = useMemo(
    () => new Map(candidates.map((c) => [c.slug, c])),
    [candidates]
  );

  /**
   * The queue: everyone not triaged out.
   *
   * An absent mark means "queued", not "nowhere". Marks are only written when
   * someone acts, so a person added by a teammate — or added before marks were
   * per-teammate — has none, and treating that as excluded made three screens
   * disagree: the queue screen defaulted an absent mark to "queued" and listed 19
   * people, while this defaulted it to nothing, so the nav badge and the digest
   * both said 2. Same roster, three numbers.
   *
   * The queue screen's reading is the correct one: enriching someone is an
   * implicit "I want this person", and only `known` or `rejected` is a decision to
   * take them out.
   */
  const queueList = useMemo(() => {
    const rows = candidates.filter((c) => (marks[c.slug]?.status ?? "queued") === "queued");
    return rows.sort((a, b) => {
      const pa = marks[a.slug]?.pinned ? 1 : 0;
      const pb = marks[b.slug]?.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return b.score - a.score;
    });
  }, [candidates, marks]);

  const knownCount = useMemo(
    () => Object.values(marks).filter((m) => m.status === "known").length,
    [marks]
  );
  const rejectedCount = useMemo(
    () => Object.values(marks).filter((m) => m.status === "rejected").length,
    [marks]
  );

  const value: AppStateValue = {
    loading,
    error,
    setError,
    storage,
    ephemeral,
    state,
    team,
    roster,
    marks,
    patch,
    patchTeam,
    addHits,
    addSlugs,
    addNeighbors,
    mark,
    setCluster,
    editTerms,
    removePeople,
    resetAll,
    enrich,
    job,
    lastBatch,
    analyze,
    analyzing,
    taggerEnabled,
    candidates,
    bySlug,
    queue: queueList,
    knownCount,
    rejectedCount,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
