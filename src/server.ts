#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Page, launchBrowser } from './browser.js';
import { AUTH_CONNECTION_DESCRIPTION, AUTH_VALUE_FORMAT } from './auth-description.js';
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
  fetchBonusQuestionsForMember,
  placeBets,
  placeBonusBets,
  placeBonusBetsForMember,
  fetchMembers,
  placeBetsForMember,
  OVERVIEW_VIEW_OPTIONS,
} from './core.js';

// ── Persistent Kicktipp session ────────────────────────────────────

let pageInstance: Page | null = null;

// Wraps a tool body so that if the kicktipp session has gone stale (cached
// cookie jar still holds an expired cookie), we evict and retry once
// before surfacing the error.
async function withFreshSession<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isAuthError(err)) throw err;
    const ctx = requestContext.getStore();
    if (ctx?.email) {
      await invalidateSession(ctx.email);
    } else if (pageInstance) {
      const stalePage = pageInstance;
      pageInstance = null;
      try {
        await stalePage.close();
      } catch {
        // Nothing else to clean up for the browserless page shim.
      }
    }
    return await fn();
  }
}

async function getPage(): Promise<Page> {
  const ctx = requestContext.getStore();
  if (ctx) {
    // Inside a request context (HTTP mode) credentials MUST come from the
    // request — never fall back to the operator's local config/env, or one
    // user's session could be served to another.
    if (!ctx.email || !ctx.password) {
      throw new Error('No credentials in request context.');
    }
    return getSessionPage(ctx.email, ctx.password);
  }
  if (pageInstance) {
    try {
      await pageInstance.evaluate(() => true);
      return pageInstance;
    } catch {
      pageInstance = null;
    }
  }
  if (!hasCredentials()) {
    throw new Error('No credentials found. Set KICKTIPP_EMAIL and KICKTIPP_PASSWORD env vars in the MCP server config, or run `kicktipp set-community` in a terminal.');
  }
  const { page } = await launchBrowser();
  pageInstance = page;
  return page;
}

// ── MCP Server ─────────────────────────────────────────────────────

const SERVER_INSTRUCTIONS = [
  'kicktipp football prediction game.',
  AUTH_CONNECTION_DESCRIPTION,
  'IMPORTANT: Call get_status first to check if credentials and a community are configured. If credentials are missing or invalid, the operator needs to provide them (env vars for stdio mode, Authorization header for HTTP mode). If only the community is missing, call get_communities then set_community.',
].join('\n\n');

export function createServer(): McpServer {
const server = new McpServer(
  { name: 'kicktipp', version: '1.0.0' },
  { instructions: SERVER_INSTRUCTIONS },
);

// Wrap server.tool so read-only handlers auto-retry once if the cached
// kicktipp session is stale (cookie expired between requests). Mutating
// tools (place_bets, place_bonus_bets) must NOT retry — the first attempt
// may have already submitted data server-side, and a retry would re-submit.
const tool: typeof server.tool = ((...args: unknown[]) => {
  const handler = args.pop() as (...a: unknown[]) => Promise<unknown>;
  const wrapped = (...handlerArgs: unknown[]) => withFreshSession(() => handler(...handlerArgs));
  return (server.tool as (...a: unknown[]) => unknown)(...args, wrapped);
}) as typeof server.tool;
const mutatingTool = server.tool.bind(server);

tool(
  'get_status',
  'Check current configuration. Call this first to see if a community and player are set. Most tools require a community. Use set_community and set_player if not configured.',
  {},
  async () => {
    const ctx = requestContext.getStore();
    const credentials = !!(ctx?.email && ctx?.password) || hasCredentials();
    const community = ctx?.community || loadCommunity();
    const player = ctx?.player || loadPlayer();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          credentials_saved: credentials,
          community: community || null,
          player: player || null,
          setup_needed: !credentials || !community,
          setup_instructions: !credentials
            ? `No credentials found. For hosted HTTP MCP, send an Authorization bearer value using ${AUTH_VALUE_FORMAT}. For stdio mode, set KICKTIPP_EMAIL and KICKTIPP_PASSWORD env vars in the MCP server config, or run \`kicktipp set-community\` in a terminal.`
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

mutatingTool(
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

mutatingTool(
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

mutatingTool(
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
  'list_members',
  'ADMIN ONLY: List all members of the community with their tipperId and status (Dummy/active). Use this to find a member by name and look up their tipperId for place_bets_for_member or place_bonus_bets_for_member. Requires the logged-in user to be a Spielleiter (admin) of the community.',
  {},
  async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchMembers(page, community);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

tool(
  'get_bonus_questions_for_member',
  'ADMIN ONLY: Get available bonus questions with options and current selections for another member via Tipps nachtragen. Use list_members to find the tipperId or pass the exact member name.',
  {
    tipperId: z.string().describe('Numeric tipperId OR member name (resolved via list_members). E.g. "12345678" or "player-name".'),
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday (1-34). Omit for current/default bonus page.'),
  },
  async ({ tipperId, matchday }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchBonusQuestionsForMember(page, community, tipperId, matchday);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

mutatingTool(
  'place_bets_for_member',
  'ADMIN ONLY: Place bets on behalf of another member (e.g. a Dummy member with no login). DESTRUCTIVE: submits real bets. Use list_members to find the tipperId. Get team names from get_bets first. Format each bet as "Home vs Away=H:G". Requires Spielleiter (admin) rights.',
  {
    tipperId: z.string().describe('Numeric tipperId OR member name (resolved via list_members). E.g. "12345678" or "player-name".'),
    bets: z.array(z.string()).min(1).describe('Bets in format "Home vs Away=H:G".'),
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday (1-34). Omit for current.'),
    dry_run: z.boolean().optional().describe('If true, validate and return what would be placed without submitting.'),
  },
  async ({ tipperId, bets, matchday, dry_run }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const placed = await placeBetsForMember(page, community, tipperId, bets, matchday, !dry_run);
    return { content: [{ type: 'text', text: JSON.stringify({ success: !dry_run, dry_run: !!dry_run, tipperId, placed }, null, 2) }] };
  },
);

mutatingTool(
  'place_bonus_bets_for_member',
  'ADMIN ONLY: Place bonus question answers on behalf of another member via Tipps nachtragen. DESTRUCTIVE: submits real bonus bets. Use dry_run=true to preview without submitting. Use get_bonus_questions_for_member for exact question text and options. Format each as "Question text=Answer".',
  {
    tipperId: z.string().describe('Numeric tipperId OR member name (resolved via list_members). E.g. "12345678" or "player-name".'),
    bets: z.array(z.string()).min(1).describe('Bonus bets in format "Question text=Answer". Repeat the same question for multi-select slots, e.g. ["Wer erreicht das Halbfinale?=Deutschland", "Wer erreicht das Halbfinale?=Brasilien"].'),
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday (1-34). Omit for current/default bonus page.'),
    dry_run: z.boolean().optional().describe('If true, validate and return what would be placed without submitting.'),
  },
  async ({ tipperId, bets, matchday, dry_run }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const placed = await placeBonusBetsForMember(page, community, tipperId, bets, matchday, !dry_run);
    return { content: [{ type: 'text', text: JSON.stringify({ success: !dry_run, dry_run: !!dry_run, tipperId, placed }, null, 2) }] };
  },
);

mutatingTool(
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
