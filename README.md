# DPS Paper Generator — Persistent Backend & Sync Engine

This replaces browser-only `localStorage` with a real self-hosted backend, so
data survives crashes, refreshes, and follows you to any device. This
document explains what changed, how it works, and how to deploy it.

## What you got

```
paper-generator-backend/
  server.js              Express app + WebSocket server (entry point)
  default-state.js        Empty defaults used only to seed a brand-new DB
  db/
    schema.sql            SQLite table definitions
    database.js            Database Layer — all SQL lives here
  routes/
    api.js                 API Layer — REST endpoints
  public/
    index.html              The redesigned app (frontend), served by this
                             same backend at "/" if you deploy this folder as-is
  package.json / .env.example
```

A standalone copy of the frontend is also provided separately
(`DPS_Paper_Generator_v25_synced.html`) in case you want to host the
frontend somewhere else (e.g. GitHub Pages, Netlify) and point it at a
backend running elsewhere — both files are identical, `public/index.html`
is just a convenience copy.

## Architecture

### Database Layer (`db/database.js`, `db/schema.sql`)

Uses Node's **built-in `node:sqlite`** module (no native compilation, no
prebuilt-binary downloads — just `npm install && node server.js`).

Three tables:

- **`app_state`** — one row per logical area of the app (`institution`,
  `paper_patterns`, `question_bank`, `saved_papers`, `custom_classes`,
  `custom_chapters`, `custom_qtypes`, `deleted_builtins`). Each row stores
  a JSON blob, a `version` counter, `updated_at` (epoch ms), and
  `updated_by` (device id).
- **`state_history`** — the last 20 versions of every row, for recovery /
  rollback if something bad ever gets saved.
- **`devices`** — which devices/browsers have connected, for labeling.

**Why whole-slice JSON blobs instead of a fully relational schema** (e.g.
one row per question)? The app's own JavaScript already treats each of
these areas as one cohesive in-memory object (`USER_BANK`, `savedPapers`,
etc.), and hundreds of lines of existing, working business logic read and
write them that way. Relationalizing every question or every saved paper
into its own row would mean rewriting that logic — high risk of breaking
Question Bank, Generate Paper, Preview, and everything else the brief
says must keep working. Storing each area as a versioned, timestamped row
gives real tables, real IDs, and real conflict resolution, without
touching the business logic at all. If you later want row-level
granularity for `question_bank` or `saved_papers` specifically, the
schema comment in `schema.sql` marks exactly where to extend it.

### API Layer (`routes/api.js`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Full snapshot — used on initial load |
| GET | `/api/state/changes?since=<ts>` | Incremental sync (polling fallback) |
| GET | `/api/state/:key` | One area |
| GET | `/api/state/:key/history` | Last 20 versions of one area |
| PUT | `/api/state/:key` | **The autosave endpoint.** Body: `{ value, updatedAt, deviceId }` |
| POST | `/api/state/:key/beacon` | Same as PUT, reachable via `sendBeacon` for tab-close saves |

### Conflict resolution (`db/database.js: writeSlice`)

Timestamp-based, **latest edit wins**, decided by the **server clock**
(not each browser's own clock, which can't be trusted to agree):

- Incoming write's `updatedAt` is compared to the stored row's `updated_at`.
- Newer → accepted, row updated, a history entry is kept, and every other
  connected device is told via WebSocket that this area changed.
- Older or equal → **rejected** with `409` and the server's current
  (winning) value is returned in the same response, so the losing client
  can reconcile its local view instead of corrupting the winning edit.

### Sync Engine (embedded in the frontend, see below)

- **`PGStorage`** — a drop-in replacement for `localStorage.getItem` /
  `setItem` with the exact same call signature. Every one of the app's
  original ~21 localStorage call sites now calls this instead, unchanged
  otherwise.
- **AutoSaveManager** — every `PGStorage.setItem()` call debounces a push
  to the backend by 500ms, so rapid typing doesn't spam the network.
- **SyncManager** — does the actual network push, handles the offline
  queue, and reconciles `409` conflicts.
- **Offline queue** — an IndexedDB store that holds the latest pending
  write per area if the network is down. Flushed automatically the
  moment `navigator.onLine` becomes true again, or every 20s as a backup.
- **WebSocket** — pushes an instant "this area changed" notice to every
  *other* open tab/device the moment one device saves, so multi-device
  editing shows up live instead of waiting for a manual refresh.
