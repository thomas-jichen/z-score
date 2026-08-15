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

/** Selective programs, competitions and credentials. */
export const PROGRAMS: Seed[] = [
  { label: "RSI", aliases: ["Research Science Institute"] },
  { label: "STS", aliases: ["Regeneron Science Talent Search", "Science Talent Search", "Regeneron STS"] },
  { label: "ISEF", aliases: ["International Science and Engineering Fair", "Regeneron ISEF"] },
  { label: "SSP", aliases: ["Summer Science Program"] },
  { label: "MIT PRIMES", aliases: ["PRIMES"] },
  { label: "PROMYS", aliases: ["Program in Mathematics for Young Scientists"] },
  { label: "Simons Fellow", aliases: ["Simons Summer Research Program", "Simons Summer Research"] },
  { label: "Garcia Program", aliases: ["Garcia Summer Scholar", "Garcia Center"] },
  { label: "Jane Street", aliases: ["AMP", "Academy of Math and Programming"] },
  { label: "USAMO", aliases: ["USA Mathematical Olympiad"] },
  { label: "USACO Platinum", aliases: ["USA Computing Olympiad Platinum"] },
  { label: "USAPhO", aliases: ["USA Physics Olympiad"] },
  { label: "USABO", aliases: ["USA Biolympiad", "USA Biology Olympiad"] },
  { label: "IMO", aliases: ["International Mathematical Olympiad"] },
  { label: "IOI", aliases: ["International Olympiad in Informatics"] },
  { label: "Mathcamp", aliases: ["Canada/USA Mathcamp"] },
  { label: "SPARC", aliases: ["Summer Program on Applied Rationality and Cognition"] },
  { label: "TASP", aliases: ["Telluride Association Summer Program", "TASS"] },
  { label: "Hack Club" },
  { label: "Neo Scholar", aliases: ["Neo Scholars"] },
  { label: "Thiel Fellow", aliases: ["Thiel Fellowship"] },
  { label: "Z Fellow", aliases: ["Z Fellows", "Z-Fellow", "ZFellows", "Z Fellowship"] },
  { label: "Coca-Cola Scholar", aliases: ["Coca-Cola Scholars", "Coke Scholar"] },
  { label: "QuestBridge", aliases: ["QuestBridge Scholar", "QuestBridge National College Match"] },
  { label: "Diamond Challenge" },
  { label: "Conrad Challenge", aliases: ["Conrad Spirit of Innovation Challenge"] },
  { label: "MOP", aliases: ["Mathematical Olympiad Program", "Math Olympiad Summer Program", "MOSP"] },
  { label: "Davidson Fellow", aliases: ["Davidson Fellows"] },
  { label: "Presidential Scholar", aliases: ["U.S. Presidential Scholar", "United States Presidential Scholar"] },
  { label: "Rise", aliases: ["Rise Global Winner", "Schmidt Futures Rise"] },
  { label: "Coolidge Scholar", aliases: ["Coolidge Scholarship", "Coolidge Senator"] },
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
