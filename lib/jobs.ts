import { get, set } from "./store";
import type { ProfileId } from "./profiles";
import type { Provenance } from "./enrichment";

/**
 * An enrichment run in flight.
 *
 * Kept in the KV store rather than in the profile document for two reasons:
 * a run outlives the request that started it, and a job record is written on a
 * different cadence from the rest of a person's state — mixing them would mean
 * every poll rewrites the whole document.
 *
 * Keys are namespaced per profile, matching `stateKey`, so Cory's runs and
 * Grace's runs can never collide.
 */

export type JobStatus = "running" | "done" | "error";

export type EnrichJob = {
  id: string;
  profile: ProfileId;
  /** Which path started it. Only affects how results are labelled. */
  kind: "serp" | "seed";
  runId: string;
  datasetId: string;
  /** Slugs sent to the actor. Also the mock-mode input. */
  slugs: string[];
  /** Provenance per slug, so a mixed batch keeps per-candidate attribution. */
  provenance: Record<string, Provenance>;
  hop: number;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  resultCount?: number;
};

export function jobKey(profile: ProfileId, id: string): string {
  return `zscore:job:${profile}:${id}`;
}

export function newJobId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function readJob(profile: ProfileId, id: string): Promise<EnrichJob | null> {
  return get<EnrichJob>(jobKey(profile, id));
}

export async function writeJob(job: EnrichJob): Promise<void> {
  await set(jobKey(job.profile, job.id), job);
}
