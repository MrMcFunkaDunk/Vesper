import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { getCharacterMail, getMailDetail, type CharacterMail, type MailDetail, type SessionCharacter } from "../lib/eve";
import CharacterSelectorStrip from "./CharacterSelectorStrip";

interface MailPageProps {
  characters: SessionCharacter[];
  initialCharacterId: number | null;
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

  useEffect(() => {
    if (selectedId == null) return;
    setMail(null);
    setSelectedMailId(null);
    setMailDetail(null);
    getCharacterMail(selectedId).then(setMail).catch(() => setMail({ entries: [], needs_reauth: false }));
  }, [selectedId]);

  function openMail(mailId: number) {
    if (selectedId == null) return;
    setSelectedMailId(mailId);
    setMailDetail(null);
    setMailDetailLoading(true);
    getMailDetail(selectedId, mailId)
      .then(setMailDetail)
      .finally(() => setMailDetailLoading(false));
  }

  const selectedCharacter = characters.find((c) => c.id === selectedId);

  return (
    <main className="main main-mail">
      <div className="mail-page">
        <div className="mail-page-header">
          <p className="eyebrow">Mail</p>
          <h2>{selectedCharacter ? `${selectedCharacter.name}'s Inbox` : "Inbox"}</h2>
        </div>

        <CharacterSelectorStrip characters={characters} selectedId={selectedId} onSelect={setSelectedId} />

        <div className="mail-page-body">
          {selectedId == null ? (
            <p className="detail-empty">No connected characters.</p>
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
          ) : mail.entries.length === 0 ? (
            <p className="detail-empty">No mail found.</p>
          ) : (
            <div className="mail-list">
              {mail.entries.map((m) => (
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
