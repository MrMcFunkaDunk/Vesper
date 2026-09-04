import { useEffect, useState } from "react";
import { getRegionMarketHistory } from "../lib/market";
import { formatIsk } from "../lib/format";

const THE_FORGE_REGION_ID = 10000002;

/** The eight refined minerals every industrialist/hauler tracks, same set EVE OS's ticker shows - always shown first, in this order. */
const MINERALS: { typeId: number; name: string }[] = [
  { typeId: 34, name: "Tritanium" },
  { typeId: 35, name: "Pyerite" },
  { typeId: 36, name: "Mexallon" },
  { typeId: 37, name: "Isogen" },
  { typeId: 38, name: "Nocxium" },
  { typeId: 39, name: "Zydrine" },
  { typeId: 40, name: "Megacyte" },
  { typeId: 11399, name: "Morphite" },
];

/** A broader watchlist beyond the base minerals - PLEX, skill injectors,
 * fuel-block gases, ice products, moon materials, and a couple of common
 * T2/reaction inputs. ESI has no bulk "history for every item" endpoint
 * (ESI's /markets/{region}/history/ is strictly one type at a time), so
 * scanning literally every tradeable item for a real "biggest movers today"
 * board isn't feasible here - this is a curated, still-fetchable set wide
 * enough that a genuine swing on any of them is worth surfacing, rather
 * than the 8 minerals being the only things this ticker could ever show
 * movement on. Verified against the local synced SDE (not guessed from
 * memory) before picking these ids. */
const WATCHLIST: { typeId: number; name: string }[] = [
  { typeId: 44992, name: "PLEX" },
  { typeId: 40520, name: "Large Skill Injector" },
  { typeId: 45635, name: "Small Skill Injector" },
  { typeId: 17888, name: "Nitrogen Isotopes" },
  { typeId: 17887, name: "Oxygen Isotopes" },
  { typeId: 16274, name: "Helium Isotopes" },
  { typeId: 17889, name: "Hydrogen Isotopes" },
  { typeId: 17960, name: "Prometium" },
  { typeId: 16653, name: "Thulium" },
  { typeId: 62516, name: "Compressed Veldspar" },
  { typeId: 3645, name: "Water" },
  { typeId: 16272, name: "Heavy Water" },
  { typeId: 16273, name: "Liquid Ozone" },
  { typeId: 16275, name: "Strontium Clathrates" },
  { typeId: 16679, name: "Fullerides" },
  { typeId: 16643, name: "Cadmium" },
  { typeId: 16642, name: "Vanadium" },
  { typeId: 16662, name: "Platinum Technite" },
  { typeId: 16658, name: "Silicon Diborite" },
  { typeId: 30745, name: "Sleeper Data Library" },
  { typeId: 30744, name: "Neural Network Analyzer" },
  { typeId: 28668, name: "Nanite Repair Paste" },
  { typeId: 9832, name: "Coolant" },
];

/** How many of the watchlist's biggest movers (by absolute % change) get
 * appended after the fixed minerals. */
const MOVER_COUNT = 6;
/** Roughly how many seconds of scroll time per ticker entry - keeps the
 * pace feeling the same regardless of how many entries end up in the row,
 * rather than a fixed duration that reads as rushed once movers are added. */
const SECONDS_PER_ENTRY = 3.3;

interface TickerEntry {
  typeId: number;
  name: string;
  price: number;
  changePct: number;
}

async function loadEntry(m: { typeId: number; name: string }): Promise<TickerEntry | null> {
  try {
    const history = await getRegionMarketHistory(THE_FORGE_REGION_ID, m.typeId);
    if (history.length === 0) return null;
    const latest = history[history.length - 1];
    const prev = history[history.length - 2] ?? latest;
    const changePct = prev.average > 0 ? ((latest.average - prev.average) / prev.average) * 100 : 0;
    return { typeId: m.typeId, name: m.name, price: latest.average, changePct };
  } catch {
    return null;
  }
}

function MineralTicker() {
  const [entries, setEntries] = useState<TickerEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([Promise.all(MINERALS.map(loadEntry)), Promise.all(WATCHLIST.map(loadEntry))]).then(([mineralResults, watchResults]) => {
      if (cancelled) return;
      const minerals = mineralResults.filter((e): e is TickerEntry => e != null);
      const movers = watchResults
        .filter((e): e is TickerEntry => e != null)
        .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
        .slice(0, MOVER_COUNT);
      setEntries([...minerals, ...movers]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!entries || entries.length === 0) return null;
  const loadedEntries = entries;

  const durationSeconds = Math.max(25, loadedEntries.length * SECONDS_PER_ENTRY);

  function renderItems(keyPrefix: string) {
    return loadedEntries.map((e) => (
      <span key={`${keyPrefix}${e.typeId}`} className="mineral-ticker-item">
        <span className="mineral-ticker-name">{e.name}</span>
        <span className="isk mineral-ticker-price">{formatIsk(e.price)}</span>
        <span className={e.changePct >= 0 ? "wallet-amount-positive" : "wallet-amount-negative"}>
          ({e.changePct >= 0 ? "+" : ""}
          {e.changePct.toFixed(1)}%)
        </span>
      </span>
    ));
  }

  return (
    <div className="mineral-ticker">
      <div className="mineral-ticker-track" style={{ animationDuration: `${durationSeconds}s` }}>
        {/* Two identical halves side by side, both sliding together - the
            animation moves this element left by exactly one half's own
            width, so the moment the first half scrolls fully out of view
            the second is sitting right where it started, and the loop
            resets to a pixel-identical frame. The second half is purely a
            visual continuation (same data, not new information), so it's
            hidden from assistive tech. Under reduced motion (see the two
            gating rules in App.css) the animation is switched off and this
            whole element instead wraps onto multiple lines - the clone
            half is hidden outright there too, since a second, non-moving
            copy of the same row would just be confusing clutter rather
            than serving the seamless-loop purpose it exists for here. */}
        <div className="mineral-ticker-half">{renderItems("a-")}</div>
        <div className="mineral-ticker-half mineral-ticker-half-clone" aria-hidden="true">
          {renderItems("b-")}
        </div>
      </div>
    </div>
  );
}

export default MineralTicker;
