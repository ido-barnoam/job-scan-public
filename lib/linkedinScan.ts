// The LinkedIn scan: Ido's saved LinkedIn searches, any company. Runs separately from the
// board scan (own cron, email and report) but shares its history, Jev questions, cut-offs,
// role statuses, usage guardrails and 30-day dedup.

import { AGENCIES, AGENCY_WORDS, DEDUP_DAYS, FIT_LEVELS, LINKEDIN_ACTOR, LINKEDIN_SEARCHES, PROFILE, THRESHOLDS, USAGE_LIMITS } from "../config/settings";
import { ask, BudgetExceeded, pool, setBudget, usage, type NoulAnswer, type Question, type ScoreAnswer } from "./jev";
import { runLinkedInSearch, searchLabel, type LinkedInJob } from "./linkedin";
import { classifyLocation } from "./location";
import {
  DESCRIPTION_NOTE,
  israelDate,
  JOB_QUESTIONS,
  matchCompany,
  prepareRun,
  PROFILE_VERSION,
  REMOTE_QUESTION,
  runId,
  skippedReport,
  tierFor,
  titleKey,
  withDescription,
  type ScanResult,
} from "./scan";
import type { BoardResult, JobResult, RawJob, RunReport } from "./types";

const isAgency = (company: string) =>
  AGENCY_WORDS.test(company) || AGENCIES.some((a) => company.toLowerCase().includes(a.toLowerCase()));

interface Options {
  dryRun: boolean;
  week?: boolean; // search the past week instead of the past day
  searchLimit?: number; // only run the first N searches (for testing)
  runCapUsd?: number;
}

