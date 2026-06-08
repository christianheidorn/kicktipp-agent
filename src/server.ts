#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Browser, Page, BrowserContext } from 'playwright';
import { launchBrowser } from './browser.js';
import { saveCommunity, savePlayer, loadCommunity, loadPlayer, hasCredentials } from './config.js';
import { requestContext } from './request-context.js';
import { getSessionPage, invalidateSession, isAuthError } from './session-pool.js';
import {
  resolveCommunity,
  fetchTodayMatches,
  fetchBets,
  fetchSchedule,
  fetchLeaderboard,
  fetchOverview,
  fetchTable,
  fetchRules,
  fetchCommunities,
  fetchPlayers,
  fetchBonusQuestions,
  placeBets,
  placeBonusBets,
  OVERVIEW_VIEW_OPTIONS,
} from './core.js';

// ── Persistent browser session ─────────────────────────────────────

let browserInstance: Browser | null = null;
let pageInstance: Page | null = null;
let contextInstance: BrowserContext | null = null;

// Wraps a tool body so that if the kicktipp session has gone stale (cached
// browser context still holds an expired cookie), we evict and retry once
// before surfacing the error.
async function withFreshSession<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isAuthError(err)) throw err;
    const ctx = requestContext.getStore();
    if (ctx?.email) await invalidateSession(ctx.email);
    return await fn();
  }
}

async function getPage(): Promise<Page> {
  const ctx = requestContext.getStore();
  if (ctx?.email && ctx?.password) {
    return getSessionPage(ctx.email, ctx.password);
  }
  if (pageInstance) {
    try {
      await pageInstance.evaluate(() => true);
      return pageInstance;
    } catch {
      browserInstance = null;
      pageInstance = null;
      contextInstance = null;
    }
  }
  if (!hasCredentials()) {
    throw new Error('No credentials found. Set KICKTIPP_EMAIL and KICKTIPP_PASSWORD env vars in the MCP server config, or run `kicktipp set-community` in a terminal.');
  }
  const { browser, page, context } = await launchBrowser();
  browserInstance = browser;
  pageInstance = page;
  contextInstance = context;
  return page;
}

// ── MCP Server ─────────────────────────────────────────────────────

export function createServer(): McpServer {
const server = new McpServer(
  { name: 'kicktipp', version: '1.0.0' },
  { instructions: 'kicktipp.com football prediction game. IMPORTANT: Call get_status first to check if credentials and a community are configured. If credentials are missing, tell the user to either set KICKTIPP_EMAIL and KICKTIPP_PASSWORD env vars in the MCP server config, or run `kicktipp set-community` in a terminal. If only the community is missing, call get_communities then set_community.' },
);

// Wrap server.tool so every handler auto-retries once if the cached kicktipp
// session is stale (cookie expired between requests).
const tool: typeof server.tool = ((...args: unknown[]) => {
  const handler = args.pop() as (...a: unknown[]) => Promise<unknown>;
  const wrapped = (...handlerArgs: unknown[]) => withFreshSession(() => handler(...handlerArgs));
  return (server.tool as (...a: unknown[]) => unknown)(...args, wrapped);
}) as typeof server.tool;

tool(
  'get_status',
  'Check current configuration. Call this first to see if a community and player are set. Most tools require a community. Use set_community and set_player if not configured.',
  {},
  async () => {
    const credentials = hasCredentials();
    const community = loadCommunity();
    const player = loadPlayer();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          credentials_saved: credentials,
          community: community || null,
          player: player || null,
          setup_needed: !credentials || !community,
          setup_instructions: !credentials
            ? 'No credentials found. Set KICKTIPP_EMAIL and KICKTIPP_PASSWORD env vars in the MCP server config, or run `kicktipp set-community` in a terminal.'
            : !community
              ? 'No community set. Call get_communities then set_community.'
              : null,
        }, null, 2),
      }],
    };
  },
);

