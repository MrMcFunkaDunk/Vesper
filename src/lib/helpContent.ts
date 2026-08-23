/** Copy shown by HelpBadge - one entry per top-level nav page (keyed by
 * Sidebar.tsx's NAV_ITEMS id) plus one entry per sub-tab on pages bundling
 * several genuinely different tools/tabs under one nav item (e.g. Industry's
 * five calculators as "industry.production" etc., Wallet & Market's ten tabs
 * as "wallet.orders" etc.). Each field can be a single paragraph or an array
 * of paragraphs - use an array once a page has enough distinct tabs/modes
 * that one run-on paragraph would stop being readable. */
export interface HelpContent {
  title: string;
  what: string | string[];
  how: string | string[];
  gives: string | string[];
}

export const HELP_CONTENT: Record<string, HelpContent> = {
  dashboard: {
    title: "Dashboard",
    what: [
      "Your home screen - every logged-in character shown as a card with wallet balance, total skill points, current training skill and queue, current ship and location, and a clone-state badge, all refreshed automatically in the background every 2 minutes. Below the grid, two auto-refreshing strips show official EVE Online news and recent New Eden activity (sovereignty/structure events from DOTLAN).",
      "Clicking a card opens that character's full Detail view instead - a separate, much larger screen with 22 tabs covering everything from their skill queue and assets to mail, contracts, and kill history. If you have more than one character, a \"Compare Skills\" button also appears above the grid.",
    ],
    how: [
      "Click anywhere on a character's card to open their full Detail view and make them the app's active character (this also updates the character switcher in the top bar). The small Ω/α badge on a card's portrait is a manual, purely cosmetic override - ESI has no real Alpha/Omega field, so VESPER guesses at first based on skill points; clicking the badge cycles it Auto → Alpha → Omega → back to Auto, and your choice is remembered per character but never reflects or changes anything in the actual game.",
      "\"Add Character\" (bottom-right tile) starts EVE SSO sign-in for a new account. If a card shows \"Reconnect\" instead, that character's token has expired or is missing a scope some tab needs - click it and sign in again as that same character in the browser prompt to refresh it.",
      "Inside a character's Detail view: a vertical portrait rail on the left lets you jump straight to another character without going back to this grid. The header (name, corp/alliance, ISK, SP, location, training) always stays visible above 22 tabs: Queue, Plan, Skills, Clones, Employment, Standings, Contacts, Medals, LP, Assets, Market Orders, Contracts, Insurance, Industry Jobs, Wallet, Transactions, Mail, Notifications, Kill Log, Planetary, Research, and Faction Warfare. A few worth knowing about specifically: \"Plan\" is a personal, app-only skill planner completely separate from your real in-game queue, with its own priority ordering, an implant-preview calculator, and an injector-count estimate; \"Assets\" only records one ISK-value snapshot per calendar day, so a trend line won't appear until it's been open on two different days; \"Kill Log\" is a portal out of this view entirely - clicking any name, corp, alliance, or system on a kill/loss row jumps you to that entity's killboard on the separate Kills & Intel page, not another tab here; and \"Insurance\" is a standalone calculator for any ship in the game (ESI has no endpoint for policies you've actually bought), not a record of this character's own coverage.",
      "Switching characters - whether via the grid, the rail, or the top bar - fully resets the Detail view back to the Queue tab; it doesn't remember which tab you were last on for a different character. Every tab's data loads once on first visit and then polls every 2 minutes while that tab stays open; there's no manual refresh button anywhere on this page.",
    ],
    gives: "A fast way to check in on your whole roster without opening each character individually, and a deep, all-in-one profile for any one of them the moment you need more than the summary card shows.",
  },

  kills: {
    title: "Kills & Intel",
    what: [
      "Live and historical killmail data from zKillboard, plus two watchlists (Tracked Players/Corps/Alliances and a merged Contacts directory) that feed alerts elsewhere in the app.",
      "Seven tabs across the top: Tracked Systems, Most Recent Kills, Battles, Kill Reports, Top Stats, Tracked Players, and Contacts. A search box above them (hidden only on Tracked Players) looks up any character, corporation, or alliance and opens their full killboard - and every kill row, system name, corp/alliance name, and character name anywhere in this page is itself clickable, drilling further in and adding to a breadcrumb trail at the top that you can click back through to any earlier point, not just one step at a time.",
    ],
    how: [
      "Most Recent Kills is a genuinely live global feed (highsec through wormhole space) that keeps polling in the background even while you're on a different tab or page entirely - the \"Updated Xs ago\" label ticks in real time and a Refresh button forces an immediate re-check. An NPC-kills on/off toggle and a High/Low/Null/W-Space security filter bar apply here and are shared with Tracked Systems (toggling one changes the other). The feed itself is capped to the most recent 150 kills - it's a live ticker, not an archive.",
      "Tracked Systems is your personal watchlist: search-and-add a system, or switch to \"Gate\" mode to track one specific stargate within a system (a gate's own name repeats all over New Eden, so you pick the system first, then the gate). Constellations and regions are added differently - open that system's own killboard by drilling into any kill, then use the star \"Track\" button on its Constellation or Region killboard header; it lands in this exact same watchlist. Each tracked entry shows as a colored chip you can click to filter the feed to just that one (click again to show everything tracked), drag to reorder, or remove with its X. A gate you track only matches kills at that literal gate, not the whole system it sits in.",
      "Battles auto-clusters kills straight out of the live feed above - two or more kills in the same system count as one \"battle\" as long as no gap longer than 20 minutes separates consecutive kills there. It's an explicitly rough grouping (no full attacker-list analysis) and only ever covers battles still inside that live 150-kill window, not a historical battle browser.",
      "Kill Reports applies zKillboard-style classification filters - Top Kills, Big Kills, Capitals, Structures, Abyssal, Abyssal PvP, Awox, Ganked, Solo - one at a time, each with a tooltip spelling out its exact definition (e.g. \"Ganked\" specifically means the attacker who did this kill was later CONCORD-killed for it, which needs VESPER to have recorded both kills itself). Top Stats is the same idea for rankings instead of a filtered list: Top Killers and Top Losers, each broken into Characters/Corporations/Alliances/Factions/Ships/Groups over a rolling 60-minute window, plus a \"Where It Happened\" panel of top systems and regions - only the Characters/Corporations/Alliances rows are clickable through to a killboard.",
      "Both Kill Reports and Top Stats run entirely off VESPER's own locally-recorded kill history, not a live zKillboard query - so they only cover what VESPER has actually seen since it started running, and get more complete the longer the app stays open. A \"Backfill Last 30 Days\" button (shown above both tabs) does a one-time background import of zKillboard's own bulk history to fill that in immediately instead of waiting a literal month.",
      "Tracked Players/Corps/Alliances is your kill/death watchlist (the same list is also editable from Settings) - anyone or anything added here triggers a notification the moment they show up on any killmail anywhere, whether or not you're on this page. Contacts merges every connected character's personal contact list into one searchable, sortable directory, with a \"Track\" button on each trackable row to add them straight to the watchlist above.",
    ],
    gives: "Situational awareness on where fights are happening right now, instant alerts the moment someone you're watching kills or dies, a deep-dive killboard for anyone you're checking up on, and the same kind of classification/leaderboard views zKillboard itself offers - built from VESPER's own growing local history rather than a live query every time.",
  },

  map: {
    title: "Map",
    what: [
      "A full, pannable/zoomable New Eden starmap with a live kill-heat overlay - every system with recent kills glows red (brighter and bigger the more kills it's had in the last hour), and a system with a kill in roughly the last 2 minutes also gets a small pulsing outline around its dot so \"fighting right now\" is visually distinct from \"was busy a while ago but has gone quiet.\" The map keeps mapping and tracking in the background even while you're on a completely different page, so coming back to it never means waiting for everything to reload.",
      "Two kinds of character markers can appear next to a system dot: a small house icon with your character's initials marks wherever that character's home station is, and a portrait circle marks wherever that character actually is right now - both are system-level only (no attempt to identify the exact station/structure), and hovering either one shows that character's name in a small tag.",
      "Above the map itself sit three sub-tabs: Map (the starmap you're reading about here), Gate Check, and Wars.",
    ],
    how: [
      "Search for a system by name to jump straight to it, or click any system dot directly. Clicking a system does two things at once: it sets that system as your app-wide \"current location\" for proximity alerts (shown in the header next to a location-pin icon, with an X to clear it), and it pins that system's hover tooltip open so you can actually click into the mini-killboard inside it (see below) instead of it disappearing the moment your mouse moves away.",
      "The row of numbers under \"Nearby\" (1/2/3/5/7/9/Region) sets the jump-radius around your current location that counts as \"nearby\" for kill alerts - pick 3, for example, and a kill anywhere within 3 jumps of wherever you last clicked will trigger a proximity notification (with an optional screen-flash and sound, configurable in Settings) even while you're on another page entirely. \"Region\" widens that to your whole current region instead of a jump count. This radius has nothing to do with what's drawn on screen - it's purely what counts as \"close enough to warn you about.\"",
      "Hovering (without clicking) any system shows a transient tooltip with its security status, recent kill count, and - if it's had kills - a small clickable killboard of the most recent ones, each row jumping straight to that kill's full detail on the Kills & Intel page. Clicking a system instead of just hovering pins that same tooltip open (with a close X) so you can move your mouse into it and actually click a kill row without it vanishing first; clicking the same system again, or clicking empty space, unpins it.",
      "\"Key\" toggles a legend explaining the security-color scale and station-service icons; \"Icons\" toggles whether those station-service icons draw under system names at all. \"Stats\" opens a small activity panel; the box in the bottom-right corner always shows the current top-active systems and regions across the whole visible map.",
      "Gate Check and Wars are separate sub-tabs above the map itself, not overlays on top of it - switch to them the same way you'd switch any tab.",
    ],
    gives: "A live read on where danger or opportunity is right now, an alert the moment a kill lands within whatever radius you've set of wherever you last clicked, and - once you've clicked into a system's pinned tooltip - a one-click path from \"something just died here\" straight to that kill's full detail.",
  },

  "path-wormhole-finder": {
    title: "Path & Wormhole Tracker",
    what: [
      "A wormhole-chain mapper built around named \"chains\" you switch between (like Tripwire or Pathfinder), each its own node-graph canvas of systems and connections - plus a route planner that can combine stargates and your mapped wormholes into one path, a live browser of public Thera/Turnur connections, and a standalone capital jump-fuel/fatigue planner.",
      "Node cards on the canvas carry real information, not just a name: a home icon flags the chain's Origin system, a pulsing dot marks wherever your tracked character actually is right now, the security number and color follow EVE's real convention (wormhole systems show \"J-SPACE\" instead), a skull-and-count badge appears if there have been recent kills there, and the border color reflects standing (blue/red) toward anyone involved in one of those kills, matched against your in-game contacts. Connection lines are colored by wormhole mass status (green/orange/red), drawn dashed if flagged End-of-Life, and drawn as a red \"!\" if the signature behind them has since dropped out of your last scan.",
    ],
    how: [
      "Chain pills at the top show a name and system count; click one to switch the canvas to it, or use \"+ New Chain\" to start another from scratch. Each pill's own small icons let you rename it, delete it (with confirmation), or - the important one - toggle \"Live Tracking\" (a locate-pin icon), which is what makes a chain map itself automatically as you actually play. Turning Live Tracking on for any chain (or simply opening this page) is what wakes up VESPER's live location polling in the background; once it's running, every real jump your tracked character makes gets added to every chain that has Live Tracking on, tagged correctly as a stargate or wormhole hop, with no other action needed from you. The very first jump after turning tracking on only registers the starting system (there's no \"previous system\" yet to draw a connection from) - the next jump after that is what starts connecting them.",
      "On the canvas: type in the search box to add a system by name; drag a node to reposition it; drag from any of a node's four edge-handles onto another node to draw a wormhole connection between them (dragging onto an already-connected pair just selects that existing connection instead of duplicating it). Click a node to open its detail panel on the right - \"Set as Origin\" flags it as this chain's manual routing start, \"View Killboard\" jumps to its killboard on Kills & Intel, and a Signatures section lets you paste your in-game Scanning window's clipboard content directly to bulk-import that system's signatures (color-coded by how stale they are, and calling out anything from your last scan that's since vanished).",
      "Click a connection line instead of a node to edit it. A stargate hop just shows an informational note (it's tracked automatically, nothing to configure). A wormhole connection lets you set its real wormhole-type code (type-ahead against the actual game data, revealing its mass caps and estimated lifetime), mark it End-of-Life, flag it with a custom icon/color/note, and - if the type has known mass limits - use a rolling mass calculator: pick a preset ship or click \"Use My Ship\" to pull your actual current ship's real mass, then log a pass as \"Hot\" or \"Cold\" (purely your own note about intent, not derived) to track worst-case/best-case remaining mass, since a real wormhole's exact total mass is randomized at spawn and never fully revealed. Once you've logged at least one jump this way, the Fresh/Reduced/Critical status switches from manual to automatically derived from that log.",
      "The Route toolbar button plans a path from either your character's live current system (default, re-routes automatically as you move) or the chain's manually-set Origin, to any destination you search for or pick from the five trade-hub shortcuts - happily mixing stargate and wormhole legs into one continuous route, with each step tagged \"Gate\" or \"WH\" (clicking a WH step jumps you to that connection's editor). Scout shows live, community-maintained public wormhole connections out of Thera or Turnur, each with an expiry countdown and a one-click \"Route Here.\" Capital is entirely separate from the mapped chain: pick a capital ship, optionally a character (to apply their real trained jump-drive skills), and a jump-order list of waypoints, and it works out fuel, cooldown, and cumulative fatigue per leg - deliberately assuming zero waiting between jumps, since that's the worst case to fuel for, not an estimate of real elapsed time.",
    ],
    gives: "A live, always-current map of your current wormhole chain that fills itself in as you actually explore, routes that account for wormholes instead of just gates, a heads-up on public Thera/Turnur connections without checking a separate site, and the real fuel/fatigue cost of a capital jump route before you commit to it.",
  },

  wallet: {
    title: "Wallet & Market",
    what: "Ten tabs covering everything money- and market-related: Market Browser, Item Database, Appraisal, Screener, LP Store, Contracts, Insurance, Orders, Wallet, and Transactions. Switch between them along the top; Orders/Wallet/Transactions/LP Store also show a character-selector strip once you have more than one character connected, since those four are scoped to whichever character is picked there.",
    how: "Each tab is its own tool with its own help - open its badge for the specifics. As a starting point: Market Browser and Item Database are for looking things up (prices, order books, price history, or just what an item actually does); Appraisal and Screener are calculators (bulk-value a pasted list, or scan a whole category for live arbitrage); LP Store ranks what your loyalty points are actually worth spending on; Contracts, Orders, Wallet, and Transactions are records of what you (or the wider public market, for Contracts) have actually done or currently have active; Insurance is a standalone \"what would this cost\" calculator, not a record of policies you've bought.",
    gives: "One place to track your finances, sanity-check prices, and hunt for profit before you buy, sell, or commit ISK to anything.",
  },
  "wallet.browser": {
    title: "Market Browser",
    what: "Full market data for any item in a region you pick - live order book, 90-day price history, and a category tree to browse instead of search.",
    how: [
      "Pick a region via either the five-hub quick-picker or the \"All Other Regions\" list (only one of the two is ever active at a time - whichever you touched last wins). Search an item by name, or drill through the category tree on the left (leaf categories lazy-load their items only once you actually expand them). Once an item's picked, stat cards show Avg Vol (7d), Spread, Best Sell, Best Buy, and Split Price - the ISK-per-unit midpoint between best sell and best buy, the conventional figure for splitting a direct player trade evenly, not a suggestion to place an order there.",
      "Market Data and Price History tabs switch between the live order book (sellers cheapest-first, buyers highest-first, capped at 50 rows each) and a 90-day chart - Export CSV grabs whichever one you're currently looking at. \"Pin Price Widget\" opens a small separate always-on-top window with a live price lookup for the current region, independent of VESPER's own window.",
    ],
    gives: "A real, current order book and price history for anything in the game, plus a quick always-on-top price check you can leave open while doing something else.",
  },
  "wallet.itemdb": {
    title: "Item Database",
    what: "A browsable catalog of every item in the game, laid out category → group → item, in the same style as db.evetools.org - not just ships, everything from modules to charges to skillbooks.",
    how: "Drill down through categories and groups on the left, click an item for its full detail view (attributes, fittable slot, real-time price). From a ship's detail view, \"Fit This Ship\" jumps straight into the Fit Builder with that hull already loaded - this is a one-shot handoff, so it only works if you go there next, not after browsing somewhere else first. This tab is drill-down only - there's no search box here.",
    gives: "A fast way to look up what an item actually does without leaving VESPER, and a shortcut straight into fitting a ship you just found.",
  },
  "wallet.appraisal": {
    title: "Appraisal",
    what: "Bulk value-checks a pasted list of items - inventory copy, an EFT fit, or just plain item names - against a region's real, live order book, not a flat average price.",
    how: [
      "Pick a region the same way as Market Browser, paste your list, and click Appraise. The parser accepts several formats automatically: tab-separated inventory-copy rows, a pasted EFT fit (the [Ship, Fit Name] header line is ignored), \"Item x12\" style, or a bare name (defaults to quantity 1) - duplicate mentions of the same item across lines get summed into one row.",
      "Sell Unit/Sell Total walk the region's real buy-order book, best price first, until your quantity is filled - so a large quantity correctly shows a worse blended price if the book is thin, rather than just multiplying by the top order's price. Buy Unit/Buy Total do the same against the sell-order book. A \"thin liquidity\" tag flags any row where the book couldn't fully fill your quantity, and unresolved item names are called out separately in the footer.",
    ],
    gives: "A real, liquidity-aware total value for a whole inventory, fit, or loot list - not an optimistic \"top order price × quantity\" guess.",
  },
  "wallet.screener": {
    title: "Screener",
    what: "Two scan modes over a market category you pick: Same-Region Spread (buy/sell margin within one region) and Inter-Region Hauling (buy at a source region, haul, and sell at a destination region - ranked by profit per m³ of cargo, since cargo space is usually the real constraint on a haul).",
    how: [
      "Pick a mode first - Spread needs one region, Hauling needs two different ones (the Scan button stays disabled with a message if they match). Drill into a category the same way as Market Browser until you reach a leaf category, then Scan - the button label tells you exactly how many of that category's items will be checked, since only the first 50 are ever scanned per run to keep it fast.",
      "Spread ranks by margin % (best sell minus best buy, over best sell) within one region. Hauling computes buying at the source region's cheapest sell order, then undercutting the destination's current lowest sell order to list your own - the standard retail-arbitrage margin, not just the destination's buy-order price - and separately shows \"Instant Sell @ Dest\" (the destination's best buy order) as an alternative for someone who'd rather sell instantly than wait to be undercut in turn. Neither mode accounts for route risk (gate camps, contraband, prices moving in transit) - it's a starting point, not a guarantee.",
    ],
    gives: "A fast way to find real, currently-live arbitrage or hauling opportunities in a whole category instead of guessing which items are worth flipping.",
  },
  "wallet.lpstore": {
    title: "LP Store",
    what: "Every item purchasable with loyalty points at any corporation you've earned LP with, ranked by estimated ISK profit per LP spent - not just the raw LP price.",
    how: "Pick a corporation from your LP balance pills (auto-selected if you only have one), then browse or filter its store by item name. \"ISK / LP\" - the default sort - nets out the ISK cost, any items you'd have to turn in alongside your LP, and the reward's market value, then divides by LP cost; a negative number means the offer currently costs more than the reward is worth once everything's accounted for. All valuations use EVE-wide average price, a rough guide for often thinly-traded faction items, not a live regional quote.",
    gives: "A fast, honest answer to \"which of my LP is actually worth converting to ISK right now\" instead of eyeballing raw LP costs.",
  },
  "wallet.contracts": {
    title: "Contracts",
    what: "A public-market contract browser for a region you pick - item exchange, auction, courier, and loan contracts anyone has posted, not just your own.",
    how: "Pick a region (defaults to your Settings default trade hub), optionally narrow by contract type, and search by title or issuer corp - all three combine together. Every column header sorts. This shows the first 500 matches; narrow your filters if you need to see further into a bigger list.",
    gives: "A way to browse what's actually for sale as a contract in a region, without needing to already know an exact item or issuer.",
  },
  "wallet.insurance": {
    title: "Insurance",
    what: "A standalone cost/payout calculator for insuring any ship in the game right now - not a record of policies you've actually bought.",
    how: "Search a ship name (restricted to insurable hulls) and pick it; its insurance tiers show sorted cheapest-payout to most-expensive, each with Level, Cost, Payout, and Net Payout (payout minus cost).",
    gives: "A clear \"what would insuring this cost, and what would I actually net back\" before you buy a policy in-game - ESI has no endpoint anywhere for a character's real insurance policies, so this is deliberately a calculator, not a tracker.",
  },
  "wallet.orders": {
    title: "Orders",
    what: "The selected character's active and historical market buy/sell orders.",
    how: "Pick a character above if you have more than one; every column sorts. No filtering here today beyond sorting.",
    gives: "A quick look at what you currently have listed on the market and its status, without opening the game.",
  },
  "wallet.wallet": {
    title: "Wallet",
    what: "The selected character's ISK balance and full wallet journal - every ISK-affecting event (bounties, taxes, contract payments, donations, and more), not just market trades.",
    how: "Search by description or party name, and narrow by transaction type with the dropdown - both combine. Export CSV grabs whichever rows are currently loaded. Capped to the most recent 1,000 entries; this is distinct from the separate Transactions tab, which covers specifically market buy/sell fills.",
    gives: "A full, filterable read on where a character's ISK is actually coming from and going, beyond just market activity.",
  },
  "wallet.transactions": {
    title: "Transactions",
    what: "The selected character's market buy/sell transaction history specifically (as opposed to Wallet's full journal of every ISK-affecting event), plus a FIFO-matched realized profit/loss summary.",
    how: "Search by item, location, or who you traded with, and narrow to just Buys or Sells with the dropdown. The Realized P&L stat row matches every buy against later sells of that same item, oldest-first, to work out real profit rather than just summing amounts - any sold quantity with no matching earlier buy in your visible history (e.g. mined, manufactured, or bought before your history started) is called out separately as \"Unmatched Sells\" and deliberately excluded from the P&L figure, since its true cost basis is unknown.",
    gives: "A real, FIFO-based realized-profit figure for your trading, not just a raw sum of buys and sells.",
  },

  planetary: {
    title: "Planetary Industry",
    what: [
      "Two tabs: Colonies, a live cross-character view of every planetary colony you actually have running, and Materials Reference, a planning tool for which planet types yield which raw materials and the full P0-P4 production chain for any commodity.",
    ],
    how: [
      "Colonies lists every colony across all connected characters with its status (Active/Needs Restart/No Extractors), pin icons color-coded by whether each extractor's current cycle has ended, and how long it's been idle. Search by character/planet/system name, or narrow by Character, Planet Type, or Status with the dropdowns - click a row to expand its full pin-by-pin breakdown, including what each extractor is pulling and what's sitting in storage.",
      "Materials Reference is a five-column grid (Planets, then P0 through P4 materials). Click a planet to highlight the raw P0 materials it yields; click any material to highlight its entire upstream ingredient chain all the way back to raw P0s, plus every planet type that ultimately feeds into it - a material's highlight reaches much further than a planet's does, since a planet only shows its direct outputs. The Manufacturing Strategies search box loads a full plan for any P1-P4 commodity: required raw materials (each tagged with which planets produce them) and an expandable recipe tree of every intermediate ingredient down to P0.",
    ],
    gives: "At-a-glance visibility into which of your colonies actually need attention right now, plus everything you'd otherwise need the wiki for when planning or optimizing a new PI chain.",
  },

  mail: {
    title: "Mail",
    what: "A read-only view of a connected character's in-game mail inbox.",
    how: "Pick a character at the top if you have more than one (with only one character connected, there's nothing to switch between, so the picker doesn't appear at all). Click any row to open that message full-screen; \"Back to list\" returns to the inbox. There's no reply, compose, delete, or mark-as-read control anywhere here - it's a mirror of the inbox list and message bodies only.",
    gives: "A quick way to check mail without alt-tabbing into the game.",
  },

  "intel-check": {
    title: "Intel Check",
    what: "Three related tools: Paste Local (bulk affiliation/threat check from a pasted name list), Live Feed (the same check, but reading your actual EVE chat log files automatically), and D-Scan (count up a pasted Directional Scan result by ship/object type).",
    how: [
      "Paste Local: paste a list of pilot names - names can be separated by newlines or commas (not spaces, since real character names often contain spaces), so the EVE Local chat window's own member list pastes in directly. Each resolved pilot gets a card: portrait, corp/alliance, and a threat score derived from zKillboard's danger ratio - but the High/Medium/Low band isn't just that raw percentage: High needs both a very high danger ratio and at least 5 kills, Medium needs a high ratio or at least 20 kills, so a pilot with one lucky kill and zero losses doesn't outrank someone with hundreds of real kills. Anyone with zero combined kills/losses sorts to the very bottom regardless of their ratio. Capped at 100 pilots per run.",
      "Live Feed reads one of EVE's own local chat-log files directly off disk - this needs in-game chat logging turned on first (Settings → Chat → \"Log chat to file\"). Pick which of your characters' logs to read (each running client keeps its own separate log files), then pick a channel from that character's own channel list - there's no auto-detection of \"which channel is the intel channel,\" you choose it explicitly, and your choice is remembered across restarts. It then polls every 4 seconds for new lines; the first time you watch a channel it shows only the last ~32KB of context, not the whole session's history. Click any speaker's name in the feed to run the same threat check against just that one pilot.",
      "D-Scan: paste your in-game Directional Scan result exactly as copied (Ctrl+A, Ctrl+C in the D-Scan window) - it expects the real tab-separated Name/Type/Distance format and only actually uses the Type column, counting how many of each object type were detected. Any line that doesn't split into exactly those three fields is silently skipped, so an empty or wrong-looking result usually means the paste wasn't the real D-Scan format.",
    ],
    gives: "A fast read on how dangerous a room full of unfamiliar names actually is, an automatic version of the same check that needs no copy-pasting once it's set up, and an instant type-by-type breakdown of what's sitting on a directional scan.",
  },

  industry: {
    title: "Industry",
    what: "Five calculators covering the whole manufacturing pipeline: Production (build-cost), Reprocessing (mineral yield), Invention (T2 odds), Research (ME/TE planning time), and Mining Ledger (real mining history). Switch between them with the tabs at the top - each has its own help badge with the full detail.",
    how: "Pick a blueprint, item, or (for Mining Ledger) just a character, set your skills and any structure/rig/facility bonuses, and the relevant calculator does the material, time, cost, or odds math using live market prices and your real trained skill levels where relevant. Production and Reprocessing both have a \"Save as Default\" button that remembers your usual ME/TE/facility/skill setup so you don't re-enter it every visit.",
    gives: "A real build-vs-buy cost comparison, a real reprocessing yield, real invention odds, a real research timeline, and a real mining-ISK-per-day figure - all grounded in your actual skills and live prices instead of rules of thumb.",
  },
  "industry.production": {
    title: "Production",
    what: "Full recursive build-cost calculation for anything with a manufacturing or reaction blueprint - the whole material tree, not just the top-level inputs, with a build-vs-buy decision made at every single node in that tree.",
    how: [
      "Search for the item or reaction, set Runs, Material/Time Efficiency, structure type (NPC Station vs. Engineering Complex, which applies real ME/TE bonuses on top), and facility tax. Optionally pick a system to price in a real job-installation cost off that system's live industry cost index - leave it blank and the total is materials only.",
      "Calculate Build Cost shows total and per-unit cost, plus an expandable Build Steps tree where every material is tagged Build or Buy (a real decision per node, not a fixed rule) with its own cost. The Shopping List table flattens everything the tree decided to buy, re-priced live against whichever Trade Hub you pick. \"+ Add to Shopping List\" snapshots the current build (with its ME/TE/runs baked in) into a running multi-job list below that aggregates raw-material totals across every queued job - queued jobs are frozen at add time, so reconfiguring and recalculating afterward doesn't retroactively change them.",
    ],
    gives: "A real total cost, a concrete shopping list, and a running aggregated shopping list across multiple queued jobs - before you commit a blueprint to a job.",
  },
  "industry.reprocessing": {
    title: "Reprocessing",
    what: "Exact mineral/material yield from reprocessing a stack of ore, ice, or salvage, based on your real skills, facility, rig, and security-band bonuses.",
    how: "Search the item (ore/ice/salvage only), set quantity held, facility/rig/security band, your Reprocessing/Reprocessing Efficiency/Ore or Ice Processing skill levels, and any reprocessing implant. Reprocessing only ever happens in whole \"portions\" (a fixed batch size per ore type) - any amount beyond the last full portion is reported explicitly as leftover/wasted rather than silently rounded away, so you know exactly how much to actually reprocess.",
    gives: "A fast, accurate answer to \"is it worth reprocessing this, or should I just sell it?\" - and how much of your stack to reprocess to avoid wasting any of it.",
  },
  "industry.invention": {
    title: "Invention",
    what: "Success-chance and expected-cost odds for inventing a Tech II blueprint copy from a Tech I original.",
    how: "Pick the T1 blueprint (and which T2 outcome, if it has more than one), your Encryption/Datacore skills, and a decryptor if you're using one - all 8 real decryptors are modeled with their actual probability/run/ME/TE effects. Results show success chance, expected attempts per success, the resulting run count/ME%/TE% as modified by your decryptor, and Expected Cost per Success - material cost divided by probability, i.e. the real amortized cost once failed attempts are accounted for, not just one attempt's material cost.",
    gives: "The real odds and true expected cost before you spend datacores and a decryptor on an invention job.",
  },
  "industry.research": {
    title: "Research",
    what: "Time and job-count planning for running Material or Time Efficiency research on a blueprint original, from its current level up to a target.",
    how: "Pick the blueprint, research type (ME or TE - switching type auto-rescales your current/target level onto that type's valid steps), current and target level, and your Research/Metallurgy/Advanced Industry skills plus any facility/implant/rig time bonuses. Shows total jobs required (one per level step) and total time, plus a per-job breakdown, since each successive level costs progressively more time than the last.",
    gives: "A clear plan for exactly how many research jobs (and how long each one runs) it takes to fully research a blueprint to your target level.",
  },
  "industry.mining": {
    title: "Mining Ledger",
    what: "Up to 90 days of a character's own real mining history from ESI - ore/ice actually pulled from belts or sites, grouped by material and valued at EVE-wide average price.",
    how: "Pick a character if you have more than one - it loads automatically with no search or calculate step. Needs a fresh sign-in the first time, since this uses a scope added after most characters were first logged in. This is character-only; there's no corp/fleet mining-observer rollup here.",
    gives: "A real ISK-per-day read on mining (Total Value ÷ Active Days) instead of guessing, without needing a spreadsheet or a third-party fleet tool.",
  },

  "fittings-fleets": {
    title: "Fitting",
    what: "A personal fit library (built locally, or synced straight from a character's real in-game saved fits) and a full slot-by-slot fit builder with a skill/doctrine checker.",
    how: [
      "The library screen searches by name/description/ship/tags, and filters by Purpose and Source (Local vs. synced In-Game); \"Sync This Character's Fits\" pulls a character's real saved fits in from ESI. Click a card to open it in the builder, or use its trash icon to delete it outright with no confirmation.",
      "In the builder: search the left-hand item tree and click anything fittable to auto-place it in the first empty slot of the right type for your chosen ship (or open a specific empty slot's own inline search). The right-hand panel shows live Powergrid/CPU/Calibration/Drone-bay gauges (flagging over-capacity), estimated cost, and a Check Doctrine list of every logged-in character - clicking a character's row fetches their real trained skills (once per session), shows a pass/fail badge for that character on the row itself, and simultaneously puts a green-check or red-X skill badge on every individual slot and the ship itself, focused on that one character; clicking the same row again clears it. This is the only control for the per-slot skill badges - there's no separate toggle.",
      "Save Fit stores it in your library. Copy EFT/Copy DNA and \"Send Straight to In-Game Fittings\" (which pushes the fit directly into a chosen character's real in-game Fittings browser via ESI) are all disabled until the fit has been saved at least once, since they operate on the saved fit's real ID, not the in-progress draft. \"Open/Close Combat Overlay\" is unrelated to any of the above - it's a separate always-on-top window showing live DPS/reps in and out, read straight from EVE's own combat log, and works whether or not you're actively editing a fit.",
    ],
    gives: "A place to build, save, and skill-check fits (against one character or your whole roster at once) without a separate fitting website, plus a one-click path to actually get a fit into the game - pasted, or pushed straight into a character's in-game browser.",
  },

  wars: {
    title: "Wars",
    what: "Real ESI war state (declared, mutual, and allied) for a corporation or alliance - who's fighting who, and whether a war looks to be winding down.",
    how: "Pick a character from the strip to see wars for their own corp/alliance, or search any character/corporation/alliance by name to see wars for that entity directly. Each war card shows aggressor vs. defender, any allies, when it was declared, and tags for Mutual/Open for Allies/Retracted - Ending Soon; a card is highlighted if the entity you picked is an actual combatant rather than just an ally.",
    gives: "A quick check on who's at war with who before you undock somewhere risky - though this page says so itself: ESI has no direct corp/alliance-to-wars lookup at all, so results come from a recently-synced window, and a war that's been open a long time without ever being formally retracted could be missed.",
  },

  calendar: {
    title: "Calendar",
    what: "A read-only view of a character's upcoming in-game calendar events - fleet ops, corp events, anything they've been invited to.",
    how: "Pick a character if you have more than one. Click an event in the list to see its full detail on the right: exact time with a live countdown, duration, host, your response status, and its body text if it has one. ESI only ever returns the next 50 upcoming events - this isn't a full history or a far-future view, and there's no way to RSVP from here; any response shown is whatever you already set in the client.",
    gives: "A way to see what's scheduled without opening the client.",
  },

  multiboxing: {
    title: "Multiboxing",
    what: "Live thumbnail previews of every running EVE client, each its own independent floating desktop window separate from VESPER's own - stays strictly view-only, exactly like EVE-O Preview: VESPER never sends keyboard or mouse input into a client, it only mirrors what's on screen and can bring a window to the foreground.",
    how: [
      "\"Open Floating Preview\" creates one small window per detected client; a plain click on any preview restores and foregrounds the matching EVE client - dragging a preview instead moves it, and dragging its edge resizes it (unless positions/sizes are locked in settings). Hover-zoom, if enabled, temporarily enlarges whichever preview your mouse is over.",
      "Settings cover: always-on-top, locking positions/sizes globally, hiding the focused client's own preview, auto-minimizing every client except the focused one, remembering each client's position/size per character name across sessions, thumbnail opacity/default size, hover-zoom factor and anchor point, and overlay chrome (label, frame, focus-highlight, each with their own color). A per-client hotkey recorder lets you assign a global keyboard shortcut (must include a modifier key, so it can never hijack a plain key from every other app) to instantly restore and foreground that specific character from anywhere on your PC, even while a totally different window has focus - hotkeys are tied to character name, not to a specific running window, so they keep working across relogs.",
      "The Profiles bar saves your entire current settings block under a name, so you can flip between whole named layouts (e.g. a \"PvP\" setup vs. a \"Mining\" one) instead of re-toggling every option by hand.",
    ],
    gives: "A fast way to see and switch between every logged-in character without alt-tabbing blind, plus global hotkeys and saved layouts once you've got it set up the way you like.",
  },

  settings: {
    title: "Settings",
    what: [
      "Two top-level tabs: General (character/scope management and every app-wide preference) and Settings Sync (a tool that copies one character's real EVE client settings file onto others).",
    ],
    how: [
      "General, section by section: Characters & Scopes lists every logged-in character with a \"View scopes\" expander (translating raw ESI permission strings into plain English), a Remove button (logs out immediately after a confirm, no undo), and \"+ Add / Re-authenticate\" for new sign-ins or refreshing an existing character's granted scopes. Notifications has a master on/off (prompts Windows for OS notification permission the first time) plus independent toggles for proximity kill alerts, new wormhole mapped, skill queue empty, skill queue running low under an editable hour threshold, and tracked-player kills/deaths - that last one always shows an in-app bell/toast regardless of this toggle, which only controls whether it also fires a native OS notification. Tracked Players/Corps/Alliances here is the exact same watchlist as Kills & Intel's own tab, not a separate one. Proximity Alert Sound has its own on/off plus a Test Sound button - the red screen flash itself always happens regardless of this setting, only the sound is gated. Default Trade Hub sets which of the 5 hubs every hub-aware page opens to by default. Display has \"Reduce motion\" (stops the queue-training pulse and proximity-flash animations specifically, not all animation) and a Default Landing Tab picker for which page the app opens on. Sidebar has Reset Icon Colors/Reset Nav Order buttons - per-icon colors and drag-reordering both already save automatically as you make them, these two only exist to undo all of that in bulk. Reference Data has a Re-sync button that redownloads just the market/industry catalog from CCP's static data export. About shows your version, a Check for Updates button (never installs anything without you clicking \"Update & Restart\"), Open Data Folder, and links to GitHub Issues/Discussions.",
      "Settings Sync is the tool for copying one character's real EVE client settings (overview presets, UI layout, keybinds, channel list, and more) onto another character or account - the same operation external \"EVE settings manager\" tools do, plus built-in backup/restore. It auto-detects EVE's real settings folder (with a manual folder picker as a fallback), lets you pick a server and one of EVE's own \"Settings Profile\" tabs (with rename/duplicate/delete and a New Profile button), then shows a two-column picker: radio buttons for the source file, checkboxes for one or more destinations - destinations are automatically restricted to the same file type as the source (per-character files only ever sync to other per-character files, and likewise for account-level files), so you can never cross-sync the wrong kind by accident.",
      "The sync itself is a full raw-byte replace of the destination file, not a selective merge - there's no \"just copy the overview\" option, it's the whole file or nothing. Clicking \"Sync to N File(s)\" pops a confirmation naming exactly what will happen before anything is touched, and every destination file that already exists gets automatically backed up (its pre-sync bytes saved into VESPER's own backup store) immediately before being overwritten - this is not an optional step. The Backups list at the bottom is the safety net for all of this: every backup, whether automatic or one you triggered manually, is listed with its own Restore (copies it back to exactly where it came from) and Delete (removes only VESPER's stored copy, never touches the live game file) actions.",
    ],
    gives: "Full control over how VESPER behaves without hunting through menus on every screen it affects, and a safe, backed-up way to keep every character's EVE client settings in sync without manually copying files yourself.",
  },
};
