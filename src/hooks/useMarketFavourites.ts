import { usePersistentState } from "./usePersistentState";

export interface MarketFavourite {
  id: number;
  name: string;
}

const STORAGE_KEY = "vesper.market.favourites";

/** Items starred for quick access on the Market Browser - the in-app
 * equivalent of EVE's own client-side market favourites, for anyone who
 * checks the same handful of items constantly (e.g. an Orca pilot always
 * pricing Heavy Water) without retyping the search every time. */
export function useMarketFavourites() {
  const [favourites, setFavourites] = usePersistentState<MarketFavourite[]>(STORAGE_KEY, []);

  function isFavourite(id: number): boolean {
    return favourites.some((f) => f.id === id);
  }

  function toggleFavourite(item: MarketFavourite) {
    setFavourites((prev) => (prev.some((f) => f.id === item.id) ? prev.filter((f) => f.id !== item.id) : [...prev, item]));
  }

  return { favourites, isFavourite, toggleFavourite };
}
