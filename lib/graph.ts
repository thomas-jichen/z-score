import type { Archetype, Candidate } from "./zscore";
import type { Person, Roster } from "./people";
import type { TaxonomyPrefs } from "./state";
import { allTags, type Tag, type TagKind } from "./tags";

/**
 * The graph.
 *
 * ── Why tags are nodes ────────────────────────────────────────────────────
 * Connecting every pair of people who share a tag grows edges quadratically, so
 * a hundred people is already an unreadable hairball. Making tags nodes and
 * linking each person only to their own tags is linear instead, and it shows
 * *which* credential connects a cluster rather than leaving you to hover an edge
 * and guess.
 *
 * ── The rarity window, which is what keeps it legible ─────────────────────
 * A tag held by most of the roster is not information. "Class of 2028" as a hub
 * drags everything into one blob and buries the structure. So a tag only becomes
 * a node while between MIN and MAX people hold it: below that it is a lone
 * pendant adding noise, above that it is background and belongs in the grouping
 * and the colour instead. Both bounds are adjustable in the UI, and anything
 * dropped is reported rather than silently disappearing.
 *
 * ── Why the layout is seeded rather than simulated live ───────────────────
 * Positions come from a hash of the node id, then a fixed number of iterations,
 * then a freeze. The graph is therefore identical across reloads, which makes it
 * screenshot-able and comparable over time, and there is no animation loop
 * running behind the other screens. It also sidesteps the float-rounding
 * hydration class of bug entirely, because nothing is computed on the server.
 */

export const EDGE_SOURCES = ["program", "school", "year", "state", "discovery"] as const;
export type EdgeSource = (typeof EDGE_SOURCES)[number];

export const GROUP_BY = ["cluster", "year", "school", "state"] as const;
export type GroupBy = (typeof GROUP_BY)[number];

/** Above this a tag is background, not a connection. */
export const DEFAULT_MAX_HOLDERS = 8;
/** Below this a tag connects nobody to anybody. */
export const DEFAULT_MIN_HOLDERS = 2;
/** Beyond this the picture stops being readable at any zoom. */
export const NODE_CAP = 120;

export type PersonNode = {
  kind: "person";
  id: string;
  slug: string;
  label: string;
  initials: string;
  r: number;
  z: number;
  cluster: Archetype;
  polymath: boolean;
  enriched: boolean;
  group: string;
  x: number;
  y: number;
};

export type TagNode = {
  kind: "tag";
  id: string;
  label: string;
  tagKind: TagKind;
  count: number;
  r: number;
  group: string;
  x: number;
  y: number;
};

export type GraphNode = PersonNode | TagNode;
export type GraphEdge = { id: string; a: string; b: string; kind: "tag" | "discovery" | "affinity"; via?: string };

export type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** People left out by the cap, lowest-scoring first. Surfaced in the UI. */
  droppedPeople: number;
  /** Tags outside the rarity window, so the slider's effect is legible. */
  tooCommon: { label: string; count: number }[];
  tooRare: number;
  groups: string[];
};

export type GraphOptions = {
  sources: EdgeSource[];
  groupBy: GroupBy;
  showTags: boolean;
  minHolders: number;
  maxHolders: number;
  cap: number;
};

const KIND_FOR_SOURCE: Record<Exclude<EdgeSource, "discovery">, TagKind> = {
  program: "program",
  school: "school",
  year: "year",
  state: "state",
};

/* ── Deterministic randomness ───────────────────────────────────────────── */

/** FNV-1a. Stable across engines, unlike anything seeded from Math.random. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Two independent unit values from one id, for an initial angle and radius. */
function jitter(id: string): { a: number; b: number } {
  const h = hash(id);
  return { a: (h % 10000) / 10000, b: ((h >>> 13) % 10000) / 10000 };
}

const round = (v: number) => Math.round(v * 100) / 100;

/* ── Build ──────────────────────────────────────────────────────────────── */

