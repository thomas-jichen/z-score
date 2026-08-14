/**
 * Sanity checks for the pure functions. Run: npm run check
 * No network, no API key. This covers the parts that silently corrupt data if
 * they're wrong: the dedupe key, the name/headline split, year inference, and
 * the query the sweep actually sends.
 */
import { extractSlug, parseTitle, inferYear, runShard } from "../lib/search";
import { buildQuery, selectionCount, EMPTY_SELECTION, type Selection } from "../lib/query";
import { parseProfile } from "../lib/apify";
import {
  estimateCost,
  formatCost,
  isUsableNeighbor,
  MAX_NEIGHBORS,
  neighborsOf,
  nextHop,
  parseSeedInput,
  toSlug,
  type EnrichedProfile,
  type Provenance,
} from "../lib/enrichment";
import { capRoster, hopAfter, isSuppressed, migrateLegacy, neighborsFrom, nextHopFrom, withEnriched, MAX_PEOPLE, type Person } from "../lib/people";
import { emptyTeam, type TaxonomyPrefs } from "../lib/state";
import { scoreOne, toCandidates } from "../lib/candidates";
import { buildSearchLabels, matchedTerms, termCounts, unmatchedTerms } from "../lib/tags";
import { assignCluster, round } from "../lib/clusters";
import { makeTag } from "../lib/tagRegistry";
import { buildGraph, DEFAULT_MIN_HOLDERS } from "../lib/graph";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) console.log(`         expected ${e}\n         actual   ${a}`);
}

const sel = (p: Partial<Selection>): Selection => ({ ...EMPTY_SELECTION, ...p });

console.log("\nextractSlug — the dedupe key");
check("plain", extractSlug("https://www.linkedin.com/in/jane-doe-123"), "jane-doe-123");
check("trailing slash", extractSlug("https://linkedin.com/in/jane-doe/"), "jane-doe");
check("query string", extractSlug("https://www.linkedin.com/in/jane-doe?trk=abc"), "jane-doe");
check("locale subdomain", extractSlug("https://uk.linkedin.com/in/jane-doe"), "jane-doe");
check("case normalised", extractSlug("https://www.linkedin.com/in/Jane-Doe"), "jane-doe");
check("percent-encoded", extractSlug("https://www.linkedin.com/in/jos%C3%A9-p"), "josé-p");
check("company URL rejected", extractSlug("https://www.linkedin.com/company/acme"), null);
check("post URL rejected", extractSlug("https://www.linkedin.com/pulse/some-post"), null);

console.log("\nparseTitle — name vs headline");
check("standard", parseTitle("Jane Doe - Founder at Acme | LinkedIn"), {
  name: "Jane Doe",
  headline: "Founder at Acme",
});
check("dash suffix variant", parseTitle("Jane Doe - Student - LinkedIn"), {
  name: "Jane Doe",
  headline: "Student",
});
check("multi-segment headline", parseTitle("Jane Doe - RSI 2025 - MIT PRIMES | LinkedIn"), {
  name: "Jane Doe",
  headline: "RSI 2025 - MIT PRIMES",
});
check("name only", parseTitle("Jane Doe | LinkedIn"), { name: "Jane Doe", headline: "" });
check("hyphenated name survives", parseTitle("Mary-Kate Olsen - Student | LinkedIn"), {
  name: "Mary-Kate Olsen",
  headline: "Student",
});

console.log("\ninferYear");
check("class of", inferYear("Class of 2027 at TJHSST"), "2027");
check("apostrophe", inferYear("TJHSST '28"), "2028");
// LinkedIn writes U+2019, not the ASCII apostrophe. Every real headline took
// this path and matched nothing until the class was widened.
check("curly apostrophe, as LinkedIn actually writes it", inferYear("Stanford ’30"), "2030");
check(
  "curly apostrophe mid-headline",
  inferYear("Incoming CS @ Stanford | Stanford AIMI ’26"),
  "2026"
);
// "Class of" with a two-digit year falls through to the apostrophe branch,
// because the qualified pattern wants four digits. The answer is still right.
check("two-digit class of", inferYear("Class of ’29 at Exeter"), "2029");
check("bare year in range", inferYear("Graduating 2026"), "2026");
check("ignores out-of-band", inferYear("Born in 1999"), undefined);

console.log("\nbuildQuery — one sweep is one query");
check("nothing selected yields no query", buildQuery(EMPTY_SELECTION), "");

check(
  "single option per category needs no parentheses",
  buildQuery(sel({ programs: ["RSI"], colleges: ["Stanford"], years: ["2030"] })),
  "RSI Stanford 2030 site:linkedin.com/in"
);

check(
  "multiple options in a category are OR'd in parentheses",
  buildQuery(
    sel({
      programs: ["Coca-Cola Scholar", "RSI"],
      colleges: ["MIT", "Stanford"],
      highSchools: ["TJHSST", "Harker"],
    })
  ),
  "(Coca-Cola Scholar OR RSI) (MIT OR Stanford) (TJHSST OR Harker) site:linkedin.com/in"
);

check(
  "group order puts title keywords last, after programs, colleges, schools, years",
  buildQuery(
    sel({
      programs: ["RSI"],
      titles: ["Founder"],
      colleges: ["MIT"],
      highSchools: ["TJHSST"],
      years: ["2030"],
    })
  ),
  "RSI MIT TJHSST 2030 Founder site:linkedin.com/in"
);

check(
  "empty categories are skipped entirely",
  buildQuery(sel({ titles: ["Founder", "Building"] })),
  "(Founder OR Building) site:linkedin.com/in"
);

check(
  "adding an option widens the same query, never adds a second",
  buildQuery(sel({ programs: ["RSI", "STS", "ISEF"] })).split("site:linkedin.com/in").length - 1,
  1
);

// No exact match anywhere: quotes disable Google's synonym expansion, which is
// the part actually doing the work.
check(
  "query is never quoted",
  /"/.test(
    buildQuery(sel({ programs: ["Coca-Cola Scholar", "RSI"], highSchools: ["TJHSST"] }))
  ),
  false
);

