import { Command } from 'commander';

function getGuideText(): string {
  return `# kicktipp CLI — Agent Guide

kicktipp is a CLI for kicktipp.com, a football prediction game.
Players bet on match scores each matchday (1-34 per season). Points are
awarded based on accuracy. Bonus questions (e.g. "Who will win the league?")
are answered once before the season starts.

## Prerequisites

A community must be set before most commands work. On first run the CLI
prompts for kicktipp.com credentials (stored in ~/.config/kicktipp-agent/).

  kicktipp set-community          # interactive picker (prompts for number)
  kicktipp set-player             # interactive — identifies you in leaderboards

These are interactive commands that require stdin. Run them once during setup.

## Non-interactive commands (safe for automation)

### Gathering information

  kicktipp today                  # matches happening today + bet status
  kicktipp bets                   # all bets for current matchday
  kicktipp bets --matchday 5      # bets for specific matchday
  kicktipp schedule               # full match schedule for current matchday
  kicktipp schedule --matchday 5  # schedule for specific matchday
  kicktipp leaderboard            # player rankings for current matchday
  kicktipp leaderboard --matchday 5
  kicktipp leaderboard --bonus    # bonus question rankings
  kicktipp overview               # season overview (matchday points)
  kicktipp overview --view standings
  kicktipp overview --view standings-diff
  kicktipp overview --view matchday-standings
  kicktipp overview --view points-from-leader
  kicktipp table                  # league table
  kicktipp table --home           # home-only table
  kicktipp table --away           # away-only table
  kicktipp rules                  # game rules and scoring system
  kicktipp communities            # list all communities user belongs to
  kicktipp players                # list players in saved community

### Placing bets by fixture name

  kicktipp bet "Home vs Away=H:G"

  Team names must match exactly (case-insensitive) as shown by \`kicktipp bets\`.
  Multiple bets can be passed as separate arguments:

  kicktipp bet "FC Bayern München vs Borussia Dortmund=2:1" "RB Leipzig vs Bayer 04 Leverkusen=0:0"

  Use --matchday N to target a specific matchday:

  kicktipp bet --matchday 5 "Team A vs Team B=1:0"

### Placing bonus bets

  kicktipp bet --bonus "Question text=Answer"

  Question and answer must match exactly (case-insensitive) as shown on the
  bonus page. Multiple answers for the same question (multi-select):

  kicktipp bet --bonus "Who will be champion?=FC Bayern München" "Who will be champion?=Borussia Dortmund"

## Interactive commands (require stdin)

  kicktipp bet                    # prompts per match: enter "2:1" or skip
  kicktipp bet --bonus            # prompts per bonus question with numbered options
  kicktipp set-community          # pick community from numbered list
  kicktipp set-player             # pick player from numbered list

## Common workflows

### "Place bets for today's games"
  1. kicktipp today               # see which games need bets
  2. kicktipp bet "Team A vs Team B=2:1" "Team C vs Team D=1:1"

### "Check how I'm doing"
  kicktipp leaderboard            # current matchday rankings
  kicktipp overview               # full season at a glance

### "See what bets I've placed"
  kicktipp bets                   # shows all matches with your bets and odds

### "Get the exact team names for placing bets"
  kicktipp bets                   # team names shown here are the exact strings
                                  # to use in "Home vs Away=H:G" format

## Output format

All commands print plain text to stdout. Errors go to stderr.
Exit code 0 on success, 1 on error.

## Notes

- Commands use browserless HTTP requests; startup is mostly login/session latency.
- Session cookies are cached; re-login happens automatically if expired.
- The --matchday option accepts 1-34 (one Bundesliga season).
- Bet format is always H:G (home goals colon away goals).
- Fixture format is always "Home vs Away=H:G" (with " vs " separator).
- Bonus format is always "Question text=Answer" (last = sign splits them).
`;
}

export function registerGuideCommand(program: Command): void {
  program
    .command('guide')
    .description('Print a detailed usage guide (useful for LLM agents)')
    .action(() => {
      console.log(getGuideText());
    });
}
