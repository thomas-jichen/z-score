import type { TagMatch, Tier } from "./tagRegistry";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SELECTION MENUS. Edit these lists directly.
 *
 * Each string is used verbatim in the Google query, so what you type here is
 * exactly what gets searched. No aliases, no hidden expansion. Keep entries
 * short: "RSI" beats "Research Science Institute", because Google's own
 * semantics handle the rest and short terms match how people actually write.
 *
 * Order of the lists below is the order they appear in the sweep sidebar.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * A vocabulary entry: the name it is called, plus every other way it is written.
 *
 * `state` is only meaningful on a school, and it is what makes a home state
 * knowable. A LinkedIn education record carries no location, and a school's name
 * rarely contains one — "Sewickley Academy" is in Pennsylvania and says so
 * nowhere. Scanning the rest of a profile for a state name instead put six of
 * nineteen people in the wrong state, because it picked up award issuers and job
 * locations that have nothing to do with where someone grew up.
 */
export type Seed = { label: string; aliases?: string[]; state?: string };

/**
 * Which names are safe to read out of prose, and which need vouching for.
 *
 * A label-keyed table rather than a field on each seed, so the whole hazard list can
 * be reviewed in one place — which is the only way to tell whether it is complete.
 *
 * Everything absent from here is `text`: the name is distinctive enough that seeing
 * it is enough. What is listed is a name that is also an ordinary English word, or an
 * initialism with a second life, where a bare sighting proves nothing:
 *
 *   "imo the best approach is RL"                IMO, 2.0
 *   "twin primes conjecture"                     MIT PRIMES, 1.4
 *   "contributed to the rise of transformers"    Rise, 1.2
 *   "mentors from the Lightspeed Studios"        Lightspeed, 1.5 — Tencent's studio
 *   "Sequoia National Park volunteer"            Sequoia, 2.0
 *   "IMU accel and gyro fusion"                  Accel, 1.5
 *   "Antler on the deer skull dataset"           Antler, 0.7
 *   "on the contrary, we found"                  Contrary, 1.2
 *   "afore mentioned"                            Afore Capital, 1.5
 *   "1517 Broadway suite 400"                    1517 Fund, 1.5
 *   "drank a Coke at lunch"                      Coca-Cola Scholar, 0.8
 *   "SPARC Solaris kernel work"                  SPARC, 0.9
 *   "repetitive strain injury (RSI)"             RSI, 1.6
 *
 * Every one of those was verified to fire. `qualified` keeps them all, because each
 * is also a real credential that real people in this population hold, and asks the
 * clause around the name to be talking about holding something.
 *
 * Benchmark is the single `structured` entry. The others have a sentence shape that
 * tells their two senses apart; "benchmark" does not, in a population that publishes
 * machine-learning papers for a living, and a Benchmark-backed high schooler is
 * vanishingly rare. It still tags from an employer or a school the vendor resolved.
 */
export const MATCH_POLICY: Record<string, TagMatch> = {
  // Funds and fellowships whose name is also a word.
  Benchmark: "structured",
  Accel: "qualified",
  Greylock: "qualified",
  Antler: "qualified",
  Contrary: "qualified",
  Sequoia: "qualified",
  Lightspeed: "qualified",
  Bessemer: "qualified",
  "Khosla Ventures": "qualified",
  "General Catalyst": "qualified",
  "Afore Capital": "qualified",
  "1517 Fund": "qualified",
  "Founders Fund": "qualified",
  "Pear VC": "qualified",

  /**
   * Competitions and programmes, and the line here is narrower than it first looks.
   *
   * The test is "would somebody write this word in an ordinary sentence", not "could
   * this abbreviation mean something else somewhere". RSI is also repetitive strain
   * injury and STS is also the Space Shuttle, but nobody in this population writes
   * either of those, and they do write the credential bare: Davido Zhang's whole
   * headline is "Stanford Math & CS | Phillips Exeter | RSI", and Brian Zhang's is
   * "Research Science Institute (RSI)". Gating those cost three of the four real RSI
   * holders in the roster their 1.6, to guard against a false positive that has never
   * once occurred. So RSI, STS, SSP, IOI and ISEF are read freely.
   *
   * What stays gated is a name that really does appear in this population's prose in
   * its other sense: "imo the best approach is RL", "mop", "the rise of transformers",
   * "twin primes conjecture", "SPARC Solaris kernel". IBO is here for a different
   * reason — the International Baccalaureate Organization is common among exactly
   * these students, and at 2.0 it is the most expensive collision in the table.
   */
  IMO: "qualified",
  IBO: "qualified",
  MOP: "qualified",
  SPARC: "qualified",
  Rise: "qualified",
  "MIT PRIMES": "qualified",
  "Jane Street AMP": "qualified",
  "Coca-Cola Scholar": "qualified",
};

/**
 * What each rung of a credential is worth, where the credential has rungs.
 *
 * `normalizeKey` deletes "winner", "finalist", "semifinalist" and "qualifier",
 * which is right for building a key and was throwing away the only thing that
 * separates two people holding the same name. Michael Yu's honour reads "Neo Scholar
 * Finalist" and he scored the full 1.5 of being a Neo Scholar; Andra Campos wrote
 * "Coca Cola Scholarship Semi-Finalist" and scored the full 1.2.
 *
 * Deliberately not every tag. A ladder is only listed where the programme really has
 * a published tier and the gap between rungs is worth pricing. Two omissions are on
 * purpose rather than for lack of time:
 *
 *   ISEF already splits its top rung into its own tag, ISEF Grand Award, read per
 *   honour by ISEF_TIER in lib/extract.ts. A ladder here would double-charge it.
 *
 *   The olympiads already have the Olympiad camper flag, which stacks with the
 *   olympiad's own weight by design so that a USABO camper and a USABO semifinalist
 *   are not the same person. Same reason.
 *
 * Absolute weights, not fractions of the base, so the number on the screen is the
 * number that scores and the taxonomy editor stays one kind of thing. The cost of
 * that choice is real and worth stating: raising a base weight does not lift its
 * rungs with it, so a retuned tag needs its ladder retuned too. Every rung below is
 * priced against the *seeded* base, which is what a fresh document has.
 */