function groupValue(c: Candidate, by: GroupBy): string {
  if (by === "year") return c.graduation_year ?? "Unknown year";
  if (by === "school") return c.school ?? "Unknown school";
  if (by === "state") return c.state ?? "Unknown state";
  return c.archetype;
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

export function buildGraph(
  candidates: Candidate[],
  roster: Roster,
  tax: TaxonomyPrefs,
  opts: GraphOptions
): Graph {
  // Highest-scoring first, so the cap drops the least interesting people rather
  // than an arbitrary slice.
  const ranked = [...candidates].sort((a, b) => b.z_score_normalized - a.z_score_normalized);
  const shown = ranked.slice(0, Math.max(1, opts.cap));
  const droppedPeople = ranked.length - shown.length;

  const wantKinds = new Set(
    opts.sources.filter((s): s is Exclude<EdgeSource, "discovery"> => s !== "discovery").map((s) => KIND_FOR_SOURCE[s])
  );
  // Extracted terms ride along with programs: they are credentials that simply
  // have not been promoted yet, and hiding them would make the tagger invisible.
  if (wantKinds.has("program")) wantKinds.add("extracted");

  // Tally holders per tag across the shown population only, so the rarity window
  // means what it says on screen.
  const holders = new Map<string, { tag: Tag; slugs: string[] }>();
  const tagsBySlug = new Map<string, Tag[]>();

  for (const c of shown) {
    const person: Person | undefined = roster[c.slug];
    if (!person) continue;
    const tags = allTags(person, tax).filter((t) => t.confirmed && wantKinds.has(t.kind));
    tagsBySlug.set(c.slug, tags);

    for (const t of tags) {
      const key = `${t.kind}:${t.label.toLowerCase()}`;
      const entry = holders.get(key) ?? { tag: t, slugs: [] };
      if (!entry.slugs.includes(c.slug)) entry.slugs.push(c.slug);
      holders.set(key, entry);
    }
  }

  const tooCommon: { label: string; count: number }[] = [];
  let tooRare = 0;
  const inWindow = new Map<string, { tag: Tag; slugs: string[] }>();

  for (const [key, entry] of holders) {
    const n = entry.slugs.length;
    if (n > opts.maxHolders) {
      tooCommon.push({ label: entry.tag.label, count: n });
      continue;
    }
    if (n < opts.minHolders) {
      tooRare++;
      continue;
    }
    inWindow.set(key, entry);
  }
  tooCommon.sort((a, b) => b.count - a.count);

  const groups = [...new Set(shown.map((c) => groupValue(c, opts.groupBy)))].sort();

  const personNodes: PersonNode[] = shown.map((c) => ({
    kind: "person",
    id: `p:${c.slug}`,
    slug: c.slug,
    label: c.name,
    initials: initialsOf(c.name),
    // Node size is the z-score, as before. Floored so a below-average person is
    // still clickable rather than a dot.
    r: round(7 + Math.min(Math.max(c.z_score_normalized, -1), 3.5) * 2.6),
    z: c.z_score_normalized,
    cluster: c.archetype,
    polymath: c.polymath,
    enriched: c.enriched,
    group: groupValue(c, opts.groupBy),
    x: 0,
    y: 0,
  }));

  const nodes: GraphNode[] = [...personNodes];
  const edges: GraphEdge[] = [];

  if (opts.showTags) {
    for (const [key, entry] of inWindow) {
      const id = `t:${key}`;
      nodes.push({
        kind: "tag",
        id,
        label: entry.tag.label,
        tagKind: entry.tag.kind,
        count: entry.slugs.length,
        r: round(4 + Math.sqrt(entry.slugs.length) * 1.7),
        group: "",
        x: 0,
        y: 0,
      });
      for (const slug of entry.slugs) {
        edges.push({ id: `${id}~${slug}`, a: id, b: `p:${slug}`, kind: "tag", via: entry.tag.label });
      }
    }
  } else {
    // Person-only mode. One edge per pair, weighted by how rare the shared tags
    // are, keeping only the strongest few per person so this does not collapse
    // back into the hairball the tag nodes exist to avoid.
    const weights = new Map<string, { a: string; b: string; w: number; via: string }>();
    for (const entry of inWindow.values()) {
      const idf = 1 / entry.slugs.length;
      for (let i = 0; i < entry.slugs.length; i++) {
        for (let j = i + 1; j < entry.slugs.length; j++) {
          const [x, y] = [entry.slugs[i], entry.slugs[j]].sort();
          const key = `${x}~${y}`;
          const prev = weights.get(key);
          // The rarest shared thing names the edge, since that is the
          // interesting one.
          const via = !prev || idf > 1 / entry.slugs.length ? entry.tag.label : prev.via;
          weights.set(key, { a: x, b: y, w: (prev?.w ?? 0) + idf, via: prev ? prev.via : via });
        }
      }
    }

    const perPerson = new Map<string, { key: string; w: number }[]>();
    for (const [key, e] of weights) {
      for (const slug of [e.a, e.b]) {
        const list = perPerson.get(slug) ?? [];
        list.push({ key, w: e.w });
        perPerson.set(slug, list);
      }
    }
    const keep = new Set<string>();
    for (const list of perPerson.values()) {
      list.sort((x, y) => y.w - x.w);
      for (const item of list.slice(0, 3)) keep.add(item.key);
    }
    for (const key of keep) {
      const e = weights.get(key)!;
      edges.push({ id: `a:${key}`, a: `p:${e.a}`, b: `p:${e.b}`, kind: "affinity", via: e.via });
    }
  }

  // Discovery edges are factual: this person was found on that person's People
  // Also Viewed. Always drawn when enabled, and never subject to the rarity
  // window, because they are not inferred.
  if (opts.sources.includes("discovery")) {
    const present = new Set(shown.map((c) => c.slug));
    for (const c of shown) {
      const via = roster[c.slug]?.discoveredVia;
      if (via?.kind !== "pav") continue;
      if (!present.has(via.seedSlug) || via.seedSlug === c.slug) continue;
      edges.push({
        id: `d:${via.seedSlug}~${c.slug}`,
        a: `p:${via.seedSlug}`,
        b: `p:${c.slug}`,
        kind: "discovery",
        via: "People also viewed",
      });
    }
  }

  layout(nodes, edges, groups);

  return { nodes, edges, droppedPeople, tooCommon, tooRare, groups };
}

/* ── Layout ─────────────────────────────────────────────────────────────── */

const ITERATIONS = 240;
const WIDTH = 1000;
const HEIGHT = 620;

/**
 * Seeded force-directed layout, run once and frozen.
 *
 * Group anchors give the clusters somewhere to be, so the picture reads as
 * "these people belong together" rather than as one drifting mass. Tag nodes have
 * no anchor: they are pulled by whoever holds them, which is what makes a shared
 * credential sit visibly between its people.
 */
function layout(nodes: GraphNode[], edges: GraphEdge[], groups: string[]): void {
  if (nodes.length === 0) return;

  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const spread = Math.min(WIDTH, HEIGHT) * 0.34;

  // Anchors on a circle, in sorted group order, so the same data lands in the
  // same place every time.
  const anchors = new Map<string, { x: number; y: number }>();
  groups.forEach((g, i) => {
    const angle = (i / Math.max(groups.length, 1)) * Math.PI * 2 - Math.PI / 2;
    anchors.set(g, {
      x: cx + Math.cos(angle) * (groups.length === 1 ? 0 : spread),
      y: cy + Math.sin(angle) * (groups.length === 1 ? 0 : spread * 0.72),
    });
  });

  const px = new Float64Array(nodes.length);
  const py = new Float64Array(nodes.length);
  const index = new Map<string, number>();

  nodes.forEach((n, i) => {
    index.set(n.id, i);
    const anchor = n.kind === "person" ? anchors.get(n.group) : undefined;
    const base = anchor ?? { x: cx, y: cy };
    const { a, b } = jitter(n.id);
    const angle = a * Math.PI * 2;
    const dist = (0.25 + b * 0.75) * (n.kind === "person" ? 78 : 130);
    px[i] = base.x + Math.cos(angle) * dist;
    py[i] = base.y + Math.sin(angle) * dist;
  });

  const links = edges
    .map((e) => ({ a: index.get(e.a), b: index.get(e.b) }))
    .filter((l): l is { a: number; b: number } => l.a !== undefined && l.b !== undefined);

  const radius = nodes.map((n) => n.r);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const alpha = 1 - iter / ITERATIONS;

    // Repulsion. O(n²), which at a 120-person cap plus tag nodes is a few
    // million float operations once — cheap enough to do synchronously, and the
    // reason the cap exists.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = px[j] - px[i];
        let dy = py[j] - py[i];
        let d2 = dx * dx + dy * dy;
        if (d2 === 0) {
          // Two nodes exactly coincident would divide by zero. Nudge by a
          // deterministic amount rather than a random one.
          dx = ((i % 7) - 3) * 0.5 + 0.1;
          dy = ((j % 5) - 2) * 0.5 + 0.1;
          d2 = dx * dx + dy * dy;
        }
        if (d2 > 90000) continue;
        const d = Math.sqrt(d2);
        const min = radius[i] + radius[j] + 8;
        const force = (2600 * alpha) / d2 + (d < min ? (min - d) * 0.5 : 0);
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        px[i] -= fx;
        py[i] -= fy;
        px[j] += fx;
        py[j] += fy;
      }
    }

    // Attraction along edges.
    for (const l of links) {
      const dx = px[l.b] - px[l.a];
      const dy = py[l.b] - py[l.a];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const rest = 62;
      const force = (d - rest) * 0.045 * alpha;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      px[l.a] += fx;
      py[l.a] += fy;
      px[l.b] -= fx;
      py[l.b] -= fy;
    }

    // Anchor and centring pull.
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const target = n.kind === "person" ? (anchors.get(n.group) ?? { x: cx, y: cy }) : { x: cx, y: cy };
      const k = n.kind === "person" ? 0.035 : 0.006;
      px[i] += (target.x - px[i]) * k * alpha;
      py[i] += (target.y - py[i]) * k * alpha;
    }
  }

  // Fit to the viewBox with a margin, so the picture fills the canvas whatever
  // the group count did to its extent.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < nodes.length; i++) {
    minX = Math.min(minX, px[i] - radius[i]);
    maxX = Math.max(maxX, px[i] + radius[i]);
    minY = Math.min(minY, py[i] - radius[i]);
    maxY = Math.max(maxY, py[i] + radius[i]);
  }

  const pad = 24;
  const sx = (WIDTH - pad * 2) / Math.max(maxX - minX, 1);
  const sy = (HEIGHT - pad * 2) / Math.max(maxY - minY, 1);
  const s = Math.min(sx, sy, 1.6);

  for (let i = 0; i < nodes.length; i++) {
    nodes[i].x = round(pad + (px[i] - minX) * s);
    nodes[i].y = round(pad + (py[i] - minY) * s);
  }
}

export const VIEW_WIDTH = WIDTH;
export const VIEW_HEIGHT = HEIGHT;

/** Neighbours of one node, for hover isolation and the side panel. */
export function neighborsOf(edges: GraphEdge[], id: string): Set<string> {
  const out = new Set<string>([id]);
  for (const e of edges) {
    if (e.a === id) out.add(e.b);
    else if (e.b === id) out.add(e.a);
  }
  return out;
}
