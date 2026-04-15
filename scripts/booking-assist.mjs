import 'dotenv/config';
import { chromium } from 'playwright';

const argv = new Set(process.argv.slice(2));

const cfg = {
  url:
    process.env.BOOKING_URL ||
    'https://parks.saskatchewan.ca/camping/buffalo-pound-provincial-park/r/campgroundDetails.do?contractCode=SKPP&parkId=290170',
  bookingOpenIso: process.env.BOOKING_OPEN_ISO,
  targetSites: (process.env.TARGET_SITES || 'L2,L3')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 500),
  openEarlyMs: Number(process.env.OPEN_EARLY_MS || 120_000),
  maxAttempts: Number(process.env.MAX_ATTEMPTS || 300),
  headless: String(process.env.HEADLESS || 'false').toLowerCase() === 'true',
  slowMoMs: Number(process.env.SLOW_MO_MS || 0),
  runNow:
    argv.has('--run-now') ||
    String(process.env.RUN_NOW || 'false').toLowerCase() === 'true',
  profile: {
    firstName: process.env.FIRST_NAME || '',
    lastName: process.env.LAST_NAME || '',
    email: process.env.EMAIL || '',
    phone: process.env.PHONE || ''
  }
};

function utcNowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireBookingTime() {
  if (cfg.runNow) return;
  if (!cfg.bookingOpenIso) {
    throw new Error('BOOKING_OPEN_ISO is required unless RUN_NOW=true');
  }
  const t = Date.parse(cfg.bookingOpenIso);
  if (Number.isNaN(t)) {
    throw new Error(`Invalid BOOKING_OPEN_ISO: ${cfg.bookingOpenIso}`);
  }
}

function log(msg) {
  console.log(`[${utcNowIso()}] ${msg}`);
}

async function waitUntilWindow() {
  if (cfg.runNow) {
    log('RUN_NOW=true, skipping wait window');
    return;
  }

  const target = Date.parse(cfg.bookingOpenIso);
  const openAt = target - cfg.openEarlyMs;

  while (Date.now() < openAt) {
    const remaining = openAt - Date.now();
    const secs = Math.ceil(remaining / 1000);
    log(`Waiting to open page early window... ${secs}s`);
    await sleep(Math.min(5000, remaining));
  }

  while (Date.now() < target) {
    const remaining = target - Date.now();
    const ms = Math.min(250, remaining);
    await sleep(ms);
  }

  log('Reached booking-open timestamp.');
}

async function safeClick(locator) {
  try {
    await locator.first().click({ timeout: 1200 });
    return true;
  } catch {
    return false;
  }
}

async function fillIfEmpty(page, selectors, value) {
  if (!value) return;
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) continue;
    try {
      const current = await loc.inputValue();
      if (!current) await loc.fill(value);
      return;
    } catch {
      // continue trying other selectors
    }
  }
}

async function fillProfile(page) {
  await fillIfEmpty(page, ['input[name*=first i]', 'input[id*=first i]'], cfg.profile.firstName);
  await fillIfEmpty(page, ['input[name*=last i]', 'input[id*=last i]'], cfg.profile.lastName);
  await fillIfEmpty(page, ['input[type=email]', 'input[name*=mail i]', 'input[id*=mail i]'], cfg.profile.email);
  await fillIfEmpty(page, ['input[type=tel]', 'input[name*=phone i]', 'input[id*=phone i]'], cfg.profile.phone);
}

async function tryReserveSite(page, siteCode) {
  const code = siteCode.toUpperCase();

  // Strategy 1: find a row/card that includes the site code and click a reserve/book button inside it.
  const containers = page.locator(`:is(tr, li, article, div):has-text("${code}")`);
  const count = await containers.count();

  for (let i = 0; i < Math.min(count, 15); i += 1) {
    const c = containers.nth(i);
    const reserveButton = c.locator('button:has-text("Reserve"), button:has-text("Book"), a:has-text("Reserve"), a:has-text("Book")');
    if (await safeClick(reserveButton)) {
      log(`Clicked reserve/book inside container for ${code}`);
      return true;
    }
  }

  // Strategy 2: direct text match near actionable controls.
  const direct = page.locator(`text=/${code}/i`);
  if ((await direct.count()) > 0) {
    const nearAction = direct.first().locator('xpath=ancestor-or-self::*[self::tr or self::li or self::div][1]').locator('button, a');
    if (await safeClick(nearAction.filter({ hasText: /reserve|book/i }))) {
      log(`Clicked nearby reserve/book for ${code}`);
      return true;
    }
  }

  return false;
}

async function attemptBooking(page) {
  // Reload each attempt after booking-open to catch inventory changes.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });

  // Try both targets in priority order.
  for (const site of cfg.targetSites) {
    const ok = await tryReserveSite(page, site);
    if (!ok) continue;

    await page.waitForTimeout(600);
    await fillProfile(page);

    log(`Site ${site}: reservation interaction succeeded (pending human verification).`);
    return { success: true, site };
  }

  return { success: false };
}

async function main() {
  requireBookingTime();
  log(`Starting with targets: ${cfg.targetSites.join(', ')}`);

  const browser = await chromium.launch({
    headless: cfg.headless,
    slowMo: cfg.slowMoMs
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('dialog', async (dialog) => {
    log(`Dialog detected: ${dialog.message()}`);
    await dialog.dismiss();
  });

  try {
    await waitUntilWindow();

    log(`Opening page: ${cfg.url}`);
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Keep trying quickly right after open.
    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
      log(`Attempt ${attempt}/${cfg.maxAttempts}`);
      const result = await attemptBooking(page);
      if (result.success) {
        log(`Success path reached for ${result.site}. Complete CAPTCHA/payment manually now.`);
        log('Browser will stay open for manual finalization. Press Ctrl+C to exit when done.');

        // Keep alive for manual completion.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          await sleep(60_000);
        }
      }
      await sleep(cfg.pollIntervalMs);
    }

    log('Max attempts reached without finding a target reserve action.');
  } finally {
    if (cfg.headless) {
      await browser.close();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
