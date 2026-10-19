import { authorized, finishRun } from "../../../lib/finish";
import { runLinkedInScan } from "../../../lib/linkedinScan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The LinkedIn scan. Called daily by Vercel Cron, or by hand with ?key=$CRON_SECRET.
//   ?dry=1       don't email, and don't count as handled later (default outside production)
//   ?send=1      email even outside production
//   ?week=1      search the past week instead of the past day
//   ?searches=N  only run the first N saved searches
//   ?cap=USD     lower the Jev spend cap for this run (dry runs only)
export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  // The LinkedIn scan is optional: without an Apify token it does nothing (no run saved, no email).
  if (!process.env.APIFY_TOKEN) return Response.json({ skipped: "LinkedIn scan is off: APIFY_TOKEN is not set" });
  const url = new URL(req.url);

  const prod = process.env.VERCEL_ENV === "production";
  const dryRun = url.searchParams.get("dry") === "1" || (!prod && url.searchParams.get("send") !== "1");
  const runCapUsd = dryRun && url.searchParams.get("cap") ? Number(url.searchParams.get("cap")) : undefined;
  const result = await runLinkedInScan({
    dryRun,
    week: url.searchParams.get("week") === "1",
    searchLimit: Number(url.searchParams.get("searches")) || undefined,
    runCapUsd,
  });
  const { report } = result;
  const { reportUrl } = await finishRun(result);

  return Response.json({
    id: report.id,
    reportUrl,
    dryRun,
    stats: report.stats,
    guard: report.guard,
    usage: report.usage,
    searches: report.boards.map((b) => `${b.company}: ${b.status} ${b.total}` + (b.error ? ` ${b.error}` : "")),
    considered: report.jobs
      .filter((j) => j.tier !== "dropped")
      .map((j) => `${j.tier} ${j.fit?.toFixed(2)} c=${j.fitConfidence?.toFixed(2)} x=${j.excluded?.toFixed(2)} | ${j.company} | ${j.title} | ${j.location}`),
    errors: report.errors,
    emailed: report.emailed,
  });
}
