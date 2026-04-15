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
  startDate: process.env.START_DATE || '',
  nights: Number(process.env.NIGHTS || 5),
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

function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDaysIso(isoDate, days) {
  const base = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return '';
  base.setUTCDate(base.getUTCDate() + days);
  return toIsoDate(base);
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
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
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

async function setDateIfPresent(page, selectors, value) {
  for (const sel of selectors) {
    const input = page.locator(sel).first();
    if ((await input.count()) === 0) continue;
    try {
      await input.click({ timeout: 800 });
      await input.fill(value, { timeout: 1200 });
      await input.press('Enter').catch(() => {});
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

async function configureTripDates(page) {
  if (!cfg.startDate) return;
  const departure = addDaysIso(cfg.startDate, cfg.nights);
  if (!departure) {
    log(`Date config ignored: invalid START_DATE=${cfg.startDate}`);
    return;
  }

  const arrivalSet = await setDateIfPresent(
    page,
    [
      'input[name*=arriv i]',
      'input[id*=arriv i]',
      'input[name*=checkin i]',
      'input[id*=checkin i]',
      'input[name*=start i]',
      'input[id*=start i]'
    ],
    cfg.startDate
  );

  const departureSet = await setDateIfPresent(
    page,
    [
      'input[name*=depart i]',
      'input[id*=depart i]',
      'input[name*=checkout i]',
      'input[id*=checkout i]',
      'input[name*=end i]',
      'input[id*=end i]'
    ],
    departure
  );

  if (arrivalSet || departureSet) {
    await safeClick(
      page.locator(
        'button:has-text("Search"), button:has-text("Update"), button:has-text("Apply"), a:has-text("Search"), a:has-text("Update")'
      )
    );
    log(`Trip dates set -> arrival=${cfg.startDate}, departure=${departure} (${cfg.nights} nights)`);
  } else {
    log('Trip dates not set: no recognizable date inputs found on page.');
  }
}

async function tryReserveSite(page, siteCode) {
  const code = siteCode.toUpperCase();
  let matchedContainers = 0;
  let foundReserveControl = false;
  let lastClickError = '';

  // Strategy 1: find a row/card that includes the site code and click a reserve/book button inside it.
  const containers = page.locator(`:is(tr, li, article, div):has-text("${code}")`);
  const count = await containers.count();
  matchedContainers = count;

  for (let i = 0; i < Math.min(count, 15); i += 1) {
    const c = containers.nth(i);
    const reserveButton = c.locator('button:has-text("Reserve"), button:has-text("Book"), a:has-text("Reserve"), a:has-text("Book")');
    if ((await reserveButton.count()) > 0) {
      foundReserveControl = true;
    }
    const click = await safeClick(reserveButton);
    if (click.ok) {
      log(`Clicked reserve/book inside container for ${code}`);
      return { ok: true, reason: 'clicked_reserve_control' };
    }
    if (click.error) {
      lastClickError = click.error;
    }
  }

  // Strategy 2: direct text match near actionable controls.
  const direct = page.locator(`text=/${code}/i`);
  if ((await direct.count()) > 0) {
    const nearAction = direct.first().locator('xpath=ancestor-or-self::*[self::tr or self::li or self::div][1]').locator('button, a');
    const nearReserve = nearAction.filter({ hasText: /reserve|book/i });
    if ((await nearReserve.count()) > 0) {
      foundReserveControl = true;
    }
    const click = await safeClick(nearReserve);
    if (click.ok) {
      log(`Clicked nearby reserve/book for ${code}`);
      return { ok: true, reason: 'clicked_nearby_reserve_control' };
    }
    if (click.error) {
      lastClickError = click.error;
    }
  }

  if (matchedContainers === 0) {
    return { ok: false, reason: 'site_code_not_visible' };
  }
  if (!foundReserveControl) {
    return { ok: false, reason: 'site_visible_but_no_reserve_control' };
  }
  return {
    ok: false,
    reason: 'reserve_control_click_failed',
    details: lastClickError || 'unknown click failure'
  };
}

async function detectGlobalStatus(page) {
  const bodyText = (await page.locator('body').innerText()).toLowerCase();
  const signals = [];

  if (
    bodyText.includes('booking opens') ||
    bodyText.includes('not yet available') ||
    bodyText.includes('available from')
  ) {
    signals.push('booking_not_open_yet_signal');
  }

  if (
    bodyText.includes('no availability') ||
    bodyText.includes('fully booked') ||
    bodyText.includes('sold out')
  ) {
    signals.push('no_availability_signal');
  }

  if (bodyText.includes('captcha')) {
    signals.push('captcha_present_signal');
  }

  return signals;
}

async function attemptBooking(page, targetSites) {
  try {
    // Reload each attempt after booking-open to catch inventory changes.
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (error) {
      log(`Attempt failure: reload_failed (${error?.message || String(error)})`);
      return {
        success: false,
        reason: 'reload_failed',
        details: error?.message || String(error)
      };
    }

    await configureTripDates(page);

    const globalSignals = await detectGlobalStatus(page);
    const siteResults = [];

    // Try both targets in priority order.
    for (const site of targetSites) {
      const result = await tryReserveSite(page, site);
      siteResults.push({ site, ...result });
      if (!result.ok) continue;

      await page.waitForTimeout(600);
      await fillProfile(page);

      log(`Site ${site}: reservation interaction succeeded (pending human verification).`);
      return { success: true, site };
    }

    const siteSummary = siteResults.map((s) => `${s.site}:${s.reason}`).join(' | ');
    const signalSummary = globalSignals.length > 0 ? globalSignals.join(', ') : 'none';
    log(`Attempt failure summary -> signals=${signalSummary}; sites=${siteSummary || 'none'}`);

    return {
      success: false,
      reason: 'no_target_site_click_succeeded',
      globalSignals,
      siteResults
    };
  } catch (error) {
    const details = error?.message || String(error);
    log(`Attempt failure: attempt_exception (${details})`);
    return {
      success: false,
      reason: 'attempt_exception',
      details
    };
  }
}

function isClosedTargetError(error) {
  const msg = (error?.message || String(error)).toLowerCase();
  return (
    msg.includes('target page, context or browser has been closed') ||
    msg.includes('page has been closed') ||
    msg.includes('browser has been closed')
  );
}

function attachPageHandlers(page) {
  page.on('dialog', async (dialog) => {
    log(`Dialog detected: ${dialog.message()}`);
    await dialog.dismiss();
  });
}

async function recoverPage(context, currentPage, url) {
  if (currentPage && !currentPage.isClosed()) return currentPage;
  if (context.pages().length > 0) {
    const p = context.pages().find((x) => !x.isClosed());
    if (p) return p;
  }
  const newPage = await context.newPage();
  attachPageHandlers(newPage);
  await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  log('Recovered by creating a new page after previous page closed.');
  return newPage;
}

function summarizeAttempt(result) {
  if (result.success) {
    return `success: ${result.site}`;
  }

  const parts = [];
  parts.push(`reason=${result.reason || 'unknown_failure'}`);

  if (Array.isArray(result.globalSignals) && result.globalSignals.length > 0) {
    parts.push(`signals=${result.globalSignals.join(',')}`);
  }

  if (Array.isArray(result.siteResults) && result.siteResults.length > 0) {
    const siteBits = result.siteResults.map((s) => {
      const detail = s.details ? ` (${s.details})` : '';
      return `${s.site}:${s.reason || (s.ok ? 'ok' : 'failed')}${detail}`;
    });
    parts.push(`sites=[${siteBits.join(' | ')}]`);
  }

  if (result.details) {
    parts.push(`details=${result.details}`);
  }

  return parts.join(' ; ');
}

async function main() {
  requireBookingTime();
  const pendingSites = new Set(cfg.targetSites.map((s) => s.toUpperCase()));
  log(`Starting with targets: ${Array.from(pendingSites).join(', ')}`);

  const browser = await chromium.launch({
    headless: cfg.headless,
    slowMo: cfg.slowMoMs
  });

  const context = await browser.newContext();
  let page = await context.newPage();
  attachPageHandlers(page);

  try {
    await waitUntilWindow();

    log(`Opening page: ${cfg.url}`);
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Keep trying quickly right after open.
    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
      log(`Attempt ${attempt}/${cfg.maxAttempts}`);
      try {
        page = await recoverPage(context, page, cfg.url);
      } catch (error) {
        log(`Attempt ${attempt} could not recover page: ${error?.message || String(error)}`);
        break;
      }

      let result;
      try {
        result = await attemptBooking(page, Array.from(pendingSites));
      } catch (error) {
        if (isClosedTargetError(error)) {
          const closedResult = {
            success: false,
            reason: 'page_or_context_closed',
            details: error?.message || String(error)
          };
          log(`Attempt ${attempt} result: ${summarizeAttempt(closedResult)}`);
          await sleep(500);
          continue;
        }
        const unexpectedResult = {
          success: false,
          reason: 'unexpected_exception',
          details: error?.message || String(error)
        };
        log(`Attempt ${attempt} result: ${summarizeAttempt(unexpectedResult)}`);
        await sleep(cfg.pollIntervalMs);
        continue;
      }
      if (result.success) {
        pendingSites.delete(String(result.site).toUpperCase());
        if (pendingSites.size === 0) {
          log(`Success path reached for all targets (${cfg.targetSites.join(', ')}). Complete CAPTCHA/payment manually now.`);
          log('Browser will stay open for manual finalization. Press Ctrl+C to exit when done.');

          // Keep alive for manual completion.
          // eslint-disable-next-line no-constant-condition
          while (true) {
            await sleep(60_000);
          }
        }
        log(`Added target ${result.site}. Remaining targets: ${Array.from(pendingSites).join(', ') || 'none'}`);
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      log(`Attempt ${attempt} result: ${summarizeAttempt(result)}`);
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
