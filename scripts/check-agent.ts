/**
 * Edge cases for the agent loop. Run: npm run check:agent
 *
 * The pure parts of the campaign engine are covered by `npm run check`. This is
 * the other half: `tickCampaign` end to end against a real store, with the two
 * paid calls stubbed. It exists because the engine's failure modes are things a
 * pure test cannot reach — a lock two callers race for, a day counter that must
 * move once however often it is poked, a rate limit hit halfway through a chunk,
 * a blocklist an unattended loop must not walk past.
 *
 * Nothing here talks to Serper, Apify or Groq. `fetch` is replaced for the whole
 * run and restored at the end; `ZSCORE_APIFY_MOCK` keeps the enrichment path
 * synthetic. Both are asserted, not assumed, so a stub that stops matching the
 * real call site fails loudly rather than quietly testing nothing.
 *
 * The store is the real file backend, backed up and restored around the run, for
 * the same reason: the interesting bugs live in what gets persisted between two
 * calls, and a fake store would not have them.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MAX_CAMPAIGNS,
  budgetLeft,
  terminalReason,
  utcDay,
  type Campaign,
} from "../lib/campaign";
import {
  createCampaign,
  deleteCampaign,
  listCampaigns,
  readCampaign,
  buildReport,
  stopCampaign,
  tickCampaign,
  updateCampaign,
  writeDefaults,
} from "../lib/campaignRun";
import { tagFresh } from "../lib/campaignTag";
import { adjudicateFresh } from "../lib/tagAdjudicate";
import { MAX_UNVOUCHED, heldTags, unvouchedTags } from "../lib/tags";
import type { Person } from "../lib/people";
import { EMPTY_SELECTION, type Selection } from "../lib/query";
import type { ProfileId } from "../lib/profiles";
import { MAX_PROFILES_PER_RUN } from "../lib/apify";
import { HOURLY_TAG_CAP, reserveTagging } from "../lib/ratelimit";
import { hasGroq } from "../lib/groq";
import { readRoster, readTeam, writePeople } from "../lib/serverState";
import { TEAM_KEY } from "../lib/state";
import { del, get, set } from "../lib/store";
import { stateKey, hydrate, type ProfileState } from "../lib/state";

/* ── Harness ────────────────────────────────────────────────────────────── */

let failures = 0;
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

function checkThat(label: string, pass: boolean, why?: string) {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}`);
  if (!pass && why) console.log(`         ${why}`);
}

const OWNER = "cory" as ProfileId;
const OTHER = "sam" as ProfileId;
const STORE = path.join(process.cwd(), ".data", "store.json");

/* ── The stubs ──────────────────────────────────────────────────────────── */

const realFetch = globalThis.fetch;

/** Every call the run made, so a test can assert what was and was not paid for. */
let calls: { host: string; body?: string }[] = [];

/**
 * What the stubbed model says next.
 *
 * `verdicts` maps a tag id to the answer. `groqStatus` and `groqFailures` drive the
 * retry cases: a 429 with a retry-after header must be retried and a 400 must not,
 * and the number of times `fetch` is reached is the thing under test.
 */
let verdicts: Record<string, boolean> = {};
let groqFailures = 0;
let groqStatus = 429;
let groqRetryAfter: string | null = "0";
/** Set to return ids nobody asked about, or to answer only some of them. */
let groqExtraIds: string[] = [];
let groqAnswerOnly: string[] | null = null;

/** Set to have the stub report how much of the minute's budget is left. */
let groqRemainingTokens: string | null = null;
let groqResetTokens = "250ms";

function groqReply(body: string | undefined): Response {
  if (groqFailures > 0) {
    groqFailures--;
    return new Response(JSON.stringify({ error: { message: "slow down" } }), {
      status: groqStatus,
      headers: groqRetryAfter === null ? {} : { "retry-after": groqRetryAfter },
    });
  }
  // Answer about exactly the ids the prompt asked about, which is how the real
  // model behaves and what makes the hallucination guard meaningful.
  const asked = [...(body ?? "").matchAll(/id: ([a-z0-9-]+)/g)].map((m) => m[1]);
  const answering = groqAnswerOnly ?? asked;
  const list = [
    ...answering.map((id) => ({ id, holds: verdicts[id] === true })),
    ...groqExtraIds.map((id) => ({ id, holds: true })),
  ];
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdicts: list }) } }],
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...(groqRemainingTokens === null
          ? {}
          : {
              "x-ratelimit-remaining-tokens": groqRemainingTokens,
              "x-ratelimit-reset-tokens": groqResetTokens,
            }),
      },
    }
  );
}

function groqCalls() {
  return calls.filter((c) => c.host === "api.groq.com").length;
}

/** Serper hits, keyed by nothing: every query returns the same page of people. */
let serperPeople: { name: string; slug: string; snippet: string }[] = [];
/** Set to make the next N Serper calls fail, for the mid-tick failure cases. */
let serperFailures = 0;
let serperStatus = 500;

function serperBody() {
  return JSON.stringify({
    organic: serperPeople.map((p) => ({
      title: `${p.name} - LinkedIn`,
      link: `https://www.linkedin.com/in/${p.slug}`,
      snippet: p.snippet,
    })),
  });
}

function install() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).host;
    calls.push({ host, body: typeof init?.body === "string" ? init.body : undefined });

    if (host === "google.serper.dev") {
      if (serperFailures > 0) {
        serperFailures--;
        return new Response("upstream exploded", { status: serperStatus });
      }
      return new Response(serperBody(), { status: 200 });
    }

    if (host === "api.groq.com") return groqReply(init?.body as string | undefined);
    // Anything else is a call this harness did not expect to be made, and the
    // point of failing loudly here is that a paid call sneaking in is exactly
    // the bug class worth catching.
    return new Response(`unstubbed host ${host}`, { status: 599 });
  }) as typeof fetch;
}

/* ── Fixtures ───────────────────────────────────────────────────────────── */

/**
 * Wide enough for a plan of sixty-three, so a multi-day test exercises the day
 * counter rather than just running out of queries. One program and one college
 * yields three, which is how the first version of this file managed to assert the
 * wrong number twice and blame the engine.
 */
