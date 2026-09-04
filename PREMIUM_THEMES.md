# Premium Deck Themes

Three premium themes - **Bulkhead**, **Cold Ballast**, and **Command Deck** -
built as a genuinely different design system on top of VESPER, not a color
palette layered over the existing UI. Switching from a standard theme to one
of these changes shape, typography, component construction, and behavior,
not just hue.

The six standard themes (Dark, Light, Analog Signal, Night Static, Dusk
Horizon, YC Retro, Phosphor Deck) are **unchanged** - functionally and
visually identical to before this work. Every rule described below is gated
behind `:root[data-theme="bulkhead"|"cold-ballast"|"command-deck"]` and does
nothing at all otherwise; verified directly against the running app (see
"How this was verified" below), not just by inspection.

## Architecture

```
src/themes/premium/
  premium-tokens.css      full ~50-var token sheet x3, + construction tokens
  premium-structure.css   shared component language every deck reads through
  bulkhead.css            Bulkhead-only geometry
  cold-ballast.css        Cold Ballast-only geometry
  command-deck.css        Command Deck-only geometry

src/components/premium/
  StatusLamp.tsx          physical indicator lamp (housing/unlit/lit/bloom)
  TechnicalLabel.tsx      small etched-plate reference marking
```

All five CSS files import from `App.tsx`, after `App.css`. Each is a plain
stylesheet, not a JS module - the split exists purely so the six standard
themes and the premium system can never collide while editing one or the
other, and so a future fourth deck is one more `.css` file plus one line in
each shared selector list, not a rewrite.

**`useTheme.ts` was refactored** to broadcast theme changes over a
`window` `CustomEvent` instead of relying on `usePersistentState`'s plain
`useState`. This mattered for real: the previous implementation meant two
separate components calling `useTheme()` had two unsynced copies of the
theme value - the persistent `TopBar` (never unmounted between tab
switches) would keep rendering whatever it read at its own mount time until
a full reload, even after `SettingsPage` changed the theme. Every
`useTheme()` call site now stays live-synced the instant *any* of them
calls `setTheme`, with the exact same external API (`[theme, setTheme] as
const`) so no call site needed to change. A new `isPremiumTheme(theme)`
helper is exported alongside it.

## What actually changes

| Layer | What changes | Where |
|---|---|---|
| **Color** | Full token sheet per deck - surfaces, text, accent/status, kill-mail colors, ISK, standings, the 10-step security gradient, each running its own "safe → danger" hue family | `premium-tokens.css` |
| **Shape** | `--radius-sm`/`--radius-md` zeroed (→ ~225 existing consumers go hard-edged for free); chamfered `clip-path` notch + corner brackets on `.dashboard-header`/`.market-stat-card`; per-deck geometry (Bulkhead hazard band + rivets + chamfered nav; Cold Ballast containment-ring chips + vertical accent rail; Command Deck segmented double-line framing) | `premium-structure.css` + per-deck files |
| **Type** | `--font-label` repointed per deck (Oswald / Saira Condensed / Saira Condensed); `--font-display` per deck (Oswald / Orbitron / Exo 2); every label-style element forced uppercase + tracked; numeric readouts forced to the new global `--font-mono` (Share Tech Mono) with `tabular-nums` and a phosphor glow. Prose (`--font-body`) is never touched | `premium-structure.css` |
| **Weight** | Full button physics - resting housing shadow, hard press-and-lock (`translateY` + shadow collapse, zero easing), a distinct "latched" look for persistent toggle states (tabs, radius filters, label chips), disabled buttons rendered as visibly unpowered (`grayscale`+`brightness` filter, no depth) rather than just faded | `premium-structure.css` |
| **Indicators** | `StatusLamp` - real layered housing (bevel ring → unlit/lit core → bloom), circular and rectangular variants, wired into the shared `StatusChip` component so every existing usage app-wide (server status, character connection, etc.) picks it up automatically | `StatusLamp.tsx`, `StatusChip.tsx` |
| **Navigation** | Sidebar reads as a breaker rack - thicker frame, a real indicator lamp per nav item (CSS-only, no JSX change) that energizes on the active route instead of just recoloring text; drag-to-reorder's own transform is left completely alone | `premium-structure.css` |
| **Everything else in the "first pass scope"** | Tabs (switch-bank rail), tables (structural dividers + accent rail header), forms/inputs (recessed "dial" housing), tooltips (`.help-badge-popover` → inset diagnostic screen), the global error modal (→ alert annunciator panel), toasts (→ annunciator strip), loading skeletons (→ stepped scanning tick instead of a smooth shimmer), scrollbars (thin/high-contrast) | `premium-structure.css` |
| **Atmosphere** | One full-viewport signature layer per deck, `z-index: 500` (above normal content, below the toast/banner/kill-alert overlays at 9997-9999): Bulkhead a worn porthole vignette, Cold Ballast a CRT scanline raster, Command Deck a diagonal glass sheen | per-deck files |
| **Motion** | A ~340ms ignition flicker + one-line boot label (`BUS CHECK // LINK OK`, `SYS.LINK — SYNC`, `NAV.LOCK — READY`) plays on every page mount, via the one universal `<main className="main ...">` wrapper all 25 page components already share - zero JSX changes needed anywhere | `premium-structure.css` + per-deck `content` |
| **Degradation** | A real (not decorative) RGB-split/power-sag flicker, `.premium-signal-degraded` on `document.body` for 650ms, triggered from exactly one place: `useErrorReporter`'s `reportError` - the single choke point every error path in the app already goes through. Never fires ambiently | `useErrorReporter.tsx` + `premium-structure.css` |
| **Accessibility** | Every animation this system introduces (boot flicker, lamp blink, scan-tick loading, degrade flicker) has a static fallback under both the OS `prefers-reduced-motion: reduce` media query and the app's own in-app Reduce Motion toggle (`body[data-reduce-motion="true"]`) - verified live, not just written | `premium-structure.css` |
| **Sound** | Architecture only, deliberately not wired to real audio yet - see "Sound" below | `lib/sound.ts`, `usePremiumSoundEnabled.ts` |

