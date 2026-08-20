import type { ContactEntry } from "./eve";

/** Picks the most specific standing for a kill's victim/attacker: a direct
 * character contact beats a corporation contact, which beats an alliance
 * contact. Returns null when nothing in the contact list matches any of the
 * given ids. */
export function matchContactStanding(
  contacts: ContactEntry[],
  ids: { characterId: number | null; corporationId: number | null; allianceId: number | null },
): number | null {
  if (ids.characterId != null) {
    const match = contacts.find((c) => c.contact_type === "character" && c.contact_id === ids.characterId);
    if (match) return match.standing;
  }
  if (ids.corporationId != null) {
    const match = contacts.find((c) => c.contact_type === "corporation" && c.contact_id === ids.corporationId);
    if (match) return match.standing;
  }
  if (ids.allianceId != null) {
    const match = contacts.find((c) => c.contact_type === "alliance" && c.contact_id === ids.allianceId);
    if (match) return match.standing;
  }
  return null;
}
