import { useEffect, useState } from "react";
import { getRegionMarketHistory, type MarketHistoryPoint } from "../lib/market";
import { TRADE_HUB_REGIONS } from "../lib/map";
import { useDefaultTradeHub } from "../hooks/useDefaultTradeHub";
import MiniPriceChart from "./MiniPriceChart";

// Same fixed sets as the market ticker (MineralTicker.tsx) and the Ore
// Table's own mineral/ice-product columns - the mining-relevant items
// people actually watch. ore.cerlestes.de's own Market History page also
// charts raw ore/ice/moon-ore/gas prices, but that's ~190 more items and
// ~190 more concurrent ESI history fetches - scoped out of this pass to
// keep the page fast; the two categories here are the ones most directly
// useful (what you get FROM mining, not the raw rocks themselves).
const MINERAL_ITEMS = [
  { typeId: 34, name: "Tritanium" },
  { typeId: 35, name: "Pyerite" },
  { typeId: 36, name: "Mexallon" },
  { typeId: 37, name: "Isogen" },
  { typeId: 38, name: "Nocxium" },
  { typeId: 39, name: "Zydrine" },
  { typeId: 40, name: "Megacyte" },
  { typeId: 11399, name: "Morphite" },
];

const ICE_PRODUCT_ITEMS = [
  { typeId: 16272, name: "Heavy Water" },
  { typeId: 16273, name: "Liquid Ozone" },
  { typeId: 16275, name: "Strontium Clathrates" },
  { typeId: 17887, name: "Oxygen Isotopes" },
  { typeId: 16274, name: "Helium Isotopes" },
  { typeId: 17889, name: "Hydrogen Isotopes" },
  { typeId: 17888, name: "Nitrogen Isotopes" },
];

const TIMEFRAMES = [
  { id: "14d", label: "14 Days", days: 14 },
  { id: "90d", label: "90 Days", days: 90 },
  { id: "1y", label: "1 Year", days: 365 },
  { id: "all", label: "All", days: Infinity },
] as const;
type TimeframeId = (typeof TIMEFRAMES)[number]["id"];

interface Section {
  title: string;
  items: { typeId: number; name: string }[];
}

const SECTIONS: Section[] = [
  { title: "Minerals", items: MINERAL_ITEMS },
  { title: "Ice Products", items: ICE_PRODUCT_ITEMS },
];

function MarketHistorySection({ section, regionId, timeframeDays }: { section: Section; regionId: number; timeframeDays: number }) {
  const [open, setOpen] = useState(true);
  const [history, setHistory] = useState<Map<number, MarketHistoryPoint[]>>(new Map());

  useEffect(() => {
    let cancelled = false;
    // Clear immediately rather than waiting for the new fetch to resolve -
    // otherwise switching regions keeps every chart showing the previous
    // region's numbers (mislabeled as the new one) for however long the
    // refetch takes, with nothing on screen to say it's stale.
    setHistory(new Map());
    Promise.all(section.items.map((item) => getRegionMarketHistory(regionId, item.typeId).then((points) => [item.typeId, points] as const))).then(
      (results) => {
        if (!cancelled) setHistory(new Map(results));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, regionId]);

  return (
    <div className="market-history-section">
      <div className="industry-build-steps-header">
        <p className="wh-side-label">{section.title}</p>
        <button type="button" className="skill-action-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && (
        <div className="mini-price-chart-grid">
          {section.items.map((item) => {
            const points = history.get(item.typeId);
            const sliced = points ? (Number.isFinite(timeframeDays) ? points.slice(-timeframeDays) : points) : null;
            return sliced ? (
              <MiniPriceChart key={item.typeId} points={sliced} name={item.name} />
            ) : (
              <div key={item.typeId} className="mini-price-chart">
                <p className="mini-price-chart-name">{item.name}</p>
                <p className="detail-empty">Loading...</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MarketHistoryTab() {
  const [defaultTradeHub] = useDefaultTradeHub();
  const [hubRegionId, setHubRegionId] = useState(defaultTradeHub);
  const [timeframe, setTimeframe] = useState<TimeframeId>("1y");
  const timeframeDays = TIMEFRAMES.find((t) => t.id === timeframe)?.days ?? 365;

  return (
    <div className="industry-production">
      <div className="industry-inputs-panel">
        <div className="industry-input-grid">
          <label className="wh-field-label">
            Trade Hub
            <select className="industry-field-input" value={hubRegionId} onChange={(e) => setHubRegionId(Number(e.target.value))}>
              {TRADE_HUB_REGIONS.map((h) => (
                <option key={h.regionId} value={h.regionId}>
                  {h.regionName}
                </option>
              ))}
            </select>
          </label>
          <label className="wh-field-label">
            Timeframe
            <select className="industry-field-input" value={timeframe} onChange={(e) => setTimeframe(e.target.value as TimeframeId)}>
              {TIMEFRAMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="industry-results-panel">
        {SECTIONS.map((section) => (
          <MarketHistorySection key={section.title} section={section} regionId={hubRegionId} timeframeDays={timeframeDays} />
        ))}
      </div>
    </div>
  );
}

export default MarketHistoryTab;
