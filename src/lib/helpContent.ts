/** Copy shown by HelpBadge - one entry per top-level nav page (keyed by
 * Sidebar.tsx's NAV_ITEMS id) plus a few entries for sub-tabs on pages
 * bundling genuinely different tools under one nav item (currently just
 * Industry's four calculators, keyed as "industry.production" etc.). */
export interface HelpContent {
  title: string;
  what: string;
  how: string;
  gives: string;
}

export const HELP_CONTENT: Record<string, HelpContent> = {
  dashboard: {
    title: "Dashboard",
    what: "Your home screen - every logged-in character shown as a card with wallet balance, skill queue, current location, and ship, refreshed automatically in the background.",
    how: "Click a character's card to open their full detail view (skills, assets, contracts, mail, standings, and more). Use \"Add Character\" in the top bar to log in another account via EVE SSO.",
    gives: "A fast way to check in on your whole roster without opening each character individually.",
  },
  kills: {
    title: "Kills & Intel",
    what: "Live and historical killmail data from zKillboard - a recent-activity feed, battle clustering, zKillboard-style Kill Reports filters (Top Kills, Capitals, Structures, Abyssal, Awox, Ganked, Solo, and more), an hourly Top Stats leaderboard, and full killboard lookups for any character, corporation, alliance, system, or region.",
    how: "Search a name at the top to open its killboard, or browse the tabs below: Tracked Systems / Most Recent Kills / Battles for the live feed, Kill Reports to filter by kill type, and Top Stats for who's been killing (and dying) the most in the last hour. Kill Reports and Top Stats both run off VESPER's own local kill history, which fills in more completely the longer the app stays open.",
    gives: "Situational awareness on where fights are happening right now, a deep-dive killboard for anyone you're checking up on, and the same kind of classification/leaderboard views zKillboard itself offers.",
  },
  map: {
    title: "Map",
    what: "A full New Eden starmap with a live kill-activity heatmap - systems glow and pulse brighter the more kills just happened there.",
    how: "Search for a system to jump to it, click a number under \"Nearby\" to set a jump radius for proximity kill alerts (these keep working even on other screens), and scroll/drag to explore. \"Key\" and \"Icons\" toggle the legend and station-service markers.",
    gives: "A live read on where danger or opportunity is right now, plus an alert the moment a kill lands near wherever you've marked as your current system.",
  },
  "path-wormhole-finder": {
    title: "Path & Wormhole Tracker",
    what: "Route planning across both stargates and wormhole connections, a visual chain map for tracking a wormhole system as you explore it, and a capital jump-drive route planner.",
    how: "Set a start and destination for a stargate-and-wormhole-aware route, or open/create a chain and map connections as you scan and jump - turn on auto-map for a chain and it fills in automatically as your tracked character moves. Use the Capital toggle to plan a jump-drive route: pick a ship and a jump order for your waypoints to see fuel, cooldown, and fatigue per leg.",
    gives: "Routes that actually account for wormholes instead of just gates, a live, always-current map of your current wormhole chain, and the fuel/fatigue cost of a capital jump route before you commit to it.",
  },
  wallet: {
    title: "Wallet & Market",
    what: "Your ISK balance, wallet journal and transactions, market orders and contracts, plus a market browser and price checker.",
    how: "Switch characters at the top. Browse the wallet journal to see where ISK is coming from and going, check Contracts/Orders for what's active, or use the Market Browser and Appraisal tools to look up what something's actually worth.",
    gives: "One place to track your finances and sanity-check prices before you buy or sell.",
  },
  "wallet.screener": {
    title: "Screener",
    what: "Two scan modes over a market category you pick: Same-Region Spread (buy/sell margin within one region) and Inter-Region Hauling (buy at a source region, haul, and sell at a destination region - ranked by profit per m³ of cargo).",
    how: "Drill into a category on the left, pick your region(s) for the mode you're in, then Scan - it checks up to 50 items in that category's live order books. Hauling mode needs two different regions picked.",
    gives: "A fast way to find real, currently-live arbitrage instead of guessing which items are worth flipping or hauling.",
  },
  "wallet.lpstore": {
    title: "LP Store",
    what: "Every item purchasable with loyalty points at any corporation you've earned LP with, ranked by estimated ISK profit per LP spent - not just the raw LP price.",
    how: "Pick a corporation from your LP balances, then browse its store. Each row already accounts for the ISK cost, any items you'd need to turn in alongside your LP, and the reward's market value - sort follows automatically, highest ISK/LP first.",
    gives: "A fast answer to \"which of my LP is actually worth converting to ISK right now\" instead of eyeballing raw LP costs.",
  },
  "wallet.itemdb": {
    title: "Item Database",
    what: "A browsable catalog of every item in the game, laid out category → group → item, in the same style as db.evetools.org - not just ships, everything from modules to charges to skillbooks.",
    how: "Drill down through categories and groups on the left, click an item for its full detail view (attributes, fittable slot, real-time price). From a ship's detail view, \"Fit This Ship\" jumps straight into the Fit Builder with that hull already loaded.",
    gives: "A fast way to look up what an item actually does without leaving VESPER, and a shortcut straight into fitting a ship you just found.",
  },
  planetary: {
    title: "Planetary Industry",
    what: "A planning reference for planetary interaction - which planet types yield which raw materials, and the full P0-P4 production chain for any commodity. Not a live colony view.",
    how: "Search for a commodity to see its full production chain, or browse by planet type to see what it can produce.",
    gives: "Everything you'd otherwise need the wiki for when setting up or optimizing a PI chain.",
  },
  mail: {
    title: "Mail",
    what: "A read-only view of your in-game mail inbox.",
    how: "Pick a character at the top, then browse and open mail the same way you would in the client.",
    gives: "A quick way to check mail without alt-tabbing into the game.",
  },
  "intel-check": {
    title: "Intel Check",
    what: "A bulk affiliation lookup for chat-list-style pastes of pilot names.",
    how: "Paste a list of names - e.g. copied straight out of a local chat window - and it resolves each one's corporation and alliance.",
    gives: "A fast way to vet a list of unfamiliar names: who's actually in that fleet, and whether anyone's a real threat.",
  },
  industry: {
    title: "Industry",
    what: "Blueprint and manufacturing tools covering four different jobs: production cost, reprocessing yield, invention odds, and ME/TE research planning. Use the tabs at the top of the page to switch between them - each has its own help badge with more detail.",
    how: "Pick a blueprint or item, set your skills and structure bonuses, and the relevant calculator handles the material, time, and cost math using live market prices.",
    gives: "A real build-vs-buy cost comparison before you commit to a manufacturing job.",
  },
  "fittings-fleets": {
    title: "Fitting",
    what: "An in-app ship fitting builder with saved fits, plus fleet composition tooling.",
    how: "Build a fit slot by slot, save it for later, or export it (EFT/DNA format) to paste into the game client or elsewhere.",
    gives: "A place to plan and store fits without needing a separate fitting website.",
  },
  wars: {
    title: "Wars",
    what: "Active wars involving the corporations and alliances you care about.",
    how: "Search for an entity to see its current wars, along with aggressors and defenders on each side.",
    gives: "A quick check on who's at war with who before you undock somewhere risky.",
  },
  calendar: {
    title: "Calendar",
    what: "Your upcoming in-game events and fleet ops.",
    how: "Pick a character to view their calendar, then click an event for its full details.",
    gives: "A way to see what's scheduled without opening the client.",
  },
  multiboxing: {
    title: "Multiboxing",
    what: "Live thumbnail previews of every running EVE client, shown in a floating window separate from VESPER's own - stays view-only, exactly like EVE-O Preview: no keyboard or mouse input is ever sent to a client, it only mirrors what's already on screen.",
    how: "Click \"Open Floating Preview\" to launch the window - drag it anywhere on your desktop. Click any thumbnail to bring that client to the foreground. It keeps running even if VESPER is minimized or on a different tab.",
    gives: "A fast way to see and switch between every logged-in character without alt-tabbing blind.",
  },
  settings: {
    title: "Settings",
    what: "Account and preference management - logged-in characters and their granted scopes, notifications, default trade hub, and other app-wide preferences.",
    how: "Each section handles one area (characters, notifications, industry defaults, sidebar, and so on) - change what you want and it takes effect immediately, no save button needed.",
    gives: "Control over how VESPER behaves without hunting through menus on every screen it affects.",
  },
  "industry.production": {
    title: "Production",
    what: "Full build-cost calculation for anything with a manufacturing blueprint - the whole material tree, not just the top-level item.",
    how: "Search for the item you want to build, set ME/TE, runs, and any structure bonuses, then hit Calculate. Each material shows build-vs-buy cost so you can see where building it yourself actually saves ISK.",
    gives: "A real total cost (and a shopping list of what to buy) before you commit a blueprint to a job.",
  },
  "industry.reprocessing": {
    title: "Reprocessing",
    what: "How many minerals/materials you'll get back from reprocessing a stack of items, based on your skills and the facility you're using.",
    how: "Search for the item, set the facility/rig/security bonuses and your reprocessing skills, and it calculates the yield.",
    gives: "A fast answer to \"is it worth reprocessing this, or should I just sell it?\"",
  },
  "industry.invention": {
    title: "Invention",
    what: "Success-chance and output odds for inventing Tech II blueprint copies from Tech I originals.",
    how: "Pick the T1 blueprint, choose a decryptor (or none), and set your relevant skills - it shows the invention chance and what run/ME/TE the resulting T2 BPC will have.",
    gives: "The real odds and expected outcome before you spend datacores and a decryptor on an invention job.",
  },
  "industry.research": {
    title: "Research",
    what: "Time and cost planning for running ME and TE research jobs on a blueprint original.",
    how: "Pick the blueprint and target ME/TE level - it shows how many research runs that takes and how long each one runs for.",
    gives: "A clear plan for how long (and how many job slots) it'll take to fully research a blueprint.",
  },
  "industry.mining": {
    title: "Mining Ledger",
    what: "Up to 90 days of a character's own mining history from ESI - what you actually pulled out of every belt/site, by ore or ice type, valued at EVE-wide average price.",
    how: "Pick a character (if you have more than one) - it loads automatically. Needs a fresh sign-in the first time, since this uses a scope added after most characters were first logged in.",
    gives: "A real ISK-per-day read on mining instead of guessing, without needing a spreadsheet or a third-party fleet tool.",
  },
};
