# Z-Score

Internal talent-discovery tool for Z Fellows. It finds high school and early-college students
before the world knows their names, scores them against a program taxonomy, and ranks them in a
digest.

A candidate's score is a **hand-calibrated sum**: the weight of every tag they hold, plus a priced
count of their experiences, projects, publications and patents. No mean, no standard deviation, no
division, and no dependence on who else has been enriched.

It is still written in sigma notation (`+24.0σ`), which is house style and where the name comes from.
It is not a standard deviation, and nothing in the product claims it is.

## The pipeline

```
sweep ──▶ select ──▶ queue ──▶ digest
  ▲                    │
  │                    ├──▶ graph      (a live view of the queue)
  │                    └──▶ taxonomy   (the ruleset that scores everything)
  │
agent  ──▶ the same three steps, once a day, unattended
```

| Route | What it is |
|---|---|
| `/sweep` | Both discovery paths, and the two things you can do with results |
| `/queue` | The roster. Pin, mark known, remove, enrich, retag, override a cluster |
| `/digest` | Top ten by score, email-safe layout. The primary surface |
| `/graph` | People and tags as one network, clustered by whatever you group on |
| `/taxonomy` | Term weights, cluster assignments, and the review queue for new terms |
| `/candidate/[slug]` | One person: score breakdown, tags, profile, discovery trace |
| `/agent` | Multi-day searches that run themselves, and the Claude connection |

### Two things you can do with search results

Queuing and enriching are different decisions, so they are different buttons.

- **Add to queue** — free and instant, on search data alone. Nothing is spent.
- **Enrich** — runs Apify at about $0.004 a profile, then queues them with full data.

Enriching someone already queued **upgrades them in place**. Their marks, their discovery trace
and the date you first saw them all survive; they simply gain the profile data. So "add now,
enrich later" is a real workflow rather than a dead end.

### The three buttons on a row

| | Means |
|---|---|
| ★ | Pin to the top. Filterable |
| ◆ | Already know them. Leaves the queue, counted on the digest |
| ✕ | Remove. Leaves the queue, and **future sweeps un-tick them and say why** |

"Interested" is not one of them, because being in the queue already says that. `known` is kept
separate from `rejected` on purpose: *"this sweep surfaced eight people Cory already rates"* is
evidence the tool works, and folding it into delete throws that away.

Removals are reversible — the queue offers an undo, and a Removed view restores anything older.

## The score

```
raw = Σ weight(matched term) + publication/patent/project bonuses
z   = (raw − 2.2) / 1.8            constants, not measured
```

Worked examples, all asserted in `npm run check` so a weight edit cannot silently move the scale:

| Profile | raw | z |
|---|---|---|
| Hack Club alone | 0.7 | −0.8σ |
| RSI + ISEF + USAMO | 4.5 | +1.3σ |
| IMO + IOI + RSI + 1 publication | 6.6 | +2.4σ |

**Why the calibration is fixed.** It used to standardise over whoever happened to be enriched,
which had three consequences: a person's number moved as the queue grew, a lone candidate always
scored exactly 0, and two teammates saw different values for the same kid. Now the same person
scores the same forever, until someone deliberately retunes a weight on the taxonomy screen.

Search-only and enriched records run through the identical formula with **no discount**. A
search-only person simply has less text, so they match fewer terms and score lower — a consequence
of the evidence rather than a penalty on top of it. Their score badge reads hollow, and says
"from search", so you can see how much was read to get the number.

Lives in two files: [`lib/clusters.ts`](lib/clusters.ts) for the model,
[`lib/candidates.ts`](lib/candidates.ts) for applying it.

### Six clusters, and Polymath is not one of them

A cluster is a **reference class** — you judge an olympiad kid against olympiad kids. Polymath is
not a population, it is the union of overlaps, so a mean polymath does not exist. It was also
absorbing everything unclassifiable, which is how you could tell two clusters were missing: Jane
Street, Coca-Cola Scholar, QuestBridge, TASP and SPARC were all polymaths.

