# kicktipp-agent

A CLI and MCP server for [kicktipp.com](https://www.kicktipp.com) — the German football prediction game. View leaderboards, schedules, league tables, and place bets from the terminal or let an AI agent do it for you.

## Why?

Kicktipp has no public API. Everything goes through the website's server-rendered HTML pages and forms. This project gives you two ways to skip the browser:

- **CLI** — Check scores, standings, and place bets in seconds from the terminal. No clicking through pages, no waiting for ads to load. Useful for quick lookups during matchday or scripting your predictions.

- **MCP Server** — Connect an AI assistant (Claude Desktop, Claude Code, or any MCP client) to your kicktipp account. Ask it to show today's matches, check who's leading your league, or place bets for you — all through natural conversation. The assistant sees your community's data but never your password.

Plain HTTP requests with cookie-session caching keep things fast. No Chrome, Chromium, or Playwright install is required.

## Installation

```bash
npm install
npm run build
npm link
```

This gives you two commands:

- **`kicktipp`** — the CLI
- **`kicktipp-mcp`** — the MCP server

## CLI

### First-time setup

On first run, the CLI prompts for your kicktipp.com email and password. Credentials are stored locally in `~/.config/kicktipp-agent/config.ini` (chmod 600).

```console
$ kicktipp set-community
No credentials found. Please enter your kicktipp.com login:
Email: you@example.com
Password: ********
Credentials saved to ~/.config/kicktipp-agent/config.ini

Available communities:
  [1] testspiel
  [2] bundesliga-tipps
Select community (1-2): 1
Saved 'testspiel' as default community.
```

Optionally set your player name so the leaderboard highlights your position:

```console
$ kicktipp set-player
```

### Commands

| Command | Description |
|---------|-------------|
| `communities` | List all communities you belong to |
| `set-community` | Select a default community |
| `players` | List players in the saved community |
| `set-player` | Select which player you are |
| `leaderboard` | Show the matchday leaderboard |
| `overview` | Show the season overview |
| `schedule` | Show the match schedule |
| `table` | Show the league table |
| `bets` | Show your bets for a matchday |
| `bet` | Place bets (interactive, by fixture, or bonus) |
| `today` | Show today's matches and which still need bets |
| `rules` | Show the game rules |
| `guide` | Print a detailed usage guide (useful for LLM agents) |
| `logout` | Remove stored credentials and session |

### Placing bets

```bash
# Interactive — prompts for each match
kicktipp bet

# By fixture name (get exact names from `kicktipp bets`)
kicktipp bet "FC Bayern München vs Borussia Dortmund=2:1"
kicktipp bet "RB Leipzig vs Bayer 04 Leverkusen=0:0" --matchday 5

# Bonus questions — interactive
kicktipp bet --bonus

# Bonus questions — by name
kicktipp bet --bonus "Who will win the league?=FC Bayern München"
```

### Options

- `--matchday <n>` — Target a specific matchday (1-34)
- `--bonus` — Bonus question rankings (with `leaderboard`) or bonus bets (with `bet`)
- `--view <value>` — Overview type (with `overview`)
- `--home` / `--away` — Home/away filter (with `table`)

## MCP Server

The MCP server exposes the same functionality as the CLI through the [Model Context Protocol](https://modelcontextprotocol.io), allowing AI assistants like Claude to interact with kicktipp.com on your behalf.

### Available tools

| Tool | Description |
|------|-------------|
| `get_status` | Check if credentials and community are configured |
| `get_today_matches` | Today's matches with bet status |
| `get_bets` | Matches and current bets for a matchday |
| `get_schedule` | Match schedule with results |
| `get_leaderboard` | Player rankings for a matchday |
| `get_overview` | Season overview across all matchdays |
| `get_table` | League table (actual football standings) |
| `get_rules` | Game rules and scoring system |
| `get_communities` | List communities the user belongs to |
| `get_players` | List players in the community |
| `get_bonus_questions` | Bonus questions with options |
| `get_bonus_questions_for_member` | Admin-only bonus questions/options for a member |
| `set_community` | Set the active community |
| `set_player` | Set which player you are |
| `place_bets` | Place match bets by fixture name |
| `place_bonus_bets` | Place bonus question answers |
| `list_members` | Admin-only member list with tipper IDs |
| `place_bets_for_member` | Admin-only bets on behalf of another member |
| `place_bonus_bets_for_member` | Admin-only bonus question answers on behalf of another member |

### Setup with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kicktipp": {
      "command": "kicktipp-mcp",
      "env": {
        "KICKTIPP_EMAIL": "you@example.com",
        "KICKTIPP_PASSWORD": "yourpassword"
      }
    }
  }
}
```

The `env` block passes credentials directly to the server process — Claude never sees them. If you prefer, you can omit `env` and set credentials via the CLI instead (`kicktipp set-community`).

After restarting Claude Desktop, the agent will have access to all kicktipp tools. It will call `get_status` first to check configuration, then prompt you to set a community if needed.

### Setup with Claude Code

Add to `.mcp.json` in your home directory or project:

```json
{
  "mcpServers": {
    "kicktipp": {
      "command": "kicktipp-mcp",
      "env": {
        "KICKTIPP_EMAIL": "you@example.com",
        "KICKTIPP_PASSWORD": "yourpassword"
      }
    }
  }
}
```

### Credentials

Hosted HTTP MCP clients authenticate with a single bearer auth value. Paste the
auth value into your MCP client connection settings, or send it as the
`Authorization` bearer token:

```text
<community>,<player>,<email>,<password>
```

Example:

```text
bundesliga-tipps,player-name,player@example.com,example-password
```

For local stdio MCP setups, the server also accepts credentials in two ways
(checked in this order):

1. **Environment variables** — `KICKTIPP_EMAIL` and `KICKTIPP_PASSWORD` passed via the `env` block in your MCP client config
2. **Config file** — `~/.config/kicktipp-agent/config.ini`, shared with the CLI

If neither is found, the server returns an error guiding the agent to inform you.

### Base URL

By default the client uses `https://www.kicktipp.de` and German page routes. You can set
`KICKTIPP_BASE_URL=https://www.kicktipp.com` to prefer Kicktipp's English routes
(`predict`, `leaderboard`, `schedule`, `tables`, `rules`). If Kicktipp redirects to
a route that is unavailable for a community, the browserless client retries the known
German/English aliases across both `.com` and `.de`.

### HTTP Deployment

The `kicktipp-mcp-http` binary starts a stateless HTTP MCP server on `/mcp` and
exposes `/health` for deployment checks. A `Dockerfile` and `fly.toml.example`
are included for container-based deployments.

To deploy on Fly.io, copy the example config and set your own app name:

```bash
cp fly.toml.example fly.toml
fly launch --copy-config
fly deploy
```

## Development

```bash
npm test          # run tests
npm run build     # compile TypeScript
```

## Credits

Originally forked from [schwalle/kicktipp-betbot](https://github.com/schwalle/kicktipp-betbot) by Stefan. The project has since been fully rewritten in TypeScript with a new CLI interface, MCP server, and Cheerio-based parsing.