tool(
  'get_today_matches',
  "Get today's matches with bet status. Shows which games are happening today and whether bets have been placed.",
  {},
  async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchTodayMatches(page, community);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

tool(
  'get_bets',
  'Get all matches and your current bets for a matchday. Shows team names (use these exact names for place_bets), your placed bets, and odds.',
  { matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.') },
  async ({ matchday }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchBets(page, community, matchday);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

tool(
  'get_schedule',
  'Get the match schedule with results for a matchday.',
  { matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.') },
  async ({ matchday }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchSchedule(page, community, matchday);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

tool(
  'get_leaderboard',
  'Get player rankings for a matchday. Includes matches/results and ranking table with points.',
  {
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.'),
    bonus: z.boolean().optional().describe('Show bonus question rankings instead of match rankings.'),
  },
  async ({ matchday, bonus }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchLeaderboard(page, community, matchday, bonus);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

tool(
  'get_overview',
  'Get the season overview showing all players and their points across matchdays.',
  { view: z.enum(OVERVIEW_VIEW_OPTIONS as [string, ...string[]]).optional().describe('View type. Default: matchday-points.') },
  async ({ view }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchOverview(page, community, view);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

tool(
  'get_table',
  'Get the league table (standings of the actual football teams, not the prediction game).',
  { option: z.enum(['home', 'away']).optional().describe('Filter by home or away games only.') },
  async ({ option }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchTable(page, community, option);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

tool(
  'get_rules',
  'Get the game rules and scoring system.',
  {},
  async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchRules(page, community);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

tool(
  'get_communities',
  'List all kicktipp communities the user belongs to.',
  {},
  async () => {
    const page = await getPage();
    const data = await fetchCommunities(page);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

tool(
  'get_players',
  'List all players in the saved community.',
  {},
  async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchPlayers(page, community);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

tool(
  'set_community',
  'Set the active community. Use get_communities first to see available options, then pass the exact name.',
  { name: z.string().describe('Exact community name as returned by get_communities.') },
  async ({ name }) => {
    const page = await getPage();
    const communities = await fetchCommunities(page);
    if (!communities.includes(name)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Community "${name}" not found. Available: ${communities.join(', ')}` }, null, 2) }], isError: true };
    }
    saveCommunity(name);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, community: name }, null, 2) }] };
  },
);

tool(
  'set_player',
  'Set which player you are (for leaderboard highlighting). Use get_players first to see available names.',
  { name: z.string().describe('Exact player name as returned by get_players.') },
  async ({ name }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const players = await fetchPlayers(page, community);
    if (!players.includes(name)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Player "${name}" not found. Available: ${players.join(', ')}` }, null, 2) }], isError: true };
    }
    savePlayer(name);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, player: name }, null, 2) }] };
  },
);

tool(
  'get_bonus_questions',
  'Get available bonus questions with their options and current selections.',
  {},
  async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchBonusQuestions(page, community);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

tool(
  'place_bets',
  'Place match bets by fixture name. DESTRUCTIVE: submits real bets. Use dry_run=true to preview without submitting. Get exact team names from get_bets first. Format each bet as "Home vs Away=H:G" where H and G are goal counts.',
  {
    bets: z.array(z.string()).min(1).describe('Bets in format "Home vs Away=H:G", e.g. ["FC Bayern München vs Borussia Dortmund=2:1"]'),
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.'),
    dry_run: z.boolean().optional().describe('If true, validate and return what would be placed without submitting.'),
  },
  async ({ bets, matchday, dry_run }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const placed = await placeBets(page, community, bets, matchday, !dry_run);
    return { content: [{ type: 'text', text: JSON.stringify({ success: !dry_run, dry_run: !!dry_run, placed }, null, 2) }] };
  },
);

tool(
  'place_bonus_bets',
  'Place bonus question answers. DESTRUCTIVE: submits real bets. Use dry_run=true to preview without submitting. Get exact question text and options from get_bonus_questions first. Format each as "Question text=Answer".',
  {
    bets: z.array(z.string()).min(1).describe('Bonus bets in format "Question text=Answer", e.g. ["Who will be champion?=FC Bayern München"]'),
    dry_run: z.boolean().optional().describe('If true, validate and return what would be placed without submitting.'),
  },
  async ({ bets, dry_run }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const placed = await placeBonusBets(page, community, bets, !dry_run);
    return { content: [{ type: 'text', text: JSON.stringify({ success: !dry_run, dry_run: !!dry_run, placed }, null, 2) }] };
  },
);

return server;
}

// ── Start ──────────────────────────────────────────────────────────

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run stdio main when invoked directly (not when imported by http-server.ts).
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
    return entry === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
