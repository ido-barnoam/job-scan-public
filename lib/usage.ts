import { USAGE_LIMITS } from "../config/settings";
import { spentUsd, usage as jevUsage } from "./jev";
import { blobUsage } from "./store";
import { apifyUsage } from "./linkedin";
import { tavilyUsage } from "./web";
import type { RunReport, Usage } from "./types";

const L = USAGE_LIMITS;

export const emptyUsage = (): Usage => ({
  jev: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
  vercel: { runs: 0, durationSec: 0, activeCpuSec: 0, memoryGbHours: 0, blobAdvancedOps: 0, blobSimpleOps: 0, blobBytesRead: 0, blobBytesWritten: 0 },
  resend: { emails: 0 },
  tavily: { searches: 0 },
  apify: { runs: 0, results: 0, usd: 0 },
});

export function addUsage(a: Usage, b: Usage): Usage {
  const out = emptyUsage();
  // Older runs may lack a service (e.g. tavily, apify), so read every field defensively.
  for (const svc of ["jev", "vercel", "resend", "tavily", "apify"] as const)
    for (const k of Object.keys(out[svc]))
      (out[svc] as any)[k] = ((a[svc] as any)?.[k] ?? 0) + ((b[svc] as any)?.[k] ?? 0);
  return out;
}

// Runs saved before usage tracking existed only have token counts.
export function usageOfRun(r: RunReport): Usage {
  if (r.usage) return { ...emptyUsage(), ...r.usage, resend: { emails: r.emailed?.id ? 1 : 0 } };
  const u = emptyUsage();
  u.jev = {
    calls: r.stats.jevCalls,
    inputTokens: r.stats.inputTokens,
    outputTokens: r.stats.outputTokens,
    usd: (r.stats.inputTokens * L.jev.usdPerMillionInputTokens) / 1e6,
  };
  u.vercel.runs = 1;
  u.resend.emails = r.emailed?.id ? 1 : 0;
  return u;
}

export const monthOf = (iso: string) => iso.slice(0, 7); // calendar month, UTC

// Usage by the current invocation. `pendingSave` counts the put() that saves this run.
export function collectRunUsage(started: Date, cpuStart: NodeJS.CpuUsage, pendingSave = true): Usage {
  const cpu = process.cpuUsage(cpuStart);
  const durationSec = (Date.now() - started.getTime()) / 1000;
  const memGb = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || 2048) / 1024;
  return {
    jev: { calls: jevUsage.calls, inputTokens: jevUsage.input, outputTokens: jevUsage.output, usd: spentUsd() },
    vercel: {
      runs: 1,
      durationSec,
      activeCpuSec: (cpu.user + cpu.system) / 1e6,
      memoryGbHours: (durationSec / 3600) * memGb,
      blobAdvancedOps: blobUsage.advanced + (pendingSave ? 1 : 0),
      blobSimpleOps: blobUsage.simple,
      blobBytesRead: blobUsage.bytesRead,
      blobBytesWritten: blobUsage.bytesWritten,
    },
    resend: { emails: 0 },
    tavily: { searches: tavilyUsage.searches },
    apify: { ...apifyUsage },
  };
}

// Share of each monthly limit used, for the guardrails and the report.
export function shares(month: Usage, storedBytes: number) {
  const v = L.vercel;
  return {
    jevBudget: month.jev.usd / L.jev.monthlyBudgetUsd,
    activeCpu: month.vercel.activeCpuSec / 3600 / v.activeCpuHours,
    memory: month.vercel.memoryGbHours / v.provisionedMemoryGbHours,
    invocations: month.vercel.runs / v.invocations,
    blobStorage: storedBytes / 1e9 / v.blobStorageGb,
    blobSimpleOps: month.vercel.blobSimpleOps / v.blobSimpleOps,
    blobAdvancedOps: month.vercel.blobAdvancedOps / v.blobAdvancedOps,
    blobTransfer: month.vercel.blobBytesRead / 1e9 / v.blobTransferGb,
    resendMonth: month.resend.emails / L.resend.emailsPerMonth,
    tavilyMonth: month.tavily.searches / L.tavily.searchesPerMonth,
    apifyMonth: (month.apify?.usd ?? 0) / L.apify.monthlyCreditUsd,
  };
}

export function vercelOverLimit(month: Usage, storedBytes: number): string | undefined {
  const s = shares(month, storedBytes);
  const vercelKeys = ["activeCpu", "memory", "invocations", "blobStorage", "blobSimpleOps", "blobAdvancedOps", "blobTransfer"] as const;
  const hit = vercelKeys.find((k) => s[k] >= L.stopAtShare);
  return hit ? `Vercel ${hit} is at ${Math.round(s[hit] * 100)}% of the free Hobby quota this month` : undefined;
}
