import { createHash } from "node:crypto";
import boardsJson from "../config/boards.json";
import companiesJson from "../config/companies.json";
import reportedJson from "../config/reported.json";
import { DEDUP_DAYS, EXCLUDED_ROLE_TYPES, FIT_LEVELS, PROFILE, THRESHOLDS, USAGE_LIMITS, WEB_SEARCHES } from "../config/settings";
import { fetchBoard, fetchDescription, stripHtml } from "./boards";
import { ask, BudgetExceeded, pool, setBudget, usage, type ChoiceAnswer, type NoulAnswer, type Question, type ScoreAnswer } from "./jev";
import { classifyLocation } from "./location";
import { blobUsage, listRuns, loadRun, type RunEntry } from "./store";
import { runWebSearches, tavilyUsage, type WebFind } from "./web";
import { resolveFind, type ResolvedFind } from "./webdata";
import { isLinkedIn } from "./links";
import { addUsage, emptyUsage, monthOf, usageOfRun, vercelOverLimit } from "./usage";
import type { Board, BoardResult, JobResult, LocationClass, RawJob, RunReport, Usage } from "./types";

const BOARDS = boardsJson as Board[];
const REPORTED = reportedJson as { company: string; title: string; url: string }[];
const COMPANIES = companiesJson as { name: string; rating: number }[];

const JOB_QUESTIONS: Record<string, Question> = {
  fit: {
    type: "score",
    instructions: "How well does the job in `job` fit the career target described in `candidate`? Judge by the job's function and seniority.",
    criteria: FIT_LEVELS,
  },
  excluded: {
    type: "noul",
    instructions: `Is the job in \`job\` ${EXCLUDED_ROLE_TYPES}?`,
  },
};
const REMOTE_QUESTION: Question = {
  type: "noul",
  instructions: "Based on its location (and description, if given), can the job in `job` be done by someone living and working in Israel?",
  criteria: {
    true: "The location includes Israel, or the role is remote with no country restriction, or remote across a region that includes Israel (such as EMEA)",
    false: "On-site or hybrid in cities outside Israel, or remote but restricted to specific other countries (such as US-remote or UK-remote)",
  },
};
const BOARD_QUESTION: Question = {
  type: "noul",
  instructions:
    "Do the job postings in `listings` belong to the company named `company`, rather than a different organization that happens to use a similar name or board address?",
};

// Second pass: the shortlist is re-judged with the full posting text.
const DESCRIPTION_NOTE =
  "`job.description` is the full posting text. Judge the actual responsibilities described there, not only the title.";
const withDescription = (q: Question): Question => ({ ...q, instructions: { question: q.instructions, note: DESCRIPTION_NOTE } });
const VERIFY_MIN_FIT = 1.2; // Israel jobs just under the "worth a look" line also get a second look

// Web-search finds (Tavily): which listed company posted it, and is it still open.
const WEB_COMPANY_INSTRUCTIONS =
  "Which company in `companies` is hiring for the job in `job` (search-result title, snippet, URL and page text)? " +
  "Answer none if it is a different company, a job board listing many companies' jobs, or not a job posting.";
const WEB_TITLE_INSTRUCTIONS =
  "Which option is the title of the job advertised in `job` (its search-result title, snippet and page text)? " +
  "Pick the role's name as a hiring company would write it, not a page name, a company name or a sentence. Answer none if no option is the job's title.";
const WEB_STATUS_QUESTION: Question = {
  type: "choice",
  instructions: "Is the job in `job` still open, based on `job.description` (the text of its page)?",
  criteria: {
    open: "The page shows this specific job as currently open",
    closed: "The page says this job is closed, filled, expired or no longer accepting applications",
    unclear: "The page does not show the job itself (an empty careers page, a list of other jobs, a login wall, or it could not be fetched)",
  },
};

export const PROFILE_VERSION = createHash("sha1")
  .update(JSON.stringify([PROFILE, JOB_QUESTIONS, REMOTE_QUESTION, DESCRIPTION_NOTE]))
  .digest("hex")
  .slice(0, 8);

const israelDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);

interface Options {
  dryRun: boolean;
  boardLimit?: number;
  runCapUsd?: number; // lower per-run Jev cap, for testing the guardrail
  fresh?: boolean; // ignore earlier runs' answers and ask Jev again
}

export interface ScanResult {
  report: RunReport;
  cpuStart: NodeJS.CpuUsage;
  monthPrior: Usage; // this calendar month's usage before this run
  emailsToday: number; // emails already sent today (UTC), for the Resend daily quota
}

export async function runScan(opts: Options): Promise<ScanResult> {
  const started = new Date();
  const cpuStart = process.cpuUsage();
  const errors: string[] = [];
  const warnings: string[] = [];
  usage.calls = usage.errors = usage.input = usage.output = 0;
  tavilyUsage.searches = 0;
  blobUsage.advanced = blobUsage.simple = blobUsage.bytesRead = blobUsage.bytesWritten = 0;

  // History: what was already reported, yesterday's judgments to reuse, and this month's usage.
  let history: RunReport[] = [];
  let storedBytes = 0;
  const month = monthOf(started.toISOString());
  try {
    const all: RunEntry[] = await listRuns();
    storedBytes = all.reduce((n, e) => n + e.size, 0);
    const entries = all.filter((e, i) => i < 40 || monthOf(e.uploadedAt.toISOString()) === month);
    history = (await pool(entries, 8, (e) => loadRun(e).catch(() => null))).filter(Boolean) as RunReport[];
  } catch (e) {
    errors.push(`Could not read run history: ${String(e)}`);
  }
  const thisMonth = history.filter((r) => monthOf(r.startedAt) === month);
  const monthPrior = thisMonth.map(usageOfRun).reduce(addUsage, emptyUsage());
  const today = started.toISOString().slice(0, 10);
  const emailsToday = thisMonth.filter((r) => r.startedAt.startsWith(today) && r.emailed?.id).length;

  // Guardrails, checked before any work.
  const J = USAGE_LIMITS.jev;
  const jevLeft = J.monthlyBudgetUsd - monthPrior.jev.usd;
  setBudget(J.usdPerMillionInputTokens, Math.max(0, Math.min(J.perRunCapUsd, opts.runCapUsd ?? Infinity, jevLeft)));
  let stopped = vercelOverLimit(monthPrior, storedBytes);
  if (!stopped && jevLeft <= 0) stopped = `Jev monthly budget of $${J.monthlyBudgetUsd} is used up ($${monthPrior.jev.usd.toFixed(2)} spent)`;
  if (!stopped && jevLeft < J.monthlyBudgetUsd * 0.2) warnings.push(`Only $${jevLeft.toFixed(2)} of the $${J.monthlyBudgetUsd} Jev budget is left this month`);
  if (stopped) {
    return {
      report: {
        id: started.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z"),
        date: israelDate(started),
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        env: process.env.VERCEL_ENV ?? "local",
        dryRun: opts.dryRun,
        profileVersion: PROFILE_VERSION,
        thresholds: { ...THRESHOLDS },
        boards: [],
        jobs: [],
        stats: { boards: 0, boardsCovered: 0, jobsRead: 0, judged: 0, verified: 0, cachedJudgments: 0, strong: 0, look: 0, seen: 0, dropped: 0, jevCalls: 0, jevErrors: 0, inputTokens: 0, outputTokens: 0 },
        errors,
        blobStoredBytes: storedBytes,
        guard: { stopped: `Scan skipped: ${stopped}`, warnings },
      },
      cpuStart,
      monthPrior,
      emailsToday,
    };
  }
  let budgetHits = 0;
  const cutoff = started.getTime() - DEDUP_DAYS * 86400_000;
  const seen = new Set<string>();
  for (const r of history) {
    if (r.dryRun || new Date(r.startedAt).getTime() < cutoff) continue;
    for (const j of r.jobs) if ((j.tier === "strong" || j.tier === "look") && r.emailed?.id) seen.add(j.key);
  }
  const cache = new Map<string, JobResult>();
  for (const r of [...history].reverse()) {
    if (opts.fresh || r.profileVersion !== PROFILE_VERSION) continue;
    for (const j of r.jobs) if (j.fit !== undefined) cache.set(`${j.key}|${j.web?.pageTitle ?? j.title}|${j.location}`, j);
  }
  const alreadyReported = (j: RawJob) =>
    seen.has(j.key) || REPORTED.some((r) => r.url.includes(j.id) && j.id.length >= 6);

  // 1. Read the boards.
  const boards = BOARDS.slice(0, opts.boardLimit ?? BOARDS.length);
  const fetched = await pool(boards, 10, async (b) => {
    try {
      return { b, jobs: await fetchBoard(b), error: undefined as string | undefined };
    } catch (e) {
      return { b, jobs: [] as RawJob[], error: String(e).slice(0, 300) };
    }
  });

  // 2. Check each board really belongs to the company (catches e.g. a different "EON").
  const boardMatch = new Map<string, number>();
  await pool(
    fetched.filter((f) => f.jobs.length > 0),
    10,
    async ({ b, jobs }) => {
      try {
        const a = await ask(
          { company: b.company, listings: jobs.slice(0, 30).map((j) => ({ title: j.title, location: j.location })) },
          { belongs: BOARD_QUESTION },
        );
        boardMatch.set(b.slug, (a.belongs as NoulAnswer).noul);
      } catch (e) {
        if (e instanceof BudgetExceeded) budgetHits++;
        else errors.push(`Board check failed for ${b.company}: ${String(e).slice(0, 200)}`);
      }
    },
  );

  // 3. Judge every Israel-compatible job.
  const boardResults: BoardResult[] = [];
  const toJudge: { b: Board; j: RawJob; loc: JobResult["locationClass"]; wrong: boolean }[] = [];
  for (const { b, jobs, error } of fetched) {
    const classes = jobs.map((j) => classifyLocation(j));
    const match = boardMatch.get(b.slug);
    const wrong = match !== undefined && match < THRESHOLDS.boardMatch;
    boardResults.push({
      company: b.company,
      ats: b.ats,
      slug: b.slug,
      rating: b.rating,
      status: error ? "failed" : jobs.length === 0 ? "empty" : wrong ? "wrong_company" : "ok",
      error,
      total: jobs.length,
      israel: classes.filter((c) => c === "israel").length,
      ambiguous: classes.filter((c) => c === "ambiguous").length,
      elsewhere: classes.filter((c) => c === "elsewhere").length,
      boardMatch: match,
    });
    jobs.forEach((j, i) => {
      if (classes[i] !== "elsewhere") toJudge.push({ b, j, loc: classes[i], wrong });
    });
  }

  let cachedJudgments = 0;
  const results = await pool(toJudge, 16, async ({ b, j, loc, wrong }): Promise<JobResult> => {
    const base: JobResult = {
      key: j.key,
      company: b.company,
      rating: b.rating,
      ats: b.ats,
      title: j.title,
      location: j.location,
      team: j.team,
      url: j.url,
      locationClass: loc,
      tier: "dropped",
      source: "board",
      boardMatch: boardMatch.get(b.slug),
    };
    if (wrong) return { ...base, reason: "wrong_company" };

    const hit = cache.get(`${j.key}|${j.title}|${j.location}`);
    if (hit) {
      cachedJudgments++;
      Object.assign(base, {
        fit: hit.fit,
        fitConfidence: hit.fitConfidence,
        fitProbs: hit.fitProbs,
        excluded: hit.excluded,
        remoteOk: hit.remoteOk,
        titleFit: hit.titleFit,
        titleFitConfidence: hit.titleFitConfidence,
        verified: hit.verified,
        titlePass: hit.titlePass,
        postingPass: hit.postingPass,
        cached: true,
      });
    } else {
      try {
        const qs: Record<string, Question> = { ...JOB_QUESTIONS };
        if (loc === "ambiguous") qs.remote_ok = REMOTE_QUESTION;
        const a = await ask(
          { candidate: PROFILE, job: { company: b.company, title: j.title, location: j.location, team: j.team } },
          qs,
        );
        const fit = a.fit as ScoreAnswer;
        base.fit = fit.score;
        base.fitConfidence = fit.confidence;
        base.fitProbs = fit.probabilities;
        base.excluded = (a.excluded as NoulAnswer).noul;
        if (a.remote_ok) base.remoteOk = (a.remote_ok as NoulAnswer).noul;
        base.titlePass = { fit: base.fit, fitConfidence: base.fitConfidence, fitProbs: base.fitProbs, excluded: base.excluded, remoteOk: base.remoteOk };
      } catch (e) {
        if (e instanceof BudgetExceeded) budgetHits++;
        else errors.push(`Judgment failed for ${b.company} / ${j.title}: ${String(e).slice(0, 200)}`);
      }
    }
    return { ...base, ...tierFor(base, alreadyReported(j)) };
  });

  // 4. Second pass on the shortlist: re-judge with the full posting text.
  const raw = new Map(toJudge.map((t) => [t.j.key, t]));
  const shortlist = results.filter(
    (r) =>
      !r.verified &&
      r.reason !== "wrong_company" &&
      (r.tier !== "dropped" || (r.locationClass === "israel" && r.reason === "low_fit" && (r.fit ?? 0) >= VERIFY_MIN_FIT)),
  );
  await pool(shortlist, 12, async (r) => {
    const { b, j } = raw.get(r.key)!;
    try {
      const description = (await fetchDescription(b, j)).slice(0, 6000);
      if (!description) return;
      const qs: Record<string, Question> = {
        fit: withDescription(JOB_QUESTIONS.fit),
        excluded: withDescription(JOB_QUESTIONS.excluded),
      };
      if (r.locationClass === "ambiguous") qs.remote_ok = withDescription(REMOTE_QUESTION);
      const a = await ask(
        { candidate: PROFILE, job: { company: b.company, title: j.title, location: j.location, team: j.team, description } },
        qs,
      );
      const fit = a.fit as ScoreAnswer;
      r.titleFit = r.fit;
      r.titleFitConfidence = r.fitConfidence;
      r.fit = fit.score;
      r.fitConfidence = fit.confidence;
      r.fitProbs = fit.probabilities;
      r.excluded = (a.excluded as NoulAnswer).noul;
      if (a.remote_ok) r.remoteOk = (a.remote_ok as NoulAnswer).noul;
      r.postingPass = { fit: r.fit, fitConfidence: r.fitConfidence, fitProbs: r.fitProbs, excluded: r.excluded, remoteOk: r.remoteOk, chars: description.length };
      r.verified = true;
      r.reason = undefined;
      Object.assign(r, tierFor(r, alreadyReported(j)));
    } catch (e) {
      if (e instanceof BudgetExceeded) budgetHits++;
      else errors.push(`Description check failed for ${b.company} / ${j.title}: ${String(e).slice(0, 200)}`);
    }
  });

  // 5. Web search (Tavily) for jobs at listed companies outside the 49 boards.
  let webFinds = 0;
  const T = USAGE_LIMITS.tavily;
  const tavilyFull = monthPrior.tavily.searches + WEB_SEARCHES.length > T.searchesPerMonth * USAGE_LIMITS.stopAtShare;
  if (tavilyFull) warnings.push(`Web searches skipped: Tavily is at ${monthPrior.tavily.searches} of ${T.searchesPerMonth} free searches this month`);
  if (!opts.boardLimit && !tavilyFull) {
    try {
      const search = await runWebSearches();
      errors.push(...search.errors);
      const boardIds = results.map((r) => r.key.split(":")[2]).filter((id) => id && id.length >= 6);
      const scannedBoards = new Set(BOARDS.map((b) => `${b.ats}:${b.slug.toLowerCase()}`));
      const finds = new Map<string, WebFind>();
      for (const f of search.finds) {
        const k = normUrl(f.url);
        if (finds.has(k) || boardIds.some((id) => f.url.includes(id))) continue; // already read from a board
        finds.set(k, f);
      }
      // Read each result's own job data; a careers page becomes one entry per job,
      // unless its company isn't on your list, in which case it stays one entry.
      const resolved = (await pool([...finds.values()], 6, async (f) => collapseIfNotListed(await resolveFind(f), f))).flat();
      const jobs = new Map<string, ResolvedFind>();
      for (const r of resolved) {
        if (r.raw && boardIds.includes(r.raw.job.id)) continue; // already read from a board
        if (r.slug && r.source && scannedBoards.has(`${r.source}:${r.slug.toLowerCase()}`)) continue; // one of the 49 boards
        const k = normUrl(r.url);
        if (!jobs.has(k)) jobs.set(k, r);
      }
      webFinds = jobs.size;
      const expanded = [...jobs.values()].filter((r) => r.expandedFrom).length;

      const web = await pool([...jobs.values()], 8, async (r): Promise<JobResult> => {
        const f = r.find;
        const key = `web:${normUrl(r.url)}`;
        const fromData = !!r.source;
        // Location from the job's own data is decided by code; otherwise Jev is asked.
        const loc: LocationClass =
          fromData && (r.location || r.country)
            ? classifyLocation({ location: r.location ?? "", country: r.country, remote: r.remote } as RawJob)
            : "ambiguous";
        const base: JobResult = {
          key,
          company: "—",
          rating: 0,
          ats: "web",
          title: r.title,
          location: fromData ? r.location || "—" : "From web search",
          url: r.url,
          locationClass: loc,
          tier: "dropped",
          source: "web",
          web: {
            v: 2,
            query: f.query,
            snippet: f.snippet,
            pageChars: 0,
            pageTitle: f.title,
            fromData: r.source,
            dataCompany: r.company,
            expandedFrom: r.expandedFrom,
            closedByData: r.closed,
            collapsedJobs: r.collapsedJobs,
          },
        };
        if (r.closed) return { ...base, reason: "closed" };
        if (r.collapsedJobs) return { ...base, company: r.company ?? r.slug ?? "—", location: "Careers page", reason: "not_on_list" };

        // Company: named by the job's data and matched to your list by code; Jev only picks when the data doesn't say.
        const named = matchCompany(r.company, r.slug);
        const candidates = named ? [] : companyCandidates(f);
        if (named) Object.assign(base, { company: named.name, rating: named.rating });
        else if (fromData && r.company) return { ...base, company: r.company, reason: "not_on_list" };
        else if (!candidates.length) return { ...base, reason: "not_on_list" };
        if (loc === "elsewhere") return { ...base, reason: "not_israel" };

        const reported = seen.has(key) || REPORTED.some((x) => normUrl(x.url) === normUrl(r.url));
        const hit = cache.get(`${key}|${f.title}|${base.location}`);
        if (hit?.web?.v === 2) {
          cachedJudgments++;
          const { tier, reason, cached, ...judged } = hit;
          const again: JobResult = { ...judged, cached: true, tier: "dropped" };
          return { ...again, ...webTier(again, reported) };
        }

        let text = r.description ?? "";
        if (!text && r.raw) text = await fetchDescription(r.raw.board, r.raw.job).catch(() => "");
        if (!text) text = r.pageText ?? "";
        text = text.slice(0, 6000);
        base.web!.pageChars = text.length;
        const titles = fromData ? [] : titleCandidates(f, text);

        const qs: Record<string, Question> = {
          fit: withDescription(JOB_QUESTIONS.fit),
          excluded: withDescription(JOB_QUESTIONS.excluded),
        };
        if (!named)
          qs.company = {
            type: "choice",
            instructions: WEB_COMPANY_INSTRUCTIONS,
            criteria: { ...Object.fromEntries(candidates.map((c) => [c.name, null])), none: "None of these companies" },
          };
        if (!fromData) qs.status = WEB_STATUS_QUESTION;
        if (titles.length)
          qs.job_title = {
            type: "choice",
            instructions: WEB_TITLE_INSTRUCTIONS,
            criteria: { ...Object.fromEntries(titles.map((t) => [t, null])), none: "None of these is the job's title" },
          };
        if (loc === "ambiguous") qs.remote_ok = withDescription(REMOTE_QUESTION);

        try {
          const a = await ask(
            {
              candidate: PROFILE,
              ...(named ? {} : { companies: candidates.map((c) => c.name) }),
              job: {
                company: named?.name ?? r.company,
                title: r.title,
                location: fromData ? r.location : undefined,
                snippet: f.snippet,
                url: r.url,
                description: text || "(the page could not be fetched)",
              },
            },
            qs,
          );
          if (a.company) {
            const company = a.company as ChoiceAnswer;
            base.web!.companyProbs = company.probabilities;
            const chosen = candidates.find((c) => c.name === company.choice);
            if (chosen) Object.assign(base, { company: chosen.name, rating: chosen.rating });
          }
          if (a.status) base.web!.statusProbs = (a.status as ChoiceAnswer).probabilities;
          // Select, don't generate: the title is one of the spans code found, copied verbatim.
          if (a.job_title) {
            const title = a.job_title as ChoiceAnswer;
            base.web!.titleProbs = title.probabilities;
            if (title.choice !== "none" && (title.probabilities[title.choice] ?? 0) >= 0.5) base.title = title.choice;
          }
          const fit = a.fit as ScoreAnswer;
          Object.assign(base, {
            fit: fit.score,
            fitConfidence: fit.confidence,
            fitProbs: fit.probabilities,
            excluded: (a.excluded as NoulAnswer).noul,
            remoteOk: a.remote_ok ? (a.remote_ok as NoulAnswer).noul : undefined,
            verified: text.length > 0,
          });
          base.postingPass = { fit: base.fit, fitConfidence: base.fitConfidence, fitProbs: base.fitProbs, excluded: base.excluded, remoteOk: base.remoteOk, chars: text.length };
        } catch (e) {
          if (e instanceof BudgetExceeded) budgetHits++;
          else errors.push(`Web find failed for ${r.title}: ${String(e).slice(0, 200)}`);
        }
        return { ...base, ...webTier(base, reported) };
      });
      results.push(...web);
      boardResults.push({
        company: "Web search (Tavily)",
        ats: "web",
        slug: "web-search",
        rating: 0,
        status: search.errors.length && !search.finds.length ? "failed" : "ok",
        error:
          `${tavilyUsage.searches} searches, ${search.finds.length} results → ${webFinds} jobs after reading each result's job data` +
          (expanded ? ` (${expanded} from careers pages)` : "") +
          (search.errors.length ? ` · ${search.errors.length} searches failed` : ""),
        total: webFinds,
        israel: web.filter((r) => r.locationClass === "israel" || (r.remoteOk ?? 0) >= THRESHOLDS.remoteOk).length,
        ambiguous: web.filter((r) => r.locationClass === "ambiguous").length,
        elsewhere: web.filter((r) => r.locationClass === "elsewhere").length,
      });
    } catch (e) {
      errors.push(`Web-search pass failed: ${String(e).slice(0, 200)}`);
    }
  }

  if (budgetHits) warnings.push(`Jev budget reached during the run: ${budgetHits} checks were skipped`);
  const notJudged = results.filter((r) => r.reason === "not_judged").length;
  if (notJudged) warnings.push(`${notJudged} jobs could not be judged by Jev and are listed under Dropped → Not judged`);

  const count = (t: JobResult["tier"]) => results.filter((r) => r.tier === t).length;
  const report: RunReport = {
    id: started.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z"),
    date: israelDate(started),
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    env: process.env.VERCEL_ENV ?? "local",
    dryRun: opts.dryRun,
    profileVersion: PROFILE_VERSION,
    thresholds: { ...THRESHOLDS },
    boards: boardResults,
    jobs: results.sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1)),
    stats: {
      boards: boards.length,
      boardsCovered: boardResults.filter((b) => b.ats !== "web" && (b.status === "ok" || b.status === "empty")).length,
      jobsRead: fetched.reduce((n, f) => n + f.jobs.length, 0),
      judged: results.filter((r) => r.fit !== undefined).length,
      verified: results.filter((r) => r.verified).length,
      cachedJudgments,
      strong: count("strong"),
      look: count("look"),
      seen: count("seen"),
      dropped: count("dropped"),
      jevCalls: usage.calls,
      jevErrors: usage.errors,
      inputTokens: usage.input,
      outputTokens: usage.output,
    },
    errors,
    blobStoredBytes: storedBytes,
    guard: { warnings },
    method: {
      profile: PROFILE,
      fitLevels: FIT_LEVELS,
      questions: {
        fit: JOB_QUESTIONS.fit.instructions,
        excluded: JOB_QUESTIONS.excluded.instructions,
        remote_ok: REMOTE_QUESTION,
        board_check: BOARD_QUESTION.instructions,
        full_posting_note: DESCRIPTION_NOTE,
        web_searches: WEB_SEARCHES,
        web_company: WEB_COMPANY_INSTRUCTIONS,
        web_title: WEB_TITLE_INSTRUCTIONS,
        web_status: WEB_STATUS_QUESTION,
      },
    },
  };
  return { report, cpuStart, monthPrior, emailsToday };
}

