# VESPER — ESI Endpoint Audit

Generated 2026-08-19. Source: live `https://esi.evetech.net/meta/openapi.json`
(`swagger.json` at the old path 404s), OpenAPI 3.1.0, "tranquility 2020-01-01",
197 total path+method operations across 29 tags. Cross-checked against
`src-tauri/src/esi.rs`, `map.rs`, `market.rs`, `kills.rs`, `route.rs`, `pi.rs`,
`wars.rs`, `wormholes.rs` and `src/lib/scopes.ts`.

**Confirmed live: the `Opportunities` tag has zero endpoints in the current
spec** — fully removed by CCP, not just deprecated.

- Total live ESI endpoints: **197**
- Already called by VESPER: **57**
- Not currently called: **140**
- Detailed below with a concrete VESPER idea: **51**
- Explicitly skipped as corp-admin/low-value noise: **89** (see final section)

For each entry: **scope status** means —
- `public` — no auth needed
- `granted` — the scope is already in `DASHBOARD_SCOPES`, every connected
  character already has it, no reconnect needed to start using this endpoint
- `reconnect` — new scope, every character would need to log in again to grant it

---

## Alliance

### `GET /alliances/{alliance_id}/icons` — public
Returns the icon image URLs for an alliance (64/128px), same shape as the
corporation icon endpoint below. **Idea:** real alliance logos on the Kills &
Intel alliance profile page and next to entries in the Wars list, instead of
name-only rows.

## Assets

### `POST /characters/{character_id}/assets/locations` — granted (`esi-assets.read_assets.v1`)
### `POST /characters/{character_id}/assets/names` — granted (`esi-assets.read_assets.v1`)
Bulk-resolve a batch of asset `item_id`s (from the assets list VESPER already
fetches) to exact in-space/station coordinates and to any custom name the
player gave that item (containers, ships). **Idea:** Assets tab enrichment —
show "Loot Can 3" or a renamed Orca's actual name instead of just its type,
and exact position for anything sitting in space rather than a hangar.

## Calendar

### `PUT /characters/{character_id}/calendar/{event_id}` — reconnect (`esi-calendar.respond_calendar_events.v1`)
Sets the character's response (accepted/declined/tentative) to a calendar
event. **Idea:** the Calendar screen is currently read-only — add
Accept/Decline/Tentative buttons directly on each listed event.

### `GET /characters/{character_id}/calendar/{event_id}/attendees` — granted (`esi-calendar.read_calendar_events.v1`)
Full attendee list with each person's response status for one event.
**Idea:** show "12 attending, 3 maybe" and who's actually coming under each
event in the Calendar detail view — useful for checking fleet-op turnout.

## Character

### `GET /characters/{character_id}/portrait` — public
Portrait image URLs (32/64/128/256/512px) for a character.
**Idea:** the single highest-visual-impact item in this whole audit — real
character portraits everywhere a pilot name currently renders as plain text:
Dashboard character cards, Kills & Intel killmail attacker/victim rows and
character-profile lookups, Mail sender rows, Wars party listings.

### `GET /characters/{character_id}/blueprints` — reconnect (`esi-characters.read_blueprints.v1`)
The full list of BPOs/BPCs the character owns, each with material efficiency,
time efficiency, and runs remaining. **Idea:** a "My Blueprints" panel on the
Industry screen, feeding the same production-graph work `pi.rs` already does
for PI — know what you can actually build without alt-tabbing to the client.

### `GET /characters/{character_id}/fatigue` — reconnect (`esi-characters.read_fatigue.v1`)
Jump activation/fatigue timers (last jump time, fatigue expiry, jump cooldown
expiry). **Idea:** a capital-pilot readiness card on the Dashboard, and a
relevant input for the new Path & Wormhole Finder when planning
capital/jump-freighter movement.

### `POST /characters/affiliation` — public
Bulk lookup: many `character_id`s in, corporation/alliance/faction ids out,
in one call (no per-character round trip). **Idea:** `kills.rs` itself
flags "Local can run to 100+ pilots" as an ESI+zKillboard concurrency
concern for the Intel Check local-scan feature — this endpoint is the direct
fix, replacing dozens of per-pilot lookups with one bulk POST.

## Contacts

### `POST` / `PUT` / `DELETE /characters/{character_id}/contacts` — reconnect (`esi-characters.write_contacts.v1`)
Bulk add/edit/delete entries on the character's in-game contact list.
**Idea:** a "Blacklist this pilot" button right on a Kills & Intel killmail
or character profile — sets a negative standing + watched flag without
leaving VESPER.

