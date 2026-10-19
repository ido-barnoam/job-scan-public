// LinkedIn job search through an Apify actor (valig/linkedin-jobs-scraper).
// https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post

import { LINKEDIN_ACTOR, LINKEDIN_LIMIT, LINKEDIN_SEARCHES, USAGE_LIMITS } from "../config/settings";

export type LinkedInSearch = (typeof LINKEDIN_SEARCHES)[number];

// One posting as the actor returns it (descriptionHtml is left out of the download).
export interface LinkedInJob {
  id: string;
  url: string;
  title: string;
  location: string;
  companyName: string;
  description?: string;
  postedDate?: string;
  experienceLevel?: string;
  sector?: string;
  applyType?: string;
  applicationsCount?: string;
}

export const apifyUsage = { runs: 0, results: 0, usd: 0 };

// LinkedIn's own search filters, passed through as URL parameters.
// distance is in miles; f_WT=2 is LinkedIn's "Remote" workplace filter.
function urlParams(s: LinkedInSearch) {
  const out: { key: string; value: string }[] = [];
  if (s.distanceKm) out.push({ key: "distance", value: String(Math.round(s.distanceKm / 1.609)) });
  if (s.remote) out.push({ key: "f_WT", value: "2" });
  return out;
}

export const searchLabel = (s: LinkedInSearch) =>
  `${s.keywords} · ${s.location}${s.distanceKm ? ` · ${s.distanceKm} km` : ""}${s.remote ? " · remote" : ""}`;

// Runs one search and waits for its results. `skipIds` are postings already handled in earlier runs;
// the actor leaves them out, so they are neither downloaded nor paid for.
export async function runLinkedInSearch(
  s: LinkedInSearch,
  opts: { datePosted: "r86400" | "r604800"; skipIds: string[]; timeoutSec: number },
): Promise<LinkedInJob[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN is not set");
  const input = {
    keywords: s.keywords,
    location: s.location,
    datePosted: opts.datePosted,
    limit: LINKEDIN_LIMIT,
    urlParam: urlParams(s),
    skipJobId: opts.skipIds,
  };
  const actor = LINKEDIN_ACTOR.replace("/", "~");
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=${opts.timeoutSec}&memory=256&clean=true&omit=descriptionHtml,recruiterUrl,companyUrl`;
  apifyUsage.runs++;
  apifyUsage.usd += USAGE_LIMITS.apify.usdPerStart;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
    signal: AbortSignal.timeout((opts.timeoutSec + 15) * 1000),
  });
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const items = (await res.json()) as LinkedInJob[];
  apifyUsage.results += items.length;
  apifyUsage.usd += items.length * USAGE_LIMITS.apify.usdPerResult;
  return items.filter((j) => j?.id && j.title);
}