### The three decks

| Deck | Mood | Display / label font | Accent | Signature geometry |
|---|---|---|---|---|
| **Bulkhead** | Gritty industrial freighter - rust, hazard amber, a reactor overdue for a teardown | Oswald / Oswald | `#d98c2b` | Hazard-stripe header band, corner rivets, chamfered nav items, thick 4px sidebar frame |
| **Cold Ballast** | Submarine ops / bio-lab - pressure hulls, tank glass, chilled clinical light | Orbitron / Saira Condensed | `#35c9c9` | Containment-tube double-ring chips, vertical accent rail on the page header, CRT scanline raster |
| **Command Deck** | Bridge glass / warm switch banks - HUD blue readouts paired against amber physical switches | Exo 2 / Saira Condensed | `#4f7dff` | Segmented double-line chip framing, tactical-glass header glow, diagonal sheen |

## Sound

`src/lib/sound.ts`'s existing pattern (a bundled MP3 asset, imported
directly so Vite resolves it at build time, played through a lazy-singleton
`<Audio>` element) is what `playProximityAlert`/`playNotificationPing`
already use - there's no Rust-side audio engine anywhere in this app, and
none was added. `playPremiumRelayClick`/`playPremiumMechanicalThrow` exist
as no-ops in the same file, plus a real `usePremiumSoundEnabled` settings
hook (`vesper.premium.soundEnabled`, defaults on) - deliberately not wired
to actual samples, since a static `import ... from "nonexistent.mp3"` would
fail the build rather than degrade gracefully, and inventing a low-quality
placeholder clip isn't better than no sound. When real "mechanical relay
click" / "heavy breaker throw" samples exist, bundling them the same way
the existing two sounds are bundled turns these into real functions with no
other call-site changes needed.

## Bugs caught and fixed during the build

- **Corner brackets vs. the clip-path notch.** The corner-bracket
  pseudo-elements were first positioned on the same two corners the
  chamfer notch cuts away - `clip-path` clips an element's own
  `::before`/`::after` along with everything else, so the brackets
  would've been invisible. Moved to the opposite diagonal.
- **Clip-path clipping real dropdowns.** `.industry-inputs-panel` and
  `.settings-section` sometimes host an autocomplete suggestion dropdown
  (`.gatecheck-slot-results`, `position: absolute; top: 100%`) that
  renders below the panel. `clip-path` clips a box's overflow regardless
  of its `overflow` property, so notching those two would have silently
  cut real, functional dropdowns off. Both keep the inset-bevel shadow
  (purely decorative) but not the notch; only `.dashboard-header` and
  `.market-stat-card` get the full chamfer.
- **`TechnicalLabel` changing standard-theme output.** First draft always
  rendered its text; dropped into the shared sidebar footer (rendered by
  every theme), that would have added new visible text with no styling to
  make sense of it under the six standard themes. Now renders `null`
  unless `isPremiumTheme(theme)`.
