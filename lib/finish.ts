import { USAGE_LIMITS } from "../config/settings";
import { buildEmail, sendEmail } from "./email";
import type { ScanResult } from "./scan";
import { saveRun } from "./store";
import { addUsage, collectRunUsage } from "./usage";

// After a scan (boards or LinkedIn): record usage, email the result (unless a dry run or near
// Resend's free limits), and save the run. Shared by both cron routes.
export async function finishRun({ report, cpuStart, monthPrior, emailsToday }: ScanResult) {
  const dryRun = report.dryRun;
  const started = new Date(report.startedAt);
  const prod = process.env.VERCEL_ENV === "production";
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
  return { reportUrl: process.env.REPORT_TOKEN ? reportUrl : "(REPORT_TOKEN not set)" };
}

// Who may start a scan: Vercel Cron (which sends "Authorization: Bearer $CRON_SECRET"), or by hand with ?key=$CRON_SECRET.
export function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? new URL(req.url).searchParams.get("key");
  return !!secret && given === secret;
}
