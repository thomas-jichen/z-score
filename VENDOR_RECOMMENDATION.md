# LinkedIn Talent-Discovery Pipeline — Scraping Infrastructure Recommendation

**Prepared for:** Z Fellows early-talent discovery tool
**Date:** 12 August 2026
**Status:** Recommendation only — no pipeline built

---

## 0. TL;DR

**Use `harvestapi/linkedin-profile-scraper` for Strategy A and `harvestapi/linkedin-profile-search` for Strategy B.** They are the same vendor and share an output schema, so one parser serves both.

The decisive finding: **HarvestAPI is the only well-maintained, high-volume Apify actor I could verify that actually returns the "People Also Viewed" sidebar.** It ships as a top-level `moreProfiles[]` array. Most competitors that claim it in marketing copy do not have it in their schema — I checked, and several listing descriptions and comparison blogs are simply wrong.

Three things you should read before the cost tables, because they change the architecture:

1. **For Strategy B discovery, keep the existing Google/SERP workflow — don't replace it with the HarvestAPI search actor.** Querying Google rather than LinkedIn is cheaper (~$4.01 vs $8.00 per 1k enriched), carries no LinkedIn ToS exposure, and probably has *better* keyword recall because Google full-text indexes the profile page while LinkedIn's own search appears to weight headline/title. **But the Google Custom Search JSON API is discontinued on 1 January 2027 and is already closed to new customers** — migrate to Serper.dev. See §3.5, which also lists an infinite-loop bug in the current workflow.
2. **Rosters are a verification and watchlist layer, not a discovery funnel.** An earlier draft over-weighted them; §3 carries the correction and the reasoning.
3. **Your target population is minors, and that is a genuine legal constraint, not a footnote.** It rules out the cookie-based tooling entirely and caps how you may store and share the data. See §7.

---

## 1. Capability answers (the five gating questions)

Verified by reading actual output schemas and sample JSON on vendor pages, not listing blurbs.

### Q1 — Does it return "People Also Viewed"?

**Yes, but only from two sources worth using.**

`harvestapi/linkedin-profile-scraper` returns it as `moreProfiles`:

```json
"moreProfiles": [
  {
    "id": "ACoAADLPJPwBkCGTsuAt6NQXwPJ6JJfpzm57ngg",
    "firstName": "Meliton Nathaniel",
    "lastName": "Santos",
    "position": "PharmD Candidate 2026A at Western University of Health Sciences",
    "publicIdentifier": "meliton-nathaniel-santos-bb858b1b9",
    "linkedinUrl": "https://www.linkedin.com/in/meliton-nathaniel-santos-bb858b1b9"
  }
]
```

That is exactly the expansion primitive Strategy A needs — it hands you a resolvable `publicIdentifier` per neighbor, so the next hop is a direct re-feed with no name-matching step.

Bright Data also exposes `people_also_viewed` in its LinkedIn profile schema.

**Negative findings worth stating plainly**, because they contradict what the comparison blogs say:

- `apimaestro/linkedin-profile-detail` and `apimaestro/linkedin-profile-full-sections-scraper` — **no PAV**. An aggregator blog claims the full-sections actor returns "People Also Viewed"; the actor's own page lists its sections (experience, education, skills, certifications, projects, recommendations, honors, languages) and PAV is not among them.
- `data-slayer/linkedin-profile-scraper` — a search snippet claims "up to 26 Also Viewed similar profiles." The actor page has no such field anywhere. Treat that claim as marketing residue.
- Coresignal, ScrapIn, Piloterr — no PAV in documented schemas. These are enrichment/lookup products, not graph-expansion products.

### Q2 — Keyword people-search, or URL-only?

| Tool | Discovery? |
|---|---|
| `harvestapi/linkedin-profile-search` | **Yes** — free-text `searchQuery` + structured filters |
| `harvestapi/linkedin-profile-scraper` | No — URL / public identifier / profile ID only |
| Bright Data | Yes — "discover by" name/keyword alongside URL collection |
| Coresignal | Yes — Search credits then Collect credits, two-step |
| ScrapIn | Yes — people search endpoint |
| Exa | Yes — semantic, over 1B+ profiles |

The HarvestAPI search actor's filters include free-text query, **LinkedIn school URLs** (`stanford-university`, `MIT` — directly serves your 40-feeder-school sweep), locations, current/past companies, industry IDs, and years of experience.

**There is no graduation-year filter.** You post-filter on `education[].endDate.year`, which the Full mode returns as structured `{month, year, text}`. That works, but you pay to scrape profiles you then discard — budget for it.

**Hard ceiling to design around:** LinkedIn caps any single query at 2,500 results. HarvestAPI works around this with automatic query segmentation (splits by country → state/region → experience level → industry), advertised up to ~100k profiles per query. Segmentation costs extra: it charges per search page *even for segments returning zero results*, since it must run the query to learn the count.

### Q3 — Session cookies required?

**HarvestAPI: no cookies, no LinkedIn account.** Managed infrastructure, public pages only. Same for Bright Data, Coresignal, ScrapIn, Piloterr, Exa.

Cookie-based tools exist (`harvestapi/linkedin-sales-navigator-lead-search-cookie`, `curious_coder/linkedin-sales-navigator-search-scraper`). **Do not use them** — see Q5 and §7.

### Q4 — Full education + honors + volunteer + projects?

**Yes — this is where HarvestAPI decisively wins for your population.** Complete verified top-level schema:

