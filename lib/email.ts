import { RECIPIENT, USAGE_LIMITS } from "../config/settings";
import { isLinkedIn } from "./links";
import type { JobResult, RunReport } from "./types";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (x?: number) => (x === undefined ? "—" : `${Math.round(x * 100)}%`);

function block(j: JobResult): string {
  const fit = j.fit === undefined ? "Not scored" : `Fit ${j.fit.toFixed(1)}/3 · confidence ${pct(j.fitConfidence)}`;
  return `<div style="margin-bottom:18px">
  <div style="font-weight:bold;font-size:16px">${esc(j.company)} — Glassdoor ${j.rating}</div>
  <div>${esc(j.title)}</div>
  <div>${esc(j.location)}</div>
  <div style="font-size:13px;color:#666">${fit}</div>${isLinkedIn(j.url) ? `
  <div style="font-size:13px;color:#8a5a00">Found on LinkedIn, which hides details from logged-out visitors. Check in a browser that it is still open.</div>` : ""}
  <div><a href="${esc(j.url)}">View and apply</a></div>
</div>`;
}

// "Considered" sections in the email are sorted by Glassdoor rating, then fit.
const byRating = (a: JobResult, b: JobResult) => b.rating - a.rating || (b.fit ?? 0) - (a.fit ?? 0);

export function buildEmail(r: RunReport, reportUrl: string) {
  const strong = r.jobs.filter((j) => j.tier === "strong").sort(byRating);
  const look = r.jobs.filter((j) => j.tier === "look").sort(byRating);
  const dd = r.date.slice(8, 10) + "/" + r.date.slice(5, 7);
  const subject =
    strong.length + look.length > 0 ? `Job scan — ${dd}` : `Job scan — nothing new ${dd}`;

  const s = r.stats;
  const failed = r.boards.filter((b) => b.status === "failed" || b.status === "wrong_company");
  let html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111">`;
  // Guardrail notices go first.
  const notices = [r.guard?.stopped, ...(r.guard?.warnings ?? [])].filter(Boolean) as string[];
  if (notices.length)
    html += `<div style="background:#fdf1dc;border-radius:8px;padding:10px 12px;margin-bottom:16px"><b>Usage limit notice</b>${notices
      .map((n) => `<div style="font-size:13px">${esc(n)}</div>`)
      .join("")}</div>`;
  if (strong.length) html += `<h2 style="font-size:18px">Strong fit (${strong.length})</h2>${strong.map(block).join("")}`;
  if (look.length) html += `<h2 style="font-size:18px">Worth a look (${look.length})</h2>${look.map(block).join("")}`;
  if (!strong.length && !look.length && !r.guard?.stopped) html += `<p>The scan ran and found no new jobs.</p>`;
  html += `<hr style="border:none;border-top:1px solid #ddd">
<div style="font-size:13px;color:#555">
${s.boardsCovered} of ${s.boards} boards read · ${s.judged} jobs scored · ${s.dropped} filtered out · ${s.seen} already sent before
</div>`;
  if (failed.length)
    html += `<div style="font-size:13px;color:#555">Boards not read: ${failed
      .map((b) => `${esc(b.company)} (${b.status === "failed" ? "error" : "different company"})`)
      .join(", ")}</div>`;
  if (r.errors.length) html += `<div style="font-size:13px;color:#a00">${r.errors.length} errors, details in the report.</div>`;
  if (r.usage && r.monthUsage)
    html += `<div style="font-size:13px;color:#555">Jev cost: this run $${r.usage.jev.usd.toFixed(4)} · this month $${r.monthUsage.jev.usd.toFixed(3)} of $${USAGE_LIMITS.jev.monthlyBudgetUsd} · Vercel, Resend and Tavily on free plans</div>`;
  html += `<p><a href="${esc(reportUrl)}">Open the full report with every job, filter and score</a></p></div>`;
  return { subject, html };
}

export async function sendEmail(subject: string, html: string): Promise<{ id?: string; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { error: "RESEND_API_KEY is not set" };
  if (!RECIPIENT) return { error: "RECIPIENT_EMAIL is not set" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Job Scan <onboarding@resend.dev>", to: [RECIPIENT], subject, html }),
  });
  const body = await res.json().catch(() => ({}));
  return res.ok ? { id: body.id } : { error: `Resend HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}` };
}
