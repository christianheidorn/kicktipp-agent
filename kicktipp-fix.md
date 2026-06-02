# Fix: Allow placing bets before matchday is API-active

## Problem
The kicktipp MCP `place_bets()` tool fails with "No editable matches found" when trying to place bets before a matchday is API-active (i.e., when match inputs have CSS class `nichttippbar`).

### Root Cause
1. **`placeBets()` function** filters out matches with class `nichttippbar` - blocking bet placement before matchday activation
2. **`fetchBets()` and `fetchTodayMatches()`** use generic `tbody` selector instead of targeting specific table - causing them to miss or misparse matches

### Why This Matters
- ✅ Browser GUI allows placing bets **before** matchday is active (12+ hours before kickoff)
- ✅ CLI allows it (via direct Playwright navigation)
- ❌ MCP blocks it (filters by `nichttippbar` class)
- User expects consistent behavior across all three

## Solution

### Changes Made
1. **Remove `nichttippbar` filter** (line 502 in `src/core.ts`)
   - Allows `placeBets()` to fill input fields regardless of `nichttippbar` class
   - Aligns with CLI/browser behavior

2. **Specify correct table selector** in:
   - `fetchBets()` - Line 215: `content.find('table#tippabgabeSpiele tbody')`
   - `fetchTodayMatches()` - Line 166: `content.find('table#tippabgabeSpiele tbody')`
   - `placeBets()` - Line 502: `$('#kicktipp-content table#tippabgabeSpiele tbody')`

### Why This Works
- `table#tippabgabeSpiele` is the HTML ID of the match prediction table
- This prevents accidentally selecting other `<tbody>` elements (e.g., bonus questions table)
- Input fields exist and are editable even when marked with `nichttippbar` class

## Impact
- ✅ `get_bets()` now correctly returns matches even before matchday is active
- ✅ `place_bets()` now allows setting bets early (like browser GUI)
- ✅ Bonus questions remain unaffected (separate table)
- ✅ No breaking changes to API or existing behavior

## Testing
- Verified HTML structure of tippabgabe page
- Confirmed input fields exist in all match rows regardless of `nichttippbar` class
- Confirmed `table#tippabgabeSpiele` is unique identifier for match table