```
id, publicIdentifier, linkedinUrl, firstName, lastName, headline, about,
openToWork, hiring, photo, premium, influencer, location, verified,
registeredAt, topSkills, connectionsCount, followerCount, currentPosition,
experience, education, certifications, projects, volunteering,
receivedRecommendations, skills, courses, publications, patents,
honorsAndAwards, languages, featured, moreProfiles,
query, status, entityId, requestId
```

The sub-schemas are properly structured, not text blobs:

- **`honorsAndAwards`** → `{title, issuedBy, issuedAt, description, associatedWith, associatedWithLink}` — this is where RSI, ISEF placement, USAMO qualification and Coca-Cola Scholar actually live on a high schooler's profile.
- **`education`** → `{schoolName, schoolLinkedinUrl, schoolId, degree, fieldOfStudy, skills[], startDate{month,year}, endDate{month,year}}` — `endDate.year` is your graduation-year filter.
- **`volunteering`** → `{role, duration, startDate, endDate, organizationName, organizationLinkedinUrl, cause}`
- **`projects`** → `{title, description, duration, startDate, endDate}`
- Plus `courses`, `publications`, `patents`, `certifications`, `languages`.

For a 17-year-old whose `experience` array is empty or a summer retail job, `honorsAndAwards` + `projects` + `volunteering` *is* the signal. An actor returning only work history is worthless here, which eliminates most of the field.

### Q5 — Sales Navigator URLs as input?

**HarvestAPI's cookieless actors: no.** Sales Nav actors exist on Apify but **every one of them requires session cookies** — Sales Nav is authentication-gated by definition, so there is no cookieless path. That is a structural fact, not a vendor gap.

**My recommendation is to skip Sales Navigator**, for three reasons:

1. Cookie-based scraping is the precise legal theory that killed Proxycurl (§7). It converts "reading public pages" into "unauthorized access to an authenticated system."
2. It puts a real LinkedIn account at ban risk, and Sales Nav seats are ~$100/mo each.
3. **You don't need it.** The only Sales Nav filter you actually want is graduation year, and you can reconstruct that by post-filtering `education[].endDate.year` from the cookieless path. You pay a little more in wasted scrapes and get none of the risk.

---

## 2. Comparison table

Cost column is normalized to **cost per 1,000 full profiles at ~50k/month**, excluding platform subscription.

