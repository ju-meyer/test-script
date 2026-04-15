# Saskatchewan Parks booking assist (human-in-the-loop)

This repository contains a **speed-assist automation script** to help you move quickly at booking-open time for Saskatchewan Parks campsites.

> It is designed to automate navigation and form-filling where possible, while keeping a human in control for any CAPTCHA, explicit confirmations, and payment.

## What it does

- Opens the booking page in Chromium (Playwright).
- Waits until a target booking-open timestamp.
- Tries target sites in priority order (example: `L2`, then `L3`).
- Keeps retrying until all target sites are added (for example both `L2` and `L3`).
- Attempts to click reserve/book actions for matching site rows/cards.
- Supports site actions labeled `Enter Date` (not just `Reserve`/`Book`) for parks using that flow.
- Matches site codes using common variants (e.g., `L2`, `L 2`, `L-2`, `Loop L Site 2`).
- Attempts to set arrival/departure dates from `START_DATE` + (`END_DATE` or `NIGHTS`) each attempt.
- Handles date widgets that require `MM/DD/YYYY` and a separate `Length of stay` field.
- Can click a target site-type filter label (default `Nightly Electric`) and scan multiple result pages via `Next`.
- Searches main page and embedded frames for filters, site rows, and actions.
- Optionally auto-fills obvious form fields from environment variables.
- Leaves final confirmation/payment to you.
- Logs structured attempt diagnostics (e.g., site code not visible, reserve button missing, click failed, potential not-open/no-availability signals).
- Logs a one-line human-readable reason for each failed attempt (with per-site breakdown).
- Catches and logs unexpected per-attempt exceptions (instead of crashing on stack traces).
- Recovers from accidental tab/page closures by opening a fresh page and continuing attempts.

## What it does **not** do

- No CAPTCHA bypass.
- No anti-bot evasion.
- No hidden API abuse.

Use responsibly and in compliance with the website terms.

---

## Quick start

1. Install Node 20+.
2. Install dependencies:

```bash
npm install
npx playwright install chromium
```

3. Copy env template and edit values:

```bash
cp .env.example .env
```

4. Dry run now (without waiting):

```bash
npm run start:now
```

This works in PowerShell/CMD too because `npm run start:now` calls a Node launcher script (`scripts/start-now.mjs`) instead of relying on shell-specific env syntax.

5. Run for launch time:

```bash
npm start
```

---

## Time configuration

The script expects `BOOKING_OPEN_ISO` in **UTC ISO** format.

For Regina (CST, UTC-6) at 7:00 AM on Apr 16, 2026:

- Local: `2026-04-16 07:00:00` (Regina)
- UTC: `2026-04-16T13:00:00Z`

Set this in `.env`.

---

## Notes

Because booking pages can change structure, selector logic is heuristic and may need quick tuning after a test run.

For your specific use case, set:

- `TARGET_SITES="L2,L3"`
- `START_DATE="2026-06-26"`
- `END_DATE="2026-07-01"` (or omit this and use `NIGHTS="5"`)
- `NIGHTS="5"`
- `SITE_TYPE_LABEL="Nightly Electric"`
- `MAX_RESULT_PAGES="8"`