export const TIER_LADDERS: Record<string, Partial<Record<Tier, number>>> = {
  // A Thiel finalist is interviewed; a Thiel Fellow is paid to drop out.
  "Thiel Fellow": { finalist: 0.8, semifinalist: 0.4 },
  "Neo Scholar": { finalist: 0.8 },
  "Davidson Fellow": { finalist: 0.6 },
  "Coca-Cola Scholar": { finalist: 0.5, semifinalist: 0.3 },
  Rise: { finalist: 0.6 },
  // A Coolidge Senator is the rung below a Coolidge Scholar, and shared its weight.
  "Coolidge Scholar": { finalist: 0.6, semifinalist: 0.4 },
  QuestBridge: { finalist: 0.3 },
  USSYP: { finalist: 0.6 },
  "Cameron Impact Scholar": { finalist: 0.4 },
  "National YoungArts": { winner: 0.9, finalist: 0.6 },
  "NCWIT Aspirations": { winner: 0.7, semifinalist: 0.2, qualifier: 0.2 },
  "Elks Most Valuable Student": { semifinalist: 0.15 },
  // Scholar, then Candidate, then nominated. Low stakes either way at 0.5.
  "Presidential Scholar": { finalist: 0.3, semifinalist: 0.2, qualifier: 0.2 },
};