function tierFor(j: JobResult, reported: boolean): Pick<JobResult, "tier" | "reason"> {
  const t = THRESHOLDS;
  if (j.locationClass === "elsewhere") return { tier: "dropped", reason: "not_israel" };
  if (j.locationClass === "ambiguous" && j.remoteOk !== undefined && j.remoteOk < t.remoteOk)
    return { tier: "dropped", reason: "not_israel" };
  // No judgment (Jev error or budget reached): listed under Dropped, and the email says how many.
  if (j.fit === undefined || j.excluded === undefined) return { tier: "dropped", reason: "not_judged" };
  let tier: JobResult["tier"];
  if (j.fit >= t.strongFit && j.excluded < t.strongMaxExcluded) tier = "strong";
  else if (j.fit >= t.lookFit && j.excluded < t.lookMaxExcluded) tier = "look";
  else return { tier: "dropped", reason: j.excluded >= t.lookMaxExcluded ? "excluded" : "low_fit" };
  return { tier: reported ? "seen" : tier };
}

// Web finds: a company must be chosen (not "none"), the page must not say it is closed,
// then the usual location and fit rules apply.
function webTier(j: JobResult, reported: boolean): Pick<JobResult, "tier" | "reason"> {
  if (j.web?.closedByData) return { tier: "dropped", reason: "closed" };
  if (j.fit === undefined) return { tier: "dropped", reason: "not_judged" };
  if (j.company === "—") return { tier: "dropped", reason: "not_on_list" };
  // LinkedIn shows logged-out visitors a sign-in or "no longer accepting" page, so its "closed" isn't trusted.
  if ((j.web?.statusProbs?.closed ?? 0) >= 0.6 && !isLinkedIn(j.url)) return { tier: "dropped", reason: "closed" };
  return tierFor(j, reported);
}

