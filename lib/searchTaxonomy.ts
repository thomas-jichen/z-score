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

/** Selective programs, competitions and credentials. */
export const PROGRAMS: string[] = [
  "RSI",
  "STS",
  "ISEF",
  "SSP",
  "MIT PRIMES",
  "PROMYS",
  "Simons Fellow",
  "Garcia Program",
  "Jane Street",
  "USAMO",
  "USACO Platinum",
  "USAPhO",
  "USABO",
  "IMO",
  "IOI",
  "Mathcamp",
  "SPARC",
  "TASP",
  "Hack Club",
  "Neo Scholar",
  "Thiel Fellow",
  "Z Fellow",
  "Coca-Cola Scholar",
  "QuestBridge",
  "Diamond Challenge",
  "Conrad Challenge",
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

export const COLLEGES: string[] = [
  "MIT",
  "Stanford",
  "Harvard",
  "Caltech",
  "Princeton",
  "Yale",
  "Berkeley",
  "Carnegie Mellon",
  "Cornell",
  "Columbia",
  "UPenn",
  "UChicago",
  "Waterloo",
  "Georgia Tech",
  "UIUC",
  "Michigan",
  "UT Austin",
  "Duke",
  "Brown",
  "Olin",
];

export const HIGH_SCHOOLS: string[] = [
  "TJHSST",
  "Stuyvesant",
  "Bronx Science",
  "Brooklyn Tech",
  "Hunter College High School",
  "Phillips Exeter",
  "Phillips Andover",
  "Harker",
  "IMSA",
  "Bergen County Academies",
  "NCSSM",
  "Montgomery Blair",
  "Lexington High School",
  "Mission San Jose",
  "Canyon Crest",
  "Whitney High School",
  "Choate",
  "Deerfield",
  "Lawrenceville",
  "Groton",
  "Milton Academy",
  "Horace Mann",
  "Dalton",
  "Sidwell Friends",
  "Menlo School",
  "Castilleja",
  "Nueva",
  "BASIS Scottsdale",
  "Gunn High School",
  "Palo Alto High School",
  "Saratoga High School",
  "Lynbrook",
  "Monta Vista",
  "Torrey Pines",
  "Plano West",
  "LASA",
  "TAMS",
  "High Technology High School",
  "Ward Melville",
  "Westview High School",
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

export type Seed = { label: string; aliases?: string[] };

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
  { label: "Y Combinator", aliases: ["YC"] },
  { label: "Dorm Room Fund" },
  { label: "a16z", aliases: ["Andreessen Horowitz"] },
  { label: "Sequoia", aliases: ["Sequoia Capital"] },
  { label: "Goldman Sachs" },
  { label: "Regeneron" },
  { label: "Bain & Company", aliases: ["Bain"] },
  { label: "Boston Consulting Group", aliases: ["BCG"] },
];
