import type { Archetype, Candidate } from "./zscore";
import type { Person, Roster } from "./people";
import type { TaxonomyPrefs } from "./state";
import { allTags, type Tag } from "./tags";
import type { TagFacet } from "./tagRegistry";

/**
 * The graph.
 *
 * ── What it is for ────────────────────────────────────────────────────────
 * Three questions, in the order they get asked:
 *
 *   1. Who in my queue is connected to whom, and *why*?
 *   2. Which of those connections is a place more talent lives?
 *   3. So where do I sweep next?
 *
 * Everything here earns its place against one of those. A control that only makes
 * the picture different, rather than answering one of them, has been removed.
 *
 * ── Why the shared thing can become a node ────────────────────────────────
 * Connecting every pair of people who share a tag grows edges quadratically, so a
 * hundred people is an unreadable hairball. Drawing the shared thing as its own
 * node and linking each person only to their own is linear instead, and it names
 * *which* credential connects a cluster rather than leaving you to hover an edge
 * and guess. Both readings are offered: People (person-to-person, the reason on
 * the edge) and Hubs (the shared thing drawn, labelled, in the middle).
 *
 * ── The rarity window, which is what keeps Hubs legible ───────────────────
 * A tag held by most of the roster is not a connection. "Stanford" across twelve
 * of twenty drags everything into one blob and buries the structure. So a tag is
 * only drawn as a hub while between MIN and MAX people hold it. Above the ceiling
 * it is not thrown away: it is exactly what `hubs` reports, because a thing
 * twelve of your best people share is the *best* lead you have, just a useless
 * line to draw.
 *
 * ── Why the layout is seeded rather than simulated live ───────────────────
 * Positions come from a hash of the node id, then a fixed number of iterations,
 * then a freeze. The graph is therefore identical across reloads, which makes it
 * screenshot-able and comparable over time, and there is no animation loop running
 * behind the other screens. It also sidesteps the float-rounding hydration class of
 * bug entirely, because nothing is computed on the server.
 */

/**
 * What counts as a link between two people.
 *
 * Ordered by how much a shared one actually tells you, strongest first.
 *
 * College is deliberately its own switch rather than folded in with high school.
 * A shared high school is rare and actionable — a local pipeline you can go and
 * sweep. A shared college is a hub: twelve of twenty are at Stanford, so drawing
 * it links most of the queue to most of the queue and says nothing about any pair
 * of them. One is a connection, the other is a fact about the population, and
 * they should not arrive together on one click.
 *
 * `year` and `state` used to be here and are gone for the same reason, without
 * the redemption: a shared class year produced a near-complete mesh. Both survive
 * under Group by, which is what a broad shared attribute is actually for.
 */
export const EDGE_SOURCES = [
  "discovery",
  "backing",
  "program",
  "company",
  "highschool",
  "college",
] as const;
export type EdgeSource = (typeof EDGE_SOURCES)[number];

/**
 * What pulls people together on the canvas.
 *
 * `none` is first and is the default: with no anchors the force layout is free to
 * let the connections themselves decide who sits near whom, which is the whole
 * point of drawing a graph. Anchoring by an attribute overrides that — it is a
 * deliberate second read ("show me the same links arranged by class year"), not a
 * sensible starting position.
 *
 * Current location is not offered. For students it is transient — an internship
 * city for ten weeks — whereas the home state inferred from their high school is
 * the durable fact and the one that describes a pipeline.
 */
export const GROUP_BY = ["none", "cluster", "year", "home"] as const;
export type GroupBy = (typeof GROUP_BY)[number];

/**
 * Above this a tag is background, not a connection. It becomes a lead instead.
 *
 * Twenty rather than eight, so the opening view shows the whole roster's shared
 * ground and the slider is used to *narrow* it. Eight hid Stanford, which is the
 * single most connected thing about this population and the first thing anyone
 * looks for.
 */
