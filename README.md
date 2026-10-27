# SHUAQI 耍起 — V0

## Website and contributions

Live application: [shuaqi.uk](https://shuaqi.uk).

This repository contains the full SHUAQI application. My contribution focuses on
activity recommendation: ranking design, dynamic per-user weighting, bilingual
LLM-assisted matching, query expansion and embeddings, service interfaces, and
recommendation integration and testing. A teammate developed the frontend and backend
of the wider application. Implementation was supported by AI-assisted development.

Recommendation entry point: `server/api/recommendations.post.ts`.
Ranking modules: `server/utils/reco/`. Detailed behaviour:
[dynamic weights](docs/dynamic-weights.md) and [semantic expansion](docs/semantic-expansion.md).
The latest recommendation features require the two `2026102700000*` migrations;
deployment of this source snapshot should be verified separately from the live website.

Mobile-first PWA for UK university students (G5, KCL and UAL pilot): discover events, opt in to meet other attendees, find buddies by intent, check in on site with a static event QR + GPS, and build an explainable participation record.

- **App**: Nuxt 4 (Vue 3, TypeScript, Tailwind v4), `@nuxtjs/supabase`, `@vite-pwa/nuxt` — deployed on **Vercel** (functions in `lhr1`).
- **Backend**: **Supabase** (`eu-west-2`, London) — Postgres with row level security, Auth (school e-mail OTP), Storage.
- All permission-sensitive writes (check-in evidence, connections, plans, admin actions) are Postgres `security definer` functions in `supabase/migrations/`. Clients only hold the anon key.

## Local development

Requires Node 22, pnpm 10 and Docker.

```sh
pnpm install
npx supabase start            # local Postgres/Auth/Storage + Mailpit (http://127.0.0.1:54324)
npx supabase db reset         # apply migrations
cp .env.example .env          # SUPABASE_URL / SUPABASE_KEY from `npx supabase status`
pnpm dev                      # http://localhost:3000
```

Sign up locally with a G5, KCL or UAL address (e.g. `alice@ucl.ac.uk` or `alice@kcl.ac.uk`); the OTP e-mail lands in Mailpit.
`supabase db reset` also loads `supabase/seed.sql`: test accounts (admin, organisers, students) and scenarios are listed in `docs/seed-data.md`. Never run the seed against production.

Make yourself admin: `update profiles set role = 'admin' where id = (select id from auth.users where email = 'alice@ucl.ac.uk');`

## Tests

```sh
pnpm test:unit     # Vitest
pnpm test:db       # pgTAP permission and business-rule tests (supabase/tests)
pnpm db:types      # regenerate app/types/database.types.ts after a migration
```

CI (`.github/workflows/ci.yml`) runs the build, unit tests and pgTAP tests on every PR, and checks generated types are current.

## Environments and deployment

| | Staging | Production |
|---|---|---|
| Supabase project | `shuaqi-staging` (eu-west-2) | `shuaqi-prod` (eu-west-2) |
| Vercel | Preview deployments (every PR) | Production (`main`) |

1. **Supabase** (each project): set Auth → Site URL and redirect URLs (`https://<domain>/confirm`, Vercel preview pattern for staging); enable custom SMTP (Resend, domain with SPF/DKIM); e-mail OTP length 6. Enable PITR/backups on production.
2. **Vercel**: import the repo (framework preset Nuxt). Environment variables:
   - `SUPABASE_URL`, `SUPABASE_KEY` (anon) — Preview → staging values, Production → prod values
   - `NUXT_SUPABASE_SERVICE_KEY` — server only; `/api/recommendations` uses it to cache event embeddings
   - Push notifications: `NUXT_PUBLIC_VAPID_PUBLIC_KEY`, and server only `NUXT_VAPID_PRIVATE_KEY`, `NUXT_VAPID_SUBJECT`, `NUXT_PUSH_DISPATCH_SECRET`; the database side (pg_net, pg_cron, Vault secrets) is in `docs/push-notifications.md`
   - Optional AI for recommendations, server only: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `LLM_COMPAT_BASE_URL` + `LLM_COMPAT_API_KEY` (any OpenAI-compatible API). Which one is used is chosen in 后台 → 推荐算法; see `docs/recommendations.md`.
3. **Migrations**: `.github/workflows/migrate.yml` pushes `supabase/migrations` to staging on every merge to `main`; production only runs when the workflow is started by hand (Actions → Run workflow), after checking staging. Secrets per GitHub environment (`staging`, `production`): `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`. Never change schema in the dashboard.

## Recommendations

`/recommend` (为你推荐) ranks events for the signed-in user, with or without a natural-language search. `POST /api/recommendations` parses the search (rules, plus an optional language model), gets candidates from `recommendation_candidates()` under the user's own session, and scores them in `server/utils/reco/`. Design, weights and data handling: `docs/recommendations.md`. Behind the `recommendations` feature flag.

## Push notifications

New chat messages, friend requests, buddy matches and a reminder about an hour before events you are going to arrive as web push notifications, once the user taps 开启通知 (我的 → 通知设置) and allows them. iPhone needs the home-screen app (iOS 16.4+); WeChat cannot receive them. Database triggers queue notifications, `/api/push/dispatch` sends them. Design and per-environment setup: `docs/push-notifications.md`. Behind the `push` feature flag.

## Rules the code enforces

- G5, KCL and UAL e-mail domains can sign up (`allowed_school_domains`, subdomains allowed); "verified" comes from Auth confirmation, never from the client. Imperial `@ic.ac.uk` inputs are normalized to `@imperial.ac.uk` so the app reuses the same account.
- Profile fields have per-field visibility; other people's profiles are only read through `get_profile_card()`.
- Connections need both sides; blocking removes requests and connections.
- RSVP is not attendance. Static QR + GPS creates `self_reported_presence / geo_verified`; only organiser confirmation creates `verified` attendance. Repeat check-ins never duplicate evidence.
- Organisers only see their own events' attendees; reports are visible to the reporter and admins only; evidence changes are audited.
- "People within 50m" uses fresh GPS positions (≤ 2 minutes old, ≤ 100 m accuracy, kept 5 minutes; no check-in needed) as the V0 stand-in for Bluetooth: inside an event, on the standalone "加好友" page, and as an arrival prompt on a confirmed shared plan.
- One-to-one chat only between connections who have not blocked each other; messages are written by `send_message()` (20/min, 500/day), kept 12 months and deleted with either account. Reporting a message stores an excerpt for admins; admins cannot browse chats. See `docs/privacy-chat.md`.
- Feature flags (`feature_flags`) switch off intents, in-event discovery, nearby, QR check-in, trust card, peer event creation or chat on launch day.
