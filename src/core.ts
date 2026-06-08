import { Page } from 'playwright';
import * as cheerio from 'cheerio';
import { dismissConsent, parseOdds, getCommunities, getPlayers } from './browser.js';
import { getPredictUrl, getLeaderboardUrl, URL_BASE } from './url.js';
import { loadCommunity, loadPlayer } from './config.js';
import {
  parseBetArg,
  matchFixture,
  EditableMatch,
} from './helpers/parse-bet-arg.js';
import { escapeCssValue } from './helpers/escape-css-value.js';

// ── Shared helpers ─────────────────────────────────────────────────

async function loadPage(page: Page, url: string): Promise<cheerio.CheerioAPI> {
  // Default waitUntil 'load' waits for every image + iframe (incl. the
  // consent-banner iframe). On a fresh login + cold start that easily
  // exceeds 30s. 'domcontentloaded' is enough — kicktipp renders server-side.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await dismissConsent(page);
  // Kicktipp redirects to /login when the session is invalid. Surface this
  // as an explicit error so callers don't silently get empty parse results.
  const finalUrl = page.url();
  if (/\/(login|profile\/login|profil\/login)(\?|$|\/)/i.test(finalUrl)) {
    throw new Error(`Kicktipp session is not authenticated (redirected to ${finalUrl}). Verify credentials.`);
  }
  const html = await page.content();
  // Some stale-session requests get a 200 "Seite wurde nicht gefunden" page
  // instead of a /login redirect — treat that as auth-lost too so the retry
  // wrapper can evict the cached browser and try a fresh login.
  if (/Seite\s+wurde\s+nicht\s+gefunden/i.test(html)) {
    throw new Error(`Kicktipp session is not authenticated (page not found at ${finalUrl}). Verify credentials.`);
  }
  return cheerio.load(html);
}

function parseMatchDate(dateStr: string): Date | null {
  const trimmed = dateStr.trim();
  const usMatch = trimmed.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i,
  );
  if (usMatch) {
    const [, m, d, y, h, min, ampm] = usMatch;
    let hour = parseInt(h);
    if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
    return new Date(2000 + parseInt(y), parseInt(m) - 1, parseInt(d), hour, parseInt(min));
  }
  const deMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})$/);
  if (deMatch) {
    const [, d, m, y, h, min] = deMatch;
    return new Date(2000 + parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(h), parseInt(min));
  }
  return null;
}

export async function resolveCommunity(page: Page): Promise<string> {
  const saved = loadCommunity();
  if (saved) return saved;
  const all = await getCommunities(page);
  if (!all.length) throw new Error('No communities found. Run `kicktipp set-community` first.');
  throw new Error(`No community set. Available: ${all.join(', ')}. Run \`kicktipp set-community\` first.`);
}

// ── Data types ─────────────────────────────────────────────────────

export interface TodayMatch {
  time: string;
  home: string;
  away: string;
  bet: string;
  odds: { home: string; draw: string; away: string };
  needsBet: boolean;
}

export interface BetMatch {
  date: string;
  home: string;
  away: string;
  bet: string;
  odds: { home: string; draw: string; away: string };
}

export interface ScheduleMatch {
  date: string;
  home: string;
  away: string;
  result: string;
}

export interface RankingEntry {
  position: string;
  name: string;
  matchdayPoints: string;
  bonus: string;
  total: string;
  isCurrentPlayer: boolean;
}

export interface BonusQuestionEntry {
  abbreviation: string;
  question: string;
  result: string;
}

export interface LeaderboardData {
  title: string;
  matches?: ScheduleMatch[];
  bonusQuestions?: BonusQuestionEntry[];
  rankings: RankingEntry[];
}

export interface OverviewPlayer {
  position: string;
  name: string;
  matchdays: Record<number, string>;
  bonus: string;
  wins: string;
  total: string;
  isCurrentPlayer: boolean;
}

export interface OverviewData {
  label: string;
  maxMatchday: number;
  players: OverviewPlayer[];
}

export interface TableTeam {
  position: string;
  team: string;
  played: string;
  points: string;
  goalsFor: string;
  goalsAgainst: string;
  goalDifference: string;
  wins: string;
  draws: string;
  losses: string;
}