check("site filter is always last", buildQuery(sel({ programs: ["RSI"] })).endsWith("site:linkedin.com/in"), true);
check("selectionCount totals every category", selectionCount(sel({ programs: ["RSI"], titles: ["Founder"], years: ["2030"] })), 3);

// ── Enrichment ───────────────────────────────────────────────────────────
// A trimmed but structurally faithful HarvestAPI item: nested date objects,
// object-shaped skills, the moreProfiles fan-out. Parsing bugs here would put
// wrong data in front of Cory silently, which is the worst failure mode.

const RAW_PROFILE = {
  publicIdentifier: "Ada-Chen-7a12",
  linkedinUrl: "https://www.linkedin.com/in/Ada-Chen-7a12",
  firstName: "Ada",
  lastName: "Chen",
  headline: "Building at the intersection of bio and ML",
  // Verified against a real payload: an object with display text plus a
  // structured `parsed` block carrying the region code.
  location: { linkedinText: "Austin, TX", countryCode: "US", parsed: { regionCode: "TX" } },
  about: "17. Working on protein design.",
  registeredAt: "2022-08-14",
  followerCount: 3400,
  connectionsCount: 812,
  education: [
    {
      schoolName: "TJHSST",
      degree: "High School Diploma",
      fieldOfStudy: "STEM",
      startDate: { month: 8, year: 2023 },
      endDate: { month: 6, year: "2027" },
    },
  ],
  honorsAndAwards: [
    { title: "RSI 2025", issuedBy: "MIT", description: "Research Science Institute" },
    { title: "ISEF Finalist", issuedBy: "Society for Science" },
  ],
  projects: [{ title: "foldbench", description: "Open benchmark", startDate: { year: 2024 } }],
  volunteering: [{ role: "Tutor", organizationName: "Math circle", duration: "2 yrs" }],
  experience: [{ position: "Research Intern", companyName: "UT Austin", startDate: { year: 2025 } }],
  skills: [{ name: "Python" }, { name: "PyTorch" }],
  publications: [{ title: "A paper" }],
  patents: [],
  moreProfiles: [
    {
      id: "ACoAAA1",
      firstName: "Mira",
      lastName: "Okonkwo",
      // A real `position` usually states the year. This one does, Ken's does not.
      position: "Student, class of 2027",
      publicIdentifier: "mira-okonkwo",
      linkedinUrl: "https://www.linkedin.com/in/mira-okonkwo",
    },
    {
      id: "ACoAAA2",
      firstName: "Ken",
      lastName: "Tanaka",
      position: "Student",
      publicIdentifier: "ken-tanaka",
      linkedinUrl: "https://www.linkedin.com/in/ken-tanaka",
    },
    // No identifier at all — must be dropped, not turned into a junk lookup.
    { id: "ACoAAA3", firstName: "Ghost", lastName: "Entry", position: "Unknown" },
    // The headline-less tail. The vendor pads the sidebar with accounts it has
    // no headline for and writes "--" into position. One of them shows the
    // scraper stringifying a missing lastName.
    {
      id: "ACoAAA4",
      firstName: "Penny",
      lastName: "Gallear",
      position: "--",
      publicIdentifier: "penny-gallear-1a5872427",
      linkedinUrl: "https://www.linkedin.com/in/penny-gallear-1a5872427",
    },
    {
      id: "ACoAAA5",
      firstName: "Datollski",
      lastName: "undefined",
      position: "-",
      publicIdentifier: "datollski-undefined-860314422",
      linkedinUrl: "https://www.linkedin.com/in/datollski-undefined-860314422",
    },
  ],
};

const VIA_SERP: Provenance = { kind: "serp", query: "RSI site:linkedin.com/in" };

console.log("\ntoSlug — canonical identifier");
check("full url", toSlug("https://www.linkedin.com/in/ada-chen"), "ada-chen");
check("bare identifier", toSlug("ada-chen-7a12"), "ada-chen-7a12");
check("locale subdomain", toSlug("https://de.linkedin.com/in/ada-chen"), "ada-chen");
check("uppercase folded", toSlug("Ada-Chen"), "ada-chen");
check("a pasted name is not an identifier", toSlug("Ada Chen"), null);
check("empty", toSlug("   "), null);

console.log("\nparseSeedInput");
check(
  "newlines and commas both split",
  parseSeedInput("https://www.linkedin.com/in/a\nb,\n https://uk.linkedin.com/in/c ").slugs,
  ["a", "b", "c"]
);
check(
  "duplicates collapse across url forms",
  parseSeedInput("https://www.linkedin.com/in/a/\nA\nhttps://uk.linkedin.com/in/a").slugs,
  ["a"]
);
check("junk is reported, not silently dropped", parseSeedInput("Ada Chen\nhttps://linkedin.com/in/a").rejected, [
  "Ada Chen",
]);

