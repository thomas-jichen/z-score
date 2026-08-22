# Demo runbook

For the Cory and Grace demo. Everything below was verified against the live app and
the live data, not assumed. Times and numbers are what it actually did.

---

## 1. Done: the Z Fellows people

**Grace Kasten is deleted permanently.** She is on the blocklist, so no future sweep
or campaign can re-add her. Her headline was literally `Z Fellows` — she works there —
and no rule over the words separates "my employer is Z Fellows" from "I am a Z
Fellow". Showing Grace a screen listing Grace as a candidate was the one outcome
worth spending a deletion on. Roster is 55; Cory's queue is 39.

**Two more are worth a look, and I left them for you** because deletion cannot be
undone and both are judgement calls about a real person:

| | Headline | Why it is ambiguous |
|---|---|---|
| `Baylor Adams` | "Early stage investor" | Only mention of Z Fellows is `Experience:`, so he no longer carries the tag — but he is probably staff or a scout, not a candidate |
| `Sonith Sunku` | *(none)* | Same shape: `Experience: Z Fellows` and nothing else |

Both are already untagged and score near zero, so they sit near the bottom of the
queue rather than in the demo's top ten. The ◆ Already known button handles either
one in a click if you would rather they were not there at all.

**Tarun Batchu's RSI tag is suppressed.** His honours section is *headed* "Research &
Science Awards", which normalises to the same key as "Research Science Institute", so
he was carrying a 1.6 for a programme he never attended. Suppressed on him
specifically — the tag is wrong about him, not worthless in general. If anyone asks,
this is a good demonstration of the × on a tag chip.

## 2. Demo on the production build, not the dev server

There is a red **"3 Issues"** badge in the bottom-left corner of every screen on
`npm run dev`. It is not our bug: React reports a hydration mismatch because a
browser extension — Bitdefender, injecting `bis_skin_checked="1"` into every `div` —
edits the DOM before React hydrates. React's own message lists this as one of its
causes. The production build has no dev overlay at all, so the badge cannot appear.

```bash
# Stop the dev server first, or use the alternate dist dir as below.
NEXT_DIST_DIR=.next-check npx next build
NEXT_DIST_DIR=.next-check npx next start -p 3739
```

Verified: builds clean, **ready in 68ms**, every route serves, no overlay, no console
errors. Using `NEXT_DIST_DIR` means this never touches a running dev server's
chunks — which is what `next.config.ts` says it is for.

If you would rather stay on the dev server, demo in a Chrome profile with extensions
disabled and the badge goes away too.

---

## 3. Which profile to demo from

| Profile | State | Good for |
|---|---|---|
| **Cory** | 39 queued, 16 removed | The main demo. Looks used, not empty. |
| **Grace** | 17 queued, no removals | Showing it "through her eyes". |
| **Thomas** | 52 queued, 5 saved sweeps, **owns the only campaign** | Anything on the Agent screen you want to *drive* |

The campaign controls are owner-only by design. As Cory the finished campaign shows
`Report` and nothing else; as Thomas you also get Advance, Edit and Delete. **If you
plan to advance a campaign live, be Thomas.**

---

## 4. Pre-flight, the morning of

Run these in order. Each one has a known-good answer.

```bash
npm run check          # → All 563 checks passed.
npm run check:agent    # → All 139 agent checks passed.   (~70s, it is doing real work)
npx tsc --noEmit       # → silence
```

Then prove the paid paths are alive, because an expired key is the one failure you
cannot talk your way through. One query, one tenth of a cent:

```bash
# In the browser console on the app, signed in:
await fetch('/api/sweep', {method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({shards:[{id:'smoke', query:'RSI Stanford site:linkedin.com/in'}]})}).then(r=>r.json())
```

Verified this morning: **10 hits in 2.8s, no errors, $0.001**. If it returns an error
about the key, the sweep and the whole agent loop are down and nothing else matters.

All four keys are set locally: Serper, Apify, Groq, and `CRON_SECRET`. `enrichPerDay`
defaults to 10 and the per-run cap now defaults to 10 as well, which is what a free
Apify account allows — so nothing can buy a refused batch mid-demo.

---

## 5. The demo itself

An order that shows the product's argument, not just its screens. Roughly 12 minutes.

**1. Digest — "here is the answer."** Open on `/digest`. Sebastian Tan +5.7σ,
Philip Meng +4.7σ, Davido Zhang +4.2σ. Lead with the ranking, not the
plumbing. The two signals beside each name are the argument for the number.