export interface RulesSection {
  type: 'heading' | 'paragraph' | 'table';
  text?: string;
  headers?: string[];
  rows?: string[][];
}

export interface PlacedBet {
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
}

export interface BonusQuestionOption {
  value: string;
  text: string;
}

export interface BonusQuestion {
  question: string;
  selects: {
    name: string;
    options: BonusQuestionOption[];
    selected: string;
  }[];
}

export interface PlacedBonusBet {
  question: string;
  answer: string;
}

// ── Data functions ─────────────────────────────────────────────────

export async function fetchTodayMatches(page: Page, community: string): Promise<{ title: string; matches: TodayMatch[] }> {
  const $ = await loadPage(page, getPredictUrl(community));
  const content = $('#kicktipp-content');
  const title = content.find('div.pagetitle').text().trim();
  const tbody = content.find('tbody');
  if (!tbody.length) return { title, matches: [] };

  const now = new Date();
  const matches: TodayMatch[] = [];

  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 5) return;
    const dateText = $(cols[0]).text().trim();
    const matchDate = parseMatchDate(dateText);
    if (!matchDate || matchDate.getFullYear() !== now.getFullYear() ||
        matchDate.getMonth() !== now.getMonth() || matchDate.getDate() !== now.getDate()) return;

    const home = $(cols[1]).text().trim();
    const away = $(cols[2]).text().trim();
    const betTd = $(cols[3]);
    let bet: string;
    if (betTd.hasClass('nichttippbar')) {
      bet = betTd.text().trim() || '-';
    } else {
      const heimInput = betTd.find('input[id$="_heimTipp"]');
      const gastInput = betTd.find('input[id$="_gastTipp"]');
      if (heimInput.length && gastInput.length) {
        const h = heimInput.attr('value') || '';
        const g = gastInput.attr('value') || '';
        bet = h && g ? `${h}:${g}` : '';
      } else {
        bet = '-';
      }
    }

    const time = matchDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const [rateHome, rateDraw, rateAway] = parseOdds($, cols[4]);

    matches.push({
      time, home, away, bet,
      odds: { home: rateHome, draw: rateDraw, away: rateAway },
      needsBet: !bet,
    });
  });

  return { title, matches };
}

export async function fetchBets(page: Page, community: string, matchday?: number): Promise<{ title: string; matches: BetMatch[] }> {
  const $ = await loadPage(page, getPredictUrl(community, matchday));
  const content = $('#kicktipp-content');
  const title = content.find('div.pagetitle').text().trim();
  const tbody = content.find('tbody');
  if (!tbody.length) return { title, matches: [] };

  const matches: BetMatch[] = [];
  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 5) return;
    const date = $(cols[0]).text().trim();
    const home = $(cols[1]).text().trim();
    const away = $(cols[2]).text().trim();

    const betTd = $(cols[3]);
    let bet: string;
    if (betTd.hasClass('nichttippbar')) {
      bet = betTd.text().trim();
    } else {
      const heimInput = betTd.find('input[id$="_heimTipp"]');
      const gastInput = betTd.find('input[id$="_gastTipp"]');
      if (heimInput.length && gastInput.length) {
        const h = heimInput.attr('value') || '';
        const g = gastInput.attr('value') || '';
        bet = h && g ? `${h}:${g}` : '-';
      } else {
        bet = '-';
      }
    }

    const [rateHome, rateDraw, rateAway] = parseOdds($, cols[4]);
    matches.push({ date, home, away, bet, odds: { home: rateHome, draw: rateDraw, away: rateAway } });
  });

  return { title, matches };
}

export async function fetchSchedule(page: Page, community: string, matchday?: number): Promise<{ title: string; matches: ScheduleMatch[] }> {
  let url = `${URL_BASE}/${encodeURIComponent(community)}/spielplan`;
  if (matchday !== undefined) {
    if (matchday < 1 || matchday > 34) throw new RangeError(`Matchday '${matchday}' is not valid, use 1-34.`);
    url += `?spieltagIndex=${matchday}`;
  }
  const $ = await loadPage(page, url);
  const content = $('#kicktipp-content');
  const title = content.find('div.pagetitle').text().trim();
  const table = content.find('table#spiele');
  if (!table.length) return { title, matches: [] };
  const tbody = table.find('tbody');
  if (!tbody.length) return { title, matches: [] };

  const matches: ScheduleMatch[] = [];
  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 5) return;
    const date = $(cols[0]).text().trim();
    const home = $(cols[2]).text().trim();
    const away = $(cols[3]).text().trim();
    const resultSpan = $(cols[4]).find('span.kicktipp-ergebnis');
    let result: string;
    if (resultSpan.length) {
      const h = resultSpan.find('span.kicktipp-heim').text().trim();
      const g = resultSpan.find('span.kicktipp-gast').text().trim();
      result = `${h}:${g}`;
    } else {
      result = '-:-';
    }
    matches.push({ date, home, away, result });
  });

  return { title, matches };
}

