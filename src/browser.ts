import { chromium, Page, Browser, BrowserContext } from 'playwright';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import fs from 'fs';
import path from 'path';
import { URL_BASE, URL_LOGIN, getLeaderboardUrl } from './url.js';
import { SESSION_FILE, loadCredentials } from './config.js';
import { status, statusClear } from './helpers/spinner.js';

export async function launchBrowser(): Promise<{ browser: Browser; page: Page; context: BrowserContext }> {
  const browser = await chromium.launch({ headless: true });

  // Always do fresh login (session restoration was causing hangs)
  const { email, password } = await loadCredentials();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await login(page, email, password);
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  await context.storageState({ path: SESSION_FILE });
  fs.chmodSync(SESSION_FILE, 0o600);
  return { browser, page, context };
}

export async function dismissConsent(page: Page): Promise<void> {
  try {
    const iframePromise = page.waitForSelector('iframe[src*="privacy-mgmt"]', { timeout: 500 });
    const foundIframe = await Promise.race([iframePromise, new Promise(r => setTimeout(() => r(null), 600))]);
    if (!foundIframe) return; // No iframe, skip

    for (const frame of page.frames()) {
      try {
        const btn = await frame.$('button:has-text("Accept and continue")');
        if (btn) {
          await btn.click();
          await page.waitForSelector('iframe[src*="privacy-mgmt"]', { state: 'hidden', timeout: 1000 }).catch(() => {});
          return;
        }
      } catch {
        // Frame might not be accessible
      }
    }
  } catch {
    /* no consent dialog */
  }
}

async function login(page: Page, username: string, password: string): Promise<void> {
  status('Logging in...');
  await page.goto(URL_LOGIN, { waitUntil: 'networkidle', timeout: 5000 }).catch(() => {});
  await dismissConsent(page);

  try {
    await page.fill('input[name="kennung"]', username, { timeout: 2000 });
    await page.fill('input[name="passwort"]', password, { timeout: 2000 });
  } catch (err) {
    console.error('Login form not found, but continuing...');
  }

  try {
    await page.click('button[type="submit"]', { timeout: 2000 });
  } catch (err) {
    console.error('Submit button not found, but continuing...');
  }

  // Just wait a bit for the page to change, don't wait for navigation event
  await new Promise(r => setTimeout(r, 3000));
  statusClear();
}

export async function getCommunities(page: Page): Promise<string[]> {
  status('Fetching communities...');
  await page.goto(`${URL_BASE}/info/profil/meinetipprunden`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  try {
    await page.waitForLoadState('domcontentloaded');
  } catch {
    /* timeout is ok */
  }
  await dismissConsent(page);

  const $ = cheerio.load(await page.content());
  const links = $('#kicktipp-content a');
  const communities: string[] = [];
  links.each((_, el) => {
    const href = ($(el).attr('href') || '').replace(/\//g, '');
    const text = $(el).text().trim();
    const menuDiv = $(el).find('div.menu-title-mit-tippglocke');
    if (
      href.toLowerCase() === text.toLowerCase() ||
      (menuDiv.length && menuDiv.text().trim().toLowerCase() === href.toLowerCase())
    ) {
      communities.push(href);
    }
  });
  statusClear();
  return communities;
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