/** Selective programs, competitions and credentials. */
export const PROGRAMS: Seed[] = [
  /**
   * ─── Added after auditing what the tagger finds and cannot score ─────────
   *
   * Thirty of the sixty-two credentials the tagger read off the roster resolved to
   * nothing, so they could not score however selective they were. These are the ones
   * worth a weight, priced by how many people a year hold them.
   *
   * Four that turned up are deliberately absent. EXTRACT_SYSTEM in lib/groq.ts tells
   * the model to skip AIME, Science Olympiad, Congressional App Challenge and
   * National Merit Semifinalist as too common, and that judgment looks right — adding
   * them here without editing the prompt would create tags nothing ever fills, and
   * editing the prompt would start scoring credentials tens of thousands of people
   * hold. The state and regional science fairs are absent for the same reason, and
   * because a state fair reading as ISEF is the bug two commits ago fixed.
   */
  { label: "USSYP", aliases: ["United States Senate Youth Program", "US Senate Youth Program"] },
  { label: "Jack Kent Cooke Scholar", aliases: ["Jack Kent Cooke Scholarship", "Jack Kent Cooke"] },
  { label: "Gloria Barron Prize", aliases: ["Barron Prize", "Gloria Barron Prize for Young Heroes"] },
  { label: "Cameron Impact Scholar", aliases: ["Cameron Impact Scholarship"] },
  { label: "NeurIPS High School Track", aliases: ["NeurIPS High School"] },
  { label: "S.T. Yau Science Award", aliases: ["Yau Science Award", "S. T. Yau Science Award"] },
  { label: "Math Prize for Girls" },
  { label: "National YoungArts", aliases: ["YoungArts"] },
  { label: "NACLO", aliases: ["North American Computational Linguistics Olympiad"] },
  { label: "USESO", aliases: ["USA Earth Science Olympiad"] },
  { label: "NCWIT Aspirations", aliases: ["NCWIT Aspirations in Computing", "NCWIT"] },
  { label: "National Economics Challenge", aliases: ["NEC"] },
  { label: "Elks Most Valuable Student" },
  { label: "Cum Laude Society" },
  { label: "Palantir Meritocracy Fellow", aliases: ["Palantir Meritocracy Fellowship"] },
  { label: "Bank of America Student Leader" },

  { label: "RSI", aliases: ["Research Science Institute"] },
  { label: "STS", aliases: ["Regeneron Science Talent Search", "Science Talent Search", "Regeneron STS"] },
  { label: "ISEF", aliases: ["International Science and Engineering Fair", "Regeneron ISEF"] },
  { label: "SSP", aliases: ["Summer Science Program"] },
  { label: "MIT PRIMES", aliases: ["PRIMES"] },
  { label: "PROMYS", aliases: ["Program in Mathematics for Young Scientists"] },
  { label: "Simons Fellow", aliases: ["Simons Summer Research Program", "Simons Summer Research"] },
  { label: "Garcia Program", aliases: ["Garcia Summer Scholar", "Garcia Center"] },
  /**
   * Named for the programme, not the firm.
   *
   * This used to read "Jane Street", which collided head-on with the Jane Street
   * entry in COMPANIES: one label, one tag, so an internship on the trading floor
   * and a place on the summer maths programme became the same credential. They are
   * different achievements, they belong to different link types on the graph, and
   * merging them meant the graph could not draw a shared employer at all.
   */
  {
    label: "Jane Street AMP",
    aliases: [
      "AMP",
      "Academy of Math and Programming",
      "Jane Street Academy of Math and Programming",
    ],
  },
  { label: "USAMO", aliases: ["USA Mathematical Olympiad"] },
  { label: "USACO Platinum", aliases: ["USA Computing Olympiad Platinum"] },
  { label: "USAPhO", aliases: ["USA Physics Olympiad", "National Physics Olympiad"] },
  /**
   * Now that `national` survives normalisation, the national olympiads can hold the
   * spellings that used to resolve to the international tag at four times the weight.
   */
  {
    label: "USABO",
    aliases: [
      "USA Biolympiad",
      "USA Biology Olympiad",
      "National Biology Olympiad",
      "US Biology Olympiad",
      "National US Biology Olympiad",
    ],
  },
  { label: "IMO", aliases: ["International Mathematical Olympiad"] },
  { label: "IOI", aliases: ["International Olympiad in Informatics"] },
  // The other three internationals, which carry the same weight as IMO and IOI and
  // were simply missing — an IPhO medallist scored nothing for it.
  { label: "IPhO", aliases: ["International Physics Olympiad"] },
  // "IBmO" is dropped: it is the International Biology-Medicine Olympiad, a separate
  // and far less selective competition, and it was holding IBO's 2.0.
  { label: "IBO", aliases: ["International Biology Olympiad"] },
  { label: "IChO", aliases: ["International Chemistry Olympiad"] },
  { label: "Mathcamp", aliases: ["Canada/USA Mathcamp"] },
  { label: "SPARC", aliases: ["Summer Program on Applied Rationality and Cognition"] },
  // "TASS" is gone from here twice over: it is the Telluride Association Sophomore
  // Seminar, a different and younger programme priced the same 0.9, and it is the
  // Russian state news agency. An alias has to name the thing it is an alias for.
  { label: "TASP", aliases: ["Telluride Association Summer Program"] },
  { label: "Hack Club" },
  { label: "Coca-Cola Scholar", aliases: ["Coca-Cola Scholars", "Coke Scholar"] },
  { label: "QuestBridge", aliases: ["QuestBridge Scholar", "QuestBridge National College Match"] },
  { label: "Diamond Challenge" },
  { label: "Conrad Challenge", aliases: ["Conrad Spirit of Innovation Challenge"] },
  { label: "MOP", aliases: ["Mathematical Olympiad Program", "Math Olympiad Summer Program", "MOSP"] },
  { label: "Davidson Fellow", aliases: ["Davidson Fellows"] },
  { label: "Presidential Scholar", aliases: ["U.S. Presidential Scholar", "United States Presidential Scholar"] },
  { label: "Rise", aliases: ["Rise Global Winner", "Schmidt Futures Rise"] },
  { label: "Coolidge Scholar", aliases: ["Coolidge Scholarship", "Coolidge Senator"] },
  /**
   * The three hackathons worth a tag, and nothing else.
   *
   * These went in as a much longer list — PennApps, MHacks, LA Hacks, HackHarvard,
   * AIME, DECA, FBLA, HOSA, Science Olympiad, John Locke — because they appeared on a
   * profile, which is the wrong reason to add anything. Appearing on a profile is not
   * signal; being hard to get is. AIME passes ten thousand people a year and DECA has
   * a couple of hundred thousand members, so a tag for either says almost nothing
   * about the person holding it while still adding to their score.
   *
   * What survives is the top of the collegiate hackathon circuit, and even that is
   * priced as an activity rather than a credential: these are things a good builder
   * does on a weekend, not filters they cleared.
   */
  { label: "TreeHacks", aliases: ["Stanford TreeHacks"] },
  { label: "CalHacks", aliases: ["Cal Hacks", "Berkeley CalHacks"] },
  { label: "HackMIT" },
  { label: "Breakthrough Junior Challenge", aliases: ["Breakthrough Junior"] },
  /**
   * The tier above finalist at ISEF, which the ISEF tag alone cannot express.
   *
   * There are ~1,800 finalists a year and a few hundred Grand Awards across every
   * category, so "ISEF — 2nd Place Grand Award in Physics & Astronomy" and "ISEF
   * Finalist" are two very different results scoring the same 0.6. This is the one
   * competition worth splitting by tier: it is the largest in the world, so the gap
   * between its tiers is the widest of any tag here.
   *
   * Its tier names are *not* unambiguous enough to match on, which is what the
   * original "Grand Award" alias assumed. Every competition hands out a grand prize,
   * and after the noise pass that alias was the single word `grand` — so a piano
   * competition and a business-plan contest both scored 1.4 for a science fair
   * neither had entered, while the two real winners matched by the same accident.
   * The tier now comes from `lib/extract.ts`, which reads honours and can require
   * ISEF and the placing in the same line.
   */
  { label: "ISEF Grand Award", aliases: ["ISEF Best of Category"] },
  /**
   * Dual-degree programmes admitted separately from the university, at rates far
   * below it. Berkeley M.E.T. takes about fifty a year; being in one is a stronger
   * statement than the school's name on its own, and the school's name is all that
   * was scoring.
   */
  { label: "Berkeley M.E.T.", aliases: ["Management, Entrepreneurship, & Technology", "Berkeley MET", "M.E.T. program"] },
  { label: "Penn M&T", aliases: ["Jerome Fisher Program", "Management & Technology", "Jerome Fisher"] },
  { label: "Huntsman Program", aliases: ["Huntsman"] },
  { label: "Vagelos Program", aliases: ["Vagelos Scholars", "Vagelos"] },
];

/**
 * Tags that changed their name, keyed by the old key.
 *
 * A label change moves the id — `normalizeKey` strips "winner" and "finalist" as
 * noise, so "Competition winner" was stored as `competition` and "Hackathon winner"
 * is `hackathon`. Without this the stored row keeps the old name, the seed list adds
 * a second one beside it, and the team's tuning stays on the row nobody holds.
 *
 * That tuning is the whole reason this exists rather than a purge: "Olympiad
 * finalist" had already been moved off its seeded 1.0 by hand.
 */