console.log("\nparseProfile — HarvestAPI payload");
const parsed = parseProfile(RAW_PROFILE, VIA_SERP);
if (!parsed) {
  failures++;
  console.log(" FAIL  parseProfile returned null");
}
const p = parsed as EnrichedProfile;
check("slug is folded to lowercase", p.slug, "ada-chen-7a12");
check("name is joined", p.name, "Ada Chen");
check("location unwrapped from object", p.location, "Austin, TX");
// "Class of" means the COLLEGE graduating class throughout the app, so a 2027
// high-school leaver is the class of 2031. The fixture's only education record is
// a high school diploma.
check("high school leaver is given a college class year", p.gradYear, 2031);
check("and the raw education year is untouched", p.educations[0].endYear, 2027);
check("endDate year survives being a string", p.educations[0].endYear, 2027);
check("honors kept in order", p.honors.map((h) => h.title), ["RSI 2025", "ISEF Finalist"]);
check("skills flattened from objects", p.skills, ["Python", "PyTorch"]);
check("publications flattened", p.publications, ["A paper"]);
check("empty patents stay empty", p.patents, []);
check("neighbours parsed", p.neighbors.map((n) => n.slug), ["mira-okonkwo", "ken-tanaka"]);
check("neighbour without an identifier is dropped", p.neighbors.length, 2);
// The sidebar arrives with identity attached. Asserting only slugs is what let
// the name and position be silently dropped everywhere downstream.
check("neighbour name is kept", p.neighbors[0].name, "Mira Okonkwo");
check("neighbour position is kept", p.neighbors[0].position, "Student, class of 2027");
check("neighbour year inferred from position", p.neighbors[0].year, "2027");
check("no year in the position means no guess", p.neighbors[1].year, undefined);
check("neighbour url kept", p.neighbors[0].url, "https://www.linkedin.com/in/mira-okonkwo");
// The sidebar's tail is padding, not people. Keeping it meant paying $0.004 to
// find out that a row with no headline was a dormant unrelated account.
check("headline-less padding is left out", p.neighbors.length, 2);
check("and the count of what was left out is kept", p.neighborsDropped, 2);
check('"--" is not a headline', isUsableNeighbor({ ...p.neighbors[0], position: "--" }), false);
check('a single dash is not either', isUsableNeighbor({ ...p.neighbors[0], position: " - " }), false);
check("an empty position is not", isUsableNeighbor({ ...p.neighbors[0], position: "" }), false);
check("a real headline is", isUsableNeighbor(p.neighbors[0]), true);
check(
  "a hyphenated headline survives",
  isUsableNeighbor({ ...p.neighbors[0], position: "Co-founder" }),
  true
);
{
  // The cut is positional, not textual. Measured over five real profiles the
  // array came back at 10 or 20 and the quality cliff was at index 10 every
  // time; one profile's entire tail had real headlines ("Student at Stanford
  // University", a cash-for-gold business) and sailed through a headline test.
  const wide = parseProfile(
    {
      publicIdentifier: "wide",
      moreProfiles: Array.from({ length: 14 }, (_, i) => ({
        firstName: "Neighbor",
        lastName: `${i + 1}`,
        position: `CS @ Stanford, number ${i + 1}`,
        publicIdentifier: `n${i + 1}`,
      })),
    },
    VIA_SERP
  )!;
  check("only the sidebar block is kept", wide.neighbors.length, MAX_NEIGHBORS);
  check("the tenth survives", wide.neighbors[9].slug, "n10");
  check(
    "the eleventh is dropped despite a plausible headline",
    wide.neighbors.some((n) => n.slug === "n11"),
    false
  );
  check("and the four cut are counted", wide.neighborsDropped, 4);
}

check(
  'the literal string "undefined" is not part of a name',
  parseProfile(
    {
      publicIdentifier: "x",
      moreProfiles: [
        { firstName: "Datollski", lastName: "undefined", position: "CS @ Stanford", publicIdentifier: "d1" },
      ],
    },
    VIA_SERP
  )?.neighbors[0].name,
  "Datollski"
);
check("provenance carried through", p.discoveredVia.kind, "serp");
check("region taken from the structured parsed block", p.region, "TX");
check("experience description kept for matching", Boolean(p.experience[0]), true);
check("garbage in gives null, not a broken record", parseProfile({ nothing: true }, VIA_SERP), null);

console.log("\ngrad year fallback");
check(
  "start year plus four when no end date is stated",
  parseProfile(
    { publicIdentifier: "x", education: [{ schoolName: "S", startDate: { year: 2024 } }] },
    VIA_SERP
  )?.gradYear,
  2028
);
check(
  "no education means no guess",
  parseProfile({ publicIdentifier: "x", education: [] }, VIA_SERP)?.gradYear,
  undefined
);

console.log("\nhop expansion");
check("neighborsOf returns slugs", neighborsOf(p), ["mira-okonkwo", "ken-tanaka"]);
check(
  "already-known people are not re-paid for",
  nextHop([p], new Set(["mira-okonkwo"])).map((n) => n.slug),
  ["ken-tanaka"]
);
check("hop carries seed attribution", nextHop([p], new Set())[0].seedName, "Ada Chen");
// A hop row is what the reviewer reads before deciding to spend, so the
// neighbour's own identity has to survive the projection, not just the seed's.
check("hop carries the neighbour name", nextHop([p], new Set())[0].name, "Mira Okonkwo");
check(
  "hop carries the neighbour position",
  nextHop([p], new Set())[0].position,
  "Student, class of 2027"
);
check("hop carries the inferred year", nextHop([p], new Set())[0].year, "2027");
check(
  "the seed itself is skipped when known",
  nextHop([p], new Set(["ada-chen-7a12", "mira-okonkwo", "ken-tanaka"])).length,
  0
);
{
  // The same neighbour reachable from two seeds must be enriched once.
  const other = parseProfile({ ...RAW_PROFILE, publicIdentifier: "other-seed" }, VIA_SERP)!;
  check("neighbour shared by two seeds appears once", nextHop([p, other], new Set()).length, 2);

  // The Person-level variant the sweep screen now uses.
  const asPerson = withEnriched(undefined, p);
  check(
    "hop from a Person reads the nested profile",
    nextHopFrom([asPerson], new Set()).map((n) => n.slug),
    ["mira-okonkwo", "ken-tanaka"]
  );
  check(
    "hop from a Person keeps the neighbour name",
    nextHopFrom([asPerson], new Set())[0].name,
    "Mira Okonkwo"
  );
  check("one person's neighbours", neighborsFrom(asPerson, new Set()).length, 2);

  // Depth is read off the surfacing person, so it is right regardless of which
  // screen started the expansion. This replaces a hardcoded hop of 1.
  check("a neighbour of a swept person is hop 1", hopAfter(asPerson), 1);
  const atHopOne = withEnriched(
    undefined,
    parseProfile(
      { ...RAW_PROFILE, publicIdentifier: "hop-one" },
      { kind: "pav", seedSlug: "ada-chen-7a12", seedName: "Ada Chen", hop: 1 }
    )!
  );
  check("a neighbour of a hop-1 person is hop 2", hopAfter(atHopOne), 2);
  check("depth is capped at what the route accepts", hopAfter(
    withEnriched(
      undefined,
      parseProfile(
        { ...RAW_PROFILE, publicIdentifier: "deep" },
        { kind: "pav", seedSlug: "x", seedName: "X", hop: 9 }
      )!
    )
  ), 5);
}

