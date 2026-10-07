# Build prompt

Copy everything below the line into Claude Code (or another AI coding assistant) after filling in the
**About me** section. If you leave parts of it blank, the assistant will ask you.

---

I want you to build and deploy my own copy of **Job Scan**, a small web app that checks job boards every
morning, uses an AI judgment service called Jev (by TypeSafe) to decide which jobs fit me, and emails me
the good ones with a link to a full report. I am not a developer, so you will do the technical work and
guide me through anything I have to do myself.

## About me (fill in, or leave blank and ask me)

- My name:
- The email address I want the daily email sent to:
- The country I'm job hunting in (the reference code is set up for Israel):
- The roles I'm looking for, in my own words:
- My seniority (for example: senior individual contributor, manager, director):
- Role types I never want (for example: engineering, HR, finance, entry-level):
- Companies I want covered (a list, or "start from the example list"):
- Do I want a daily email? (yes / no — the report works either way)

## Start from the reference code

A working version of this app is public at **https://github.com/ido-barnoam/job-scan-public**.
Read its `README.md` and code before writing anything, and reuse it. Do not rewrite it from scratch.
The parts that should change for me are:

- `config/settings.ts`: `PROFILE`, `EXCLUDED_ROLE_TYPES`, `FIT_LEVELS` (only if my seniority needs
  different wording), `WEB_SEARCHES`, and the limits in `USAGE_LIMITS` if I ask.
- `config/companies.json`: my companies (name and Glassdoor rating; ask me for ratings or use 0).
- `config/boards.json`: the job boards to read directly for my companies (see "Finding job boards").
- `lib/location.ts` and the from-country question in `lib/scan.ts`, only if I'm not job hunting in Israel.

If you can't reach GitHub, ask me to download the repository as a ZIP and add it to the folder.

## How you work with me

1. Explain each step in one or two plain sentences before doing it. One step at a time.
2. **Never ask me to paste an API key, password or token into this chat.** When a key is needed, tell
   me exactly where in Vercel to paste it (Project → Settings → Environment Variables), what name to
   give it, and to tick Production and mark it Sensitive.
3. Ask before anything that costs money, publishes something, or sends an email.
4. Test with dry runs (no email) before turning on the daily schedule.
5. When something fails, read the error yourself (build log, function log) and fix it. Don't ask me
   to debug.

## What the app does (match this behavior)

Every day at 01:00 UTC a Vercel Cron job calls `/api/scan`. The scan:

1. **Reads the job boards** in `config/boards.json` through their free public APIs:
   Greenhouse (`boards-api.greenhouse.io/v1/boards/{slug}/jobs`, with the EU host as fallback),
   Lever (`api.lever.co/v0/postings/{slug}?mode=json`), Ashby
   (`api.ashbyhq.com/posting-api/job-board/{slug}`) and SmartRecruiters
   (`api.smartrecruiters.com/v1/companies/{slug}/postings`).
2. **Checks each board belongs to the company** (Jev yes/no question on a sample of its listings).
3. **Sorts jobs by location in code**: a known city or country in my target country counts, a clearly
   foreign location is dropped, and unclear ones ("Remote", "EMEA") go to Jev, which is asked whether
   the job can be done from my country (kept at 64% or higher).
4. **Scores every remaining job with Jev** in one request with two questions: fit to my profile
   (a Score on four levels: unrelated, adjacent, right function but too junior, right function at the
   right level) and whether it is an excluded role type (yes/no).
5. **Second pass**: for the shortlist, and jobs just below it, fetches the full job description and asks
   the same questions again; these answers replace the title-only ones.