export const DEFAULT_MAX_HOLDERS = 20;
/** Below this a tag connects nobody to anybody. */
export const DEFAULT_MIN_HOLDERS = 2;
/** Beyond this the picture stops being readable at any zoom. */
export const NODE_CAP = 120;
/** Labelled hubs on the canvas. Past this the labels are the noise. */
export const MAX_HUB_NODES = 22;
/** Leads offered under the canvas. */
export const MAX_LEADS = 12;

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
  facet: TagFacet;
  count: number;
  /** Label box, so the de-overlap pass can keep two chips from colliding. */
  w: number;
  h: number;
  group: string;
  x: number;
  y: number;
};

export type GraphNode = PersonNode | TagNode;

export type GraphEdge = {
  id: string;
  a: string;
  b: string;
  kind: "tag" | "discovery" | "affinity";
  /** Every shared thing behind this link, rarest first. */
  reasons: string[];
  /** Σ 1/holders over the shared things. Drawn as stroke weight. */
  weight: number;
};

/**
 * One person's connections, ranked, with the reason attached.
 *
 * Computed whichever way the canvas is drawn, because "who is Grace connected to
 * and why" is a question about the data and not about the current view. This is
 * what the side panel reads.
 */
export type Link = { slug: string; reasons: string[]; weight: number };

/**
 * A lead: a thing several people in the queue share, ranked by how much talent it
 * has already produced.
 *
 * Ranked by talent rather than headcount on purpose. Three exceptional people out
 * of a programme that takes eighty a year is a better place to look than five
 * ordinary ones out of a university that takes seven thousand.
 */
export type Hub = {
  id: string;
  label: string;
  facet: TagFacet;
  count: number;
  slugs: string[];
  /** Σ score of the people who hold it. */
  talent: number;
};

export type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** People left out by the cap, lowest-scoring first. Surfaced in the UI. */
  droppedPeople: number;
  /** Ranked places to look for more of the same. */
  hubs: Hub[];
  /** Person-to-person connections with reasons, keyed by slug. */
  connections: Record<string, Link[]>;
  /** Tags outside the rarity window, so the window's effect stays legible. */
  tooCommon: { label: string; count: number }[];
  tooRare: number;
  /** Hubs in the window but past the label cap. */
  hubsNotDrawn: number;
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

/**
 * Which facets each link type draws on.
 *
 * Facets, not the coarser `TagKind`, because kind collapses company, major, title
 * and flag into one bucket — so asking for shared employers would also have linked
 * everyone who studied Computer Science or writes "Founder" in a headline, which
 * are the two densest tags in the roster and the least informative.
 */
const FACETS_FOR_SOURCE: Record<Exclude<EdgeSource, "discovery">, TagFacet[]> = {
  /**
   * The most valuable link on the canvas for talent discovery.
   *
   * Two people out of one YC batch have met, and the batch is a place with eighty
   * more of them in it. It is also the rarest kind of shared thing here, so it almost
   * never behaves like a hub.
   */
  backing: ["accelerator"],
  program: ["program"],
  company: ["company", "org"],
  highschool: ["highschool"],
  college: ["college"],
};

/**
 * Where a lead goes when you sweep for it.
 *
 * Companies and organisations have no menu of their own, so they go in with the
 * title keywords — which is not a fudge: that group is free text appended to the
 * query, and "Jane Street" as a keyword is exactly the right way to find more
 * people from Jane Street.
 */
