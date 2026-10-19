"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { USAGE_LIMITS } from "../../../../config/settings";
import { isLinkedIn } from "../../../../lib/links";
import type { RoleStatus, StatusMap } from "../../../../lib/status";
import type { BoardResult, JobResult, Judgment, RunReport } from "../../../../lib/types";

type Tab = "companies" | "considered" | "dropped" | "usage";

const TIER_LABEL: Record<string, string> = { strong: "Strong fit", look: "Worth a look", seen: "Already sent", dropped: "Dropped" };
const REASON_LABEL: Record<string, string> = {
  low_fit: "Low fit",
  excluded: "Excluded role type",
  not_israel: "Not doable from Israel",
  wrong_company: "Board belongs to another company",
  not_judged: "Not judged (Jev error or budget)",
  not_on_list: "Company not on your list",
  closed: "Posting closed",
  unreadable: "Page couldn't be read",
};
const ROLE_LABEL: Record<RoleStatus, string> = { new: "New", cv_sent: "CV sent", not_relevant: "Not relevant" };
type Row = JobResult & { roleStatus: RoleStatus };

const SOURCE_LABEL: Record<string, string> = { comeet: "Comeet", greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", smartrecruiters: "SmartRecruiters" };
const ATS_LABEL: Record<string, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", smartrecruiters: "SmartRecruiters", web: "Web search" };
// Where a role came from: the company's job board system, or for web-search finds, the site it was found on.
function origin(j: JobResult): { label: string; site?: string } {
  if (j.ats !== "web") return { label: ATS_LABEL[j.ats] ?? j.ats };
  let site: string | undefined;
  try {
    site = new URL(j.url).hostname.replace(/^www\./, "");
  } catch {}
  return { label: "Web search", site };
}

const STATUS_LABEL: Record<string, string> = { ok: "Covered", empty: "No openings", failed: "Failed", wrong_company: "Wrong company" };

function Bar({ value, max = 1, label }: { value?: number; max?: number; label?: string }) {
  if (value === undefined) return <span className="muted">—</span>;
  return (
    <span className="bar" title={label}>
      <span className="bar-track"><span className="bar-fill" style={{ width: `${Math.min(100, (value / max) * 100)}%` }} /></span>
      <span className="num">{max === 1 ? `${Math.round(value * 100)}%` : value.toFixed(2)}</span>
    </span>
  );
}

// Run ids are UTC timestamps with dashes (2026-09-23T01-00-05Z); show them in Israel time.
const runLabel = (id: string) => {
  const d = new Date(id.replace(/T(\d\d)-(\d\d)-(\d\d)Z$/, "T$1:$2:$3Z"));
  return isNaN(+d) ? id : d.toLocaleString("en-GB", { timeZone: "Asia/Jerusalem", dateStyle: "medium", timeStyle: "short" });
};

function useSort<T>(rows: T[], initial: keyof T, desc = true) {
  const [key, setKey] = useState<keyof T>(initial);
  const [down, setDown] = useState(desc);
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const x = a[key] as any, y = b[key] as any;
        const c = x === undefined ? -1 : y === undefined ? 1 : typeof x === "string" ? x.localeCompare(y) : x - y;
        return down ? -c : c;
      }),
    [rows, key, down],
  );
  const th = (k: keyof T, label: string, className?: string) => (
    <th className={className} onClick={() => (k === key ? setDown(!down) : (setKey(k), setDown(true)))} aria-sort={k === key ? (down ? "descending" : "ascending") : "none"}>
      {label} {k === key ? (down ? "↓" : "↑") : ""}
    </th>
  );
  return { sorted, th };
}