function selection(over: Partial<Selection> = {}): Selection {
  return {
    ...EMPTY_SELECTION,
    programs: ["RSI", "ISEF", "IMO"],
    colleges: ["Stanford", "MIT", "Harvard"],
    titles: ["Founder", "Researcher"],
    years: ["2028", "2029"],
    ...over,
  };
}

/** Deliberately narrow: three queries, so the plan runs out before the days do. */
function narrowSelection(): Selection {
  return { ...EMPTY_SELECTION, programs: ["RSI"], colleges: ["Stanford"] };
}

function people(n: number, prefix = "p") {
  return Array.from({ length: n }, (_, i) => ({
    name: `Person ${prefix}${i}`,
    slug: `${prefix}${i}-slug`,
    snippet: `RSI '24 and Stanford. Founder of something. ${i}`,
  }));
}

async function freshStore() {
  await del("zscore:team:campaigns");
  await del("zscore:team:people");
  await del("zscore:team:agent");
  await del(stateKey(OWNER));
  const team = await readTeam();
  await set(TEAM_KEY, { ...team, deleted: [] });
  calls = [];
  serperFailures = 0;
}

/** A search-only person with whatever prose a case needs. */
function personWith(slug: string, over: { headline?: string; about?: string; snippet?: string }): Person {
  return {
    slug,
    name: `Person ${slug}`,
    url: `https://www.linkedin.com/in/${slug}`,
    headline: over.headline ?? "",
    snippet: over.snippet ?? "",
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    searchLabels: [],
    ...(over.about
      ? {
          enriched: {
            slug,
            name: `Person ${slug}`,
            headline: over.headline ?? "",
            about: over.about,
            url: "",
            honors: [],
            projects: [],
            volunteering: [],
            educations: [],
            experience: [],
            skills: [],
            certifications: [],
            languages: [],
            publications: [],
            patents: [],
            courses: [],
            featured: [],
            recommendations: [],
            neighbors: [],
          },
        }
      : {}),
  } as unknown as Person;
}

function heldLabels(p: Person, team: Awaited<ReturnType<typeof readTeam>>) {
  return heldTags(p, team.taxonomy).map((t) => t.def.label);
}

function heldEvidence(p: Person, team: Awaited<ReturnType<typeof readTeam>>, label: string) {
  return heldTags(p, team.taxonomy).find((t) => t.def.label === label)?.evidence?.text;
}

async function marksFor(owner: ProfileId) {
  return hydrate(await get<Partial<ProfileState>>(stateKey(owner))).marks;
}

/* ── The run ────────────────────────────────────────────────────────────── */

