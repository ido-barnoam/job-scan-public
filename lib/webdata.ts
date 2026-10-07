import { fetchBoard, stripHtml } from "./boards";
import type { Ats, Board, RawJob } from "./types";
import type { WebFind } from "./web";

// Turns a web-search result into the job(s) it points to, read from the job's own data
// wherever possible instead of the page's visible text:
// - Comeet pages carry the job (or the company's whole job list) as embedded JSON;
// - Greenhouse, Lever, Ashby and SmartRecruiters links are looked up in the same public
//   job APIs the board scan uses;
// - anything else (LinkedIn, Glassdoor, VC job boards) falls back to the page text.
// A careers page (a job list rather than one job) becomes one entry per job.

export type DataSource = "comeet" | "greenhouse" | "lever" | "ashby" | "smartrecruiters";

export interface ResolvedFind {
  url: string;
  title: string;
  find: WebFind; // the search result it came from
  source?: DataSource; // set when details come from the job's own data
  company?: string; // company name as the data gives it
  slug?: string; // ATS board slug, for matching to the company list
  location?: string;
  country?: string;
  remote?: boolean;
  description?: string; // full posting text, when available
  pageText?: string; // visible page text (fallback sources only)
  expandedFrom?: string; // careers-page URL this job was listed on
  closed?: boolean; // the link is to a job no longer in the company's live data
  collapsedJobs?: number; // a careers page kept as one entry (company not on the list): how many jobs it lists
  raw?: { board: Board; job: RawJob }; // for fetching a Greenhouse/SmartRecruiters description
}

const UA = { "User-Agent": "job-scan (personal job alert)" };
const MAX_EXPANDED = 60; // jobs taken from one careers page

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA, cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Parses the JSON value assigned to `name` in a page's inline script (e.g. POSITION_DATA = {...};).
function embeddedJson(html: string, name: string): any {
  const m = new RegExp(`\\b${name}\\s*=\\s*`).exec(html);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  if (html.startsWith("null", i)) return null;
  const open = html[i];
  if (open !== "{" && open !== "[") return undefined;
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(i, k + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function comeetPosition(p: any, companyName: string | undefined, find: WebFind, expandedFrom?: string): ResolvedFind {
  const details = (p?.custom_fields?.details ?? []).map((d: any) => `${d.name}: ${stripHtml(d.value ?? "")}`).join("\n");
  return {
    url: p.url_comeet_hosted_page || p.url_active_page || find.url,
    title: p.name,
    find,
    source: "comeet",
    company: p.company_name || companyName,
    location: p.location?.name ?? "",
    country: p.location?.country,
    remote: /remote/i.test(p.workplace_type ?? ""),
    description: details || undefined,
    expandedFrom,
  };
}

async function fromComeet(find: WebFind, path: string[]): Promise<ResolvedFind[] | undefined> {
  const html = await getText(find.url);
  const company = embeddedJson(html, "COMPANY_DATA")?.name as string | undefined;
  const position = embeddedJson(html, "POSITION_DATA");
  const list = embeddedJson(html, "COMPANY_POSITIONS_DATA");
  if (position && typeof position === "object") return [comeetPosition(position, company, find)];
  if (Array.isArray(list)) return list.slice(0, MAX_EXPANDED).map((p) => comeetPosition(p, company, find, find.url));
  // A job link whose page no longer carries the job: the posting is gone.
  if (path.length >= 5 && company) return [{ url: find.url, title: find.title, find, source: "comeet", company, closed: true }];
  return undefined;
}

// Which ATS a link belongs to, and its board slug and job id.
function atsLink(u: URL): { ats: Ats; slug: string; id?: string } | undefined {
  const p = u.pathname.split("/").filter(Boolean);
  const host = u.hostname;
  if (host.endsWith("greenhouse.io")) {
    if (p[0] === "embed") {
      const slug = u.searchParams.get("for");
      return slug ? { ats: "greenhouse", slug, id: u.searchParams.get("token") ?? undefined } : undefined;
    }
    return p[0] ? { ats: "greenhouse", slug: p[0], id: p[1] === "jobs" ? p[2] : undefined } : undefined;
  }
  if (host === "jobs.lever.co") return p[0] ? { ats: "lever", slug: p[0], id: p[1] } : undefined;
  if (host === "jobs.ashbyhq.com") return p[0] ? { ats: "ashby", slug: p[0], id: p[1] } : undefined;
  if (host === "jobs.smartrecruiters.com") return p[0] ? { ats: "smartrecruiters", slug: p[0], id: p[1]?.split("-")[0] } : undefined;
  return undefined;
}

async function fromAts(find: WebFind, link: { ats: Ats; slug: string; id?: string }): Promise<ResolvedFind[]> {
  const board: Board = { company: link.slug, ats: link.ats, slug: link.slug, rating: 0 };
  const jobs = await fetchBoard(board);
  const toFind = (job: RawJob, expandedFrom?: string): ResolvedFind => ({
    url: job.url || find.url,
    title: job.title,
    find,
    source: link.ats as DataSource,
    company: job.companyName,
    slug: link.slug,
    location: job.location,
    country: job.country,
    remote: job.remote,
    description: job.description,
    expandedFrom,
    raw: { board, job },
  });
  if (link.id) {
    const job = jobs.find((j) => j.id === link.id);
    return job ? [toFind(job)] : [{ url: find.url, title: find.title, find, source: link.ats as DataSource, slug: link.slug, closed: true }];
  }
  return jobs.slice(0, MAX_EXPANDED).map((j) => toFind(j, find.url));
}

export async function resolveFind(find: WebFind): Promise<ResolvedFind[]> {
  let u: URL;
  try {
    u = new URL(find.url);
  } catch {
    return [{ url: find.url, title: find.title, find }];
  }
  try {
    const path = u.pathname.split("/").filter(Boolean);
    if (u.hostname.endsWith("comeet.com") && path[0] === "jobs") {
      const r = await fromComeet(find, path);
      if (r) return r;
    }
    const link = atsLink(u);
    if (link) return await fromAts(find, link);
  } catch {
    // fall through to the page text
  }
  let pageText = "";
  try {
    pageText = stripHtml(await getText(find.url)).slice(0, 6000);
  } catch {}
  return [{ url: find.url, title: find.title, find, pageText }];
}
