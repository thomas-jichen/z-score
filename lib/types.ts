/** One sweep is one query, so a Shard is just the query the run executes. */
export type Shard = {
  id: string;
  query: string;
};

/** One profile as seen from the SERP. No LinkedIn data beyond what Google indexed. */
export type Hit = {
  slug: string;
  name: string;
  headline: string;
  url: string;
  snippet: string;
  /** Shard ids that surfaced this person. Length is the cross-shard corroboration count. */
  matchedShards: string[];
  /** Graduation year inferred from the snippet or headline, if one is stated. */
  inferredYear?: string;
};

export type ShardResult = {
  shardId: string;
  count: number;
  hits: Hit[];
  error?: string;
};

export type SweepStats = {
  shardsRun: number;
  shardsEmpty: number;
  rawHits: number;
  uniqueHits: number;
};
