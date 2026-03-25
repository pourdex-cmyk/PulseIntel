# Pulse Intelligence

Unified AI Communication Platform — Email, Chat, and Meetings in one inbox.

Built with: **Vercel** (hosting + serverless functions) · **Supabase** (database + auth + realtime) · **Anthropic Claude** (AI analysis, drafts, reports)

---

## Stack

```
Frontend     → public/index.html + public/api.js (vanilla JS, no framework)
API Layer    → api/**/*.js (Vercel Edge/Node.js serverless functions)
Database     → Supabase (PostgreSQL + Auth + Realtime)
AI           → Anthropic Claude API (called server-side, keys encrypted at rest)
Webhooks     → api/webhooks/*.js (receives push from Slack, Teams, Outlook, Gmail)
```

---

## Project Structure

```
pulse-intelligence/
├── api/
│   ├── auth/
│   │   ├── login.js          POST  /api/auth/login
│   │   ├── logout.js         POST  /api/auth/logout
│   │   ├── signup.js         POST  /api/auth/signup
│   │   └── refresh.js        POST  /api/auth/refresh
│   ├── settings/
│   │   ├── profile.js        GET|PUT  /api/settings/profile
│   │   └── connectors.js     GET|PUT|DELETE  /api/settings/connectors
│   ├── messages/
│   │   ├── index.js          GET  /api/messages?tab=email&category=action
│   │   └── [id].js           GET|PATCH|DELETE  /api/messages/:id
│   ├── meetings/
│   │   ├── index.js          GET|POST  /api/meetings?filter=today
│   │   └── [id].js           GET|PUT|DELETE  /api/meetings/:id
│   ├── ai/
│   │   ├── analyze.js        POST  /api/ai/analyze
│   │   ├── draft.js          POST  /api/ai/draft
│   │   ├── report.js         POST  /api/ai/report
│   │   └── meeting-prep.js   POST  /api/ai/meeting-prep
│   └── webhooks/
│       ├── slack.js          POST  /api/webhooks/slack?uid=xxx
│       ├── teams.js          POST  /api/webhooks/teams?uid=xxx
│       ├── outlook.js        POST  /api/webhooks/outlook?uid=xxx
│       └── gmail.js          POST  /api/webhooks/gmail?uid=xxx
├── lib/
│   ├── supabase.js           Supabase client (server-side)
│   └── middleware.js         Auth middleware + response helpers
├── supabase/
│   └── schema.sql            Complete database schema
├── public/
│   ├── index.html            Main app (your pulse-intelligence.html)
│   ├── login.html            Login / signup page
│   └── api.js                Frontend API client (replaces localStorage)
├── .env.example              All required environment variables
├── vercel.json               Vercel routing + function config
└── package.json
```

---

## Setup — Step by Step

### 1. Clone and open in VS Code

```bash
git clone https://github.com/YOUR_USERNAME/pulse-intelligence.git
cd pulse-intelligence
code .
npm install
```

### 2. Create Supabase project

