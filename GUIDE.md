# Build your own Job Scan: a step-by-step guide

This guide is for people who don't write code. You'll use an AI assistant (Claude) to build your own
copy of Job Scan, a small app that checks job boards every morning, picks the jobs that fit you, and
emails you the good ones with a link to a full report.

**You need:** a computer, about an hour for the first setup, and a paid Claude plan (Pro or higher)
for Claude Code. Everything else is free or costs a few cents a month.

**You'll end up with:**

- a daily email (if you want one) listing new jobs that fit you, split into "Strong fit" and
  "Worth a look";
- a private report page with every job checked, a fit score for each, the reason each was kept or
  dropped, and a place to mark jobs as "CV sent" or "Not relevant".

---

## Step 1: Create the accounts

Open each site, sign up, and keep the browser tab open. When a step says "copy the key", paste it into
a private note for now. **Never paste keys into the chat with the AI.** You'll paste them into Vercel later.

1. **GitHub** (github.com): sign up. This is where your copy of the app's code will live.
2. **Vercel** (vercel.com): choose **Sign up → Continue with GitHub**, and pick the free **Hobby** plan.
   This is where your app will run.
3. **TypeSafe** (console.typesafe.ai): sign up, open **API keys**, create a key and copy it.
   This is the AI that judges which jobs fit you. It costs cents a month; add a payment method if asked.
4. **Tavily** (app.tavily.com): sign up on the free plan and copy your API key (it starts with `tvly-`).
   This runs the web searches.
5. **Resend** (resend.com), only if you want the daily email: sign up **with the email address you want
   the job emails sent to**, open **API Keys**, create a key and copy it.

## Step 2: Install Claude and open a folder

1. Download the **Claude desktop app** from claude.ai/download and sign in.
2. Create an empty folder on your computer, for example `Documents/job-scan`.
3. In the Claude app, open the **Code** tab and choose that folder.

## Step 3: Give Claude the build prompt

1. Open the file `BUILD_PROMPT.md` (in the same place you found this guide) and copy everything below
   the line.
2. Paste it into a text editor and fill in the **About me** section. Short answers are fine. Example:
   *"Roles: product operations and program management. Seniority: senior or team lead. Never: sales,
   engineering, HR."*
3. Paste the whole prompt into Claude and press Enter.

## Step 4: Answer Claude's questions

Claude will work through the setup one step at a time. Expect it to:

- **ask about you**: your roles, the companies you care about, and what isn't a fit. It will show you
  your "profile" in plain language. Read it carefully: this is what decides which jobs you get.
- **ask for permission** before running commands or connecting to GitHub and Vercel. Approve these.
- **ask you to paste keys into Vercel**, never into the chat. When it does:
  1. Open vercel.com → your **job-scan** project → **Settings** → **Environment Variables**.
  2. Type the **name** Claude gives you (for example `TAVILY_API_KEY`) in the Key box.
  3. Paste the key from your note into the Value box.
  4. Tick **Production**, switch on **Sensitive**, and click **Save**.
  5. Tell Claude it's done.

If Claude asks you to do something you don't understand, write *"explain that more simply"*.

## Step 5: The first test

Claude will run a test scan that **doesn't send email** and give you a link to your report.

- Bookmark that link. It's private: anyone with it can see your report, so don't share it.
- Open the **Considered** tab. These are the jobs that fit you. Click **Why?** on any job to see how
  the app decided.
- If the results look wrong (too many, too few, wrong kind of roles), tell Claude what's wrong in plain
  words, for example *"it keeps showing me sales roles"*, and it will adjust your profile.

When you're happy, tell Claude to send the first real email and turn on the daily schedule.

## Using it day to day

- **The email** arrives each morning, usually between 04:00 and 05:00 Israel time. "Strong fit" jobs match you well;
  "Worth a look" are less certain. Each job appears only once.
- **The report** has everything the scan saw:
  - **Considered**: jobs that fit. **Dropped**: jobs that didn't, each with a reason.
  - **Role status**: mark jobs **CV sent** or **Not relevant** to keep track. It's saved automatically.
  - **Why?**: the full explanation for any job.
  - **Usage**: what each service used this month. You'll never be charged more than $5 a month by
    TypeSafe; the other services are on free plans.
- **To change anything** (your roles, companies, the email), open Claude in the same folder and ask,
  for example *"add Wix and Monday.com to my companies"*. Claude will update and redeploy the app.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| No email arrived | Check spam first. Then ask Claude: *"I didn't get today's email, check the last run."* With Resend's free plan, email only reaches the address you signed up to Resend with. |
| Vercel says a deployment failed | Ask Claude: *"The Vercel deployment failed, read the build log and fix it."* The previous version keeps running meanwhile. |
| The report link shows "404" | The link must include your exact report token. Ask Claude for the link again. |
| The email says "Usage limit notice" | A monthly limit was reached. It resets next month. Ask Claude what happened. |
| The jobs don't fit | Tell Claude what's wrong in plain words; it will change your profile and re-run. |

## Keeping it safe

- Keys only go into Vercel, never into chats, emails or documents.
- Your report link is private. If it leaks, ask Claude to change your `REPORT_TOKEN`.
- You can stop everything at any time: in Vercel, open the project → **Settings** → **Cron Jobs** and
  disable the schedule.
