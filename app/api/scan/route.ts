import { authorized, finishRun } from "../../../lib/finish";
import { runScan } from "../../../lib/scan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Called daily by Vercel Cron, or by hand with ?key=$CRON_SECRET.
//   ?dry=1     don't email, and don't count as "already reported" later (default outside production)
//   ?send=1    email even outside production
//   ?boards=N  only scan the first N boards (for debugging)
//   ?cap=USD   lower the Jev spend cap for this run (dry runs only)
//   ?fresh=1   re-ask Jev about every job instead of reusing earlier answers (dry runs only)
export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);

  const prod = process.env.VERCEL_ENV === "production";
  const dryRun = url.searchParams.get("dry") === "1" || (!prod && url.searchParams.get("send") !== "1");
  const boardLimit = Number(url.searchParams.get("boards")) || undefined;

  // ?cap=0.001 lowers this run's Jev spend cap (dry runs only), to test the guardrail.
  const runCapUsd = dryRun && url.searchParams.get("cap") ? Number(url.searchParams.get("cap")) : undefined;
  const fresh = dryRun && url.searchParams.get("fresh") === "1";
  const result = await runScan({ dryRun, boardLimit, runCapUsd, fresh });
  const { report } = result;
  const { reportUrl } = await finishRun(result);

  return Response.json({
    id: report.id,
    reportUrl,
    dryRun,
    stats: report.stats,
    guard: report.guard,
    usage: report.usage,
    monthUsage: report.monthUsage,
    boards: report.boards.map((b) => `${b.company}: ${b.status} ${b.total}/${b.israel}il/${b.ambiguous}?` + (b.boardMatch !== undefined ? ` match=${b.boardMatch.toFixed(2)}` : "") + (b.error ? ` ${b.error}` : "")),
    considered: report.jobs
      .filter((j) => j.tier !== "dropped")
      .map((j) => `${j.tier} ${j.fit?.toFixed(2)} c=${j.fitConfidence?.toFixed(2)} x=${j.excluded?.toFixed(2)} | ${j.company} | ${j.title} | ${j.location}`),
    errors: report.errors,
    emailed: report.emailed,
    ...(url.searchParams.get("dump") === "1" ? { jobs: report.jobs } : {}),
  });
}