export const RENAMED: Record<string, string> = {
  competition: "Hackathon winner",
  olympiad: "Olympiad camper",
  /**
   * Not a rename: the same label, a key that stopped being one character.
   *
   * "Z Fellow" normalised to `z`, because `fellow` is noise, and `resolveAny` is
   * facet-blind — so "Z", "Z Scholar", "Z Institute" and an education row named
   * simply "Z" all took the heaviest weight in the taxonomy. `keyFromWords` now
   * keeps the noise when stripping it would leave a single character, and every
   * stored document has the team's tuning on the old row.
   */
  z: "Z Fellow",
  /**
   * Also not renames: `national` stopped being a noise word, so every id that had
   * it silently deleted moved. All four are national labs, and all four keys are
   * more nearly their own name than they were.
   */
  "argonne-laboratory": "Argonne National Laboratory",
  "oak-ridge-laboratory": "Oak Ridge National Laboratory",
  "los-alamos-laboratory": "Los Alamos National Laboratory",
  "sandia-laboratories": "Sandia National Laboratories",
};

/**
 * Aliases withdrawn from the vocabulary, to be dropped from documents that have them.
 *
 * The same problem `PURGED` solves for tags. Taking an alias out of a seed list stops
 * it being *created* and does nothing about the copies already stored: `migrateFacets`
 * unions stored aliases with seeded ones and only surrenders a key the seeds have
 * reassigned to somebody else. An alias with no owner at all is nobody's to reassign,
 * so it simply persists — which meant deleting `speedrun` from a16z, or moving
 * `biology-olympiad` off IBO, changed nothing whatsoever for a team that already had
 * a taxonomy. Verified: Megan D'Souza kept IBO at 2.0 for a USABO semifinal, and
 * Vihaan Shringi kept ISEF for a Washington state fair, after both were "fixed".
 *
 * Normalised keys, not display spellings, because that is the form stored.
 *
 * Only keys no seed owns any more belong here. `mathematical-olympiad` is absent on
 * purpose: it moved off IMO but MOP holds it legitimately, and the existing
 * reassignment rule is what settles that. `npm run check` asserts the distinction.
 */
export const PURGED_ALIASES: string[] = [
  // Deleted: each named something other than the tag it was on.
  "speedrun", // a16z, 2.0 — a gaming verb
  "tass", // TASP, 0.9 — a different Telluride programme, and a news agency
  "ibmo", // IBO, 2.0 — the Biology-Medicine Olympiad, far less selective

  // Moved, because `national` and `international` stopped being noise. The old key
  // is the one that could not tell a national competition from a world final.
  "science-engineering-fair", // ISEF — also every state and regional fair
  "biology-olympiad", // IBO 2.0 — was taking USABO's semifinalists
  "physics-olympiad", // IPhO 2.0 — likewise USAPhO
  "chemistry-olympiad", // IChO 2.0
  "olympiad-in-informatics", // IOI 2.0
  "aeronautics-space-administration", // NASA
  "questbridge-match", // QuestBridge
  "fermi-accelerator-laboratory", // Fermilab
];

/**
 * Tags withdrawn from the vocabulary, to be switched off in documents that have them.
 *
 * Removing a name from a seed list stops it being *created*; it does nothing about
 * the copies already stored, so AIME and DECA would have gone on scoring forever on
 * every profile that already had them. These are zeroed and switched off on the next
 * read — not deleted, so the history is visible and a slider brings any of them back.
 *
 * Only names the seeds themselves introduced. A tag someone promoted by hand is
 * their decision and is never touched here.
 */
/**
 * Deleted outright on the next read, not parked at zero.
 *
 * `RETIRED` switches a tag off and leaves it on the screen; these do not deserve the
 * row. DECA has a couple of hundred thousand members, AIME passes ten thousand a year
 * — a tag for either says nothing about the person holding it, and leaving them
 * visible invites someone to switch them back on.
 */
export const PURGED: string[] = [
  "DECA",
  "AIME",
  "FBLA",
  "HOSA",
  "BPA",
  "Science Olympiad",
  "Science Bowl",
  "Congressional App Challenge",
  "John Locke Institute",
  "Key Club",
  "Model UN",
  "National Honor Society",
  "AP Scholar",
  "National Merit",
  /**
   * A two-week summer seminar you apply to and pay for. It was seeded at 0.2 on the
   * reasoning that the host university is selective, which is the host's selectivity
   * and not the attendee's — and this tool exists to find people who can build
   * companies, which a fortnight at Yale says nothing about either way.
   *
   * Purged rather than zeroed for the same reason as the rest of this list: a row at
   * zero is an invitation to switch it back on.
   */
  "Yale Young Global Scholars",
];

export const RETIRED: string[] = [
  "PennApps",
  "MHacks",
  "LA Hacks",
  "HackHarvard",
  "Hack the North",
];

/**
 * Things that will keep turning up and are never worth a tag.
 *
 * Seeded into `dismissed`, so they stop reaching the review queue at all rather than
 * being declined one profile at a time. Two kinds: near-automatic academic
 * recognitions, and open-entry organisations large enough that membership is a
 * statement about a school district rather than a person.
 *
 * Not permanent — it is the same list the dismiss button writes to, so anything here
 * can be brought back on the taxonomy screen.
 */
export const LOW_SIGNAL: string[] = [
  "Yale Young Global Scholars",
  "YYGS",
  "AP Scholar",
  "AP Scholar with Distinction",
  "National Merit",
  "National Merit Commended",
  "National Merit Semifinalist",
  "National Honor Society",
  "Dean's List",
  "Honor Roll",
  "Presidential Award for Educational Excellence",
  "Seal of Biliteracy",
  "AIME",
  "AIME Qualifier",
  "DECA",
  "FBLA",
  "HOSA",
  "BPA",
  "Key Club",
  "Model UN",
  "Science Olympiad",
  "Science Bowl",
  "Congressional App Challenge",
  "John Locke Institute",
  "PennApps",
  "MHacks",
  "LA Hacks",
  "HackHarvard",
  "Girls Who Code",
  "Boy Scouts",
  "Eagle Scout",
  "Varsity",
  "Student Council",
  "Stealth Startup",
];

