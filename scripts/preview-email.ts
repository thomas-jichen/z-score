/**
 * Write both emails to disk so they can be opened and looked at.
 * Run: npm run preview:email
 *
 * An email is the one surface nobody sees before it reaches somebody else, and no
 * amount of assertion substitutes for opening it. This renders against the live
 * roster when there is one and against fixtures when there is not, so it works with
 * or without a database attached.
 *
 * Writes to `.data/`, which is already gitignored as the file-backend directory.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { renderCampaignReport, renderQueueDigest } from "../lib/emailDigest";
import { scoreOne } from "../lib/candidates";
import { emptyTeam } from "../lib/state";
import type { Campaign } from "../lib/campaign";
import type { ReportPerson } from "../lib/campaignRun";
import type { Candidate } from "../lib/zscore";

const ORIGIN = "https://zscore.example.com";
const OUT = path.join(process.cwd(), ".data");

async function liveCandidates(): Promise<Candidate[] | null> {
  try {
    const { readRoster, readTeam } = await import("../lib/serverState");
    const [roster, team] = await Promise.all([readRoster(), readTeam()]);
    const people = Object.values(roster);
    if (people.length === 0) return null;
    return people
      .map((p) => scoreOne(p, team.taxonomy))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  } catch {
    return null;
  }
}

/** Enough of a person to exercise every branch: thin, polymath, no signals, an ampersand. */
function fixtures(): Candidate[] {
  const tax = emptyTeam().taxonomy;
  const base = {
    slug: "x",
    name: "X",
    url: "",
    headline: "",
    snippet: "",
    addedAt: "2026-08-20T00:00:00.000Z",
    searchLabels: [],
  };
  const mk = (over: Record<string, unknown>) =>
    scoreOne({ ...base, ...over } as never, tax);

  return [
    mk({
      slug: "a",
      name: "Priya Raghunathan",
      headline: "Physics at MIT | RSI '24",
      snippet: "Physics at MIT | RSI '24, IPhO Gold",
    }),
    mk({
      slug: "b",
      name: "Tom & Sons Robotics",
      headline: "Founder | Z Fellow",
      snippet: "Founder | Z Fellow, backed by a16z",
    }),
    mk({ slug: "c", name: "Someone With Nothing", headline: "Student", snippet: "Student" }),
  ];
}

function fakeCampaign(): { campaign: Campaign; people: ReportPerson[] } {
  const campaign = {
    id: "cmp_preview",
    owner: "thomas",
    name: "Research olympiad to top CS",
    status: "done",
    finishedReason: "ran its full 2 days",
    day: 2,
    foundCount: 30,
    spentUsd: 0.037,
    settings: { days: 2, searchesPerDay: 20, queuePerDay: 40, enrichPerDay: 10, budgetUsd: 0.3, scoreBar: 0 },
  } as unknown as Campaign;

  const people: ReportPerson[] = [
    {
      slug: "rudy-pathak",
      name: "Rudy Pathak",
      headline: "Co-Founder @ Brylo | Z Fellow | CS + Bio @ Stanford",
      url: "",
      score: 7.8,
      archetype: "founder",
      confirmed: ["Z Fellow"],
      enriched: true,
      day: 1,
      at: "2026-08-20T00:00:00.000Z",
      evicted: false,
      hasPhoto: true,
      signals: [
        { label: "Z Fellow", points: 2 },
        { label: "NASA", points: 1.4 },
        { label: "Funded founder", points: 1.2 },
      ],
    },
    {
      slug: "gone",
      name: "Evicted Person",
      headline: "",
      url: "",
      score: 1.2,
      archetype: "builder",
      confirmed: [],
      enriched: false,
      day: 2,
      at: "2026-08-21T00:00:00.000Z",
      evicted: true,
      // An evicted row is a snapshot with no profile behind it, so no face.
      hasPhoto: false,
      signals: [],
    },
  ];
  return { campaign, people };
}

async function main() {
  const live = await liveCandidates();
  const candidates = live ?? fixtures();

  const digest = renderQueueDigest({
    candidates,
    queueTotal: candidates.length + 29,
    knownCount: 4,
    // A week ago, so the newer half of the list carries the marker.
    newSince: "2026-08-16T00:00:00.000Z",
    origin: ORIGIN,
    cadence: "weekly",
  });

  const { campaign, people } = fakeCampaign();
  const report = renderCampaignReport({ campaign, people, origin: ORIGIN });

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, "email-digest.html"), digest.html);
  await fs.writeFile(path.join(OUT, "email-report.html"), report.html);
  await fs.writeFile(
    path.join(OUT, "email-plain.txt"),
    `SUBJECT: ${digest.subject}\n\n${digest.text}\n\n${"=".repeat(60)}\n\nSUBJECT: ${report.subject}\n\n${report.text}\n`
  );

  console.log(`source: ${live ? `${candidates.length} live candidates` : "fixtures, no roster found"}`);
  console.log(`digest subject: ${digest.subject}`);
  console.log(`report subject: ${report.subject}`);
  console.log(`\nwrote:\n  ${OUT}/email-digest.html\n  ${OUT}/email-report.html\n  ${OUT}/email-plain.txt`);
}

void main();
