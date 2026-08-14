# UI Audit — pre-redesign state

Audited 12 Aug 2026, before any redesign work.

## Headline finding

**The app is not what the redesign brief assumes it is.**

The brief describes Z-Score: LLM signal extraction, deterministic archetype-relative scoring,
and five screens (digest, queue, detail, graph, taxonomy admin). What exists is **Sweep** — a
discovery-only tool that finds LinkedIn profiles via sharded Google SERP queries and dedupes
them. Two screens. No scoring layer of any kind.

```
grep -rniE "\bscore\b|\brating\b|archetype|candidate|digest|taxonomy|graph" app lib scripts
```

returns **zero** matches for `score`, `rating`, `archetype`, `digest`, `graph`. The only hits
are the word "candidate" in one line of prose copy, and `taxonomy` referring to a *search-term*
taxonomy that has no weights.

Consequence: the `z_score` rename map is **not** a rename of existing fields. It is a naming
contract for schema being introduced for the first time.

---

## Stack

| Aspect | Finding |
|---|---|
| Framework | Next.js 15.5.4, **App Router** (`app/` directory, no `pages/`) |
| Language | TypeScript, `strict: true`, path alias `@/*` |
| Styling | **Plain CSS**, single `app/globals.css` with CSS custom properties. No Tailwind, no PostCSS config, no CSS modules |
| CSS-in-JS | None. No styled-components, emotion, clsx or cva |
| Component library | **None.** Every element is hand-written; nothing is a library default |
| State | Local `useState` / `useMemo` only. No Redux, Zustand, or context |
| Fonts | Runtime `<link>` to Google Fonts (Fraunces + IBM Plex Sans/Mono) with system fallbacks. Deliberately not `next/font` — build-time fetching caused `next build` to hang |
| Data fetching | `fetch` to own API routes; client batches shards 20 at a time |
| Tests | `scripts/check-parsing.ts`, 46 assertions, run via `npm run check` (tsx) |
| Build isolation | `npm run build:check` writes to `.next-check` via `NEXT_DIST_DIR` so a type-check cannot clobber a running dev server |

---

## Route and file inventory

2,020 lines total across 12 source files.

| Path | Lines | What it is |
|---|---|---|
| `app/page.tsx` | 489 | **The one real screen.** Client component: dimension pickers, query-mode toggle, shard matrix, run controls, results table, CSV export |
| `app/globals.css` | 682 | All styling. Token block + ~40 component classes |
| `app/unlock/page.tsx` | 64 | Passphrase gate form |
| `app/layout.tsx` | 36 | Root layout, font links, metadata |
| `app/api/sweep/route.ts` | 39 | POST, max 25 shards/call, cookie-verified |
| `app/api/auth/route.ts` | 33 | POST sets signed cookie, DELETE clears |
| `middleware.ts` | 29 | Cookie-presence gate, redirects to `/unlock` |
| `lib/taxonomy.ts` | 294 | **Search-term** taxonomy: 25 programs, 40 high schools, 20 colleges, 7 years. Aliases + `casual` forms. **No weights** |
| `lib/search.ts` | 220 | Serper + Google CSE providers, slug extraction, title parsing, year inference, free-tier auto-degrade |
| `lib/shards.ts` | 77 | Cartesian product shard builder, strict/loose modes, cost estimate |
| `lib/types.ts` | 40 | `ShardDims`, `Shard`, `Hit`, `ShardResult`, `SweepStats` |
| `lib/auth.ts` / `lib/session.ts` | 46 | HMAC-signed cookie; `session.ts` split out so Edge middleware avoids `node:crypto` |

### Routes

- `/` — sweep screen (gated)
- `/unlock` — passphrase form (public)
- `/api/sweep`, `/api/auth` — JSON endpoints

**Four of the five briefed screens do not exist**: digest, candidate detail, graph, taxonomy
admin. The results table on `/` is the closest thing to a candidate queue and is the natural
thing to evolve into one.

---

## Current visual language — and why it is being replaced

The existing design is a deliberate, self-consistent system, but it is **not** zfellows.com:

| Aspect | Current | zfellows.com |
|---|---|---|
| Ground | Cool pale sage `#f1f3f1`, dark mode `#0d1412` | Warm cream `#fffdf3`, light only |
| Accent | Deep teal `#0b5d4e` | Blue `#2067ff` |
| Secondary encoding | Medal tiers — gold `#b4881f`, silver `#7e8a8c`, bronze `#9c5b2e` | None; one accent |
| Display face | Fraunces (serif, `WONK` axis) | Inter, system stack in the redesign |
| Radius | `3px` / `6px` — near-sharp | `999rem` pills, `12`/`20px` cards |
| Buttons | Rectangular, 3px radius | Pills with inset blue glow |
| Layout | Sidebar rail + top bar | Top horizontal nav, no sidebar |
| Theme | Full dark-mode token set | Light only |