console.log("\ncost");
check("per profile", estimateCost(1), 0.004);
check("hundred profiles", Number(estimateCost(100).toFixed(3)), 0.4);
check("small totals keep three places", formatCost(estimateCost(1)), "$0.004");
check("normal totals keep two", formatCost(estimateCost(100)), "$0.40");

// ── The roster, and the marks that are separate from it ──────────────────

const TAX: TaxonomyPrefs = emptyTeam().taxonomy;

/** A Person built from the parsed profile above, for the scoring checks. */
const PERSON: Person = withEnriched(undefined, p);

const bare = (slug: string, honors: string[] = [], extra: Partial<Person> = {}): Person => ({
  ...PERSON,
  slug,
  headline: "",
  searchLabels: [],
  enriched: {
    ...p,
    slug,
    headline: "",
    about: "",
    honors: honors.map((title) => ({ title })),
    projects: [],
    publications: [],
    patents: [],
    experience: [],
    volunteering: [],
    certifications: [],
    // Cleared too, or the spread of the parsed fixture leaves TJHSST and a field
    // of study on every person — both of which are now real scoring tags, so the
    // worked examples below would stop being about the credential they name.
    educations: [],
  },
  ...extra,
});

console.log("\ncapRoster — keeps the store bounded");
{
  const many: Record<string, Person> = {};
  for (let i = 0; i < MAX_PEOPLE + 25; i++) {
    many[`p${i}`] = {
      ...bare(`p${i}`),
      // Later index means more recent, so p0 is the oldest.
      addedAt: new Date(1700000000000 + i * 1000).toISOString(),
      enriched: undefined,
    };
  }
  const capped = capRoster(many);
  check("capped to the limit", Object.keys(capped).length, MAX_PEOPLE);
  check("newest kept", Boolean(capped[`p${MAX_PEOPLE + 24}`]), true);
  check("oldest dropped", Boolean(capped.p0), false);
  check("under the limit is untouched", Object.keys(capRoster({ a: PERSON })).length, 1);

  // Anyone pinned or enriched outranks a thin record, whatever the dates say.
  const withPin: Record<string, Person> = { ...many };
  withPin.p0 = { ...withPin.p0 };
  const keptPinned = capRoster(withPin, { p0: { status: "queued", pinned: true, at: "x" } });
  check("a pinned person survives the cap", Boolean(keptPinned.p0), true);
}

console.log("\nstatus and suppression");
{
  check("queued is not suppressed", isSuppressed({ status: "queued", at: "x" }), false);
  // Both terminal states keep a person out of future sweeps, so a rejection is
  // not silently paid for twice.
  check("known is suppressed", isSuppressed({ status: "known", at: "x" }), true);
  check("rejected is suppressed", isSuppressed({ status: "rejected", at: "x" }), true);
  check("no mark at all is not suppressed", isSuppressed(undefined), false);
}

console.log("\nmigrateLegacy — old documents keep working");
{
  const { roster, marks } = migrateLegacy({
    candidates: { "ada-chen-7a12": p },
    ratings: { "ada-chen-7a12": "already_know", "someone-else": "not_interested" },
  });
  check("the enriched profile becomes a Person", Boolean(roster["ada-chen-7a12"]?.enriched), true);
  check("the profile keeps its slug", roster["ada-chen-7a12"].slug, "ada-chen-7a12");
  check("already_know becomes known", marks["ada-chen-7a12"].status, "known");
  check("not_interested becomes rejected", marks["someone-else"].status, "rejected");
  check(
    "an interested rating stays in the queue",
    migrateLegacy({ ratings: { x: "interested" } }).marks.x.status,
    "queued"
  );
}

// ── Tags: what counts as evidence ────────────────────────────────────────

console.log("\nbuildSearchLabels — a query is a hypothesis, not a fact");
{
  // An OR group never reports which branch matched, so a chip only counts as
  // evidence when the hit's own text actually contains it.
  const labels = buildSearchLabels(
    "Ada Chen - RSI 2025, TJHSST",
    sel({ programs: ["RSI", "IMO"], highSchools: ["TJHSST"], colleges: ["MIT"] })
  );
  const byLabel = new Map(labels.map((l) => [l.label, l.confirmed]));
  check("a term present in the text is confirmed", byLabel.get("RSI"), true);
  check("the school in the text is confirmed", byLabel.get("TJHSST"), true);
  check("the other branch of the OR is not confirmed", byLabel.get("IMO"), false);
  check("a college that never appears is not confirmed", byLabel.get("MIT"), false);
  check("every chip is still recorded", labels.length, 4);
}

console.log("\nmatchedTerms");
{
  const labels = matchedTerms(PERSON, TAX).map((t) => t.label);
  check("RSI found in honors", labels.includes("RSI"), true);
  check("ISEF found in honors", labels.includes("ISEF"), true);
  check("unearned programs are not claimed", labels.includes("IMO"), false);

  // Whole-term matching: "IMO" must not fire inside another word.
  const noisy = bare("noisy");
  noisy.enriched!.headline = "Very imortant person at Simons Foundation";
  check("no substring false positive on IMO", matchedTerms(noisy, TAX).map((t) => t.label).includes("IMO"), false);

  // An unconfirmed chip must never reach the score.
  const thin: Person = {
    ...bare("thin"),
    enriched: undefined,
    headline: "Student",
    snippet: "Nothing notable here.",
    searchLabels: [
      { label: "IMO", confirmed: false },
      { label: "RSI", confirmed: true },
    ],
  };
  const thinTerms = matchedTerms(thin, TAX).map((t) => t.label);
  check("a confirmed chip scores", thinTerms.includes("RSI"), true);
  check("an unconfirmed chip does not", thinTerms.includes("IMO"), false);
}