- **Unsynced `useTheme()` instances.** Caught while designing `StatusLamp`
  - see the `useTheme.ts` refactor above.
- An earlier draft accidentally left a literal `$PREMIUM_SELECTOR$`
  placeholder in several selectors (a comma-separated list can't share a
  compound-selector prefix - `:root[a], :root[b] .foo` matches `:root[a]`
  alone OR `.foo` under `:root[b]`, not `.foo` under either) - caught via
  a brace/selector sanity pass before it shipped.

## How this was verified

`npx tsc --noEmit` is clean, and both a programmatic brace-balance check
and a manual read pass ran on every new CSS file. Beyond that, the running
dev app was actually opened in a browser pointed at the Vite dev server
(`http://127.0.0.1:1520`) and inspected live:

- Switched `data-theme` between all three decks and read back
  `getComputedStyle` on real rendered elements (the login screen, the
  global error modal, its heading and button, `body::after`) - confirmed
  exact background colors, `border-radius: 0px`, the right `font-family`
  per deck, the right `box-shadow` housing values, and each deck's own
  distinct atmosphere `background-image` (radial vignette / scanline
  raster / diagonal sheen - three different values, not one shared rule).
- Switched back to the standard `"dark"` theme and confirmed the same
  elements revert exactly - `border-radius: 8px` on the modal,
  `background-image: none` on `body::after` - proving no premium rule
  leaks into a standard theme.
- Set `body[data-reduce-motion="true"]` and confirmed a `.skeleton-row`'s
  computed `animation-name` resolves to `none`, not just written that way.

ESI-authenticated screens (dashboard, sidebar with a live session, etc.)
couldn't be exercised this way - the plain browser has no Tauri IPC bridge,
so any page that calls `invoke()` throws immediately (this is also what's
firing the repeated "Live kill stream error" during this testing - happens
on the standard themes too, it's a pre-existing artifact of loading the
app outside Tauri, not something introduced here). The native app window
was left running throughout and confirmed alive afterward.

## Round two: page layouts, not just component skins

The first pass covered shared components everywhere (buttons, tabs,
tables, forms, tooltips, modals, toasts, loading states) - real, but it
meant every page still had the *same arrangement* of content, just
reskinned. This pass changed two actual pages' composition, not their
components:

- **Map** (`MapView.tsx` + `.map-canvas-wrap` in `premium-structure.css`):
  the canvas itself now resolves `--accent`/`--danger`/`--gate` at draw
  time via a new `hexToRgbTriple()` helper, replacing four places that
  were hardcoded to the *original dark theme's* exact hex values
  (`rgba(111, 195, 217, ...)` cyan for the constellation hulls and the
  ticker-hover ring, `rgba(255, 90, 60, ...)` for the active-kill pulse,
  `rgba(240, 192, 74, ...)`/`"#f0c04a"` for the current-location marker)
  regardless of which theme was active - **a real bug fixed for all nine
  themes**, not just the three premium ones; a cyan ring on an
  amber-and-rust Bulkhead map, or the home marker's roof/body panel
  always rendering in the default theme's exact `#1a1c21`/`#131418`, was
  wrong before this on every non-default theme. On top of that, premium
  themes get a decorative instrument layer over the canvas - an inset
  bezel ring, a slow 14s long-range-scanner sweep (`mix-blend-mode:
  screen`, reduced-motion-aware), and the search bar/layer toggles/kill
  ticker rail restyled as console chrome instead of website widgets. None
  of this touches the canvas draw loop's actual logic, only its color
  inputs and a DOM layer sitting on top of it.
- **Dashboard** (`Dashboard.tsx` + `.dashboard-home` in
  `premium-structure.css`): real layout re-composition via CSS Grid, not
  a re-skin of the same stack. `.dashboard`/`.dashboard-header` turned out
  to be shared by three *other* pages (Industry, Mining, Multiboxing)
  reusing those same generic classes for their own different content, so
  the home page got one new class, `dashboard-home`, to target precisely.
  Its two ticker widgets (`NewsTicker` and `LiveActivityTicker` - which
  already happen to share the exact class `news-ticker`) go from
  full-width-stacked to an asymmetric 2:1 side-by-side split via
  `grid-template-areas`, using the adjacent-sibling combinator
  (`.news-ticker + .news-ticker`) to tell the two apart by position
  rather than a class neither one uniquely has. Collapses back to the
  standard stacked order under 900px. Verified directly: injected a
  synthetic `.dashboard-home` tree into the running page and confirmed
  both the wide-viewport 913px/457px column split and the narrow-viewport
  stacked fallback resolve exactly as written.