export async function fetchLeaderboard(page: Page, community: string, matchday?: number, bonus = false): Promise<LeaderboardData> {
  const $ = await loadPage(page, getLeaderboardUrl(community, matchday, bonus));
  const content = $('#kicktipp-content');
  const title = content.find('div.pagetitle').text().trim();
  const savedPlayer = loadPlayer();

  // Matches (non-bonus only)
  let matches: ScheduleMatch[] | undefined;
  if (!bonus) {
    const matchesTable = content.find('table#spielplanSpiele');
    if (matchesTable.length) {
      matches = [];
      matchesTable.find('tbody tr').each((_, tr) => {
        const cols = $(tr).children('td');
        if (cols.length < 4) return;
        const date = $(cols[0]).text().trim();
        const home = $(cols[1]).text().trim();
        const away = $(cols[2]).text().trim();
        const resultSpan = $(cols[3]).find('span.kicktipp-ergebnis');
        let result = '-:-';
        if (resultSpan.length) {
          result = `${resultSpan.find('span.kicktipp-heim').text().trim()}:${resultSpan.find('span.kicktipp-gast').text().trim()}`;
        }
        matches!.push({ date, home, away, result });
      });
    }
  }

  // Bonus questions (bonus only)
  let bonusQuestions: BonusQuestionEntry[] | undefined;
  if (bonus) {
    const questionsTable = content.find('table.ktable').first();
    if (questionsTable.length) {
      bonusQuestions = [];
      questionsTable.find('tbody tr').each((_, tr) => {
        const cols = $(tr).children('td');
        if (cols.length < 4) return;
        const question = $(cols[1]).text().trim();
        const abbreviation = $(cols[2]).text().trim();
        const resultParts: string[] = [];
        $(cols[3]).find('table tr').each((__, subTr) => {
          const medium = $(subTr).find('div.visible-medium-block');
          if (medium.length) resultParts.push(medium.text().trim());
        });
        bonusQuestions!.push({ abbreviation, question, result: resultParts.join(', ') || '---' });
      });
    }
  }

  // Rankings
  const rankings: RankingEntry[] = [];
  content.find('table#ranking tbody tr').each((_, tr) => {
    const posTd = $(tr).find('td.position');
    const nameDiv = $(tr).find('div.mg_name');
    if (!posTd.length || !nameDiv.length) return;
    const name = nameDiv.text().trim();
    rankings.push({
      position: posTd.text().trim(),
      name,
      matchdayPoints: $(tr).find('td.spieltagspunkte').text().trim(),
      bonus: $(tr).find('td.bonus').text().trim(),
      total: $(tr).find('td.gesamtpunkte').text().trim(),
      isCurrentPlayer: !!savedPlayer && name === savedPlayer,
    });
  });

  return { title, matches, bonusQuestions, rankings };
}

const OVERVIEW_VIEWS: Record<string, [string, string]> = {
  'matchday-points': ['spieltagspunkte', 'Matchday points'],
  'standings': ['platzierungen', 'Standings'],
  'standings-diff': ['platzierungsdifferenz', 'Standings difference'],
  'matchday-standings': ['spieltagsplatzierungen', 'Matchday standings'],
  'points-from-leader': ['punkteZurSpitze', 'Points from leader'],
};

export const OVERVIEW_VIEW_OPTIONS = Object.keys(OVERVIEW_VIEWS);

