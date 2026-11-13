# AfterHours Desk

An open-source AI phone receptionist for HVAC and other home-service businesses.

A shop owner fills in one form. A minute later they have a local phone number answered by an AI receptionist that books service visits, handles emergencies safely, and emails them a summary of every call. No one on your side has to touch it.

```
Sign-up form ──► Vapi assistant created ──► local phone number assigned ──► welcome email
                                                     │
          caller ──► AI receptionist ──► check times / book / take message ──► this server
                                                     │
                                       end of call ──► summary emailed to the shop
```

## What it does

- **Automatic setup.** Each sign-up creates its own [Vapi](https://vapi.ai) assistant with that shop's hours, service area and fees, gives it a phone number in the shop's area code, and emails the owner the number plus call-forwarding steps.
- **Real booking.** The receptionist offers open 2-hour windows from the shop's weekly hours, in the shop's own time zone, and a window can't be booked twice.
- **Safety first.** Gas smell, CO alarm, smoke or sparking: callers are told to leave and call 911 or the gas company, and the owner gets an EMERGENCY email.
- **Emergency routing.** If the shop gives an on-call number, emergencies and urgent no-heat or no-cool calls are transferred live to that tech, after the details are saved. The number is never read out to callers.
- **A person if the AI can't answer.** Each shop's number has a fallback: if Vapi can't start the assistant, the call rings the on-call number, then the office, then the owner's mobile.
- **Honest.** The greeting says it's the virtual assistant and that calls are recorded. It never claims to be human, never quotes prices the shop didn't list, and never takes payment details.
- **Call summaries.** After every call the shop gets the bookings, messages and Vapi's summary by email.
- **Owner dashboard.** Each shop gets a private link (in every email, and copyable from the admin page) to a phone-friendly page with callbacks waiting (urgent first), upcoming visits, recent calls with summaries and transcripts, and minutes used. Owners tap Call or Mark done; done items can be moved back.
- **Books into Jobber or Housecall Pro.** From their dashboard, owners connect Jobber (sign in) or Housecall Pro (paste an API key). Every visit the receptionist books is copied in: in Jobber as a client, property and request titled with the caller's chosen window; in Housecall Pro as a customer and a scheduled job. Repeat callers are matched by phone. Tokens and keys are encrypted in the database. If a sync fails, the booking still stands, the owner still gets the email, and the dashboard shows the reason with a Retry button.
- **Seven countries: US, Canada, UK, Australia, UAE, Saudi Arabia, India.** Every country lives in one table, `src/countries.js` (trade wording, emergency numbers, urgent cases, time zones, work week, languages, example calls, how numbers are bought), so adding another is a data entry. Canada: 911 plus the gas utility, English or English-French. UK: boiler language, 0800 111 999 and 999. Australia: air con, 000 plus the gas distributor. UAE: Civil Defence 997 and ambulance 998, English or Gulf Arabic. Saudi Arabia: 911 and Civil Defence 998, Arabic or English, Sunday to Thursday. Sign-up asks for the country. Indian shops get an AC-service script, Hindi-English (Hinglish) speech recognition, a "Namaste" greeting, 112 and the LPG helpline 1906 (or their piped-gas company) in the safety line, IST, and +91 number formats everywhere. US shops keep the original script.
- **Numbers past Vapi's free 10.** With Twilio keys set, a shop that can't get a free Vapi number gets a local Twilio number in its area code, imported into Vapi. If Vapi refuses it, the Twilio number is released so it costs nothing. `NUMBER_SOURCE=twilio` uses Twilio for every shop.
- **Numbers by country.** US: Vapi's free numbers, then Twilio. Canada: Twilio, in the shop's area code. UK and Australia: Twilio once your regulatory bundle is approved (until then, shops wait in "Needs number" and you attach one bought by hand). India, UAE and Saudi Arabia: calls must run through licensed local operators, so shops wait in "Needs number" until you attach a number from that country's provider, connected through a SIP credential you add once in Vapi.
- **Free first month.** Every shop's trial starts when its receptionist goes live (no card needed). The owner gets emails 7 days and 2 days before it ends and on the day it ends, and their dashboard counts down the days. Paying during the month sets the first charge for the day it ends. After 3 days' grace without payment, the receptionist is paused: the shop keeps its number and calls go to its own on-call or office phone. Paying turns it back on within a minute. Shops in a country without online payment are never paused; you get an email to invoice them. From the admin page: Extend 14 days, Mark paid (invoice), Pause, Resume.
- **Billing.** Owners start a subscription from their dashboard: Stripe Checkout for US shops (free trial, optional Stripe Tax for state sales tax), Razorpay for Indian shops (rupees, GST invoices). Signed webhooks keep each shop's status, and you get an email when a payment fails or a subscription ends. Receptionists keep answering; pausing is your call.
- **Busy-line alert.** The admin page shows the most calls going on at once in the last 24 hours, across all shops, against your Vapi lines. You get an email at 80%.
- **Support logins.** `SUPPORT_TOKENS` gives teammates their own admin sign-in; every change is logged with their name.
- **Morning report.** At 7 AM in each shop's time zone, the owner gets one email covering everything since the last report: who to call back, what's booked, how many calls. A quiet night sends nothing.
- **No lost reports.** If the server was asleep or restarting when a call ended, it fetches the missed reports from Vapi every 10 minutes and still emails the shop, once.
- **Minutes and costs.** Every call's length and Vapi cost are stored. The admin page shows each shop's minutes this month against its plan, and you get an email when a shop reaches 80% and 100% of its included minutes. Calls keep being answered past the limit.
- **Protected from abuse.** Honeypot field, per-IP rate limit, a hard cap on clients, and an optional manual-approval mode.
- **Recovers from failures.** If a setup step fails, half-made resources are cleaned up, you get an alert, and one admin call retries it.

## Run it locally

Needs Node.js 22.13 or newer. No database server: data lives in a SQLite file.

```bash
git clone https://github.com/<you>/afterhours-desk.git
cd afterhours-desk
npm install
cp .env.example .env      # then fill in the required values
npm test                  # 88 tests, uses a fake Vapi, no account needed
npm start
```

Vapi has to reach your server over https, so for local testing run a tunnel such as `ngrok http 3000` and put that https address in `PUBLIC_URL`.

## Go live

You need two free accounts first:

- **Vapi** (dashboard.vapi.ai): copy your private API key. New accounts get free credit and a free number.
- **Resend** (resend.com): free for 3,000 emails a month. Verify your domain, or use their test sender while trying it out, and copy your API key.

The server generates its own secrets and detects its public address on Render and Railway, so those keys (plus a database address on hosts without a disk) are all you paste in.

### Option A: Free, no card (Neon + Render Free + a keep-awake ping)

1. **Database:** sign up at neon.com (no card), create a project in a US region, and copy the connection string (`postgresql://...`).
2. **App:** sign up at render.com, click **New → Web Service**, and pick this repo. Don't use the Deploy button below; it uses a paid plan.
   - Language **Node**, build command `npm ci`, start command `npm start`, instance type **Free**.
   - Environment variables: `DATABASE_URL` (the Neon string), `NODE_VERSION` = `22`, `VAPI_API_KEY`, `RESEND_API_KEY`, `MAIL_FROM`, `OPERATOR_EMAIL`.
   - Deploy. Render's public address is detected automatically.
3. **Keep it awake:** at cron-job.org (free), create a job that opens `https://<your-app>.onrender.com/healthz` every 5 minutes. Render's free plan sleeps after 15 idle minutes, and a sleeping app makes the first call after a quiet spell fail.
4. Open Render's **Logs** and save the admin token printed on first start.

Client data lives in Neon, so Render's free plan wiping its disk doesn't lose anything. Free plans have no uptime guarantee; move to a paid instance once clients are paying.

### Option B: Render paid (about $7/month, always on)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bose-bot/afterhours-desk)

Click the button, paste the same keys on the setup screen, and deploy. It creates the server and a database disk, so no Neon or keep-awake ping is needed.

### Option C: Railway or Northflank (both need a card or open sign-ups)

- **Railway:** **New Project → Deploy from GitHub repo**, pick this repo (it builds from `Dockerfile` and `railway.toml`), add the variables, **Generate Domain**, and add a **Volume** at `/app/data` (or set `DATABASE_URL`).
- **Northflank:** create a **Combined service** from this repo with the **Dockerfile** build type and public HTTP on port 3000, add the variables plus `DATABASE_URL`, then set `PUBLIC_URL` to the service's public address.

### Then, on either host

1. **Edit the website** in `public/index.html`: replace every `[BRACKETED]` placeholder (prices, your name, city, email, demo number) and review `public/privacy.html`. Push, and the host redeploys.
2. **Test it end to end:** sign up as a fake shop with your own email and mobile, approve it (below), call the number you receive, book a visit, then try "I smell gas".
3. **Turn on full automation** by setting `PROVISION_MODE=auto`. New deploys start in `approval` mode with a 10-client cap, so a stranger can't run up your Vapi bill before you're ready.

## Settings that matter

| Variable | What it does |
| --- | --- |
| `PROVISION_MODE` | `approval` (default) holds sign-ups until you approve them. `auto` goes live instantly. |
| `MAX_CLIENTS` | Stops new sign-ups once this many clients exist. Start low. |
| `VAPI_MODEL`, `VAPI_VOICE_*` | Pick the model and voice. Empty voice uses Vapi's default. |
| `OPERATOR_EMAIL` | Where new-client, failure and minute alerts go. |
| `INCLUDED_MINUTES` | Call minutes in a plan each month (default 300, as on the website). Alerts at 80% and 100%. `0` turns them off. |
| `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET` | From your app at developer.getjobber.com. Without them the Connect Jobber button is hidden. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Buy US numbers on Twilio when Vapi's free numbers run out. `NUMBER_SOURCE=twilio` to always use Twilio. |
| `VAPI_SIP_CREDENTIAL_<CC>` | A licensed local provider's SIP trunk, added once in Vapi as a credential: `_IN`, `_AE`, `_SA`. `VAPI_IN_SIP_CREDENTIAL_ID` still works for India. |
| `TWILIO_BUNDLE_SID_<CC>`, `TWILIO_ADDRESS_SID_<CC>` | Your approved Twilio regulatory bundle and address, for `_GB` and `_AU` (Canada needs none). |
| `STRIPE_PRICE_ID_<CC>` | A Stripe price in local currency (`_CA`, `_GB`, `_AU`, `_AE`, `_SA`). Falls back to `STRIPE_PRICE_ID`. |
| `VAPI_VOICE_<LANG>_PROVIDER`, `VAPI_VOICE_<LANG>_ID` | Optional voice per caller language: `AR`, `EN_FR`, `HI_EN`. |
| `VAPI_IN_VOICE_PROVIDER`, `VAPI_IN_VOICE_ID` | Optional Indian voice. `VAPI_IN_TRANSCRIBER_*` overrides the default Deepgram nova-3 multilingual transcriber. |
| `TRIAL_DAYS`, `TRIAL_GRACE_DAYS`, `TRIAL_END_ACTION` | Free month length (default 30, 0 turns it off), grace days before pausing (default 3), and `pause` (default) or `notify` to only email you. |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | US subscriptions. Webhook URL: `/api/billing/stripe/webhook`. `STRIPE_TRIAL_DAYS` (default 14), `STRIPE_AUTOMATIC_TAX=true` once Stripe Tax is set up. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_PLAN_ID`, `RAZORPAY_WEBHOOK_SECRET` | Indian subscriptions. Webhook URL: `/api/billing/razorpay/webhook`. |
| `VAPI_CONCURRENCY` | How many calls your Vapi account takes at once (default 10), for the busy-line alert. |
| `SUPPORT_TOKENS` | `Name:token,Name2:token2` for teammates on the admin page. Tokens need 24+ characters. |
| `MORNING_REPORT_HOUR` | Local hour for the overnight email (default 7). `off` turns it off. |
| `RECOVER_EVERY_MINUTES` | How often to fetch call reports that never reached the server (default 10). `0` turns it off. |

Every Vapi phone minute and every number costs money on your Vapi account. Set `MAX_CLIENTS`, and keep `approval` mode on until you're charging clients.

## Admin API

All admin calls need `Authorization: Bearer $ADMIN_TOKEN`. If you didn't set `ADMIN_TOKEN`, the server made one on first start: it's in the first startup log, or run `npm run admin-token` on the server.

| Call | What it does |
| --- | --- |
| `GET /api/admin/clients` | List every client and their status. |
| `GET /api/admin/clients/:id` | One client with their bookings, messages and calls. |
| `POST /api/admin/clients/:id/approve` | Start setup for a client waiting for approval. |
| `POST /api/admin/clients/:id/retry` | Retry a failed setup. |
| `POST /api/admin/clients/:id/refresh-number` | Fetch a number that wasn't assigned yet at setup. |
| `POST /api/admin/clients/:id/update-script` | Send the latest script, greeting, tools and phone fallback to a live shop. |
| `POST /api/admin/clients/:id/send-report` | Email that shop its report for the last 24 hours, right now. |
| `POST /api/admin/clients/:id/attach-number` | Connect a number by hand (local SIP provider, or a number in your Twilio account) and go live. |
| `GET /api/admin/overview` | Busiest moment in the last 24 hours against your Vapi lines. |
| `POST /api/admin/recover-calls` | Fetch any call reports from Vapi that never arrived, right now. |

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your-app.example.com/api/admin/clients
```

## How it's built

| File | Job |
| --- | --- |
| `src/server.js` | Routes: sign-up, status, Vapi webhook, admin, website. |
| `src/provision.js` | Sign-up to live number, with rollback and retry. |
| `src/prompt.js` | The receptionist's instructions and its three tools. |
| `src/webhook.js` | Answers Vapi's tool calls and stores end-of-call reports. |
| `src/scheduling.js` | Open appointment windows, time-zone and daylight-saving aware. |
| `src/validate.js` | Cleans and checks sign-up data. |
| `src/db.js` | Storage: Postgres when `DATABASE_URL` is set, otherwise a SQLite file. |
| `public/` | The marketing site and sign-up form. |

Webhook security: each assistant's server URL carries a per-deployment secret token, and the server also accepts a Bearer token or `x-vapi-secret` header if you'd rather attach a Vapi credential.

## Before you take real customers

- **Move off free hosting.** A free server goes to sleep when idle. The keep-awake ping and the report recovery soften that, but a paid plan (about $7 a month on Render) keeps tool calls fast during live calls.
- **Watch the health check.** `/healthz` fails when the database can't be reached. Point a free uptime monitor (UptimeRobot, Better Stack, or cron-job.org's failure alerts) at it so you hear about an outage before a shop does.
- **Test the transfer once on your real number.** Call the shop's AI number, say you smell gas, and check the on-call phone rings. Free Vapi numbers can't place outbound calls; if the transfer doesn't go through, import a Twilio number for that shop.
- **Set up Jobber once, for all your shops.** Create a free developer account at developer.getjobber.com, create an app, set its callback URL to `https://<your server>/api/integrations/jobber/callback`, and give it read and write access to clients, properties and requests, plus read access to the account. Put its client ID and secret in `JOBBER_CLIENT_ID` and `JOBBER_CLIENT_SECRET`. Then connect a test Jobber account from a dashboard and book a call before telling shops about it.
- **Check the Housecall Pro sync with a real account.** It follows Housecall Pro's public API (customers, addresses, jobs with a schedule, job notes), which needs their MAX plan. The tests use a fake of that API, so book one real test visit first and confirm the job lands where you expect.
- **Each new country before its first shop.** UK and Australia: get the Twilio regulatory bundle approved (UK 1–3 days, Australia 3–5). UAE and Saudi Arabia: sign a licensed SIP provider, confirm the route with Vapi, call one number end to end, and check Arabic calls with a native speaker. Everywhere: a local review of the recording notice and data handling (PIPEDA, UK GDPR, Australian Privacy Act, UAE PDPL, Saudi PDPL), and prices in local currency.
- **India before the first shop.** Confirm with Vapi that your Indian provider's SIP route is allowed, add it as a credential, and call one attached number end to end. Have an Indian lawyer review the greeting notice and data handling against the DPDP Rules (main duties from May 13, 2027).
- **Billing before charging.** Create the Stripe price and the Razorpay plan, point both webhooks at this server, and run one test payment in each.
- **Call recording and AI disclosure laws** differ by state. The greeting tells callers the call is recorded, which covers states that need every party's consent. Check the rules where your clients and their callers are.
- **Bookings are requests.** They're stored here and emailed to the shop; they don't write into ServiceTitan, Housecall Pro or Google Calendar yet. That's the most useful next contribution.
- **Free Vapi numbers are inbound-only.**
- The privacy page is a template, not legal advice.

## Roadmap ideas

- Calendar sync (Google Calendar, then field-service tools)
- SMS summaries
- Stripe billing with automatic pause on failed payment, using the minute counts already stored
- Read the shop's Jobber or Housecall Pro calendar before offering windows, so the receptionist never offers a time the team already filled
- Admin dashboard page
- Other trades: plumbing, electrical, roofing

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening a PR, and add a test for any behavior change. Please report security problems privately via GitHub's security advisories instead of public issues.

## License

MIT. See [LICENSE](LICENSE).