| Cluster | Terms |
|---|---|
| Olympiad | IMO, IOI, USAMO, USACO Platinum, USAPhO, USABO, Mathcamp, PROMYS |
| Research | RSI, STS, ISEF, SSP, MIT PRIMES, Simons Fellow, Garcia Program, + publications |
| Builder | Hack Club, Conrad Challenge, + projects, open source |
| Founder | Thiel Fellow, Neo Scholar, Diamond Challenge, + YC and founder headlines |
| Quant | Jane Street, + quant and trading internships |
| Scholar | Coca-Cola Scholar, TASP, SPARC |

**Polymath is a badge**, awarded for clearing +0.5σ in two or more clusters.

**Assignment: the single highest-weighted matched term wins.** IOI (2.0) + RSI (1.8) → Olympiad,
with the Polymath badge and Research as a secondary. Drag RSI above IOI on the taxonomy screen and
that person becomes Research. The taxonomy is the model.

A term can also map to **no cluster** — QuestBridge is a socioeconomic context signal, not a
talent type, so it carries score weight and casts no vote. Editable per term, including back to a
cluster. Any person's cluster can be overridden by hand, which always wins.

## Tags, and how much each is trusted

| Source | Trust |
|---|---|
| Taxonomy term found in the record's own text | Scores |
| A search chip **confirmed** against the hit's title or snippet | Scores |
| A search chip the text does not show | Rendered struck through. Scores nothing |
| Extracted by the tagger, once promoted | Scores |
| Extracted, not yet promoted | Zero weight. Sits in the review queue |

A query like `(RSI OR IMO) (MIT OR Stanford)` never reports which branch matched, so attaching
every chip to every hit would invent facts, and those facts would then score. Each chip is
cross-checked against the hit's own text, which is free and turns a guess into evidence.
Unconfirmed chips are still kept, because they record why a person was looked at.

## The tagger

`ZSCORE_GROQ_API_KEY` enables one thing: reading credential names out of profile free text
(`openai/gpt-oss-120b`, roughly $0.0002 a profile, about 5% of the Apify cost). It runs
automatically as each enrichment lands, and behind an Analyze button for search-only people.

**It never moves a number.** An extracted term carries zero weight until someone promotes it on
the taxonomy screen, and there is no per-person LLM archetype or summary — both would make a score
depend on a sampled generation, and reproducibility is the whole basis for trusting the ranking.
Cluster and starting weight are asked **once per term, at promotion**, not per person.

**Every screen works with the key unset.** You lose new-term discovery, not the product; the
review panel says so rather than showing an empty box that looks broken.

Only credential-bearing text is sent: no name, no URL, no school, no location. The population is
minors and the model does not need to know who someone is to recognise "Davidson Fellow".

## The graph

People **and** tags are nodes, and a person links only to their own tags. Connecting every pair
who share a tag grows edges quadratically, so a hundred people is already a hairball; this is
linear, and it shows *which* credential connects a cluster instead of leaving you to hover an edge
and guess.

**The rarity window is what keeps it readable.** A tag is a node only while between 2 and 8 people
hold it. Below that it is a lone pendant; above that it is background — "class of 2028" as a hub
drags everything into one blob. Both bounds are adjustable, and anything dropped is named on
screen rather than silently disappearing.

Discovery edges (who was found on whose People Also Viewed) are drawn person-to-person and are
never subject to the window, because nothing about them is inferred.

Layout is a **seeded deterministic simulation**: positions hash from the node id, iterate, then
freeze. Identical across reloads, no animation loop, no new dependency, and no float-rounding
hydration bugs because it only ever runs on the client. Capped at 120 people, lowest scores
dropped, with a note saying so.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Then open http://localhost:3737. Set `ZSCORE_APIFY_MOCK=1` to exercise the whole flow for free.

