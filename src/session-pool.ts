import { createHash } from 'crypto';
import { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser } from './browser.js';

interface Entry {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastUsed: number;
  inFlight: Promise<Page> | null;
}

const IDLE_TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
// Hard cap on concurrent cached sessions. Each Chromium context is ~150 MB;
// the 1 GB Fly VM realistically tops out around 5. Override via env if you
// resize the machine.
const MAX_SESSIONS = Number(process.env.MCP_MAX_SESSIONS || 4);

const pool = new Map<string, Entry>();

function userKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

async function isPageAlive(page: Page): Promise<boolean> {
  try {
    await page.evaluate(() => true);
    return true;
  } catch {
    return false;
  }
}

export function isAuthError(err: unknown): boolean {
  return err instanceof Error && /Kicktipp (login failed|session is not authenticated)/i.test(err.message);
}

export async function invalidateSession(email: string): Promise<void> {
  await evict(userKey(email));
}

// Evict least-recently-used non-inflight entries until we're below the cap.
async function enforceCapacity(): Promise<void> {
  while (pool.size >= MAX_SESSIONS) {
    let oldestKey: string | null = null;
    let oldestUsed = Infinity;
    for (const [k, e] of pool) {
      if (e.inFlight) continue;
      if (e.lastUsed < oldestUsed) {
        oldestUsed = e.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) break; // everything is mid-launch — let one finish
    await evict(oldestKey);
  }
}

async function evict(key: string): Promise<void> {
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  try {
    await entry.context.close();
  } catch { /* ignore */ }
  try {
    await entry.browser.close();
  } catch { /* ignore */ }
}

export async function getSessionPage(email: string, password: string): Promise<Page> {
  const key = userKey(email);
  const existing = pool.get(key);

  if (existing) {
    if (existing.inFlight) return existing.inFlight;
    if (await isPageAlive(existing.page)) {
      existing.lastUsed = Date.now();
      return existing.page;
    }
    await evict(key);
  }

  // Insert the placeholder synchronously BEFORE the await so concurrent
  // getSessionPage calls for new users don't all race past the capacity
  // check and overshoot MAX_SESSIONS. Then enforce capacity (which may
  // evict other entries) and finally kick off the launch.
  let resolveLaunch!: (p: Page) => void;
  let rejectLaunch!: (err: unknown) => void;
  const launchPromise = new Promise<Page>((resolve, reject) => {
    resolveLaunch = resolve;
    rejectLaunch = reject;
  });
  const placeholder: Entry = {
    browser: null as unknown as Browser,
    context: null as unknown as BrowserContext,
    page: null as unknown as Page,
    lastUsed: Date.now(),
    inFlight: launchPromise,
  };
  pool.set(key, placeholder);

  await enforceCapacity();

  launchBrowser({ email, password, sessionFile: null }).then(({ browser, context, page }) => {
    const entry: Entry = { browser, context, page, lastUsed: Date.now(), inFlight: null };
    pool.set(key, entry);
    resolveLaunch(page);
  }, rejectLaunch);

  try {
    return await launchPromise;
  } catch (err) {
    pool.delete(key);
    throw err;
  }
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pool) {
    if (entry.inFlight) continue;
    if (now - entry.lastUsed > IDLE_TTL_MS) {
      void evict(key);
    }
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

export async function shutdownPool(): Promise<void> {
  clearInterval(sweeper);
  await Promise.all(Array.from(pool.keys()).map(evict));
}