1. Go to [supabase.com](https://supabase.com) → New project
2. Copy your **Project URL** and **anon key** from Settings → API
3. Copy your **service_role key** (keep this secret — server-side only)
4. Go to SQL Editor → New query → paste entire `supabase/schema.sql` → Run

### 3. Set environment variables

```bash
cp .env.example .env
```

Edit `.env` with your actual values. Then add them to Vercel:

```bash
vercel env add SUPABASE_URL
vercel env add SUPABASE_ANON_KEY
vercel env add SUPABASE_SERVICE_KEY
vercel env add ANTHROPIC_API_KEY
vercel env add JWT_SECRET          # openssl rand -hex 32
vercel env add APP_URL             # https://your-app.vercel.app
```

### 4. Deploy to Vercel

```bash
npx vercel login
npx vercel --prod
```

Your app is live. Vercel auto-deploys on every `git push` to `main`.

### 5. Copy your app HTML

Copy `pulse-intelligence.html` (from this conversation) to `public/index.html`.

Add these two lines just before the closing `</body>` tag in index.html:

```html
<script src="/api.js"></script>
<script>
  // Redirect to login if not authenticated
  if (!API.auth.isLoggedIn) window.location.href = '/login.html';
</script>
```

Then replace all calls to `localStorage.getItem/setItem` with `API.*` calls — the `public/api.js` client mirrors every localStorage operation with an API call. You can do this incrementally: the app works with localStorage while you migrate.

---

## Platform Webhook Setup

Each user gets unique webhook URLs shown in their Settings page. Register these in each platform:

### Slack
1. [api.slack.com/apps](https://api.slack.com/apps) → Create App → Event Subscriptions
2. Request URL: `https://your-app.vercel.app/api/webhooks/slack?uid={user_slack_uid}`
3. Subscribe to: `message.channels`, `message.im`, `message.groups`
4. OAuth Scopes: `channels:history`, `groups:history`, `im:history`, `channels:read`
5. Copy Bot Token (`xoxb-...`) → paste in app Settings → Slack

### Microsoft Teams + Outlook (one Azure app registration)
1. [portal.azure.com](https://portal.azure.com) → Azure Active Directory → App registrations → New
2. API Permissions: `Mail.Read`, `ChannelMessage.Read.All`, `Chat.Read`
3. Create Microsoft Graph subscription pointing to your webhook URL
4. Copy Client ID + Secret → paste in app Settings

### Gmail
1. [console.cloud.google.com](https://console.cloud.google.com) → Enable Gmail API + Cloud Pub/Sub
2. Create Pub/Sub topic: `gmail-notifications`
3. Grant `gmail-api-push@system.gserviceaccount.com` the `Pub/Sub Publisher` role
4. Create push subscription pointing to `/api/webhooks/gmail?uid={user_gmail_uid}`
5. Call `users.watch()` with the topic — your webhook auto-registers this on connect
6. Copy OAuth2 token → paste in app Settings

---

## API Reference

All endpoints require `Authorization: Bearer {access_token}` except auth endpoints.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | `{ email, password }` → `{ access_token, refresh_token, profile }` |
| POST | `/api/auth/signup` | `{ email, password, firstName, lastName }` → `{ user }` |
| POST | `/api/auth/logout` | Invalidates session |
| POST | `/api/auth/refresh` | `{ refresh_token }` → new tokens |
| GET | `/api/settings/profile` | Returns user profile |
| PUT | `/api/settings/profile` | Update profile fields |
| GET | `/api/settings/connectors` | Returns connected sources + webhook URLs |
| PUT | `/api/settings/connectors` | Save tokens (encrypted at rest) |
| DELETE | `/api/settings/connectors` | `{ source }` → disconnect |
| GET | `/api/messages` | `?tab=email&category=action&priority=60&unread=true` |
| GET | `/api/messages/:id` | Single message (auto-marks read) |
| PATCH | `/api/messages/:id` | Update category/priority/unread |
| DELETE | `/api/messages/:id` | Delete message |
| GET | `/api/meetings` | `?filter=today\|upcoming\|past\|all` |
| POST | `/api/meetings` | Create meeting |
| GET | `/api/meetings/:id` | Single meeting |
| PUT | `/api/meetings/:id` | Full update |
| DELETE | `/api/meetings/:id` | Delete |
| POST | `/api/ai/analyze` | `{ message_id, type }` → `{ analysis }` |
| POST | `/api/ai/draft` | `{ message_id }` → `{ draft }` |
| POST | `/api/ai/report` | → `{ report, stats }` |
| POST | `/api/ai/meeting-prep` | `{ meeting_id }` → `{ prep }` |

---

## Cost at Scale

| Users | Vercel | Supabase | Total/mo |
|-------|--------|----------|----------|
| 1–10  | $20 (Pro) | $25 (Pro) | **$45** |
| 10–50 | $20 | $25 | **$45** |
| 50–200 | $20 | $25–75 | **$45–95** |
| 200–500 | $20 | $75–150 | **$95–170** |

Claude API costs are passed through to clients via their own API keys stored in their account settings. ACG infrastructure cost stays flat.

---

## Local Development

```bash
npm install
cp .env.example .env   # fill in your values
npx vercel dev         # runs on http://localhost:3000
```

Vercel Dev emulates the serverless function environment locally including env vars.
