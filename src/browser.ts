import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import fs from 'fs';
import path from 'path';
import { URL_BASE, URL_LOGIN, getAlternateUrls, getCommunitiesUrl, getLeaderboardUrl } from './url.js';
import { SESSION_FILE, loadCredentials } from './config.js';
import { status, statusClear } from './helpers/spinner.js';

export interface LaunchOptions {
  email?: string;
  password?: string;
  // Path to persist cookies. Pass null to skip persistence (use case:
  // multi-user session pool where each user has an in-memory cookie jar).
  sessionFile?: string | null;
}

export interface Browser {
  close(): Promise<void>;
}

export interface BrowserContext {
  close(): Promise<void>;
}

interface SerializedCookie {
  name: string;
  value: string;
}

interface StoredSession {
  cookies?: SerializedCookie[];
}

type HeaderBag = Headers & {
  getSetCookie?: () => string[];
};

const AUTH_LOST_URL = /\/(login|profile\/login|profil\/login)(\?|$|\/)/i;

class CookieJar {
  private cookies = new Map<string, string>();

  static fromFile(file: string): CookieJar {
    const jar = new CookieJar();
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as StoredSession;
    for (const cookie of raw.cookies || []) {
      if (cookie.name && cookie.value !== undefined) {
        jar.cookies.set(cookie.name, cookie.value);
      }
    }
    return jar;
  }

  store(headers: Headers): void {
    const headerBag = headers as HeaderBag;
    const values = typeof headerBag.getSetCookie === 'function'
      ? headerBag.getSetCookie()
      : splitSetCookie(headerBag.get('set-cookie') || '');

    for (const value of values) {
      const first = value.split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq);
      const cookieValue = first.slice(eq + 1);
      if (/\bmax-age=0\b|\bexpires=Thu,\s*01\s*Jan\s*1970\b/i.test(value)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, cookieValue);
      }
    }
  }

  header(): string {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join('; ');
  }

  toJSON(): StoredSession {
    return {
      cookies: Array.from(this.cookies, ([name, value]) => ({ name, value })),
    };
  }
}

function splitSetCookie(value: string): string[] {
  if (!value) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.slice(i, i + 2) !== ', ') continue;
    const next = value.slice(i + 2);
    if (/^[^=;,]+=/.test(next)) {
      out.push(value.slice(start, i));
      start = i + 2;
    }
  }
  out.push(value.slice(start));
  return out.filter(Boolean);
}

class HttpElement {
  constructor(
    private readonly page: Page,
    private readonly selector: string,
  ) {}

  async fill(value: string): Promise<void> {
    this.page.setInputValue(this.selector, value);
  }

  async click(): Promise<void> {
    await this.page.click(this.selector);
  }
}

