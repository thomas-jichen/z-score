import { readRoster, readTeam } from "../lib/serverState";
import { heldTags } from "../lib/tags";

/** Summer and enrichment programmes: a place you paid or applied to attend. */
const ENRICHMENT = /young global|pre-?college|summer (program|academy|session|institute|seminar)|youth program|leadership (program|academy|conference)|governor'?s school|\bcamp\b/i;

async function main() {
  const [roster, team] = await Promise.all([readRoster(), readTeam()]);
  const t = team.taxonomy;
  console.log("── currently held tags that read as attend-a-programme ──");
  const holders = new Map<string, string[]>();
  for (const p of Object.values(roster)) {
    for (const { def } of heldTags(p, t)) {
      if (def.facet !== "program") continue;
      holders.set(def.label, [...(holders.get(def.label) ?? []), p.name]);
    }
  }
  for (const [label, names] of [...holders].sort()) {
    const d = Object.values(t.tags).find((x) => x.label === label)!;
    const flag = ENRICHMENT.test(label) ? " <-- attend-a-programme" : "";
    console.log(`  ${label.padEnd(30)} w=${String(d.weight).padEnd(4)} ${names.length} holder(s)${flag}`);
  }
}
void main();
