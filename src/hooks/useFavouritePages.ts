import { usePersistentState } from "./usePersistentState";

const STORAGE_KEY = "vesper.sidebar.favouritePages";

/** Which nav pages (Sidebar.tsx's NAV_ITEMS ids) a pilot has starred from
 * that page's own TopBar - the pages the sidebar's Favourites view filters
 * down to. Deliberately just a flat list of ids, not full NavItem copies:
 * NAV_ITEMS itself (label, icon, description) is always the single source
 * of truth for everything about a page except whether it's starred. */
export function useFavouritePages() {
  const [favouriteIds, setFavouriteIds] = usePersistentState<string[]>(STORAGE_KEY, []);

  function isFavouritePage(id: string): boolean {
    return favouriteIds.includes(id);
  }

  function toggleFavouritePage(id: string) {
    setFavouriteIds((prev) => (prev.includes(id) ? prev.filter((existing) => existing !== id) : [...prev, id]));
  }

  /** Lets the Sidebar's Favourites view drag-reorder the starred list itself
   * (independent of the main nav's own drag order) - favouriteIds' order is
   * both "when it was starred" and "what order it shows in", so reordering
   * one is reordering the other. */
  function reorderFavourites(next: string[]) {
    setFavouriteIds(next);
  }

  return { favouriteIds, isFavouritePage, toggleFavouritePage, reorderFavourites };
}
