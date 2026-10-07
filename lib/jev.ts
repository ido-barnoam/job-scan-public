// Minimal client for the TypeSafe System One HTTP API.
// https://docs.typesafe.ai/api

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export type Question =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] };

export interface NoulAnswer { type: "noul"; noul: number }
export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export type Answer = NoulAnswer | ScoreAnswer | ChoiceAnswer;

export const usage = { calls: 0, errors: 0, input: 0, output: 0 };

// Spend guard. The scan sets how many dollars this run may spend (the smaller of the
// per-run cap and what is left of the monthly budget); calls stop once it is reached.
// Calls already in flight still finish, so a run can overshoot by a few calls (a fraction of a cent).
export class BudgetExceeded extends Error {}
const budget = { usdPerMTok: 0, allowedUsd: Infinity };
export function setBudget(usdPerMTok: number, allowedUsd: number) {
  budget.usdPerMTok = usdPerMTok;
  budget.allowedUsd = allowedUsd;
}
export const spentUsd = () => (usage.input * budget.usdPerMTok) / 1e6;

export async function ask(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is not set");
  if (spentUsd() >= budget.allowedUsd) throw new BudgetExceeded(`Jev budget for this run reached ($${budget.allowedUsd.toFixed(4)})`);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      usage.calls++;
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state, questions }),
        cache: "no-store",
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`TypeSafe HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
      usage.input += body.usage?.input_tokens ?? 0;
      usage.output += body.usage?.output_tokens ?? 0;
      return body.answers;
    } catch (e) {
      lastErr = e;
      if (String(e).includes("HTTP 4")) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  usage.errors++;
  throw lastErr;
}

// Run fn over items with at most `limit` in flight.
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
