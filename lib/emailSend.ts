import { scoreOne } from "./candidates";
import type { Campaign } from "./campaign";
import { buildReport, listCampaigns, writeCampaign } from "./campaignRun";
import { emailOrigin, hasEmail, trySend } from "./email";
import { renderCampaignReport, renderQueueDigest } from "./emailDigest";
import { PROFILES, type ProfileId } from "./profiles";
import { readRoster, readTeam } from "./serverState";
import { digestDue, hydrate, mergeState, stateKey, type ProfileState } from "./state";
import { get, set } from "./store";
import { log } from "./log";

/**
 * Deciding who gets mail, and making sure they get it once.
 *
 * Kept apart from `lib/email.ts`, which only knows how to put a message on the wire,
 * and from `lib/emailDigest.ts`, which only knows how to render one. This is the
 * part that reads state and writes it back, and it is the part where the bugs live.
 *
 * ── Two different clocks ──────────────────────────────────────────────────
 * A campaign report is an *event*: it happens once, when a campaign finishes, and
 * the only question is whether it has already been sent. A digest is a *schedule*:
 * it happens on a cadence, and the only question is whether enough time has passed.
 * They are idempotent in different ways and so they are two functions.
 */

/* ── Recipients ─────────────────────────────────────────────────────────── */

export type Recipient = { id: ProfileId; state: ProfileState };

/**
 * Everyone who has entered an address, with their settings.
 *
 * Three reads, once per pass. There are three profiles and there will not be more,
 * so a fan-out here is not worth thinking about.
 */
export async function recipients(): Promise<Recipient[]> {
  const rows = await Promise.all(
    PROFILES.map(async (p) => ({
      id: p.id,
      state: hydrate(await get<Partial<ProfileState>>(stateKey(p.id))),
    }))
  );
  return rows.filter((r) => Boolean(r.state.email));
}

/* ── The campaign report ────────────────────────────────────────────────── */

/**
 * Mail every finished campaign that has not been mailed.
 *
 * A drain rather than a hook, and the difference matters. `c.status = "done"` is a
 * bare assignment in two places inside `tickCampaign`, which holds a lock and has a
 * 240 second budget — putting a paid network call on that path would be putting it
 * on the critical path of the thing that spends money. Instead this asks a question
 * of the stored state, so it does not care who finished the campaign, it cannot
 * send twice, and a failed send is retried on the next pass rather than lost.
 *
 * Only the owner is mailed. A campaign belongs to the profile that made it and
 * spends against that profile's caps, so it is that person's result.
 */
export async function sendPendingCampaignEmails(): Promise<number> {
  if (!hasEmail()) return 0;

  const pending = (await listCampaigns()).filter(
    (c) => c.status !== "running" && Boolean(c.finishedAt) && !c.notifiedAt
  );
  if (pending.length === 0) return 0;

  const origin = emailOrigin();
  const people = await recipients();
  let sent = 0;

  for (const c of pending) {
    const to = people.find((r) => r.id === c.owner);

    /**
     * Nobody to tell, so stamp it and move on. Without this a campaign owned by
     * somebody with no address is reconsidered on every cron for as long as it is
     * kept, and the log fills with a decision nobody can act on.
     */
    if (!to || !to.state.campaignEmails || !to.state.email) {
      await stamp(c);
      continue;
    }

    const report = await buildReport(c, 10);
    const mail = renderCampaignReport({ campaign: c, people: report, origin });
    const ok = await trySend(c.owner, { to: to.state.email, ...mail });

    /**
     * Stamped only on success. A failure leaves it pending, so the next cron tries
     * again — which is the right way round: a duplicate report is noise, a missing
     * one is a campaign nobody hears about.
     */
    if (ok) {
      await stamp(c);
      sent++;
    }
  }

  if (sent > 0) log.info("email.campaigns", { sent, pending: pending.length });
  return sent;
}

async function stamp(c: Campaign): Promise<void> {
  await writeCampaign({ ...c, notifiedAt: new Date().toISOString() });
}

/* ── The queue digest ───────────────────────────────────────────────────── */

/**
 * Send the digest to anyone whose cadence is due.
 *
 * The queue is per person: `queued` is the absence of a mark, so two teammates
 * looking at the same roster see different lists, and the count in the email has to
 * be the count that person would see on the screen. That is why the ranking is
 * rebuilt per recipient rather than computed once and reused. Three people and a
 * roster of fifty-odd makes that free; the alternative is an email whose numbers
 * disagree with the app, which is the bug this whole feature would be judged on.
 */
export async function sendDueDigests(now = new Date()): Promise<number> {
  if (!hasEmail()) return 0;

  const due = (await recipients()).filter((r) => digestDue(r.state.digest, r.state.lastDigestAt, now));
  if (due.length === 0) return 0;

  const [roster, team] = await Promise.all([readRoster(), readTeam()]);
  const scored = Object.values(roster).map((p) => scoreOne(p, team.taxonomy));
  const origin = emailOrigin();
  let sent = 0;

  for (const r of due) {
    const marks = r.state.marks;
    const queue = scored
      .filter((c) => (marks[c.slug]?.status ?? "queued") === "queued")
      .sort((a, b) => {
        const pa = marks[a.slug]?.pinned ? 1 : 0;
        const pb = marks[b.slug]?.pinned ? 1 : 0;
        return pa !== pb ? pb - pa : b.score - a.score;
      });

    /**
     * An empty queue is worth saying once and then not saying again. A daily digest
     * that reports nothing every morning trains people to filter it, and the first
     * real find then goes unread.
     */
    if (queue.length === 0) {
      await remember(r, now);
      continue;
    }

    const mail = renderQueueDigest({
      candidates: queue.slice(0, 10),
      queueTotal: queue.length,
      knownCount: Object.values(marks).filter((m) => m.status === "known").length,
      /**
       * Measured from the last *email*, not the last visit to the screen. The two
       * answer different questions: `digestSeenAt` is "what have I not looked at",
       * this is "what has happened since I was last told".
       */
      newSince: r.state.lastDigestAt,
      origin,
      cadence: r.state.digest === "weekly" ? "weekly" : "daily",
    });

    if (await trySend(r.id, { to: r.state.email as string, ...mail })) {
      await remember(r, now);
      sent++;
    }
  }

  if (sent > 0) log.info("email.digests", { sent, due: due.length });
  return sent;
}

/**
 * Record that a digest went, through the same merge the app uses.
 *
 * `mergeState` rather than a bare write, because the person may be using the app in
 * another tab while the cron runs and a whole-document overwrite would take their
 * marks with it.
 */
async function remember(r: Recipient, now: Date): Promise<void> {
  const key = stateKey(r.id);
  const current = hydrate(await get<Partial<ProfileState>>(key));
  await set(key, mergeState(current, { lastDigestAt: now.toISOString() }));
}
