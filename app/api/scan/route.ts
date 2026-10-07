import { buildEmail, sendEmail } from "../../../lib/email";
import { runScan } from "../../../lib/scan";
import { saveRun } from "../../../lib/store";
import { addUsage, collectRunUsage } from "../../../lib/usage";
import { USAGE_LIMITS } from "../../../config/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Called daily by Vercel Cron (which sends "Authorization: Bearer $CRON_SECRET"),
// or by hand with ?key=$CRON_SECRET.
//   ?dry=1     don't email, and don't count as "already reported" later (default outside production)
//   ?send=1    email even outside production
//   ?boards=N  only scan the first N boards (for debugging)
//   ?cap=USD   lower the Jev spend cap for this run (dry runs only)
//   ?fresh=1   re-ask Jev about every job instead of reusing earlier answers (dry runs only)
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url);
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("key");
  if (!secret || given !== secret) return new Response("Unauthorized", { status: 401 });

  const prod = process.env.VERCEL_ENV === "production";
  const dryRun = url.searchParams.get("dry") === "1" || (!prod && url.searchParams.get("send") !== "1");
  const boardLimit = Number(url.searchParams.get("boards")) || undefined;

  // ?cap=0.001 lowers this run's Jev spend cap (dry runs only), to test the guardrail.
  const runCapUsd = dryRun && url.searchParams.get("cap") ? Number(url.searchParams.get("cap")) : undefined;
  const fresh = dryRun && url.searchParams.get("fresh") === "1";
  const { report, cpuStart, monthPrior, emailsToday } = await runScan({ dryRun, boardLimit, runCapUsd, fresh });
  const started = new Date(report.startedAt);

  const host = prod ? process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.VERCEL_URL;
  const reportUrl = `https://${host}/r/${process.env.REPORT_TOKEN}/${report.id}`;
  // Usage so far, so the email can show it. Resend guard: stay under the free quota.
  report.usage = collectRunUsage(started, cpuStart);
  report.monthUsage = addUsage(monthPrior, report.usage);
  const R = USAGE_LIMITS.resend;
  const resendBlocked =
    monthPrior.resend.emails >= R.emailsPerMonth * USAGE_LIMITS.stopAtShare
      ? `Resend: ${monthPrior.resend.emails} emails sent this month, near the ${R.emailsPerMonth} free limit`
      : emailsToday >= R.emailsPerDay * USAGE_LIMITS.stopAtShare
        ? `Resend: ${emailsToday} emails sent today, near the ${R.emailsPerDay}/day free limit`
        : undefined;
  if (!dryRun && resendBlocked) {
    report.guard = { ...(report.guard ?? { warnings: [] }), warnings: [...(report.guard?.warnings ?? []), `Email not sent. ${resendBlocked}`] };
  } else if (!dryRun) {
    const { subject, html } = buildEmail(report, reportUrl);
    report.emailed = await sendEmail(subject, html);
    if (report.emailed.error) report.errors.push(report.emailed.error);
  }
  report.usage = collectRunUsage(started, cpuStart);
  report.usage.resend.emails = report.emailed?.id ? 1 : 0;
  report.usage.vercel.blobBytesWritten += JSON.stringify(report).length; // the save below
  report.monthUsage = addUsage(monthPrior, report.usage);
  try {
    await saveRun(report);
  } catch (e) {
    report.errors.push(`Could not save run: ${String(e)}`);
  }

  return Response.json({
    id: report.id,
    reportUrl: process.env.REPORT_TOKEN ? reportUrl : "(REPORT_TOKEN not set)",
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
