// Everything you are likely to tune lives here.

// Where the daily email goes. Set RECIPIENT_EMAIL in your Vercel project settings.
// With Resend's free test sender (onboarding@resend.dev) this must be the email you signed up to Resend with.
export const RECIPIENT = process.env.RECIPIENT_EMAIL ?? "";

// EXAMPLE — replace with your own. What Jev compares every job against: the roles you want,
// at what level, and what is not a fit. Changing this text re-scores every job on the next run.
export const PROFILE =
  "EXAMPLE: Senior individual contributor or manager in customer success operations and revenue operations " +
  "at tech companies in Israel. Targets: CS Ops, RevOps, GTM Ops, Business Operations, Sales Ops, Support Ops. " +
  "Director and Head of roles in these functions are a strong fit. " +
  "Not a fit: engineering, IT or security operations, finance, HR, pure quota-carrying sales, office admin, entry-level.";

// EXAMPLE — replace with your own. Role types you never want, asked as a separate yes/no question.
export const EXCLUDED_ROLE_TYPES =
  "an engineering, IT/DevOps/SecOps-type operations, finance or accounting, HR or people, office admin, or entry-level role";

export const FIT_LEVELS = [
  "Unrelated function",
  "Adjacent function the candidate could stretch into but is not targeting",
  "Target function but too junior: analyst, coordinator, specialist, associate or representative level",
  "Target function at senior IC, manager, director, head of or VP level",
];

// Tiers. fit is 0..3 (see FIT_LEVELS), excluded is the probability the title is an excluded role type.
export const THRESHOLDS = {
  strongFit: 2.5, // fit >= this and excluded < strongMaxExcluded -> strong
  strongMaxExcluded: 0.5,
  lookFit: 1.5, // fit >= this (and not strong) and excluded < lookMaxExcluded -> worth a look
  lookMaxExcluded: 0.7,
  remoteOk: 0.64, // unclear locations ("Remote", "EMEA", web finds with no location) count as doable from Israel at or above this
  boardMatch: 0.3, // a board whose listings look like a different company below this is flagged
};

// Jobs already reported by earlier scans are not emailed again for this many days.
export const DEDUP_DAYS = 30;

// Usage limits and guardrails. Jev is the only paid service; Vercel Hobby and the
// Resend free plan cannot bill, so for them the guardrail keeps usage under the free quota.
export const USAGE_LIMITS = {
  jev: {
    usdPerMillionInputTokens: 0.042, // jev-1.13 price; output tokens are free
    monthlyBudgetUsd: 5, // hard cap: Jev calls stop once this month's spend reaches it
    perRunCapUsd: 0.5, // one run may never spend more than this
  },
  vercel: {
    // Hobby plan included usage per month
    activeCpuHours: 4,
    provisionedMemoryGbHours: 360,
    invocations: 1_000_000,
    blobStorageGb: 1,
    blobSimpleOps: 10_000,
    blobAdvancedOps: 2_000,
    blobTransferGb: 10,
  },
  resend: { emailsPerMonth: 3_000, emailsPerDay: 100 },
  tavily: { searchesPerMonth: 1_000 }, // free plan: 1,000 credits/month, 1 credit per basic search
  stopAtShare: 0.9, // skip the scan (Vercel), the email (Resend) or the web searches (Tavily) at 90% of a free quota
};

// EXAMPLE — replace with searches for your own roles. Web searches (Tavily) find jobs at your companies
// whose job boards are not in config/boards.json. "domains" limits a search to those sites.
export const WEB_SEARCHES: { query: string; domains?: string[] }[] = [
  { query: 'Israel "revenue operations" OR "business operations" OR "customer success operations"', domains: ["job-boards.greenhouse.io", "boards.greenhouse.io"] },
  { query: 'Israel "operations manager" OR "revenue operations" OR "GTM operations"', domains: ["jobs.lever.co"] },
  { query: "Israel operations manager", domains: ["jobs.ashbyhq.com"] },
  { query: 'Israel "operations manager" OR "revenue operations" OR "customer success operations"', domains: ["comeet.com"] },
  { query: 'Israel "business operations" OR "sales operations"', domains: ["jobs.smartrecruiters.com"] },
  { query: '"customer success operations" OR "revenue operations" OR "GTM operations" jobs Israel Tel Aviv' },
];
