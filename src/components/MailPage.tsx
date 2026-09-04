import { useEffect, useState } from "react";
import { ArrowLeft, Mail as MailIcon, Send, X } from "lucide-react";
import {
  getCharacterMail,
  getMailDetail,
  getMailLabels,
  sendMail,
  type CharacterMail,
  type MailDetail,
  type MailLabel,
  type MailRecipientInput,
  type SessionCharacter,
} from "../lib/eve";
import { searchCharactersLive, searchEntitiesLive, type CharacterMatch, type EntityMatch } from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";
import CharacterSelectorStrip from "./CharacterSelectorStrip";

interface MailPageProps {
  characters: SessionCharacter[];
  initialCharacterId: number | null;
}

/** One picked recipient, kept in whatever shape ESI's send-mail payload
 * actually wants (recipient_id + recipient_type) - resolved once at pick
 * time from the same live character/corp/alliance search Tracked Players
 * already uses, so there's no separate name-lookup step at send time. */
interface RecipientChip {
  id: number;
  name: string;
  kind: MailRecipientInput["recipient_type"];
}

interface ComposeSuggestion {
  id: number;
  name: string;
  kind: MailRecipientInput["recipient_type"];
}

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleString([], { timeZone: "UTC" }) : "—";
}

function reauthNotice() {
  return <p className="detail-empty">Sign in again to unlock mail for this character.</p>;
}

