# Exchange Rate Automation – Proof of Concept

A standalone POC that tests whether exchange rates for our ERP (Zybo) can be
**retrieved automatically, validated, and prepared for ERP import**, instead of being typed in by hand.

> **This is a technical feasibility POC, not a production financial system.**
> It shows **reference (mid-market) rates**. These are not bank buy/sell or transaction rates, not an official CBUAE fixing, and not real-time.
> **Nothing is written to Zybo or any database.**

---

## 1. Quick start (Windows, VS Code)

### Prerequisites
- **Node.js 22 or later (LTS recommended, tested with v24.22.2).** Node.js was not installed on the build machine.
  Install it from <https://nodejs.org> (LTS installer) or with `winget install OpenJS.NodeJS.LTS`, then open a new terminal and check it with `node -v`.
- Internet access from the machine running the backend. Only the backend calls the rate providers.

### Install & run
```powershell
cd d:\exchangeratereguliser
npm install                                  # installs backend + frontend (npm workspaces)
copy backend\.env.example backend\.env       # optional – defaults work without it
npm run dev                                  # starts API (:4000) and dashboard (:5173)
```
Open **http://localhost:5173**. The app has two pages (React Router), both directly addressable:

- **API Dashboard** – `http://localhost:5173/dashboard`: provider selector (ExchangeRate-API, currencyapi.com, OANDA, Compare All Providers), status, overview, converter, history.
- **ERP Integration** – `http://localhost:5173/erp-integration`: Zybo-style Branches Exchange Rate screen (countries,
  effective rates, edit / override / resume, history, audit log, SQL preview).

Shared state and data live above the routes (`App.tsx`), so switching pages keeps the selected provider and country and
does not refetch.

| Command | What it does |
|---|---|
| `npm run dev` | Backend (`tsx watch`) and frontend (Vite) together |
| `npm test` | Backend unit and API tests (offline, with fake providers) |
| `npm run smoke` | **Live** check against the real providers |
| `npm run typecheck` | TypeScript check for both projects |
| `npm run build` | Production build (`backend/dist`, `frontend/dist`) |

To run the two parts separately: `npm run dev -w backend` and `npm run dev -w frontend`.

---

## 2. Architecture

```
┌──────────── Browser ────────────┐        ┌─────────────── backend/ (Express + TS) ────────────────┐
│ frontend/ React + TS + Vite     │  /api  │ routes ─► controllers ─► services ─► providers ─► HTTPS │
│  • Rate overview / search       │ ─────► │   exchangeRateController   RateService   open-er-api   │
│  • Converter, history           │ (Vite  │   erpController            (cache,       currency-api  │
│  • Status / stale warnings      │  proxy)│                             fallback,     (pluggable)   │
│  • ERP Integration Preview      │        │                             staleness)                  │
│  Tailwind CSS                   │        │                            ErpStagingService (in-memory)│
└─────────────────────────────────┘        └─────────────────────────────────────────────────────────┘
```

```
backend/src
  config.ts                 env-driven settings (validated at start-up)
  app.ts / server.ts        Express app factory (injectable for tests) / entry point
  providers/                one adapter per vendor behind the ExchangeRateProvider interface
  services/rateMath.ts      rate direction, inversion, cross rates (decimal.js)
  services/rateService.ts   cache, rate-limit guard, fallback, status, history
  services/staleness.ts     fresh / delayed (weekend, holiday) / stale
  services/effectiveRateService.ts  effective ERP rates, validation, overrides, history, audit, SQL preview
  services/editorAuth.ts         single rate-editor sign-in (backend-enforced)
  services/dailyRateJob.ts       automatic update schedule
  controllers/, lib/        HTTP handlers, validation, errors, fetch with timeout
backend/tests               vitest + supertest (36 tests)
backend/scripts/smoke-test.ts   live provider check
frontend/src
  components/               StatusPanel, RatesToolbar, RatesTable, ConverterCard, HistoryPanel, ErpPreview, ui
  hooks/                    useExchangeRates, useErpPreview
  services/api.ts           typed API client
  types/api.ts              shared response interfaces
```