console.log("\ntermCounts and unmatchedTerms");
{
  const counts = termCounts([PERSON, bare("b", ["RSI 2025"]), bare("c")], TAX);
  check("RSI counted on two people", counts.RSI, 2);
  check("a term nobody has is absent", counts.IMO, undefined);

  const tagged: Person = { ...bare("t"), extractedTerms: ["Davidson Fellow", "RSI"] };
  const also: Person = { ...bare("u"), extractedTerms: ["Davidson Fellow"] };
  const pending = unmatchedTerms([tagged, also], TAX);
  check("a term outside the taxonomy is offered", pending[0].term, "Davidson Fellow");
  check("counted over real people", pending[0].count, 2);
  check("a term already in the taxonomy is not offered", pending.some((x) => x.term === "RSI"), false);
  check(
    "a dismissed term stops being offered",
    unmatchedTerms([tagged, also], { ...TAX, dismissed: ["Davidson Fellow"] }).length,
    0
  );
  check(
    "hand-added terms reach the promote queue too",
    unmatchedTerms([{ ...bare("m"), manualTerms: ["Clark Scholar"] }], TAX)[0].term,
    "Clark Scholar"
  );
}

console.log("\npromoting a term actually makes it score");
{
  // The loop that matters: the tagger attributes a term to someone, you promote
  // it on the taxonomy screen, their score moves.
  //
  // This regressed silently once. The tagger returns *normalised* names — a
  // profile saying "Regeneron Science Talent Search" comes back as "STS" — so a
  // promoted term often appears nowhere in the profile text. Matching on text
  // alone meant promoting a term did nothing, with no way to see why.
  const tagged: Person = {
    ...bare("tagged"),
    extractedTerms: ["Davidson Fellow"],
  };

  const before = scoreOne(tagged, TAX);
  check("unpromoted, it carries no weight", before.signals.some((s) => s.label === "Davidson Fellow"), false);

  // A tag IS the term now. There is no separate promoted list, no separate weights
  // map and no separate clusters map — one registry entry carries all three, which
  // is what makes two spellings of one award impossible.
  const promoted: TaxonomyPrefs = {
    ...TAX,
    tags: {
      ...TAX.tags,
      "davidson": makeTag({
        label: "Davidson Fellow",
        facet: "award",
        weight: 1.9,
        cluster: "research",
        promoted: true,
      }),
    },
  };
  const after = scoreOne(tagged, promoted);
  check("promoted, it scores", after.signals.some((s) => s.label === "Davidson Fellow"), true);
  // Now the score IS the sum, so the delta is the weight exactly. It used to be
  // the weight divided by sigma, and the assertion needed a tolerance.
  const delta = round(after.score - before.score);
  check("the score moves by exactly the weight", delta, 1.9);
  check("and it votes for its cluster", after.archetype, "research");
  check(
    "it leaves the review queue once promoted",
    unmatchedTerms([tagged], promoted).length,
    0
  );

  // A hand-added term behaves identically, since it is the same finding.
  const byHand: Person = { ...bare("byhand"), manualTerms: ["Davidson Fellow"] };
  check("a hand-added term scores once promoted too", scoreOne(byHand, promoted).signals.some((s) => s.label === "Davidson Fellow"), true);

  // Casing must not matter, or the same credential scores for one person and not
  // another depending on how the model happened to capitalise it.
  const cased: Person = { ...bare("cased"), extractedTerms: ["davidson fellow"] };
  check("matching is case-insensitive", scoreOne(cased, promoted).signals.some((s) => s.label === "Davidson Fellow"), true);

  // A term already found in the text must not be counted a second time.
  const both: Person = { ...bare("both", ["RSI"]), extractedTerms: ["RSI"] };
  check("a term in both text and tags counts once", scoreOne(both, TAX).signals.filter((s) => s.label === "RSI").length, 1);
}

// ── Scoring: fixed calibration ───────────────────────────────────────────

console.log("\nthe score is a sum — the documented worked examples");
{
  // The score IS the raw total now, so these assert it directly. The three
  // sigma figures that used to sit alongside them (−0.8σ, +1.3σ, +2.4σ) have no
  // successor: there is no mean to be above.
  const sumOf = (c: ReturnType<typeof scoreOne>) =>
    round(c.signals.reduce((s, x) => s + x.points, 0));

  const hackClub = scoreOne(bare("hc", ["Hack Club"]), TAX);
  check("Hack Club alone", hackClub.score, 0.7);

  const three = scoreOne(bare("three", ["RSI", "ISEF", "USAMO"]), TAX);
  check("RSI + ISEF + USAMO", three.score, 4.5);

  const strong = bare("strong", ["IMO", "IOI", "RSI"]);
  strong.enriched!.publications = ["A paper"];
  const strongScored = scoreOne(strong, TAX);
  check("IMO+IOI+RSI+1 pub", strongScored.score, 6.6);

  // The breakdown on the detail screen must add up to the number above it. Under
  // the old model the rows were weight/sigma and the total was (Σw−mu)/sigma, so
  // they never did.
  check("the breakdown sums to the total", sumOf(strongScored), strongScored.score);
  check("and for a thin profile too", sumOf(hackClub), hackClub.score);
}

console.log("\ncapped counts");
{
  const many = bare("many", []);
  many.enriched!.experience = Array.from({ length: 20 }, (_, i) => ({
    title: `Role ${i}`,
    company: `Company ${i}`,
  }));
  const scored = scoreOne(many, TAX);
  const row = scored.signals.find((s) => s.label.includes("experience"))!;
  // 20 experiences, cap 8, 0.2 each. Volume must not beat quality.
  check("counting stops at the cap", row.points, 1.6);
  check("and the row says what was dropped", row.label, "20 experiences, 8 counted");

  const few = bare("few", []);
  few.enriched!.projects = [{ title: "One" }, { title: "Two" }];
  const f = scoreOne(few, TAX);
  const prow = f.signals.find((s) => s.label.includes("project"))!;
  check("under the cap, everything counts", prow.points, 0.8);
  check("and the label is plain", prow.label, "2 projects");
}

