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
- **Honest.** The assistant says it's an AI when asked, never quotes prices the shop didn't list, and never takes payment details.
- **Call summaries.** After every call the shop gets the bookings, messages and Vapi's summary by email.
- **Protected from abuse.** Honeypot field, per-IP rate limit, a hard cap on clients, and an optional manual-approval mode.
- **Recovers from failures.** If a setup step fails, half-made resources are cleaned up, you get an alert, and one admin call retries it.

## Run it locally

Needs Node.js 22.13 or newer. No database server: data lives in a SQLite file.

```bash
git clone https://github.com/<you>/afterhours-desk.git
cd afterhours-desk
npm install
cp .env.example .env      # then fill in the required values
npm test                  # 21 tests, uses a fake Vapi, no account needed
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
| `OPERATOR_EMAIL` | Where new-client and failure alerts go. |

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

- **Call recording and AI disclosure laws** differ by state. Some states require every party's consent to record. Check the rules where your clients and their callers are.
- **Bookings are requests.** They're stored here and emailed to the shop; they don't write into ServiceTitan, Housecall Pro or Google Calendar yet. That's the most useful next contribution.
- **Free Vapi numbers are inbound-only.**
- The privacy page is a template, not legal advice.

## Roadmap ideas

- Calendar sync (Google Calendar, then field-service tools)
- SMS summaries
- Stripe billing with automatic pause on failed payment
- Admin dashboard page
- Other trades: plumbing, electrical, roofing

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening a PR, and add a test for any behavior change. Please report security problems privately via GitHub's security advisories instead of public issues.

## License

MIT. See [LICENSE](LICENSE).