Every one of these conflicts with the brief. The dark-mode token set is **removed** — the brief
specifies light theme matching zfellows, and dark appears there only as a card treatment.

The sidebar-plus-topbar layout is also explicitly called out as an anti-pattern, so navigation
is rebuilt as a top horizontal nav derived from `.new-navbar_link`.

---

## Component inventory — all custom, none library defaults

From `app/globals.css`: `.topbar`, `.wordmark`, `.shell`, `.rail`, `.stage`, `.eyebrow`,
`.section-title`, `.section-note`, `.chips`, `.chip`, `.btn` (+`.ghost`), `.linkish`,
`.runbar`, `.readout*`, `.matrix`, `.matrix-band`, `.cell`, `.legend`, `.swatch`,
`.table-wrap`, `.tier`, `.person-name`, `.headline`, `.snippet`, `.year-pill`,
`.empty-state`, `.unlock-*`, `.input`, `.banner`, `.hint`.

Nothing is a vendor default, so there is no stock styling to strip — but every class needs
retheming to the extracted tokens.

Two existing concepts survive the redesign conceptually:

- **`.tier`** — colours a corroboration count by magnitude (gold/silver/bronze). This is a
  direct ancestor of `ZScoreBadge`, but the medal palette is unsourced and gets replaced by the
  sigma magnitude ramp.
- **`.matrix` / `.cell`** — the shard matrix, a genuinely distinctive element that visualises
  query productivity. It is retained and rethemed, not discarded.

---

## Where the score is displayed or named today

Nowhere, in the scoring sense. The nearest equivalents:

| Location | Current | Becomes |
|---|---|---|
| `lib/types.ts` `Hit.matchedShards: string[]` | Array of shard ids; `.length` is the corroboration count | Stays on `Hit`; feeds a `Candidate.z_score` term |
| `app/page.tsx` — `.tier` span, `data-tier={Math.min(len,3)}` | Gold/silver/bronze count badge | `ZScoreBadge` with sigma notation + archetype |
| `app/page.tsx` sort — `b.matchedShards.length - a.matchedShards.length` | Ranking by corroboration | Ranking by `z_score_normalized` |
| `app/page.tsx` copy — "it is a proxy, not a score" | Prose disclaimer | Removed once a real score exists |
| `lib/types.ts` `Hit.inferredYear` | Regex-inferred grad year | Feeds `Candidate.graduation_year` |

---

## Rename map

| From | To | Reason |
|---|---|---|
| `lib/taxonomy.ts` | `lib/searchTaxonomy.ts` | Frees `taxonomy` for the weighted scoring taxonomy the admin screen edits. A genuine collision — the two are different structures, not synonyms |
| `Term` (type) | `SearchTerm` | Same |
| `termToFragment` | `searchTermToFragment` | Same |
| `package.json` `talent-sweep` | `z-score` | Product name |
| metadata title `Sweep — early talent discovery` | `Z-Score` | Product name |
| `COOKIE_NAME = "sweep_session"` | `"zscore_session"` | Product name |
| `APP_PASSPHRASE` | `ZSCORE_PASSPHRASE` | Env prefix |
| `SESSION_SECRET` | `ZSCORE_SESSION_SECRET` | Env prefix |
| `SERPER_API_KEY` | `ZSCORE_SERPER_API_KEY` | Env prefix |
| `GOOGLE_CSE_KEY` / `GOOGLE_CSE_CX` | `ZSCORE_GOOGLE_CSE_KEY` / `ZSCORE_GOOGLE_CSE_CX` | Env prefix |

**Not renamed:** `Hit` (a SERP result is genuinely not a `Candidate`; both types coexist),
`/api/sweep` (sweeping remains the discovery action), `Shard` / `ShardResult` / `buildShards`.

---

## Behaviour that must not regress

Verified working before the redesign and covered by the 46 assertions:

1. Sweep runs against Serper and returns results.
2. Deduplication on LinkedIn profile slug — never on name.
3. Ranking by cross-shard corroboration.
4. Strict and loose query modes produce different queries and different ids. Measured on a live
   run: 16 unique people from 20 hits, only 4 found by both modes.
5. Serper free-tier auto-degrade — `num > 10` is rejected, so the client latches and retries at
   10 rather than failing every shard.
6. Google CSE pagination terminates on a short page or absent `nextPage` (the infinite-loop bug
   present in the original n8n workflow is fixed here and must stay fixed).
7. Slug extraction handles locale subdomains, query strings, trailing slashes, percent-encoding,
   and rejects `/company/` and `/pulse/` URLs.
