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
  currentSchool,
  estimateCost,
  formatCost,
  inferGradYear,
  isDegreeRow,
  isUsableNeighbor,
  MAX_NEIGHBORS,
  neighborsOf,
  nextHop,
  parseSeedInput,
  toSlug,
  type EnrichedProfile,
  type Provenance,
} from "../lib/enrichment";
import { capRoster, hopAfter, isSuppressed, migrateLegacy, neighborsFrom, nextHopFrom, refreshDerived, withEnriched, MAX_PEOPLE, type Person } from "../lib/people";
import {
  MAX_DELETED,
  SEED_VERSION,
  emptyTeam,
  hydrateTeam,
  mergeTeam,
  type TaxonomyPrefs,
  type TeamState,
} from "../lib/state";
import { PURGED_ALIASES } from "../lib/searchTaxonomy";
import { readTier, scanText } from "../lib/tagMatch";
import { scoreOne, toCandidates } from "../lib/candidates";
import {
  budgetLeft,
  cleanSettings,
  defaultSettings,
  estimateUsd,
  mergeTop,
  terminalReason,
  utcDay,
  KEEP_TOP,
  type Campaign,
  type ReportRow,
} from "../lib/campaign";
import { planQueries, queriesFrom } from "../lib/campaignQueries";
import {
  allTags,
  buildSearchLabels,
  heldTags,
  matchedTerms,
  schoolStateLookup,
  termCounts,
  unmatchedTerms,
} from "../lib/tags";
import { classifyOrg, extractTags, inferHomeState } from "../lib/extract";
import { extractTerms, groundedIn } from "../lib/groq";
import { cleanDeleted, cleanTaxonomy } from "../lib/team";
import { START_WEIGHT, assignCluster, round } from "../lib/clusters";
import {
  aliasIsUsable,
  containsTokens,
  indexRegistry,
  makeTag,
  resolveAny,
  resolveTag,
  usableAliases,
} from "../lib/tagRegistry";
import { buildGraph, edgePath, DEFAULT_MAX_HOLDERS, DEFAULT_MIN_HOLDERS, EDGE_SOURCES } from "../lib/graph";

let failures = 0;
// Counted so the summary can say how many, which is the number the README quotes.
// Left to be worked out by hand it goes stale the first time anyone adds a check.
let total = 0;
function check(label: string, actual: unknown, expected: unknown) {
  total++;
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
      highSchools: ["Phillips Exeter", "Harker"],
    })
  ),
  "(Coca-Cola Scholar OR RSI) (MIT OR Stanford) (Phillips Exeter OR Harker) site:linkedin.com/in"
);

