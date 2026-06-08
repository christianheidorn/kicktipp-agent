import { chromium, Page, Browser, BrowserContext } from 'playwright';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import fs from 'fs';
import path from 'path';
import { URL_BASE, URL_LOGIN, getLeaderboardUrl } from './url.js';
import { SESSION_FILE, loadCredentials } from './config.js';
import { status, statusClear } from './helpers/spinner.js';

export interface LaunchOptions {
  email?: string;
  password?: string;
  // Path to persist the storage state. Pass null to skip persistence
  // (use case: multi-user session pool where each user has an in-memory context).
  sessionFile?: string | null;
}

export async function launchBrowser(
  opts: LaunchOptions = {},
): Promise<{ browser: Browser; page: Page; context: BrowserContext }> {
  const sessionFile = opts.sessionFile === undefined ? SESSION_FILE : opts.sessionFile;
  const browser = await chromium.launch({ headless: true });

  if (sessionFile && fs.existsSync(sessionFile)) {
    status('Restoring session...');
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      storageState: sessionFile,
    });
    const page = await context.newPage();
    await page.goto(URL_BASE);
    await page.waitForLoadState('domcontentloaded');
    if (!page.url().includes('/login')) {
      statusClear();
      return { browser, page, context };
    }
    status('Session expired, logging in again...');
    await context.close();
  }

  const creds = opts.email && opts.password
    ? { email: opts.email, password: opts.password }
    : await loadCredentials();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await login(page, creds.email, creds.password);
  if (sessionFile) {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    await context.storageState({ path: sessionFile });
    fs.chmodSync(sessionFile, 0o600);
  }
  return { browser, page, context };
}

export async function dismissConsent(page: Page): Promise<void> {
  try {
    await page.waitForSelector('iframe[src*="privacy-mgmt"]', { timeout: 2000 });
    for (const frame of page.frames()) {
      const btn =
        (await frame.$('button:has-text("Accept and continue")')) ||
        (await frame.$('button:has-text("Akzeptieren und weiter")')) ||
        (await frame.$('button:has-text("Akzeptieren")'));
      if (btn) {
        await btn.click();
        await page.waitForSelector('iframe[src*="privacy-mgmt"]', { state: 'hidden', timeout: 3000 });
        return;
      }
    }
  } catch {
    /* no consent dialog */
  }
}

async function login(page: Page, username: string, password: string): Promise<void> {
  status('Logging in...');
  await page.goto(URL_LOGIN);
  await page.waitForLoadState('domcontentloaded');
  await dismissConsent(page);
  await page.fill('input[name="kennung"]', username);
  await page.fill('input[name="passwort"]', password);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  if (page.url().includes('/login')) {
    statusClear();
    throw new Error('Kicktipp login failed. Check your credentials.');
  }
  statusClear();
}

export async function getCommunities(page: Page): Promise<string[]> {
  status('Fetching communities...');
  await page.goto(`${URL_BASE}/info/profil/meinetipprunden`);
  await page.waitForLoadState('domcontentloaded');
  await dismissConsent(page);
  const finalUrl = page.url();
  if (/\/(login|profile\/login|profil\/login)(\?|$|\/)/i.test(finalUrl)) {
    throw new Error(`Kicktipp session is not authenticated (redirected to ${finalUrl}). Verify credentials.`);
  }

  const $ = cheerio.load(await page.content());
  const links = $('#kicktipp-content a');
  const communities = new Set<string>();
  const reserved = new Set(['info', 'service']);
  links.each((_, el) => {
    const raw = $(el).attr('href') || '';
    // Community links look like "/<slug>/" or "/<slug>" — a single path segment.
    const match = raw.match(/^\/([^/?#]+)\/?$/);
    if (!match) return;
    const slug = match[1];
    if (reserved.has(slug)) return;
    communities.add(slug);
  });
  statusClear();
  return Array.from(communities);
}

export function parseOdds($: cheerio.CheerioAPI, td: AnyNode): [string, string, string] {
  const el = $(td);
  const home = el.find('span.quote-heim span.quote-text').text().trim();
  const draw = el.find('span.quote-remis span.quote-text').text().trim();
  const road = el.find('span.quote-gast span.quote-text').text().trim();
  return [home, draw, road];
}

export async function getPlayers(page: Page, community: string): Promise<string[]> {
  status('Fetching players...');
  await page.goto(getLeaderboardUrl(community));
  await page.waitForLoadState('domcontentloaded');
  await dismissConsent(page);
  statusClear();

  const $ = cheerio.load(await page.content());
  const players: string[] = [];
  $('table#ranking tbody tr').each((_, tr) => {
    const name = $(tr).find('div.mg_name').text().trim();
    if (name) players.push(name);
  });
  return players;
}