async function main() {
  let backup: string | null = null;
  try {
    backup = await fs.readFile(STORE, "utf8");
  } catch {
    backup = null;
  }

  process.env.ZSCORE_APIFY_MOCK = "1";
  process.env.ZSCORE_SERPER_API_KEY = "test-key";
  /**
   * Generous per-minute limits for the bulk of the run.
   *
   * Not a way of dodging the pacer: the first version of this file ran into it with
   * real numbers and hung for minutes, which is the pacer working exactly as it
   * should. A test suite cannot wait out a sixty-second sliding window twenty times,
   * so the window is opened wide here and closed deliberately in the one block that
   * is about the limits, which uses the daily caps because those refuse immediately
   * instead of waiting.
   */
  process.env.ZSCORE_GROQ_RPM = "100000";
  process.env.ZSCORE_GROQ_TPM = "100000000";
  process.env.ZSCORE_GROQ_RPD = "100000";
  process.env.ZSCORE_GROQ_TPD = "100000000";
  install();

  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
    if (backup === null) await fs.rm(STORE, { force: true });
    else await fs.writeFile(STORE, backup);
  }

  console.log(
    failures === 0
      ? `\nAll ${total} agent checks passed.\n`
      : `\n${failures} of ${total} agent check(s) failed.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

async function run() {
  /* ── The stubs are the stubs ─────────────────────────────────────────── */
  console.log("\nthe harness pays for nothing");
  {
    await freshStore();
    serperPeople = people(3);
    const c = await createCampaign(OWNER, { name: "stub check", selection: selection(), queries: [], settings: { days: 1, enrichPerDay: 0 } });
    checkThat("a campaign is created", c.ok, JSON.stringify(c));
    if (c.ok) await tickCampaign(c.campaign.id, 20_000);
    checkThat("Serper was called", calls.some((x) => x.host === "google.serper.dev"));
    check(
      "and nothing else was",
      [...new Set(calls.map((x) => x.host))].filter((h) => h !== "google.serper.dev"),
      []
    );
  }

  /* ── Nothing to search ───────────────────────────────────────────────── */
  console.log("\na campaign with nothing to search says so, rather than running forever");
  {
    await freshStore();
    const empty = await createCampaign(OWNER, { name: "empty", selection: EMPTY_SELECTION, queries: [], settings: { days: 7 } });
    checkThat("an empty selection is refused outright", !empty.ok, JSON.stringify(empty));
    checkThat(
      "and the refusal says what to do about it",
      !empty.ok && /selection|query/i.test(empty.error),
      !empty.ok ? empty.error : "?"
    );

    // A blank name is refused too, rather than becoming a row nobody can pick out
    // of a list of twenty-five.
    const noName = await createCampaign(OWNER, { name: "   ", selection: selection(), settings: { days: 1 } });
    checkThat("a blank name is refused", !noName.ok, JSON.stringify(noName));

    /**
     * The narrow case is the one that has to end gracefully: a real selection whose
     * plan is shorter than the schedule. It runs what it has and finishes on the
     * plan rather than the day count, which is why `plannedQueries` is in the create
     * response at all.
     */
    const narrow = await createCampaign(OWNER, {
      name: "narrow",
      selection: narrowSelection(),
      settings: { days: 7, searchesPerDay: 100, enrichPerDay: 0 },
    });
    checkThat("a narrow selection creates", narrow.ok, JSON.stringify(narrow));
    if (narrow.ok) {
      check("with a small plan", narrow.plannedQueries, 3);
      checkThat(
        "and a warning that the schedule will not fill",
        narrow.warnings.length > 0,
        JSON.stringify(narrow.warnings)
      );
      const first = await tickCampaign(narrow.campaign.id, 20_000);
      check("the first advance runs the whole plan", first.campaign.queryCursor, 3);
      const stored = await readCampaign(narrow.campaign.id);
      await writeCampaignDirect({ ...stored!, lastTickDay: "2000-01-01" });
      const second = await tickCampaign(narrow.campaign.id, 20_000);
      check("and the next one finishes it", second.campaign.status, "done");
      checkThat(
        "on the plan, not the days",
        /ran out of queries/.test(second.campaign.finishedReason ?? ""),
        second.campaign.finishedReason
      );
    }
  }

  /* ── The day counter ─────────────────────────────────────────────────── */
  console.log("\nthe day moves once a day, however often it is poked");
  {
    await freshStore();
    serperPeople = people(4, "day");
    const made = await createCampaign(OWNER, { name: "days", selection: selection(), queries: [], settings: {
      days: 3,
      searchesPerDay: 2,
      queuePerDay: 2,
      enrichPerDay: 0,
    } });
    if (!(made.ok)) throw new Error("setup");
    const id = made.campaign.id;

    const one = await tickCampaign(id, 20_000);
    check("the first advance is day 1", one.campaign.day, 1);
    check("and it ran the day's quota", one.campaign.searchedToday, 2);

    const two = await tickCampaign(id, 20_000);
    check("advancing again does not move the day", two.campaign.day, 1);
    check("nor run more searches", two.campaign.searchedToday, 2);
    checkThat("and says the day is spent", /already done/.test(two.note ?? ""), two.note);

    // Rolling the stored date back is the only way to reach tomorrow in a test,
    // and it is exactly what the cron does at midnight.
    const stored = await readCampaign(id);
    if (!stored) throw new Error("gone");
    const rolled: Campaign = { ...stored, lastTickDay: "2000-01-01" };
    await writeCampaignDirect(rolled);
    const three = await tickCampaign(id, 20_000);
    check("a new UTC date moves the day", three.campaign.day, 2);
    check("and resets the day's counters", three.campaign.searchedToday, 2);
  }

  /* ── The lock ────────────────────────────────────────────────────────── */
  console.log("\ntwo advances at once is one advance");
  {
    await freshStore();
    serperPeople = people(4, "lock");
    const made = await createCampaign(OWNER, { name: "lock", selection: selection(), queries: [], settings: {
      days: 2,
      searchesPerDay: 4,
      enrichPerDay: 0,
    } });
    if (!(made.ok)) throw new Error("setup");
    const [a, b] = await Promise.all([
      tickCampaign(made.campaign.id, 20_000),
      tickCampaign(made.campaign.id, 20_000),
    ]);
    const refused = [a, b].filter((r) => /already running/i.test(r.note ?? ""));
    check("exactly one is refused", refused.length, 1);
    const after = await readCampaign(made.campaign.id);
    check("and only one day's queries were charged", after?.searchedToday, 4);
  }

  /* ── The ceiling ─────────────────────────────────────────────────────── */
  console.log("\nthe ceiling is a ceiling");
  {
    await freshStore();
    serperPeople = people(2, "cap");
    const made = await createCampaign(OWNER, { name: "cap", selection: selection(), queries: [], settings: {
      days: 30,
      searchesPerDay: 5,
      enrichPerDay: 0,
      budgetUsd: 0.003,
    } });
    if (!(made.ok)) throw new Error("setup");
    const t = await tickCampaign(made.campaign.id, 20_000);
    checkThat(
      "spend never exceeds the ceiling by more than one chunk",
      t.campaign.spentUsd <= 0.003 + 25 * 0.001,
      String(t.campaign.spentUsd)
    );
    const again = await tickCampaign(made.campaign.id, 20_000);
    check("and the next advance finds it finished", again.campaign.status, "done");
    checkThat(
      "on the ceiling",
      /dollar ceiling/.test(again.campaign.finishedReason ?? ""),
      again.campaign.finishedReason
    );
    check("with no room left", budgetLeft(again.campaign), 0);
  }

  /* ── The score bar ───────────────────────────────────────────────────── */
  console.log("\na bar nobody clears queues nobody, and still says what it saw");
  {
    await freshStore();
    serperPeople = people(5, "bar");
    const made = await createCampaign(OWNER, { name: "bar", selection: selection(), queries: [], settings: {
      days: 1,
      searchesPerDay: 2,
      enrichPerDay: 0,
      scoreBar: 19,
    } });
    if (!(made.ok)) throw new Error("setup");
    const t = await tickCampaign(made.campaign.id, 20_000);
    check("nobody is queued", t.campaign.foundCount, 0);
    checkThat("but the queries were run", (t.tick?.queries ?? 0) > 0, JSON.stringify(t.tick));
    checkThat("and the hits were seen", (t.tick?.hits ?? 0) > 0, JSON.stringify(t.tick));
  }

  /* ── What an unattended loop must refuse ─────────────────────────────── */
  console.log("\nan unattended loop does not undo a human");
  {
    await freshStore();
    serperPeople = people(3, "erase");
    const team = await readTeam();
    await set(TEAM_KEY, { ...team, deleted: ["erase0-slug"] });

    const made = await createCampaign(OWNER, { name: "refuse", selection: selection(), queries: [], settings: {
      days: 1,
      searchesPerDay: 1,
      enrichPerDay: 0,
    } });
    if (!(made.ok)) throw new Error("setup");
    const t = await tickCampaign(made.campaign.id, 20_000);
    check("a permanently deleted person is not re-added", t.campaign.found.includes("erase0-slug"), false);
    checkThat("but the others are", t.campaign.found.length > 0, JSON.stringify(t.campaign.found));

    // Now reject one of them by hand and advance again on a fresh day.
    const marks = await marksFor(OWNER);
    const victim = t.campaign.found[0];
    await set(stateKey(OWNER), {
      ...(await get<Partial<ProfileState>>(stateKey(OWNER))),
      marks: { ...marks, [victim]: { ...(marks[victim] ?? {}), status: "rejected" } },
    });
    const stored = await readCampaign(made.campaign.id);
    if (!stored) throw new Error("gone");
    await writeCampaignDirect({
      ...stored,
      lastTickDay: "2000-01-01",
      settings: { ...stored.settings, days: 2 },
      queryCursor: 0,
    });
    await tickCampaign(made.campaign.id, 20_000);
    const after = await marksFor(OWNER);
    check("a rejection is not revived", after[victim]?.status, "rejected");
  }

  /* ── Stopped, deleted, revived ───────────────────────────────────────── */
  console.log("\nstopping, deleting and reviving");
  {
    await freshStore();
    serperPeople = people(2, "stop");
    const made = await createCampaign(OWNER, { name: "stop", selection: selection(), queries: [], settings: {
      days: 5,
      searchesPerDay: 1,
      enrichPerDay: 0,
    } });
    if (!(made.ok)) throw new Error("setup");
    const id = made.campaign.id;

    const del1 = await deleteCampaign(id, OWNER);
    checkThat("a running campaign refuses to be deleted", !del1.ok, JSON.stringify(del1));

    const stopped = await stopCampaign(id, OWNER, "by hand");
    check("stopping works", stopped.ok ? stopped.campaign.status : "?", "stopped");
    const afterStop = await tickCampaign(id, 20_000);
    checkThat("and advancing a stopped campaign does nothing", /stopped/.test(afterStop.note ?? ""), afterStop.note);
    check("having spent nothing more", afterStop.campaign.spentUsd, 0);

    const stopAgain = await stopCampaign(id, OWNER, "again");
    checkThat("stopping twice is not an error", stopAgain.ok, JSON.stringify(stopAgain));

    const del2 = await deleteCampaign(id, OWNER);
    checkThat("a stopped campaign deletes", del2.ok, JSON.stringify(del2));
    check("and is gone", await readCampaign(id), null);
  }

  console.log("\nraising a limit on a finished campaign brings it back");
  {
    await freshStore();
    serperPeople = people(2, "revive");
    const made = await createCampaign(OWNER, { name: "revive", selection: selection(), queries: [], settings: {
      days: 1,
      searchesPerDay: 1,
      enrichPerDay: 0,
    } });
    if (!(made.ok)) throw new Error("setup");
    const id = made.campaign.id;
    await tickCampaign(id, 20_000);
    const stored = await readCampaign(id);
    await writeCampaignDirect({ ...stored!, lastTickDay: "2000-01-01" });
    const done = await tickCampaign(id, 20_000);
    check("it finishes on its day count", done.campaign.status, "done");

    const raised = await updateCampaign(id, OWNER, { days: 4 });
    checkThat("raising the days revives it", raised.ok && raised.campaign.status === "running", JSON.stringify(raised));
    check(
      "and clears the stale reason",
      raised.ok ? raised.campaign.finishedReason : "?",
      undefined
    );

    // A used-up query plan is not refilled by any number, so the reason updates
    // rather than the campaign reviving on a lie.
    const cursorAtEnd = await readCampaign(id);
    await writeCampaignDirect({ ...cursorAtEnd!, queryCursor: 99999, status: "done", finishedReason: "ran its full 1 day" });
    const reraised = await updateCampaign(id, OWNER, { days: 9 });
    checkThat(
      "an exhausted plan stays finished",
      reraised.ok && reraised.campaign.status === "done",
      JSON.stringify(reraised)
    );
    checkThat(
      "with the reason it is actually stuck on",
      reraised.ok && /ran out of queries/.test(reraised.campaign.finishedReason ?? ""),
      reraised.ok ? reraised.campaign.finishedReason : "?"
    );
  }

  /* ── Ownership and concurrency of campaigns ──────────────────────────── */
  console.log("\none running campaign, and only its owner may change it");
  {
    await freshStore();
    serperPeople = people(1, "own");
    const first = await createCampaign(OWNER, { name: "first", selection: selection(), queries: [], settings: { days: 3, enrichPerDay: 0 } });
    if (!(first.ok)) throw new Error("setup");
    const second = await createCampaign(OWNER, { name: "second", selection: selection(), queries: [], settings: { days: 3, enrichPerDay: 0 } });
    checkThat("a second running campaign is refused", !second.ok, JSON.stringify(second));

    const byOther = await updateCampaign(first.campaign.id, OTHER, { days: 9 });
    checkThat("a teammate cannot change the settings", !byOther.ok, JSON.stringify(byOther));
    const stopByOther = await stopCampaign(first.campaign.id, OTHER, "nope");
    checkThat("nor stop it", !stopByOther.ok, JSON.stringify(stopByOther));
  }

  /* ── Hostile and degenerate input ────────────────────────────────────── */
  console.log("\ndegenerate input is clamped, not obeyed");
  {
    await freshStore();
    serperPeople = people(1, "clamp");
    const made = await createCampaign(OWNER, { name: "clamp", selection: selection(), queries: [], settings: {
      days: 9999,
      searchesPerDay: -5,
      queuePerDay: 0,
      enrichPerDay: 10_000,
      budgetUsd: -1,
      scoreBar: 999,
    } });
    checkThat("it still creates", made.ok, JSON.stringify(made));
    if (made.ok) {
      const s = made.campaign.settings;
      check("days clamped to the maximum", s.days, 30);
      check("searches to the minimum", s.searchesPerDay, 1);
      check("queue to the minimum", s.queuePerDay, 1);
      check("enrichment to the maximum", s.enrichPerDay, 100);
      check("budget to the floor", s.budgetUsd, 0);
      check("the bar to the ceiling", s.scoreBar, 20);
    }
  }

  console.log("\na wall of queries is bounded");
  {
    await freshStore();
    serperPeople = people(1, "many");
    const huge = Array.from({ length: 500 }, (_, i) => `"query number ${i}"`);
    const made = await createCampaign(OWNER, { name: "huge", selection: EMPTY_SELECTION, queries: huge, settings: { days: 1, enrichPerDay: 0 } });
    if (!(made.ok)) throw new Error("setup");
    checkThat(
      "the stored query list is capped",
      made.campaign.queries.length <= 50,
      String(made.campaign.queries.length)
    );
  }

  /* ── A failing search ────────────────────────────────────────────────── */
  console.log("\na failing search is a note, not a crash");
  {
    await freshStore();
    serperPeople = people(2, "fail");
    const made = await createCampaign(OWNER, { name: "fail", selection: selection(), queries: [], settings: {
      days: 1,
      searchesPerDay: 3,
      enrichPerDay: 0,
    } });
    if (!(made.ok)) throw new Error("setup");
    serperFailures = 99;
    const t = await tickCampaign(made.campaign.id, 20_000);
    checkThat("the tick returns", t.campaign.id === made.campaign.id);
    checkThat("with a note about the failure", (t.tick?.note ?? "").length > 0, JSON.stringify(t.tick?.note));
    check("nobody was queued", t.campaign.foundCount, 0);
    checkThat(
      "and the cursor still moved, because the queries were paid for",
      t.campaign.queryCursor > 0,
      String(t.campaign.queryCursor)
    );
    serperFailures = 0;
  }

  /* ── The campaign list is bounded ────────────────────────────────────── */
  console.log("\nthe campaign list is bounded");
  {
    await freshStore();
    serperPeople = people(1, "cap2");
    for (let i = 0; i < MAX_CAMPAIGNS + 4; i++) {
      const made = await createCampaign(OWNER, { name: `c${i}`, selection: selection(), queries: [], settings: { days: 1, enrichPerDay: 0 } });
      if (made.ok) await stopCampaign(made.campaign.id, OWNER, "make room");
    }
    const all = await listCampaigns();
    checkThat("never more than the cap", all.length <= MAX_CAMPAIGNS, String(all.length));
  }

  /* ── terminalReason, exhaustively ────────────────────────────────────── */
  console.log("\nterminalReason answers for every way a campaign can end");
  {
    const base = {
      day: 1,
      settings: { days: 3, searchesPerDay: 1, queuePerDay: 1, enrichPerDay: 0, budgetUsd: 1, scoreBar: 0 },
      spentUsd: 0,
      queryCursor: 0,
    } as unknown as Campaign;
    check("mid-run is not terminal", terminalReason(base, 10), null);
    check("day past the count is", /full 3 days/.test(terminalReason({ ...base, day: 4 }, 10) ?? ""), true);
    check("one day reads singular", /full 1 day\b/.test(terminalReason({ ...base, day: 2, settings: { ...base.settings, days: 1 } }, 10) ?? ""), true);
    check("spend at the ceiling is", /ceiling/.test(terminalReason({ ...base, spentUsd: 1 }, 10) ?? ""), true);
    check("spend over it is too", /ceiling/.test(terminalReason({ ...base, spentUsd: 2 }, 10) ?? ""), true);
    check("no ceiling never ends on spend", terminalReason({ ...base, spentUsd: 999, settings: { ...base.settings, budgetUsd: 0 } }, 10), null);
    check("cursor at the plan's end is", /ran out of queries/.test(terminalReason({ ...base, queryCursor: 10 }, 10) ?? ""), true);
    check("an empty plan is immediately", /ran out of queries/.test(terminalReason(base, 0) ?? ""), true);
  }

  /* ── Enrichment ──────────────────────────────────────────────────────── */
  console.log("\nenrichment: paid once, collected before anything new is started");
  {
    await freshStore();
    serperPeople = people(6, "enr");
    const made = await createCampaign(OWNER, {
      name: "enrich",
      selection: selection(),
      settings: { days: 2, searchesPerDay: 2, queuePerDay: 6, enrichPerDay: 3 },
    });
    if (!made.ok) throw new Error("setup");
    const id = made.campaign.id;

    const t = await tickCampaign(id, 30_000);
    checkThat("people were queued", t.campaign.foundCount > 0, String(t.campaign.foundCount));
    check("and enriched, up to the day's cap", t.campaign.enrichedToday, 3);
    check("the run landed inside the tick", t.campaign.pendingJobId, null);
    checkThat("the report has rows", t.campaign.top.length > 0, String(t.campaign.top.length));

    /**
     * The mock is free, so a mocked run must not move the spend. Otherwise every
     * test of a budget ceiling is measuring the harness.
     */
    check("a mocked run costs nothing", t.campaign.spentUsd, t.campaign.queryCursor * 0.001);

    // Same day again: the cap is spent, so no second run.
    const again = await tickCampaign(id, 30_000);
    check("the daily enrichment cap holds within a day", again.campaign.enrichedToday, 3);
  }

  console.log("\na pending run is drained before new work, and a lost one is dropped");
  {
    await freshStore();
    serperPeople = people(4, "pend");
    const made = await createCampaign(OWNER, {
      name: "pending",
      selection: selection(),
      settings: { days: 3, searchesPerDay: 1, queuePerDay: 4, enrichPerDay: 2 },
    });
    if (!made.ok) throw new Error("setup");
    const id = made.campaign.id;
    await tickCampaign(id, 30_000);

    /**
     * A job id pointing at nothing is the shape of a crash between starting a run
     * and writing the job. It must be dropped with a note rather than pinning the
     * campaign on a run that will never land.
     */
    const stored = await readCampaign(id);
    await writeCampaignDirect({ ...stored!, pendingJobId: "job_does_not_exist", lastTickDay: "2000-01-01" });
    const t = await tickCampaign(id, 30_000);
    check("an unreadable job is dropped", t.campaign.pendingJobId, null);
    checkThat("with a note", /could not be read/.test(t.tick?.note ?? ""), t.tick?.note);
    checkThat("and the tick still did its day's work", (t.tick?.queries ?? 0) > 0, JSON.stringify(t.tick));
  }

  console.log("\nenrichment never outruns the budget or the per-run ceiling");
  {
    await freshStore();
    serperPeople = people(20, "room");
    // A ceiling that leaves room for the queries and nothing else.
    const made = await createCampaign(OWNER, {
      name: "tight",
      selection: selection(),
      settings: { days: 1, searchesPerDay: 1, queuePerDay: 20, enrichPerDay: 50, budgetUsd: 0.002 },
    });
    if (!made.ok) throw new Error("setup");
    const t = await tickCampaign(made.campaign.id, 30_000);
    checkThat(
      "a ceiling with no room for a profile enriches nobody",
      t.campaign.enrichedToday === 0,
      String(t.campaign.enrichedToday)
    );

    await freshStore();
    serperPeople = people(30, "run");
    const big = await createCampaign(OWNER, {
      name: "big",
      selection: selection(),
      settings: { days: 1, searchesPerDay: 1, queuePerDay: 30, enrichPerDay: 100, budgetUsd: 0 },
    });
    if (!big.ok) throw new Error("setup");
    const bt = await tickCampaign(big.campaign.id, 30_000);
    /**
     * A free Apify account refuses a run over ten items and bills for it anyway, so
     * this is a money bound and not a throughput one. It was 250 by default, which
     * meant raising enrichPerDay on the Agent screen — allowed up to 100 — bought a
     * refused run every night until the tick's own error handler clamped it.
     */
    checkThat(
      "and one tick never starts a run above the vendor's per-run cap",
      bt.campaign.enrichedToday <= MAX_PROFILES_PER_RUN,
      `${bt.campaign.enrichedToday} > ${MAX_PROFILES_PER_RUN}`
    );
    check("which defaults to what a free account allows", MAX_PROFILES_PER_RUN, 10);
  }

  /* ── Deadlines ───────────────────────────────────────────────────────── */
  console.log("\na tick that runs out of time leaves a consistent campaign");
  {
    await freshStore();
    serperPeople = people(3, "clock");
    const made = await createCampaign(OWNER, {
      name: "clock",
      selection: selection(),
      settings: { days: 1, searchesPerDay: 60, queuePerDay: 10, enrichPerDay: 0 },
    });
    if (!made.ok) throw new Error("setup");
    // Zero budget: the deadline is already past on the first check.
    const t = await tickCampaign(made.campaign.id, 0);
    check("it does not throw", t.campaign.id, made.campaign.id);
    check("and charges for nothing it did not run", t.campaign.spentUsd, t.campaign.queryCursor * 0.001);
    checkThat(
      "leaving the cursor no further than the searches it counted",
      t.campaign.queryCursor === t.campaign.searchedToday,
      `${t.campaign.queryCursor} vs ${t.campaign.searchedToday}`
    );
  }

  /* ── The report ──────────────────────────────────────────────────────── */
  console.log("\nthe report survives a person being evicted from the roster");
  {
    await freshStore();
    serperPeople = people(4, "rep");
    const made = await createCampaign(OWNER, {
      name: "report",
      selection: selection(),
      settings: { days: 1, searchesPerDay: 1, queuePerDay: 4, enrichPerDay: 0 },
    });
    if (!made.ok) throw new Error("setup");
    await tickCampaign(made.campaign.id, 20_000);

    const ran = await readCampaign(made.campaign.id);
    const before = await buildReport(ran!, 10);
    checkThat("the report has rows", before.length > 0, String(before.length));

    // Evict everybody: the snapshot is all that is left.
    await del("zscore:team:people");
    const after = await buildReport(ran!, 10);
    check("and keeps them after eviction", after.length, before.length);
    checkThat(
      "marking them as no longer in the roster",
      after.every((r) => r.evicted === true),
      JSON.stringify(after.map((r) => r.evicted))
    );
  }

  /* ── The LLM step ────────────────────────────────────────────────────── */
  console.log("\nthe tagger inside a tick stays inside its limits");
  {
    await freshStore();
    const savedKey = process.env.ZSCORE_GROQ_API_KEY;
    const savedAlt = process.env.GROQ_API_KEY;
    delete process.env.ZSCORE_GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    check("with no key the tagger is off", hasGroq(), false);
    calls = [];
    const off = await tagFresh(OWNER, ["nobody"], Date.now() + 5_000);
    check("and tags nothing", off.tagged, 0);
    check("without calling anything", calls.length, 0);
    checkThat("saying why", /tagger is off/.test(off.note ?? ""), off.note);
    if (savedKey) process.env.ZSCORE_GROQ_API_KEY = savedKey;
    if (savedAlt) process.env.GROQ_API_KEY = savedAlt;
  }

  console.log("\nadjudication asks only about what the rules could not settle");
  {
    await freshStore();
    process.env.ZSCORE_GROQ_API_KEY = "test-key";
    const team = await readTeam();

    // "the rise of transformers" names Rise, which is `qualified`, with nothing in
    // the clause to vouch for it. That is the whole candidate set.
    const ambiguous = personWith("amb", { about: "contributed to the rise of transformers in vision" });
    // "Selected as a Rise Global winner" vouches for itself, so it is not a candidate.
    const clear = personWith("clear", { about: "Selected as a Rise winner in 2025" });
    // A name that is never read from prose is never a candidate either: no amount of
    // context turns the word benchmark in a paper title into the fund.
    const never = personWith("never", { about: "EnDive: A Cross-Dialect Benchmark for Fairness" });
    await writePeople([ambiguous, clear, never]);

    check("an ambiguous match is a candidate", unvouchedTags(ambiguous, team.taxonomy).map((u) => u.id), ["rise"]);
    check("a vouched one is not", unvouchedTags(clear, team.taxonomy).length, 0);
    check("and a structured-only name is not", unvouchedTags(never, team.taxonomy).length, 0);
    checkThat(
      "the candidate carries the words and their context",
      unvouchedTags(ambiguous, team.taxonomy)[0]?.span.toLowerCase() === "rise" &&
        /transformers/.test(unvouchedTags(ambiguous, team.taxonomy)[0]?.context ?? ""),
      JSON.stringify(unvouchedTags(ambiguous, team.taxonomy)[0])
    );

    // Unadjudicated, the tag does not score. That is the conservative answer and the
    // one the rules already gave.
    check("and it does not score until judged", heldLabels(ambiguous, team).includes("Rise"), false);
  }

  console.log("\na verdict is asked once, respected, and cached");
  {
    await freshStore();
    const team = await readTeam();
    const p1 = personWith("v1", { about: "contributed to the rise of transformers" });
    const p2 = personWith("v2", { about: "worked on the twin primes conjecture" });
    await writePeople([p1, p2]);

    verdicts = { rise: false, "mit-primes": false };
    calls = [];
    const r = await adjudicateFresh(OWNER, ["v1", "v2"], Date.now() + 30_000);
    check("one call per person", groqCalls(), 2);
    check("both verdicts recorded", r.judged, 2);
    check("neither approved", r.approved, 0);

    const roster = await readRoster();
    check("a no is stored as a no", roster["v1"]?.adjudicated?.rise, false);
    check("and the tag still does not score", heldLabels(roster["v1"]!, team).includes("Rise"), false);

    /**
     * The cache is the difference between paying once and paying on every pass. A
     * `false` has to be kept for that: an absent key means "not yet asked".
     */
    calls = [];
    const again = await adjudicateFresh(OWNER, ["v1", "v2"], Date.now() + 30_000);
    check("asking again costs nothing", groqCalls(), 0);
    check("and judges nothing", again.judged, 0);
  }

  console.log("\na yes makes the tag score, and only for the person it was about");
  {
    await freshStore();
    const team = await readTeam();
    const yes = personWith("yes", { about: "contributed to the rise of transformers" });
    const other = personWith("other", { about: "contributed to the rise of transformers" });
    await writePeople([yes, other]);

    verdicts = { rise: true };
    await adjudicateFresh(OWNER, ["yes"], Date.now() + 30_000);
    const roster = await readRoster();
    check("the judged person holds it", heldLabels(roster["yes"]!, team).includes("Rise"), true);
    check("with the words that produced it", heldEvidence(roster["yes"]!, team, "Rise")?.toLowerCase(), "rise");
    check("and the unjudged one does not", heldLabels(roster["other"]!, team).includes("Rise"), false);
  }

  console.log("\nthe model cannot switch on a tag nobody asked about");
  {
    await freshStore();
    const team = await readTeam();
    const p = personWith("halluc", { about: "contributed to the rise of transformers" });
    await writePeople([p]);

    verdicts = { rise: false };
    groqExtraIds = ["z-fellow", "y-combinator", "rsi"];
    await adjudicateFresh(OWNER, ["halluc"], Date.now() + 30_000);
    groqExtraIds = [];
    const roster = await readRoster();
    check("ids nobody asked about are dropped", Object.keys(roster["halluc"]?.adjudicated ?? {}), ["rise"]);
    check("so the invented ones do not score", heldLabels(roster["halluc"]!, team).includes("Z Fellow"), false);
  }

  console.log("\na candidate the model ignores is recorded as a no, not re-asked");
  {
    await freshStore();
    const p = personWith("silent", {
      about: "contributed to the rise of transformers and the twin primes conjecture",
    });
    await writePeople([p]);

    verdicts = {};
    groqAnswerOnly = ["rise"];
    await adjudicateFresh(OWNER, ["silent"], Date.now() + 30_000);
    groqAnswerOnly = null;
    const roster = await readRoster();
    const decided = roster["silent"]?.adjudicated ?? {};
    checkThat(
      "every candidate asked about gets an answer",
      "rise" in decided && "mit-primes" in decided,
      JSON.stringify(decided)
    );
    calls = [];
    await adjudicateFresh(OWNER, ["silent"], Date.now() + 30_000);
    check("so nothing is asked twice", groqCalls(), 0);
  }

  /* ── The limits ──────────────────────────────────────────────────────── */
  console.log("\nadjudication cannot outrun its limits");
  {
    await freshStore();
    // More people than one invocation may take, each with a candidate.
    const many = Array.from({ length: 12 }, (_, i) =>
      personWith(`lim${i}`, { about: "contributed to the rise of transformers" })
    );
    await writePeople(many);
    verdicts = { rise: false };

    calls = [];
    await adjudicateFresh(
      OWNER,
      many.map((p) => p.slug),
      Date.now() + 30_000
    );
    check("one invocation makes at most CHUNK calls", groqCalls(), 4);

    // And a person with a wall of candidates is one call, not one per candidate.
    await freshStore();
    const crowded = personWith("crowd", {
      about:
        "the rise of transformers, twin primes, IMU accel and gyro, on the contrary, " +
        "Sequoia National Park, a mop, SPARC Solaris, drank a Coke, IBO diploma candidate",
    });
    await writePeople([crowded]);
    const team2 = await readTeam();
    const candidates = unvouchedTags(crowded, team2.taxonomy);
    checkThat("candidates are capped per person", candidates.length <= MAX_UNVOUCHED, String(candidates.length));
    calls = [];
    await adjudicateFresh(OWNER, ["crowd"], Date.now() + 30_000);
    check("and judged in a single call", groqCalls(), 1);
  }

  console.log("\na 429 is retried, bounded, and a 400 is not retried at all");
  {
    await freshStore();
    const p = personWith("retry", { about: "contributed to the rise of transformers" });
    await writePeople([p]);
    verdicts = { rise: true };

    // Two refusals then success: the ladder rides it out.
    calls = [];
    groqStatus = 429;
    groqRetryAfter = "0";
    groqFailures = 2;
    const ok = await adjudicateFresh(OWNER, ["retry"], Date.now() + 30_000);
    check("a transient refusal is retried", ok.judged, 1);
    check("three attempts, not more", groqCalls(), 3);

    /**
     * The one that matters for a loop nobody is watching: a permanent 429 must stop,
     * not hammer. chatJson allows five attempts and then gives up.
     */
    await freshStore();
    await writePeople([personWith("storm", { about: "contributed to the rise of transformers" })]);
    calls = [];
    groqFailures = 99;
    const gaveUp = await adjudicateFresh(OWNER, ["storm"], Date.now() + 30_000);
    check("a permanent refusal gives up", gaveUp.judged, 0);
    check("after a bounded number of attempts", groqCalls(), 5);
    const stormRoster = await readRoster();
    check(
      "recording no verdict, so it is retried later rather than wrongly denied",
      stormRoster["storm"]?.adjudicated,
      undefined
    );

    // A 400 is the model's fault, not the clock's, and repeating it is waste.
    await freshStore();
    await writePeople([personWith("bad", { about: "contributed to the rise of transformers" })]);
    calls = [];
    groqStatus = 400;
    groqFailures = 99;
    const notRetried = await adjudicateFresh(OWNER, ["bad"], Date.now() + 30_000);
    check("a bad request is not retried", groqCalls(), 1);
    check("and judges nothing", notRetried.judged, 0);
    groqStatus = 429;
    groqFailures = 0;
  }

  console.log("\na spent daily cap stops the call before it is made");
  {
    await freshStore();
    await writePeople([personWith("daily", { about: "contributed to the rise of transformers" })]);
    verdicts = { rise: true };

    /**
     * The property that matters for an unattended loop: a cap that cannot be waited
     * out inside one request must not be waited on, and must not be retried. The
     * ledger has already counted this run's calls, so a cap of one is spent.
     */
    process.env.ZSCORE_GROQ_RPD = "1";
    calls = [];
    const capped = await adjudicateFresh(OWNER, ["daily"], Date.now() + 30_000);
    check("the request cap stops it before the network", groqCalls(), 0);
    check("and it judges nothing", capped.judged, 0);
    const roster = await readRoster();
    check("recording no verdict, so it is asked again tomorrow", roster["daily"]?.adjudicated, undefined);

    process.env.ZSCORE_GROQ_RPD = "100000";
    process.env.ZSCORE_GROQ_TPD = "1";
    calls = [];
    const tokenCapped = await adjudicateFresh(OWNER, ["daily"], Date.now() + 30_000);
    check("the token cap does the same", groqCalls(), 0);
    check("judging nothing", tokenCapped.judged, 0);
    process.env.ZSCORE_GROQ_TPD = "100000000";

    // And with the caps restored it goes through, so the block above proved the cap
    // and not some other breakage.
    calls = [];
    const fine = await adjudicateFresh(OWNER, ["daily"], Date.now() + 30_000);
    check("with room again it works", fine.judged, 1);
    check("in one call", groqCalls(), 1);
  }

  console.log("\nthe pacer books what the response says somebody else has spent");
  {
    await freshStore();
    await writePeople([personWith("pace1", { about: "contributed to the rise of transformers" })]);
    verdicts = { rise: true };

    /**
     * The reconciliation path, which is what makes the pacer safe when the same key
     * is in use elsewhere: the response says none of the minute is left, and the
     * ledger books the difference so the *next* call waits rather than being refused.
     *
     * A missing header used to take this same branch, because `Number(null)` is 0 and
     * 0 is finite — so one ordinary response booked the whole minute and the next call
     * slept for it. That is why the reset is short here: the wait is real and measured,
     * and it should be a quarter of a second rather than sixty.
     */
    process.env.ZSCORE_GROQ_TPM = "4000";
    groqRemainingTokens = "0";
    groqResetTokens = "250ms";
    calls = [];
    const began = Date.now();
    const paced = await adjudicateFresh(OWNER, ["pace1"], Date.now() + 90_000);
    const took = Date.now() - began;
    groqRemainingTokens = null;
    process.env.ZSCORE_GROQ_TPM = "100000000";

    /**
     * One person, because the ledger is process-wide and every block above this one
     * has already put entries in it. Counting calls against a shared minute would be
     * measuring the order of this file rather than the pacer.
     */
    check("the work still gets done", paced.judged, 1);
    checkThat("having waited for room rather than being refused", took >= 200, `${took}ms`);
  }

  console.log("\nthe app's own hourly cap gates it too");
  {
    await freshStore();
    await writePeople([personWith("hourly", { about: "contributed to the rise of transformers" })]);
    verdicts = { rise: true };

    /**
     * `reserveTagging` is the app's cap, separate from Groq's and counted per profile
     * per hour. Adjudication charges one unit per person, which is also one call per
     * person, so the unit means something. Burning it here proves the gate is in the
     * path rather than assumed.
     */
    // Burn until refused rather than asking for the whole cap in one go: earlier
    // blocks in this file have already spent some of the hour.
    for (let i = 0; i < 20; i++) {
      const r = await reserveTagging(OWNER, Math.ceil(HOURLY_TAG_CAP / 4));
      if (!r.ok) break;
    }
    calls = [];
    const gated = await adjudicateFresh(OWNER, ["hourly"], Date.now() + 30_000);
    check("a spent hourly cap makes no call", groqCalls(), 0);
    checkThat("and says which cap it was", /paused/i.test(gated.note ?? ""), gated.note);
  }

  console.log("\nadjudication is gated the same three ways tagging is");
  {
    await freshStore();
    await writePeople([personWith("gate", { about: "contributed to the rise of transformers" })]);

    const savedKey = process.env.ZSCORE_GROQ_API_KEY;
    delete process.env.ZSCORE_GROQ_API_KEY;
    calls = [];
    const off = await adjudicateFresh(OWNER, ["gate"], Date.now() + 30_000);
    check("no key, no calls", groqCalls(), 0);
    checkThat("and it says so", /tagger is off/.test(off.note ?? ""), off.note);
    process.env.ZSCORE_GROQ_API_KEY = savedKey;

    // A deadline already past means the reservation is taken but no call is made.
    calls = [];
    const late = await adjudicateFresh(OWNER, ["gate"], Date.now() - 1);
    check("an expired deadline makes no call", groqCalls(), 0);
    check("and judges nothing", late.judged, 0);

    // Nobody with a candidate means no reservation and no call.
    calls = [];
    const nothing = await adjudicateFresh(OWNER, ["does-not-exist"], Date.now() + 30_000);
    check("an unknown slug costs nothing", groqCalls(), 0);
    check("and judges nothing", nothing.judged, 0);
  }

  console.log("\nan empty target list costs nothing");
  {
    calls = [];
    const none = await tagFresh(OWNER, [], Date.now() + 5_000);
    check("no slugs, no work", none.tagged, 0);
    check("and no calls", calls.length, 0);
  }

  /* ── utcDay ──────────────────────────────────────────────────────────── */
  console.log("\nthe day is a UTC date, not a local one");
  {
    checkThat("utcDay is a plain date", /^\d{4}-\d{2}-\d{2}$/.test(utcDay()), utcDay());
    check("and matches the ISO prefix", utcDay(), new Date().toISOString().slice(0, 10));
  }
}

/**
 * Write a campaign straight to the hash.
 *
 * The engine has no "pretend it is tomorrow" seam, and it should not: the day
 * counter reading the real UTC date is the property that makes two ticks safe.
 * So the tests that need tomorrow edit the stored row, which is exactly what the
 * passage of midnight looks like from the engine's side.
 */
async function writeCampaignDirect(c: Campaign) {
  const { hset } = await import("../lib/store");
  await hset("zscore:team:campaigns", { [c.id]: c });
}

void main();