export async function runLinkedInScan(opts: Options): Promise<ScanResult> {
  const started = new Date();
  const cpuStart = process.cpuUsage();
  const { errors, warnings, history, storedBytes, monthPrior, emailsToday, jevLeft, stopped: guard, seen } = await prepareRun(started);
  setBudget(USAGE_LIMITS.jev.usdPerMillionInputTokens, Math.max(0, Math.min(USAGE_LIMITS.jev.perRunCapUsd, opts.runCapUsd ?? Infinity, jevLeft)));

  const searches = LINKEDIN_SEARCHES.slice(0, opts.searchLimit ?? LINKEDIN_SEARCHES.length);
  // Apify guard: stay under the free plan's monthly credit, assuming a full run.
  const A = USAGE_LIMITS.apify;
  const worstCase = searches.length * (A.usdPerStart + 200 * A.usdPerResult);
  let stopped = guard;
  if (!stopped && monthPrior.apify.usd + worstCase > A.monthlyCreditUsd * USAGE_LIMITS.stopAtShare)
    stopped = `Apify: about $${monthPrior.apify.usd.toFixed(2)} of the $${A.monthlyCreditUsd} free monthly credit is used`;
  if (stopped) return { report: skippedReport(started, opts.dryRun, "linkedin", errors, storedBytes, stopped, warnings), cpuStart, monthPrior, emailsToday };

  // Postings handled by earlier LinkedIn runs are skipped by the actor itself. Jobs Jev couldn't
  // judge are left out of that list, so they come back and get judged next time.
  const cutoff = started.getTime() - DEDUP_DAYS * 86400_000;
  const linkedinRuns = history.filter((r) => r.kind === "linkedin" && !r.dryRun);
  const skipIds = new Set<string>();
  for (const r of linkedinRuns)
    if (new Date(r.startedAt).getTime() >= cutoff)
      for (const j of r.jobs) if (j.reason !== "not_judged") skipIds.add(j.key.replace(/^linkedin:/, ""));
  // Daily runs look back one day. With no LinkedIn run in the last 30 hours (the first run, or a
  // missed day) they look back a week; skipIds keeps that from repeating anything.
  const lastRun = Math.max(0, ...linkedinRuns.map((r) => new Date(r.startedAt).getTime()));
  const week = opts.week || started.getTime() - lastRun > 30 * 3600_000;
  const datePosted = week ? "r604800" : "r86400";

  // 1. Run the searches and merge them by posting id. Apify's free plan allows 5 actor runs at
  // once, so at most 4 run together. Every search must finish by the deadline, leaving the rest
  // of the function's 300 seconds for Jev and saving the run.
  const deadline = started.getTime() + 210_000;
  const fetched = await pool(searches, 4, async (s) => {
    const timeoutSec = Math.floor((deadline - Date.now()) / 1000);
    if (timeoutSec < 30) return { s, jobs: [] as LinkedInJob[], error: "Skipped: not enough time left in this run" as string | undefined };
    try {
      return { s, jobs: await runLinkedInSearch(s, { datePosted, skipIds: [...skipIds], timeoutSec }), error: undefined as string | undefined };
    } catch (e) {
      return { s, jobs: [] as LinkedInJob[], error: String(e).slice(0, 300) };
    }
  });
  const merged = new Map<string, { j: LinkedInJob; searches: string[] }>();
  for (const { s, jobs } of fetched)
    for (const j of jobs) {
      if (skipIds.has(j.id)) continue;
      const m = merged.get(j.id);
      if (m) m.searches.push(s.keywords);
      else merged.set(j.id, { j, searches: [s.keywords] });
    }

  // 2. Judge each posting with its full text (LinkedIn's data includes it, so there is no separate title pass).
  let budgetHits = 0;
  const results = await pool([...merged.values()], 16, async ({ j, searches: found }): Promise<JobResult> => {
    const listed = matchCompany(j.companyName);
    const company = listed?.name ?? j.companyName ?? "—";
    const raw = { location: j.location ?? "" } as RawJob;
    const loc = classifyLocation(raw);
    const base: JobResult = {
      key: `linkedin:${j.id}`,
      company,
      rating: listed?.rating ?? 0,
      ats: "linkedin",
      title: j.title,
      location: j.location || "—",
      url: j.url,
      locationClass: loc,
      tier: "dropped",
      source: "linkedin",
      linkedin: {
        searches: found,
        postedDate: j.postedDate,
        experienceLevel: j.experienceLevel,
        sector: j.sector,
        applyType: j.applyType,
        applicants: j.applicationsCount,
      },
    };
    if (isAgency(j.companyName ?? "")) return { ...base, reason: "agency" };
    if (loc === "elsewhere") return { ...base, reason: "not_israel" };
    const reported = seen.has(base.key) || seen.has(titleKey(company, j.title));

    const description = (j.description ?? "").slice(0, 6000);
    const qs: Record<string, Question> = description
      ? { fit: withDescription(JOB_QUESTIONS.fit), excluded: withDescription(JOB_QUESTIONS.excluded) }
      : { ...JOB_QUESTIONS };
    if (loc === "ambiguous") qs.remote_ok = description ? withDescription(REMOTE_QUESTION) : REMOTE_QUESTION;
    try {
      const a = await ask({ candidate: PROFILE, job: { company, title: j.title, location: j.location, description: description || undefined } }, qs);
      const fit = a.fit as ScoreAnswer;
      Object.assign(base, {
        fit: fit.score,
        fitConfidence: fit.confidence,
        fitProbs: fit.probabilities,
        excluded: (a.excluded as NoulAnswer).noul,
        remoteOk: a.remote_ok ? (a.remote_ok as NoulAnswer).noul : undefined,
        verified: !!description,
      });
      const pass = { fit: base.fit, fitConfidence: base.fitConfidence, fitProbs: base.fitProbs, excluded: base.excluded, remoteOk: base.remoteOk };
      if (description) base.postingPass = { ...pass, chars: description.length };
      else base.titlePass = pass;
    } catch (e) {
      if (e instanceof BudgetExceeded) budgetHits++;
      else errors.push(`Judgment failed for ${company} / ${j.title}: ${String(e).slice(0, 200)}`);
    }
    return { ...base, ...tierFor(base, reported) };
  });

  if (budgetHits) warnings.push(`Jev budget reached during the run: ${budgetHits} checks were skipped`);
  const notJudged = results.filter((r) => r.reason === "not_judged").length;
  if (notJudged) warnings.push(`${notJudged} jobs could not be judged by Jev and are listed under Dropped → Not judged`);

  // One row per search in the "Searches" tab.
  const searchRows: BoardResult[] = fetched.map(({ s, jobs, error }) => {
    const mine = results.filter((r) => r.linkedin?.searches.includes(s.keywords));
    return {
      company: searchLabel(s),
      ats: "linkedin",
      slug: `linkedin:${s.keywords}`,
      rating: 0,
      status: error ? "failed" : jobs.length ? "ok" : "empty",
      error,
      total: jobs.length,
      israel: mine.filter((r) => r.locationClass === "israel").length,
      ambiguous: mine.filter((r) => r.locationClass === "ambiguous").length,
      elsewhere: mine.filter((r) => r.locationClass === "elsewhere").length,
    };
  });

  const count = (t: JobResult["tier"]) => results.filter((r) => r.tier === t).length;
  const report: RunReport = {
    id: runId(started, "linkedin"),
    kind: "linkedin",
    date: israelDate(started),
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    env: process.env.VERCEL_ENV ?? "local",
    dryRun: opts.dryRun,
    profileVersion: PROFILE_VERSION,
    thresholds: { ...THRESHOLDS },
    boards: searchRows,
    jobs: results.sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1)),
    stats: {
      boards: searches.length,
      boardsCovered: searchRows.filter((b) => b.status !== "failed").length,
      jobsRead: fetched.reduce((n, f) => n + f.jobs.length, 0),
      judged: results.filter((r) => r.fit !== undefined).length,
      verified: results.filter((r) => r.verified).length,
      cachedJudgments: 0,
      strong: count("strong"),
      look: count("look"),
      seen: count("seen"),
      dropped: count("dropped"),
      jevCalls: usage.calls,
      jevErrors: usage.errors,
      inputTokens: usage.input,
      outputTokens: usage.output,
    },
    errors: [...errors, ...fetched.filter((f) => f.error).map((f) => `LinkedIn search "${f.s.keywords}" failed: ${f.error}`)],
    blobStoredBytes: storedBytes,
    guard: { warnings },
    method: {
      profile: PROFILE,
      fitLevels: FIT_LEVELS,
      questions: {
        fit: JOB_QUESTIONS.fit.instructions,
        excluded: JOB_QUESTIONS.excluded.instructions,
        remote_ok: REMOTE_QUESTION,
        full_posting_note: DESCRIPTION_NOTE,
        linkedin_actor: LINKEDIN_ACTOR,
        linkedin_searches: searches,
        linkedin_date_posted: datePosted,
        linkedin_skipped_ids: skipIds.size,
        agencies: { names: AGENCIES, words: String(AGENCY_WORDS) },
      },
    },
  };
  return { report, cpuStart, monthPrior, emailsToday };
}