**2. One candidate — "and here is why."** Click Davido Zhang. The score breakdown
now quotes the words that produced each signal: `RSI +0.53σ` reads
*"Research Science Institute"*, `STS +0.47σ` reads *"Regeneron STS Scholar"*.
This is the strongest thing in the product to a sceptical audience — every number
is traceable to a sentence on the profile. Open **Everything else** to show the
long tail with the same treatment.

**3. Queue — "and here is the work."** `/queue`. Show Filters → **Enrichment → Not
enriched**, then the header checkbox: the bulk bar offers to enrich them at a stated price. Three
clicks from "who still needs a profile pulled" to a priced action. Then the ★ ◆ ×
triage on a row.

**4. Graph — "and here is who knows whom."** `/graph`, 105 links. Switch **People →
Hubs** and toggle a link type or two. Do not linger; it is a supporting act.

**5. Taxonomy — "and you control all of it."** `/taxonomy`. Move one weight slider
and show the score change. Then the right column, **Unmatched but notable**: ~90 terms
the tagger found that are not yet in the vocabulary, each with Promote and Dismiss.
This is the honest answer to "what happens when it meets a credential you have never
heard of".

**6. Agent — "and it does this without you."** `/agent`. Read the campaign row:
*Research olympiad to top CS, ran its full 2 days, 30 found, $0.04 of $0.30*. Click
**Report** for the ranked list it produced by itself. Then open **What to say to
Claude** and **Limits we do not set** — the second one is the credibility move: every
number the loop obeys is on screen, including the ones you do not control.

**7. Close on the money.** 30 people for 3.7 cents, and a hard ceiling that stops it.

---

## 6. Things not to do live

- **Do not run a full sweep from `/sweep`** unless you have rehearsed the exact
  selection. It is the one screen where a wide selection can take a while and return
  noise. A saved sweep from Thomas's profile is the safer path.
- **Do not create an MCP token on stage** unless you want to switch to a terminal.
  There are zero tokens right now; minting one shows a `claude mcp add` command that
  only means something if you then run it. Better as a follow-up than a live step.
- **Do not advance the finished campaign** hoping it does something. It is done, and
  raising its day count would restart real spending mid-demo.
- **A phone is fine if you need it.** Digest, queue and Agent were all walked at
  402px with zero real overflow: the table becomes cards, the nav becomes a bottom tab
  bar, headlines ellipsise. The graph is the only screen that wants a laptop.

---

## 7. If someone asks a hard question

**"How do you know the tags are right?"** You do not have to take it on faith — every
tag read from prose carries the words that produced it, on screen. And the honest
version: this week we found and fixed a wrong `Benchmark +1.5` on the second-ranked
person that came from the word "benchmark" in one of his own papers. The evidence
trail is what made that findable.

**"What stops it inventing credentials?"** Three things, and they are all visible.
Names that are also ordinary English words are only read where the sentence vouches
for them — "backed by Accel" counts, "IMU accel and gyro" does not. A tier is priced
separately, so a Neo Scholar *finalist* scores 0.8 rather than the scholar's 1.5. And
the LLM only ever adjudicates what the rules could not settle, never the whole thing.

**"What does it cost?"** A search is $0.001 and a profile pull is $0.004. The
two-day campaign found 30 people for 3.7 cents. Enrichment is the only real spend and
it has a per-day cap inside a hard dollar ceiling.

**"Does it scrape LinkedIn?"** No. Google, for public search results, then a vendor
for the profile detail. The corpus is minors, so the app is `noindex`, behind a shared
passphrase, and email-finding is deliberately switched off.

**"What if it is wrong about someone?"** Three different verbs, deliberately: this tag
is wrong about *him* (the × on a chip), this tag is worthless (Dismiss on the
taxonomy screen), and this person should never come back (delete permanently).

---

## 8. Known rough edges, in case they surface

| | |
|---|---|
| 93 unmatched terms in the review queue | Feature, not backlog: the tagger finds credentials faster than anyone prices them. Say so. |
| `Grace Kasten` / `Baylor Adams` in the roster | Z Fellows staff, swept up by their own headlines. See §1. |
| The only campaign is finished and owned by Thomas | Demo as Thomas, or just show the Report. |
| Cron is not running | `CRON_SECRET` is set locally; on Vercel the daily advance needs it in the environment or the route 503s on purpose. |
| Mobile graph | Intentionally simplified on a narrow screen. |