const normUrl = (u: string) => u.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();

// Cheap first pass for web finds: which listed companies could this be? Jev picks among these.
const STOP = /\b(inc|ltd|llc|group|technologies|technology|systems|networks|software|labs|corporation|company)\b/g;
const squash = (s: string) => s.toLowerCase().replace(STOP, "").replace(/[^a-z0-9]/g, "");
function companyCandidates(f: WebFind) {
  // The job site's own name (e.g. "Comeet" on comeet.com) is not the employer,
  // unless the link is to that company's own careers page.
  let site = "", path = "";
  try {
    const u = new URL(f.url);
    site = squash(u.hostname.replace(/^(www|jobs|job-boards|boards|careers|il)\./, "").split(".")[0]);
    path = u.pathname.toLowerCase();
  } catch {}
  const hay = squash(`${f.title} ${f.url}`);
  const urlTokens = f.url.toLowerCase().split(/[\/.\-_?=&]+/).filter((t) => t.length >= 4);
  return COMPANIES.map((c) => ({ ...c, key: squash(c.name) }))
    .filter((c) => c.key.length >= 3 && (hay.includes(c.key) || urlTokens.some((t) => c.key.startsWith(t))))
    .filter((c) => !(c.key === site && !path.includes(`/${site}`)))
    .sort((a, b) => b.key.length - a.key.length)
    .slice(0, 5);
}