check(
  "group order puts title keywords last, after programs, colleges, schools, years",
  buildQuery(
    sel({
      programs: ["RSI"],
      titles: ["Founder"],
      colleges: ["MIT"],
      highSchools: ["Harker"],
      years: ["2030"],
    })
  ),
  "RSI MIT Harker 2030 Founder site:linkedin.com/in"
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

/**
 * Quotes disable Google's synonym expansion, which is the part doing the work, so
 * nothing is quoted — except the three spelled-out school names, where an exact
 * phrase is the entire point.
 */
check(
  "an ordinary query is never quoted",
  /"/.test(buildQuery(sel({ programs: ["Coca-Cola Scholar", "RSI"], colleges: ["MIT"] }))),
  false
);

/**
 * A rare acronym alone is a loose search, not a precise one.
 *
 * "RSI TJHSST" returned "T.J. Parker, CSP, PMP" and "Thomas Guelzow II" — three of
 * ten results were people whose initials or company happened to look like the
 * school. The full name gives the engine an unambiguous phrase to anchor on, and the
 * OR keeps the acronym working for profiles that only write it that way.
 */
check(
  "an ambiguous acronym is searched with its full name",
  buildQuery(sel({ highSchools: ["NCSSM"] })),
  '(NCSSM OR "North Carolina School of Science and Mathematics") site:linkedin.com/in'
);
check(
  "and two of them flatten into one list rather than nesting",
  buildQuery(sel({ highSchools: ["TJHSST", "IMSA"] })),
  '(TJHSST OR "Thomas Jefferson High School for Science and Technology" OR IMSA OR "Illinois Mathematics and Science Academy") site:linkedin.com/in'
);
// Only the three that are genuinely ambiguous. RSI and IMO are searched alongside
// other terms that disambiguate them, and spelling every acronym out would bloat
// every query.
check(
  "an unambiguous acronym is left alone",
  buildQuery(sel({ programs: ["RSI"] })),
  "RSI site:linkedin.com/in"
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
    {
      publicIdentifier: "x",
      // Named, because the row now has to read as a degree. A school called "S"
      // with no degree is not one, which is the point of the stricter rule: a
      // dated accelerator row must not be able to set a class year.
      education: [
        { schoolName: "Stanford University", degree: "BS", startDate: { year: 2024 } },
      ],
    },
    VIA_SERP
  )?.gradYear,
  2028
);
check(
  "no education means no guess",
  parseProfile({ publicIdentifier: "x", education: [] }, VIA_SERP)?.gradYear,
  undefined
);
check(
  "and an undated programme is not a guess either",
  parseProfile(
    { publicIdentifier: "x", education: [{ schoolName: "Z Fellows", degree: "Gap Year" }] },
    VIA_SERP
  )?.gradYear,
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

console.log("\ninferGradYear — class means the college class");
{
  const ed = (
    school: string,
    degree?: string,
    startYear?: number,
    endYear?: number
  ) => ({ school, degree, startYear, endYear });

  // The ordinary case: only a high school listed, which is most of this population.
  check(
    "leaving school in 2026 is the class of 2030",
    inferGradYear([ed("Pittsford Mendon High School", "High School Diploma", 2022, 2026)]),
    2030
  );

  // A real, dated degree is the answer.
  check(
    "a dated degree wins",
    inferGradYear([
      ed("Pittsford Mendon High School", "High School Diploma", 2020, 2024),
      ed("Stanford University", "Bachelor of Science - BS", 2024, 2028),
    ]),
    2028
  );

  /**
   * Thomas Wang: a Stanford row ending the same year he left school.
   *
   * Both cannot be graduations, and taking the stated year at face value made an
   * incoming freshman read as the class of 2026 on every screen.
   */
  check(
    "a college year that cannot be one is rejected for the school rule",
    inferGradYear([
      ed("Stanford University", "Bachelor of Science", undefined, 2026),
      ed("Shady Side Academy", "High School Diploma", 2022, 2026),
    ]),
    2030
  );

  /**
   * Accelerators are not degrees.
   *
   * LinkedIn's education section takes anything and this population fills it with
   * programmes. Davido Zhang read as the class of 2026 off a Z Fellows row, and
   * Philip Meng as the class of 2019 off his middle school — neither of which is a
   * graduation, and neither of which is a high school either.
   */
  check("an accelerator is not a degree", isDegreeRow(ed("Z Fellows", "Gap Year")), false);
  check("nor is a batch", isDegreeRow(ed("Y Combinator", "S26 Batch")), false);
  check("nor a pre-college division", isDegreeRow(ed("The Juilliard School", "Pre-College Division")), false);
  check("a named university is", isDegreeRow(ed("Stanford University", "Computer Science")), true);
  check("so is an abbreviated degree", isDegreeRow(ed("Massachusetts Institute of Technology", "S.B.")), true);
  check("a high school never is", isDegreeRow(ed("Shady Side Academy", "High School Diploma")), false);

  check(
    "so a dated accelerator cannot set the class year",
    inferGradYear([
      ed("Stanford University", "Bachelor's Degree"),
      ed("Phillips Exeter Academy", "High School Diploma"),
      ed("Z Fellows", undefined, undefined, 2026),
    ]),
    undefined
  );
  check(
    "and neither can a middle school",
    inferGradYear([
      ed("Stanford University", "Electrical Engineering and Computer Science"),
      ed("Eaglebrook School", "School President"),
      ed("Chinese International School", "Student Council", undefined, 2019),
    ]),
    undefined
  );

  /**
   * The label is the school someone is at, not the one they left.
   *
   * Both are tagged either way; this only decides the string next to their name, and
   * a tie on end date used to hand it to the high school.
   */
  check(
    "a college outranks a high school for the label",
    currentSchool({
      ...p,
      educations: [
        { school: "Stanford University", degree: "Bachelor of Science", endYear: 2026 },
        { school: "Shady Side Academy", degree: "High School Diploma", startYear: 2022, endYear: 2026 },
      ],
    }),
    "Stanford University"
  );

  /**
   * A row that states nothing must not win the label.
   *
   * `isHighSchool` answers one question, and "not secondary" was being read as
   * "college" — but LinkedIn's education section takes anything. Max Fan's rows are
   * Stanford (BS, 2025-2029), Groton, a conservatory, a dual enrolment, and "Ad Astra
   * School" with no degree and no dates. That last row counted as a college, and
   * because an absent end date is read as still-enrolled it then outranked Stanford:
   * the least informative row on the profile won, and he was filed under a school he
   * has no stated degree from while his headline reads "Stanford CS & Physics".
   */
  check(
    "a bare school name loses to a real degree",
    currentSchool({
      ...p,
      educations: [
        { school: "Stanford University", degree: "Bachelor of Science - BS", startYear: 2025, endYear: 2029 },
        { school: "Groton School", degree: "High School Diploma", startYear: 2020, endYear: 2025 },
        { school: "New England Conservatory of Music", degree: "Piano Performance", startYear: 2022, endYear: 2025 },
        { school: "Ad Astra School" },
      ],
    }),
    "Stanford University"
  );

  /**
   * The word "university" is not always in the name.
   *
   * Fixing the above by ranking degree rows first regressed Tarun Batchu: his "UC
   * Berkeley Management, Entrepreneurship, & Technology (M.E.T.) program" row says
   * neither "university" nor "college", so it did not count as study and the label
   * fell to a community college that happened to spell the word out. The curated
   * college list is the same vocabulary the taxonomy is seeded from.
   */
  check(
    "a college known by its short name still counts as study",
    currentSchool({
      ...p,
      educations: [
        {
          school: "UC Berkeley Management, Entrepreneurship, & Technology (M.E.T.) program",
          degree: "EECS + Business Administration",
        },
        { school: "Olentangy Liberty High School", startYear: 2022, endYear: 2026 },
        {
          school: "Cincinnati State Technical and Community College",
          degree: "Associates in Arts & Associates in Science",
          startYear: 2023,
          endYear: 2026,
        },
      ],
    }),
    "UC Berkeley Management, Entrepreneurship, & Technology (M.E.T.) program"
  );

  // An accelerator in the education section is not a school at all, and used to be
  // read as one because it is not secondary.
  check(
    "an accelerator row does not become the label",
    currentSchool({
      ...p,
      educations: [
        { school: "Z Fellows", degree: "Gap Year" },
        { school: "Stanford University", degree: "BS", startYear: 2024, endYear: 2028 },
      ],
    }),
    "Stanford University"
  );
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

console.log("\nhydrateTeam — a stored registry keeps up with the seed lists");
{
  /**
   * An alias that changes hands has to leave the tag it came from.
   *
   * "AMP" belonged to a tag labelled "Jane Street" while the firm and the summer
   * programme shared one entry. Splitting them moved the alias to Jane Street AMP,
   * and a stored document that kept it on the firm left one key answering to two
   * tags — so an extracted "AMP" resolved to whichever the index happened to hold.
   */
  const stale = hydrateTeam({
    taxonomy: {
      ...emptyTeam().taxonomy,
      tags: {
        "jane-street": {
          id: "jane-street",
          label: "Jane Street",
          facet: "program",
          aliases: ["amp", "academy-math-programming", "hand-added-by-a-teammate"],
          weight: 3.3,
          cluster: "quant",
          promoted: true,
        },
      },
    },
  } as Parameters<typeof hydrateTeam>[0]);

  const firm = stale.taxonomy.tags["jane-street"];
  const programme = stale.taxonomy.tags["jane-street-amp"];
  check("the firm is retyped to a company", firm.facet, "company");
  check("it surrenders the reassigned alias", firm.aliases.includes("amp"), false);
  check(
    "but keeps one nobody else claims",
    firm.aliases.includes("hand-added-by-a-teammate"),
    true
  );
  check("and the programme is seeded in beside it", programme?.facet, "program");
  check("holding the alias", programme?.aliases.includes("amp"), true);

  /**
   * A weight is the team's to keep — unless the document has never seen the current
   * seed generation, in which case the recalibration reaches it once.
   *
   * Both halves need saying. Without the first, a seed edit silently discards
   * tuning. Without the second, a deliberate whole-table recalibration only ever
   * applies to documents nobody has written yet, which is no recalibration at all.
   */
  // A weight nobody's seed table would produce, so it can only survive by being kept.
  const handTuned = (seedVersion?: number, weight = 1.9): Partial<TaxonomyPrefs> => ({
    ...emptyTeam().taxonomy,
    seedVersion,
    tags: {
      "jane-street": {
        id: "jane-street",
        label: "Jane Street",
        facet: "company",
        aliases: [],
        weight,
        cluster: "quant",
        promoted: true,
      },
    },
  });

  const weightAfterRead = (tax: Partial<TaxonomyPrefs>) =>
    hydrateTeam({ taxonomy: tax } as Parameters<typeof hydrateTeam>[0]).taxonomy.tags[
      "jane-street"
    ].weight;

  check("a current document keeps its own weight", weightAfterRead(handTuned(SEED_VERSION)), 1.9);
  check("a stale one adopts the recalibration", weightAfterRead(handTuned(undefined)), 1.4);
  check("and is marked so it only happens once", stale.taxonomy.seedVersion, SEED_VERSION);

  /**
   * The marker has to survive a save, or "once" becomes "every time".
   *
   * `cleanTaxonomy` rebuilds the document field by field, so a field it forgets is a
   * field the save deletes — and it did forget this one. The next read would then
   * re-run the recalibration and overwrite exactly the weights the client had just
   * finished tuning, on every save. Round-tripped through the real validator, with a
   * weight no seed table produces, so only keeping it can make this pass.
   */
  check(
    "a tuned weight survives a save",
    weightAfterRead(cleanTaxonomy(handTuned(SEED_VERSION))),
    1.9
  );

  // Nothing may out-vote everything else, on the way in as well as in the seeds.
  check(
    "and a weight above the ceiling is clamped, not stored",
    cleanTaxonomy(handTuned(SEED_VERSION, 4.5)).tags["jane-street"].weight,
    2
  );
  // One key, one tag — checked on the alias that actually moved. A blanket sweep
  // would fail on the state pairs, where "CA" is deliberately an alias of both
  // California-now and California-home: those ids are facet-qualified and the
  // ambiguity is the point of having two facets.
  check(
    "exactly one tag answers to the moved alias",
    Object.values(stale.taxonomy.tags).filter((d) => d.aliases.includes("amp")).map((d) => d.id),
    ["jane-street-amp"]
  );
}

// ── Removing a tag has to remove it ──────────────────────────────────────

console.log("\nthe x on a chip removes the chip");
{
  /**
   * Removal was recorded and never read for three of them. School, class year and
   * state are built straight off the person by `attributeTags`, which never saw
   * `suppressedTags` — so the chip came back on the next render however many times
   * it was deleted. Max Fan was carrying "Ad Astra School" and "Class of 2029" in
   * his removals and displaying both.
   */
  const p: Person = {
    ...bare("removals"),
    school: "Ad Astra School",
    gradYear: 2029,
    state: "CA",
  };
  const labels = (x: Person) => allTags(x, TAX).map((t) => t.label);

  check("the school shows before removal", labels(p).includes("Ad Astra School"), true);
  check("and the class year", labels(p).includes("Class of 2029"), true);

  const cleaned = { ...p, suppressedTags: ["Ad Astra School", "Class of 2029"] };
  check("the removed school is gone", labels(cleaned).includes("Ad Astra School"), false);
  check("and the removed class year", labels(cleaned).includes("Class of 2029"), false);
  check("and only those two went", labels(p).length - labels(cleaned).length, 2);

  /**
   * Geography ids carry their facet, so `state:california` and
   * `homestate:california` are two tags with one name. Clicking × on that name
   * plainly means the name, which is why a removal is matched on the bare label as
   * well as the resolved id.
   */
  const stateChip = allTags(p, TAX).find((t) => t.kind === "state")!;
  check(
    "removing a state by name removes it whichever facet it came from",
    allTags({ ...p, suppressedTags: [stateChip.label] }, TAX).some(
      (t) => t.kind === "state" && t.label === stateChip.label
    ),
    false
  );

  /**
   * The correction has to live on the tag rather than the stored field.
   * `refreshDerived` recomputes school and grad year from the profile on every read
   * and is deliberately authoritative, so blanking the field would be undone by the
   * next page load and the removal would look broken again for a different reason.
   */
  const withProfile: Person = {
    ...cleaned,
    enriched: { ...cleaned.enriched!, educations: [{ school: "Ad Astra School", degree: "High School Diploma" }] },
  };
  check(
    "and it survives the derivation being recomputed",
    labels(refreshDerived(withProfile)).includes("Ad Astra School"),
    false
  );
}

// ── The tagger has to cite its source ────────────────────────────────────

console.log("\na credential the profile does not mention is not a credential");
{
  /**
   * The model was always required to quote the text for every term it returned, and
   * nothing ever read the quote — the route kept the label and dropped the evidence.
   * So the one guard the design had against invention was never armed.
   *
   * Max Fan is a pianist and a linguist. He was tagged USACO Platinum and USAPhO,
   * worth 1.5 between them. Neither string is anywhere on his profile or in the
   * vendor's raw payload. The only "platinum" he has is in a cancer-research
   * abstract, which is the whole mechanism in one word: a strong STEM profile, a
   * KNOWN list of credentials in the prompt, and a model filling in what such a
   * person usually has.
   */
  const profile = [
    "Stanford CS & Physics | Research @ Harvard PhonLab, MIT, SAIL",
    "National YoungArts 2024 Winner in Classical Music / Piano",
    "NACLO Invitational Round (2024 & 2025)",
    "Platinum-based chemotherapy drugs kill cancer cells by damaging DNA.",
  ].join("\n");

  check("the fabrication is refused", groundedIn(profile, "USACO Platinum"), false);
  check("and so is a fabricated sentence around it", groundedIn(profile, "Placed Platinum in USACO 2025"), false);
  check("one with no text behind it at all", groundedIn(profile, "USAPhO Semifinalist"), false);
  check("an empty citation cites nothing", groundedIn(profile, ""), false);

  /**
   * A word that describes any result grounds no particular one. Every profile here
   * says "Winner" somewhere, so accepting it would re-open the hole.
   */
  check("a generic word is not a citation", groundedIn(profile, "Winner"), false);

  // Quoted honestly, in the three shapes the model actually produces: verbatim,
  // two spans stitched with a dash, and prefixed with the field it read.
  check("a verbatim quote is kept", groundedIn(profile, "National YoungArts 2024 Winner in Classical Music"), true);
  check("stitched spans are kept", groundedIn(profile, "NACLO Invitational Round (2024 & 2025) — Bronze 2025"), true);
  check("and a field prefix is not part of the quote", groundedIn(profile, "HEADLINE: Stanford CS & Physics"), true);

  /**
   * The check must not be a length rule, which was the first attempt and failed in
   * the direction that matters. "Z-Fellow" is eight characters and is the only place
   * that fellowship is named; dropping it would be invisible, because nobody reviews
   * a credential they never see.
   */
  check(
    "a short real credential survives",
    groundedIn("CEO @ Vela | Z-Fellow", "Z-Fellow"),
    true
  );
  check(
    "as does a batch written only inside a company name",
    groundedIn("Co-Founder and CEO Poth Labs (YC S26) Building the internal voice", "Poth Labs (YC S26)"),
    true
  );
  /**
   * The limit, stated rather than discovered later: the quote has to be a span, not
   * a summary. A model that compresses "Poth Labs | ex-Palantir | YC S26" down to
   * "Poth Labs (YC S26)" has skipped over text in the middle, and that reads the same
   * as an invention from here. It costs a true finding occasionally; the alternative
   * is matching on scattered words, which is how a fabrication gets back in.
   */
  check(
    "a quote that skips over the middle of a line does not ground",
    groundedIn("Founder, Poth Labs | ex-Palantir | YC S26", "Poth Labs (YC S26)"),
    false
  );
}

console.log("\ndeleting a tag has to outlast the seed list");
{
  /**
   * Deleting the entry is not enough on its own. The migration seeds in every name a
   * stored document has never seen, so a deleted seed reappears on the next read —
   * which would make the control look broken for the one case it exists for.
   */
  const seeded = emptyTeam().taxonomy;
  const anySeed = Object.values(seeded.tags).find((d) => d.facet === "program")!;

  const after = hydrateTeam({
    taxonomy: {
      ...seeded,
      tags: Object.fromEntries(Object.entries(seeded.tags).filter(([id]) => id !== anySeed.id)),
      removed: [anySeed.id],
      seedVersion: SEED_VERSION,
    },
  } as Parameters<typeof hydrateTeam>[0]);

  check("a deleted tag stays deleted", Boolean(after.taxonomy.tags[anySeed.id]), false);
  check("and the decision is remembered", after.taxonomy.removed, [anySeed.id]);
  check(
    "nothing else was taken with it",
    Object.keys(after.taxonomy.tags).length,
    Object.keys(seeded.tags).length - 1
  );

  /**
   * `cleanTaxonomy` rebuilds the document field by field, so a field it forgets is a
   * field the save deletes — and every deleted tag would come back on the next read.
   * The same trap `seedVersion` fell into.
   */
  check(
    "the list survives a save",
    cleanTaxonomy({ ...seeded, removed: [anySeed.id] }).removed,
    [anySeed.id]
  );

  // A two-week summer seminar at a selective university is the host's selectivity,
  // not the attendee's, and says nothing about building a company.
  check(
    "and Yale Young Global Scholars is not in the vocabulary",
    Object.values(seeded.tags).some((d) => /young global/i.test(d.label)),
    false
  );
}

// ── Aliases that identify nothing ────────────────────────────────────────

console.log("\nan alias has to mean something standing alone");
{
  /**
   * `normalizeKey` deletes the words that carry no meaning in a key, which is right
   * for a key and wrong for an alias when the deleted word was the noun. "Grand
   * Award" became `grand`, so a piano competition's Grand Prize and a business-plan
   * contest's Grand Prize both scored 1.4 for an ISEF award neither had won — and
   * the two people who *had* won one matched by the same accident, never by name.
   */
  check("the alias that caused it is gone", usableAliases(["Grand Award"], "isef-grand"), []);
  check("and so is the one that made VEX read as CMU", usableAliases(["Robotics Institute"], "cmu-robotics"), []);

  // Not a length rule. Plenty of one-word aliases name exactly one thing.
  check("a one-word proper name still counts", usableAliases(["Thiel Fellowship"], "thiel-fellow"), ["thiel"]);
  check("as does an acronym", usableAliases(["YYGS"], "yale-young-global-scholars"), ["yygs"]);
  check(
    "and a two-token alias is untouched",
    usableAliases(["Best of Category"], "isef-grand"),
    ["best-category"]
  );

  /**
   * Filtering a stored registry must not re-normalise it. `normalizeKey` is not
   * idempotent — it splits on punctuation, so the stored key `hand-added-by-a-teammate`
   * comes back as `hand-added-by-teammate` once "a" is stripped a second time, and a
   * migration meant only to inspect aliases would quietly rename them.
   */
  check("the key-level test leaves a stored key alone", aliasIsUsable("hand-added-by-a-teammate", "x"), true);
  check("while still refusing the ambiguous one", aliasIsUsable("grand", "isef-grand"), false);

  // A document written before the seed was corrected heals on read, rather than
  // waiting for someone to re-seed from scratch.
  const stored = hydrateTeam({
    taxonomy: {
      ...emptyTeam().taxonomy,
      tags: {
        "isef-grand": {
          id: "isef-grand",
          label: "ISEF Grand Award",
          facet: "program",
          aliases: ["grand", "best-category"],
          weight: 1.4,
          cluster: "research",
          promoted: true,
        },
      },
    },
  } as Parameters<typeof hydrateTeam>[0]);
  check(
    "a stored bad alias is dropped on read",
    stored.taxonomy.tags["isef-grand"].aliases.includes("grand"),
    false
  );
  check(
    "and the good one beside it survives",
    stored.taxonomy.tags["isef-grand"].aliases.includes("best-category"),
    true
  );
}

console.log("\nattending something at a place is not belonging to it");
{
  const held = (p: Person) =>
    heldTags(p, TAX)
      .filter((t) => t.def.facet !== "state" && t.def.facet !== "homestate")
      .map((t) => t.def.label);

  /**
   * Vihaan Shringi reads computer science at Carnegie Mellon. His education section
   * also lists Stanford, where the degree field says "Accredited coursework" for one
   * summer, and both produced a college tag — so a summer course scored the same 0.8
   * as a degree. The same mistake as Ishan Ramrakhiani being tagged Yale for Yale
   * Young Global Scholars, one field over.
   */
  const courses = bare("courses");
  courses.enriched!.educations = [
    { school: "Carnegie Mellon University", degree: "Bachelor of Science - BS", startYear: 2026, endYear: 2030 },
    { school: "Stanford University", degree: "Accredited coursework", startYear: 2025, endYear: 2025 },
  ];
  const ct = held(courses);
  check("the degree is a school", ct.includes("Carnegie Mellon"), true);
  check("the coursework is not", ct.includes("Stanford"), false);

  /**
   * The remaining checks read the extractor rather than `heldTags`, which only
   * returns names the registry already knows — an unseeded school or startup would
   * disappear for a reason that has nothing to do with the guard.
   */
  const emitted = (p: Person) =>
    extractTags(p, schoolStateLookup(TAX)).tags.map((t) => t.label);

  // Registering for credit is a real registration, however young the student.
  const dual = bare("dual");
  dual.enriched!.educations = [
    { school: "University of California, Santa Cruz", degree: "Dual Enrollment", startYear: 2024, endYear: 2024 },
  ];
  check(
    "but dual enrolment is",
    emitted(dual).includes("University of California, Santa Cruz"),
    true
  );

  /**
   * Max Fan's experience section has `company: "Jump Trading"` with the title "AI
   * Research Symposium" — an event, scoring the same 1.4 as a desk on their trading
   * floor. LinkedIn's experience section takes anything.
   */
  const attended = bare("attended");
  attended.enriched!.experience = [
    { title: "AI Research Symposium", company: "Jump Trading", startYear: 2025, endYear: 2025 },
    { title: "ML Engineering", company: "Sylvan Labs", startYear: 2025, endYear: 2025 },
  ];
  const at = emitted(attended);
  check("a symposium is not an employer", at.includes("Jump Trading"), false);
  check("and the real role beside it survives", at.includes("Sylvan Labs"), true);

  /**
   * Both halves of the test are needed. These name an event *and* hold a role, and
   * dropping them would lose real signal to fix a smaller problem.
   */
  const both = bare("both");
  both.enriched!.experience = [
    { title: "Bootcamp Fellow", company: "Stanford ASES", startYear: 2025, endYear: 2026 },
    { title: "Case Competition Judge", company: "Bain & Company", startYear: 2025 },
  ];
  const bt = held(both);
  check("a fellowship at a bootcamp is a role", bt.includes("Stanford ASES"), true);
  check("as is judging a competition", bt.some((l) => /Bain/.test(l)), true);
}

console.log("\nplaced at ISEF, as opposed to placed at something");
{
  /**
   * Two facts in one line, which text matching cannot express: the fair, and the
   * placing. Read per honour, so an ISEF row and an unrelated grand prize elsewhere
   * on the profile cannot combine into a credential neither one is.
   */
  const grand = (p: Person) => heldTags(p, TAX).some((t) => t.def.id === "isef-grand");
  const isef = (p: Person) => heldTags(p, TAX).some((t) => t.def.id === "isef");

  check(
    "a grand award at ISEF is the tier",
    grand(bare("won", ["International Science and Engineering Fair (ISEF) - 2nd Place Grand Award in Physics"])),
    true
  );
  check(
    "a grand prize somewhere else is not",
    grand(bare("piano", ["Fidelity Investments Young Artists Competition Grand Prize Winner"])),
    false
  );
  check(
    "nor is a grand prize at a business-plan contest",
    grand(bare("pitch", ["Diamond Challenge Grand Prize Finalist"])),
    false
  );
  check(
    "an ISEF finalist keeps the fair without the tier",
    (() => {
      const p = bare("finalist", ["Regeneron ISEF Finalist"]);
      return [isef(p), grand(p)];
    })(),
    [true, false]
  );
  /**
   * The two facts have to be in the same honour, not merely both on the profile.
   *
   * The second honour here does match the tier on its own — "1st Place" is one of
   * the forms ISEF itself uses — so this passes only because the two are read per
   * row. Pair it with a grand prize that matches nothing and the check would go
   * green whether the scoping worked or not.
   */
  check(
    "two separate honours do not add up to one award",
    grand(bare("split", ["Regeneron ISEF Finalist", "State Math League — 1st Place"])),
    false
  );

  /**
   * The same tier problem, one competition over.
   *
   * Megan D'Souza and Evan Xiang both held one USABO tag. Hers reads "Semifinalist,
   * Top 225, score of 31 on the Open Exam"; his reads "2x National Finalist, invited
   * to training camp" — roughly the top twenty in the country. Clearing the first
   * round is what the competition's own tag already means, so semifinalist and
   * qualifier are pointedly not tiers.
   */
  const camp = (p: Person) => heldTags(p, TAX).some((t) => t.def.label === "Olympiad camper");

  check(
    "a camp invitation is the tier",
    camp(bare("camper", ["2x National Finalist - USA Biology Olympiad (USABO). Invited to training camp."])),
    true
  );
  check(
    "a semifinal is not",
    camp(bare("semi", ["USABO Semifinalist. Top 225. Score of 31 on the Open Exam."])),
    false
  );
  check(
    "nor is qualifying",
    camp(bare("qual", ["USAMO Qualifier", "USACO Platinum Qualifier with a score of 1000/1000"])),
    false
  );
  /**
   * Science Olympiad is a school activity with a quarter of a million entrants and
   * was purged from the vocabulary for it. Matching the bare word "olympiad" would
   * have read "National Science Olympiad" as a national olympiad team.
   */
  check(
    "and a school activity with a national round is not an olympiad",
    camp(bare("sciolly", ["Science Olympiad National Tournament - National Team, 5x medallist"])),
    false
  );
  // Both facts in one honour, as above.
  check(
    "the olympiad and the tier have to be the same line",
    camp(bare("apart", ["USABO Semifinalist", "Debate — national team"])),
    false
  );
}

// ── Permanent deletion ───────────────────────────────────────────────────

console.log("\ndeleting for good is a blocklist, not just a missing row");
{
  /**
   * Rejecting works by *remembering* someone: the mark is what keeps them out of the
   * next sweep. Deleting throws that memory away along with everything else, so
   * without a list of its own "permanently" would last exactly until the next sweep
   * ran and re-added them as a new face.
   */
  check("a fresh team blocks nobody", emptyTeam().deleted, []);
  check(
    "a document written before the blocklist reads as empty, not undefined",
    hydrateTeam({ taxonomy: emptyTeam().taxonomy } as Partial<TeamState>).deleted,
    []
  );
  check(
    "a stored blocklist survives a read",
    hydrateTeam({ deleted: ["ada-chen-7a12"] } as Partial<TeamState>).deleted,
    ["ada-chen-7a12"]
  );

  // Slugs, normalised the same way the add path normalises them. A profile URL and a
  // bare slug have to land on the same key, or one trailing slash undoes a deletion.
  check(
    "a URL and a slug are the same block",
    cleanDeleted(["https://www.linkedin.com/in/ada-chen-7a12/", "ada-chen-7a12"]),
    ["ada-chen-7a12"]
  );
  check("junk is dropped rather than stored", cleanDeleted(["", "   ", 7, null]), []);
  check(
    "the list is capped, keeping the newest",
    (() => {
      const many = Array.from({ length: MAX_DELETED + 5 }, (_, i) => `person-${i}`);
      const out = cleanDeleted(many);
      return [out.length, out[out.length - 1]];
    })(),
    [MAX_DELETED, `person-${MAX_DELETED + 4}`]
  );

  /**
   * The blocklist is not part of the taxonomy, and a taxonomy save must not touch it.
   *
   * They share one document and `cleanTaxonomy` rebuilds its half field by field, so
   * the only thing keeping a deletion alive through a slider drag is that the two are
   * separate keys at the top level.
   */
  check(
    "a taxonomy save leaves the blocklist alone",
    mergeTeam(
      { ...emptyTeam(), deleted: ["ada-chen-7a12"] },
      { taxonomy: cleanTaxonomy(emptyTeam().taxonomy) }
    ).deleted,
    ["ada-chen-7a12"]
  );
  // And unblocking the last one has to be expressible, so an empty list is a real
  // value rather than "no change".
  check(
    "clearing the blocklist is a patch, not a no-op",
    mergeTeam({ ...emptyTeam(), deleted: ["ada-chen-7a12"] }, { deleted: [] }).deleted,
    []
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

  const tagged: Person = { ...bare("t"), extractedTerms: ["Brooke Owens Fellow", "RSI"] };
  const also: Person = { ...bare("u"), extractedTerms: ["Brooke Owens Fellow"] };
  const pending = unmatchedTerms([tagged, also], TAX);
  check("a term outside the taxonomy is offered", pending[0].term, "Brooke Owens Fellow");
  check("counted over real people", pending[0].count, 2);
  check("a term already in the taxonomy is not offered", pending.some((x) => x.term === "RSI"), false);
  check(
    "a dismissed term stops being offered",
    unmatchedTerms([tagged, also], { ...TAX, dismissed: ["Brooke Owens Fellow"] }).length,
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
    extractedTerms: ["Brooke Owens Fellow"],
  };

  const before = scoreOne(tagged, TAX);
  check("unpromoted, it carries no weight", before.signals.some((s) => s.label === "Brooke Owens Fellow"), false);

  // A tag IS the term now. There is no separate promoted list, no separate weights
  // map and no separate clusters map — one registry entry carries all three, which
  // is what makes two spellings of one award impossible.
  const promoted: TaxonomyPrefs = {
    ...TAX,
    tags: {
      ...TAX.tags,
      "brooke-owens": makeTag({
        label: "Brooke Owens Fellow",
        facet: "program",
        weight: 1.9,
        cluster: "research",
        promoted: true,
      }),
    },
  };
  const after = scoreOne(tagged, promoted);
  check("promoted, it scores", after.signals.some((s) => s.label === "Brooke Owens Fellow"), true);
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
  const byHand: Person = { ...bare("byhand"), manualTerms: ["Brooke Owens Fellow"] };
  check("a hand-added term scores once promoted too", scoreOne(byHand, promoted).signals.some((s) => s.label === "Brooke Owens Fellow"), true);

  // Casing must not matter, or the same credential scores for one person and not
  // another depending on how the model happened to capitalise it.
  const cased: Person = { ...bare("cased"), extractedTerms: ["brooke owens fellow"] };
  check("matching is case-insensitive", scoreOne(cased, promoted).signals.some((s) => s.label === "Brooke Owens Fellow"), true);

  // A term already found in the text must not be counted a second time.
  const both: Person = { ...bare("both", ["RSI"]), extractedTerms: ["RSI"] };
  check("a term in both text and tags counts once", scoreOne(both, TAX).signals.filter((s) => s.label === "RSI").length, 1);
}

// ── Scoring: fixed calibration ───────────────────────────────────────────

console.log("\nseeded aliases — one tag per real-world thing");
{
  const ix = indexRegistry(TAX.tags);
  const resolves = (written: string, expect: string) =>
    check(`"${written}" is ${expect}`, resolveAny(ix, written)?.label, expect);

  // The full legal name is what a LinkedIn education record actually says, while
  // the label is what people call it. Without the alias these are two tags for one
  // school, and neither carries the right holder count.
  resolves("Massachusetts Institute of Technology", "MIT");
  resolves("Stanford University", "Stanford");
  resolves("Thomas Jefferson High School for Science and Technology", "TJHSST");
  resolves("Phillips Exeter Academy", "Phillips Exeter");
  resolves("Research Science Institute", "RSI");
  resolves("Regeneron Science Talent Search", "STS");
  resolves("Andreessen Horowitz", "a16z");
  // A headline writes it every which way.
  resolves("Z Fellows", "Z Fellow");
  resolves("Z-Fellow", "Z Fellow");
  /**
   * Z Fellows writes you a cheque, so it is an accelerator, not a programme.
   *
   * The facet is what carries the weight scale: as a programme it sat on the same
   * shelf as a summer course, and the whole point of the accelerator facet is that
   * being funded is a harder filter than being admitted.
   */
  const z = resolveAny(ix, "Z Fellow")!;
  check("Z Fellow is an accelerator", z.facet, "accelerator");
  check("and it votes Founder", z.cluster, "founder");
  // Distinct things must stay distinct.
  check("USACO Gold is not USACO Platinum", resolveAny(ix, "USACO Gold")?.label, undefined);
}

console.log("\nschool containment — a programme name wrapped around a school");
{
  const ix = indexRegistry(TAX.tags);
  const school = (label: string, facet: "college" | "highschool", expect: string | null) => {
    const r = resolveTag(ix, { label, facet });
    check(
      `${JSON.stringify(label.slice(0, 44))} is ${expect ?? "not a known school"}`,
      r.kind === "exact" ? r.def.label : null,
      expect
    );
  };

  // An education record routinely names the programme, not the school. That is
  // still the school, and an exact-key match will never see it.
  school("UC Berkeley Management, Entrepreneurship, & Technology (M.E.T.) program", "college", "Berkeley");
  school("MIT Beaver Works Summer Institute", "college", "MIT");
  school("Carnegie Mellon University School of Computer Science", "college", "Carnegie Mellon");
  school("Harvard Extension School", "college", "Harvard");

  // The hazard of containment, and the two things that contain it.
  // A high-school record is never matched against a college tag, so "Stanford
  // Online High School" cannot become Stanford.
  // It is a school in its own right, and the point is that it is not Stanford.
  school("Stanford Online High School", "highschool", "Stanford Online High School");
  check(
    "an online high school is not the university whose name it carries",
    resolveTag(indexRegistry(TAX.tags), { label: "Stanford Online High School", facet: "highschool" })
      .kind === "exact" &&
      resolveAny(indexRegistry(TAX.tags), "Stanford Online High School")?.label !== "Stanford",
    true
  );
  // And a genuinely different institution whose name contains a shorter one is
  // named in an exclusion list.
  school("Michigan State University", "college", null);
  school("Washington State University", "college", null);

  // Token-aligned, so a name is never matched inside a longer word.
  check("mit does not match inside summit", containsTokens("summit-prep", "mit"), false);
  check("but does match a whole token", containsTokens("mit-beaver-works", "mit"), true);
  check("and the run must be contiguous", containsTokens("california-santa-cruz-berkeley", "california-berkeley"), false);
}

console.log("\nhome state — from the high school, not from any state on the profile");
{
  const look = schoolStateLookup(TAX);
  const withSchools = (eds: { school: string; degree?: string; endYear?: number }[]) => {
    const p = bare("geo");
    p.enriched!.educations = eds;
    return inferHomeState(p.enriched!, look);
  };

  // The school decides. Scanning the profile for any state name instead put six
  // of nineteen real people in the wrong state.
  check(
    "a seeded high school knows its state",
    withSchools([{ school: "Sewickley Academy", degree: "High School Diploma" }]),
    "Pennsylvania"
  );
  check(
    "and so does one written in full",
    withSchools([{ school: "Phillips Exeter Academy", degree: "High School Diploma" }]),
    "New Hampshire"
  );
  // The high school decides even when a university is also listed, because the
  // university is where they went next, not where they are from.
  check(
    "the high school wins over the university",
    withSchools([
      { school: "Groton School", degree: "High School Diploma", endYear: 2025 },
      { school: "Stanford University", degree: "Bachelor of Science", endYear: 2029 },
    ]),
    "Massachusetts"
  );
  // No high school at all: the university is the only evidence there is.
  check(
    "with no high school listed, the university is used",
    withSchools([{ school: "MIT", degree: "Bachelor of Science" }]),
    "Massachusetts"
  );
  // An online school has no state, and must not inherit one from the university
  // whose name it carries.
  check(
    "an online high school yields nothing rather than a guess",
    withSchools([
      { school: "Stanford Online High School", degree: "Supplemental Coursework" },
      { school: "Stanford University", degree: "Bachelor of Science" },
    ]),
    undefined
  );

  // Current and home are separate facets, so both can be held at once.
  const p = bare("bothgeo");
  p.enriched!.educations = [{ school: "Decatur High School", degree: "High School Diploma" }];
  // `region` is the vendor's structured code and rightly beats the display
  // string, so the fixture sets it rather than only the free text.
  p.enriched!.region = "CA";
  p.enriched!.location = "Stanford, California, United States";
  const facets = extractTags(p, look).tags;
  check("current state is tagged", facets.find((t) => t.facet === "state")?.label, "California");
  check("home state is tagged separately", facets.find((t) => t.facet === "homestate")?.label, "Georgia");
  check(
    "and the home state is marked as inferred",
    facets.find((t) => t.facet === "homestate")?.inferred,
    true
  );
}

console.log("\naccelerators — the signal that was invisible");
{
  /**
   * Every way a batch actually appears on a profile, and it appeared none of the
   * ways the code was looking.
   *
   * Four people in the roster showed YC three times over — an education row, a
   * company registered as "Poth Labs (YC S26)", and "YC S26" in the headline — and
   * scored nothing for any of it. The education row resolved as a *university*,
   * because that is what an undated row with no degree looks like.
   */
  // Geography comes along from the fixture's location and is not what is under test.
  const held = (p: Person) =>
    heldTags(p, TAX)
      .filter((t) => t.def.facet !== "state" && t.def.facet !== "homestate")
      .map((t) => `${t.def.label}[${t.def.facet}]`);

  const batchRow = bare("batch");
  batchRow.enriched!.educations = [{ school: "Y Combinator", degree: "S26" }];
  check("a batch in the education section is the accelerator", held(batchRow), [
    "Y Combinator[accelerator]",
  ]);

  const plural = bare("plural");
  plural.enriched!.educations = [{ school: "Z Fellows", degree: "Gap Year" }];
  check("and the plural spelling resolves too", held(plural), ["Z Fellow[accelerator]"]);

  /**
   * The company's registered name.
   *
   * "(YC S24)" is part of what a YC company calls itself, and it says investors
   * funded this. Company names are resolved by exact key with containment
   * deliberately off — "ex-Google intern" must not become a Google role — so this
   * needed its own narrow rule rather than a general loosening.
   */
  const marked = bare("marked");
  marked.enriched!.experience = [{ title: "Co-Founder", company: "Willow (YC S24)" }];
  check("a batch marker in a company name counts", held(marked).includes("Y Combinator[accelerator]"), true);
  check(
    "a company that merely mentions one does not",
    held(
      Object.assign(bare("plain"), {
        enriched: {
          ...bare("plain").enriched!,
          experience: [{ title: "Intern", company: "Some YC-backed startup" }],
        },
      })
    ).includes("Y Combinator[accelerator]"),
    false
  );

  /**
   * Prose about a venture is not a claim about the person.
   *
   * Olaoluwa Oguneye is a Partner at Dorm Room Fund, "the original student-run
   * venture fund backed by a16z" — a sentence about the fund, which scored him 1.8
   * as though a16z had backed him.
   */
  const aboutTheFund = bare("fund");
  aboutTheFund.enriched!.experience = [
    {
      title: "Partner",
      company: "Dorm Room Fund",
      description: "The original student-run venture fund, backed by a16z and Sequoia.",
    },
  ];
  check("someone else's backers do not transfer", held(aboutTheFund).includes("a16z[accelerator]"), false);

  /**
   * But a founder's do.
   *
   * Tarun Batchu is CEO of Vela, whose description reads "Backed by a16z (sr007) and
   * Z Fellows" — the same shape of sentence as the one above, and true about him,
   * because when you founded the company its backers are your backers. Excluding the
   * field outright threw the real one away with the false one; the role is what tells
   * them apart.
   */
  const ownVenture = bare("own");
  ownVenture.enriched!.experience = [
    { title: "CEO", company: "Vela", description: "Backed by a16z (sr007) and Z Fellows" },
  ];
  check("a founder's own backing does", held(ownVenture).includes("a16z[accelerator]"), true);

  // Their own headline does count: naming it about yourself is the claim.
  const claimed = bare("claimed");
  claimed.enriched!.headline = "CEO, Headstarter | a16z Speedrun Scout";
  check("but their own headline does", held(claimed).includes("a16z[accelerator]"), true);

  /**
   * A paper's title names its subject, not its author's backers.
   *
   * Philip Meng published "EnDive: A Cross-Dialect Benchmark for Fairness and
   * Performance in Large Language Models", and the word benchmark in it read as
   * Benchmark the fund: +1.5 on the second-ranked person in the queue, off a
   * credential that appears nowhere on his profile. The population is full of ML
   * researchers and the investor list is full of common English words, so this was
   * every paper any of them will ever write, not one unlucky title.
   */
  const author = bare("author");
  author.enriched!.publications = [
    "EnDive: A Cross-Dialect Benchmark for Fairness and Performance in Large Language Models",
  ];
  check("a paper title is not a claim", held(author).includes("Benchmark[accelerator]"), false);

  // Patents read the same way. A certification does not: it is a claim about the
  // person in the way a headline is, not the name of a thing they made.
  const patented = bare("patented");
  patented.enriched!.patents = ["Index structures for sparse retrieval"];
  check("nor is a patent title", held(patented).includes("Index Ventures[accelerator]"), false);

  const certified = bare("certified");
  certified.enriched!.certifications = ["Emergent Ventures Fellowship 2025"];
  check("but a certification is", held(certified).includes("Emergent Ventures[accelerator]"), true);

  /**
   * A famous name attached to an open-enrolment product.
   *
   * YC Startup School is a free online course. It read as YC itself and put the
   * heaviest weight in the taxonomy on "Y Combinator Startup School 2026 Admit".
   */
  const school = bare("school", ["Y Combinator Startup School 2026 Admit"]);
  check("Startup School is not Y Combinator", held(school).includes("Y Combinator[accelerator]"), false);

  // A two-character alias in prose is a coincidence waiting to happen: "10 companies
  // into yc/a16z sr." is a placement business, not a batch.
  const placer = bare("placer");
  placer.enriched!.experience = [
    { title: "Founder", company: "Headstarter", description: "10 companies into yc/a16z sr." },
  ];
  check("a two-letter alias is not text-matched", held(placer).includes("Y Combinator[accelerator]"), false);

  // A company named for an acronym is not the programme of that acronym.
  const acronym = bare("acronym");
  acronym.enriched!.experience = [{ title: "Researcher", company: "SSP International" }];
  check("a company name is not the credential vocabulary", held(acronym).includes("SSP[program]"), false);

  // An accelerator has an address, not a home town.
  const noHome = bare("nohome");
  noHome.enriched!.educations = [{ school: "Y Combinator", degree: "S26" }];
  check("and it sets no home state", inferHomeState(noHome.enriched!, schoolStateLookup(TAX)), undefined);
}

console.log("\nprose — the text says it, however it is spelled");
{
  /**
   * The old matcher compiled each tag's label and aliases into a regex and tested
   * them against the text. It failed in both directions for one reason: aliases are
   * stored as *normalised keys*, so `research-science` was asked to appear in prose
   * with its hyphen, while a bare one-token key like `imo` matched any whole word.
   *
   * Thirty-eight of the sixty-eight text-matched tags had no alias that could ever
   * fire, and fifteen of fifty-six people in the roster were missing a credential
   * they plainly hold. Every case below was verified wrong before `scanText`.
   */
  const held = (p: Person) =>
    heldTags(p, TAX)
      .filter((t) => t.def.facet === "program" || t.def.facet === "accelerator")
      .map((t) => t.def.label);

  const prose = (extra: Partial<NonNullable<Person["enriched"]>>): Person => {
    const p = bare("prose");
    p.enriched = { ...p.enriched!, ...extra };
    return p;
  };

  // ── Spellings that used to miss ──────────────────────────────────────────
  /**
   * This exact sentence is quoted in lib/tags.ts as the case the accelerator design
   * was built around, and the plural on "Fellows" meant it never produced the tag:
   * the label needs a space and the alias key `z-fellows` needs a hyphen.
   */
  const backed = prose({
    experience: [{ title: "CEO", company: "Vela", description: "Backed by a16z (sr007) and Z Fellows" }],
  });
  check("a plural does not hide the tag", held(backed).includes("Z Fellow"), true);
  check("and the other name in the sentence still lands", held(backed).includes("a16z"), true);

  // Thiel Fellow has no usable alias at all — every one of its four normalises onto
  // the id — so before this only the exact string "Thiel Fellow" worked.
  check(
    "an inflection does not either",
    held(prose({ headline: "Founder | Thiel Fellowship 2025" })).includes("Thiel Fellow"),
    true
  );
  check(
    "nor a possessive plural",
    held(prose({ honors: [{ title: "Davidson Fellows Scholarship" }] })).includes("Davidson Fellow"),
    true
  );
  // Andra Campos writes "Coca Cola", with no hyphen, and is a semi-finalist.
  check(
    "nor a missing hyphen",
    held(prose({ honors: [{ title: "Coca Cola Scholarship Semi-Finalist" }] })).includes("Coca-Cola Scholar"),
    true
  );
  check(
    "nor a cohort plural",
    held(prose({ headline: "Neo Scholars 2024 cohort" })).includes("Neo Scholar"),
    true
  );
  // A multi-token alias, which no hyphenated key could ever match in prose.
  check(
    "a spelled-out name reaches its abbreviation",
    held(prose({ honors: [{ title: "Research Science Institute" }] })).includes("RSI"),
    true
  );

  // ── Words that are also names ────────────────────────────────────────────
  /**
   * The other half. Matching on normalised keys matches far more, so the per-tag
   * `match` policy has to arrive with it; these two blocks are one change.
   */
  check("an opinion is not an olympiad", held(prose({ about: "imo the best approach is RL" })).includes("IMO"), false);
  check("but IMO Gold is", held(prose({ honors: [{ title: "IMO Gold Medal 2025" }] })).includes("IMO"), true);

  // In a population of mathematicians this is the worst-fitting alias in the table.
  check(
    "a conjecture is not a programme",
    held(prose({ about: "worked on the twin primes conjecture" })).includes("MIT PRIMES"),
    false
  );

  // Davido Zhang carried Lightspeed +1.5 from this. It is Tencent's game studio.
  check(
    "a game studio is not a venture fund",
    held(
      prose({
        experience: [
          { title: "Founder", company: "Q", description: "multi-agent networks with mentors from the Lightspeed Studios" },
        ],
      })
    ).includes("Lightspeed"),
    false
  );

  check("a trend is not a fellowship", held(prose({ about: "the rise of transformers" })).includes("Rise"), false);
  // The case that started all of this.
  check(
    "a paper's benchmark is not a fund",
    held(prose({ about: "EnDive: A Cross-Dialect Benchmark for Fairness" })).includes("Benchmark"),
    false
  );
  check("a conjunction is not an accelerator", held(prose({ about: "on the contrary, we found" })).includes("Contrary"), false);
  check("a national park is not Sequoia Capital", held(prose({ about: "Sequoia National Park volunteer" })).includes("Sequoia"), false);

  // The discriminating pair: the same name, twice, once real.
  const imu = prose({ about: "IMU accel and gyro fusion on an STM32" });
  check("an accelerometer is not Accel", held(imu).includes("Accel"), false);
  const round = prose({
    experience: [{ title: "Founder", company: "Q", description: "raised a seed round backed by Accel" }],
  });
  check("being backed by Accel is", held(round).includes("Accel"), true);

  // ── The quote ───────────────────────────────────────────────────────────
  /**
   * The evidence is shown to a human and sent to the model, so the words matter.
   *
   * A window can widen without the key changing, because noise words are dropped
   * when the key is built — and whether that is an improvement depends on which
   * noise word it swallowed. "Institute" is part of the programme's name and
   * "Finalist" is how far somebody got; "of" is a dangling preposition.
   */
  const quote = (text: string) => {
    const found = scanText(text, indexRegistry(TAX.tags));
    return found.length === 1 ? found[0].span.text : found.map((f) => f.span.text);
  };
  check("the quote is the whole name", quote("Research Science Institute 2024"), "Research Science Institute");
  check("including the rung", quote("Neo Scholar Finalist"), "Neo Scholar Finalist");
  check("and the sponsor", quote("Regeneron Science Talent Search Scholar"), "Regeneron Science Talent Search Scholar");
  check("but not a trailing join", quote("contributed to the rise of transformers"), "rise");

  // ── The one-character key ────────────────────────────────────────────────
  /**
   * "Z Fellow" normalised to `z`, because `fellow` is noise, and `resolveAny` is
   * facet-blind. `schoolStateLookup` asks the accelerator facet before any school
   * facet, so an education row named simply "Z" took the heaviest weight in the
   * taxonomy — and suppressing the string "Z" suppressed the real tag.
   */
  const justZ = bare("justz");
  justZ.enriched!.educations = [{ school: "Z", degree: "Student" }];
  check("a school called Z is not Z Fellows", held(justZ).includes("Z Fellow"), false);
  const zScholar = bare("zscholar", ["Z Scholar"]);
  check("and neither is a Z Scholar", held(zScholar).includes("Z Fellow"), false);
  const real = bare("realz");
  real.enriched!.educations = [{ school: "Z Fellows", degree: "W24" }];
  check("but the real batch row still is", held(real).includes("Z Fellow"), true);

  // ── Working there is not having been through it ──────────────────────────
  /**
   * A Google result for a LinkedIn profile ends in the profile's own field list, and
   * the `Experience:` segment names employers. Baylor Adams works at Z Fellows — his
   * headline is "Early stage investor" and the only mention anywhere is "Experience:
   * Z Fellows" — and he was scored 2.0 as though he had been through the batch.
   * Sonith Sunku has no headline at all and the same snippet shape.
   */
  const staff: Person = {
    ...bare("staff"),
    enriched: undefined,
    headline: "Early stage investor",
    snippet:
      "Early stage investor \u00b7 Experience: Z Fellows \u00b7 Education: University of Southern California \u00b7 Location: United States",
  };
  check("an employer in a snippet is not a batch", held(staff).includes("Z Fellow"), false);

  /**
   * `Education:` is left alone, because that is where somebody who really did the
   * batch lists it. Anish Shinde's reads "Education: Z Fellows".
   */
  const alum: Person = {
    ...bare("alum"),
    enriched: undefined,
    headline: "Founder @ Markov",
    snippet: "Founder @ Markov \u00b7 Experience: Markov \u00b7 Education: Z Fellows \u00b7 Location: SF",
  };
  check("but the education segment is", held(alum).includes("Z Fellow"), true);

  // And a headline claim is untouched by any of it.
  const claimed2: Person = {
    ...bare("claimed2"),
    enriched: undefined,
    headline: "Founder @ Markov | Z Fellow",
    snippet: "Founder @ Markov | Z Fellow \u00b7 Experience: Markov \u00b7 Location: SF",
  };
  check("as is a headline that says so", held(claimed2).includes("Z Fellow"), true);
}

console.log("\nnational is not international, and a withdrawn alias has to leave");
{
  const index = indexRegistry(TAX.tags);
  const to = (label: string) => resolveAny(index, label)?.label ?? null;

  /**
   * `national` and `international` were noise words, and they were the most expensive
   * two in the set. Stripping them made "National Biology Olympiad" and
   * "International Biology Olympiad" one key, owned by the international tag, so a
   * USABO semifinalist scored IBO's 2.0 instead of USABO's 0.5 — four times over, on
   * the distinction that matters most in a competition credential.
   */
  check("a national olympiad is the national one", to("National Biology Olympiad Semifinalist"), "USABO");
  check("and the world final is still the world final", to("International Biology Olympiad"), "IBO");
  check("the same for physics", to("National Physics Olympiad"), "USAPhO");
  check("and for its world final", to("International Physics Olympiad"), "IPhO");

  /**
   * The same word was also letting every state and regional fair read as ISEF.
   * Vihaan Shringi's honour is "WSSEF First Place" — the Washington State Science and
   * Engineering Fair — and it scored the International one.
   */
  check("a state fair is not ISEF", to("Washington State Science and Engineering Fair"), null);
  check("the international one is", to("International Science and Engineering Fair"), "ISEF");

  /**
   * `mathematical-olympiad` was the only duplicate alias key in the taxonomy, held by
   * both IMO and MOP, and `indexRegistry` is first-wins — so the summer programme
   * resolved to the world final at 2.0. IMO now owns its full name instead.
   */
  check("the olympiad programme is not the olympiad", to("Mathematical Olympiad Program"), "MOP");
  check("and the world final still resolves", to("International Mathematical Olympiad"), "IMO");

  /**
   * Withdrawing an alias from a seed list used to change nothing for a team that
   * already had a taxonomy: `migrateFacets` unions stored aliases with seeded ones
   * and only surrenders a key the seeds reassigned to somebody else, so an alias with
   * no owner at all was nobody's to take away. Both fixes above were no-ops in
   * production until PURGED_ALIASES existed.
   */
  const seedOwned = new Set<string>();
  for (const def of Object.values(emptyTeam().taxonomy.tags)) {
    for (const a of def.aliases) seedOwned.add(a);
  }
  check(
    "nothing purged is still owned by a seed",
    PURGED_ALIASES.filter((a) => seedOwned.has(a)),
    []
  );

  const carrying = emptyTeam().taxonomy;
  const ibo = Object.values(carrying.tags).find((d) => d.label === "IBO")!;
  const withStale = hydrateTeam({
    taxonomy: {
      ...carrying,
      tags: { ...carrying.tags, [ibo.id]: { ...ibo, aliases: [...ibo.aliases, "biology-olympiad"] } },
    },
  } as Parameters<typeof hydrateTeam>[0]);
  check(
    "a stored document loses a withdrawn alias",
    withStale.taxonomy.tags[ibo.id].aliases.includes("biology-olympiad"),
    false
  );
  check(
    "and keeps the one it should have",
    withStale.taxonomy.tags[ibo.id].aliases.includes("international-biology-olympiad"),
    true
  );

  // Four lab ids moved when `national` stopped being deleted. RENAMED carries the
  // team's tuning across rather than leaving it on a row nobody holds.
  // The destination id is removed first, because a document written before the move
  // has only the old row. Leaving both in would test the collision rule instead.
  const beforeMove = { ...carrying.tags };
  delete beforeMove["argonne-national-laboratory"];
  const oldLab = hydrateTeam({
    taxonomy: {
      ...carrying,
      // Stamped, or `behindSeeds` fires and adoptSeedWeights resets the hand weight
      // this check is about. A document written by the current app carries it.
      seedVersion: SEED_VERSION,
      tags: {
        ...beforeMove,
        "argonne-laboratory": {
          id: "argonne-laboratory",
          label: "Argonne National Laboratory",
          facet: "lab",
          aliases: [],
          weight: 1.9,
          cluster: null,
          promoted: true,
        },
      },
    },
  } as Parameters<typeof hydrateTeam>[0]);
  check("a moved id carries its weight", oldLab.taxonomy.tags["argonne-national-laboratory"]?.weight, 1.9);
  check("and leaves nothing behind", oldLab.taxonomy.tags["argonne-laboratory"], undefined);
}

console.log("\ntiers — a finalist is not a winner");
{
  /**
   * `normalizeKey` deletes "winner", "finalist", "semifinalist" and "qualifier",
   * which is right for a key and was throwing away the only thing separating two
   * people holding the same name. Michael Yu's honour reads "Neo Scholar Finalist"
   * and he took the full 1.5 of being a Neo Scholar; Andra Campos wrote "Coca Cola
   * Scholarship Semi-Finalist" and took the full 1.2.
   */
  const scored = (honor: string) => {
    const p = bare("tier", [honor]);
    return matchedTerms(p, TAX);
  };
  const w = (honor: string, label: string) => scored(honor).find((t) => t.label === label)?.weight;
  const tier = (honor: string, label: string) => scored(honor).find((t) => t.label === label)?.tier;

  check("being a Neo Scholar is 1.5", w("Neo Scholar", "Neo Scholar"), 1.5);
  check("reaching the final is 0.8", w("Neo Scholar Finalist", "Neo Scholar"), 0.8);
  check("and the rung is recorded", tier("Neo Scholar Finalist", "Neo Scholar"), "finalist");

  /**
   * "Semi-Finalist" with a hyphen puts a word boundary in front of "finalist", so a
   * naive strength ordering promotes a semifinalist two rungs. Both spellings have
   * to land on the same rung.
   */
  check("a hyphenated semi-final is a semi-final", tier("Coca-Cola Scholar Semi-Finalist", "Coca-Cola Scholar"), "semifinalist");
  check("and so is the one word", tier("Coca-Cola Scholar Semifinalist", "Coca-Cola Scholar"), "semifinalist");
  check("priced below the finalist", w("Coca-Cola Scholar Semifinalist", "Coca-Cola Scholar"), 0.3);
  check("which is priced below the scholar", w("Coca-Cola Scholar Finalist", "Coca-Cola Scholar"), 0.5);
  // The seeded base, not the 1.2 this team has tuned it to. Rungs are absolute.
  check("and the scholar keeps the whole weight", w("Coca-Cola Scholar", "Coca-Cola Scholar"), 0.8);

  /**
   * USACO names its divisions after medals, so "a score of 1000/1000 on Gold" is a
   * division and not a placing. Davido Zhang's honour says Qualifier in as many
   * words and read as a win.
   */
  check(
    "a USACO division is not a medal",
    readTier("USACO Platinum Mar 2022 Qualifier with a score of 1000/1000 on Gold"),
    "qualifier"
  );
  // And bare gold is still a medal everywhere else. Brian Zhang has one.
  check("but IPhO Gold is", readTier("IPhO Gold '25"), "winner");

  /**
   * Containment resolving to the wrong institution, all fifteen verified wrong.
   *
   * A LinkedIn education row wraps the school in extra words, so containment is what
   * makes "UC Berkeley M.E.T. program" resolve to Berkeley. The hazard is the school
   * whose name merely *contains* another's: "Penn State University" scored a UPenn
   * degree, "Cal Poly San Luis Obispo" and "Cal State Fullerton" both scored
   * Berkeley through the `cal` alias, "Duke Kunshan" scored Duke.
   *
   * The high schools were worse, because the facet split that saves the colleges
   * cannot help — Exeter Township Senior High School and Phillips Exeter are both
   * high schools, so containment could only ever get it wrong.
   */
  const at = (label: string, facet: "college" | "highschool" | "lab") => {
    const r = resolveTag(indexRegistry(TAX.tags), { label, facet });
    return r.kind === "exact" ? r.def.label : null;
  };

  for (const [label, facet] of [
    ["Penn State University", "college"],
    ["Pennsylvania State University", "college"],
    ["Cal Poly San Luis Obispo", "college"],
    ["Cal State Fullerton", "college"],
    ["Michigan Technological University", "college"],
    ["University of Michigan-Dearborn", "college"],
    ["Duke Kunshan University", "college"],
    ["Columbia College Chicago", "college"],
    ["Exeter Township Senior High School", "highschool"],
    ["Andover High School", "highschool"],
    ["Groton-Dunstable Regional High School", "highschool"],
    ["Dalton High School", "highschool"],
    ["Media Lab Helsinki", "lab"],
    ["Broad Research Group", "lab"],
  ] as [string, "college" | "highschool" | "lab"][]) {
    check(`${label} is not a tag`, at(label, facet), null);
  }

  // And the real ones still resolve, including the wrapped-in-a-programme case that
  // containment exists for.
  check("Penn is still Penn", at("University of Pennsylvania", "college"), "UPenn");
  check("Chicago is still Chicago", at("University of Chicago", "college"), "UChicago");
  check("Columbia is still Columbia", at("Columbia University", "college"), "Columbia");
  check("Exeter is still Exeter", at("Phillips Exeter Academy", "highschool"), "Phillips Exeter");
  check("Groton is still Groton", at("Groton School", "highschool"), "Groton");
  check(
    "and a programme around a school is still the school",
    at("UC Berkeley Management, Entrepreneurship, & Technology program", "college"),
    "Berkeley"
  );

  /**
   * A batch code or a rung is not part of the name.
   *
   * The tagger returns what the profile says, and the profile says "YC S26", "5x AIME
   * Qualifier", "TreeHacks 2026 Winner", "NACLO Bronze". `normalizeKey` keeps digits,
   * rightly — "1517 Fund" and "645 Ventures" are named with them — so the cohort code
   * stayed in the key and none of those reached the tag they plainly name. Thirty of
   * the sixty-two credentials the tagger found on this roster could not score, and
   * this was the largest single cause.
   */
  const term = (label: string) => resolveAny(indexRegistry(TAX.tags), label)?.label ?? null;
  check("a batch code is not part of the name", term("YC S26"), "Y Combinator");
  check("nor is a year", term("TreeHacks 2026 Winner"), "TreeHacks");
  check("nor a count", term("3x Regeneron ISEF Finalist"), "ISEF");
  check("nor a medal", term("NACLO Bronze"), "NACLO");
  check("nor an honourable mention", term("NCWiT Aspirations in Computing Honorable Mention"), "NCWIT Aspirations");

  /**
   * A fallback, not a rule: the exact key always wins first. USACO names a division
   * Platinum, so stripping grading words as a rule would have folded USACO Platinum
   * into nothing at all.
   */
  check("but a name made of one is still itself", term("USACO Platinum"), "USACO Platinum");
  check("and so is a fund named with a number", term("1517 Fund"), "1517 Fund");

  // A tag with no ladder reads the tier and charges the same for it. Most
  // credentials either happened or did not.
  check("an unladdered tag still reports the rung", tier("USAMO Qualifier", "USAMO"), "qualifier");
  check("but is not discounted for it", w("USAMO Qualifier", "USAMO"), w("USAMO", "USAMO"));

  /**
   * Read from the field that produced the match, not the profile. A semifinal in one
   * honour must not grade another — the property the ISEF tier check already had.
   */
  const two = bare("two", ["Neo Scholar", "Davidson Fellows Semifinalist"]);
  const terms = matchedTerms(two, TAX);
  check("one honour's rung does not reach another", terms.find((t) => t.label === "Neo Scholar")?.tier, undefined);
  check("and the other honour keeps its own", terms.find((t) => t.label === "Davidson Fellow")?.tier, "semifinalist");

  /**
   * The tagger states the tier plainly in the term it returns — "USABO Semifinalist",
   * "Neo Scholar Finalist" — and `normalizeKey` is about to delete exactly that word.
   */
  const fromTagger = bare("tagger");
  fromTagger.extractedTerms = ["Neo Scholar Finalist"];
  check(
    "a tagger's own term carries its rung",
    matchedTerms(fromTagger, TAX).find((t) => t.label === "Neo Scholar")?.weight,
    0.8
  );
}

console.log("\nlabs, clubs and startups — everything that was filed as a company");
{
  const held = (p: Person) =>
    heldTags(p, TAX)
      .filter((t) => t.def.facet !== "state" && t.def.facet !== "homestate")
      .map((t) => `${t.def.label}[${t.def.facet}]`);

  /**
   * Jacob Lee's profile, in miniature.
   *
   * Tech Lead of Stanford ASES, researcher at the Stanford Multi-Robot Systems Lab,
   * growth at Cluely, a founding role at a YC company, a TreeHacks track win and a
   * Breakthrough Junior final — and none of it scored. The clubs and labs were read
   * as employers and matched nothing; the hackathons were not in the vocabulary at
   * all.
   */
  const jacob = bare("jacob", [
    "TreeHacks Interaction Track Winner",
    "Second Place CalHacks Audio Track",
    "Breakthrough Junior Challenge Finalist",
  ]);
  jacob.enriched!.experience = [
    { title: "Tech Lead", company: "Stanford ASES" },
    { title: "Researcher", company: "Stanford Multi-Robot Systems Lab" },
    { title: "Growth Team", company: "Cluely" },
    { title: "Founding Growth Manager", company: "Friday (YC F24)" },
  ];
  const jt = held(jacob);
  /**
   * The batch belongs to the founders.
   *
   * "Founding Growth Manager" is employee number five. Reading it as a founder gave
   * Jacob Lee the full 2.0 for Y Combinator off a job at a YC company, which put him
   * level with the people who actually got into the batch — and third on the list,
   * where he does not belong.
   */
  check("an early hire at a YC company is not YC", jt.includes("Y Combinator[accelerator]"), false);
  check("a student society is a club", jt.includes("Stanford ASES[club]"), true);
  check("a research group is a lab", jt.includes("Stanford Multi-Robot Systems Lab[lab]"), true);
  check("a known early-stage company is a startup", jt.includes("Cluely[startup]"), true);
  check("a hackathon win counts", jt.includes("TreeHacks[program]"), true);
  check("so does a second place", jt.includes("CalHacks[program]"), true);
  check("and a competition final", jt.includes("Breakthrough Junior Challenge[program]"), true);
  const founded = bare("founded");
  founded.enriched!.experience = [{ title: "Co-Founder & CTO", company: "Willow (YC S24)" }];
  check("but a co-founder of one is", held(founded).includes("Y Combinator[accelerator]"), true);

  /**
   * The pattern only has to be good enough to file a name it has never seen.
   *
   * A curated name overrules it: "Cluely" contains no word meaning startup and
   * "Stanford ASES" none meaning club, so the registry has the last word — exactly as
   * it does for schools.
   */
  check("a name saying lab is a lab", classifyOrg("Berkeley Robotics Lab", "Intern"), "lab");
  check("a name saying society is a club", classifyOrg("Entrepreneurship Society", "Chair"), "club");
  check("a batch marker is a startup", classifyOrg("Willow (YC S24)", "Engineer"), "startup");
  check("founding one makes it a startup", classifyOrg("Vela", "Co-Founder"), "startup");
  check("working at one does not", classifyOrg("Vela", "Intern"), "company");
  check("and an ordinary employer stays one", classifyOrg("Google", "Software Engineer"), "company");

  /**
   * Everything unresolved reaches the review queue, carrying what it already is.
   *
   * The queue only ever saw what the tagger read out of prose, so a lab, a society or
   * a seed-stage startup in the experience section was not tagged, not scored, and
   * never even offered — there was no way to fix it from the screen. And an offer with
   * no facet is why promoting one filed it as an award.
   */
  const unknown = bare("unknown");
  unknown.enriched!.experience = [
    { title: "Researcher", company: "Some Unheard-Of Research Lab" },
    { title: "President", company: "Some Unheard-Of Society" },
  ];
  const offered = unmatchedTerms([unknown], TAX);
  check(
    "an unknown lab is offered as a lab",
    offered.find((o) => o.term === "Some Unheard-Of Research Lab")?.facet,
    "lab"
  );
  check(
    "an unknown society as a club",
    offered.find((o) => o.term === "Some Unheard-Of Society")?.facet,
    "club"
  );
  // A title or a class year arriving here would bury the queue in noise.
  check("and a job title is not offered at all", offered.some((o) => o.term === "President"), false);
}

console.log("\ntier and outcome — winning is not attending, and founding is not joining");
{
  const held = (p: Person) =>
    heldTags(p, TAX)
      .filter((t) => t.def.facet !== "state" && t.def.facet !== "homestate")
      .map((t) => t.def.label);

  /**
   * One tag per competition cannot say how well someone did in it.
   *
   * "ISEF — 2nd Place Grand Award in Physics & Astronomy" is top-two in a category
   * against 1,800 finalists, and it scored exactly what "ISEF Finalist" scored. The
   * flag carries the outcome for every competition at once, and ISEF — much the
   * largest, so much the widest gap between tiers — also gets a tag for the tier.
   */
  const won = bare("won", ["ISEF - 2nd Place Grand Award in Physics & Astronomy"]);
  const wt = held(won);
  check("ISEF's award tier is its own tag", wt.includes("ISEF Grand Award"), true);
  /**
   * A placing at a science fair is not a hackathon win.
   *
   * The flag used to be "Competition winner" and fired on any placing in any honour,
   * which made it true of thirteen people and specific about none: a piano
   * competition, a business case, a state science fair and three actual hackathons
   * all carried it. Named for hackathons, it requires one.
   */
  check("and not a hackathon win", wt.includes("Hackathon winner"), false);

  const reached = bare("reached", ["3x Regeneron ISEF Finalist"]);
  const rt = held(reached);
  check("reaching the final is not a Grand Award", rt.includes("ISEF Grand Award"), false);
  check("but it is still ISEF", rt.includes("ISEF"), true);

  // The three spellings that actually appear, and the two that must not count.
  for (const [title, want] of [
    ["TreeHacks 2026 Winner: Build with Poke Track", true],
    ["Second Place CalHacks Audio Track", true],
    ["Stanford First Place Hackathon Winner", true],
    ["TreeHacks 2026 Finalist", false],
    ["Fidelity Investments Young Artists Competition Grand Prize Winner", false],
  ] as [string, boolean][]) {
    check(
      `${want ? "counts" : "does not count"}: ${title.slice(0, 44)}`,
      held(bare(`hack-${title.length}-${String(want)}`, [title])).includes("Hackathon winner"),
      want
    );
  }

  /**
   * Founding a funded company is two facts, and only one was scored.
   *
   * The batch is the filter they cleared; the company is what they built. Scoring only
   * the first put YC founders whose profiles say little else below people with a
   * science-fair award and a pile of hackathons — backwards for a tool whose whole
   * purpose is finding people worth funding.
   */
  const founder = bare("f1");
  founder.enriched!.experience = [{ title: "Co-Founder and CEO", company: "Poth Labs (YC S26)" }];
  check("founding a batch company is its own signal", held(founder).includes("Funded founder"), true);

  const raised = bare("f2");
  raised.enriched!.experience = [
    { title: "CEO", company: "Vela", description: "Backed by a16z (sr007) and Z Fellows" },
  ];
  check("so is founding one that raised", held(raised).includes("Funded founder"), true);

  // The distinction the whole thing turns on.
  const early = bare("f3");
  early.enriched!.experience = [
    { title: "Founding Growth Manager", company: "Friday (YC F24)" },
  ];
  check("arriving early is neither", held(early).includes("Funded founder"), false);

  const unfunded = bare("f4");
  unfunded.enriched!.experience = [{ title: "Founder", company: "Some Side Project" }];
  check("and founding something nobody funded is not it", held(unfunded).includes("Funded founder"), false);

  // "Raised awareness" is not a round.
  const awareness = bare("f5");
  awareness.enriched!.experience = [
    { title: "Founder", company: "A Nonprofit", description: "Raised awareness for clean water" },
  ];
  check("nor is raising awareness", held(awareness).includes("Funded founder"), false);
}

console.log("\nthe score is a sum — the documented worked examples");
{
  // The score IS the raw total now, so these assert it directly. The three
  // sigma figures that used to sit alongside them (−0.8σ, +1.3σ, +2.4σ) have no
  // successor: there is no mean to be above.
  const sumOf = (c: ReturnType<typeof scoreOne>) =>
    round(c.signals.reduce((s, x) => s + x.points, 0));

  const hackClub = scoreOne(bare("hc", ["Hack Club"]), TAX);
  check("Hack Club alone", hackClub.score, 0.4);

  // 1.6 + 0.7 + 1.2.
  const three = scoreOne(bare("three", ["RSI", "ISEF", "USAMO"]), TAX);
  check("RSI + ISEF + USAMO", three.score, 3.5);

  const strong = bare("strong", ["IMO", "IOI", "RSI"]);
  strong.enriched!.publications = ["A paper"];
  const strongScored = scoreOne(strong, TAX);
  // 2.0 + 2.0 + 1.6 + 0.3.
  check("IMO+IOI+RSI+1 pub", strongScored.score, 5.9);

  /**
   * Being funded outweighs any single competition.
   *
   * The assertion the whole recalibration exists for: Y Combinator scored 0.5 as an
   * employer, a third of what an ISEF finalist got.
   */
  const backed = scoreOne(bare("yc", ["Y Combinator"]), TAX);
  check("a YC batch alone", backed.score, 2.0);
  check("which beats an ISEF finalist", backed.score > scoreOne(bare("isef", ["ISEF"]), TAX).score, true);
  check("and votes Founder", backed.archetype, "founder");

  // Nothing in the table exceeds 2.0, so the σ analogy survives a plain sum.
  const overweight = Object.entries(START_WEIGHT).filter(([, w]) => w > 2);
  check("no weight exceeds 2.0", overweight, []);

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
  // 20 experiences, cap 4, 0.1 each. Volume must not beat quality — and it did:
  // counts alone could reach 7.6 against a top score of about 10, so most of a
  // ranking came from the one thing anybody can pad.
  check("counting stops at the cap", row.points, 0.4);
  check("and the row says what was dropped", row.label, "20 experiences, 4 counted");

  const few = bare("few", []);
  few.enriched!.projects = [{ title: "One" }, { title: "Two" }];
  const f = scoreOne(few, TAX);
  const prow = f.signals.find((s) => s.label.includes("project"))!;
  check("under the cap, everything counts", prow.points, 0.2);
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
  check(
    "the Jane Street programme is Quant",
    scoreOne(bare("js", ["Jane Street AMP"]), TAX).archetype,
    "quant"
  );

  /**
   * The firm and the programme are two tags, not one.
   *
   * They shared the label "Jane Street" and therefore shared a tag, so a summer on
   * the trading floor and a place on the summer maths programme were the same
   * credential — and the graph could not draw a shared employer at all, because the
   * only Jane Street tag was filed as a programme.
   */
  {
    const employed = bare("js-co");
    employed.enriched!.experience = [{ title: "Intern", company: "Jane Street" }];
    const scored = scoreOne(employed, TAX);
    check("working there is a company tag", scored.archetype, "quant");
    check(
      "and it is the company, not the programme",
      scored.signals.some((sg) => sg.label === "Jane Street"),
      true
    );
    check(
      "the programme is a separate tag with its own weight",
      TAX.tags["jane-street-amp"]?.facet,
      "program"
    );
    check("and the firm keeps the plain name", TAX.tags["jane-street"]?.facet, "company");
  }
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
      enriched: {
        ...base.enriched!,
        educations: [
          { school, degree: "High School Diploma", endYear: 2027 },
          // All twelve, so it exceeds the ceiling and becomes background. This is
          // the real shape of the hub problem: twelve of twenty are at Stanford, so
          // drawing it as a connection says nothing about any pair of them.
          { school: "Stanford", degree: "Bachelor of Science", endYear: 2031 },
        ],
      },
    };
  });
  const roster = Object.fromEntries(crowd.map((x) => [x.slug, x]));
  const cands = toCandidates(crowd, TAX);

  const opts = {
    // "year" and "state" are no longer link types: a shared class year across
    // twenty people linked most of the queue to most of the queue, which is a
    // grouping and not a connection. Both survive under Arrange. High school and
    // college are separate switches because one is rare and one is a hub.
    sources: ["program", "highschool", "college", "discovery"] as const,
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
  // Stanford is on all twelve, so as a hub it would drag the whole graph into one
  // blob. It is held back as background instead.
  check("a tag shared by twelve does not", tagLabels.includes("Stanford"), false);
  check("and is reported rather than silently dropped", g.tooCommon.some((t) => t.count === 12), true);

  check("every person is a node", g.nodes.filter((n) => n.kind === "person").length, 12);
  check("edges only ever join a person to a tag", g.edges.every((e) => e.a.startsWith("t:") || e.b.startsWith("t:")), true);

  /**
   * The opening view shows everything the data knows.
   *
   * Both of these were set to hide the densest facts — college was off as a link
   * type and the ceiling was eight, which between them hid Stanford, the single most
   * connected thing about this population and the first thing anyone looks for.
   * Narrowing is the slider's job; the default should not do it in advance.
   */
  check("the hub ceiling opens at twenty", DEFAULT_MAX_HOLDERS, 20);
  check("and every link type is a real option", EDGE_SOURCES.length, 6);

  // Raising the ceiling brings the hub back in.
  const wide = buildGraph(cands, roster, TAX, { ...opts, sources: [...opts.sources], maxHolders: 20 });
  check(
    "raising the ceiling admits it",
    wide.nodes.filter((n) => n.kind === "tag").map((n) => n.label).includes("Stanford"),
    true
  );

  /**
   * A tag too broad to draw is the *best* lead, not a discarded one.
   *
   * This is the inversion the screen is built on. Stanford across all twelve is a
   * useless line — it joins everyone to everyone — but it is the richest place to
   * go looking for more people like them. So the ceiling removes it from the
   * canvas and it has to still be in `hubs`.
   */
  const leadLabels = g.hubs.map((h) => h.label);
  check("a hub too broad to draw is still a lead", leadLabels.includes("Stanford"), true);
  check("and so are the drawable ones", leadLabels.includes("RSI") && leadLabels.includes("TJHSST"), true);
  check("a thing only one person has is not a lead", g.hubs.every((h) => h.count >= 2), true);
  // Ranked by talent, so a small selective programme can outrank a large university.
  check(
    "leads are ranked by the talent behind them",
    g.hubs.every((h, i) => i === 0 || g.hubs[i - 1].talent >= h.talent),
    true
  );
  check("every lead knows who holds it", g.hubs.every((h) => h.slugs.length === h.count), true);

  /**
   * Connections are computed whichever way the canvas is drawn.
   *
   * In Hubs mode the person-to-person edges are not on the canvas, but "why are
   * these two together" does not stop being worth answering because of how the
   * picture is arranged — the panel asks it either way.
   */
  check("connections exist in hub mode, where the edges do not", (g.connections["g0"] ?? []).length > 0, true);
  check(
    "and every one names its reason",
    Object.values(g.connections).every((list) => list.every((l) => l.reasons.length > 0)),
    true
  );
  check(
    "the rarest shared thing leads the reason list",
    // g0 and g1 share RSI (3 holders) and TJHSST (6). RSI is rarer, so it is first.
    g.connections["g0"]?.find((l) => l.slug === "g1")?.reasons[0],
    "RSI"
  );
  check(
    "a link is symmetric",
    g.connections["g1"]?.some((l) => l.slug === "g0"),
    true
  );

  /**
   * Hub labels must not overlap.
   *
   * This was the single thing that made the hub view useless: chips landing on top
   * of each other, so the canvas carried twenty strings and you could read six. The
   * force pass only knows discs, so a separate box pass runs after it.
   */
  {
    const chips = g.nodes.filter((n): n is Extract<typeof n, { kind: "tag" }> => n.kind === "tag");
    const collisions = chips.flatMap((a, i) =>
      chips.slice(i + 1).filter(
        (b) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2
      )
    );
    check("no two hub labels overlap", collisions.length, 0);
  }

  // No grouping means no anchors: the links decide the arrangement.
  {
    const free = buildGraph(cands, roster, TAX, { ...opts, sources: [...opts.sources], groupBy: "none" });
    check("ungrouped draws no group anchors", free.groups.length, 0);
    check("and still places every node", free.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), true);
  }

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
    // Which way round it went is the useful half, so the panel says it from each
    // side rather than printing one neutral sentence twice.
    check(
      "the panel reads it from the seed's side",
      g2.connections["seed-a"]?.[0]?.reasons[0],
      "Found them on People also viewed"
    );
    check(
      "and from the other's",
      g2.connections["found-b"]?.[0]?.reasons[0],
      "Found on their People also viewed"
    );
  }

  console.log("\ngraph — edges are bowed paths, trimmed to the node");
  {
    // A straight run of lines through a dense middle reads as a spider web, and two
    // parallel links become one smudge. A consistent slight bow separates them.
    const p1 = edgePath(0, 0, 100, 0);
    check("a path is a quadratic, not a line", /^M[\d.-]+ [\d.-]+Q/.test(p1), true);
    check("it bows off the straight line", p1.includes("Q50 9"), true);
    // The trim is what lets a discovery arrowhead land outside the target instead of
    // underneath the circle it points at.
    const trimmed = edgePath(0, 0, 100, 0, 10, 20);
    check("the ends are pulled back by the trim", trimmed.startsWith("M10 0"), true);
    check("at both ends", trimmed.endsWith(" 80 0"), true);
    // Coincident endpoints must not divide by zero.
    check("coincident nodes do not produce NaN", /NaN/.test(edgePath(5, 5, 5, 5)), false);
  }
}
// ── Store: concurrent writes to different keys ───────────────────────────
/**
 * The agent loop.
 *
 * Two of these are not tests of arithmetic. `queueHits` is the door a week-long
 * unattended run pushes people through, and both of its refusals — a permanently
 * deleted person, and a rejection a human already made — are silent when they
 * break. So each is also mutation-tested: the same call with the guard's input
 * removed must come out differently, or the check is not watching anything.
 */
