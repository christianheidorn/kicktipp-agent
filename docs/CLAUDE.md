# CLAUDE.md

## Project Overview

**kicktipp-agent** is a TypeScript CLI and MCP server for [kicktipp.de](https://www.kicktipp.de) — a German football prediction game platform. It uses plain HTTP requests plus cookie sessions, Cheerio for HTML parsing/form serialization, Commander.js for CLI argument parsing, and the MCP SDK to expose tools to AI assistants. The tool can view leaderboards, schedules, league tables, and manage bets (manual and bonus).

## File Inventory

```
src/
  index.ts                    # CLI entry point + Commander setup + simple commands
  server.ts                   # MCP server entry point (kicktipp-mcp binary)
  core.ts                     # Shared business logic used by both CLI and MCP server
  shared.ts                   # Shared CLI helpers (ask, ensureCommunity)
  config.ts                   # Credential/community/player storage (~/.config/kicktipp-agent/)
  browser.ts                  # HTTP session management, login, form submission, HTML parsing
  url.ts                      # URL constants and builders
  helpers/
    parse-bet-arg.ts          # parseBetArg + matchFixture
    spinner.ts                # Terminal spinner (ora wrapper)
  commands/
    leaderboard.ts            # leaderboard command (--matchday, --bonus)
    overview.ts               # overview command (--view)
    schedule.ts               # schedule command (--matchday)
    table.ts                  # table command (--home, --away)
    bets.ts                   # bets command (--matchday)
    rules.ts                  # rules command
    bet.ts                    # unified bet command (interactive, fixture, bonus)
    today.ts                  # today command (today's matches + bet status)
    guide.ts                  # guide command (detailed usage for LLM agents)
tests/
  parse-bet-arg.test.ts       # parseBetArg + matchFixture tests
  url.test.ts                 # URL builder tests
package.json
tsconfig.json
```

## Commands

```bash
# Install
npm install

# Build
npm run build

# Run tests
npm test

# CLI usage (after npm link)
kicktipp --help
kicktipp communities
kicktipp set-community
kicktipp players
kicktipp set-player
kicktipp leaderboard [--matchday N] [--bonus]
kicktipp overview [--view matchday-points|standings|standings-diff|matchday-standings|points-from-leader]
kicktipp schedule [--matchday N]
kicktipp table [--home|--away]
kicktipp bets [--matchday N]
kicktipp bet [--matchday N]
kicktipp bet "Home vs Away=2:1" [--matchday N]
kicktipp bet --bonus ["Question=Answer"]
kicktipp today
kicktipp guide
kicktipp rules
kicktipp logout
```

## Architecture

### Entry Points

- **`src/index.ts`** — CLI. Commander.js program with subcommands. Simple commands (logout, communities, set-community, players, set-player) are defined inline. View and bet commands are registered via import from `src/commands/`.
- **`src/server.ts`** — MCP server. Exposes the same functionality as the CLI through the Model Context Protocol. Uses a persistent Kicktipp HTTP session shared across tool calls.
- **`src/core.ts`** — Shared business logic (fetching data, placing bets) used by both entry points. All functions take the local HTTP-backed `Page` shim and community name, return structured data.

### Credential & Config Storage: `src/config.ts`

- **Dir:** `~/.config/kicktipp-agent/`
- **Config:** `config.ini` (ini format, chmod 600)
  - `[auth]` section: `email`, `password`
  - `[community]` section: `name` (saved default community)
  - `[player]` section: `name` (saved player identity for leaderboard marker)
- **Session:** `session.json` (Kicktipp cookie jar for session persistence)

### HTTP Session: `src/browser.ts`

- Uses `fetch` with a first-party Kicktipp cookie jar
- Keeps a page-like subset (`goto`, `content`, `$`, `fill`, `selectOption`, `click`) so existing parsing code stays small
- `dismissConsent(page)` — compatibility no-op; the HTTP client never loads the CMP iframe
- `login()` — posts the `kennung` + `passwort` form directly
- Session cached to `SESSION_FILE` after successful login; restored on next run

### HTML Parsing (Cheerio)

All page parsing follows: `page.goto(url)` → `cheerio.load(await page.content())` → find `#kicktipp-content` → parse tables.

**Key CSS selectors:**
- Content wrapper: `#kicktipp-content`
- Page title: `div.pagetitle`
- Bet form inputs: `input[id$='_heimTipp']`, `input[id$='_gastTipp']`
- Submit button: `button[name="submitbutton"]`
- Non-editable bets: `td.nichttippbar`
- Odds: `span.quote-heim span.quote-text`, `span.quote-remis span.quote-text`, `span.quote-gast span.quote-text`
- Rankings table: `table#ranking`
- Schedule table: `table#spiele`
- Player names: `div.mg_name`
- Match result: `span.kicktipp-ergebnis > span.kicktipp-heim` / `span.kicktipp-gast`
- Bonus questions table: `table#tippabgabeFragen`

### URL Structure: `src/url.ts`

```
Base:          https://www.kicktipp.de by default, or KICKTIPP_BASE_URL=https://www.kicktipp.com
Login:         /info/profil/login              | /info/profile/login
Communities:   /info/profil/meinetipprunden    | /info/profile/prediction-games
Predict:       /{community}/tippabgabe         | /{community}/predict
Predict bonus: /{community}/tippabgabe?bonus=true | /{community}/predict?bonus=true
Leaderboard:   /{community}/tippuebersicht     | /{community}/leaderboard
Overview:      /{community}/gesamtuebersicht   | /{community}/overview
Schedule:      /{community}/tippspielplan      | /{community}/schedule
Tables:        /{community}/tabellen           | /{community}/tables
Rules:         /{community}/spielregeln        | /{community}/rules
Admin:         /{community}/spielleiter/mitgliederliste, /{community}/spielleiter/tippsnachtragen
```

The HTTP client retries known German/English aliases across `.com` and `.de` when
Kicktipp redirects to a missing page, which is common for tournament communities.

### Bet Argument Parsing: `src/helpers/parse-bet-arg.ts`

- `parseBetArg("Home vs Away=H:G")` — splits on last `=`, then on ` vs `, returns `{home, away, h, g}`. Throws on invalid format.
- `matchFixture(home, away, editable)` — case-insensitive exact match. Throws if not found.

## Key Details

- Site: `https://www.kicktipp.de` by default; `https://www.kicktipp.com` via `KICKTIPP_BASE_URL`
- TypeScript with ES2022 target, Node16 module resolution
- Matchday range: 1-34 (Bundesliga season)
- Login form: `input[name="kennung"]`, `input[name="passwort"]`
- Config shared at `~/.config/kicktipp-agent/config.ini`
