import { Star } from "lucide-react";
import { useFavouritePages } from "../hooks/useFavouritePages";
import { subTabLabel } from "../lib/subTabs";

interface FavouriteTabButtonProps {
  /** NAV_ITEMS id of the page this tab lives on, e.g. "wallet". */
  pageId: string;
  /** The page's own internal tab id, e.g. "lpstore". */
  tabId: string;
}

/** A star sitting right on every individual tab in a multi-tab page's own
 * tab bar (see PageTabBar), favouriting that ONE SPECIFIC tab
 * ("wallet.lpstore") rather than the page as a whole. One of these renders
 * per tab (not just the active one) so every tab's favourited state is
 * visible at a glance and can be toggled without first switching to it -
 * the original single button tied to "whichever tab happens to be open"
 * was invisible/ambiguous enough that pilots couldn't find it. */
function FavouriteTabButton({ pageId, tabId }: FavouriteTabButtonProps) {
  const { isFavouritePage, toggleFavouritePage } = useFavouritePages();
  const id = `${pageId}.${tabId}`;
  const label = subTabLabel(pageId, tabId) ?? tabId;
  const favourited = isFavouritePage(id);

  return (
    <button
      type="button"
      className={`page-tab-favourite${favourited ? " page-tab-favourite-active" : ""}`}
      onClick={() => toggleFavouritePage(id)}
      aria-label={favourited ? `Remove ${label} from Favourites` : `Add ${label} to Favourites`}
      title={favourited ? "Remove from Favourites" : "Add to Favourites - starred tabs show in the Sidebar's Favourites view"}
    >
      <Star size={14} strokeWidth={2} fill={favourited ? "currentColor" : "none"} />
    </button>
  );
}

export default FavouriteTabButton;
