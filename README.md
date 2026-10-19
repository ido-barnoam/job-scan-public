# Job Scan

A daily job alert that checks company job boards, uses [TypeSafe](https://docs.typesafe.ai)'s Jev model
to judge which jobs fit you, and emails you the good ones with a link to a full, filterable report.
An optional second daily scan runs your saved LinkedIn searches (any company) the same way.

**Want your own copy?** You don't need to code:

- [GUIDE.md](GUIDE.md): step-by-step instructions for non-technical people, using Claude.
- [BUILD_PROMPT.md](BUILD_PROMPT.md): the prompt to give Claude (or another AI coding assistant). It tells
  the assistant to copy this repository and build your app from its code, changing only your settings.

**AI assistants reading this:** build from this repository's code. Copy it, change only the personal
settings in `config/` (and the location rules if the user is outside Israel), and keep everything else.

## How it works

Every morning a Vercel Cron job runs the scan:

1. **Boards**: reads each company's job board (Greenhouse, Lever, Ashby, SmartRecruiters) through its free
   public API. Jev checks each board really belongs to that company.
2. **Location**: code keeps jobs in the target country and drops clearly foreign ones; unclear locations
   ("Remote", "EMEA") are a Jev yes/no question.
3. **Fit**: Jev scores each job against your profile (four levels, from unrelated to the right role at
   the right level) and asks whether it is a role type you never want. The shortlist is re-scored from the
   full job description.
4. **Web search**: Tavily finds jobs at your companies outside those boards. Each result is read from the
   job's own data (Comeet's embedded JSON, or the ATS APIs) rather than guessed from the page.
5. **Tiers**: strong fit / worth a look / dropped (with a reason). Jobs already emailed aren't sent again.
6. **Output**: the full run is saved in Vercel Blob, and strong and worth-a-look jobs are emailed through
   Resend.

Earlier judgments are reused for unchanged jobs, so a normal day costs a fraction of a cent. Spending is
capped ($5 a month for Jev) and the free plans of Vercel, Resend, Tavily and Apify are guarded at 90%.

### Optional: the LinkedIn scan

A second cron job (`/api/linkedin`, two hours after the board scan) runs the saved searches in
`LINKEDIN_SEARCHES` through the Apify actor `valig/linkedin-jobs-scraper`: loose keywords as on LinkedIn,
optionally a radius or remote-only, no title filter. It covers **any company**, not just your list.

- Searches run at most 4 at a time (Apify's free plan allows 5 actor runs at once) and are merged by
  posting id. Postings seen in the last 30 days are passed to the actor as `skipJobId`, so they are
  neither downloaded nor paid for. A run looks back one day, or a week if there was no run in the last 30 hours.
- Jobs from recruitment agencies and aggregators (`AGENCIES`, `AGENCY_WORDS`) are dropped before Jev.
- LinkedIn's data includes the full posting, so Jev reads every job in full in a single pass, with the
  same questions and cut-offs as the board scan.
- It has its own email ("LinkedIn, any company") and report (marked LinkedIn in the run picker), and
  shares the Jev budget, role statuses and the 30-day "already sent" list with the board scan. That list
  also matches company + title, so a job is never emailed by both scans.
- Without `APIFY_TOKEN` the endpoint does nothing. A typical day costs a few cents of Apify's free $5
  monthly credit; a week-long first run is about $0.35.

## Files

| Path | What it is |
| --- | --- |
| `config/settings.ts` | **Your profile**, excluded role types, fit levels, cut-offs, web searches, usage limits |
| `config/companies.json` | Your companies (name and Glassdoor rating). An example list is included |
| `config/boards.json` | Job boards read directly (company, ATS, slug) |
| `config/reported.json` | Jobs you were already sent before using the app (optional) |
| `lib/scan.ts` | The daily pipeline and every Jev question; shared history, guardrails and dedup |
| `lib/linkedin.ts`, `lib/linkedinScan.ts` | Apify client, and the LinkedIn scan pipeline |
| `lib/finish.ts` | Shared end of a run: usage, email, save |
| `lib/jev.ts` | TypeSafe API client with the spending guard |
| `lib/boards.ts` | Job-board readers |
| `lib/web.ts`, `lib/webdata.ts` | Tavily search, and reading each result's job data |
| `lib/location.ts` | Code-side location rules (set up for Israel) |
| `lib/email.ts` | The daily email |
| `lib/usage.ts`, `lib/store.ts`, `lib/status.ts` | Usage tracking, run storage, role statuses |
| `app/api/scan` | The endpoint the cron calls (`?dry=1` for a test run with no email) |
| `app/api/linkedin` | The LinkedIn scan's endpoint (same `?dry=1`; `&week=1` to search the past week) |
| `app/r/[token]` | The report page |

## Environment variables

Set in Vercel → Project → Settings → Environment Variables (Production, Sensitive):

| Name | What |
| --- | --- |
| `TYPESAFE_API_KEY` | From console.typesafe.ai |
| `TAVILY_API_KEY` | From app.tavily.com |
| `RESEND_API_KEY` | From resend.com (optional, for the email) |
| `RECIPIENT_EMAIL` | Where the email goes (with Resend's free sender: your Resend sign-up address) |
| `CRON_SECRET` | Any long random string; protects the scan endpoint |
| `REPORT_TOKEN` | Any long random string; the secret part of the report link `/r/<token>` |
| `APIFY_TOKEN` | From console.apify.com → Settings → API & Integrations (optional, for the LinkedIn scan) |
| `BLOB_READ_WRITE_TOKEN` | Added automatically when you connect a Vercel Blob store |

## Run a scan by hand

`GET /api/scan` with `Authorization: Bearer $CRON_SECRET` (or `?key=$CRON_SECRET`). Add `?dry=1` for a test
(no email, nothing marked as sent), `&boards=5` to read only the first five boards, `&fresh=1` (dry runs)
to re-ask Jev about every job.

`GET /api/linkedin` the same way, with `?dry=1`, `&week=1` (search the past week) and `&searches=2`
(run only the first two saved searches). Outside production, runs are dry unless you add `&send=1`.

## Notes

- Location rules and the time zone are set up for Israel; `BUILD_PROMPT.md` tells the assistant what to
  change for another country.
- Vercel builds every push. On a branch other than `main` it builds a preview without touching the live
  app, which is a safe way to check a change compiles. Preview deployments need their own environment
  variables (tick Preview), and preview links ask you to sign in to Vercel.
- Built with Next.js on Vercel. No database; runs and statuses are JSON files in Vercel Blob.
