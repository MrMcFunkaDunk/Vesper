import { useEffect, useState } from "react";
import { getRegionMarketHistory } from "../lib/market";
import { formatIsk } from "../lib/format";

const THE_FORGE_REGION_ID = 10000002;

/** The eight refined minerals every industrialist/hauler tracks, same set EVE OS's ticker shows. */
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

interface TickerEntry {
  name: string;
  price: number;
  changePct: number;
}

function MineralTicker() {
  const [entries, setEntries] = useState<TickerEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      MINERALS.map(async (m): Promise<TickerEntry | null> => {
        try {
          const history = await getRegionMarketHistory(THE_FORGE_REGION_ID, m.typeId);
          if (history.length === 0) return null;
          const latest = history[history.length - 1];
          const prev = history[history.length - 2] ?? latest;
          const changePct = prev.average > 0 ? ((latest.average - prev.average) / prev.average) * 100 : 0;
          return { name: m.name, price: latest.average, changePct };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (!cancelled) setEntries(results.filter((e): e is TickerEntry => e != null));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!entries || entries.length === 0) return null;

  return (
    <div className="mineral-ticker">
      {entries.map((e) => (
        <span key={e.name} className="mineral-ticker-item">
          <span className="mineral-ticker-name">{e.name}</span>
          <span className="isk mineral-ticker-price">{formatIsk(e.price)}</span>
          <span className={e.changePct >= 0 ? "wallet-amount-positive" : "wallet-amount-negative"}>
            ({e.changePct >= 0 ? "+" : ""}
            {e.changePct.toFixed(1)}%)
          </span>
        </span>
      ))}
    </div>
  );
}

export default MineralTicker;