Everything selectable on the sweep screen lives in one file,
[`lib/searchTaxonomy.ts`](./lib/searchTaxonomy.ts) — five plain string arrays, each entry used
verbatim in the Google query.

### How discovery works

One sweep is one Google query. Selecting more options widens that same query rather than starting
another, so a sweep always costs a single search. Categories are ANDed by juxtaposition, options
inside a category are ORed:

```
(Coca-Cola Scholar OR RSI) (MIT OR Stanford) (TJHSST OR Harker) site:linkedin.com/in
```

Nothing is quoted: exact-match phrases switch off Google's synonym expansion and relevance
ranking, which is the part doing the real work. Queries hit Google, not LinkedIn — nothing here
touches LinkedIn's servers, uses cookies, or needs an account. Results dedupe on the profile slug,
never on name.

**Serper's free tier caps at 10 results per query.** The app detects the rejection, latches it, and
retries at 10 so the sweep completes rather than failing. A paid plan returns up to 100.

### Enrichment

[`harvestapi/linkedin-profile-scraper`](https://apify.com/harvestapi/linkedin-profile-scraper) at
**$4 per 1,000 profiles**, so a 10-hit sweep costs about 4¢. Public pages only. One actor covers
both paths, because it returns each profile's People Also Viewed list alongside the profile
itself — which is why there is one client, one parser and one cost line instead of two vendors.

Runs are started and polled, never awaited: Apify's synchronous endpoint 408s at 300 seconds and a
Vercel function caps there too. A run survives a page reload, **and survives navigating to another
screen** — the poll lives in an app-wide provider, and the nav shows its progress from anywhere.

`moreProfiles` is a **co-view model, not a similarity model**. It reports who browsers looked at in
the same session. On a well-known adult it fills with unrelated adults — a probe against Reid
Hoffman returns Jensen Huang. On a low-traffic 16-year-old it can be empty. Every person stores
where they came from, so drift is measurable before you trust a second hop.

## Storage

| Key | Type | Holds |
|---|---|---|
| `zscore:team:people` | Redis **hash**, field = slug | The roster. Shared |
| `zscore:team:prefs` | string | Taxonomy and custom menu terms. Shared |
| `zscore:profile:<id>` | string | Marks, sweeps, filters, seeds, active job. Personal |
| `zscore:job:<profile>:<id>` | string | An enrichment run in flight |

**The roster is shared, the judgement is not.** Nobody pays Apify twice for the same person and
everyone sees one score for them; pin, already-known and removed stay private, so Grace triaging
her list does not reshape Cory's. A split scoring model would give one person three different
z-scores depending on who was looking, so the taxonomy is team-wide too.

The hash matters: `HSET` writes one person atomically, so pinning someone costs a few bytes
instead of reading a multi-megabyte document, merging, and writing all of it back — which is what
one-document-per-teammate forced, and it got worse with every profile enriched.

Old documents migrate on first read, once, guarded by a stored schema version.

### Attaching a database, required before deploying

Storage picks a backend automatically: **Upstash Redis** when REST credentials are present,
otherwise **a JSON file under `.data/`** for local development only. Vercel's filesystem is
read-only outside `/tmp`, so **without Redis attached nothing will save in production**. The app
detects this and shows a banner rather than silently dropping writes.

1. Vercel dashboard → Storage → Marketplace → add **Upstash Redis**, connect it to the project.
2. The integration sets `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for you.
3. Redeploy.

`KV_REST_API_*` and `ZSCORE_REDIS_REST_*` are also accepted, so any Upstash-compatible endpoint
works.

## Before deploying

- **The spend cap is server-side.** 500 profiles per teammate per UTC day by default, counted in
  profiles because that is what Apify bills, and reserved before the run starts so a crash cannot
  hand quota back. Refusals say what the cap is and when it resets.
- **Every route body is validated** — slug shape, enum values, array lengths, payload size —
  and rejected with a 400 rather than trusted.
- **Paid calls are logged** as JSON lines with count, cost and duration, and no candidate PII.
  Without that the first surprising bill is unexplainable.
- **`noindex` and a narrow CSP** on every response. The corpus is minors; it should never reach a
  search index even if a URL leaks.
- **Delete all stored people** lives under "Stored data" on the taxonomy screen. Weights survive,
  since those are the team's tuning rather than anybody's personal data.
- The target population is minors, CCPA has required a documented risk assessment for processing
  known under-16 data since 1 January 2026, and email-finding should stay off for this group.
  `VENDOR_RECOMMENDATION.md` §7 covers this properly.

- **The cron is off until `CRON_SECRET` is set.** The route 503s rather than allowing the call,
  because the alternative is a public URL in production that starts paid work and a secret
  comparison against the literal string `Bearer undefined`.

## Commands

```bash
npm run check        # 464 assertions over the pure functions. No network, no API key
npm run build:check  # type-check build into .next-check, so it cannot clobber a running dev server
```

`npm run check` covers the parts that corrupt data silently: slug extraction (the dedupe key),
name and headline splitting, year inference, query construction, HarvestAPI payload parsing, hop
expansion and its dedupe, the confirmed/unconfirmed tag split, fixed-calibration scores against
the three worked examples above, **the same person scoring identically in a pool of 1 and a pool of
30**, cluster assignment and its tie-break, the polymath threshold, promoting a term actually
making it score, status transitions and sweep suppression, graph rarity windowing and layout
determinism, hash-store operations, migration of a legacy document, the agent's query plan and its
arity ordering, when a campaign stops and why, and **the two things an unattended run must
refuse** — re-adding a permanently deleted person, and un-rejecting one a human already
turned down — each mutation-tested so the check cannot pass vacuously.

## Design

- [`DESIGN_TOKENS.md`](./DESIGN_TOKENS.md) — every token with a citation back to zfellows.com
- [`DESIGN_LANGUAGE.md`](./DESIGN_LANGUAGE.md) — the standing judgement rules
- [`REDESIGN_PLAN.md`](./REDESIGN_PLAN.md) — component derivations and screen specs
- [`VENDOR_RECOMMENDATION.md`](./VENDOR_RECOMMENDATION.md) — why SERP discovery over the HarvestAPI
  search actor, and the constraints on storing real profile data

The logo lives at `assets/logo.png`; `app/icon.png` and `app/apple-icon.png` are generated from it.

## The agent loop

A campaign is the whole pipeline on a timer. You give it a selection, a number of days and a daily
query budget; each day it runs its queries, ranks the hits on how many of your own search terms
the person's own text confirms, queues the best it does not already have, pays to enrich a capped
few, and keeps a running top thirty. At the end you read the report.

Three things move it: the daily Vercel cron, the Advance button on `/agent`, or Claude. There is no
setting the loop obeys that is not on that screen and settable from either side — days, searches a
day, queued a day, enrichments a day, the dollar ceiling, the score bar, and the team defaults a
new campaign starts from. The caps we do not own are printed there too, with their values.

Claude reaches it over MCP at `/api/mcp`, authenticated by a `zsk_` token minted on `/agent` and
stored only as a SHA-256 hash. Thirteen tools: read the taxonomy, the queue and any campaign;
sanity-check a query for a tenth of a cent; create, advance, update and stop a campaign; search,
queue and enrich directly. **What it deliberately cannot do**: delete a person, reset the roster,
change a taxonomy weight, or mark anyone known or rejected. Deciding who is worth talking to stays
a human call, so an unattended loop can fill the queue but never triage it.

Two refusals worth knowing, because they are what keeps a week-long run from doing damage: a
campaign never re-adds a permanently deleted person, and never un-rejects one. Clicking add again
in the UI plainly means revive; a nightly job doing it would quietly undo every triage decision.

## Not built

LLM screening beyond term extraction, and the email send itself. The digest is the top ten by
score; screening is a separate decision.
# z-score
