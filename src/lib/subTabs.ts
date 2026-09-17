export interface SubTabInfo {
  id: string;
  label: string;
}

/** Every multi-tab page's own internal tab ids/labels, duplicated here (each
 * page still owns its own TABS array/button JSX for rendering) so the
 * Sidebar's Favourites view and TopBar's star button can talk about "wallet.lpstore"
 * without importing a whole page component. Keep in sync with each page's own
 * tab list by hand - there's no single source of truth to derive this from
 * since the pages predate sub-tab favouriting. */
export const SUB_TABS: Record<string, SubTabInfo[]> = {
  kills: [
    { id: "tracked", label: "Tracked Systems" },
    { id: "recent", label: "Most Recent Kills" },
    { id: "battles", label: "Battles" },
    { id: "reports", label: "Kill Reports" },
    { id: "topstats", label: "Top Stats" },
    { id: "trackedplayers", label: "Tracked Players" },
    { id: "contacts", label: "Contacts" },
  ],
  "fittings-fleets": [
    { id: "library", label: "My Fits" },
    { id: "builder", label: "New Fit" },
    { id: "ships", label: "My Ships" },
  ],
  wallet: [
    { id: "browser", label: "Market Browser" },
    { id: "marketcompare", label: "Market Compare" },
    { id: "shipscanner", label: "Ship Scanner" },
    { id: "itemdb", label: "Item Database" },
    { id: "appraisal", label: "Appraisal" },
    { id: "screener", label: "Screener" },
    { id: "lpstore", label: "LP Store" },
    { id: "contracts", label: "Contracts" },
    { id: "insurance", label: "Insurance" },
    { id: "orders", label: "Orders" },
    { id: "wallet", label: "Wallet" },
    { id: "transactions", label: "Transactions" },
  ],
  industry: [
    { id: "production", label: "Production" },
    { id: "reprocessing", label: "Reprocessing" },
    { id: "invention", label: "Invention" },
    { id: "research", label: "Research" },
    { id: "opportunities", label: "Opportunities" },
  ],
  map: [
    { id: "map", label: "Map" },
    { id: "gatecheck", label: "Gate Check" },
    { id: "likelycamps", label: "Likely Gate Camps" },
    { id: "localthreat", label: "Local Threat" },
    { id: "dscan", label: "D-Scan" },
    { id: "regionmap", label: "Region Map" },
  ],
  mining: [
    { id: "oretable", label: "Ore Table" },
    { id: "ledger", label: "Mining Ledger" },
    { id: "markethistory", label: "Market History" },
  ],
  planetary: [
    { id: "colonies", label: "Colonies" },
    { id: "reference", label: "Materials Reference" },
  ],
};

export function subTabLabel(pageId: string, subTabId: string): string | undefined {
  return SUB_TABS[pageId]?.find((t) => t.id === subTabId)?.label;
}

/** A favourite id is either a bare NAV_ITEMS id ("industry") from before
 * sub-tab favouriting existed, or "<pageId>.<subTabId>" ("industry.production")
 * for a specific tab on one of the pages above. Split it back apart so the
 * Sidebar/TopBar don't have to duplicate this parsing. */
export function splitFavouriteId(id: string): { pageId: string; subTabId: string | null } {
  const dotIndex = id.indexOf(".");
  if (dotIndex === -1) return { pageId: id, subTabId: null };
  return { pageId: id.slice(0, dotIndex), subTabId: id.slice(dotIndex + 1) };
}