- **Sync status badge** — small pill, bottom-right corner of the app:
  `✓ Synced`, `● Saving…`, `○ Offline — N pending`, etc.

## How the pieces fit together (data flow)

1. **Page load** — before the app's own `window.onload` init runs, the
   sync engine fetches `/api/state` once and hydrates its cache (and a
   local `localStorage` mirror) with the server's authoritative data.
   Only then does the original init code run — every `PGStorage.getItem`
   it calls already has synced data available, synchronously, exactly
   like `localStorage.getItem` always did.
2. **Any edit** (typing a question, uploading a PDF, changing settings,
   etc.) — the app's *existing* save functions run exactly as before and
   call `PGStorage.setItem(...)`. That immediately updates the in-memory
   cache and the local `localStorage` mirror (instant, synchronous, so
   the UI never waits on the network), then schedules a debounced push.
3. **500ms later** — the push fires: `PUT /api/state/:key`. If online, it
   reaches the server, gets versioned, and every other connected device
   gets a WebSocket ping.
4. **If offline** — the write goes into the IndexedDB queue instead, and
   the badge shows "Offline — N pending". The app keeps working
   normally throughout (reads fall back to the `localStorage` mirror).
5. **Reconnect** — the queue flushes automatically, oldest first, each
   entry re-checked against the server's current version.
6. **Another device changes something** — this device's WebSocket
   receives a "changed" push, fetches just that one area, updates its
   cache, and re-runs the app's own load+render functions so the screen
   reflects it live.
7. **Tab closes / refreshes** — `visibilitychange`/`beforeunload` fire the
   app's existing `flushAllToStorage()` *and* a `navigator.sendBeacon`
   call, which (unlike a normal network request) is specifically
   designed by browsers to survive the page actually closing.

## Authentication

Accounts are real: **mobile number** + password, hashed with bcrypt,
sessions are JWTs valid 30 days. Every account's data — question bank,
saved papers, institution settings, everything — is scoped by `user_id`
in every table, so one account can never read or write another's data
**except the admin, who has full oversight by design** (see below).

### Signing up / logging in