async function checkCampaign() {
  console.log("\nplanQueries — the day's work, widest yield first");

  check("nothing selected, nothing planned", planQueries(EMPTY_SELECTION), []);

  check(
    "one anchor is one query",
    planQueries(sel({ programs: ["RSI"] })),
    ["RSI site:linkedin.com/in"]
  );

  // A modifier cannot stand on its own: "2029 founder" finds the whole internet.
  check("modifiers alone plan nothing", planQueries(sel({ years: ["2029"], titles: ["Founder"] })), []);

  const plan = planQueries(sel({ programs: ["RSI"], colleges: ["Stanford"], years: ["2029"] }));
  check("anchors come before any pairing", plan.slice(0, 2), [
    "RSI site:linkedin.com/in",
    "Stanford site:linkedin.com/in",
  ]);
  check("every planned query is distinct", plan.length, new Set(plan).size);
  check("the site filter is on all of them", plan.every((q) => q.includes("site:linkedin.com/in")), true);

  // Arity ordering is the whole reason the plan is ordered at all: three AND-ed
  // groups usually return nothing, so they must never crowd out a single anchor.
  const arity = (q: string) => q.replace(" site:linkedin.com/in", "").split(" ").length;
  const firstThreeTerm = plan.findIndex((q) => arity(q) >= 3);
  const lastOneTerm = plan.reduce((last, q, i) => (arity(q) === 1 ? i : last), -1);
  check("no three-term query precedes a one-term query", firstThreeTerm === -1 || firstThreeTerm > lastOneTerm, true);

  check(
    "raw queries lead, and gain the site filter",
    planQueries(sel({ programs: ["RSI"] }), ['"Z Fellows" 2030'])[0],
    '"Z Fellows" 2030 site:linkedin.com/in'
  );
  check(
    "a raw query that already has the filter is not given a second one",
    planQueries(EMPTY_SELECTION, ["foo site:linkedin.com/in"]),
    ["foo site:linkedin.com/in"]
  );

  const wide = sel({
    programs: ["RSI", "STS", "ISEF"],
    colleges: ["Stanford", "MIT"],
    highSchools: ["TJHSST"],
    titles: ["Founder"],
    years: ["2029", "2030"],
  });
  check("the ceiling is obeyed", planQueries(wide, [], 12).length, 12);
  check("a truncated plan is still the front of the full one", planQueries(wide, [], 12), planQueries(wide).slice(0, 12));
  check("deterministic across calls", planQueries(wide), planQueries(wide));

  // The cursor is the only state the loop keeps about queries, so a day's slice
  // must be exactly the untouched front of what is left.
  const day1 = queriesFrom(plan, 0, 3);
  const day2 = queriesFrom(plan, 3, 3);
  check("consecutive days do not repeat a query", day1.some((q) => day2.includes(q)), false);
  check("a cursor past the end yields nothing", queriesFrom(plan, plan.length, 5), []);
  check("a short tail is not padded", queriesFrom(plan, plan.length - 2, 10).length, 2);

  console.log("\ncampaign settings and stopping");

  const base = defaultSettings();
  check("out-of-range clamps rather than throwing", cleanSettings({ days: 999, searchesPerDay: -5 }, base).days, 30);
  check("an omitted key keeps its current value", cleanSettings({ days: 3 }, base).searchesPerDay, base.searchesPerDay);
  check("an empty string is not zero", cleanSettings({ days: "" }, base).days, base.days);
  check("a non-number is ignored, not coerced", cleanSettings({ days: "many" }, base).days, base.days);
  check("whole days, decimal dollars", [
    cleanSettings({ days: 2.7 }, base).days,
    cleanSettings({ budgetUsd: 1.234 }, base).budgetUsd,
  ], [3, 1.234]);

  check(
    "the estimate is searches plus enrichment",
    estimateUsd({ ...base, days: 7, searchesPerDay: 100, enrichPerDay: 10, budgetUsd: 5 }),
    Number((7 * 100 * 0.001 + 7 * 10 * 0.004).toFixed(4))
  );

  const camp = (over: Partial<Campaign>): Campaign => ({
    id: "c1", owner: "cory", name: "t", status: "running",
    selection: EMPTY_SELECTION, queries: [], settings: { ...base, days: 2, budgetUsd: 1 },
    day: 1, lastTickDay: null, queryCursor: 0,
    searchedToday: 0, queuedToday: 0, enrichedToday: 0, pendingJobId: null,
    spentUsd: 0, top: [], found: [], foundCount: 0, ticks: [],
    createdAt: "2026-01-01T00:00:00.000Z", ...over,
  } as Campaign);

  check("mid-run, no reason to stop", terminalReason(camp({}), 50), null);
  check("the last day is still a day it may work", terminalReason(camp({ day: 2 }), 50), null);
  check("past the last day it stops", terminalReason(camp({ day: 3 }), 50)?.includes("full 2 days"), true);
  check("the ceiling stops it", terminalReason(camp({ spentUsd: 1 }), 50)?.includes("dollar ceiling"), true);
  check("a cent under the ceiling is not the ceiling", terminalReason(camp({ spentUsd: 0.99 }), 50), null);
  check("an exhausted plan stops it", terminalReason(camp({ queryCursor: 50 }), 50)?.includes("ran out of queries"), true);
  check("days are counted before money", terminalReason(camp({ day: 3, spentUsd: 1 }), 50)?.includes("full 2 days"), true);

  // What makes raising a setting on a finished campaign mean something: the same
  // function decides both when to stop and whether the stop still applies.
  const ranOutOfDays = camp({ day: 3 });
  check("it stopped because the days ran out", terminalReason(ranOutOfDays, 50)?.includes("full 2 days"), true);
  check(
    "and giving it more days is a reason to carry on",
    terminalReason({ ...ranOutOfDays, settings: { ...base, days: 5, budgetUsd: 1 } }, 50),
    null
  );
  const hitCeiling = camp({ spentUsd: 1 });
  check(
    "raising a ceiling it hit is a reason to carry on",
    terminalReason({ ...hitCeiling, settings: { ...base, days: 2, budgetUsd: 3 } }, 50),
    null
  );
  // But no amount of money refills a used-up plan, so that one has to stay stopped.
  check(
    "a used-up query plan is not fixed with money",
    terminalReason({ ...camp({ queryCursor: 50 }), settings: { ...base, days: 2, budgetUsd: 99 } }, 50)?.includes("ran out of queries"),
    true
  );

  check("room left under the ceiling", budgetLeft(camp({ spentUsd: 0.4 })), 0.6);
  check("overspend reads as nothing left, never negative", budgetLeft(camp({ spentUsd: 1.5 })), 0);
  check("no ceiling means no limit", budgetLeft(camp({ settings: { ...base, budgetUsd: 0 } })), Infinity);

  // The day counter moves on the UTC date, which is what makes advance_campaign
  // safe to call repeatedly: ten calls are one day's work, not ten.
  check("the day is the UTC date", utcDay(new Date("2026-08-20T23:30:00Z")), "2026-08-20");
  check("and not the local one", utcDay(new Date("2026-08-21T00:30:00Z")), "2026-08-21");

  console.log("\nmergeTop — the kept best across days");

  const row = (slug: string, score: number, day = 1): ReportRow => ({
    slug, name: slug, headline: "", url: `https://www.linkedin.com/in/${slug}`,
    score, archetype: "founder", confirmed: [], enriched: false, day,
    at: "2026-01-01T00:00:00.000Z",
  });

  check("highest score first", mergeTop([], [row("a", 1), row("c", 3), row("b", 2)]).map((r) => r.slug), ["c", "b", "a"]);
  check("one row per person", mergeTop([row("a", 1)], [row("a", 1)]).length, 1);
  // Enrichment happens after a person is first seen, so the later sighting is the
  // truer one and must win even though the slug is already held.
  check("a later, better sighting replaces the earlier", mergeTop([row("a", 1)], [row("a", 5)])[0].score, 5);
  check("a later, worse sighting does not", mergeTop([row("a", 5)], [row("a", 1)])[0].score, 5);
  const many = Array.from({ length: 80 }, (_, i) => row(`p${i}`, i));
  check("kept at the bound", mergeTop([], many).length, KEEP_TOP);
  check("and it keeps the best of them", mergeTop([], many)[0].score, 79);

  console.log("\nqueueHits — what an unattended run must refuse");

  const { promises: fsp } = await import("node:fs");
  const nodePath = await import("node:path");
  const store = await import("../lib/store");
  const serverState = await import("../lib/serverState");
  const file = nodePath.join(process.cwd(), ".data", "store.json");
  const backup = await fsp.readFile(file, "utf8").catch(() => null);

  try {
    const hit = (slug: string) => ({
      slug, name: slug.replace("-", " "), headline: "RSI 2025",
      url: `https://www.linkedin.com/in/${slug}`, snippet: "Research Science Institute 2025",
      matchedShards: ["RSI"],
    });
    const hits = [hit("erased-person"), hit("rejected-person"), hit("new-person")];
    const opts = { query: "RSI", selection: sel({ programs: ["Research Science Institute"] }) };
    // "known" suppresses just the same, and a week-long run would re-queue both.
    const marks = {
      "rejected-person": { status: "rejected" as const, at: "2026-01-01T00:00:00.000Z" },
    };

    await store.set("zscore:team:people", {});
    const team = hydrateTeam(null);
    await store.set("zscore:team:prefs", { ...team, deleted: ["erased-person"] });

    const guarded = await serverState.queueHits("cory", hits, { ...opts, marks });
    check("a permanently deleted person is refused", guarded.slugs.includes("erased-person"), false);
    check("and the refusal is counted, not hidden", guarded.blocked, 1);
    check("a human's rejection is not revived", guarded.slugs.includes("rejected-person"), false);
    check("and that is counted too", guarded.skipped, 1);
    check("the person nobody has ruled on is queued", guarded.slugs, ["new-person"]);
    check("confirmed labels come from the hit's own text", guarded.people[0].searchLabels, [
      { label: "Research Science Institute", confirmed: true },
    ]);
    // The OR group matched, but this person's text does not say it — so the chip
    // is carried unconfirmed rather than asserted.
    const unconfirmed = await serverState.queueHits(
      "cory",
      [{ ...hit("quiet-person"), headline: "Student", snippet: "Student at a school" }],
      { query: "RSI", selection: sel({ programs: ["Research Science Institute", "ISEF"] }) }
    );
    check(
      "a term the text does not show is not asserted",
      unconfirmed.people[0].searchLabels.every((l) => l.confirmed === false),
      true
    );

    // Mutation: remove each guard's input and the same call must change. If these
    // two come out identical, neither check above is watching anything.
    await store.set("zscore:team:prefs", { ...team, deleted: [] });
    const unerased = await serverState.queueHits("cory", hits, { ...opts, marks });
    check("mutation — with the blocklist empty the deleted person returns", unerased.slugs.includes("erased-person"), true);

    await store.set("zscore:team:prefs", { ...team, deleted: ["erased-person"] });
    const revived = await serverState.queueHits("cory", hits, { ...opts, marks, reviveRejected: true });
    check("mutation — reviveRejected is what lets a rejection back in", revived.slugs.includes("rejected-person"), true);
    check("but it never overrides the blocklist", revived.slugs.includes("erased-person"), false);

    const capped = await serverState.queueHits("cory", hits, { ...opts, max: 1 });
    check("the daily cap is honoured", capped.slugs.length, 1);
  } finally {
    if (backup !== null) await fsp.writeFile(file, backup);
    else await fsp.rm(file, { force: true });
  }
}

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
  await checkCampaign();

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

  /**
   * The guard has to be wired up, not merely written.
   *
   * `groundedIn` is checked on its own above, and that is exactly the coverage the
   * original bug already had: the model was required to cite the text, the citation
   * was parsed, and the route then kept the label and threw the evidence away. A
   * mechanism nobody calls is the same as no mechanism, so this drives the real
   * extraction path against a mocked Groq reply and asserts the fabrication does not
   * survive the trip.
   */
  console.log("\nextractTerms — the citation is checked, not just requested");
  process.env.ZSCORE_GROQ_API_KEY = "test-key";

  const reply = (terms: { label: string; evidence: string }[]) =>
    (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ terms }) } }],
          usage: { total_tokens: 100 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;

  const pianist: Person = {
    ...bare("pianist", [
      "National YoungArts 2024 Winner in Classical Music / Piano",
      "Platinum-based chemotherapy drugs kill cancer cells by damaging DNA.",
    ]),
    headline: "Stanford CS & Physics",
  };

  globalThis.fetch = reply([
    { label: "National YoungArts", evidence: "National YoungArts 2024 Winner in Classical Music" },
    { label: "USACO Platinum", evidence: "USACO Platinum division qualifier" },
    { label: "USAPhO", evidence: "USAPhO Semifinalist" },
  ]);
  const extracted = await extractTerms(pianist, ["USACO Platinum", "USAPhO"]);
  globalThis.fetch = realFetch;

  check(
    "the cited term survives and the invented ones do not",
    extracted.ok ? extracted.value.terms.map((t) => t.label) : extracted.error,
    ["National YoungArts"]
  );

  console.log(
    failures === 0
      ? `\nAll ${total} checks passed.\n`
      : `\n${failures} of ${total} check(s) failed.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