| Tool | Q1 PAV | Q2 Search | Q3 Cookieless | Q4 Honors/Vol/Proj | Q5 SalesNav | Cost /1k | Reliability |
|---|---|---|---|---|---|---|---|
| **`harvestapi/linkedin-profile-scraper`** | **Yes** (`moreProfiles`) | No (URL only) | **Yes** | **Yes** — all four | No | **$4.00** | **Strong.** 61K users, 11K MAU, 4.5★ (79), modified 13d ago, 11h issue response, 89/90 issues closed |
| **`harvestapi/linkedin-profile-search`** | **Yes** (Full mode) | **Yes** + school filter | **Yes** | **Yes** — all four | No | **$8.00 best case, $16+ realistic** — billed $100/1k *search pages* (≤25 profiles each) + $4/1k profiles; narrow shards and empty segments still cost a full page. See §3.5 | **Strong.** 36K users, 5.5K MAU, 4.4★ (90), modified 2d ago, 18h response |
| **Bright Data** | **Yes** (`people_also_viewed`) | Yes (discover by name/keyword) | Yes | Yes | No | **$1.50** PAYG / **$0.75–0.98** committed | Strong enterprise SLA; 5k/mo free tier; KYC + compliance review adds setup friction |
| `apimaestro/linkedin-profile-detail` | **No** | No | Yes | Honors yes, PAV/volunteer no | No | $5.00 | Good. 18K users, 4.2K MAU, 4.7★ (64), 3h response, modified 1mo ago |
| `apimaestro/linkedin-profile-full-sections-scraper` | **No** | No | Yes | Honors + projects; no volunteer/PAV | No | $10.00 | Thin. 3.3K users, **355 MAU**, 5.0★ but only 8 reviews |
| `scrapio/linkedin-profile-scraper` ("Similar Profile Finder") | **Yes** — native 3-hop BFS | No | Yes | Projects only; **no honors/volunteer** | No | $14.99/mo + usage | **Weak. 78 users, 6 MAU, 0 reviews.** Falls back to Wayback Machine snapshots — stale data risk |
| `data-slayer/linkedin-profile-scraper` | **No** (despite claims) | No | Yes | Projects, volunteer; no honors | No | $4.00 | **Weak.** 553 users, 35 MAU, 1 review |
| **Coresignal** | No | Yes (Search + Collect credits) | Yes | Partial | No | **$0.133–0.196/record** | Strong vendor, but **cached index** — freshness lag on fast-moving student profiles |
| **ScrapIn** | No | Yes | Yes | Partial | No | **~$20–49** (credit tiers) | Real-time, solid, but ~5–12× HarvestAPI at your volume |
| **Piloterr** | No | Limited | Yes | Partial | No | 10 credits/advanced call; datasets from $3,000/mo | Mid-tier; datasets priced out of range |
| **Exa** | **Semantic equivalent** (`find_similar`) | **Yes** — 1B+ profiles, natural language | Yes | No (it's an index, not a scraper) | No | ~$45/1k matched results (Pro tier) | Strong, but a *discovery* layer — pair with a cheap enricher |
| **Clay** | No | Via waterfall | Yes | Depends on sub-provider | No | High per-credit | Aggregator — you'd be paying a margin on the vendors above |
| ~~Proxycurl / Nubela~~ | — | — | — | — | — | — | **DEAD.** Sued by LinkedIn Jan 2025, settled July 2025 under permanent injunction, shut down 4 July 2025 |

---

## 3. The architecture change I'd actually push for: roster-first

This is the part I'd argue hardest for, and it's specific to your population.

**The problem with Strategy B as specified.** You're using LinkedIn free-text search to reconstruct membership in programs that already publish canonical rosters. That reconstruction is lossy in four directions at once: students who didn't list the program, students who abbreviated it, false positives (someone who *mentions* RSI), and no way to verify. You then pay per profile for all of it.

**The inversion.** Start from the authoritative roster, resolve to LinkedIn second.

Public, structured, free sources covering most of your taxonomy:

| Source | What's public | Structure |
|---|---|---|
| **IMO** — `imo-official.org` | Full individual results by year and country, with medals, back decades | Highly structured HTML tables |
| **IOI** — `stats.ioinformatics.org` | Same, for informatics | Structured |
| **USACO** — `usaco.org` results pages | Per-contest, per-division finishers **including Platinum**, with names and schools | Structured HTML per contest |
| **Regeneron STS** — Society for Science | Top 300 scholars + 40 finalists annually, with school and project title | Press releases + listings |
| **Regeneron ISEF** — Society for Science | **Searchable project abstract database, 2014–2026** — names, schools, categories, project titles | Queryable database |
| **Coca-Cola Scholars** | Public scholar directory | Directory |
| **MAA / AMC** | USAMO / USAJMO qualifier lists, honor rolls | Published lists |
| **Hack Club** | Public GitHub org, public events, public Slack | GitHub API |
| **Neo Scholars, Thiel Fellows** | Published cohort lists | Web pages |

Then resolve identity: name + school + graduation year → LinkedIn, via `harvestapi/linkedin-profile-search-by-name` (5.8K users, 4.4★) or Exa people search.

**Why this is strictly better where it applies:**

- **Precision goes from roughly 30–50% to ~95%.** You're no longer guessing whether someone did RSI. The roster says they did.
- **Cost collapses.** You only enrich people already known to qualify, instead of scraping thousands of search hits to find the qualifying minority.
- **It's verified provenance.** For an investment context, "2025 ISEF grand award, Materials Science" sourced from Society for Science is a defensible fact. "Profile mentions ISEF" is not.
- **Cleaner legal posture.** These are publications of achievement, published deliberately by the awarding institution.

> **Correction (revised after review).** An earlier draft of this section claimed that reaching people *not* on LinkedIn was "arguably the highest-value segment." **That was wrong for this fund's purpose.** LinkedIn presence in a 16–18-year-old is itself a selection signal: it means they're thinking about professional positioning, networking and opportunity. A student who appears on an IMO roster but has no LinkedIn is, on base rates, tracking toward academia — not founding a company. For Z Fellows, absence from LinkedIn is mild *negative* evidence, not untapped alpha.
>
> Two caveats keep rosters valuable. First, LinkedIn adoption at 16–17 is partly a function of school culture and network access — TJHSST and Harker cohorts are saturated, a strong rural student may not be — so treat it as a **noisy** proxy for startup intent, correlated with privilege. Second, presence is a much weaker signal than *activity*; see §3.5 for sharper substitutes.
>
> **Rosters are therefore demoted from a discovery funnel to a verification + scoring + watchlist layer** — see the revised role below.

**Revised role for rosters:**

1. **Verification.** "2025 ISEF grand award, Materials Science," sourced from Society for Science, is a defensible fact. "Profile mentions ISEF" is not. This matters when the output is an investment memo.
2. **Scoring features.** Rosters carry detail LinkedIn never will — placement, category, year, country team. "IMO gold" and "IMO honorable mention" should not score the same.
3. **Watchlist.** This one survives the objection above and is worth building. A roster student with no LinkedIn *today* who creates one at 19 to start a company is precisely the Z Fellows target — and you'd be first to know. Store name + school + year, re-resolve monthly, alert on first appearance. Cheap, and it's the only mechanism here that gets you ahead of other funds rather than level with them.

**Keep LinkedIn for what only LinkedIn does:** the co-view graph (`moreProfiles`), current status ("what are they doing *now*"), and the long tail of programs without public rosters (Jane Street INSIGHT/AMP, Garcia, SPARC, PROMYS, Simons, MIT PRIMES, Diamond/Conrad Challenge).

I'd frame the final system as **three funnels merging into one scoring layer**: roster-first (highest precision), LinkedIn keyword sweep (highest recall), and PAV expansion (highest serendipity).

---

## 3.5 SERP-based discovery — evaluating the existing n8n workflow

An existing n8n workflow (`redacted-linkedin-scraper.json`) already does SERP-based discovery: Google Custom Search JSON API with `site:linkedin.com/in`, paginating to 100 results, parsing `title`/`link`/`snippet` into Google Sheets. **This is a better foundation for Strategy B discovery than the HarvestAPI search actor, and it should be kept** — with three fixes.

### Why it's the right shape

- **It queries Google, not LinkedIn.** No LinkedIn ToS exposure, no bot detection, no cookies, no account at risk. This is the cleanest discovery mechanism available on the legal axis discussed in §7.
- **It probably has better keyword recall than LinkedIn's own search.** Google full-text indexes the rendered public profile page. LinkedIn's internal people-search appears to weight name/headline/title heavily (Gap 3). For matching a string like `"Research Science Institute"` that lives in an honors section, **Google is more likely to hit than LinkedIn's own search box.** That partially resolves Gap 3 — in favor of the SERP path.
- **Discovery cost is near zero** compared with enrichment.

### The reframe that makes it work

Don't try to make the SERP query precise. **Use it as a cheap, high-recall candidate generator; get precision from the enrichment + scoring layer.**

This works because of an asymmetry worth stating explicitly: **the logged-out profile view is section-limited, but HarvestAPI's enrichment is not.** LinkedIn's public profile exposes name, headline, location and a cropped About by default, with Honors, Projects, Volunteer and Education as *member-controlled opt-in toggles* — so a keyword search against the crawlable HTML passes through three multiplicative filters (listed it × made that section public × Google indexed it). HarvestAPI's output, by contrast, returns fully populated `honorsAndAwards`, `volunteering`, `projects`, `courses`, `publications` and `patents`.

So: **discovery is section-limited; scoring is not.** Cast wide at the SERP stage (school + grad-year sweeps, loose keywords), enrich everything, then score on complete data.

### Cost comparison — SERP + enrich beats search-actor Full mode

| Path | Discovery | Enrichment | **Total /1k enriched** |
|---|---|---|---|
| HarvestAPI search, Full mode *(full 25-result pages)* | $4.00/1k | included | **$8.00** |
| HarvestAPI search, Full mode *(realistic sharded, ~8/page)* | $12.50/1k | included | **$16.50** |
| Google CSE + HarvestAPI scraper | $0.50/1k | $4.00/1k | **$4.50** |
| **Serper + HarvestAPI scraper** | **~$0.01/1k** | $4.00/1k | **~$4.01** |

Google CSE: $5 per 1,000 queries × 10 results = $0.50/1k URLs. Serper: ~$0.30–1.00 per 1,000 queries × up to 100 results = ~$0.003–0.01/1k URLs. **Discovery becomes a rounding error; enrichment is the whole cost.**

> **Measured, 12 Aug 2026.** Serper's **free tier is capped at 10 results per query** — `num > 10`
> returns `Query pattern not allowed for free accounts`. The 100-results-per-query figure above
> is paid-only, so free-tier discovery economics are the same as Google CSE's. Confirmed by
> probing: `site:`, quoted phrases and OR groups are all permitted on free; only `num` is gated.

#### Measured: strict vs loose queries retrieve different people

A live two-query test (`Coca-Cola Scholar × Stanford`, strict and loose forms, 10 results each):

| | Result |
|---|---|
| Strict (quoted OR group) | 10 hits |
| Loose (unquoted, casual phrasing) | 10 hits |
| Unique people | **16** |
| Found by both modes | **4** |

**12 of 20 hits — 60% — were unique to one mode**, despite both querying the same program and
school. Quoted phrase matching is a literal filter; unquoted queries get synonym expansion and
relevance ranking, and the two reach materially different slices of Google's index.

Two consequences. First, **run both forms and dedupe** — at ~$0.001 per query the extra cost is
nil and recall rises sharply. Second, the overlap is *signal*: agreement between two independent
retrieval strategies is a better corroboration score than two hits from the same one.

This also means literal alias coverage matters more than expected. `"Coca-Cola Scholar"` does not
match *Coke Scholar* or *Coca Cola Scholar*, and `"Regeneron STS"` does not match **Intel STS**
— the program's name before 2017. Former names (Intel STS, Intel ISEF) need to be enumerated
explicitly or that cohort is invisible to strict queries.

#### The per-page trap in HarvestAPI search pricing

The search actor bills **$100 per 1,000 search pages** ($0.10/page), where a page holds *up to* 25 short profiles. At a full page that's $4/1k discovered. **But it charges per page regardless of how many results the page actually contains — including zero-result segments**, which the README states explicitly.

This penalizes exactly the query shape Strategy B requires. A narrow shard like `"Research Science Institute" + TJHSST + 2027` may return 4 results and still cost a full $0.10.

| Avg results/page | Effective discovery cost |
|---|---|
| 25 (full page) | $4/1k |
| 10 | $10/1k |
| 5 | $20/1k |
| 0 (empty shard) | $0.10 burned, nothing returned |

Across ~3,000 shards, HarvestAPI search costs **~$300 to discover** — much of it on thin or empty pages. Serper costs **~$3** for the same sweep and returns up to 100 results per query rather than 25. **The gap on the discovery half is ~100×, not the ~8× a full-page assumption suggests.** Per-page billing is structurally wrong for narrow, high-precision queries; per-query billing is structurally right.

#### Volume discount

The actor's pricing table shows a Business-tier **"Gold discount" of 30%**: $50/1,000 search pages, **$3.20/1,000 full profiles**, $8.00/1,000 with email. Since enrichment is now essentially the entire spend, confirm which Apify plan unlocks this tier before committing — at 50k/month it pulls enrichment from ~$200 to ~$160.

### Three fixes required

**1. The API is being discontinued — this is time-critical.** Google's own docs (last updated 2026-02-18) state:

> "The following pricing applies only to existing Custom Search JSON API customers until the service discontinuation on **January 1, 2027**. **This API is not available for new customers.**"

That's ~5 months out, and no new keys are being issued. **Migrate to Serper.dev** — ~$0.30–1.00 per 1,000 queries, 2,500 free/month, and it returns **up to 100 results per query instead of 10**, collapsing the pagination loop to a single call. DataForSEO ($0.60–1.00/1k) is the alternative. Avoid SerpAPI at $9–25/1k.

**2. The 100-result cap is per query and must be sharded around.** Google returns at most 100 results for any query (`start` maxes at 91) — this is a SERP-wide limit, not a CSE quirk, and it survives the migration. Shard the query space so each cell stays under 100:

```
site:linkedin.com/in "Research Science Institute" "2027"
site:linkedin.com/in "Research Science Institute" "TJHSST"
site:linkedin.com/in "Stuyvesant" "Class of 2027"
```

~15 programs × 4 grad years × 40 schools ≈ thousands of shards, each with its own 100-result budget. At Serper pricing the entire sweep costs single-digit dollars.

**3. Output is SERP metadata only.** `name`, `title`, `link`, `snippet`, `image` — no honors, no education, no graduation year. The workflow currently terminates at Google Sheets, which means **there is no scoring input yet.** The missing stage is: dedupe URLs → HarvestAPI profile scraper → score. That stage is where all the actual signal enters.

### Bugs in the current workflow

- **Infinite loop.** In `Extract Results`, `nextStartIndex` defaults to `1` when `response.queries.nextPage` is absent — which is exactly what happens on the last page. `hasMoreResults` then evaluates `1 <= 100 → true`, and the loop returns to `start=1` and runs forever, burning quota. Guard on `items.length === 0` and on `nextStartIndex > currentStartIndex`.
- **`maxPages: 10` is dead config.** Set in `Set Fields`, never read anywhere. It's the natural circuit-breaker for the bug above — wire it up.
- **Name parsing is lossy.** `item.title.split(" - ")` against LinkedIn SERP titles of the form `Jane Doe - Founder - Acme | LinkedIn` leaves `| LinkedIn` glued to the last segment, and breaks on names or headlines containing hyphens. Strip the `| LinkedIn` suffix first, then split.
- **No deduplication.** Sharded queries will overlap heavily by design. Dedupe on the profile slug (`/in/<publicIdentifier>`) before enriching, or you'll pay HarvestAPI repeatedly for the same person.
- **`Wait` node has empty parameters** — verify the resolved default interval. If it's defaulting to hours, throughput is far lower than intended.
- **Pagination state routes through Google Sheets.** `Pagination` reads `index`/`results` from the Sheets node's output rather than from `Extract Results` directly. That's fragile — carry loop state on a separate branch.

### Startup intent — measure it directly, don't proxy it with presence

The reasoning for centering LinkedIn is sound: among 16–18-year-olds, having a LinkedIn at all correlates with startup and career orientation, whereas roster-only students skew academic. But **mere presence is a blunt version of the signal you actually want**, and every field below is already in the HarvestAPI payload you're paying for. Score on these instead:

| Signal | Field | Why it separates founders from academics |
|---|---|---|
| Self-description as a builder | `headline`, `about` — "building", "founder", "co-founder", "shipping", "working on" | The single sharpest text signal; academics write "researcher", "incoming PhD", "student" |
| Company they created | `experience[]` where `companyName` has no `companyId` | An unlinked company is usually one they registered themselves |
| Personal site / GitHub | `featured`, `about` URLs | Builders ship artifacts and link them |
| Follower ≫ connection ratio | `followerCount` vs `connectionsCount` | Broadcasting to an audience rather than networking — founder behavior |
| Account age vs. age | `registeredAt` vs `education[].startDate` | Joined at 14–15 ⇒ unusually early professional orientation |
| Posting activity | profile-posts actor | Active > present, by a wide margin |
| Commercial framing of achievements | `projects[].description`, `honorsAndAwards[].description` | "Patented", "users", "revenue", "launched" vs "published", "presented" |

The high-value quadrant is **strong roster credential × strong builder signal** — an ISEF finalist whose headline says "building" is a far better Z Fellows lead than either signal alone. That intersection is only computable if you carry roster data alongside LinkedIn data, which is the strongest remaining argument for §3.

### Index-coverage caveat — test this

Google indexes high-traffic pages best. A 16-year-old with 40 connections is precisely the profile least likely to be well-indexed, and LinkedIn Help notes crawl refresh "can take several weeks or months." **Measure coverage before committing:** take 30 profiles you already know exist (from a roster, or hand-verified), and check what fraction are returned by an exact-name `site:linkedin.com/in` query. Below ~60% and SERP discovery has a systematic blind spot against your youngest, highest-value segment — which is the case for keeping the HarvestAPI search actor as a parallel recall path rather than replacing it outright.

---

## 4. Capability gaps

### Gap 1 — The connection graph is not obtainable. At all.

You asked about finding seeds' "strongest connections/friends via their interaction history or connections." **This is not available from any vendor at any price.** LinkedIn does not expose a member's connection list to third parties. Even a cookie-based scraper logged into your own account sees only *your* network and mutual connections — never an arbitrary person's full graph. Any vendor claiming otherwise is either reselling stale breach data or running fake accounts, which is precisely what got Proxycurl shut down.

**Workarounds, in descending order of value:**

1. **Post engagement as a real interaction graph.** Who reacts to and comments on a seed's posts is an observable, public, genuine affinity signal — and unlike PAV it reflects actual human relationships rather than recruiter browsing patterns. `harvestapi/linkedin-profile-posts` plus a post-reactions/comments actor gets you this. For a tight cohort of high-achieving students who congratulate each other publicly, I'd expect this to substantially outperform PAV on precision. **I'd test this alongside PAV in the trial.**
2. **Co-membership edges from rosters.** Same RSI cohort year, same ISEF category, same USACO contest — free, exact, and derived from data you already have under the roster-first approach.
3. **GitHub collaboration graph.** Mutual follows, shared repos, co-contributions. Free API, generous limits, and for technical talent it's a truer signal of who actually works with whom.

### Gap 2 — PAV is a co-view model, not a similarity model

"People Also Viewed" reflects *who recruiters and browsers looked at in the same session*. For a famous young founder it will be polluted with unrelated adults. Fan-out is typically ~5–26 and can be empty on low-traffic profiles — which describes many high schoolers.

**Consequence for the recursion:** drift is the main risk, and it compounds. Mitigate with (a) a hard score threshold before any hop, (b) requiring ≥2 independent seeds to surface a candidate before hop 3, (c) capping at 2 hops until measured, and (d) tracking `discoveredVia` provenance so you can audit which seeds produce good subtrees and prune the bad ones.

### Gap 3 — Free-text search may not index honors/projects

**This is the single biggest unknown in the whole plan.** LinkedIn people-search keyword matching is heavily weighted toward name, headline, and current title. If it does not index the `honorsAndAwards` and `projects` free text, then searching `"Research Science Institute"` returns only the minority who put RSI *in their headline* — and Strategy B's yield collapses by an order of magnitude.

I could not resolve this from documentation. **It must be the first thing your trial measures** (§6). The roster-first approach in §3 is the hedge, and it's a large part of why I recommend it.

### Gap 4 — No graduation-year filter

Post-filter on `education[].endDate.year`. Costs wasted scrapes. Sales Nav has the native filter but requires cookies — not worth the trade.

### Gap 5 — Sparse profiles

Many strong 16-year-olds have a near-empty LinkedIn. LinkedIn-only discovery has a structural blind spot here that no vendor fixes. Roster-first is the answer.

---

## 5. Cost model

**Assumption:** "profiles" = full profile records retrieved. Apify actor charges are drawn against your Apify plan credits; the platform subscription is roughly additive at low volume and absorbed at high volume. Verify current Apify plan tiers before committing.

### Strategy A only (PAV expansion, URL-in) — `harvestapi/linkedin-profile-scraper` @ $4/1k

| Volume/mo | Actor cost | Apify plan | **Total** |
|---|---|---|---|
| 10k | $40 | ~$39 (Starter) | **~$79** |
| 50k | $200 | ~$199 (Scale) | **~$399** |
| 200k | $800 | ~$199–999 | **~$1,000–1,800** |

### Strategy B — two paths, and the cheaper one is also better

**Path 1 — HarvestAPI search actor** @ $8/1k best case. Billed $100 per 1,000 search pages (≤25 profiles each) + $4/1k full profiles. **Only reaches $8/1k if pages come back full**; realistic sharded queries land at $14–24/1k (§3.5).

| Volume/mo | Best case | Realistic sharded | Apify plan |
|---|---|---|---|
| 10k | $80 | $165 | ~$39 |
| 50k | $400 | $825 | ~$199 |
| 200k | $1,600 | $3,300 | ~$199–999 |

**Path 2 — Serper + HarvestAPI profile scraper** @ ~$4/1k. Discovery is a rounding error; you pay only for enrichment.

| Volume/mo | Serper | HarvestAPI @ $4/1k | Apify plan | **Total** |
|---|---|---|---|---|
| 10k | ~$0.10 | $40 | ~$39 | **~$79** |
| 50k | ~$0.50 | $200 | ~$199 | **~$400** |
| 200k | ~$2 | $800 | ~$199–999 | **~$1,000–1,800** |

**Path 2 is recommended** — roughly half the cost at every volume, and it avoids per-page billing on narrow queries entirely. With the Business-tier 30% discount ($3.20/1k), 50k/month falls to ~$360.

### Realistic blended mix (~60% search / 40% PAV)

| Volume/mo | **Blended total** |
|---|---|
| 10k | **~$105** |
| 50k | **~$520** |
| 200k | **~$1,600–2,300** |

### Bright Data comparison (if cost dominates)

| Volume/mo | PAYG @ $1.50/1k | Committed @ ~$0.98/1k |
|---|---|---|
| 10k | $15 | $10 |
| 50k | $75 | $49 |
| 200k | $300 | $196 |

**Bright Data is 4–8× cheaper and also has PAV.** I still recommend starting on HarvestAPI: pay-per-result with no commitment, running in minutes, and at 50k/month the difference is ~$300 — far less than the engineering time to onboard Bright Data's compliance review. **Migrate to Bright Data if you sustain >100k/month**, where the delta becomes ~$1,000+/month and justifies the switch.

### Practical note

At 50k/month you're at roughly **$0.01 per profile**. The dominant cost of this system will not be scraping — it will be the LLM scoring pass over those profiles. Budget accordingly, and push hard on cheap pre-filtering (regex/keyword gates on `honorsAndAwards` and `education.endDate.year`) before anything reaches a model.

---

## 6. Test plan — the 20-profile trial

Run this before committing. It costs well under $1 in actor fees; the real cost is a couple of hours of manual labeling, and it's worth it.

### Seed selection (20 profiles, deliberately adversarial)

Do not pick 20 easy profiles — you'll get a false pass.

- **5** current high schoolers, graduating 2026–2027, with visible honors sections *(the core population)*
- **5** gap-year / college freshmen, ex-olympiad or ex-ISEF
- **5** well-known young founders with high-traffic profiles *(tests PAV pollution)*
- **5** deliberately sparse profiles — new accounts, few connections, minimal sections *(the hard case, and the one that matters)*

Within those, include 2–3 non-ASCII names, 2 custom vanity URLs, and 1–2 profiles you know were recently renamed.

**Before running anything, manually open all 20 and record ground truth**: does each have honors? how many? projects? volunteering? grad year? how many PAV entries render? You cannot measure fidelity without this.

### Part 1 — Profile fidelity (`harvestapi/linkedin-profile-scraper`)

| # | Metric | Pass | Fail → |
|---|---|---|---|
| 1 | `moreProfiles` non-empty rate | **≥ 80%** | < 50% ⇒ Strategy A is dead as designed |
| 2 | Mean `moreProfiles` length | **≥ 5** | ≤ 3 ⇒ fan-out too small for 2–3 hops |
| 3 | **PAV in-population rate** — fraction of neighbors who are also students/early-career, hand-labeled | **≥ 30%** | < 20% ⇒ recursion drifts to noise by hop 2; cap at 1 hop |
| 4 | `honorsAndAwards` fidelity vs. your ground truth | **≥ 95%** | Any systematic omission is disqualifying |
| 5 | `education[].endDate.year` present | **≥ 90%** | < 70% ⇒ can't filter by grad year |
| 6 | `projects` + `volunteering` fidelity | **≥ 90%** | — |
| 7 | Actual cost vs. $4/1k, incl. failed-request charges | within 10% | — |
| 8 | **Stability:** re-run all 20 at +24h, diff | < 5% field churn | High churn ⇒ dedup/caching problems downstream *(there's a logged issue about inconsistent results between runs — verify it yourself)* |

Metric **#3 is the one that decides Strategy A.** Everything else is table stakes; PAV relevance is the load-bearing assumption, and it's the one nobody's marketing page will tell you.

### Part 2 — Search viability (`harvestapi/linkedin-profile-search`) — **run this first if short on time**

Three queries in Full mode, ~25 results each:

1. `searchQuery: "Research Science Institute"` + `schools: [thomas-jefferson-high-school-for-science-and-technology]`
2. `searchQuery: "USACO Platinum"` (no school filter)
3. `schools: [stuyvesant-high-school]`, no keyword — pure school sweep

Measure:

| # | Metric | Pass |
|---|---|---|
| 9 | **Does keyword match `honorsAndAwards`/`projects` text, or only headline/title?** For every hit on query 1, check *where* the string appears | **Any hits matching only in honors/projects ⇒ deep indexing works.** All hits headline-only ⇒ Gap 3 confirmed, pivot to roster-first |
| 10 | Precision — fraction genuinely holding that credential | ≥ 60% |
| 11 | `_meta.pagination.totalElements` vs. plausible cohort size | Sanity check for the 2,500 cap |
| 12 | School sweep: fraction in target grad-year band | ≥ 40% (drives waste multiplier) |

### Part 3 — Engagement graph probe (30 min, optional but high value)

Take your 3 most-connected seeds, pull recent posts and reactors/commenters, hand-label what fraction are in-population. **If this beats metric #3, build the expansion on engagement rather than PAV.** My prior is that it will, for a cohort this tight-knit.

### Go / no-go

- **All pass** → build on HarvestAPI, both actors.
- **#9 fails** → Strategy B pivots to roster-first (§3); keep HarvestAPI for resolution + enrichment.
- **#3 fails but #1–2 pass** → PAV works mechanically but not semantically. Cap at 1 hop, weight heavily toward roster + engagement signals.
- **#4 fails** → disqualifying. Go to backup.

---

## 7. Legal and compliance — read before scaling

Not boilerplate. Two of these genuinely constrain vendor choice.

**Proxycurl is a live cautionary tale, not history.** LinkedIn sued Nubela/Proxycurl in the Northern District of California in January 2025 on six counts including breach of contract, fraud, and CFAA. It settled in July 2025 under a **permanent injunction requiring deletion of all LinkedIn data obtained by unauthorized means and notification of all customers**. The company shut down 4 July 2025. What drew the suit was specifically **fake accounts** and **maintaining a resold scraped index** — not reading public pages. Two direct implications:

- **Never use cookie-based actors or fake accounts.** That's the conduct that converts a ToS dispute into fraud and CFAA claims.
- **Don't resell or redistribute the corpus.** Internal use for Z Fellows' own sourcing is a materially different posture from operating a data product.

Note also that in *hiQ v. LinkedIn*, hiQ won on CFAA but ultimately **lost on breach of contract** in 2022. Scraping public data isn't criminal; it still breaches the User Agreement. Expect account bans and cease-and-desist as the realistic downside, and don't build anything whose failure mode is catastrophic.

**Your subjects are minors, and this is the bigger constraint.** LinkedIn's minimum age is 16 in most jurisdictions, so "high school students on LinkedIn" sits squarely in the 16–18 protected band:

- **GDPR** sets digital-consent age at 16 (13–16 by member state) and Recital 38 says children merit *specific protection*. Legitimate-interest balancing is materially harder to sustain for minors. Any EU/UK student in your corpus triggers this.
- **CCPA/CPRA** requires opt-in to "sell or share" data of under-16s. **As of 1 January 2026, processing personal information of known under-16s requires enhanced security measures and a formal documented risk assessment.** That is in force now.
- **State laws** — Colorado, Connecticut, Delaware and Montana extend protections to under-18 for sale and targeted advertising; New Jersey to 17.

Concrete guardrails I'd build in from day one, because retrofitting them is painful:

1. **Scope to US-based profiles** where practical — avoids the hardest GDPR exposure.
2. **Minimize fields.** Store what feeds the score. You do not need photos, contact info, or full `about` text to rank someone.
3. **Do not run email-finding on minors.** HarvestAPI's `$10/1k` email tier is available; for this population I'd leave it off. Outreach to a 16-year-old should go through their public channels or their school, not an SMTP-validated address you inferred.
4. **Set retention** (e.g. 12 months) and honor deletion requests.
5. **Write the risk assessment** the CCPA amendment now requires. It's a short document and it's mandatory.
6. **Keep it internal to Z Fellows.** Don't sell, syndicate, or publish the ranked digest externally.
7. **Prefer roster-first sourcing** — §3 isn't only better data, it's a better legal posture, because it rests on achievements institutions published deliberately.

None of this blocks the project. It shapes it, and doing it up front is much cheaper than doing it after someone asks.

---

## 8. Backup option

**Primary backup: Bright Data LinkedIn Scraper API.** It's the only other verified source of `people_also_viewed`, it supports both URL collection and keyword discovery, it's cookieless, and at $0.75–1.50/1k it's **4–8× cheaper** than HarvestAPI. It also has the strongest compliance posture of any vendor here — genuinely relevant given §7. The reasons it isn't primary are onboarding friction (KYC + compliance review, days not minutes) and a less student-focused schema that needs verification on `honorsAndAwards`/`volunteering` equivalents. **If HarvestAPI fails metric #4 or #8, or if you cross ~100k profiles/month, switch.**

**Secondary: `apimaestro/linkedin-profile-detail`** at $5/1k — 4.7★ over 64 reviews, 18K users, 3-hour issue response. Solid, actively maintained, and honors/projects/certifications are covered. **But it has no PAV**, so it can only serve Strategy B and roster-based enrichment. Pair it with Bright Data or Exa for expansion.

**For expansion specifically, if PAV disappoints: Exa `find_similar` + People Search.** A semantically-trained neighbor model over 1B+ profiles is arguably a *better* similarity primitive than LinkedIn's co-view heuristic — it matches on what a person *is*, not on who happened to browse them, which directly addresses Gap 2. At ~$45/1k matched results it's too expensive for bulk enrichment, but as a discovery layer feeding a $4/1k enricher it's well-priced.

**Not recommended:** `scrapio/linkedin-profile-scraper`, despite doing exactly the 3-hop BFS you described with `discoveryDepth`/`seedHandle`/`discoveredVia` labels. Six monthly active users, zero reviews, and a documented fallback to Wayback Machine snapshots — you'd be shipping stale data without knowing it. **And you don't need it:** HarvestAPI hands you `moreProfiles` with resolvable identifiers, so the BFS is ~40 lines of your own code. Writing it yourself keeps scoring, thresholding, dedup and provenance under your control, which is where the actual product value lives.

---

## Appendix — Sources

- [harvestapi/linkedin-profile-scraper](https://apify.com/harvestapi/linkedin-profile-scraper) · [issues](https://apify.com/harvestapi/linkedin-profile-scraper/issues)
- [harvestapi/linkedin-profile-search](https://apify.com/harvestapi/linkedin-profile-search)
- [apimaestro/linkedin-profile-detail](https://apify.com/apimaestro/linkedin-profile-detail) · [full-sections](https://apify.com/apimaestro/linkedin-profile-full-sections-scraper)
- [scrapio/linkedin-profile-scraper](https://apify.com/scrapio/linkedin-profile-scraper) · [data-slayer/linkedin-profile-scraper](https://apify.com/data-slayer/linkedin-profile-scraper)
- [Bright Data LinkedIn Profiles Scraper](https://brightdata.com/products/web-scraper/linkedin/profiles) · [LinkedIn Scraper API docs](https://docs.brightdata.com/datasets/scrapers/linkedin/introduction)
- [Coresignal pricing](https://coresignal.com/pricing/) · [docs](https://docs.coresignal.com/pricing)
- [ScrapIn](https://www.scrapin.io/) · [Piloterr LinkedIn Profile Info](https://www.piloterr.com/library/linkedin-profile-info)
- [Exa People Search](https://exa.ai/docs/reference/verticals/people) · [Exa Recruiting Agent](https://docs.exa.ai/examples/exa-recruiting-agent)
- [LinkedIn wins case against Proxycurl — Social Media Today](https://www.socialmediatoday.com/news/linkedin-wins-legal-case-data-scrapers-proxycurl/756101/) · [Nubela founder's account](https://nubela.co/blog/is-scraping-linkedin-legal-in-2026/)
- [IMO official results](https://www.imo-official.org/) · [IOI statistics](https://stats.ioinformatics.org/) · [USACO results](https://usaco.org/) · [Society for Science / ISEF](https://www.societyforscience.org/isef/)
- [Minors' privacy compliance — Alston & Bird](https://www.alston.com/en/insights/publications/2025/11/minors-privacy-online-safety-laws) · [IAPP](https://iapp.org/news/a/kids-and-teens-online-privacy-and-safety-8-compliance-considerations)