The app shows a sign-in screen before anything else loads. New accounts
self-register with a mobile number (7–15 digits, `+countrycode` optional)
and an 8-character-minimum password — there's no OTP/SMS verification
step (that needs a paid SMS provider you'd have to configure separately),
so this is "anyone who knows a number can claim it," same trust level as
the original app had none at all. If you need OTP verification later,
that's a scoped addition to `routes/auth.js`.

### The super-admin account — full oversight

One account can be designated admin via environment variables:

```
ADMIN_PHONE=+919876543210
ADMIN_PASSWORD=choose-a-strong-password
```

Set these before boot (or any time later — safe to add, the account is
created if missing or promoted if it already exists). That account gets:

- **Account management** — `GET /api/admin/users` (list everyone),
  `DELETE /api/admin/users/:id` (remove an account and all its data).
- **Full data oversight** — `GET /api/admin/users/:id/state` and
  `PUT /api/admin/users/:id/state/:key` let the admin view **and edit**
  any account's question bank, saved papers, institution settings, or
  any other synced area, through the in-app **Admin panel** (a button
  next to the sync badge, visible only to the admin account). Edits go
  through the same conflict-resolution/versioning path as a normal save,
  and are tagged `admin:<phone>` in version history so it's always clear
  an admin made the change. If that account has the app open elsewhere,
  they see the edit appear live via the same WebSocket push used for
  normal multi-device sync.

This is a genuine, deliberate privacy tradeoff: the admin can see and
change literally everything in every account. Make sure whoever holds
`ADMIN_PASSWORD` is someone you'd trust with that.

### `JWT_SECRET` — read this before deploying

Login tokens are signed with a secret. If you don't set `JWT_SECRET`
yourself:

- Locally, one is generated and saved to `backend/.env.local` so restarts
  on your machine keep working.
- On most hosts (Railway, Render, etc.) the filesystem doesn't persist
  writes across deploys, so a new secret gets generated every deploy and
  **everyone gets logged out**. Not dangerous, just annoying.

Set it yourself once, and it'll never happen:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Put the output in your host's environment variables as `JWT_SECRET`.

### How the frontend carries the session

- The JWT is stored in `localStorage` (`dps_auth_token`) — this is
  session/identity data, not app data, so it deliberately does **not**
  go through the sync engine.
- Every API call attaches `Authorization: Bearer <token>`.
- WebSocket connections and the tab-close `sendBeacon` calls can't set
  custom headers, so they pass the token as `?token=...` instead — the
  backend accepts either form.
- If a request ever comes back `401` (expired/invalid token), the app
  automatically drops back to the login screen rather than silently
  failing saves.

## Setup — running it locally

```bash
cd paper-generator-backend
cp .env.example .env   # fill in ADMIN_PHONE / ADMIN_PASSWORD at least
npm install
npm start
```

Open `http://localhost:8787` — that serves `public/index.html` (the app)
from the same backend, so nothing else to configure; `PG_API_BASE` is
left blank in the file, which means "same origin as whatever served me".
You'll land on a sign-in screen — sign up for your own account, or log
in with the admin credentials you set in `.env`.

Requires **Node.js 22.5 or newer** (for the built-in `node:sqlite`
module). Check with `node -v`.

## Deployment (so other devices can actually reach it)

Any Node.js host works. Railway is the fastest path:

1. Push the `paper-generator-backend` folder to a GitHub repo (or use
   Railway's CLI to deploy a local folder directly).
2. On [railway.app](https://railway.app): **New Project → Deploy from
   GitHub repo** (or `railway up` from the folder).
3. In the service's **Variables** tab, set:
   - `JWT_SECRET` — a random string (see the Authentication section above
     for how to generate one). Without this, every redeploy logs everyone out.
   - `ADMIN_PHONE` / `ADMIN_PASSWORD` — your own admin login.
4. Railway auto-detects Node, runs `npm install` then `npm start`.
5. Once deployed, Railway gives you a public URL like
   `https://paper-generator-production.up.railway.app`.
6. Open that URL directly — the app is served from the same place as the
   API, so it just works on every device. Sign up (or log in as admin).

**Render**, **Fly.io**, or your own VPS work the same way — the only
requirements are Node ≥ 22.5 and a persistent disk for
`data/paper_generator.db` (Railway and Render both provide this; on
Render specifically, add a small persistent disk mounted at `/app/data`
in the service settings so the database isn't wiped on redeploy).

### If you'd rather host the frontend separately

Host `DPS_Paper_Generator_v25_synced.html` anywhere static (GitHub Pages,
Netlify, S3, or just keep it as a local file), and set the API base at
the top of the file:

```html
<script>
  var PG_API_BASE = "https://your-app.up.railway.app";
</script>
```

CORS is already enabled on the backend for all origins, so this works
without further configuration.

## What still works unchanged

Question Bank, Saved Papers, Generate Paper, Preview, Upload PDF, Manual
Extract, Auto Extract, Settings, Institution, Paper Pattern, Random Mode,
and Word/PDF/HTML export are all untouched — only the eight `localStorage`
calls were rerouted through `PGStorage`, and everything downstream of
them behaves exactly as before, just now synced.

## Known limitations (please read)

- **Signup is open to anyone with the URL.** There's no invite/approval
  step or OTP verification of the phone number — anyone who reaches your
  deployed link can claim any mobile number and create an account with
  it. That matches a typical "share the link with your staff" rollout;
  add OTP verification (via a paid SMS provider) if you need stronger
  identity assurance.
- **The admin sees and can edit everything, by design.** Unlike a normal
  account, the super-admin has full read/write access to every other
  account's question banks, saved papers, and settings via the Admin
  panel. There's no audit log beyond the per-slice version history
  (which does tag admin edits distinctly) — if you need a dedicated
  audit trail, that's an additional feature.
- **No password reset flow.** There's no SMS/email sending configured,
  so a forgotten password currently has no self-service recovery — only
  the admin deleting/recreating the account. Worth adding if this goes
  to real users.
- **Conflict resolution is per-area, not per-field.** If two devices edit
  the *same area* (e.g. both edit the question bank) within the same
  ~500ms window, the later save wins **entirely** for that area, not
  merged field-by-field. In practice this is rare (you'd need two people
  editing literally at the same instant), and the 20-entry version
  history means nothing is ever truly gone — you can retrieve an earlier
  version via `GET /api/state/:key/history`.
- **Free hosting tiers can "sleep."** Some free tiers spin down after
  inactivity and take a few seconds to wake on the next request — the
  app will just show "Connecting…" briefly, no data is lost, but it's
  worth knowing so it isn't mistaken for a bug.