console.log("\nthe score does not depend on who else is in the pool");
{
  // The invariant worth keeping from the standardised model. It used to
  // standardise over the enriched population, so a person's number moved as the
  // queue grew and two teammates saw different values for the same kid.
  const target = bare("target", ["RSI", "ISEF"]);
  const crowd = Array.from({ length: 29 }, (_, i) => bare(`filler${i}`, ["Hack Club"]));

  const alone = toCandidates([target], TAX)[0].score;
  const inThree = toCandidates([target, ...crowd.slice(0, 2)], TAX).find((c) => c.slug === "target")!
    .score;
  const inThirty = toCandidates([target, ...crowd], TAX).find((c) => c.slug === "target")!.score;

  check("same score in a pool of one and a pool of three", alone, inThree);
  check("same score in a pool of thirty", alone, inThirty);
  check("a lone candidate gets a real score, not zero", alone !== 0, true);
}

console.log("\ncluster assignment — highest weight wins");
{
  check(
    "the heavier term decides",
    assignCluster([
      { label: "IOI", weight: 2.0, cluster: "quant" },
      { label: "RSI", weight: 1.8, cluster: "research" },
    ]),
    "quant"
  );
  check(
    "order of the input does not matter",
    assignCluster([
      { label: "RSI", weight: 1.8, cluster: "research" },
      { label: "IOI", weight: 2.0, cluster: "quant" },
    ]),
    "quant"
  );
  check(
    "a tie breaks the same way every time",
    assignCluster([
      { label: "A", weight: 1.0, cluster: "operator" },
      { label: "B", weight: 1.0, cluster: "quant" },
    ]),
    "quant"
  );
  check(
    "a term with no cluster casts no vote",
    assignCluster([
      { label: "QuestBridge", weight: 2.0, cluster: null },
      { label: "RSI", weight: 0.5, cluster: "research" },
    ]),
    "research"
  );
  check("nothing to go on returns null", assignCluster([]), null);

  // The case that motivated the whole mechanic.
  const iorsi = scoreOne(bare("iorsi", ["IOI", "RSI"]), TAX);
  check("IOI + RSI is primarily Olympiad", iorsi.archetype, "quant");
  check("and carries the Polymath badge", iorsi.polymath, true);
  check("with Research as the secondary", iorsi.secondary_archetypes, ["research"]);

  // Reweighting the taxonomy genuinely reassigns people, which is the point of
  // the sliders on that screen.
  // Retuning is a registry edit now, not a separate weights map.
  const rsi = TAX.tags[Object.keys(TAX.tags).find((k) => TAX.tags[k].label === "RSI")!];
  const flipped = scoreOne(bare("iorsi", ["IOI", "RSI"]), {
    ...TAX,
    tags: { ...TAX.tags, [rsi.id]: { ...rsi, weight: 2.5 } },
  });
  check("raising RSI above IOI flips the primary cluster", flipped.archetype, "research");

  // A manual override always wins.
  const forced = scoreOne({ ...bare("forced", ["IOI"]), clusterOverride: "founder" }, TAX);
  check("a manual override beats the computed label", forced.archetype, "founder");

  // Jane Street used to come out "polymath", which was the tell that a cluster
  // was missing.
  check("Jane Street is Quant", scoreOne(bare("js", ["Jane Street"]), TAX).archetype, "quant");
  check(
    "QuestBridge scores but does not decide the label",
    matchedTerms(bare("qb", ["QuestBridge"]), TAX)[0].cluster,
    null
  );
}

console.log("\npolymath badge");
{
  check("one cluster is not a polymath", scoreOne(bare("one", ["RSI"]), TAX).polymath, false);
  check(
    "two cleared clusters is",
    scoreOne(bare("two", ["IMO", "IOI", "RSI", "ISEF"]), TAX).polymath,
    true
  );
  // The threshold is points now, from the taxonomy, not a sigma constant.
  const weak = scoreOne(bare("weak", ["TASP", "Mathcamp"]), TAX);
  check(
    "reaching the threshold is required, not merely appearing in two",
    weak.polymath,
    Object.values(weak.cluster_scores).filter((n) => n >= TAX.polymathPoints).length >= 2
  );
  check(
    "raising the threshold takes the badge away",
    scoreOne(bare("two2", ["IMO", "IOI", "RSI", "ISEF"]), { ...TAX, polymathPoints: 99 }).polymath,
    false
  );
}

console.log("\ndiscovery trace stays honest");
{
  // A hand-supplied seed must never be labelled as a keyword hit.
  const asSeed: Person = { ...PERSON, discoveredVia: { kind: "seed" } };
  const asPav: Person = {
    ...PERSON,
    slug: "found",
    discoveredVia: { kind: "pav", seedSlug: "ada-chen-7a12", seedName: "Ada Chen", hop: 1 },
  };
  const traced = toCandidates([asSeed, asPav, PERSON], TAX);
  check("a seed reads as a seed", traced[0].discovery.map((h) => h.kind), ["seed"]);
  check(
    "a neighbour keeps the hop it came through",
    traced[1].discovery.map((h) => h.kind),
    ["seed", "people_also_viewed"]
  );
  check("the neighbour links back to its seed", traced[1].discovery[0].slug, "ada-chen-7a12");
  check("a SERP hit reads as a keyword sweep", traced[2].discovery.map((h) => h.kind), ["keyword_sweep"]);
}