export async function fetchOverview(page: Page, community: string, view = 'matchday-points'): Promise<OverviewData> {
  if (!(view in OVERVIEW_VIEWS)) {
    throw new Error(`Unknown view '${view}'. Options: ${OVERVIEW_VIEW_OPTIONS.join(', ')}`);
  }
  const [ansicht, label] = OVERVIEW_VIEWS[view];
  const $ = await loadPage(page, `${URL_BASE}/${encodeURIComponent(community)}/gesamtuebersicht?ansicht=${ansicht}`);
  const content = $('#kicktipp-content');
  const savedPlayer = loadPlayer();

  const ranking = content.find('table#ranking');
  if (!ranking.length) return { label, maxMatchday: 0, players: [] };
  const tbody = ranking.find('tbody');
  if (!tbody.length) return { label, maxMatchday: 0, players: [] };

  const players: OverviewPlayer[] = [];
  let maxMatchday = 0;

  tbody.find('tr').each((_, tr) => {
    const posTd = $(tr).find('td.position');
    const nameDiv = $(tr).find('div.mg_name');
    if (!posTd.length || !nameDiv.length) return;
    const name = nameDiv.text().trim();
    const matchdays: Record<number, string> = {};
    $(tr).find('td.spieltag').each((__, td) => {
      const classes = $(td).attr('class')?.split(/\s+/) || [];
      for (const cls of classes) {
        if (cls.startsWith('spieltag') && cls !== 'spieltag') {
          const idx = parseInt(cls.replace('spieltag', ''));
          const val = $(td).text().trim();
          if (val) { matchdays[idx] = val; if (idx > maxMatchday) maxMatchday = idx; }
        }
      }
    });
    players.push({
      position: posTd.text().trim(), name, matchdays,
      bonus: $(tr).find('td.bonus').text().trim(),
      wins: $(tr).find('td.siege').text().trim(),
      total: $(tr).find('td.punkte').text().trim(),
      isCurrentPlayer: !!savedPlayer && name === savedPlayer,
    });
  });

  return { label, maxMatchday, players };
}

export async function fetchTable(page: Page, community: string, option?: 'home' | 'away'): Promise<{ label: string; teams: TableTeam[] }> {
  let url = `${URL_BASE}/${encodeURIComponent(community)}/tabellen`;
  let label = 'League Table';
  if (option === 'home') { url += '?option=heim'; label = 'League Table (Home)'; }
  else if (option === 'away') { url += '?option=gast'; label = 'League Table (Away)'; }

  const $ = await loadPage(page, url);
  const content = $('#kicktipp-content');
  const table = content.find('table').first();
  if (!table.length) return { label, teams: [] };
  const tbody = table.find('tbody');
  if (!tbody.length) return { label, teams: [] };

  const teams: TableTeam[] = [];
  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 10) return;
    teams.push({
      position: $(cols[0]).text().trim(),
      team: $(cols[1]).text().trim(),
      played: $(cols[2]).text().trim(),
      points: $(cols[3]).text().trim(),
      goalsFor: $(cols[4]).text().trim(),
      goalsAgainst: $(cols[5]).text().trim(),
      goalDifference: $(cols[6]).text().trim(),
      wins: $(cols[7]).text().trim(),
      draws: $(cols[8]).text().trim(),
      losses: $(cols[9]).text().trim(),
    });
  });

  return { label, teams };
}

export async function fetchRules(page: Page, community: string): Promise<RulesSection[]> {
  const $ = await loadPage(page, `${URL_BASE}/${encodeURIComponent(community)}/spielregeln`);
  const pagecontent = $('#kicktipp-content div.pagecontent');
  if (!pagecontent.length) return [];

  const sections: RulesSection[] = [];
  pagecontent.contents().each((_, child) => {
    if (child.type !== 'tag') return;
    const el = $(child);
    const tagName = (child as any).tagName as string;

    if (tagName === 'h2') {
      sections.push({ type: 'heading', text: el.text().trim() });
    } else if (tagName === 'p') {
      sections.push({ type: 'paragraph', text: el.text().trim() });
    } else if (tagName === 'div') {
      const table = el.find('table');
      if (table.length) {
        const headers: string[] = [];
        table.find('thead th').each((__, th) => { headers.push($(th).text().trim()); });
        const rows: string[][] = [];
        table.find('tbody tr').each((__, tr) => {
          const row: string[] = [];
          $(tr).find('td').each((___, td) => { row.push($(td).text().trim()); });
          rows.push(row);
        });
        if (headers.length) sections.push({ type: 'table', headers, rows });
      } else {
        const classes = el.attr('class') || '';
        if (!classes.includes('level0') && el.find('p').length) {
          sections.push({ type: 'paragraph', text: el.text().trim() });
        }
      }
    }
  });

  return sections;
}

