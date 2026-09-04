import { useTheme, isPremiumTheme } from "../../hooks/useTheme";

/** A tiny stamped/printed reference marking - "VES//NAV-02", "BUS A17",
 * "DECK 04" - the kind of identification code real equipment carries on
 * its housing. Purely atmospheric, never load-bearing information, so it
 * takes plain text rather than deriving anything from real app state -
 * inventing a believable-looking part number is fine, inventing a fake
 * game statistic is not, and this component only ever does the former.
 *
 * Renders nothing at all under a standard theme - it's dropped into shared
 * markup (the sidebar footer, in particular) that every theme renders, and
 * standard themes must keep showing exactly what they always have, not a
 * new stray label with no styling to make sense of it. */
function TechnicalLabel({ children }: { children: string }) {
  const [theme] = useTheme();
  if (!isPremiumTheme(theme)) return null;
  return <span className="technical-label">{children}</span>;
}

export default TechnicalLabel;
