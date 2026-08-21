# VESPER

A desktop companion app for [EVE Online](https://www.eveonline.com/), built with Tauri, React, and Rust. VESPER lives alongside the game client and gives you a live map, kill/intel feeds, wallet and industry tools, wormhole pathing, and more — all backed by your own EVE SSO login and ESI data.

> **VESPER is an unofficial, third-party fan project.** It is not affiliated with, endorsed by, or sponsored by CCP hf. EVE Online and all related trademarks and imagery are property of CCP hf.

## Features

- **Dashboard** — at-a-glance overview for every logged-in character: wallet, skill queue, location, and more.
- **Map** — a full New Eden starmap with a live kill-activity heatmap, proximity alerts, constellation boundaries, and player-structure markers.
- **Kills & Intel** — recent kills, tracked systems/entities, and full killboard views for characters, corporations, alliances, and regions.
- **Path & Wormhole Finder** — route plotting across stargates *and* wormhole connections, with a visual chain map, Eve Scout signature import, and auto-mapping as you fly.
- **Wallet & Market** — balance, transactions, contracts, and a market browser/price checker.
- **Industry** — production, reprocessing, invention, and research cost calculators with real-time market pricing.
- **Planetary Industry**, **Fittings & Fleets**, **Wars**, **Mail**, **Calendar**, **Intel Check** — a read-only Mail inbox, an in-app fit builder, active-war tracking, and more.
- Runs entirely on your own EVE SSO login — VESPER never sees your password, and character data stays local.

## Installing

Grab the latest installer from the [Releases](../../releases) page and run it — no Rust or Node.js required.

Windows may show an "unrecognized publisher" warning on first launch (VESPER isn't code-signed); this is normal for an indie/hobby tool.

## Building from source

Requires [Node.js](https://nodejs.org/) and [Rust](https://www.rust-lang.org/tools/install), plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
npm install
npm run tauri dev    # run in development
npm run tauri build  # produce a release installer
```

## License

VESPER's own code is licensed under the [MIT License](LICENSE). This does not extend to EVE Online's trademarks, imagery, or data, which remain the property of CCP hf.