export async function fetchCommunities(page: Page): Promise<string[]> {
  return getCommunities(page);
}

export async function fetchPlayers(page: Page, community: string): Promise<string[]> {
  return getPlayers(page, community);
}

// ── Write operations ───────────────────────────────────────────────

export async function placeBets(page: Page, community: string, bets: string[], matchday?: number, submit = true): Promise<PlacedBet[]> {
  const $ = await loadPage(page, getPredictUrl(community, matchday));
  const tbody = $('#kicktipp-content tbody');
  if (!tbody.length) throw new Error('No matches found.');

  const editable: EditableMatch[] = [];
  tbody.find('tr').each((_, tr) => {
    const cols = $(tr).find('td');
    if (cols.length < 5) return;
    const betTd = $(cols[3]);
    if (betTd.hasClass('nichttippbar')) return;
    const heimInput = betTd.find('input[id$="_heimTipp"]');
    const gastInput = betTd.find('input[id$="_gastTipp"]');
    if (!heimInput.length || !gastInput.length) return;
    editable.push({
      home: $(cols[1]).text().trim(),
      away: $(cols[2]).text().trim(),
      heimName: heimInput.attr('name')!,
      gastName: gastInput.attr('name')!,
    });
  });

  if (!editable.length) throw new Error('No editable matches found.');

  const parsed: { entry: EditableMatch; h: number; g: number }[] = [];
  const seen = new Set<string>();
  for (const arg of bets) {
    const { home, away, h, g } = parseBetArg(arg);
    const key = `${home.toLowerCase()}|${away.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Duplicate fixture: "${home} vs ${away}"`);
    seen.add(key);
    const entry = matchFixture(home, away, editable);
    parsed.push({ entry, h, g });
  }

  const placed: PlacedBet[] = [];
  for (const { entry, h, g } of parsed) {
    const heimEl = await page.$(`input[name="${escapeCssValue(entry.heimName)}"]`);
    const gastEl = await page.$(`input[name="${escapeCssValue(entry.gastName)}"]`);
    if (heimEl) await heimEl.fill(String(h));
    if (gastEl) await gastEl.fill(String(g));
    placed.push({ home: entry.home, away: entry.away, homeGoals: h, awayGoals: g });
  }

  if (submit) {
    await Promise.all([
      page.waitForNavigation(),
      page.click('button[name="submitbutton"]'),
    ]);
  }

  return placed;
}

// ── Admin: Tipps nachtragen ───────────────────────────────────────
// Lets a Spielleiter (admin) set predictions for any member, including
// "dummy" members that have no login. URLs:
//   /<community>/spielleiter/mitgliederliste              — member list
//   /<community>/spielleiter/tippsnachtragen              — picker (no params)
//   /<community>/spielleiter/tippsnachtragen?tipperId=X&tippsaisonId=Y — edit page

export interface MemberEntry {
  name: string;
  tipperId: string;
  status?: string;
}

export async function fetchMembers(page: Page, community: string): Promise<MemberEntry[] | { _diagnostic: unknown }> {
  const $ = await loadPage(page, `${URL_BASE}/${encodeURIComponent(community)}/spielleiter/mitgliederliste`);
  const members = new Map<string, MemberEntry>();

  // Try several known patterns for member identification.
  const patterns: Array<{ selector: string; idRegex: RegExp }> = [
    { selector: 'a[href*="tipperId="]', idRegex: /tipperId=(\d+)/ },
    { selector: 'a[href*="tipper="]', idRegex: /tipper=(\d+)/ },
    { selector: 'a[href*="mitglied="]', idRegex: /mitglied=(\d+)/ },
    { selector: 'a[href*="/spielleiter/mitgliedsdaten"]', idRegex: /(\d{4,})/ },
    { selector: 'a[href*="tippsnachtragen"]', idRegex: /tipperId=(\d+)/ },
  ];
  for (const { selector, idRegex } of patterns) {
    $(selector).each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(idRegex);
      if (!m) return;
      const tipperId = m[1];
      const name = $(el).text().trim();
      if (!name) return;
      const rowText = $(el).closest('tr').text().trim();
      const status = /Dummy/i.test(rowText) ? 'Dummy' : /aktiv/i.test(rowText) ? 'active' : undefined;
      if (!members.has(tipperId)) members.set(tipperId, { name, tipperId, status });
    });
    if (members.size) return Array.from(members.values());
  }

  // Diagnostic dump so we can adjust the parser without redeploying blind.
  const allAnchors = $('a').toArray().slice(0, 25).map((el) => ({
    href: $(el).attr('href') || null,
    text: $(el).text().trim().slice(0, 60),
  }));
  const tableRows = $('table tbody tr').toArray().slice(0, 5).map((tr) => $(tr).html()?.slice(0, 500) || '');
  return {
    _diagnostic: {
      message: 'No members found by any known pattern. Paste this back so the parser can be adjusted.',
      pageTitle: $('title').text().trim(),
      contentH1: $('#kicktipp-content h1, .pagetitle').first().text().trim(),
      anchorSample: allAnchors,
      tableRowSamples: tableRows,
    },
  };
}