### `GET /characters/{character_id}/contacts/labels` — granted (`esi-characters.read_contacts.v1`)
The character's custom contact folder/label names (e.g. "Blues", "Known
Gankers"). **Idea:** show these labels next to each entry on the existing
Contacts tab instead of just a raw standing number.

## Contracts

### `GET /contracts/public/items/{contract_id}` — public
### `GET /contracts/public/bids/{contract_id}` — public
Item manifest for a public item-exchange contract; current top bid for a
public auction contract. **Idea:** Wallet & Market's public contract browser
(`WalletMarketPage.tsx`) currently lists headers only — clicking into a row
could show what's actually in it, or the live bid state for an auction.

### `GET /characters/{character_id}/contracts/{contract_id}/bids` — granted (`esi-contracts.read_character_contracts.v1`)
Bid history on the user's own auction-type contracts. **Idea:** same
treatment for the character's own Contracts tab.

## Corporation

### `GET /corporations/{corporation_id}/alliancehistory` — public
A corp's full alliance-membership timeline. **Idea:** mirrors the character
employment-history feature VESPER already has — add the equivalent alliance
timeline to a corp's Kills & Intel profile page.

### `GET /corporations/{corporation_id}/icons` — public
Corp logo image URLs. **Idea:** paired with alliance icons above — logos
throughout Kills & Intel, Wars, and the Dashboard wherever a corp name shows.

## Faction Warfare

### `GET /characters/{character_id}/fw/stats` — reconnect (`esi-characters.read_fw_stats.v1`)
A character's own FW involvement: current warzone, enlistment corp, kills,
victory points, current rank. **Idea:** a Dashboard card for any connected
character enrolled in Faction Warfare.

### `GET /fw/systems` — public
Current owner/contested-state of every FW solar system.
### `GET /fw/wars` — public
Which NPC factions are currently at war with each other.
**Idea:** a Map overlay showing FW frontline/contested systems next to the
existing player-structure and kill-density layers, and a small "warzone
status" panel on the Wars screen alongside player corp/alliance wars, for a
complete "who's fighting whom" picture.

## Fittings

### `DELETE /characters/{character_id}/fittings/{fitting_id}` — granted (`esi-fittings.write_fittings.v1`)
Deletes one saved fit from the character's in-game Fittings browser.
**Idea:** the Fittings & Fleets screen can already push a fit to the client
(`POST /fittings/`) — this closes the loop, letting the user clean up old
saved fits from VESPER too.

## Fleets

### `GET /characters/{character_id}/fleet` — reconnect (`esi-fleets.read_fleet.v1`)
### `GET /fleets/{fleet_id}` — reconnect (`esi-fleets.read_fleet.v1`)
### `GET /fleets/{fleet_id}/members` — reconnect (`esi-fleets.read_fleet.v1`)
### `GET /fleets/{fleet_id}/wings` — reconnect (`esi-fleets.read_fleet.v1`)
Which fleet (if any) the character is currently in, the fleet's settings,
and a full member roster (each member's ship type, solar system, wing/squad,
role). **Idea:** the Fittings & Fleets screen currently only shows static
saved fits — this would add a genuinely live view: "who's actually in my
fleet right now and what are they flying," the real-time companion piece the
screen's name already implies. (The 10 corresponding write endpoints —
inviting/kicking/moving members, managing wings/squads — are FC
command-and-control tooling and are in the skipped section below.)

## Incursions

### `GET /incursions` — public
Active incursion constellations, mothership system, influence level, whether
the boss has spawned. **Idea:** a small overlay/panel on the Map or Intel
Check screen — "Sansha's Nation incursion active in Rancer" — useful
avoid-or-farm intel for any character passing through.

## Industry

### `GET /characters/{character_id}/mining` — reconnect (`esi-industry.read_character_mining.v1`)
A paginated 30-day ledger of the character's own mining: date, solar system,
ore/ice type, quantity. **Idea:** a personal mining-yield card on the
Planetary Industry/Industry screen — the mining equivalent of the existing
wallet Transactions tab.

### `GET /industry/systems` — public
Manufacturing/research/reaction cost indices for every solar system.
**Idea:** highlight the cheapest nearby system to build in, right next to
the existing PI production-graph visualizer on the Industry screen.