export default function Report({ report, runs, base, token, initialStatuses }: { report: RunReport; runs: string[]; base: string; token: string; initialStatuses: StatusMap }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("considered");
  const [q, setQ] = useState("");
  const [company, setCompany] = useState("");
  const [ats, setAts] = useState("");
  const [group, setGroup] = useState(""); // tier, reason or status depending on tab
  const [minConf, setMinConf] = useState(0);
  const [minFit, setMinFit] = useState(0);
  const [roleFilter, setRoleFilter] = useState("");
  const [statuses, setStatuses] = useState<Record<string, RoleStatus>>(() =>
    Object.fromEntries(Object.entries(initialStatuses).map(([k, v]) => [k, v.status])),
  );
  const [saveError, setSaveError] = useState("");
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  // Optimistic: the dropdown changes at once; saves run one at a time so none is lost.
  const changeStatus = (key: string, status: RoleStatus) => {
    const before = statuses[key] ?? "new";
    setStatuses((s) => ({ ...s, [key]: status }));
    setSaveError("");
    queue.current = queue.current.then(async () => {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-report-token": token },
        body: JSON.stringify({ key, status }),
      }).catch(() => null);
      if (!res?.ok) {
        setStatuses((s) => ({ ...s, [key]: before }));
        setSaveError("Couldn't save the role status. Check your connection and try again.");
      }
    });
  };
  const withStatus = (j: JobResult): Row => ({ ...j, roleStatus: statuses[j.key] ?? "new" });

  const considered = report.jobs.filter((j) => j.tier !== "dropped");
  const dropped = report.jobs.filter((j) => j.tier === "dropped");
  const companies = [...new Set(report.jobs.map((j) => j.company).concat(report.boards.map((b) => b.company)))].sort();
  const text = q.trim().toLowerCase();

  const jobFilter = (j: Row) =>
    (!roleFilter || j.roleStatus === roleFilter) &&
    (!text || `${j.title} ${j.company} ${j.location} ${j.team ?? ""}`.toLowerCase().includes(text)) &&
    (!company || j.company === company) &&
    (!ats || j.ats === ats) &&
    (!group || j.tier === group || j.reason === group) &&
    (j.fitConfidence ?? 0) >= minConf &&
    (j.fit ?? 0) >= minFit;
  const boardFilter = (b: BoardResult) =>
    (!text || b.company.toLowerCase().includes(text)) && (!company || b.company === company) && (!ats || b.ats === ats) && (!group || b.status === group);

  const switchTab = (t: Tab) => { setTab(t); setGroup(""); };
  const reset = () => { setQ(""); setCompany(""); setAts(""); setGroup(""); setMinConf(0); setMinFit(0); setRoleFilter(""); };
  const s = report.stats;
  const when = new Date(report.startedAt).toLocaleString("en-GB", { timeZone: "Asia/Jerusalem", dateStyle: "medium", timeStyle: "short" });

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>Job scan</h1>
          <p className="muted">
            {when} Israel time{report.dryRun ? " · test run, not emailed" : ""} · {report.env}
          </p>
        </div>
        <label className="field">
          <span>Run</span>
          <select value={report.id} onChange={(e) => router.push(`${base}/${e.target.value}`)}>
            {runs.map((id) => <option key={id} value={id}>{runLabel(id)}</option>)}
          </select>
        </label>
      </header>

      <section className="tiles">
        <div className="tile"><b>{s.strong}</b><span>Strong fit</span></div>
        <div className="tile"><b>{s.look}</b><span>Worth a look</span></div>
        <div className="tile"><b>{s.seen}</b><span>Already sent</span></div>
        <div className="tile"><b>{s.dropped}</b><span>Dropped</span></div>
        <div className="tile"><b>{s.boardsCovered}/{s.boards}</b><span>Boards covered</span></div>
        <div className="tile"><b>{s.judged}</b><span>Jobs judged by Jev</span></div>
      </section>

      {(report.guard?.stopped || (report.guard?.warnings.length ?? 0) > 0) && (
        <div className="guard">
          <b>Usage guardrail</b>
          {report.guard?.stopped && <div>{report.guard.stopped}</div>}
          {report.guard?.warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}

      {report.errors.length > 0 && (
        <details className="errors">
          <summary>{report.errors.length} error{report.errors.length > 1 ? "s" : ""} in this run</summary>
          <ul>{report.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </details>
      )}

      <nav className="tabs" role="tablist">
        {([["considered", `Considered (${considered.length})`], ["dropped", `Dropped (${dropped.length})`], ["companies", `Companies checked (${report.boards.length})`], ["usage", "Usage"]] as [Tab, string][]).map(([t, l]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => switchTab(t)}>{l}</button>
        ))}
      </nav>

      {tab === "usage" ? <UsageView report={report} /> : <>
      <section className="filters">
        <label className="field grow"><span>Search</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, company, location" /></label>
        <label className="field"><span>Company</span>
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">All</option>{companies.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field"><span>ATS</span>
          <select value={ats} onChange={(e) => setAts(e.target.value)}>
            <option value="">All</option>{["greenhouse", "lever", "ashby", "smartrecruiters", "web"].map((a) => <option key={a}>{a}</option>)}
          </select>
        </label>
        <label className="field"><span>{tab === "considered" ? "Tier" : tab === "dropped" ? "Reason" : "Status"}</span>
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">All</option>
            {Object.entries(tab === "considered" ? { strong: TIER_LABEL.strong, look: TIER_LABEL.look, seen: TIER_LABEL.seen } : tab === "dropped" ? REASON_LABEL : STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {tab !== "companies" && (
          <>
            <label className="field"><span>Min confidence {Math.round(minConf * 100)}%</span><input type="range" min={0} max={1} step={0.05} value={minConf} onChange={(e) => setMinConf(+e.target.value)} /></label>
            <label className="field"><span>Min fit {minFit.toFixed(1)}</span><input type="range" min={0} max={3} step={0.1} value={minFit} onChange={(e) => setMinFit(+e.target.value)} /></label>
          </>
        )}
        {tab !== "companies" && (
          <label className="field"><span>Role status</span>
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
              <option value="">All</option>
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        )}
        <button className="link" onClick={reset}>Reset</button>
      </section>

      {tab === "companies" ? <Boards rows={report.boards.filter(boardFilter)} /> : <Jobs rows={(tab === "considered" ? considered : dropped).map(withStatus).filter(jobFilter)} dropped={tab === "dropped"} report={report} onStatus={changeStatus} />}
      {saveError && <p className="save-error" role="alert">{saveError}</p>}
      </>}

      <footer className="muted small">
        Profile version {report.profileVersion} · cut-offs: strong ≥ {report.thresholds.strongFit}, worth a look ≥ {report.thresholds.lookFit} ·{" "}
        {s.verified ?? 0} re-checked against the full posting · {s.jevCalls} Jev calls, {s.cachedJudgments} reused from earlier runs · {s.inputTokens.toLocaleString()} input tokens
      </footer>
    </main>
  );
}

function Jobs({ rows, dropped, report, onStatus }: { rows: Row[]; dropped: boolean; report: RunReport; onStatus: (key: string, s: RoleStatus) => void }) {
  const { sorted, th } = useSort(rows, "fit");
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <p className="empty">No positions match these filters.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {th("title", "Position")}
            {th("company", "Company")}
            {th("ats", "ATS")}
            {th("rating", "Glassdoor", "hide-md")}
            {th("location", "Location", "hide-sm")}
            {th("fit", "Fit (0–3)")}
            {th("fitConfidence", "Confidence")}
            {th("excluded", "Excluded type", "hide-sm")}
            {th("roleStatus", "Role status")}
            <th>{dropped ? "Reason" : "Tier"}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((j) => (
            <Fragment key={j.key}>
              <tr className={open === j.key ? "row-open" : undefined}>
                <td>
                  <a href={j.url} target="_blank" rel="noreferrer">{j.title}</a>
                  {j.team && <div className="muted small">{j.team}</div>}
                  {j.source === "web" && <div className="muted small">Found by web search</div>}
                  {j.source === "web" && j.tier !== "dropped" && isLinkedIn(j.url) && <div className="check small">LinkedIn: check in a browser that it&apos;s still open</div>}
                </td>
                <td>{j.company}</td>
                <td>
                  {origin(j).label}
                  {origin(j).site && <div className="muted small">{origin(j).site}</div>}
                </td>
                <td className="hide-md">{j.rating || "—"}</td>
                <td className="hide-sm">{j.location}{j.remoteOk !== undefined && <div className="muted small">From Israel: {Math.round(j.remoteOk * 100)}%</div>}</td>
                <td>
                  <Bar value={j.fit} max={3} />
                  {j.verified && <div className="muted small">Read full posting{j.titleFit !== undefined ? ` · title alone ${j.titleFit.toFixed(2)}` : ""}</div>}
                </td>
                <td><Bar value={j.fitConfidence} /></td>
                <td className="hide-sm"><Bar value={j.excluded} /></td>
                <td>
                  <select
                    className={`role ${j.roleStatus}`}
                    value={j.roleStatus}
                    aria-label={`Role status for ${j.title}`}
                    onChange={(e) => onStatus(j.key, e.target.value as RoleStatus)}
                  >
                    {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </td>
                <td>
                  <span className={`pill ${j.tier} ${j.reason ?? ""}`}>{dropped ? REASON_LABEL[j.reason ?? ""] ?? "Dropped" : TIER_LABEL[j.tier]}</span>
                  <button className="why" aria-expanded={open === j.key} onClick={() => setOpen(open === j.key ? null : j.key)}>
                    {open === j.key ? "Hide" : "Why?"}
                  </button>
                </td>
              </tr>
              {open === j.key && (
                <tr className="explain-row">
                  <td colSpan={10}><Explain j={j} report={report} /></td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const pctText = (x?: number) => (x === undefined ? "—" : `${Math.round(x * 100)}%`);
const fitText = (x?: number) => (x === undefined ? "—" : x.toFixed(2));

// One sentence: which rule produced this tier.
function verdict(j: JobResult, t: Record<string, number>): string {
  const fit = fitText(j.fit), ex = pctText(j.excluded);
  switch (j.reason ?? j.tier) {
    case "strong":
      return `Strong fit: fit ${fit} is at least ${t.strongFit}, and the chance this is an excluded role type (${ex}) is under ${pctText(t.strongMaxExcluded)}.`;
    case "look":
      return (j.fit ?? 0) >= t.strongFit
        ? `Worth a look: fit ${fit} is high, but the chance this is an excluded role type (${ex}) is above ${pctText(t.strongMaxExcluded)}, so it is not a strong fit.`
        : `Worth a look: fit ${fit} is between ${t.lookFit} and ${t.strongFit}, and the excluded-role chance (${ex}) is under ${pctText(t.lookMaxExcluded)}.`;
    case "seen":
      return `Already sent in an earlier email, so it is not emailed again. Its fit is ${fit}.`;
    case "low_fit":
      return `Dropped: fit ${fit} is below the ${t.lookFit} needed for "worth a look".`;
    case "excluded":
      return `Dropped: Jev put the chance this is an excluded role type (engineering, IT or security ops, finance, HR, admin, entry-level) at ${ex}, above ${pctText(t.lookMaxExcluded)}.`;
    case "not_israel":
      return j.remoteOk === undefined
        ? `Dropped: the job is in ${j.location}, outside Israel, and not remote.`
        : `Dropped: Jev put the chance this job can be done from Israel at ${pctText(j.remoteOk)}, below ${pctText(t.remoteOk)}.`;
    case "wrong_company":
      return `Dropped: this board's listings did not look like ${j.company}'s (${pctText(j.boardMatch)} match), so its jobs were not judged.`;
    case "not_judged":
      return "Not judged: the Jev call failed or the monthly budget was reached.";
    case "not_on_list":
      return j.web?.collapsedJobs
        ? `Dropped: this is ${j.company}'s careers page with ${j.web.collapsedJobs} jobs, and ${j.company} is not on your company list, so its jobs are shown as this one row.`
        : "Dropped: the hiring company is not on your company list.";
    case "closed":
      return j.web?.closedByData
        ? "Dropped: the link is to a job that is no longer in the company's live job list."
        : `Dropped: the job's page says it is closed (${pctText(j.web?.statusProbs?.closed)}).`;
    case "unreadable":
      return "Dropped: the app couldn't read the job's page (it was blocked, removed, or empty), so only the search snippet was available and there's no way to tell whether the job still exists.";
  }
  return "";
}

function Probs({ probs, labels }: { probs?: Record<string, number>; labels?: Record<string, string> }) {
  if (!probs) return null;
  return (
    <div className="probs">
      {Object.entries(probs).map(([k, v]) => (
        <div key={k} className="prob">
          <span className="prob-label">{labels?.[k] ?? k}</span>
          <Bar value={v} />
        </div>
      ))}
    </div>
  );
}

function Pass({ title, p, levels, extra }: { title: string; p: Judgment; levels: Record<string, string>; extra?: string }) {
  return (
    <div className="step">
      <b>{title}</b>
      {extra && <div className="muted small">{extra}</div>}
      <div>
        Fit <b>{fitText(p.fit)}</b> of 3 (confidence {pctText(p.fitConfidence)}). How Jev split its answer across the fit levels:
      </div>
      <Probs probs={p.fitProbs} labels={levels} />
      <div>Chance it is an excluded role type: <b>{pctText(p.excluded)}</b></div>
      {p.remoteOk !== undefined && <div>Chance it can be done from Israel: <b>{pctText(p.remoteOk)}</b></div>}
    </div>
  );
}

function Explain({ j, report }: { j: JobResult; report: RunReport }) {
  const t = report.thresholds;
  const m = report.method;
  const levels = Object.fromEntries((m?.fitLevels ?? ["0", "1", "2", "3"]).map((l, i) => [String(i), `${i} · ${l}`]));
  // Runs saved before the trail existed only have the final answers.
  const titlePass: Judgment | undefined =
    j.titlePass ?? (j.verified && j.titleFit !== undefined ? { fit: j.titleFit, fitConfidence: j.titleFitConfidence } : !j.verified && j.fit !== undefined ? j : undefined);
  const postingPass = j.postingPass ?? (j.verified ? { ...j, chars: 0 } : undefined);
  return (
    <div className="explain">
      <p className="verdict">{verdict(j, t)}</p>
      <ol className="steps">
        <li className="step">
          <b>Source</b>
          {j.source === "web" ? (
            <div>
              Found by a web search (Tavily){j.web?.query ? <> for <i>{j.web.query}</i></> : null}.
              {j.web?.snippet && <div className="muted small">Search snippet: {j.web.snippet}</div>}
              {j.web?.fromData ? (
                <div>
                  Details (company, title, location, description) were read from the job&apos;s own {SOURCE_LABEL[j.web.fromData]} data, not guessed from the page
                  {j.web.dataCompany ? <>: company <b>{j.web.dataCompany}</b></> : null}.
                </div>
              ) : (
                <div>This site has no job data the app can read, so Jev worked from the page text and the search snippet.</div>
              )}
              {j.web?.expandedFrom && (
                <div>
                  The search found the company&apos;s careers page (<a href={j.web.expandedFrom} target="_blank" rel="noreferrer">link</a>), which lists several jobs. Each job
                  was checked on its own.
                </div>
              )}
            </div>
          ) : (
            <div>Read directly from {j.company}&apos;s {j.ats} job board.{j.boardMatch !== undefined && <> Jev&apos;s check that the board belongs to {j.company}: <b>{pctText(j.boardMatch)}</b>.</>}</div>
          )}
        </li>
        {j.source === "web" && !j.web?.companyProbs && j.company !== "—" && (
          <li className="step">
            <b>Which company is hiring</b>
            <div>
              {j.reason === "not_on_list"
                ? `The job's data names "${j.company}", which is not on your company list.`
                : `The job's data names "${j.web?.dataCompany ?? j.company}", matched by code to "${j.company}" on your list.`}
            </div>
          </li>
        )}
        {j.source === "web" && j.web?.companyProbs && (
          <li className="step">
            <b>Which company is hiring</b>
            <div>Code shortlisted companies from your list whose names appear in the result; Jev picked one (or none):</div>
            <Probs probs={j.web.companyProbs} />
            {j.web.titleProbs && Object.keys(j.web.titleProbs).length > 0 && (
              <>
                <div>
                  Job title: code collected possible titles from the search result and the page; Jev picked one
                  {j.web.pageTitle && j.web.pageTitle !== j.title ? <> (the search result itself was titled &quot;{j.web.pageTitle}&quot;)</> : null}:
                </div>
                <Probs probs={j.web.titleProbs} />
              </>
            )}
            <div>Is the posting still open, based on its page ({j.web.pageChars.toLocaleString()} characters read):</div>
            <Probs probs={j.web.statusProbs} />
            {isLinkedIn(j.url) && (
              <div className="muted small">
                LinkedIn shows logged-out visitors a sign-in or &quot;no longer accepting&quot; page, so this reading isn&apos;t used to drop the job. Check it in a browser.
              </div>
            )}
          </li>
        )}
        {!j.web?.collapsedJobs && (
        <li className="step">
          <b>Location</b>
          <div>
            {j.locationClass === "israel"
              ? `Code matched an Israeli location in "${j.location}", so no question was needed.`
              : j.locationClass === "elsewhere"
                ? `"${j.location}" is outside Israel and the job is not remote, so it was dropped without asking Jev.`
                : `"${j.location}" does not name an Israeli city, so Jev was asked whether the job can be done from Israel: ${pctText(j.remoteOk)} (the cut-off is ${pctText(t.remoteOk)}).`}
          </div>
        </li>
        )}
        {titlePass && <li><Pass title="First pass: title only" p={titlePass} levels={levels} /></li>}
        {postingPass && (
          <li>
            <Pass
              title="Second pass: full posting"
              p={postingPass}
              levels={levels}
              extra={`Jev read the job's full text${postingPass.chars ? ` (${postingPass.chars.toLocaleString()} characters)` : ""} and answered the same questions again. These answers replace the title-only ones.`}
            />
          </li>
        )}
        <li className="step">
          <b>Rule applied</b>
          <div>
            Strong fit: fit ≥ {t.strongFit} and excluded-role chance under {pctText(t.strongMaxExcluded)}. Worth a look: fit ≥ {t.lookFit} and excluded-role
            chance under {pctText(t.lookMaxExcluded)}. Anything else is dropped. Jobs already emailed in the last 30 days show as &quot;Already sent&quot;.
            {j.cached && " These answers were reused from an earlier run because the job has not changed."}
          </div>
        </li>
      </ol>
      {m && (
        <details className="questions">
          <summary>Exact questions Jev was asked</summary>
          <p><b>Your profile (given to Jev with every job):</b> {m.profile}</p>
          <pre>{JSON.stringify(m.questions, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function Boards({ rows }: { rows: BoardResult[] }) {
  const { sorted, th } = useSort(rows, "rating");
  if (!rows.length) return <p className="empty">No companies match these filters.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {th("company", "Company")}
            {th("rating", "Glassdoor")}
            {th("ats", "ATS", "hide-sm")}
            <th>Status</th>
            {th("total", "Openings")}
            {th("israel", "In Israel")}
            {th("ambiguous", "Remote / unclear", "hide-sm")}
            {th("boardMatch", "Board matches company", "hide-sm")}
          </tr>
        </thead>
        <tbody>
          {sorted.map((b) => (
            <tr key={b.slug}>
              <td>{b.company}{b.error && <div className="muted small">{b.error}</div>}</td>
              <td>{b.rating}</td>
              <td className="hide-sm">{b.ats}</td>
              <td><span className={`pill ${b.status}`}>{STATUS_LABEL[b.status]}</span></td>
              <td>{b.total}</td>
              <td>{b.israel}</td>
              <td className="hide-sm">{b.ambiguous}</td>
              <td className="hide-sm"><Bar value={b.boardMatch} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

function UsageView({ report }: { report: RunReport }) {
  const run = report.usage, month = report.monthUsage;
  if (!run || !month) return <p className="empty">This run was saved before usage tracking was added.</p>;
  const L = USAGE_LIMITS, V = L.vercel;
  const stored = report.blobStoredBytes ?? 0;
  // [service, metric, this run, month to date, monthly limit, formatter]
  const rows: [string, string, number, number, number, (n: number) => string][] = [
    ["Jev", "Cost (USD)", run.jev.usd, month.jev.usd, L.jev.monthlyBudgetUsd, (n) => `$${fmt(n, 4)}`],
    ["Jev", "Input tokens", run.jev.inputTokens, month.jev.inputTokens, (L.jev.monthlyBudgetUsd / L.jev.usdPerMillionInputTokens) * 1e6, (n) => fmt(n)],
    ["Jev", "Calls", run.jev.calls, month.jev.calls, NaN, (n) => fmt(n)],
    ["Vercel", "Active CPU (hours)", run.vercel.activeCpuSec / 3600, month.vercel.activeCpuSec / 3600, V.activeCpuHours, (n) => fmt(n, 4)],
    ["Vercel", "Provisioned memory (GB-hours)", run.vercel.memoryGbHours, month.vercel.memoryGbHours, V.provisionedMemoryGbHours, (n) => fmt(n, 3)],
    ["Vercel", "Function invocations (scans)", run.vercel.runs, month.vercel.runs, V.invocations, (n) => fmt(n)],
    ["Vercel", "Blob storage (GB, all runs)", stored / 1e9, stored / 1e9, V.blobStorageGb, (n) => fmt(n, 3)],
    ["Vercel", "Blob advanced operations", run.vercel.blobAdvancedOps, month.vercel.blobAdvancedOps, V.blobAdvancedOps, (n) => fmt(n)],
    ["Vercel", "Blob simple operations", run.vercel.blobSimpleOps, month.vercel.blobSimpleOps, V.blobSimpleOps, (n) => fmt(n)],
    ["Vercel", "Blob data transfer (GB)", run.vercel.blobBytesRead / 1e9, month.vercel.blobBytesRead / 1e9, V.blobTransferGb, (n) => fmt(n, 3)],
    ["Resend", "Emails", run.resend.emails, month.resend.emails, L.resend.emailsPerMonth, (n) => fmt(n)],
    ["Tavily", "Web searches", run.tavily?.searches ?? 0, month.tavily?.searches ?? 0, L.tavily.searchesPerMonth, (n) => fmt(n)],
  ];
  return (
    <>
      <section className="tiles">
        <div className="tile"><b>${fmt(run.jev.usd, 4)}</b><span>Jev, this run</span></div>
        <div className="tile"><b>${fmt(month.jev.usd, 3)}</b><span>Jev, this month</span></div>
        <div className="tile"><b>${fmt(Math.max(0, L.jev.monthlyBudgetUsd - month.jev.usd), 2)}</b><span>Left of ${L.jev.monthlyBudgetUsd} Jev budget</span></div>
        <div className="tile"><b>$0</b><span>Vercel, Resend, Tavily (free plans)</span></div>
      </section>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Service</th><th>Metric</th><th>This run</th><th>This month</th><th className="hide-sm">Monthly limit</th><th>Left</th><th className="hide-sm">Used</th></tr>
          </thead>
          <tbody>
            {rows.map(([svc, metric, r, m, limit, f]) => (
              <tr key={metric}>
                <td>{svc}</td>
                <td>{metric}</td>
                <td className="num">{f(r)}</td>
                <td className="num">{f(m)}</td>
                <td className="num hide-sm">{isNaN(limit) ? "—" : f(limit)}</td>
                <td className="num">{isNaN(limit) ? "—" : f(Math.max(0, limit - m))}</td>
                <td className="hide-sm">{isNaN(limit) ? <span className="muted">—</span> : <Bar value={Math.min(1, m / limit)} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Guardrails: Jev stops at ${L.jev.monthlyBudgetUsd}/month and ${L.jev.perRunCapUsd}/run. Vercel is on the free Hobby plan, which cannot bill;
        the scan is skipped if any Hobby quota passes {Math.round(L.stopAtShare * 100)}%. Resend is on the free plan ({fmt(L.resend.emailsPerMonth)}/month,
        {" "}{L.resend.emailsPerDay}/day); the email is skipped near those limits. Tavily is on the free plan ({fmt(L.tavily.searchesPerMonth)} searches/month,
        no card); the web searches are skipped near that limit. Months are calendar months in UTC. Vercel figures are measured by the
        scan itself; opening this report also uses a few Blob operations that are not counted here. Vercel&apos;s own dashboard is the source of truth.
      </p>
    </>
  );
}