console.log("\nupgrade in place");
{
  // Adding on search data then enriching later must not lose the marks, the
  // discovery trace, or the date the person was first seen.
  const thin: Person = {
    slug: "ada-chen-7a12",
    name: "A Chen",
    headline: "Student",
    url: "https://www.linkedin.com/in/ada-chen-7a12",
    searchLabels: [{ label: "RSI", confirmed: true }],
    discoveredVia: { kind: "serp", query: "RSI site:linkedin.com/in" },
    addedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const upgraded = withEnriched(thin, p);
  check("the profile is attached", Boolean(upgraded.enriched), true);
  check("the fuller name wins", upgraded.name, "Ada Chen");
  // A high-school leaver in 2027 is the college class of 2031.
  check("grad year arrives as a college class", upgraded.gradYear, 2031);
  check("the school arrives", upgraded.school, "TJHSST");
  check("the state arrives", upgraded.state, "TX");
  check("the original discovery path is kept", upgraded.discoveredVia.kind, "serp");
  check("addedAt is not reset", upgraded.addedAt, "2026-01-01T00:00:00.000Z");
  check("search labels survive", upgraded.searchLabels.length, 1);
}

// ── Graph ────────────────────────────────────────────────────────────────

console.log("\ngraph — the rarity window is what keeps it readable");
{
  // Twelve people all in the class of 2027, three of whom did RSI.
  //
  // The school has to be set on the education record, not just on `Person.school`.
  // The extractor reads `enriched.educations` directly now, and the fixture spreads
  // one parsed profile into all twelve — so leaving the record alone gave every
  // person the same school and the six-holder tag became a twelve-holder one.
  const crowd: Person[] = Array.from({ length: 12 }, (_, i) => {
    const base = bare(`g${i}`, i < 3 ? ["RSI"] : []);
    const school = i < 6 ? "TJHSST" : "IMSA";
    return {
      ...base,
      gradYear: 2027,
      school,
      enriched: { ...base.enriched!, educations: [{ school, endYear: 2027 }] },
    };
  });
  const roster = Object.fromEntries(crowd.map((x) => [x.slug, x]));
  const cands = toCandidates(crowd, TAX);

  const opts = {
    sources: ["program", "school", "year"] as const,
    groupBy: "cluster" as const,
    showTags: true,
    minHolders: DEFAULT_MIN_HOLDERS,
    maxHolders: 8,
    cap: 120,
  };
  const g = buildGraph(cands, roster, TAX, { ...opts, sources: [...opts.sources] });

  const tagLabels = g.nodes.filter((n) => n.kind === "tag").map((n) => n.label);
  check("a tag shared by three becomes a node", tagLabels.includes("RSI"), true);
  check("a tag shared by six becomes a node", tagLabels.includes("TJHSST"), true);
  // "Class of 2027" is on all twelve, so as a hub it would drag the whole graph
  // into one blob. It is reported as background instead.
  check("a tag shared by twelve does not", tagLabels.includes("Class of 2027"), false);
  check("and is reported rather than silently dropped", g.tooCommon.some((t) => t.count === 12), true);

  check("every person is a node", g.nodes.filter((n) => n.kind === "person").length, 12);
  check("edges only ever join a person to a tag", g.edges.every((e) => e.a.startsWith("t:") || e.b.startsWith("t:")), true);

  // Raising the ceiling brings the common tag back in.
  const wide = buildGraph(cands, roster, TAX, { ...opts, sources: [...opts.sources], maxHolders: 20 });
  check(
    "raising the ceiling admits it",
    wide.nodes.filter((n) => n.kind === "tag").map((n) => n.label).includes("Class of 2027"),
    true
  );

  // The cap must drop the least interesting people, not an arbitrary slice.
  const capped = buildGraph(cands, roster, TAX, { ...opts, sources: [...opts.sources], cap: 5 });
  check("the cap is honoured", capped.nodes.filter((n) => n.kind === "person").length, 5);
  check("and the shortfall is reported", capped.droppedPeople, 7);
  {
    // The kept set must be the top of the distribution, not an arbitrary slice —
    // so the lowest kept score is at least the highest dropped score.
    const keptZ = capped.nodes
      .filter((n): n is Extract<typeof n, { kind: "person" }> => n.kind === "person")
      .map((n) => n.z);
    const allZ = cands.map((c) => c.score).sort((x, y) => y - x);
    check("the people kept are the highest scoring", [...keptZ].sort((x, y) => y - x), allZ.slice(0, 5));
    // Say what this means rather than encoding it as a score threshold. It used to
    // be `z > -1`, which isolated the RSI holders only because a person with no
    // terms happened to score −1.22 under the old standardisation — a coincidence
    // of the calibration, not a statement about the graph.
    const keptSlugs = new Set(
      capped.nodes
        .filter((n): n is Extract<typeof n, { kind: "person" }> => n.kind === "person")
        .map((n) => n.slug)
    );
    check("everyone with RSI is kept", ["g0", "g1", "g2"].every((s) => keptSlugs.has(s)), true);
  }

  console.log("\ngraph — the layout is deterministic");
  const a = buildGraph(cands, roster, TAX, { ...opts, sources: [...opts.sources] });
  const b = buildGraph(cands, roster, TAX, { ...opts, sources: [...opts.sources] });
  check(
    "two runs place every node identically",
    a.nodes.map((n) => `${n.id}:${n.x},${n.y}`).join("|"),
    b.nodes.map((n) => `${n.id}:${n.x},${n.y}`).join("|")
  );
  check("no node is placed off-canvas", a.nodes.every((n) => n.x >= 0 && n.y >= 0), true);
  check("no node is NaN", a.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), true);

  // Person-only mode must not collapse back into the hairball tag nodes avoid.
  const solo = buildGraph(cands, roster, TAX, { ...opts, sources: [...opts.sources], showTags: false });
  check("person-only mode draws no tag nodes", solo.nodes.every((n) => n.kind === "person"), true);
  check("and keeps the edge count bounded", solo.edges.length <= 12 * 3, true);

  console.log("\ngraph — discovery edges are facts, not inferences");
  {
    // Who was found on whose People Also Viewed. Drawn person-to-person, and
    // never subject to the rarity window, because nothing about it is inferred.
    const seed: Person = { ...bare("seed-a"), discoveredVia: { kind: "seed" } };
    const found: Person = {
      ...bare("found-b"),
      discoveredVia: { kind: "pav", seedSlug: "seed-a", seedName: "Seed A", hop: 1 },
    };
    const orphan: Person = {
      ...bare("orphan-c"),
      // Points at somebody outside the drawn set, so no edge can be honest.
      discoveredVia: { kind: "pav", seedSlug: "not-here", seedName: "Missing", hop: 1 },
    };
    const r2 = { "seed-a": seed, "found-b": found, "orphan-c": orphan };
    const g2 = buildGraph(toCandidates([seed, found, orphan], TAX), r2, TAX, {
      ...opts,
      sources: ["discovery"],
      showTags: false,
    });
    check("a pav hop becomes one edge", g2.edges.length, 1);
    check("drawn seed to discovery", [g2.edges[0].a, g2.edges[0].b], ["p:seed-a", "p:found-b"]);
    check("and labelled as discovery", g2.edges[0].kind, "discovery");
    check(
      "a hop whose seed is not drawn produces no dangling edge",
      g2.edges.some((e) => e.a.includes("not-here") || e.b.includes("not-here")),
      false
    );
  }
}
// ── Store: concurrent writes to different keys ───────────────────────────
async function checkStore() {
  const { promises: fsp } = await import("node:fs");
  const nodePath = await import("node:path");
  const store = await import("../lib/store");

  console.log("\nstore — concurrent writes must not clobber each other");

  // The file backend keeps every key in one blob, so a write is a
  // read-modify-write of the whole file. Two writers landing together used to
  // drop one key entirely: /api/state and /api/enrich did exactly this.
  const file = nodePath.join(process.cwd(), ".data", "store.json");
  const backup = await fsp.readFile(file, "utf8").catch(() => null);

  try {
    await Promise.all([
      store.set("zscore:test:a", { v: 1 }),
      store.set("zscore:test:b", { v: 2 }),
      store.set("zscore:test:c", { v: 3 }),
    ]);

    check("first key survived", await store.get("zscore:test:a"), { v: 1 });
    check("second key survived", await store.get("zscore:test:b"), { v: 2 });
    check("third key survived", await store.get("zscore:test:c"), { v: 3 });

    // ── Hashes ───────────────────────────────────────────────────────────
    // The roster is a hash so that pinning one person writes one field instead
    // of rewriting a multi-megabyte document. The file backend emulates that,
    // and concurrent field writes must not lose each other.
    console.log("\nstore — hash fields");
    const H = "zscore:test:hash";

    await Promise.all([
      store.hset(H, { a: { n: 1 } }),
      store.hset(H, { b: { n: 2 } }),
      store.hset(H, { c: { n: 3 } }),
    ]);
    const all = await store.hgetall<{ n: number }>(H);
    check("concurrent field writes all survive", Object.keys(all).sort(), ["a", "b", "c"]);
    check("values round-trip", all.b, { n: 2 });
    check("hget reads one field", await store.hget(H, "c"), { n: 3 });
    check("a missing field is null, not a throw", await store.hget(H, "nope"), null);

    await store.hset(H, { a: { n: 99 } });
    check("writing a field replaces only that field", await store.hget(H, "a"), { n: 99 });
    check("and leaves the others alone", await store.hget(H, "b"), { n: 2 });

    await store.hdel(H, ["a", "b"]);
    check("hdel removes the named fields", Object.keys(await store.hgetall(H)), ["c"]);
    check("hdel with an empty list is a no-op", await (async () => {
      await store.hdel(H, []);
      return Object.keys(await store.hgetall(H));
    })(), ["c"]);

    check("a hash and a plain key can share a name", await store.get("zscore:test:a"), { v: 1 });
    await store.del(H);
    check("del clears the hash", Object.keys(await store.hgetall(H)).length, 0);

    // ── Counters, which back the spend cap ───────────────────────────────
    console.log("\nstore — counters");
    const C = "zscore:test:counter";
    await store.del(C);
    check("first bump is one", await store.bump(C, 60), 1);
    check("second is two", await store.bump(C, 60), 2);
    check("third is three", await store.bump(C, 60), 3);
    await store.del(C);
    check("del resets the window", await store.bump(C, 60), 1);
    await store.del(C);
  } finally {
    if (backup !== null) await fsp.writeFile(file, backup, "utf8");
    else await fsp.rm(file, { force: true });
  }
}