## Killmails

### `GET /characters/{character_id}/killmails/recent` — reconnect (`esi-killmails.read_killmails.v1`)
### `GET /killmails/{killmail_id}/{killmail_hash}` — public
The character's own kills and losses for the last 90 days, straight from
CCP, plus the matching full killmail detail. **Idea:** Kills & Intel is
currently 100% zKillboard-sourced (confirmed throughout `kills.rs` — every
kill/loss/stats call hits `zkillboard.com`, with no ESI killmail scope held
at all today). This is ESI's own authoritative feed for the logged-in
characters specifically — no crawl delay, no dependency on zKillboard being
up, and a natural cross-check against the existing zKillboard-based feed for
"my kills and losses."

## Location

### `GET /characters/{character_id}/online` — reconnect (`esi-location.read_online.v1`)
Whether the character is logged in right now, plus last-login/last-logout
timestamps. **Idea:** an online/offline badge on each Dashboard character
card — "which of my 6 alts are actually logged in right now" at a glance,
without opening the client.

## Loyalty

### `GET /loyalty/stores/{corporation_id}/offers` — public
The full LP store catalog for a corp: what each offer costs in ISK+LP,
what it converts to. **Idea:** VESPER already tracks per-corp LP balances
(the existing Loyalty tab, `/characters/{id}/loyalty/points/`) — this is the
natural next feature, an LP Store browser on Wallet & Market showing what
those points are actually worth redeeming.

## Mail

### `GET /characters/{character_id}/mail/labels` — granted (`esi-mail.read_mail.v1`)
### `GET /characters/{character_id}/mail/lists` — granted (`esi-mail.read_mail.v1`)
The character's mail label/folder set with unread counts per label, and
mailing-list subscriptions. **Idea:** the Mail tab currently shows one flat
inbox — this lets it filter like the in-game client does (Fleet, Corp, a
subscribed mailing list) instead of one long undifferentiated list.

### `PUT` / `DELETE /characters/{character_id}/mail/{mail_id}` — reconnect (`esi-mail.organize_mail.v1`)
Mark a mail read/unread or relabel it; delete a mail. **Idea:** basic mail
management (mark-as-read, delete) directly from VESPER instead of read-only
viewing.

### `POST /characters/{character_id}/mail` — reconnect (`esi-mail.send_mail.v1`)
Compose and send a new mail. **Idea:** a basic reply/compose box on the Mail
tab. (If the write scope feels heavier than wanted, `POST
/ui/openwindow/newmail` below gets most of the value with a lighter scope —
open the client's own compose window instead of sending through the app.)

## Market

### `GET /markets/structures/{structure_id}` — reconnect (`esi-markets.structure_markets.v1`)
All open orders inside one player-owned structure's market.
**Idea:** Market Browser and Price Checker currently only ever see NPC
station/region orders (`/markets/{region_id}/orders/`) — this adds
player-owned trade hubs (Perimeter/Ahbazon Keepstars, etc.) that a lot of
high-volume traders actually use, which VESPER's price data is currently
blind to.

## Planetary Interaction

### `GET /characters/{character_id}/planets/{planet_id}` — granted (`esi-planets.manage_planets.v1`)
Full colony layout: every pin, link, and route, including each extractor
head's `expiry_time`. **This is the single biggest concrete gap found in
this whole audit.** VESPER's Planets tab (`fetch_character_planets` in
`esi.rs`) currently only calls the *list* endpoint (`/planets/`), which
returns just planet type, pin count, and upgrade level — no per-extractor
countdown. This detail endpoint is the missing piece for a real "extraction
expiring in 3h 42m" alert on the Planetary Industry screen, and the scope is
**already granted to every connected character today** — no reconnect
needed. One caveat straight from ESI's own docs: "Planetary information is
only recalculated when the colony is viewed through the client," so the data
can lag behind reality until the player opens that colony in-game.

## Search

### `GET /characters/{character_id}/search` — reconnect (`esi-search.search_structures.v1`)
Authenticated search across characters/corporations/alliances/systems/etc,
including player structures — the one category the already-used
`/universe/names/`/`/universe/ids/` pair cannot resolve at all. **Idea:** a
proper "find this citadel by name" box for the Path & Wormhole Finder's
waypoint picker or the Gate Check route planner.

## Skills