export const SWEEP_KEY_FOR_FACET: Partial<Record<TagFacet, string>> = {
  program: "programs",
  accelerator: "programs",
  college: "colleges",
  highschool: "highSchools",
  company: "titles",
  org: "titles",
  title: "titles",
  major: "titles",
  state: "states",
  homestate: "homeStates",
  year: "years",
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

function groupValue(c: Candidate, tags: Tag[], by: GroupBy): string {
  if (by === "none") return "";
  if (by === "year") return c.graduation_year ? `Class of ${c.graduation_year}` : "Year unknown";
  if (by === "home") return tags.find((t) => t.facet === "homestate")?.label ?? "Home unknown";
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

const CHIP_H = 22;

/**
 * Advance width of a string at the 11.5px the canvas draws it.
 *
 * Per-character rather than `length * average`, because the average is wrong in
 * both directions at the same time: "USABO" is five wide capitals and "millimetre"
 * is ten narrow lowercase, and a chip sized by the average clips one and leaves the
 * other rattling. Approximate, deterministic, and no measurement API — which
 * matters, because the layout runs before anything is in the document.
 */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (" .,:;'`|!ijltfrI[]()-".includes(ch)) w += 3.6;
    else if ("mwMW@".includes(ch)) w += 10.2;
    else if (ch >= "A" && ch <= "Z") w += 7.6;
    else if (ch >= "0" && ch <= "9") w += 6.6;
    else w += 6.4;
  }
  return w;
}

/** Label, gap, count, and the padding either side. */
const chipWidth = (label: string, count: number) =>
  round(textWidth(label) + textWidth(String(count)) + 34);