**Provider independence.** The frontend only knows the backend's normalised JSON. To switch to another provider
(for example Open Exchange Rates, or a bank feed), add a class that implements `ExchangeRateProvider` in
`backend/src/providers/`, register it in `providers/index.ts`, and set `PRIMARY_PROVIDER`. API keys stay in
`backend/.env` and never reach the browser.

---

## 3. API provider selection

All candidates were tested with live requests on 11 Nov 2026. No endpoint was assumed to exist.

| Provider | Result | Decision |
|---|---|---|
| **ExchangeRate-API Open Access**: `open.er-api.com/v6/latest/AED` | Works, no key needed, about 160 ISO currencies **including AED, SAR, INR, CNY**, daily update with publish and next-update timestamps | **Primary** |
| **fawazahmed0 currency-api** (jsDelivr CDN) | Works, no key, includes AED, **dated daily snapshots** | **Fallback + history** (community-maintained, so not authoritative) |
| Frankfurter (ECB) | Works and is reliable, but **has no AED or SAR** (ECB doesn't publish them) | Not used. Can't serve AED as target |
| Central Bank of the UAE | Website returns **403** to programmatic requests. **No documented public API** found | Not used. Not scraped |
| Open Exchange Rates / commercial | Needs an account or API key | Recommended for production (see §8) |

**ExchangeRate-API terms:** attribution is required (shown on the dashboard), and requests should be kept low.
The backend caches for 10 minutes and won't call the provider more than once every 60 seconds, even when users
press *Fetch Latest Rates*.

**Providers differ.** On the test day EUR→AED was 4.1083 (primary) and 4.1234 (fallback), about 0.4% apart.
The dashboard always shows which source each rate came from and flags it when the fallback was used.

### Switching and comparing providers (ExchangeRate-API, currencyapi.com, OANDA)

A selector at the top of the dashboard offers **ExchangeRate-API (Existing)**, **currencyapi.com (New)**, **OANDA (New)** and
**Compare All Providers**. The selection drives the overview, converter and status. Every rate endpoint takes
`?provider=exchangerate-api|currencyapi-com|oanda` (default: the existing integration, which is unchanged and keeps its backup
source). Providers can be switched without restarting. OANDA is an independent provider, never a fallback.

- **currencyapi.com setup:** set `CURRENCYAPI_COM_API_KEY` in `backend/.env` and restart. The key stays on the server and is
  sent only as the `apikey` request header. Without a key the provider shows *Key needed* and returns a clear 503; the rest of
  the dashboard keeps working.
- **Quota protection (currencyapi.com free plan: 300 requests/month):** one AED snapshot is fetched and every other target or
  country is cross-calculated from it. It is cached for 4 hours, *Fetch Latest* is limited to once per 15 minutes, and the 30-day
  history chart is turned off for this provider (each day would cost a request).
- **Compare All Providers:** every provider goes through the same path (cross-calculated from its AED snapshot with the same
  decimal places), so direction and precision are identical. Columns: code, currency, the three rates, and the difference of
  currencyapi.com and OANDA against ExchangeRate-API: `((provider − ExchangeRate-API) / ExchangeRate-API) × 100`, shown with
  *higher*/*lower*. Normal within ±0.5%, amber up to ±2%, red above (`COMPARE_ALIGNED_PERCENT`, `COMPARE_REVIEW_PERCENT`).
  Each provider's rate type, effective date, publication time and retrieval time are shown above the table. A warning appears
  when effective dates differ or rate types are not comparable (a bid or ask is never comparable with a midpoint). If one
  provider fails, its column shows the error and the others still load. **The comparison is read-only and never changes
  effective ERP rates.**
- **ERP page:** the *Effective rates from* selector offers all three providers. Effective rates are keyed by provider, so rates,
  overrides, history, the deviation check and the SQL preview are separate per provider, country and currency. Each row shows a
  provider badge and its rate type. Viewing or comparing never overwrites effective rates or overrides.
- **Adding another provider:** implement `ExchangeRateProvider` in `backend/src/providers/`, register it in `providers/index.ts`,
  and add a source in `services/rateSources.ts`.

### OANDA Exchange Rates API

OANDA's *Exchange Rates API* (business and financial data, **not** the OANDA forex-trading API) provides daily average rates.
The adapter (`backend/src/providers/oandaProvider.ts`) follows the contract in OANDA's own published client library
(`github.com/oanda/nodejs-exchange-rates`): `GET https://www.oanda.com/rates/api/v1/rates/{BASE}.json?quote=..&fields=..`
with `Authorization: Bearer <key>`, and errors as `{ code, message }`.

> **Not verified against a live key.** I could not open OANDA's documentation site or call the API with a real account (no key
> was available, and see the certificate note below). The adapter was tested against a local stand-in that follows the documented
> contract, so treat the first run with a real key as the real test. If OANDA gave you a different base URL (for example a v2
> host), set it in `OANDA_BASE_URL`.

**Rate types.** OANDA returns a *daily average*. The dashboard can show three: **midpoint** (default, comparable with the other
providers' mid-market rates), **bid** and **ask** (one side of the spread; not comparable with a midpoint). The choice in the
dashboard only changes what you view. The ERP and the daily update always use the server setting `OANDA_RATE_TYPE`. Bid and ask
need a subscription that includes them. The rate is never described as real-time.

**Quota protection.** OANDA bills per quote. The adapter asks only for the currencies you use (`OANDA_QUOTE_CURRENCIES`, default
= `ERP_CURRENCIES` + `DEFAULT_CURRENCIES` + AED), fetches **one AED snapshot** that serves every country and target, caches it for
4 hours (`OANDA_CACHE_TTL_SECONDS`), limits *Fetch Latest* to once per 15 minutes, and keeps past days in memory for the life of
the process. The 7-day history chart (`OANDA_HISTORY_MAX_DAYS`, 0 = off) costs one request per day the first time it is opened. The ERP deviation
check costs one extra request per day for the previous-day baseline.

**Errors shown to users** (always with OANDA's own message): key not configured, rejected key (401), expired trial or subscription,
plan limit (403), request limit (429), unsupported currency, a rate type your subscription does not include, and certificate problems.

#### Getting an OANDA API key

OANDA does not offer an instant self-service key. A trial or paid subscription is required, and OANDA issues the key.

1. Go to OANDA's *Exchange Rates API* page (search "OANDA Exchange Rates API", under *FX for Business / Foreign Exchange Data
   Services*) and choose the **free trial**, or contact OANDA's data team (the page lists `fxdata@oanda.com`). Plans start from
   about USD 4,850 a year. Check current terms with OANDA.
2. Ask for the **Exchange Rates API (daily average rates)** and say you want to evaluate it for ERP use. Ask which rate types
   (midpoint, bid, ask), how many currencies, how much history, and what quota the trial includes.
3. OANDA gives you an API key (an access token). Keep it private.
4. Open `backend/.env` and add one line, with no quotes and no spaces:
   ```
   OANDA_API_KEY=paste-the-key-here
   ```
   Never put it in `frontend/.env` or any `VITE_` variable, and never commit `.env`.
5. Restart `npm run dev`. The OANDA button loses its *Key needed* badge. To include OANDA in the 08:00 automatic update, set
   `DAILY_FETCH_PROVIDERS=exchangerate-api,currencyapi-com,oanda` (providers without a key are skipped automatically).

#### If you see "the secure connection to www.oanda.com could not be verified"

Node refuses the certificate it receives, so the request is stopped **before anything is sent** (certificate checking stays on).
On the network this POC was built on, `www.oanda.com` is answered with a certificate issued by a **Sophos** firewall, which means
the firewall is either inspecting the connection or blocking the site (OANDA is a forex broker, a category many web filters block).
Your browser may trust that firewall's certificate, but Node does not. Options, best first:

1. Ask IT to **allow `www.oanda.com` without SSL inspection** (and to confirm the site is not category-blocked).
2. If IT says inspection must stay, export the firewall's **CA certificate** to a `.pem` file (IT can supply it) and set
   `OANDA_CA_CERT_FILE=C:\path\to\firewall-ca.pem` in `backend/.env`. The CA is trusted **for OANDA only**, in addition to the
   normal list. Do **not** disable certificate checking (`NODE_TLS_REJECT_UNAUTHORIZED=0`).
3. Run the backend from a network that does not inspect this site.

---

## 4. Rate direction & precision

- **Convention:** `1 unit of foreign currency = Rate AED` (for example `1 USD = 3.67250105 AED`).
- The provider publishes `1 AED = 0.272294 USD`. The backend inverts this with **decimal.js** at 34 significant
  digits and rounds HALF-UP to `RATE_DECIMAL_PLACES` (default 8, suggested column `DECIMAL(19,8)`).
- **Cross rates** (for example USD→INR) are calculated from the raw provider quotes: `quote[INR] / quote[USD]`. They are not chained through rounded rates.
- Converted amounts are rounded to the target currency's minor units (AED/USD 2, JPY 0, KWD 3).
- JavaScript floating-point numbers are never used for rate maths. The frontend only displays decimal strings from the server.
- **Real precision depends on the source data.** The primary provider sends 6 decimal places, so the inverted
  USD rate is 3.67250105, not exactly the 3.6725 peg. The live smoke test checks that USD/AED is within 0.001 of the peg.

---

## 5. Freshness, weekends & holidays

Every response includes a `staleness` block:

| Status | Meaning |
|---|---|
| `fresh` | Rate date is today or yesterday |
| `delayed` | Gap since the rate date covers only weekend/holiday days (`WEEKEND_DAYS`, `HOLIDAYS`). The dashboard explains the gap is expected |
| `stale` | One or more **business days** are missing, or the age exceeds `STALE_AFTER_HOURS`. Red warning shown, and the automatic update keeps the current rates instead of applying stale ones |

The holiday list is a manual setting in `.env`. There is no holiday-calendar integration yet. The primary
provider publishes every day, including weekends, so `delayed` mostly applies to ECB/central-bank style sources.

---

## 6. Backend API

| Method & path | Purpose |
|---|---|
| `GET /api/exchange-rates?target=AED&currencies=USD,EUR&refresh=true` | Rates (default list when `currencies` is omitted; `currencies=all` for every currency). `refresh=true` forces a provider call, subject to the 60 s guard |
| `GET /api/exchange-rates/:currency` | One currency |
| `GET /api/exchange-rates/status` | Provider health, last success, last error, cache, settings |
| `GET /api/providers` | Selectable providers and whether each is configured (never returns keys) |
| `GET /api/exchange-rates/compare?target=AED&currencies=USD,EUR[&rateType=midpoint]` | All three providers side by side (read-only) with % difference vs ExchangeRate-API, dates, rate types and warnings |
| *All rate endpoints above* `&provider=currencyapi-com` or `&provider=oanda[&rateType=midpoint\|bid\|ask]` | Use another provider (a previewed OANDA rate type never changes ERP rates) |
| `GET /api/exchange-rates/currencies` | Supported currencies with names |
| `GET /api/exchange-rates/convert?from=USD&to=INR&amount=1000` | Decimal-safe conversion |
| `GET /api/exchange-rates/history?currency=USD&days=7` | Daily history (1–31 days) from the fallback provider, labelled as such. Returns **501** if no configured provider supports history |
| `GET /api/erp-preview?provider=&country=SA` | Effective ERP rates for one country, per-country summary, editor status (read-only, everyone) |
| `GET /api/erp-preview/history?provider=&country=&currency=` | Full change history of one rate |
| `GET /api/erp-preview/audit?provider=&country=` | Audit log (automatic updates, held updates, overrides, resumes) |
| `GET /api/erp-preview/schedule` | Automatic update settings, next run and last run result |
| `GET /api/erp-preview/sql?provider=&country=` | Generated T-SQL preview (**never executed**) |
| `POST /api/auth/login` `{passcode}` · `POST /api/auth/logout` · `GET /api/auth/me` | Rate-editor sign-in (session token) |
| `POST /api/erp-preview/rates/override` `{provider?, country, currency, rate, reason}` | **Editor only.** Manual rate for one currency |
| `POST /api/erp-preview/rates/resume` `{provider?, country, currency}` | **Editor only.** Remove the override, resume automatic updates |
| `POST /api/erp-preview/rates/accept` `{provider?, country, currency}` | **Editor only.** Accept an API rate that validation held back |
| `POST /api/erp-preview/schedule/run` · `DELETE /api/erp-preview` | **Editor only.** Run the update now · clear the simulation |

Errors always use this shape: `{"error": {"code": "UPSTREAM_TIMEOUT", "message": "...", "details": ...}}`.
Codes include `INVALID_CURRENCY`, `UNSUPPORTED_CURRENCY`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`,
`HISTORY_NOT_SUPPORTED`, `RECORD_LOCKED` and `INVALID_STATE`.

**Failure behaviour:**
1. If the primary provider fails (timeout, HTTP error, bad data), the fallback provider is used and a warning is shown.
2. If all providers fail, the last good cached rates are returned with a warning.
3. If all providers fail and nothing is cached, the API returns 502 with each provider's error. The status panel shows the last successful fetch.

---

## 7. ERP Integration Preview (simulation)

The layout mirrors Zybo's **Branches Exchange Rate** screen:

- **Country panel (left):** United Arab Emirates (AED), Saudi Arabia (SAR), Bahrain (BHD), China (CNY), India (INR),
  Kuwait (KWD), Oman (OMR), Qatar (QAR), Thailand (THB), United Kingdom (GBP) and United States (USD). The list is in
  `backend/src/lib/countries.ts`.
- **Base currency header:** shows the selected country's base currency. Rates are always *units of the base per 1 unit of
  the foreign currency* (for example 1 USD = 3.75 SAR, or 1 USD = 0.376 BHD).
- **One feed, many tables:** selecting a country automatically proposes its rates. They are cross-calculated
  (`quote[base] / quote[foreign]`, exact decimals) from the same AED snapshot used by the overview, so one provider call
  serves every country and all tables are consistent. The foreign currencies come from `ERP_CURRENCIES`. The default is the
  25 currencies on Zybo's Branches Exchange Rate screen (USD, EUR, GBP, AUD, BHD, BND, CHF, CNY, DKK, HKD, IDR, INR, JPY,
  KWD, MAD, NOK, NZD, OMR, QAR, SAR, SEK, SGD, THB, ZAR, with Zybo's duplicate "YEN" row mapped to JPY) plus AED,
  excluding the country's own base. They don't change when currencies
  are added in the overview. No rates are hard-coded.
- **Country level:** effective rates apply to all branches in that country. Branches are not modelled. Every rate is
  keyed by provider + country + currency, so nothing in one country or provider affects another.

Table columns: **Code, Currency, Exchange Rate, Effective Date, Source, Rate Type, Last Updated, Actions**.

### Automatic updates (no approval step)

Every day at **08:00 UAE time** (`DAILY_FETCH_TIME`, `DAILY_FETCH_TIMEZONE`) the backend fetches fresh rates from each
provider in `DAILY_FETCH_PROVIDERS` (providers without a key are skipped), validates them, and makes them the **effective
rates** for all 11 countries. If no rates exist when the server starts, an initial load runs straight away.

Validation – a rate is **held** (the current rate stays effective) when:
- it moved more than `MAX_DEVIATION_PERCENT` (default 5%) against the current rate for the same pair, or against the
  provider's previous-day rate when the pair has no rate yet;
- the source data is stale (missing business days);
- the provider value is invalid.

If a provider is down, the update retries every 15 minutes, up to 8 attempts; current rates stay effective meanwhile.
The dashboard shows the schedule, the next run and the last run's result per country.

### Read-only, with one rate editor

- Rates are **read-only** for everyone. Only the one designated editor (`ERP_EDITOR_NAME`, signs in with
  `ERP_EDITOR_PASSCODE`) sees **Edit**, **Resume Auto Update**, **Accept API rate**, **Run update now** and **Clear simulation**.
- **Enforced on the backend:** signing in returns a random session token (8 hours, server memory). Every edit endpoint
  rejects requests without a valid editor session with **403**, whatever the browser shows. Five wrong passcodes lock
  sign-in for 5 minutes. With no passcode configured, editing is off for everyone. Production would use Entra ID.
- **Edit** changes one currency only and becomes a **Manual override** (amber row, badge, reason and author shown). The
  previous rate, new rate, user, time and reason are stored. Automatic updates never change an overridden rate; they
  only record the latest API rate next to it.
- **Resume Auto Update** removes the override. The latest API rate becomes effective if it passes validation; otherwise
  the last automatic rate is used and the API rate is held.
- **Accept API rate** makes a held rate effective (for a genuine move above the limit).
- **History** (every user) lists every change to a rate. The **Audit log** lists every automatic update, held update,
  override, resume and acceptance. Entries are append-only.
- **Compare All Providers:** the comparison is read-only. The ERP page asks which provider's effective rates to show; each
  provider keeps its own effective rates and overrides.
- **SQL preview** shows the append-only `INSERT` a future integration would run for the current effective rates,
  including `RateType` (`AUTOMATIC` / `MANUAL_OVERRIDE`), previous rate and reason. It is never executed.
- Everything is held **in backend memory**. It is lost when the server restarts.

**Limitation:** the scheduler runs only while the backend is running. On a laptop that means while `npm run dev`
is open. Production would run it on a company server, using Windows Task Scheduler, SQL Agent or a hosted scheduler.

---

## 8. Future SQL Server integration (not implemented)

1. **Stage, don't overwrite.** Write to a separate `dbo.ExchangeRateStaging` table (the DDL is in the SQL preview),
   with `UNIQUE (CountryCode, CurrencyCode, BaseCurrency, EffectiveDate, Version)` and `DECIMAL(19,8)` rates. A controlled
   stored procedure, reviewed with the Zybo vendor, should copy effective rows into Zybo's own rate table.
   Never update rates already used by issued transactions.
2. Use `mssql`/`tedious` with **parameterised** queries (the preview SQL uses literals for readability only),
   a least-privilege SQL login, and credentials in a secrets store.
3. Replace `ErpStagingService`'s in-memory `Map` with a repository behind the same methods. Controllers and frontend stay unchanged.
4. Replace the POC's passcode sign-in with real authentication (for example Entra ID) and an "ExchangeRateEditor" role.
5. Move the daily schedule out of the web process (Windows Task Scheduler, SQL Agent, or a hosted job) so it runs even when
   nobody has the app open. The POC's in-app scheduler holds the logic to reuse.
6. **Decide the rate source with Finance first:** CBUAE published rates, a bank feed (rates actually used for settlement), or a
   paid provider with an SLA (Open Exchange Rates, ExchangeRate-API paid, XE, Refinitiv/LSEG). Free providers
   have no uptime guarantee.

---

## 9. Configuration

See [backend/.env.example](backend/.env.example) for every setting with comments. The main ones are
`TARGET_CURRENCY`, `DEFAULT_CURRENCIES`, `PRIMARY_PROVIDER`, `FALLBACK_PROVIDER`, `REQUEST_TIMEOUT_MS`,
`CACHE_TTL_SECONDS`, `MIN_REFRESH_INTERVAL_SECONDS`, `STALE_AFTER_HOURS`, `WEEKEND_DAYS`, `HOLIDAYS`,
`RATE_DECIMAL_PLACES`, `MAX_DEVIATION_PERCENT`, the `OANDA_*` settings and the `DAILY_FETCH_*` scheduler settings. The frontend only has `VITE_API_PROXY_TARGET`.

---

## 10. Testing performed & known limitations

**Tested successfully (11 Nov 2026):**
- 36 automated backend tests: rate direction, inversion, cross rates, minor-unit rounding, staleness
  (weekend, holiday, missed business day), cache and refresh throttle, fallback, total outage, validation errors,
  and the full ERP workflow including locking, versioning, override validation and SQL escaping.
- Live smoke test: both providers return all six required currencies, and USD/AED matches the 3.6725 peg. Dated history works.
- Manual end-to-end run through the Vite proxy: all endpoints, ERP workflow, primary timeout → fallback, and total outage → structured 502.
- TypeScript strict typecheck and production build for both projects. Headless-browser render of the dashboard.

**Not tested / limitations:**
- No frontend automated tests. The UI was checked by a rendered screenshot plus API tests, not by click-through automation.
- Not tested on a machine with a permanent Node.js install, a corporate proxy, or a firewall.
- Provider rate limits were not load-tested. Free-tier availability is not guaranteed.
- The holiday calendar is manual. Staleness rules use UTC calendar dates.
- History comes from the community fallback provider, not the primary.
- No authentication, persistence, or real ERP/SQL connection (by design for this POC).
- Exchange-rate data is attributed to its providers. Check each provider's terms before any commercial or production use.
