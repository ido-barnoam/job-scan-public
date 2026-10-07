import type { Board, RawJob } from "./types";

const UA = { "User-Agent": "job-scan (personal job alert)" };

async function getJson(url: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (res.status === 404) throw new Error(`404 at ${url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (String(e).includes("404")) break;
    }
  }
  throw lastErr;
}

async function greenhouse(b: Board): Promise<RawJob[]> {
  // Some companies (e.g. Eleos Health) are on Greenhouse's EU instance.
  const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${b.slug}/jobs`).catch((e) =>
    String(e).includes("404") ? getJson(`https://boards-api.eu.greenhouse.io/v1/boards/${b.slug}/jobs`) : Promise.reject(e),
  );
  return (d.jobs ?? []).map((j: any) => ({
    key: `greenhouse:${b.slug}:${j.id}`,
    id: String(j.id),
    title: j.title ?? "",
    location: j.location?.name ?? "",
    url: j.absolute_url ?? "",
  }));
}

async function lever(b: Board): Promise<RawJob[]> {
  const d = await getJson(`https://api.lever.co/v0/postings/${b.slug}?mode=json`);
  return (Array.isArray(d) ? d : []).map((j: any) => {
    const all: string[] = j.categories?.allLocations ?? [];
    const loc = [j.categories?.location, ...all.filter((l) => l !== j.categories?.location)].filter(Boolean).join(" / ");
    return {
      key: `lever:${b.slug}:${j.id}`,
      id: String(j.id),
      title: j.text ?? "",
      location: loc,
      team: j.categories?.team,
      url: j.hostedUrl ?? j.applyUrl ?? "",
      remote: j.workplaceType === "remote",
      country: j.country,
      description: [j.descriptionPlain, ...(j.lists ?? []).map((l: any) => `${l.text}: ${stripHtml(l.content ?? "")}`), j.additionalPlain]
        .filter(Boolean)
        .join("\n"),
    };
  });
}

async function ashby(b: Board): Promise<RawJob[]> {
  const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${b.slug}`);
  return (d.jobs ?? []).map((j: any) => {
    const secondary = (j.secondaryLocations ?? []).map((s: any) => s.location).filter(Boolean);
    return {
      key: `ashby:${b.slug}:${j.id}`,
      id: String(j.id),
      title: j.title ?? "",
      location: [j.location, ...secondary].filter(Boolean).join(" / "),
      team: j.department ?? j.team,
      url: j.jobUrl ?? j.applyUrl ?? "",
      remote: j.isRemote === true || j.workplaceType === "Remote",
      country: j.address?.postalAddress?.addressCountry,
      description: j.descriptionPlain ?? (j.descriptionHtml ? stripHtml(j.descriptionHtml) : undefined),
    };
  });
}

async function smartrecruiters(b: Board): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const d = await getJson(
      `https://api.smartrecruiters.com/v1/companies/${b.slug}/postings?limit=100&offset=${offset}`,
    );
    const page: any[] = d.content ?? [];
    for (const j of page) {
      const l = j.location ?? {};
      out.push({
        key: `smartrecruiters:${b.slug}:${j.id}`,
        id: String(j.id),
        title: j.name ?? "",
        location: l.fullLocation ?? [l.city, l.region, l.country].filter(Boolean).join(", "),
        team: j.department?.label,
        url: `https://jobs.smartrecruiters.com/${j.company?.identifier ?? b.slug}/${j.id}`,
        remote: l.remote === true,
        country: l.country,
        companyName: j.company?.name,
      });
    }
    if (page.length < 100 || out.length >= (d.totalFound ?? 0)) break;
  }
  return out;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// Full posting text, for the second-pass judgment. Lever and Ashby include it in the list call.
export async function fetchDescription(b: Board, j: RawJob): Promise<string> {
  if (j.description) return j.description;
  if (b.ats === "greenhouse") {
    const path = `/v1/boards/${b.slug}/jobs/${j.id}`;
    const d = await getJson(`https://boards-api.greenhouse.io${path}`).catch(() => getJson(`https://boards-api.eu.greenhouse.io${path}`));
    return stripHtml(d.content ?? "");
  }
  if (b.ats === "smartrecruiters") {
    const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${b.slug}/postings/${j.id}`);
    const s = d.jobAd?.sections ?? {};
    return stripHtml([s.jobDescription?.text, s.qualifications?.text, s.additionalInformation?.text].filter(Boolean).join("\n"));
  }
  return "";
}

export function fetchBoard(b: Board): Promise<RawJob[]> {
  switch (b.ats) {
    case "greenhouse":
      return greenhouse(b);
    case "lever":
      return lever(b);
    case "ashby":
      return ashby(b);
    case "smartrecruiters":
      return smartrecruiters(b);
    case "web":
      return Promise.resolve([]); // web-search finds are not read from a board
  }
}