/**
 * What high-signal students write in their LinkedIn headline. These are the
 * words that separate someone building or doing real work from someone who
 * just made a profile.
 */
export const TITLE_KEYWORDS: string[] = [
  "Founder",
  "Co-founder",
  "Building",
  "Builder",
  "Startup",
  "CEO",
  "Y Combinator",
  "Researcher",
  "Research Intern",
  "Research Assistant",
  "AI Researcher",
  "ML Engineer",
  "Published",
  "Patent",
  "SWE Intern",
  "Software Engineer Intern",
  "Quant Intern",
  "Trading Intern",
  "Incoming Intern",
  "Intern",
  "Open Source",
  "Hackathon",
  "Teaching Assistant",
];

/**
 * Colleges, with the full legal names people actually write on a profile.
 *
 * The short form is the label because that is how it is said, but a LinkedIn
 * education record says "Massachusetts Institute of Technology". Without the alias
 * those are two tags for one school, and neither one has the right holder count.
 */
export const COLLEGES: Seed[] = [
  { label: "MIT", aliases: ["Massachusetts Institute of Technology"], state: "Massachusetts" },
  { label: "Stanford", aliases: ["Stanford University"], state: "California" },
  { label: "Harvard", aliases: ["Harvard University", "Harvard College"], state: "Massachusetts" },
  { label: "Caltech", aliases: ["California Institute of Technology"], state: "California" },
  { label: "Princeton", aliases: ["Princeton University"], state: "New Jersey" },
  { label: "Yale", aliases: ["Yale University"], state: "Connecticut" },
  { label: "Berkeley", aliases: ["UC Berkeley", "University of California, Berkeley", "Cal"], state: "California" },
  { label: "Carnegie Mellon", aliases: ["Carnegie Mellon University", "CMU"], state: "Pennsylvania" },
  { label: "Cornell", aliases: ["Cornell University"], state: "New York" },
  { label: "Columbia", aliases: ["Columbia University"], state: "New York" },
  { label: "UPenn", aliases: ["University of Pennsylvania", "Penn", "Wharton"], state: "Pennsylvania" },
  { label: "UChicago", aliases: ["University of Chicago"], state: "Illinois" },
  { label: "Waterloo", aliases: ["University of Waterloo"] },
  { label: "Georgia Tech", aliases: ["Georgia Institute of Technology", "GaTech"], state: "Georgia" },
  { label: "UIUC", aliases: ["University of Illinois Urbana-Champaign", "University of Illinois"], state: "Illinois" },
  { label: "Michigan", aliases: ["University of Michigan", "UMich"], state: "Michigan" },
  { label: "UT Austin", aliases: ["University of Texas at Austin"], state: "Texas" },
  { label: "Duke", aliases: ["Duke University"], state: "North Carolina" },
  { label: "Brown", aliases: ["Brown University"], state: "Rhode Island" },
  { label: "Olin", aliases: ["Olin College of Engineering"], state: "Massachusetts" },
  { label: "UCLA", aliases: ["University of California, Los Angeles"], state: "California" },
  { label: "UCSD", aliases: ["University of California, San Diego"], state: "California" },
  { label: "NYU", aliases: ["New York University"], state: "New York" },
  { label: "Johns Hopkins", aliases: ["Johns Hopkins University", "JHU"], state: "Maryland" },
  { label: "Northwestern", aliases: ["Northwestern University"], state: "Illinois" },
  { label: "Oxford", aliases: ["University of Oxford"] },
  { label: "Cambridge", aliases: ["University of Cambridge"] },
];