function MailPage({ characters, initialCharacterId }: MailPageProps) {
  const [selectedId, setSelectedId] = useState<number | null>(initialCharacterId ?? characters[0]?.id ?? null);
  const [mail, setMail] = useState<CharacterMail | null>(null);
  const [selectedMailId, setSelectedMailId] = useState<number | null>(null);
  const [mailDetail, setMailDetail] = useState<MailDetail | null>(null);
  const [mailDetailLoading, setMailDetailLoading] = useState(false);
  const reportError = useErrorReporter();

  // Custom mail labels (created in-game) - not the built-in Inbox/Sent/Corp/
  // Alliance folders, which ESI has no documented fixed id scheme for, so
  // this only ever filters by real, named labels the character actually has.
  const [labels, setLabels] = useState<MailLabel[]>([]);
  const [activeLabelId, setActiveLabelId] = useState<number | null>(null);

  // Compose panel - a third view alongside the list/detail split above,
  // toggled the same way (one boolean, a "back" affordance out of it).
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeRecipients, setComposeRecipients] = useState<RecipientChip[]>([]);
  const [composeQuery, setComposeQuery] = useState("");
  const [composeSuggestions, setComposeSuggestions] = useState<ComposeSuggestion[]>([]);
  const [composeSuggestionsOpen, setComposeSuggestionsOpen] = useState(false);
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (selectedId == null) return;
    setMail(null);
    setSelectedMailId(null);
    setMailDetail(null);
    setActiveLabelId(null);
    setLabels([]);
    // Also close out any in-progress compose draft - the character strip
    // above stays clickable while composing, and a draft (recipients,
    // subject, body) written for the previous character has no business
    // surviving a switch to a new one and going out under its identity.
    setComposeOpen(false);
    setComposeRecipients([]);
    setComposeQuery("");
    setComposeSuggestions([]);
    setComposeSuggestionsOpen(false);
    setComposeSubject("");
    setComposeBody("");
    getCharacterMail(selectedId).then(setMail).catch(() => setMail({ entries: [], needs_reauth: false }));
    getMailLabels(selectedId)
      .then((result) => setLabels(result.needs_reauth ? [] : result.labels))
      .catch(() => setLabels([]));
  }, [selectedId]);

  // Recipient autocomplete - same live zKillboard-backed search Tracked
  // Players' add-entity box already uses, just merged into one suggestion
  // list tagged with the recipient_type ESI's send-mail payload wants.
  useEffect(() => {
    const trimmed = composeQuery.trim();
    if (trimmed.length < 3) {
      setComposeSuggestions([]);
      setComposeSuggestionsOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all([searchCharactersLive(trimmed), searchEntitiesLive(trimmed)])
        .then(([characterResults, entityResults]: [CharacterMatch[], EntityMatch[]]) => {
          if (cancelled) return;
          const merged: ComposeSuggestion[] = [
            ...characterResults.map((c): ComposeSuggestion => ({ id: c.id, name: c.name, kind: "character" })),
            ...entityResults.map((e): ComposeSuggestion => ({ id: e.id, name: e.name, kind: e.is_alliance ? "alliance" : "corporation" })),
          ];
          setComposeSuggestions(merged);
          setComposeSuggestionsOpen(merged.length > 0);
        })
        .catch(() => {
          if (!cancelled) setComposeSuggestions([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [composeQuery]);

  function openMail(mailId: number) {
    if (selectedId == null) return;
    setSelectedMailId(mailId);
    setMailDetail(null);
    setMailDetailLoading(true);
    getMailDetail(selectedId, mailId)
      .then(setMailDetail)
      .finally(() => setMailDetailLoading(false));
  }

  function openCompose() {
    setComposeOpen(true);
    setComposeRecipients([]);
    setComposeQuery("");
    setComposeSuggestions([]);
    setComposeSubject("");
    setComposeBody("");
    // Compose replaces whatever was showing in the body panel - clear any
    // open mail so leaving Compose again (Back, or after a successful
    // Send) returns to the list instead of falling back into a stale
    // mail-detail view that was still selected from before Compose opened.
    setSelectedMailId(null);
    setMailDetail(null);
  }

  function addRecipient(s: ComposeSuggestion) {
    setComposeQuery("");
    setComposeSuggestions([]);
    setComposeSuggestionsOpen(false);
    setComposeRecipients((prev) => (prev.some((r) => r.id === s.id && r.kind === s.kind) ? prev : [...prev, s]));
  }

  function removeRecipient(id: number, kind: MailRecipientInput["recipient_type"]) {
    setComposeRecipients((prev) => prev.filter((r) => !(r.id === id && r.kind === kind)));
  }

  function handleSend() {
    if (selectedId == null || composeRecipients.length === 0 || !composeSubject.trim()) return;
    setSending(true);
    sendMail(
      selectedId,
      composeSubject.trim(),
      composeBody,
      composeRecipients.map((r): MailRecipientInput => ({ recipient_id: r.id, recipient_type: r.kind })),
    )
      .then(() => {
        setComposeOpen(false);
        // Refresh so the newly-sent mail's effect on unread counts (if any)
        // and the list itself stay current - sent mail doesn't appear in
        // this character's own inbox headers, so this is just a courtesy
        // resync rather than something that'll show the message itself.
        if (selectedId != null) getCharacterMail(selectedId).then(setMail).catch(() => {});
      })
      .catch((err) => reportError(`Failed to send mail: ${String(err)}`))
      .finally(() => setSending(false));
  }

  const selectedCharacter = characters.find((c) => c.id === selectedId);
  const visibleEntries = mail ? mail.entries.filter((m) => activeLabelId == null || m.labels.includes(activeLabelId)) : [];

  return (
    <main className="main main-mail">
      <div className="mail-page">
        <div className="mail-page-header">
          <div>
            <p className="eyebrow">Mail</p>
            <h2>{selectedCharacter ? `${selectedCharacter.name}'s Inbox` : "Inbox"}</h2>
          </div>
          {selectedId != null && !composeOpen && (
            <button type="button" className="kills-sync-btn mail-compose-btn" onClick={openCompose}>
              <MailIcon size={14} strokeWidth={2} />
              Compose
            </button>
          )}
        </div>

        <CharacterSelectorStrip characters={characters} selectedId={selectedId} onSelect={setSelectedId} />

        {!composeOpen && labels.length > 0 && selectedMailId == null && (
          <div className="mail-label-row">
            <button
              type="button"
              className={`mail-label-chip${activeLabelId == null ? " mail-label-chip-active" : ""}`}
              onClick={() => setActiveLabelId(null)}
            >
              All
            </button>
            {labels.map((l) => (
              <button
                type="button"
                key={l.label_id}
                className={`mail-label-chip${activeLabelId === l.label_id ? " mail-label-chip-active" : ""}`}
                style={{ borderColor: activeLabelId === l.label_id ? l.color : undefined }}
                onClick={() => setActiveLabelId(l.label_id)}
              >
                {l.name}
                {l.unread_count > 0 && <span className="mail-label-chip-count">{l.unread_count}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="mail-page-body">
          {selectedId == null ? (
            <p className="detail-empty">No connected characters.</p>
          ) : composeOpen ? (
            <div className="mail-compose">
              <button type="button" className="mail-back-btn" onClick={() => setComposeOpen(false)}>
                <ArrowLeft size={13} strokeWidth={2} /> Back to list
              </button>

              <div className="mail-compose-field">
                <label className="wh-field-label">To</label>
                <div className="mail-compose-recipients">
                  {composeRecipients.map((r) => (
                    <span key={`${r.kind}:${r.id}`} className="mail-recipient-chip">
                      {r.name}
                      <button type="button" onClick={() => removeRecipient(r.id, r.kind)} aria-label={`Remove ${r.name}`}>
                        <X size={11} strokeWidth={2.5} />
                      </button>
                    </span>
                  ))}
                  <div className="kills-add-combobox mail-compose-recipient-search">
                    <input
                      type="text"
                      placeholder="Add a character, corporation, or alliance..."
                      value={composeQuery}
                      onChange={(e) => setComposeQuery(e.target.value)}
                      onFocus={() => composeSuggestions.length > 0 && setComposeSuggestionsOpen(true)}
                      onBlur={() => setTimeout(() => setComposeSuggestionsOpen(false), 120)}
                    />
                    {composeSuggestionsOpen && (
                      <div className="gatecheck-slot-results kills-add-suggestions">
                        {composeSuggestions.map((s) => (
                          <button
                            key={`${s.kind}:${s.id}`}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => addRecipient(s)}
                          >
                            {s.name}
                            <span className="kills-add-suggestion-kind">{s.kind}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="mail-compose-field">
                <label className="wh-field-label">
                  Subject
                  <input
                    type="text"
                    className="industry-field-input"
                    value={composeSubject}
                    onChange={(e) => setComposeSubject(e.target.value)}
                    maxLength={200}
                  />
                </label>
              </div>

              <div className="mail-compose-field">
                <label className="wh-field-label">
                  Message
                  <textarea
                    className="mail-compose-body"
                    value={composeBody}
                    onChange={(e) => setComposeBody(e.target.value)}
                    rows={12}
                    placeholder="Plain text only - VESPER doesn't send rich formatting, matching how mail bodies are shown when reading."
                  />
                </label>
              </div>

              <button
                type="button"
                className="kills-sync-btn"
                onClick={handleSend}
                disabled={sending || composeRecipients.length === 0 || !composeSubject.trim()}
              >
                <Send size={14} strokeWidth={2} />
                {sending ? "Sending..." : "Send"}
              </button>
            </div>
          ) : selectedMailId != null ? (
            <div className="mail-detail">
              <button type="button" className="mail-back-btn" onClick={() => setSelectedMailId(null)}>
                <ArrowLeft size={13} strokeWidth={2} /> Back to list
              </button>
              {mailDetailLoading || !mailDetail ? (
                <p className="detail-empty">Loading message...</p>
              ) : mailDetail.needs_reauth ? (
                reauthNotice()
              ) : (
                <>
                  <h3 className="mail-detail-subject">{mailDetail.subject}</h3>
                  <div className="mail-detail-meta">
                    <span>
                      <strong>From:</strong> {mailDetail.from_name}
                    </span>
                    <span>
                      <strong>To:</strong> {mailDetail.recipient_names.join(", ") || "—"}
                    </span>
                    <span>{fmtDate(mailDetail.timestamp)}</span>
                  </div>
                  <div className="mail-detail-body">{mailDetail.body_text || "(no body)"}</div>
                </>
              )}
            </div>
          ) : !mail ? (
            <p className="detail-empty">Loading mail...</p>
          ) : mail.needs_reauth ? (
            reauthNotice()
          ) : visibleEntries.length === 0 ? (
            <p className="detail-empty">{mail.entries.length === 0 ? "No mail found." : "No mail under this label."}</p>
          ) : (
            <div className="mail-list">
              {visibleEntries.map((m) => (
                <button
                  key={m.mail_id}
                  type="button"
                  className={`mail-row mail-row-clickable${m.is_read ? "" : " mail-row-unread"}`}
                  onClick={() => openMail(m.mail_id)}
                >
                  <div className="mail-info">
                    <span className="mail-subject">{m.subject}</span>
                    <span className="mail-meta">
                      {m.from_name} · {fmtDate(m.timestamp)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default MailPage;