// ── Happy path against a mocked Serper response ──────────────────────────
void (async () => {
  await checkStore();

  console.log("\nrunShard — mocked Serper response");
  process.env.ZSCORE_SERPER_API_KEY = "test-key";

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        organic: [
          {
            title: "Ada Chen - RSI 2025 | LinkedIn",
            link: "https://www.linkedin.com/in/ada-chen-7a12?trk=public",
            snippet: "TJHSST Class of 2027. Research Science Institute 2025.",
          },
          {
            title: "Ravi Patel - Student at IMSA | LinkedIn",
            link: "https://uk.linkedin.com/in/ravi-patel-99",
            snippet: "IMSA '28, USACO Platinum.",
          },
          // Non-profile results must be dropped, not turned into junk rows.
          {
            title: "Research Science Institute | LinkedIn",
            link: "https://www.linkedin.com/company/rsi",
            snippet: "Company page",
          },
          { title: "Some blog", link: "https://example.com/post", snippet: "unrelated" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;

  const query = buildQuery(sel({ programs: ["RSI"] }));
  const res = await runShard({ id: "sweep", query });

  check("drops non-profile results", res.count, 2);
  check("no error", res.error, undefined);
  check("first slug", res.hits[0].slug, "ada-chen-7a12");
  check("first name", res.hits[0].name, "Ada Chen");
  check("canonical url rebuilt", res.hits[0].url, "https://www.linkedin.com/in/ada-chen-7a12");
  check("year from snippet", res.hits[0].inferredYear, "2027");
  check("locale subdomain slug", res.hits[1].slug, "ravi-patel-99");
  check("apostrophe year", res.hits[1].inferredYear, "2028");
  check("result order preserved", res.hits.map((h) => h.slug), ["ada-chen-7a12", "ravi-patel-99"]);

  globalThis.fetch = realFetch;

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