/** High schools. The acronym is the label; the registered name is the alias. */
export const HIGH_SCHOOLS: Seed[] = [
  { label: "TJHSST", aliases: ["Thomas Jefferson High School for Science and Technology"], state: "Virginia" },
  { label: "Stuyvesant", aliases: ["Stuyvesant High School"], state: "New York" },
  { label: "Bronx Science", aliases: ["Bronx High School of Science"], state: "New York" },
  { label: "Brooklyn Tech", aliases: ["Brooklyn Technical High School"], state: "New York" },
  { label: "Hunter College High School", aliases: ["Hunter College HS"], state: "New York" },
  { label: "Phillips Exeter", aliases: ["Phillips Exeter Academy", "Exeter"], state: "New Hampshire" },
  { label: "Phillips Andover", aliases: ["Phillips Academy Andover", "Andover"], state: "Massachusetts" },
  { label: "Harker", aliases: ["The Harker School"], state: "California" },
  { label: "IMSA", aliases: ["Illinois Mathematics and Science Academy"], state: "Illinois" },
  { label: "Bergen County Academies", aliases: ["BCA"], state: "New Jersey" },
  { label: "NCSSM", aliases: ["North Carolina School of Science and Mathematics"], state: "North Carolina" },
  { label: "Montgomery Blair", aliases: ["Montgomery Blair High School"], state: "Maryland" },
  { label: "Lexington High School", state: "Massachusetts" },
  { label: "Mission San Jose", aliases: ["Mission San Jose High School"], state: "California" },
  { label: "Canyon Crest", aliases: ["Canyon Crest Academy"], state: "California" },
  { label: "Whitney High School", state: "California" },
  { label: "Choate", aliases: ["Choate Rosemary Hall"], state: "Connecticut" },
  { label: "Deerfield", aliases: ["Deerfield Academy"], state: "Massachusetts" },
  { label: "Lawrenceville", aliases: ["The Lawrenceville School"], state: "New Jersey" },
  { label: "Groton", aliases: ["Groton School"], state: "Massachusetts" },
  { label: "Milton Academy", state: "Massachusetts" },
  { label: "Horace Mann", aliases: ["Horace Mann School"], state: "New York" },
  { label: "Dalton", aliases: ["The Dalton School"], state: "New York" },
  { label: "Sidwell Friends", aliases: ["Sidwell Friends School"], state: "District of Columbia" },
  { label: "Menlo School", state: "California" },
  { label: "Castilleja", aliases: ["Castilleja School"], state: "California" },
  { label: "Nueva", aliases: ["The Nueva School"], state: "California" },
  { label: "BASIS Scottsdale", state: "Arizona" },
  { label: "Gunn High School", aliases: ["Henry M. Gunn High School"], state: "California" },
  { label: "Palo Alto High School", aliases: ["Paly"], state: "California" },
  { label: "Saratoga High School", state: "California" },
  { label: "Lynbrook", aliases: ["Lynbrook High School"], state: "California" },
  { label: "Monta Vista", aliases: ["Monta Vista High School"], state: "California" },
  { label: "Torrey Pines", aliases: ["Torrey Pines High School"], state: "California" },
  { label: "Plano West", aliases: ["Plano West Senior High School"], state: "Texas" },
  { label: "LASA", aliases: ["Liberal Arts and Science Academy"], state: "Texas" },
  { label: "TAMS", aliases: ["Texas Academy of Mathematics and Science"], state: "Texas" },
  { label: "High Technology High School", state: "New Jersey" },
  { label: "Ward Melville", aliases: ["Ward Melville High School"], state: "New York" },
  { label: "Westview High School", state: "California" },
  { label: "Sewickley Academy", state: "Pennsylvania" },
  { label: "Shady Side Academy", state: "Pennsylvania" },
  { label: "Fox Chapel Area High School", state: "Pennsylvania" },
  { label: "Cranbrook Schools", aliases: ["Cranbrook Kingswood"], state: "Michigan" },
  { label: "Scarsdale Senior High School", aliases: ["Scarsdale High School"], state: "New York" },
  { label: "Pittsford Mendon High School", state: "New York" },
  { label: "Olentangy Liberty High School", state: "Ohio" },
  { label: "Interlake Senior High School", aliases: ["Interlake High School"], state: "Washington" },
  { label: "Poolesville High School", state: "Maryland" },
  { label: "Decatur High School", state: "Georgia" },
  { label: "Community School of Naples", state: "Florida" },
  { label: "Stanford Online High School", aliases: ["Stanford OHS"] },
];