async function discoverSaisonId(page: Page, community: string): Promise<string> {
  const $ = await loadPage(page, `${URL_BASE}/${encodeURIComponent(community)}/spielleiter/tippsnachtragen`);
  // The picker page links/forms include tippsaisonId — grab the first.
  for (const el of $('a[href*="tippsaisonId="], form[action*="tippsaisonId="]').toArray()) {
    const attr = $(el).attr('href') || $(el).attr('action') || '';
    const m = attr.match(/tippsaisonId=(\d+)/);
    if (m) return m[1];
  }
  // Fallback: hidden input.
  const hidden = $('input[name="tippsaisonId"]').attr('value');
  if (hidden) return hidden;
  throw new Error('Could not discover tippsaisonId from admin tippsnachtragen page.');
}

export async function placeBetsForMember(
  page: Page,
  community: string,
  tipperId: string,
  bets: string[],
  matchday?: number,
  submit = true,
): Promise<PlacedBet[]> {
  const tippsaisonId = await discoverSaisonId(page, community);
  let url = `${URL_BASE}/${encodeURIComponent(community)}/spielleiter/tippsnachtragen?tipperId=${encodeURIComponent(tipperId)}&tippsaisonId=${encodeURIComponent(tippsaisonId)}`;
  if (matchday !== undefined) {
    if (matchday < 1 || matchday > 34) throw new RangeError(`Matchday '${matchday}' is not valid, use 1-34.`);
    url += `&spieltagIndex=${matchday}`;
  }
  const $ = await loadPage(page, url);
  const tbody = $('#kicktipp-content tbody');
  if (!tbody.length) throw new Error('No matches found on tippsnachtragen page.');

  const editable: EditableMatch[] = [];
  tbody.find('tr').each((_, tr) => {
    const cols = $(tr).find('td');
    if (cols.length < 4) return;
    // Layout: [date, home, away, score-inputs, ...]. Inputs may have
    // different id suffixes here; match by name pattern instead.
    const inputs = $(tr).find('input[type="text"], input:not([type])');
    if (inputs.length < 2) return;
    const heimName = inputs.eq(0).attr('name');
    const gastName = inputs.eq(1).attr('name');
    if (!heimName || !gastName) return;
    editable.push({
      home: $(cols[1]).text().trim(),
      away: $(cols[2]).text().trim(),
      heimName,
      gastName,
    });
  });

  if (!editable.length) throw new Error('No editable matches found on tippsnachtragen page.');

  const parsed: { entry: EditableMatch; h: number; g: number }[] = [];
  const seen = new Set<string>();
  for (const arg of bets) {
    const { home, away, h, g } = parseBetArg(arg);
    const key = `${home.toLowerCase()}|${away.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Duplicate fixture: "${home} vs ${away}"`);
    seen.add(key);
    parsed.push({ entry: matchFixture(home, away, editable), h, g });
  }

  const placed: PlacedBet[] = [];
  for (const { entry, h, g } of parsed) {
    const heimEl = await page.$(`input[name="${escapeCssValue(entry.heimName)}"]`);
    const gastEl = await page.$(`input[name="${escapeCssValue(entry.gastName)}"]`);
    if (heimEl) await heimEl.fill(String(h));
    if (gastEl) await gastEl.fill(String(g));
    placed.push({ home: entry.home, away: entry.away, homeGoals: h, awayGoals: g });
  }

  if (submit) {
    // Form button text is "Tipps speichern". Match by visible text since
    // name may differ from the regular tippabgabe form.
    const button =
      (await page.$('button:has-text("Tipps speichern")')) ||
      (await page.$('button[name="submitbutton"]')) ||
      (await page.$('input[type="submit"]'));
    if (!button) throw new Error('Submit button not found on tippsnachtragen page.');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      button.click(),
    ]);
  }

  return placed;
}

