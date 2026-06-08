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

  const launchPromise = launchBrowser({ email, password, sessionFile: null }).then(({ browser, context, page }) => {
    const entry: Entry = { browser, context, page, lastUsed: Date.now(), inFlight: null };
    pool.set(key, entry);
    return page;
  });

  const placeholder: Entry = {
    browser: null as unknown as Browser,
    context: null as unknown as BrowserContext,
    page: null as unknown as Page,
    lastUsed: Date.now(),
    inFlight: launchPromise,
  };
  pool.set(key, placeholder);

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