export const GRAD_YEARS: string[] = [
  "2026",
  "2027",
  "2028",
  "2029",
  "2030",
  "2031",
  "2032",
  "2033",
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SEED VOCABULARY FOR TAGGING
 *
 * The lists above drive the sweep menus and are used verbatim in a Google query.
 * The lists below are different: they seed the tag registry, so they DO carry
 * aliases. That is the whole point — "CS", "Stats" and "EECS" are how people
 * write their own majors, and a tag system that cannot fold them onto one entry
 * produces three tags for one degree.
 * ═══════════════════════════════════════════════════════════════════════════
 */


/**
 * Job titles worth a tag, matched by containment: "Summer Business Analyst"
 * contains "Analyst". Ordered longest-first at use, so "Co-founder" is preferred
 * over "Founder" on the same string.
 */
export const TITLES: Seed[] = [
  { label: "Founder", aliases: ["Founding"] },
  { label: "Co-founder", aliases: ["Cofounder", "Co Founder"] },
  { label: "CEO", aliases: ["Chief Executive Officer"] },
  { label: "CTO", aliases: ["Chief Technology Officer"] },
  { label: "COO", aliases: ["Chief Operating Officer"] },
  { label: "CFO", aliases: ["Chief Financial Officer"] },
  { label: "Partner" },
  { label: "Analyst" },
  { label: "Intern" },
  { label: "Research Intern" },
  { label: "Researcher", aliases: ["Research Assistant"] },
  { label: "Software Engineer", aliases: ["Software Developer", "SWE"] },
  { label: "Machine Learning Engineer", aliases: ["ML Engineer"] },
  { label: "Data Scientist" },
  { label: "Trader", aliases: ["Trading"] },
  { label: "Quant", aliases: ["Quantitative"] },
  { label: "Director" },
  { label: "President" },
  { label: "Chair", aliases: ["Chairman", "Chairperson"] },
  { label: "Teaching Assistant", aliases: ["TA"] },
  { label: "Instructor", aliases: ["Tutor"] },
  { label: "Scout" },
  { label: "Advisor", aliases: ["Adviser"] },
];

/** Fields of study. Aliases are how students actually abbreviate them. */
export const MAJORS: Seed[] = [
  { label: "Computer Science", aliases: ["CS", "Computer Sci"] },
  { label: "Statistics", aliases: ["Stats", "Stat"] },
  { label: "Mathematics", aliases: ["Math", "Maths"] },
  { label: "Electrical Engineering", aliases: ["EE"] },
  { label: "Electrical Engineering and Computer Science", aliases: ["EECS"] },
  { label: "Economics", aliases: ["Econ"] },
  { label: "Physics" },
  { label: "Chemistry", aliases: ["Chem"] },
  { label: "Biology", aliases: ["Bio"] },
  { label: "Neuroscience", aliases: ["Neuro"] },
  { label: "Mechanical Engineering", aliases: ["MechE"] },
  { label: "Bioengineering", aliases: ["Biomedical Engineering", "BME"] },
  { label: "Artificial Intelligence", aliases: ["AI"] },
  { label: "Data Science" },
  { label: "Political Science", aliases: ["PoliSci"] },
  { label: "Philosophy" },
  { label: "Management Science and Engineering", aliases: ["MS&E"] },
  { label: "Symbolic Systems", aliases: ["SymSys"] },
];

/**
 * Whole-profile facts, as opposed to a line on it.
 *
 * Seeded so they resolve at all — a flag the registry has never heard of is dropped
 * before it can score, which is why "Influencer" and the rest were computed on every
 * profile and visible on none.
 */
export const FLAGS: Seed[] = [
  { label: "Funded founder" },
  /**
   * Won a hackathon, rather than placed at something.
   *
   * This was "Competition winner" and fired on any placing in any honour, which made
   * it true of thirteen people and specific about none of them: a piano competition,
   * a business case, a state science fair and three actual hackathons all carried the
   * same flag. Named for hackathons, it now requires one — and the tiers that used to
   * lean on it have their own tags, ISEF Grand Award and Olympiad camper.
   */
  { label: "Hackathon winner" },
  /**
   * Reached the national training camp of an olympiad, rather than sat the exam.
   * Stacks with the olympiad's own weight, so a USABO camper and a USABO semifinalist
   * stop scoring the same 0.8.
   */
  { label: "Olympiad camper" },
  { label: "Influencer" },
  { label: "Has a site" },
  { label: "Published" },
  { label: "Patent holder" },
];

/**
 * Named research groups. The signal is doing real research as an undergraduate, and
 * the group's name is what makes it checkable.
 *
 * Filed apart from employers because "Researcher at Stanford Multi-Robot Systems Lab"
 * and "Intern at Amazon" are not the same claim, and reading both as a company meant
 * the first one scored nothing at all.
 */
export const LABS: Seed[] = [
  { label: "Stanford AI Lab", aliases: ["SAIL", "Stanford Artificial Intelligence Laboratory"] },
  { label: "Stanford HAI", aliases: ["Stanford Institute for Human-Centered AI"] },
  { label: "Stanford AIMI", aliases: ["Stanford Center for AI in Medicine and Imaging"] },
  { label: "Stanford Vision Lab", aliases: ["SVL"] },
  { label: "Stanford NLP Group", aliases: ["Stanford NLP"] },
  { label: "Stanford Multi-Robot Systems Lab", aliases: ["Stanford MSL", "Multi-Robot Systems Lab"] },
  { label: "MIT CSAIL", aliases: ["CSAIL", "Computer Science and Artificial Intelligence Laboratory"] },
  { label: "MIT Media Lab", aliases: ["Media Lab"] },
  { label: "MIT Lincoln Laboratory", aliases: ["Lincoln Lab"] },
  { label: "Berkeley AI Research", aliases: ["BAIR"] },
  // No "Robotics Institute" alias: the noise pass reduces it to `robotics`, and
  // every VEX team and student robotics club then read as Carnegie Mellon.
  { label: "CMU Robotics Institute" },
  { label: "Broad Institute", aliases: ["Broad Institute of MIT and Harvard"] },
  { label: "Whitehead Institute" },
  { label: "Cold Spring Harbor Laboratory", aliases: ["CSHL"] },
  { label: "Jackson Laboratory", aliases: ["JAX"] },
  { label: "Jet Propulsion Laboratory", aliases: ["JPL", "NASA JPL"] },
  { label: "Fermilab", aliases: ["Fermi National Accelerator Laboratory"] },
  { label: "Argonne National Laboratory", aliases: ["Argonne"] },
  { label: "Oak Ridge National Laboratory", aliases: ["ORNL"] },
  { label: "Los Alamos National Laboratory", aliases: ["LANL"] },
  { label: "Sandia National Laboratories", aliases: ["Sandia"] },
  { label: "LIGO" },
];

/**
 * Selective student organisations, mostly the entrepreneurship ones.
 *
 * The signal here is usually the role rather than the membership — running ASES is a
 * different thing from attending it — but the club has to exist as a tag before the
 * role can mean anything.
 */
export const CLUBS: Seed[] = [
  { label: "Stanford ASES", aliases: ["ASES", "Asia-Pacific Student Entrepreneurship Society"] },
  { label: "Stanford BASES", aliases: ["BASES", "Business Association of Stanford Entrepreneurial Students"] },
  { label: "Stanford Blockchain Club" },
  { label: "Stanford Marketing" },
  { label: "Stanford Women in Computer Science", aliases: ["Stanford WiCS"] },
  { label: "Free Ventures", aliases: ["Berkeley Free Ventures"] },
  { label: "Harvard Ventures" },
  { label: "MIT Sloan Entrepreneurship Club" },
  { label: "Cornell eLab" },
  { label: "Penn Wharton Entrepreneurship", aliases: ["Wharton Entrepreneurship"] },
  { label: "Duke Innovation and Entrepreneurship", aliases: ["Duke I&E"] },
  { label: "optiMize", aliases: ["Michigan optiMize"] },
  { label: "Contrary Campus Venture Partner", aliases: ["Contrary Venture Partner"] },
  { label: "Kleiner Perkins Fellow", aliases: ["KP Fellows", "Kleiner Perkins Fellows"] },
  { label: "Rewriting the Code", aliases: ["RTC"] },
  { label: "ColorStack" },
  { label: "Management Leadership for Tomorrow", aliases: ["MLT"] },
];

/**
 * Early-stage companies whose name alone is signal, because being there early is.
 *
 * Deliberately short. Startups are not a curatable universe — there are millions and
 * the list would rot in a month — so this holds only the ones a reader would
 * recognise, and everything else arrives in the review queue, correctly filed, to be
 * promoted or ignored.
 */
export const STARTUPS: Seed[] = [
  { label: "Cluely" },
  { label: "Cognition", aliases: ["Cognition AI", "Cognition Labs"] },
  { label: "Perplexity", aliases: ["Perplexity AI"] },
  { label: "Sierra", aliases: ["Sierra AI"] },
  { label: "Cursor", aliases: ["Anysphere"] },
  { label: "Harvey", aliases: ["Harvey AI"] },
  { label: "Mercor" },
  { label: "Suno" },
  { label: "ElevenLabs", aliases: ["Eleven Labs"] },
  { label: "Replit" },
  { label: "Vercel" },
  { label: "Linear" },
  { label: "Ramp" },
  { label: "Scale AI", aliases: ["Scale"] },
  { label: "Figma" },
  { label: "Notion" },
];

/**
 * Accelerators, fellowships and funds that pick people and back them.
 *
 * Kept apart from both PROGRAMS and COMPANIES, because it was in those two lists
 * that the signal went missing. "Y Combinator" as a company read as an employer,
 * so the batch row in someone's education section resolved as a university and
 * scored nothing; "Z Fellows" had the same problem from the other direction. And
 * the labels collided: the firm a16z and a16z Speedrun cannot be one tag if one is
 * a job and the other is a cheque.
 *
 * These carry the heaviest weights in the taxonomy. Every other signal here is
 * somebody's opinion that a person is promising; this is somebody acting on it.
 */
export const ACCELERATORS: Seed[] = [
  { label: "Y Combinator", aliases: ["YC", "YCombinator", "Y-Combinator"] },
  { label: "Thiel Fellow", aliases: ["Thiel Fellowship", "Thiel Foundation"] },
  // Labelled for the firm, not the programme. Keeping them apart would need two tags
  // with one key, and for this population "a16z" on a profile means Speedrun or a
  // scout role far more often than it means an analyst job.
  {
    label: "a16z",
    // Bare "Speedrun" is dropped: it is a gaming verb, and it carried the heaviest
    // weight in the taxonomy. "a16z Speedrun" still resolves.
    aliases: ["Andreessen Horowitz", "a16z Speedrun", "a16z SPEEDRUN"],
  },
  { label: "Z Fellow", aliases: ["Z Fellows", "Z-Fellow", "ZFellows", "Z Fellowship"] },
  { label: "Neo Scholar", aliases: ["Neo Scholars", "Neo Accelerator"] },
  { label: "Sequoia", aliases: ["Sequoia Capital", "Sequoia Arc", "Sequoia Atlas"] },
  { label: "Founders Fund", aliases: ["Founders Fund Anduril Fellowship"] },
  { label: "Pear VC", aliases: ["PearX", "Pear Garage"] },
  { label: "South Park Commons", aliases: ["SPC"] },
  { label: "Dorm Room Fund" },
  { label: "Contrary", aliases: ["Contrary Capital", "Contrary Research"] },
  { label: "Entrepreneur First", aliases: ["EF"] },
  { label: "Emergent Ventures", aliases: ["Emergent Ventures Fellow"] },
  { label: "1517 Fund", aliases: ["1517", "1517 Medici"] },
  { label: "Techstars" },
  { label: "Antler" },
  { label: "buildspace", aliases: ["buildspace n&w", "Buildspace"] },
  { label: "Afore Capital", aliases: ["Afore"] },
  { label: "Battery Ventures", aliases: ["Battery"] },
  { label: "645 Ventures" },
  { label: "Lightspeed", aliases: ["Lightspeed Venture Partners"] },
  { label: "General Catalyst", aliases: ["GC"] },
  { label: "Khosla Ventures", aliases: ["Khosla"] },
  { label: "Index Ventures", aliases: ["Index"] },
  { label: "Accel" },
  { label: "Greylock", aliases: ["GreylockX"] },
  // Rudy Pathak's headline reads "Z Fellow | Pareto Fellow"; it was offered to the
  // review queue as a company.
  { label: "Pareto Fellowship", aliases: ["Pareto Fellow"] },
  { label: "Benchmark" },
  { label: "Bessemer", aliases: ["Bessemer Venture Partners", "BVP"] },
];

/**
 * Companies and funds whose name alone is signal for this population. Seeded so
 * the first profile mentioning one does not arrive as an unknown term, and so
 * the common short forms fold onto the full legal name.
 */
export const COMPANIES: Seed[] = [
  { label: "Google", aliases: ["Alphabet"] },
  { label: "McKinsey & Company", aliases: ["McKinsey"] },
  { label: "Jane Street" },
  { label: "Citadel" },
  { label: "Two Sigma" },
  { label: "Jump Trading" },
  { label: "Hudson River Trading", aliases: ["HRT"] },
  { label: "OpenAI" },
  { label: "Anthropic" },
  { label: "DeepMind", aliases: ["Google DeepMind"] },
  { label: "Palantir" },
  { label: "Nvidia" },
  { label: "Meta", aliases: ["Facebook"] },
  { label: "Apple" },
  { label: "Microsoft" },
  { label: "Amazon" },
  { label: "Stripe" },
  { label: "Goldman Sachs" },
  { label: "Regeneron" },
  { label: "Bain & Company", aliases: ["Bain"] },
  { label: "Boston Consulting Group", aliases: ["BCG"] },
  // Research employers, which were missing: Thomas Wang does ML for asteroid and
  // black hole discovery at NASA and it counted for nothing.
  { label: "NASA", aliases: ["National Aeronautics and Space Administration"] },
  { label: "Tencent" },
  { label: "IBM", aliases: ["IBM Research"] },
  { label: "Intel" },
  { label: "SpaceX" },
  { label: "Tesla" },
  { label: "Waymo" },
  { label: "Bell Labs", aliases: ["Nokia Bell Labs"] },
  { label: "Bloomberg", aliases: ["Bloomberg LP", "Bloomberg L.P."] },
  { label: "Citadel Securities" },
  { label: "D. E. Shaw", aliases: ["DE Shaw", "D.E. Shaw"] },
  { label: "Susquehanna", aliases: ["SIG", "Susquehanna International Group"] },
  { label: "Databricks" },
  { label: "Snowflake" },
];