// Candidate job titles for a web find: pieces of the search result's title, plus
// role-like phrases in the snippet and page text. Jev picks one; code copies it as is.
const ROLE_WORD = "(?:Manager|Director|Lead|Head|Specialist|Analyst|Partner|Architect|Coordinator|Engineer|Executive|Representative|Consultant|Strategist|Officer|Owner|Administrator|President|VP)";
const ROLE_PHRASE = new RegExp(`\\b((?:[A-Z][\\w&/+.-]*,?\\s+(?:of\\s+|&\\s+|and\\s+)?){0,5}${ROLE_WORD}(?:,?\\s+(?:of\\s+)?[A-Z][\\w&/+.-]*){0,4})`, "g");
function titleCandidates(f: WebFind, page: string): string[] {
  const out: string[] = [];
  const add = (t?: string) => {
    const c = t?.replace(/\s+/g, " ").replace(/^(Job Application for|Job opportunity:|Careers?\s*[-|:])\s*/i, "").trim();
    if (c && c.length >= 4 && c.length <= 120 && !out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
  };
  add(f.title);
  for (const part of f.title.split(/\s+(?:[-|–—@]|at)\s+/)) add(part);
  for (const text of [f.snippet ?? "", page.slice(0, 3000)]) for (const m of text.matchAll(ROLE_PHRASE)) add(m[1]);
  return out.slice(0, 15);
}

// A company named by the job's own data (or its board slug), matched to your list by code.
function matchCompany(name?: string, slug?: string) {
  const keys = [name, slug].filter((k): k is string => !!k).map(squash).filter((k) => k.length >= 3);
  const list = COMPANIES.map((c) => ({ ...c, key: squash(c.name) }));
  for (const k of keys) {
    const exact = list.find((c) => c.key === k);
    if (exact) return exact;
  }
  for (const k of keys) {
    if (k.length < 4) continue;
    const close = list.find((c) => c.key.length >= 4 && (c.key.startsWith(k) || k.startsWith(c.key)));
    if (close) return close;
  }
  return undefined;
}


// A careers page (several jobs) at a company that isn't on your list stays a single entry,
// so the report isn't flooded with hundreds of unrelated jobs.
function collapseIfNotListed(found: ResolvedFind[], f: WebFind): ResolvedFind[] {
  const page = found.filter((r) => r.expandedFrom);
  if (!page.length) return found;
  const first = page[0];
  if (matchCompany(first.company, first.slug) || companyCandidates(f).length) return found;
  const collapsed: ResolvedFind = {
    url: first.expandedFrom!,
    title: `Careers page (${page.length} job${page.length === 1 ? "" : "s"})`,
    find: f,
    source: first.source,
    company: first.company,
    slug: first.slug,
    collapsedJobs: page.length,
  };
  return [...found.filter((r) => !r.expandedFrom), collapsed];
}