export async function fetchBonusQuestions(page: Page, community: string): Promise<BonusQuestion[]> {
  const $ = await loadPage(page, `${URL_BASE}/${encodeURIComponent(community)}/tippabgabe?bonus=true`);
  const content = $('#kicktipp-content');
  const table = content.find('table#tippabgabeFragen');
  if (!table.length) return [];
  const tbody = table.find('tbody');
  if (!tbody.length) return [];

  const questions: BonusQuestion[] = [];
  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 3) return;
    const question = $(cols[1]).text().trim();
    const selectEls = $(cols[2]).find('select');
    if (!selectEls.length) return;
    const selects: BonusQuestion['selects'][0][] = [];
    selectEls.each((__, sel) => {
      const name = $(sel).attr('name')!;
      const options: BonusQuestionOption[] = [];
      let selected = '-1';
      $(sel).find('option').each((___, opt) => {
        const value = $(opt).attr('value') || '';
        const text = $(opt).text().trim();
        if (value !== '-1') options.push({ value, text });
        if ($(opt).attr('selected') !== undefined) selected = value;
      });
      selects.push({ name, options, selected });
    });
    questions.push({ question, selects });
  });

  return questions;
}

export async function placeBonusBets(page: Page, community: string, bets: string[], submit = true): Promise<PlacedBonusBet[]> {
  const questions = await fetchBonusQuestions(page, community);
  if (!questions.length) throw new Error('No editable bonus questions found.');

  // Group by question
  const argsByQuestion = new Map<string, string[]>();
  for (const arg of bets) {
    const eqIdx = arg.lastIndexOf('=');
    if (eqIdx === -1) throw new Error(`Invalid bonus bet '${arg}'. Use format: "Question text=Answer"`);
    const question = arg.slice(0, eqIdx).trim();
    const answer = arg.slice(eqIdx + 1).trim();
    if (!question || !answer) throw new Error(`Invalid bonus bet '${arg}'. Both question and answer required.`);
    const key = question.toLowerCase();
    if (!argsByQuestion.has(key)) argsByQuestion.set(key, []);
    argsByQuestion.get(key)!.push(answer);
  }

  const placed: PlacedBonusBet[] = [];

  for (const [, answers] of argsByQuestion) {
    const q = questions.find((qq) => qq.question.toLowerCase() === answers[0].toLowerCase()) ??
      questions.find((qq) => {
        // Find by the original question text from args
        for (const arg of bets) {
          const eqIdx = arg.lastIndexOf('=');
          const qText = arg.slice(0, eqIdx).trim();
          if (qq.question.toLowerCase() === qText.toLowerCase()) return true;
        }
        return false;
      });

    if (!q) {
      const available = questions.map((qq) => qq.question).join(', ');
      throw new Error(`No bonus question found matching: "${answers[0]}". Available: ${available}`);
    }

    if (answers.length > q.selects.length) {
      throw new Error(`Too many answers for "${q.question}": got ${answers.length}, max ${q.selects.length}`);
    }

    for (let i = 0; i < answers.length; i++) {
      const option = q.selects[i].options.find((o) => o.text.toLowerCase() === answers[i].toLowerCase());
      if (!option) {
        const available = q.selects[i].options.map((o) => o.text).join(', ');
        throw new Error(`No option "${answers[i]}" for question "${q.question}". Available: ${available}`);
      }
      await page.selectOption(`select[name="${escapeCssValue(q.selects[i].name)}"]`, option.value);
      placed.push({ question: q.question, answer: option.text });
    }
  }

  if (submit) {
    await Promise.all([
      page.waitForNavigation(),
      page.click('button[name="submitbutton"]'),
    ]);
  }

  return placed;
}