6. **Web search** (Tavily, 6 searches a day, basic depth) finds jobs at my companies outside the boards
   above. For each result it reads the job's own data instead of the page text: Comeet pages embed
   `COMPANY_DATA`, `POSITION_DATA` and `COMPANY_POSITIONS_DATA` as JSON, and Greenhouse, Lever, Ashby and
   SmartRecruiters links are looked up in their APIs. A careers page becomes one entry per job, unless the
   company is not on my list, in which case it stays one row. The company is matched to my list by code;
   Jev only chooses the company (or "none") when the data doesn't name one, and a job site's own name
   (like "Comeet") is never offered as the employer. LinkedIn "closed" readings are not trusted; those
   jobs are kept with a "check in a browser" note.
7. **Tiers**: strong fit = fit ≥ 2.5 and excluded-role chance under 50%; worth a look = fit ≥ 1.5 and
   excluded under 70%; everything else is dropped with a reason. Jobs emailed in the last 30 days are
   "already sent" and not emailed again.
8. **Saves the full run** as one JSON file in Vercel Blob, and **emails** strong fits and worth-a-look
   jobs through Resend, with a link to the report.

Earlier answers are reused for unchanged jobs, so a normal day costs a fraction of a cent.

**The report** (`/r/{REPORT_TOKEN}`) has tabs for Considered, Dropped, Companies checked and Usage; per
position: company, ATS, location, fit, confidence, excluded-role chance, a Role status dropdown
(New / CV sent / Not relevant, saved per job across runs) and a "Why?" link that opens how Jev decided
(the verdict sentence, source, location, both passes with Jev's probabilities, the rule applied, and the
exact questions). Filters: search, company, ATS, tier or reason, role status, minimum confidence, minimum
fit; a run picker shows past days.

**Guardrails**: Jev stops at $5 a month and $0.50 per run; the scan is skipped if any Vercel Hobby quota
passes 90%; the email is skipped near Resend's free limits; web searches are skipped near Tavily's
1,000 free searches a month. The report's Usage tab shows each service's use against its limit.

## Services and settings

| Service | Used for | Cost |
| --- | --- | --- |
| GitHub | Holds my copy of the code | Free |
| Vercel (Hobby) | Runs the app, the daily schedule and the storage (Blob) | Free |
| TypeSafe (Jev) | The fit, location and company judgments | Pay as you go, cents a month |
| Tavily | Web search | Free plan, 1,000 searches a month |
| Resend | The daily email (optional) | Free plan |

Environment variables in Vercel (Production, Sensitive): `TYPESAFE_API_KEY`, `TAVILY_API_KEY`,
`RESEND_API_KEY`, `RECIPIENT_EMAIL`, `CRON_SECRET` and `REPORT_TOKEN` (generate the last two as long
random strings and tell me how to copy them; `REPORT_TOKEN` is the secret part of my report link).
`BLOB_READ_WRITE_TOKEN` is added automatically when you connect a Blob store to the project.
With Resend's free test sender (`onboarding@resend.dev`), `RECIPIENT_EMAIL` must be the address I
signed up to Resend with.

## Finding job boards for my companies

For each company on my list, try its likely slug (lower-case name without spaces or punctuation) on the
four board APIs above. Keep a board only if it returns jobs and Jev's "does this board belong to the
company" check passes. Show me which companies have a board and which will rely on web search only.

## Order of work

1. Ask me anything missing from **About me**, then write my profile, excluded role types and web
   searches, and show them to me in plain language for approval.
2. Set up my copy of the code on GitHub and a Vercel project linked to it, with a Blob store.
3. Walk me through creating the TypeSafe, Tavily and (if I want email) Resend accounts and adding the
   keys in Vercel.
4. Deploy, then run a dry scan (`/api/scan?dry=1`, authorized with `CRON_SECRET`) and show me the report
   link and a short summary of what it found.
5. Once I'm happy, run one real scan so I get the first email, and confirm the daily schedule is on.
6. Finish with a short note telling me how to change my profile or companies later (by asking you), and
   where to find the report.

## Done means

- The report link opens and shows today's run with my companies and my roles.
- A dry run completes without errors, and the Usage tab shows Jev cost under a cent for a normal day.
- If I wanted email: I received the first email.
- The daily schedule is on, and nothing in the code or the repository contains my keys.
