import { useEffect, useState } from "react";
import { getCharacterContacts, type SessionCharacter } from "../lib/eve";
import { standingClass } from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";
import { useSortableRows } from "../hooks/useSortableRows";
import { useTextFilter } from "../hooks/useSortableRows";
import { SortableTh } from "./SortableTh";
import TrackEntityButton from "./TrackEntityButton";
import type { CorporationSummary } from "./CorporationKillboard";
import type { AllianceSummary } from "./AllianceKillboard";

/** EveLens' 5-bucket standing classification (Terrible/Bad/Neutral/Good/Excellent). */
function standingLabel(value: number): string {
  if (value <= -5.5) return "Terrible";
  if (value <= -0.5) return "Bad";
  if (value < 0.5) return "Neutral";
  if (value < 5.5) return "Good";
  return "Excellent";
}

interface AggregatedContact {
  contact_id: number;
  contact_name: string;
  contact_type: string;
  standing: number;
  ownedBy: string[];
}

interface ContactsDirectoryProps {
  characters: SessionCharacter[];
  onSelectCharacter: (characterId: number) => void;
  onSelectCorporation: (corporation: CorporationSummary) => void;
  onSelectAlliance: (alliance: AllianceSummary) => void;
}

/** Every contact across every connected character, merged into one
 * directory - the whole point being a single place to find someone you
 * know and jump straight to their killboard (or track them), rather than
 * hunting through each character's own Contacts tab one at a time. */
function ContactsDirectory({ characters, onSelectCharacter, onSelectCorporation, onSelectAlliance }: ContactsDirectoryProps) {
  const [contacts, setContacts] = useState<AggregatedContact[] | null>(null);
  const [reauthCharacters, setReauthCharacters] = useState<string[]>([]);
  const reportError = useErrorReporter();

  useEffect(() => {
    if (characters.length === 0) {
      setContacts([]);
      return;
    }
    let cancelled = false;

    async function loadAll() {
      const byKey = new Map<string, AggregatedContact>();
      const needsReauth: string[] = [];

      await Promise.all(
        characters.map(async (character) => {
          try {
            const result = await getCharacterContacts(character.id);
            if (result.needs_reauth) {
              needsReauth.push(character.name);
              return;
            }
            for (const entry of result.entries) {
              const key = `${entry.contact_type}:${entry.contact_id}`;
              const existing = byKey.get(key);
              if (existing) {
                existing.ownedBy.push(character.name);
              } else {
                byKey.set(key, {
                  contact_id: entry.contact_id,
                  contact_name: entry.contact_name,
                  contact_type: entry.contact_type,
                  standing: entry.standing,
                  ownedBy: [character.name],
                });
              }
            }
          } catch (err) {
            reportError(`Failed to load ${character.name}'s contacts: ${String(err)}`);
          }
        }),
      );

      if (cancelled) return;
      setContacts(Array.from(byKey.values()));
      setReauthCharacters(needsReauth);
    }

    loadAll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters]);

  const { query, setQuery, filtered } = useTextFilter(contacts ?? [], (c) => [c.contact_name, c.contact_type]);
  const sorted = useSortableRows(filtered, {
    contact_name: (c) => c.contact_name,
    contact_type: (c) => c.contact_type,
    standing: (c) => c.standing,
    ownedBy: (c) => c.ownedBy.length,
  }, "standing");

  function handleOpen(contact: AggregatedContact) {
    if (contact.contact_type === "character") onSelectCharacter(contact.contact_id);
    else if (contact.contact_type === "corporation") onSelectCorporation({ id: contact.contact_id, name: contact.contact_name });
    else if (contact.contact_type === "alliance") onSelectAlliance({ id: contact.contact_id, name: contact.contact_name });
  }

  const isTrackable = (kind: string): kind is "character" | "corporation" | "alliance" =>
    kind === "character" || kind === "corporation" || kind === "alliance";

  if (characters.length === 0) {
    return <p className="detail-empty">No connected characters.</p>;
  }

  return (
    <div className="contacts-directory">
      {reauthCharacters.length > 0 && (
        <p className="detail-empty">{reauthCharacters.join(", ")} need{reauthCharacters.length === 1 ? "s" : ""} to sign in again to unlock contacts.</p>
      )}
      <input
        type="text"
        className="contracts-search-input"
        placeholder="Search contacts..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {contacts == null ? (
        <p className="detail-empty">Loading contacts across all characters...</p>
      ) : contacts.length === 0 ? (
        <p className="detail-empty">No contacts found on any connected character.</p>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh label="Name" sortKey="contact_name" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} />
                <SortableTh label="Type" sortKey="contact_type" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} />
                <th>Standing</th>
                <SortableTh label="Value" sortKey="standing" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} numeric />
                <SortableTh label="Known By" sortKey="ownedBy" activeKey={sorted.sortKey} dir={sorted.sortDir} onSort={sorted.sort} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.rows.map((c) => (
                <tr key={`${c.contact_type}:${c.contact_id}`}>
                  <td>
                    {isTrackable(c.contact_type) ? (
                      <span
                        className={`kills-system-clickable ${standingClass(c.standing)}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleOpen(c)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleOpen(c);
                          }
                        }}
                      >
                        {c.contact_name}
                      </span>
                    ) : (
                      <span className={standingClass(c.standing)}>{c.contact_name}</span>
                    )}
                  </td>
                  <td style={{ textTransform: "capitalize" }}>{c.contact_type}</td>
                  <td>
                    <span className={`data-table-tag ${c.standing > 0 ? "" : c.standing < 0 ? "data-table-tag-danger" : "data-table-tag-neutral"}`}>
                      {standingLabel(c.standing)}
                    </span>
                  </td>
                  <td className={`data-table-numeric ${standingClass(c.standing)}`}>{c.standing.toFixed(1)}</td>
                  <td>{c.ownedBy.join(", ")}</td>
                  <td>
                    {isTrackable(c.contact_type) && (
                      <TrackEntityButton entityId={c.contact_id} entityName={c.contact_name} kind={c.contact_type} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default ContactsDirectory;