export class Page {
  private currentUrl = URL_BASE;
  private html = '';
  private $dom: cheerio.CheerioAPI | null = null;
  private closed = false;
  private lastStatus = 0;
  private waiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];

  constructor(private readonly jar = new CookieJar()) {}

  async goto(url: string, _opts: unknown = {}): Promise<void> {
    this.ensureOpen();
    await this.navigate('GET', this.absoluteUrl(url));
    if (!this.isMissingResponse()) return;

    const tried = new Set([this.currentUrl]);
    for (const alternate of getAlternateUrls(this.currentUrl)) {
      if (tried.has(alternate)) continue;
      tried.add(alternate);
      await this.navigate('GET', alternate);
      if (!this.isMissingResponse()) return;
    }
  }

  async waitForLoadState(_state?: string): Promise<void> {
    this.ensureOpen();
  }

  async waitForNavigation(_opts: unknown = {}): Promise<void> {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async content(): Promise<string> {
    this.ensureOpen();
    return this.$dom ? this.$dom.html() : this.html;
  }

  url(): string {
    return this.currentUrl;
  }

  status(): number {
    return this.lastStatus;
  }

  async evaluate<T>(fn: () => T): Promise<T> {
    this.ensureOpen();
    return fn();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.resolveWaiters();
  }

  async $(selector: string): Promise<HttpElement | null> {
    this.ensureOpen();
    const el = this.find(selector);
    return el.length ? new HttpElement(this, selector) : null;
  }

  async click(selector: string): Promise<void> {
    this.ensureOpen();
    const submitter = this.find(selector);
    if (!submitter.length) {
      throw new Error(`Element not found: ${selector}`);
    }
    await this.submit(submitter);
  }

  async selectOption(selector: string, value: string): Promise<void> {
    this.ensureOpen();
    const $ = this.dom();
    const select = this.find(selector);
    if (!select.length) {
      throw new Error(`Select not found: ${selector}`);
    }
    const option = select.find('option').filter((_, el) => ($(el).attr('value') || '') === value).first();
    if (!option.length) {
      throw new Error(`Option value "${value}" not found for ${selector}`);
    }
    if (select.attr('multiple') === undefined) {
      select.find('option').removeAttr('selected');
    }
    option.attr('selected', 'selected');
    this.html = $.html();
  }

  setInputValue(selector: string, value: string): void {
    this.ensureOpen();
    const $ = this.dom();
    const input = this.find(selector);
    if (!input.length) {
      throw new Error(`Input not found: ${selector}`);
    }
    input.attr('value', value);
    this.html = $.html();
  }

  replaceContent(html: string): void {
    this.html = html;
    this.$dom = cheerio.load(html);
  }

  saveSession(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmpFile = `${file}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(this.jar.toJSON(), null, 2));
    fs.chmodSync(tmpFile, 0o600);
    fs.renameSync(tmpFile, file);
  }

  isAuthRedirect(): boolean {
    return AUTH_LOST_URL.test(this.currentUrl);
  }

  private async submit(submitter: cheerio.Cheerio<AnyNode>): Promise<void> {
    const form = submitter.closest('form');
    if (!form.length) {
      throw new Error('Submit button is not inside a form.');
    }
    const method = (form.attr('method') || 'get').toLowerCase();
    const action = this.absoluteUrl(form.attr('action') || this.currentUrl);
    const body = this.serializeForm(form, submitter);

    try {
      if (method === 'get') {
        const target = new URL(action);
        for (const [key, value] of body) target.searchParams.append(key, value);
        await this.navigate('GET', target.toString());
      } else {
        await this.navigate('POST', action, body, this.currentUrl);
      }
      this.resolveWaiters();
    } catch (err) {
      this.rejectWaiters(err);
      throw err;
    }
  }

  private serializeForm(
    form: cheerio.Cheerio<AnyNode>,
    submitter: cheerio.Cheerio<AnyNode>,
  ): URLSearchParams {
    const $ = this.dom();
    const body = new URLSearchParams();
    form.find('input, select, textarea, button').each((_, node) => {
      const el = $(node);
      const tag = (node as Element).tagName.toLowerCase();
      const name = el.attr('name');
      if (!name || el.attr('disabled') !== undefined) return;

      if (tag === 'button') {
        if (node === submitter.get(0)) body.append(name, el.attr('value') || '');
        return;
      }

      if (tag === 'textarea') {
        body.append(name, el.text());
        return;
      }

      if (tag === 'select') {
        let selected = el.find('option[selected]');
        if (!selected.length && el.attr('multiple') === undefined) {
          selected = el.find('option').first();
        }
        selected.each((__, option) => {
          const opt = $(option);
          body.append(name, opt.attr('value') ?? opt.text());
        });
        return;
      }

      const type = (el.attr('type') || 'text').toLowerCase();
      if (['button', 'image', 'reset', 'file'].includes(type)) return;
      if (['checkbox', 'radio'].includes(type) && el.attr('checked') === undefined) return;
      if (['submit'].includes(type)) {
        if (node === submitter.get(0)) body.append(name, el.attr('value') || '');
        return;
      }
      body.append(name, el.attr('value') || '');
    });
    return body;
  }

  private async navigate(
    method: 'GET' | 'POST',
    url: string,
    body?: URLSearchParams,
    referer?: string,
  ): Promise<void> {
    let currentUrl = url;
    let currentMethod = method;
    let currentBody = body;
    let currentReferer = referer;

    for (let redirects = 0; redirects < 8; redirects++) {
      const headers = new Headers({
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
        'User-Agent': 'kicktipp-agent/1.0 (+https://github.com)',
      });
      const cookie = this.jar.header();
      if (cookie) headers.set('Cookie', cookie);
      if (currentReferer) headers.set('Referer', currentReferer);
      if (currentMethod === 'POST') {
        headers.set('Content-Type', 'application/x-www-form-urlencoded');
      }

      const res = await fetch(currentUrl, {
        method: currentMethod,
        headers,
        body: currentMethod === 'POST' ? currentBody : undefined,
        redirect: 'manual',
      });
      this.jar.store(res.headers);

      const location = res.headers.get('location');
      if (location && [301, 302, 303, 307, 308].includes(res.status)) {
        currentReferer = currentUrl;
        currentUrl = this.absoluteUrl(location, currentUrl);
        if (![307, 308].includes(res.status)) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        continue;
      }

      this.currentUrl = currentUrl;
      this.lastStatus = res.status;
      this.html = await res.text();
      this.$dom = cheerio.load(this.html);
      return;
    }
    throw new Error(`Too many redirects while requesting ${url}`);
  }

  private find(selector: string): cheerio.Cheerio<AnyNode> {
    const $ = this.dom();
    const hasText = selector.match(/^button:has-text\((["'])(.*)\1\)$/);
    if (hasText) {
      const needle = hasText[2];
      return $('button').filter((_, el) => $(el).text().includes(needle)).first();
    }
    return $(selector).first();
  }

  private dom(): cheerio.CheerioAPI {
    this.ensureOpen();
    if (!this.$dom) this.$dom = cheerio.load(this.html);
    return this.$dom;
  }

  private absoluteUrl(url: string, base = this.currentUrl || URL_BASE): string {
    return new URL(url, base).toString();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Kicktipp session is closed.');
  }

  private isMissingResponse(): boolean {
    if (this.lastStatus === 404) return true;
    return /Seite\s+wurde\s+nicht\s+gefunden|Page\s+not\s+found/i.test(this.html);
  }

  private resolveWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  private rejectWaiters(err: unknown): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(err);
  }
}

const noopHandle = {
  async close(): Promise<void> {
    /* no resources to release */
  },
};

export async function launchBrowser(
  opts: LaunchOptions = {},
): Promise<{ browser: Browser; page: Page; context: BrowserContext }> {
  const sessionFile = opts.sessionFile === undefined ? SESSION_FILE : opts.sessionFile;

  if (sessionFile && fs.existsSync(sessionFile)) {
    status('Restoring session...');
    try {
      const page = new Page(CookieJar.fromFile(sessionFile));
      await page.goto(getCommunitiesUrl());
      const html = await page.content();
      if (!page.isAuthRedirect() && !/Seite\s+wurde\s+nicht\s+gefunden/i.test(html)) {
        statusClear();
        return { browser: noopHandle, page, context: noopHandle };
      }
    } catch {
      // Fall through to a fresh login. Old browser storage files and stale
      // cookie jars are both harmless here.
    }
    status('Session expired, logging in again...');
  }

  const creds = opts.email && opts.password
    ? { email: opts.email, password: opts.password }
    : await loadCredentials();
  const page = new Page();
  await login(page, creds.email, creds.password);
  if (sessionFile) page.saveSession(sessionFile);
  return { browser: noopHandle, page, context: noopHandle };
}

export async function dismissConsent(_page: Page): Promise<void> {
  // The HTTP client never loads the consent iframe; Kicktipp's server-rendered
  // pages and forms work without executing the browser consent flow.
}

async function login(page: Page, username: string, password: string): Promise<void> {
  status('Logging in...');
  await page.goto(URL_LOGIN);
  const $ = cheerio.load(await page.content());
  const form = $('form').filter((_, el) => $(el).find('input[name="kennung"]').length > 0).first();
  if (!form.length) {
    statusClear();
    throw new Error('Kicktipp login form not found.');
  }

  form.find('input[name="kennung"]').attr('value', username);
  form.find('input[name="passwort"]').attr('value', password);
  page.replaceContent($.html());

  const submit =
    form.find('button[type="submit"], button[name="submitbutton"], input[type="submit"]').first();
  if (!submit.length) {
    statusClear();
    throw new Error('Kicktipp login submit button not found.');
  }

  await page.click(selectorForSubmit(submit));
  if (page.isAuthRedirect()) {
    statusClear();
    throw new Error('Kicktipp login failed. Check your credentials.');
  }
  statusClear();
}

function selectorForSubmit(submit: cheerio.Cheerio<AnyNode>): string {
  const name = submit.attr('name');
  const tag = (submit.get(0) as Element | undefined)?.tagName || 'button';
  if (name) return `${tag}[name="${name.replace(/["\\]/g, '\\$&')}"]`;
  const type = submit.attr('type');
  if (type) return `${tag}[type="${type.replace(/["\\]/g, '\\$&')}"]`;
  return 'button';
}

export async function getCommunities(page: Page): Promise<string[]> {
  status('Fetching communities...');
  await page.goto(getCommunitiesUrl());
  const finalUrl = page.url();
  if (AUTH_LOST_URL.test(finalUrl)) {
    throw new Error(`Kicktipp session is not authenticated (redirected to ${finalUrl}). Verify credentials.`);
  }

  const $ = cheerio.load(await page.content());
  const links = $('#kicktipp-content a');
  const communities = new Set<string>();
  const reserved = new Set(['info', 'service']);
  links.each((_, el) => {
    const raw = $(el).attr('href') || '';
    // Community links look like "/<slug>/" or "/<slug>" - a single path segment.
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
  statusClear();

  const $ = cheerio.load(await page.content());
  const players: string[] = [];
  $('table#ranking tbody tr').each((_, tr) => {
    const name = $(tr).find('div.mg_name').text().trim();
    if (name) players.push(name);
  });
  return players;
}
