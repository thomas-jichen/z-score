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
  { label: "USAPhO", aliases: ["USA Physics Olympiad"] },
  { label: "USABO", aliases: ["USA Biolympiad", "USA Biology Olympiad"] },
  { label: "IMO", aliases: ["International Mathematical Olympiad"] },
  { label: "IOI", aliases: ["International Olympiad in Informatics"] },
  // The other three internationals, which carry the same weight as IMO and IOI and
  // were simply missing — an IPhO medallist scored nothing for it.
  { label: "IPhO", aliases: ["International Physics Olympiad"] },
  { label: "IBO", aliases: ["International Biology Olympiad", "IBmO"] },
  { label: "IChO", aliases: ["International Chemistry Olympiad"] },
  { label: "Mathcamp", aliases: ["Canada/USA Mathcamp"] },
  { label: "SPARC", aliases: ["Summer Program on Applied Rationality and Cognition"] },
  { label: "TASP", aliases: ["Telluride Association Summer Program", "TASS"] },
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
   * Hackathons and open competitions.
   *
   * Missing entirely, which is how Jacob Lee could win a TreeHacks track, place at
   * CalHacks and reach the Breakthrough Junior final and score nothing for any of
   * them. Priced for the median person who lists one: getting into TreeHacks is
   * selective, winning a track is much more so, and one tag covers both.
   */
  { label: "TreeHacks", aliases: ["Stanford TreeHacks"] },
  { label: "CalHacks", aliases: ["Cal Hacks", "Berkeley CalHacks"] },
  { label: "HackMIT" },
  { label: "PennApps" },
  { label: "Hack the North" },
  { label: "LA Hacks", aliases: ["LAHacks"] },
  { label: "MHacks" },
  { label: "HackHarvard" },
  { label: "Breakthrough Junior Challenge", aliases: ["Breakthrough Junior"] },
  { label: "John Locke Institute", aliases: ["John Locke Essay Competition", "John Locke Institute Essay Competition"] },
  { label: "Congressional App Challenge" },
  { label: "Science Olympiad" },
  { label: "Science Bowl", aliases: ["National Science Bowl"] },
  { label: "DECA", aliases: ["DECA ICDC", "International Career Development Conference"] },
  { label: "FBLA", aliases: ["Future Business Leaders of America"] },
  { label: "HOSA" },
  { label: "AIME", aliases: ["AIME Qualifier", "American Invitational Mathematics Examination"] },
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
  { label: "CMU Robotics Institute", aliases: ["Robotics Institute"] },
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
    aliases: ["Andreessen Horowitz", "a16z Speedrun", "Speedrun", "a16z SPEEDRUN"],
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
];