export function buildGraph(
  candidates: Candidate[],
  roster: Roster,
  tax: TaxonomyPrefs,
  opts: GraphOptions
): Graph {
  // Highest-scoring first, so the cap drops the least interesting people rather
  // than an arbitrary slice.
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const shown = ranked.slice(0, Math.max(1, opts.cap));
  const droppedPeople = ranked.length - shown.length;

  const wantFacets = new Set<TagFacet>(
    opts.sources
      .filter((s): s is Exclude<EdgeSource, "discovery"> => s !== "discovery")
      .flatMap((s) => FACETS_FOR_SOURCE[s])
  );

  // Tally holders per tag across the shown population only, so the rarity window
  // means what it says on screen.
  const holders = new Map<string, { tag: Tag; slugs: string[] }>();
  const groupOf = new Map<string, string>();
  const scoreOf = new Map<string, number>();

  for (const c of shown) {
    const person: Person | undefined = roster[c.slug];
    if (!person) continue;
    const all = allTags(person, tax);
    groupOf.set(c.slug, groupValue(c, all, opts.groupBy));
    scoreOf.set(c.slug, c.score);

    // A tag with no facet came from a path outside the registry — an unpromoted
    // extracted term or a search chip — and has no link type to belong to.
    for (const t of all) {
      if (!t.confirmed || !t.facet || !wantFacets.has(t.facet)) continue;
      // Keyed by facet, matching how links are chosen. Kind would merge a company
      // and a major that happened to share a name into one node.
      const key = `${t.facet}:${t.label.toLowerCase()}`;
      const entry = holders.get(key) ?? { tag: t, slugs: [] };
      if (!entry.slugs.includes(c.slug)) entry.slugs.push(c.slug);
      holders.set(key, entry);
    }
  }

  const tooCommon: { label: string; count: number }[] = [];
  let tooRare = 0;
  const inWindow = new Map<string, { tag: Tag; slugs: string[] }>();
  const hubs: Hub[] = [];

  for (const [key, entry] of holders) {
    const n = entry.slugs.length;
    // Every tag two or more people share is a lead, whether or not it is drawable.
    // The ceiling exists to keep lines legible, not to hide information.
    if (n >= 2) {
      hubs.push({
        id: `t:${key}`,
        label: entry.tag.label,
        facet: entry.tag.facet!,
        count: n,
        slugs: entry.slugs,
        talent: round(entry.slugs.reduce((sum, s) => sum + (scoreOf.get(s) ?? 0), 0)),
      });
    }
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
  hubs.sort((a, b) => b.talent - a.talent || b.count - a.count || a.label.localeCompare(b.label));

  /**
   * Person-to-person connections, always computed.
   *
   * Both draw modes need this: People mode draws it as edges, Hubs mode does not
   * draw it at all but the panel still has to answer "why are these two together".
   * The rarest shared thing leads the reason list, since that is the one that means
   * something.
   */
  const pairs = new Map<string, { a: string; b: string; w: number; parts: { label: string; idf: number }[] }>();
  for (const entry of inWindow.values()) {
    const idf = 1 / entry.slugs.length;
    for (let i = 0; i < entry.slugs.length; i++) {
      for (let j = i + 1; j < entry.slugs.length; j++) {
        const [x, y] = [entry.slugs[i], entry.slugs[j]].sort();
        const key = `${x}~${y}`;
        const prev = pairs.get(key) ?? { a: x, b: y, w: 0, parts: [] };
        prev.w = round(prev.w + idf);
        prev.parts.push({ label: entry.tag.label, idf });
        pairs.set(key, prev);
      }
    }
  }
  for (const p of pairs.values()) p.parts.sort((m, n) => n.idf - m.idf);

  const connections: Record<string, Link[]> = {};
  const addLink = (from: string, to: string, reasons: string[], weight: number) => {
    const list = (connections[from] ??= []);
    const existing = list.find((l) => l.slug === to);
    if (existing) {
      for (const r of reasons) if (!existing.reasons.includes(r)) existing.reasons.push(r);
      existing.weight = round(existing.weight + weight);
    } else {
      list.push({ slug: to, reasons: [...reasons], weight });
    }
  };
  for (const p of pairs.values()) {
    const reasons = p.parts.map((x) => x.label);
    addLink(p.a, p.b, reasons, p.w);
    addLink(p.b, p.a, reasons, p.w);
  }

  const groups = opts.groupBy === "none" ? [] : [...new Set([...groupOf.values()])].sort();

  const personNodes: PersonNode[] = shown
    .filter((c) => roster[c.slug])
    .map((c) => ({
      kind: "person",
      id: `p:${c.slug}`,
      slug: c.slug,
      label: c.name,
      initials: initialsOf(c.name),
      /**
       * Size is the score, scaled against the top band rather than a fixed sigma
       * range. The old clamp to [-1, 3.5] was built for a standardised figure: on a
       * point total every node would have pinned at maximum radius.
       *
       * The floor is set by legibility, not by the data. Every node carries its
       * initials, so the smallest one still has to fit two capitals — below about ten
       * it does not, and an unlabelled circle is just a dot you have to hover to
       * identify. The range is still better than two to one, which is all the size
       * needs to say.
       */
      r: round(10.5 + Math.min(Math.max(c.score, 0) / Math.max(tax.bands.exceptional, 1), 1) * 10),
      z: c.score,
      cluster: c.archetype,
      polymath: c.polymath,
      enriched: c.enriched,
      group: groupOf.get(c.slug) ?? "",
      x: 0,
      y: 0,
    }));

  const nodes: GraphNode[] = [...personNodes];
  const edges: GraphEdge[] = [];
  let hubsNotDrawn = 0;

  if (opts.showTags) {
    /**
     * Draw the strongest hubs only, and label every one that is drawn.
     *
     * Both halves matter. Eighty unlabelled dots was the old behaviour and it was
     * unreadable: a hub whose name you cannot see is worse than no hub at all,
     * because it still costs a node and five edges. So the number drawn is capped
     * at what can carry a legible label, chosen by the same talent ranking as the
     * leads, and the layout then pushes the labels apart.
     */
    const drawable = hubs.filter((h) => inWindow.has(h.id.slice(2)));
    hubsNotDrawn = Math.max(0, drawable.length - MAX_HUB_NODES);
    for (const h of drawable.slice(0, MAX_HUB_NODES)) {
      nodes.push({
        kind: "tag",
        id: h.id,
        label: h.label,
        facet: h.facet,
        count: h.count,
        w: chipWidth(h.label, h.count),
        h: CHIP_H,
        group: "",
        x: 0,
        y: 0,
      });
      for (const slug of h.slugs) {
        edges.push({
          id: `${h.id}~${slug}`,
          a: h.id,
          b: `p:${slug}`,
          kind: "tag",
          reasons: [h.label],
          weight: 1 / h.count,
        });
      }
    }
  } else {
    // Person-only mode. Keep the strongest few links per person so this does not
    // collapse back into the hairball the hubs exist to avoid.
    const perPerson = new Map<string, { key: string; w: number }[]>();
    for (const [key, e] of pairs) {
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
      const e = pairs.get(key)!;
      edges.push({
        id: `a:${key}`,
        a: `p:${e.a}`,
        b: `p:${e.b}`,
        kind: "affinity",
        reasons: e.parts.map((x) => x.label),
        weight: e.w,
      });
    }
  }

  // Discovery edges are factual: this person was found on that person's People
  // Also Viewed. Always drawn when enabled, and never subject to the rarity
  // window, because they are not inferred. Directed, seed first, because which
  // way round it went is the useful half.
  if (opts.sources.includes("discovery")) {
    const present = new Set(personNodes.map((n) => n.slug));
    for (const n of personNodes) {
      const via = roster[n.slug]?.discoveredVia;
      if (via?.kind !== "pav") continue;
      if (!present.has(via.seedSlug) || via.seedSlug === n.slug) continue;
      edges.push({
        id: `d:${via.seedSlug}~${n.slug}`,
        a: `p:${via.seedSlug}`,
        b: `p:${n.slug}`,
        kind: "discovery",
        reasons: ["People also viewed"],
        weight: 1,
      });
      addLink(n.slug, via.seedSlug, ["Found on their People also viewed"], 1);
      addLink(via.seedSlug, n.slug, ["Found them on People also viewed"], 1);
    }
  }

  for (const list of Object.values(connections)) list.sort((a, b) => b.weight - a.weight);

  layout(nodes, edges, groups);

  return {
    nodes,
    edges,
    droppedPeople,
    hubs: hubs.slice(0, MAX_LEADS),
    connections,
    tooCommon,
    tooRare,
    hubsNotDrawn,
    groups,
  };
}

/* ── Layout ─────────────────────────────────────────────────────────────── */

const ITERATIONS = 240;
const WIDTH = 1000;
const HEIGHT = 620;
const ASPECT = WIDTH / HEIGHT;

/**
 * Seeded force-directed layout, run once and frozen.
 *
 * Group anchors give the clusters somewhere to be, so the picture reads as "these
 * people belong together" rather than as one drifting mass. With no grouping there
 * are no anchors and everyone gets the same weak centre pull, which lets the edges
 * decide the arrangement. Hub nodes never have an anchor either way: they are
 * pulled by whoever holds them, which is what makes a shared credential sit
 * visibly between its people.
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

  // Half-extents drive both the close-range separation and the final fit. A hub
  // chip is a wide box, not a disc, so one radius cannot describe it: using the
  // label width as a radius would shove people a hundred pixels below a chip that
  // is only twenty-two pixels tall.
  const halfW = new Float64Array(nodes.length);
  const halfH = new Float64Array(nodes.length);

  nodes.forEach((n, i) => {
    index.set(n.id, i);
    const anchor = n.kind === "person" ? anchors.get(n.group) : undefined;
    const base = anchor ?? { x: cx, y: cy };
    const { a, b } = jitter(n.id);
    const angle = a * Math.PI * 2;
    const dist = (0.25 + b * 0.75) * (n.kind === "person" ? 78 : 130);
    px[i] = base.x + Math.cos(angle) * dist;
    py[i] = base.y + Math.sin(angle) * dist;
    halfW[i] = n.kind === "person" ? n.r : n.w / 2;
    halfH[i] = n.kind === "person" ? n.r : n.h / 2;
  });

  const links = edges
    .map((e) => ({
      a: index.get(e.a),
      b: index.get(e.b),
      // A hub needs a little more room around it than a pair of people do, because
      // its label has to fit somewhere.
      rest: e.kind === "tag" ? 104 : 94,
      /**
       * A hub is held twice as hard as a person-to-person link.
       *
       * A hub has no anchor and nothing else holding it, so at the ordinary spring
       * strength the repulsion won every exchange and the chips ended up ringing the
       * outside of the canvas — a label reading "Jane Street" as far as it could get
       * from the six people at Jane Street, which is precisely backwards. Pulling
       * harder seats each chip among its own people, the only place it means anything.
       */
      k: e.kind === "tag" ? 0.09 : 0.045,
    }))
    .filter(
      (l): l is { a: number; b: number; rest: number; k: number } =>
        l.a !== undefined && l.b !== undefined
    );

  /** Effective disc radius, for the long-range term only. */
  const reach = nodes.map((_, i) => Math.sqrt(halfW[i] * halfW[i] + halfH[i] * halfH[i]));

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const alpha = 1 - iter / ITERATIONS;

    // Repulsion. O(n²), which at a 120-person cap plus hub nodes is a few million
    // float operations once — cheap enough to do synchronously, and the reason the
    // cap exists.
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
        if (d2 > 160000) continue;
        const d = Math.sqrt(d2);
        const min = reach[i] + reach[j] + 8;
        const force = (6200 * alpha) / d2 + (d < min ? (min - d) * 0.5 : 0);
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
      const force = (d - l.rest) * l.k * alpha;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      px[l.a] += fx;
      py[l.a] += fy;
      px[l.b] -= fx;
      py[l.b] -= fy;
    }

    // Anchor and centring pull. The vertical component is stronger by the canvas
    // aspect, so the settled shape is an ellipse the shape of the frame rather than
    // a disc. A disc in a 1000×620 box leaves a third of the width empty however
    // well it is centred, which read as a small graph in a large panel.
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const target = n.kind === "person" ? (anchors.get(n.group) ?? { x: cx, y: cy }) : { x: cx, y: cy };
      const k = n.kind === "person" ? (anchors.size > 0 ? 0.035 : 0.012) : 0.006;
      px[i] += (target.x - px[i]) * k * alpha;
      py[i] += (target.y - py[i]) * k * alpha * ASPECT;
    }
  }

  separateBoxes(nodes, px, py, halfW, halfH);
  fit(nodes, px, py, halfW, halfH);
}

