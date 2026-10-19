export type Ats = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "web" | "linkedin";

export interface Board {
  company: string;
  ats: Ats;
  slug: string;
  rating: number;
}

// A posting as read from a board, before any judgment.
export interface RawJob {
  key: string; // ats:slug:id, stable across days
  id: string;
  title: string;
  location: string;
  team?: string;
  url: string;
  remote?: boolean;
  country?: string; // ISO code when the ATS gives one
  description?: string; // when the list API includes it (Lever, Ashby)
  companyName?: string; // when the API names the company (SmartRecruiters)
}

export type LocationClass = "israel" | "ambiguous" | "elsewhere";

export type Tier = "strong" | "look" | "seen" | "dropped";

export type DropReason = "low_fit" | "excluded" | "not_israel" | "wrong_company" | "not_judged" | "not_on_list" | "closed" | "unreadable" | "agency";

// One set of Jev answers about a job (title pass or full-posting pass).
export interface Judgment {
  fit?: number;
  fitConfidence?: number;
  fitProbs?: Record<string, number>;
  excluded?: number;
  remoteOk?: number;
}

export interface JobResult {
  key: string;
  company: string;
  rating: number;
  ats: Ats;
  title: string;
  location: string;
  team?: string;
  url: string;
  locationClass: LocationClass;
  remoteOk?: number; // Noul, only for ambiguous locations
  fit?: number; // 0..3
  fitConfidence?: number;
  fitProbs?: Record<string, number>;
  excluded?: number; // Noul
  titleFit?: number; // the title-only score, kept when the description pass re-scores a job
  titleFitConfidence?: number;
  verified?: boolean; // re-scored with the full job description
  cached?: boolean;
  // Decision trail, for the "how Jev decided" view.
  source?: "board" | "web" | "linkedin";
  titlePass?: Judgment;
  postingPass?: Judgment & { chars: number };
  boardMatch?: number;
  web?: {
    query?: string;
    snippet?: string;
    pageChars: number;
    companyProbs?: Record<string, number>; // Jev's choice among candidate companies ("none" included)
    statusProbs?: Record<string, number>; // open / closed / unclear
    v?: number; // 2 = judged from the job's own data where available
    fromData?: "comeet" | "greenhouse" | "lever" | "ashby" | "smartrecruiters"; // where the job's details were read from
    dataCompany?: string; // company name as the job's data gives it
    expandedFrom?: string; // careers page this job was listed on
    closedByData?: boolean; // the link is to a job no longer in the company's live data
    collapsedJobs?: number; // careers page at a company not on the list, kept as one row
    pageTitle?: string; // the search result's own title, before Jev picked the job title
    titleProbs?: Record<string, number>; // Jev's choice among candidate job titles ("none" included)
  };
  linkedin?: {
    searches: string[]; // which saved searches returned it
    postedDate?: string;
    experienceLevel?: string;
    sector?: string;
    applyType?: string; // EASY_APPLY or EXTERNAL
    applicants?: string;
  };
  tier: Tier;
  reason?: DropReason;
}

export type BoardStatus = "ok" | "empty" | "failed" | "wrong_company";

export interface BoardResult {
  company: string;
  ats: Ats;
  slug: string;
  rating: number;
  status: BoardStatus;
  error?: string;
  total: number;
  israel: number;
  ambiguous: number;
  elsewhere: number;
  boardMatch?: number; // Noul: do the listings belong to this company
}

export interface Usage {
  jev: { calls: number; inputTokens: number; outputTokens: number; usd: number };
  vercel: {
    runs: number; // function invocations by the scan (report page views are not counted)
    durationSec: number;
    activeCpuSec: number;
    memoryGbHours: number;
    blobAdvancedOps: number;
    blobSimpleOps: number;
    blobBytesRead: number;
    blobBytesWritten: number;
  };
  resend: { emails: number };
  tavily: { searches: number };
  apify: { runs: number; results: number; usd: number }; // usd is estimated from the actor's published prices
}

export interface RunReport {
  id: string; // e.g. 2026-09-23T01-00-05Z, or 2026-09-23T02-30-05Z-linkedin
  kind?: "boards" | "linkedin"; // missing on runs saved before the LinkedIn scan existed: boards
  date: string; // YYYY-MM-DD in Israel time
  startedAt: string;
  finishedAt: string;
  env: string;
  dryRun: boolean;
  profileVersion: string;
  thresholds: Record<string, number>;
  boards: BoardResult[];
  jobs: JobResult[];
  stats: {
    boards: number;
    boardsCovered: number;
    jobsRead: number;
    judged: number;
    verified: number;
    cachedJudgments: number;
    strong: number;
    look: number;
    seen: number;
    dropped: number;
    jevCalls: number;
    jevErrors: number;
    inputTokens: number;
    outputTokens: number;
  };
  errors: string[];
  emailed?: { id?: string; error?: string };
  usage?: Usage; // this run
  monthUsage?: Usage; // calendar month to date (UTC), including this run
  blobStoredBytes?: number;
  guard?: { stopped?: string; warnings: string[] };
  // What Jev was asked this run, so the report can show it.
  method?: { profile: string; fitLevels: string[]; questions: Record<string, unknown> };
}
