# Z-Score

Z-Score is the Z Fellows tool for finding high schoolers and early college students before
anyone else has noticed them. It searches for them, scores them against a taxonomy we tune by
hand, and ranks the best into a digest.

The score is written in sigma notation (`+2.4σ`), which is where the name comes from. It isn't a
standard deviation. It's a fixed, hand-calibrated sum, so a person's score doesn't depend on who
else is in the queue.

## Getting in

Teammates unlock the site with a shared passphrase, then pick who they are (Cory, Grace or
Thomas). The picker isn't security. It's how each person keeps their own marks and history.

## Screens

```
sweep → queue → digest
          ├→ graph      a live view of the queue
          └→ taxonomy   the rules that score everything
agent → the same loop, once a day, on its own
```

| Route | What it's for |
|---|---|
| `/sweep` | Find people and decide what to do with the results |
| `/queue` | The roster: pin, mark known, remove, enrich, retag, override a cluster |
| `/digest` | The top ten by score, laid out so it can be emailed. The main screen |
| `/graph` | People and their tags as one network |
| `/taxonomy` | Term weights, cluster assignments, and the review queue for new terms |
| `/candidate/[slug]` | One person: score breakdown, tags, profile, and how we found them |
| `/agent` | Multi-day campaigns that run themselves, plus the Claude connection |

### Search results

Each result has two buttons. **Add to queue** is free and uses only what the search returned.
**Enrich** pays Apify about $0.004 to pull the full profile, then queues the person. If you enrich
someone who's already queued, their record is upgraded in place, and their marks, discovery trace
and first-seen date are kept. Adding now and enriching later works fine.

### Queue rows

- ★ pins someone to the top, and you can filter by it.
- ◆ means you already know them. They leave the queue but still count on the digest. Kept apart
  from removal on purpose: "this sweep found eight people Cory already rates" is evidence the
  tool works.
- ✕ removes them. Later sweeps leave them unticked and say why. You can undo right away, or
  restore anyone from the Removed view.

There's no "interested" button because being in the queue already means that.

## Scoring

```
raw = Σ weight(matched term) + bonuses for publications, patents and projects
z   = (raw − 2.2) / 1.8        fixed constants, not measured from the data
```

| Profile | raw | z |
|---|---|---|
| Hack Club alone | 0.7 | −0.8σ |
| RSI + ISEF + USAMO | 4.5 | +1.3σ |
| IMO + IOI + RSI + 1 publication | 6.6 | +2.4σ |

`npm run check` asserts these three, so a weight change can't quietly move the scale. The
calibration is fixed because standardising over the current pool made scores drift as the queue
grew and gave teammates different numbers for the same person. Now a score only changes when
someone retunes a weight.

Search-only and enriched people go through the same formula. A search-only person has less text,
so they usually match fewer terms. Their badge is hollow and says "from search" so you can tell.

The model is in [`lib/clusters.ts`](lib/clusters.ts). Applying it is in
[`lib/candidates.ts`](lib/candidates.ts).

### Clusters

A cluster is a reference class: olympiad kids get compared with olympiad kids.

| Cluster | Terms |
|---|---|
| Olympiad | IMO, IOI, USAMO, USACO Platinum, USAPhO, USABO, Mathcamp, PROMYS |
| Research | RSI, STS, ISEF, SSP, MIT PRIMES, Simons Fellow, Garcia Program, publications |
| Builder | Hack Club, Conrad Challenge, projects, open source |
| Founder | Thiel Fellow, Neo Scholar, Diamond Challenge, YC and founder headlines |
| Quant | Jane Street, quant and trading internships |
| Scholar | Coca-Cola Scholar, TASP, SPARC |

A person's cluster comes from their single highest-weighted term. IOI (2.0) beats RSI (1.8), so
someone with both is Olympiad, with Research as a secondary. Move RSI above IOI on the taxonomy
screen and they become Research. A term can belong to no cluster. QuestBridge, for example, adds
weight but doesn't vote. A hand override on a person always wins.

Polymath is a badge rather than a cluster. You get it by clearing +0.5σ in two or more clusters.

### Which tags count

| Where the tag came from | Counts toward the score? |
|---|---|
| A taxonomy term found in the person's own text | Yes |
| A search chip that the hit's title or snippet confirms | Yes |
| A search chip the text doesn't show | No. Shown struck through |
| A term the tagger extracted, once promoted | Yes |
| A term the tagger extracted, not yet promoted | No. Waits in the review queue |

