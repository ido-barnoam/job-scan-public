import { notFound } from "next/navigation";
import { loadStatuses } from "../../../../lib/status";
import { listRuns, loadRun } from "../../../../lib/store";
import Report from "./Report";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ token: string; run?: string[] }> }) {
  const { token, run } = await params;
  if (!process.env.REPORT_TOKEN || token !== process.env.REPORT_TOKEN) notFound();

  const runs = await listRuns();
  if (!runs.length) return <main className="wrap"><h1>Job scan</h1><p>No runs yet.</p></main>;
  const entry = run?.[0] ? runs.find((r) => r.id === run[0]) : runs[0];
  if (!entry) notFound();
  const [report, statuses] = await Promise.all([loadRun(entry), loadStatuses().catch(() => ({}))]);

  return <Report report={report} runs={runs.map((r) => r.id)} base={`/r/${token}`} token={token} initialStatuses={statuses} />;
}