/**
 * Resolve overlapping hub labels, after the forces have settled.
 *
 * This is the fix for the single thing that made the hub view useless: chips
 * landing on top of each other, so the canvas carried twenty strings and you could
 * read six. The force pass cannot do it, because it only knows discs. This pass
 * knows the label box, moves only hub nodes, and pushes along whichever axis needs
 * the smaller nudge — so a pair of chips side by side separates sideways and a pair
 * stacked separates vertically, both by the least amount that clears them.
 */
function separateBoxes(
  nodes: GraphNode[],
  px: Float64Array,
  py: Float64Array,
  halfW: Float64Array,
  halfH: Float64Array
): void {
  const chips: number[] = [];
  nodes.forEach((n, i) => {
    if (n.kind === "tag") chips.push(i);
  });
  if (chips.length < 2) return;

  const GAP_X = 10;
  const GAP_Y = 6;

  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let m = 0; m < chips.length; m++) {
      for (let n = m + 1; n < chips.length; n++) {
        const i = chips[m];
        const j = chips[n];
        const dx = px[j] - px[i];
        const dy = py[j] - py[i];
        const ox = halfW[i] + halfW[j] + GAP_X - Math.abs(dx);
        const oy = halfH[i] + halfH[j] + GAP_Y - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        // Deterministic tie-break when two chips are exactly coincident.
        const sx = dx === 0 ? (i < j ? -1 : 1) : Math.sign(dx);
        const sy = dy === 0 ? (i < j ? -1 : 1) : Math.sign(dy);
        if (oy <= ox) {
          px[i] -= sx * ox * 0.06;
          px[j] += sx * ox * 0.06;
          py[i] -= (sy * oy) / 2;
          py[j] += (sy * oy) / 2;
        } else {
          px[i] -= (sx * ox) / 2;
          px[j] += (sx * ox) / 2;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/**
 * Fit to the viewBox with a margin, centred on both axes.
 *
 * One scale is used for both axes so the layout is not distorted, which means only
 * the binding axis fills the canvas and the other has slack. Anchoring at `pad`
 * gave all of that slack to one side, so the picture sat in the top-left with a
 * third of the canvas empty. Splitting it centres the graph.
 */
function fit(
  nodes: GraphNode[],
  px: Float64Array,
  py: Float64Array,
  halfW: Float64Array,
  halfH: Float64Array
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < nodes.length; i++) {
    minX = Math.min(minX, px[i] - halfW[i]);
    maxX = Math.max(maxX, px[i] + halfW[i]);
    minY = Math.min(minY, py[i] - halfH[i]);
    maxY = Math.max(maxY, py[i] + halfH[i]);
  }

  /**
   * Fill the frame, within reason.
   *
   * The scale moves positions, not radii — those are drawn in viewBox units — so
   * this spreads the graph out rather than magnifying it. That is the behaviour
   * wanted: the node sizes are already right, and a settled force layout is
   * naturally about half the frame across, so without this the picture sat as a
   * small knot in a large panel. The ceiling stops a two-node graph from being flung
   * to opposite corners.
   */
  const pad = 30;
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const CEILING = 3;
  /**
   * How far the two axes may diverge.
   *
   * A settled force layout is roughly round and the frame is not, so one scale for
   * both axes always leaves a third of the width empty. Stretching the axes
   * independently fills the frame, and the radii are untouched — circles stay
   * circles, only the gaps between them widen. Bounding the ratio is what keeps that
   * from becoming a smear: past about a third, the eye starts reading the distortion
   * as meaning.
   */
  const RATIO = 1.35;
  let sX = Math.min((WIDTH - pad * 2) / spanX, CEILING);
  let sY = Math.min((HEIGHT - pad * 2) / spanY, CEILING);
  if (sX > sY * RATIO) sX = sY * RATIO;
  if (sY > sX * RATIO) sY = sX * RATIO;

  const offX = (WIDTH - spanX * sX) / 2;
  const offY = (HEIGHT - spanY * sY) / 2;

  for (let i = 0; i < nodes.length; i++) {
    nodes[i].x = round(offX + (px[i] - minX) * sX);
    nodes[i].y = round(offY + (py[i] - minY) * sY);
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

/**
 * A gently bowed path from a to b, trimmed to each node's edge.
 *
 * Straight lines through a dense middle read as a spider web and, worse, two
 * parallel links between the same region become one thick smudge. A consistent
 * slight bow separates them and is the difference between a diagram and a picture.
 * The trim is what lets a discovery arrowhead land outside the target rather than
 * underneath it.
 */
export function edgePath(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  trimA = 0,
  trimB = 0
): string {
  const dx = bx - ax;
  const dy = by - ay;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const x1 = ax + ux * trimA;
  const y1 = ay + uy * trimA;
  const x2 = bx - ux * trimB;
  const y2 = by - uy * trimB;
  // Control point off the midpoint, perpendicular, scaled with length so short
  // links stay nearly straight and long ones sweep.
  const bow = Math.min(d * 0.09, 26);
  const mx = (x1 + x2) / 2 - uy * bow;
  const my = (y1 + y2) / 2 + ux * bow;
  return `M${x1} ${y1}Q${mx} ${my} ${x2} ${y2}`;
}