## Round three: a real component library + a rebuilt Dashboard

The `VESPER_PREMIUM_BRIDGE_ENVIRONMENTS_MASTER_PROMPT.md` directive asked
for something categorically bigger than a styling pass - a real hardware
component library and a Dashboard whose actual composition, not just its
skin, is different under a premium deck. Built per that document's own
phase order (A: shell primitives, B: hardware library, C: rebuild the
Dashboard; D/E/F - visual review, a second radical page, full propagation
- are the explicit next steps, not done here):

- **`src/components/premium/`** gained four new primitives: `Annunciator`
  (a rectangular backlit indicator built on `StatusLamp`'s housing, states
  `on`/`off`/`warn`/`danger`), `MechanicalButton` (a heavier, distinct
  control from the generic button treatment every `<button>` already gets
  - thicker housing, zero-easing press, reserved for a page's actual
  primary actions), `TelemetryRail` (a strip of small labelled readouts),
  and `ScreenHousing` (the bezel-over-recessed-display construction layer
  - a title strip on the console plane, content on the display plane).
- **`PremiumDashboard.tsx`** - a genuinely different composition, not a
  reskinned character grid: a command-status header, three zones side by
  side (SYS STATE / CAPSULEER STATUS - the real character cards, reused
  as-is / ALERT BANK), a telemetry rail of aggregate real numbers, then
  the existing tickers reframed as two auxiliary monitors. Every lamp and
  number in it is derived from data `Dashboard.tsx` already fetches -
  connected-character count, summed ISK/SP across `CharacterOverview`,
  how many are training, how many need reauth, whether sign-in is
  pending - nothing invented. `Dashboard.tsx` itself changed only at its
  `return`: same hooks, same effects, same fetching, branching to
  `<PremiumDashboard>` only when `isPremiumTheme(theme)`, per the
  directive's own "share logic, separate presentation" pattern.
- **New stylesheet: `premium-instruments.css`** - deliberately *not*
  scoped behind `:root[data-theme="x"]` the way `premium-structure.css`
  is. Its classes (`.annunciator`, `.mechanical-button`, `.screen-housing`,
  `.telemetry-rail`, `.premium-dashboard*`) are brand new and only ever
  rendered by components that already sit behind an `isPremiumTheme`
  check, so there's nothing under a standard theme for these selectors to
  ever match - the safety property the scoping exists for elsewhere is
  already guaranteed here by which components exist. Colors still resolve
  correctly per deck through ordinary `var(--accent)`/`var(--deck-*)`
  inheritance.

### Two real specificity bugs caught by testing, not just written

Both were confirmed live - injected the actual markup into the running
dev server and read back `getComputedStyle`, not just reasoned about it:

- **`.mechanical-button` silently lost to the generic button rule.**
  `premium-structure.css`'s generic press-and-lock is scoped
  `:root[data-theme="x"] button:not(.nav-item):not(:disabled)`, which
  carries more specificity (the `:root[data-theme="x"]` prefix alone adds
  two points) than an unscoped `button.mechanical-button:not(:disabled)`
  - so `.mechanical-button`'s own box-shadow/transform/transition were
  being silently overridden despite loading later in the cascade.
  Confirmed live: `box-shadow` computed to the generic rule's `0 3px 0`,
  not `.mechanical-button`'s own `0 5px 0`. Fixed by excluding
  `.mechanical-button` from the generic rule everywhere it appears
  (`button:not(.nav-item):not(.mechanical-button)`), the same pattern
  already used for `.nav-item` - explicit mutual exclusion instead of a
  specificity fight.
- **`.mechanical-button-primary`'s border color lost to its own base
  rule.** A single-class selector (`.mechanical-button-primary`) has
  lower specificity than the element+class base rule
  (`button.mechanical-button`) that sets the same `border` shorthand -
  confirmed live (`border-color` computed to the neutral base color, not
  the accent). Fixed by matching specificity:
  `button.mechanical-button.mechanical-button-primary`.

## Extending later

Add a fourth deck by: adding its `ThemeId`/`THEMES` entry (`tier:
"premium"`) in `useTheme.ts`; adding a `:root[data-theme="..."]` token
sheet to `premium-tokens.css` (~50 vars + the `--deck-*` construction set);
extending every comma-separated selector list in `premium-structure.css`
with the new `data-theme` value; and writing its own geometry file
following the shape of `bulkhead.css`/`cold-ballast.css`/`command-deck.css`
(at minimum: a `.main::before { content }` boot label and a `body::after`
atmosphere layer - everything else is optional differentiation).