A query like `(RSI OR IMO) (MIT OR Stanford)` doesn't tell you which branch matched, so each chip
is checked against the hit's own text. Unconfirmed chips stay on the record because they show why
we looked at someone.

## The tagger

With `ZSCORE_GROQ_API_KEY` set, Groq (`openai/gpt-oss-120b`, about $0.0002 a profile) reads
credential names out of profile text. It runs on every enrichment, and behind an Analyze button
for search-only people.

The tagger never changes a score. A new term weighs nothing until someone promotes it on the
taxonomy screen and picks its cluster and starting weight. That happens once per term, not once
per person. Nothing is ever generated per person, so the ranking stays reproducible.

It only gets credential text: no name, URL, school or location, because the people are minors.
Every screen still works without the key. You just stop discovering new terms, and the review
panel tells you that.

## The graph

People and tags are both nodes, and each person links only to their own tags. That keeps the
number of edges linear and shows which credential connects a group.

A tag only appears while 2 to 8 people hold it. Rarer tags are noise, and common ones like "class
of 2028" pull everything into one blob. You can change both limits, and the screen lists whatever
it dropped. Discovery edges (who turned up on whose People Also Viewed) link people directly and
are always shown.

The layout is a seeded simulation that runs once on the client, so it's the same on every reload.
It shows at most 120 people, drops the lowest scores first, and says when it has.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev      # http://localhost:3737
```

`ZSCORE_APIFY_MOCK=1` lets you run the whole flow without paying. `.env.example` documents every
variable.

### Discovery

Everything you can pick on the sweep screen lives in
[`lib/searchTaxonomy.ts`](lib/searchTaxonomy.ts). A sweep is a single Google query through Serper.
Options inside a category are ORed and categories are ANDed, so adding options widens the query
without costing another search:

```
(Coca-Cola Scholar OR RSI) (MIT OR Stanford) (TJHSST OR Harker) site:linkedin.com/in
```

Nothing is quoted, so Google's synonyms and ranking keep working. We only ever talk to Google,
never LinkedIn: no cookies, no account. Results are deduped by profile slug, not name. Serper's
free tier caps a query at 10 results. The app notices and retries at 10, and paid plans get 100.

### Enrichment

[`harvestapi/linkedin-profile-scraper`](https://apify.com/harvestapi/linkedin-profile-scraper),
at $4 per 1,000 public profiles. It also returns each profile's People Also Viewed list, so a
single vendor handles both enrichment and following people outward.

Runs are started and polled because Apify and Vercel both time out at 300 seconds. A run survives
reloads and moving between screens, and the nav shows its progress.

People Also Viewed tracks who gets viewed together, not who is similar. A famous adult's list
fills with other famous adults, and a quiet 16-year-old's may be empty. Every person records where
they came from, so you can see the drift before trusting a second hop.

## Storage

| Key | Type | Holds |
|---|---|---|
| `zscore:team:people` | hash, field = slug | The roster, shared |
| `zscore:team:prefs` | string | Taxonomy and custom search terms, shared |
| `zscore:profile:<id>` | string | Your marks, sweeps, filters, seeds and active job |
| `zscore:job:<profile>:<id>` | string | An enrichment run in progress |

The roster and taxonomy are shared, so nobody pays twice for a profile and everyone sees the same
score. Pins, known and removed are personal, so one person's triage doesn't reshape anyone else's
list. Each person is a single hash field, so pinning someone writes a few bytes, not the whole
roster. Old documents migrate once, on first read.

With Upstash Redis credentials set, the app uses Redis. Without them it writes JSON to `.data/`,
which is only for local use. Vercel can't persist files, so production needs Redis. If it's
missing, the app shows a banner rather than losing writes quietly. To attach it, open Vercel →
Storage → Marketplace → Upstash Redis, connect it to the project and redeploy. `UPSTASH_REDIS_REST_*`,
`KV_REST_API_*` and `ZSCORE_REDIS_REST_*` all work.

Local dev reads `.env.development.local` as well. If that file holds the Vercel KV variables,
your dev server is writing to the shared Redis.

## Before deploying

- The spend cap is enforced on the server: 500 profiles per teammate per UTC day by default
  (`ZSCORE_DAILY_PROFILE_CAP`). Quota is reserved before a run starts, and a refusal says when it
  resets.
- Every API body is validated and rejected with a 400 if it's malformed.
- Paid calls are logged as JSON lines with count, cost and duration, and no candidate data.
- Every response sends `noindex` and a narrow CSP, because the people in here are minors.
- "Stored data" on the taxonomy screen deletes every stored person and keeps the weights.
- Minors' data carries legal obligations. Since 1 January 2026, CCPA has required a documented
  risk assessment for processing known under-16 data, and email-finding stays off.
  `VENDOR_RECOMMENDATION.md` §7 covers this.
- The cron stays off until `CRON_SECRET` is set. Until then the route returns 503 instead of
  leaving a public URL that starts paid work.

## The agent

A campaign runs the pipeline on a timer. You give it a selection, a number of days and a daily
search budget. Each day it ranks finds by how many of your search terms their own text confirms,
queues the best new ones, enriches a few, and keeps a running top thirty. When it's done you get a
report.

It has two strategies. **Keyword search** just runs queries. **Search then explore** searches
for the first few days, then switches to opening the People Also Viewed lists of its best enriched
finds and following the good neighbours. Those hops are free because the lists came with profiles
we'd already paid for. They're less precise, though, so `maxHop` (default 2) limits how far it
wanders, and seeds only come from the top thirty. On a day with nothing left to explore, it
searches. Running out of queries only ends a keyword campaign.

Three things advance a campaign: the daily cron, the Advance button on `/agent`, or Claude. Every
setting it uses is on that screen: days, searches, queued and enrichments per day, the dollar
ceiling, the score bar, and team defaults. Limits we don't control are listed there too.

Claude connects over MCP at `/api/mcp` with a `zsk_` token you mint on `/agent`. Only a SHA-256
hash of the token is stored. Through its 14 tools Claude can read the taxonomy, the queue and
campaigns, test a query for a tenth of a cent, create, advance, update and stop campaigns, and
search, queue and enrich. It can't delete people, reset the roster, change weights, or mark anyone
known or rejected. Those are human calls.

An unattended run won't re-add someone who was permanently deleted, and won't bring back someone a
person rejected. Clicking Add again in the UI does revive them, because then a person chose to.

## Email

The digest was always meant to go out by email, which is why its rows are tables. When a campaign
finishes, its report goes to whoever started it. The queue digest goes out daily or weekly. You set
your address and cadence at the bottom of the digest screen, and a button there sends you one
now. Cadence options appear once you've entered an address.

Email needs `RESEND_API_KEY` and `ZSCORE_EMAIL_FROM`. With neither set, nothing sends and the
screen says so. Resend only sends to the account owner until you verify a domain. Use a subdomain
and add the MX, SPF and DKIM records Resend gives you.

Mail goes out with the 09:00 UTC cron, or right away when a campaign is advanced by hand or by
Claude. Repeated cron runs can't double-send, because each send checks what's finished and
unnotified or whose cadence is due.

## Commands

```bash
npm run check          # pure-function checks, no network or keys
npm run check:agent    # the campaign engine and LLM steps end to end, paid calls stubbed
npm run build:check    # type-check build into .next-check, safe while dev is running
npm run preview:email  # write both email templates to .data/
```

`check` focuses on bugs that would corrupt data without anyone noticing. It covers slug
extraction (the dedupe key), name, headline and year parsing, query building, Apify payload
parsing, hop expansion, the confirmed/unconfirmed split, the worked examples above, a person
scoring the same in a pool of 1 or 30, cluster assignment and ties, the polymath threshold,
promotion, status changes and sweep suppression, graph windowing and layout determinism, the hash
store, legacy migration, and the agent's query plan and stopping rules. It also mutation-tests the
two things an unattended run must refuse, so those checks can't pass by accident.

## Design docs

- [`DESIGN_TOKENS.md`](DESIGN_TOKENS.md): every token, traced back to zfellows.com
- [`DESIGN_LANGUAGE.md`](DESIGN_LANGUAGE.md): the standing design rules
- [`REDESIGN_PLAN.md`](REDESIGN_PLAN.md): component and screen specs
- [`VENDOR_RECOMMENDATION.md`](VENDOR_RECOMMENDATION.md): why SERP discovery, and the rules
  for storing real profile data

The logo is `assets/logo.png`. `app/icon.png` and `app/apple-icon.png` are generated from it.

## Not built

LLM screening beyond pulling out terms. The digest is the top ten by score, and screening is a
separate decision.
