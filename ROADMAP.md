# VΞSPER Roadmap — Feature Gap Notes (2026-08-17, updated after ESI verification)

Captured from a gap analysis against ESI's full endpoint surface and major
third-party tools (Fuzzwork, Adam4EVE, RavWorks, EVE Workbench, DOTLAN,
zKillboard). Each entry below is a confirmed gap plus the build direction
Barry decided on. The full implementation plan (backend/frontend detail
per feature) lives at `C:\Users\barry\.claude\plans\steady-scribbling-valley.md`.

Custom sidebar icons live in `src/assets/sidebar-icons/` (128x128,
resized down from the 1254x1254 originals in `Assets/Sidebar Icons/` at
the project root) for the four that kept a dedicated page: `industry.png`,
`fittings-fleets.png`, `wars.png`, `calendar.png`.

## 0. Live Intel Feed (local chat-log parsing)

**Gap:** Intel Check (`IntelCheck.tsx`) only works off manual copy-paste
from an intel channel — no live, automatic feed the way RIFT (a Kotlin/
Compose third-party tool, see `gamelogs`/`logs/parse` modules at
https://gitlab.com/rift-intel-fusion-tool/rift-intel-fusion-tool) has.
RIFT's approach: read EVE's own local plaintext chat logs
(`Documents/EVE/logs/ChatLogs/`) — the standard, fully-sanctioned
third-party data source for this, not screen-scraping or memory reading.

**Direction (bumped to top priority 2026-08-17 — Barry: "the other bits
arnt massively important right now"):**
1. Backend: a Rust log-watcher module (`notify` crate — new dependency)
   that tails `Documents/EVE/logs/ChatLogs/`, picks up new per-session log
   files as EVE rotates them, and parses EVE's chat-log line format
   (`[ 2024.01.15 20:15:32 ] CharacterName > message`, UTF-16 encoded).
   Needs a channel-picker (user tells the app which channel(s) are intel
   channels — no way to infer this automatically). Feeds spotted character
   names through the existing `check_intel` pipeline.
2. Frontend: a second tab on the existing Intel Check page ("Paste" vs
   "Live") — RIFT-style grouped-by-system cards (portraits + ship icons
   inline, hostile-count chips, distance-to-gate, kill entries blended in
   from zKillboard) as the visual reference.
3. Once proven there, wire the same live data into the Map's existing
   proximity system (`ProximityFlashOverlay`, location tracking) so
   locally-spotted hostiles flash the same way nearby real kills already
   do — mostly plumbing once step 2's data source exists, not new logic.

## 1. Industry

**Gap:** We read Planetary Interaction and the basic industry job list
already in the Character tabs, but nothing on blueprint ME/TE, build-cost
calculation, or job planning — the whole niche Fuzzwork and Adam4EVE cover.

**Direction:** Build our own Industry page, modeled on how Fuzzwork,
Adam4EVE, and RavWorks approach it. First pass is a build-cost calculator
(blueprint materials/products synced from Fuzzwork CSVs, live market
prices, public system cost indices) - no character auth needed. ME/TE-
aware costing off a character's *own* blueprints is a later stretch goal
(needs a new `esi-characters.read_blueprints.v1` scope).

- Reference sites: https://www.fuzzwork.co.uk/, https://www.adam4eve.eu/,
  https://ravworks.com/
- No links found yet for EVE IPH or EVE Forge.

## 2. Fittings & Fleets

**Gap:** No in-app fit builder, no saved fits, no fleet composition
tooling.

**Direction:** Fittings = a real fit builder with fits synced to/from
ESI (`esi-fittings.read_fittings.v1` + `.write_fittings.v1` - new
scopes). Fleets = confirmed ESI only exposes a fleet you're *currently*
in-game in (no offline planning concept exists in the API), so "Fleets"
became a live viewer of your current in-game fleet
(`esi-fleets.read_fleet.v1` - new scope), not a composition planner.

## 3. Contracts

**Gap:** No contract browser/search across the market the way
courier-contract-focused tools do — we only show a character's own
contracts today.

**Direction:** Extend the existing Contracts tab (item lists for
item_exchange contracts) and add a new "Browse Contracts" tab in Wallet &
Market backed by ESI's public `/contracts/public/{region_id}/` endpoint
(confirmed live, real courier/item_exchange data, no auth needed).

## 4. Wars

**Gap:** We show a corp's `war_eligible` flag on the Corporation
Killboard header, but no actual active-war state anywhere.

**Direction:** Dedicated new page (custom-designed icon) — cross-linked
rather than living in isolation:
- A tab on the **Map** screen to select and show active wars.
- A button on **Kills & Intel** linking through to the same Wars page.

Confirmed live: ESI has no corp/alliance→wars lookup at all - `/wars/`
only returns descending war IDs with no filter param. Design is a bounded
local sync (recent ~10k war IDs) refreshed periodically, then filtered
client-side for a given corp/alliance - an honestly-labeled best-effort
("might miss a years-old still-open war"), not a complete historical
index.

## 5. Calendar

**Gap:** No in-game event/fleet-op calendar view anywhere in the app.

**Direction:** New standalone page. Needs a new scope
(`esi-calendar.read_calendar_events.v1`).

## 6. Insurance

**Gap:** We show insurance levels on a kill's detail page, nothing beyond
that single-kill context.

**Direction:** Confirmed live that ESI has **no endpoint anywhere** for a
character's actual active insurance policies - only the public
`/insurance/prices/` cost/payout table per ship type, no ownership data
at all. Reframed as a **cost/payout calculator** ("what would insuring
this ship cost"), not a policy tracker - added as a tab on both Character
Detail and Wallet & Market, clearly labeled as a calculator.

## 7. Opportunities — dropped

Confirmed live (full OpenAPI spec grep) that CCP removed the entire
Opportunities/career-agent API - every guessed endpoint 404s, zero
matching paths exist. Sidebar item removed entirely rather than kept as a
placeholder; icon file deleted.

## Build order (decided 2026-08-17, re-prioritized same day)

1. Remove Opportunities (done)
2. Wars (done)
3. Contracts (done)
4. Live Intel Feed (local chat-log parsing) — bumped to top priority (done)
5. Insurance calculator (done)
6. Calendar (done)
7. Fittings & Fleets
8. Industry

Reasoning for the original 1-7 order: smallest/most self-contained
first, saving the two features that need a brand-new local SDE-style
sync (Industry's blueprint data, Fittings' dogma/slot data) for last.
Live Intel Feed was re-prioritized ahead of Insurance/Calendar/Fittings/
Industry per Barry's direct call — those four are lower-value right now
compared to a live automatic intel feed.
