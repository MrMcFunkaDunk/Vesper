# VESPER

A desktop companion app for [EVE Online](https://www.eveonline.com/), built with Tauri, React, and Rust. VESPER lives alongside the game client and gives you a live map, kill/intel feeds, wallet and industry tools, wormhole pathing, and more — all backed by your own EVE SSO login and ESI data.

> **VESPER is an unofficial, third-party fan project.** It is not affiliated with, endorsed by, or sponsored by CCP hf. EVE Online and all related trademarks and imagery are property of CCP hf.

## Features

- **Dashboard** — at-a-glance overview for every logged-in character: wallet balance, skill queue, current location, and clone state.
- **Map** — a full New Eden starmap with a live kill-activity heatmap, proximity alerts, constellation boundaries, player-structure markers, and a system stats popup (celestials, stations/services, jump and kill history).
- **Kills & Intel** — recent kills, tracked systems/entities, full killboard views for characters/corporations/alliances/regions, automatic battle report clustering (nearby kills grouped into one fight with combined ISK and participants), a live combat-log DPS/logi overlay window that floats over the game client, zKillboard-style Kill Report filters (Top Kills, Capitals, Structures, Abyssal, Awox, Ganked, Solo, and more) backed by a local rolling 30-day kill history with a one-click backfill, and an hourly Top Stats leaderboard with character/corp/alliance portraits.
- **Intel Check** — paste Local chat, a Directional Scan result, or a wormhole signature chain and get an instant read on who or what's there.
- **Path & Wormhole Tracker** — route plotting across stargates *and* wormhole connections, a visual chain map, EVE Scout Thera/Turnur signature import, auto-mapping as you fly, and a capital jump-drive route planner (real light-year distances, fuel, jump cooldown, and fatigue per leg).
- **Wallet & Market** — balance, transactions with realized FIFO profit/loss, contracts with buy-vs-market-value profitability, an LP store browser ranked by ISK-per-LP, a market browser/price checker with an always-on-top floating price widget, and a screener with same-region spread and inter-region hauling modes.
- **Industry** — production, reprocessing, invention, and research cost calculators with real-time market pricing, a multi-job shopping list that aggregates raw materials across every queued build, and a personal mining ledger valued at EVE-wide average prices.
- **Fitting** — a full fit builder with slot-accurate fitting, a skill-vs-fit flyability check (one character or a whole doctrine roster at once, with a hover tooltip for exactly what's missing), and abyssal/mutated module pricing via MutaMarket.
- **Multiboxing** — click-to-focus window previews with a highlight outline, per-character global hotkeys, and named settings profiles you can save and swap between.
- **Settings** — an EVE client settings sync tool (copy one character's client settings to every other character, with an automatic backup before every overwrite), and CSV export for assets, wallet, and market data.
- **Planetary Industry**, **Wars**, **Mail**, **Calendar** — planetary colony tracking, active-war tracking, a read-only Mail inbox, and a calendar view.
- Runs entirely on your own EVE SSO login — VESPER never sees your password, and character data stays local.
- Checks for new versions on launch and offers a one-click update — never installs anything without you clicking first.

## Installing

Grab the latest installer from the [Releases](../../releases) page and run it — no Rust or Node.js required.

Windows may show an "unrecognized publisher" warning on first launch (VESPER isn't code-signed); this is normal for an indie/hobby tool.

Once installed, VESPER checks for updates on launch and will offer to update itself when a new version ships.

## Feedback & issues

VESPER is an early build, not a finished product — expect rough edges.

- 🐛 Found a bug, or something feels broken? Open an [Issue](../../issues).
- 💬 Have a feature idea, general feedback, or just want to talk about it? Use [Discussions](../../discussions) instead.

## Building from source

Requires [Node.js](https://nodejs.org/) and [Rust](https://www.rust-lang.org/tools/install), plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
npm install
npm run tauri dev    # run in development
npm run tauri build  # produce a release installer
```

## License

VESPER's own code is licensed under the [MIT License](LICENSE). This does not extend to EVE Online's trademarks, imagery, or data, which remain the property of CCP hf.