### `GET /characters/{character_id}/attributes` — granted (`esi-skills.read_skills.v1`)
The character's 5 core attribute points (Perception, Willpower, etc.) and
remaining neural remaps. **Idea:** the Skills tab shows trained levels and
the training queue but not attributes today — this is a one-call,
already-authorized addition that also unlocks an actual SP/hour
training-rate readout, the classic EVEMon-style feature.

## Universe

### `POST /universe/ids` — public
Reverse of the already-used `/universe/names/` — exact name-to-ID
resolution for characters/corporations/alliances/systems/types/etc not yet
seen (and so not in VESPER's local caches). **Idea:** the resolver behind a
"look up this corp/alliance by name" search box on the Wars screen, or the
Kills & Intel character/corp lookup fields.

### `GET /universe/ancestries` — public
All character ancestries (e.g. "Deathless", "Static") with descriptions.
**Idea:** one more Character Overview bio detail alongside the race/
bloodline VESPER already resolves via the identical `fetch_race_name`/
`fetch_bloodline_name` pattern in `esi.rs`.

### `GET /universe/factions` — public
NPC faction names, descriptions, and militia corp/system associations.
**Idea:** pairs directly with the `fw/wars`/`fw/systems` ideas above, and
resolves the faction party on any wallet journal entry whose counterparty is
an NPC faction rather than a player.

## User Interface

This entire tag is a standout — five endpoints that deep-link straight into
the running client, letting VESPER act as a remote control rather than a
read-only mirror.

### `POST /ui/autopilot/waypoint` — reconnect (`esi-ui.write_waypoint.v1`)
Sets a solar system as an in-game autopilot waypoint. **The single best find
in this audit for the new Path & Wormhole Finder** — click a system on a
planned route inside VESPER and it sets the actual autopilot destination in
the running client. Turns the route planner from "look at this, then retype
it in the client" into one click.

### `POST /ui/openwindow/information` — reconnect (`esi-ui.open_window.v1`)
Opens the in-game info window for a character, corp, or alliance.
**Idea:** click any pilot/corp/alliance name in Kills & Intel and it opens
that entity's real info window in the live client instead of just showing
text inside VESPER.

### `POST /ui/openwindow/contract` — reconnect (`esi-ui.open_window.v1`)
**Idea:** a "View in game" button on a Wallet & Market contract row.

### `POST /ui/openwindow/marketdetails` — reconnect (`esi-ui.open_window.v1`)
**Idea:** a "View in game" button on a Market Browser/Price Checker item.

### `POST /ui/openwindow/newmail` — reconnect (`esi-ui.open_window.v1`)
Opens the client's compose-mail window, optionally prefilled.
**Idea:** a "Reply in game" button on a Mail tab message — gets most of the
value of the `send_mail` write scope above with a lighter, click-through
scope instead of sending mail through the app directly.

## Wars

### `GET /wars/{war_id}/killmails` — public
The kill list tied to one specific war. **Idea:** the Wars screen's
war-detail view could show a live kill feed for that war, reusing the same
`KillDetail` rendering Kills & Intel already has.

---

## Explicitly skipped, low value for a personal companion app

**89 endpoints** left out of the detail above, by category:

- **Corporation management (19)** — `/corporations/{id}/structures`,
  `/starbases`(+detail), `/containers/logs`, `/divisions`, `/facilities`,
  `/medals`(+`/issued`), `/members`(+`/limit`,`/titles`), `/membertracking`,
  `/roles`(+`/history`), `/shareholders`, `/standings`, `/titles`,
  `/npccorps`, `/blueprints` — CEO/director-role-gated management data with
  no personal-companion angle; VESPER's characters aren't assumed to hold
  corp roles.
- **Fleets: write/command endpoints (10)** — inviting, moving, and kicking
  fleet members, managing wings and squads. FC command-and-control tooling,
  not information display — out of scope the same way VESPER's one existing
  write call (pushing a fit to the client) is a copy, not a remote-control
  action.
- **Universe: bulk ID lists and celestial detail (12)** —
  `/universe/systems`, `/regions`, `/constellations`, `/groups`,
  `/categories`, `/types` (bulk, unnamed ID lists), `/graphics`(+detail),
  `/moons/{id}`, `/planets/{id}`, `/stars/{id}`, `/asteroid_belts/{id}` —
  VESPER already gets a far richer version of the map/market catalog data
  from its own Fuzzwork SDE sync (`map.rs`, `market.rs`); the celestial
  render/position endpoints have no current feature to attach to.
- **Sovereignty (3)** — `/sovereignty/campaigns`, `/map`, `/structures` —
  null-sec sov mechanics; no plausible personal-companion use as called out
  in the task brief.
- **Dogma (5)** — `/dogma/attributes`(+detail), `/dogma/effects`(+detail),
  `/dogma/dynamic/items/{type}/{item}` — internal type-attribute plumbing
  VESPER already consumes indirectly per-item via `/universe/types/{id}/`;
  no standalone user-facing screen would come from browsing the raw
  attribute/effect catalog.
- **Market: corp orders + catalog duplicates (5)** —
  `/corporations/{id}/orders`(+`/history`) (role-gated),
  `/markets/groups`(+detail), `/markets/{region_id}/types` — VESPER's own
  Fuzzwork-sourced market catalog (`market.rs`) already covers the category
  tree and full type list more richly than these.
- **Industry: corp-scoped (4)** — `/corporations/{id}/mining/extractions`,
  `/mining/observers`(+detail), `/industry/jobs` — director/mining-director
  role-gated.
- **Faction Warfare: leaderboards + corp (5)** — `/fw/leaderboards`(+
  `/characters`,`/corporations`), `/fw/stats` (galaxy-wide), `/corporations/
  {id}/fw/stats` — general rankings and corp-level stats with weaker
  personal-companion tie-in than the character/system-level picks above.
- **Character: niche personal data (5)** — `/agents_research`,
  `/roles` (corp roles held), `/titles` (corp titles), `/notifications/
  contacts`, `/cspa` (mail-cost calculator) — low-signal fields with no
  natural home in VESPER's current screens.
- **Wallet: corp (3)** — `/corporations/{id}/wallets`(+`/journal`,
  `/transactions`) — treasurer/director-role-gated.
- **Assets: corp (3)** — `/corporations/{id}/assets`(+`/locations`,
  `/names`) — role-gated.
- **Contacts: alliance/corp (4)** — `/alliances/{id}/contacts`(+`/labels`),
  `/corporations/{id}/contacts`(+`/labels`) — role-gated, not personal.
- **Contracts: corp (3)** — `/corporations/{id}/contracts`(+`/bids`,
  `/items`) — role-gated.
- **Killmails: corp (1)** — `/corporations/{id}/killmails/recent` —
  role-gated.
- **Mail: label management (2)** — `POST /mail/labels` (create),
  `DELETE /mail/labels/{id}` — minor CRUD on top of the label-reading idea
  already covered above; not worth a separate write-up.
- **Alliance: bulk list (1)** — `GET /alliances` — a bare list of every
  alliance ID in the game with no names attached; low value on its own.
- **Meta (2)** — `/meta/changelog`, `/meta/compatibility-dates` — ESI API
  housekeeping, not game data.

---

## Summary

- **140 unused ESI endpoints** out of 197 total live endpoints (57 already called by VESPER).
- **51 written up in detail** with concrete VESPER feature ideas, scope status, and grounding from the live spec text; **89 explicitly bucketed as skipped** (corp/admin-role-gated, duplicate of VESPER's own SDE sync, or pure API housekeeping) with reasons given by category.
- Confirmed live: the `Opportunities` tag is fully gone from the current ESI spec (0 endpoints) — matches the prior session's finding.

Five ideas flagged as most interesting:

1. **`GET /characters/{character_id}/planets/{planet_id}`** — VESPER's Planets tab only ever calls the *list* endpoint today; this per-planet detail endpoint (scope already granted, no reconnect needed) has the actual extractor `expiry_time` data for a real "extraction expiring in 3h42m" alert.
2. **`POST /ui/autopilot/waypoint`** — turns the new Path & Wormhole Finder from "look at the route, retype it in-game" into a one-click "set autopilot" action in the live client.
3. **`GET /characters/{character_id}/killmails/recent`** — VESPER's entire Kills & Intel feature is 100% zKillboard-sourced today (confirmed throughout `kills.rs`); this is ESI's own authoritative 90-day kill/loss feed straight from CCP.
4. **`GET /characters/{character_id}/portrait`** — real character portraits everywhere a pilot name currently shows as plain text (Dashboard, Kills & Intel, Mail, Wars) — the highest visual-polish-per-line-of-code item found.
5. **`POST /characters/affiliation`** — a bulk character→corp/alliance resolver that directly answers a concern `kills.rs`'s own comments raise about Local-scan concurrency for 100+ pilots.
