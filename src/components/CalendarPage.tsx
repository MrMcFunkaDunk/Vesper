import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import {
  getCharacterCalendar,
  getCalendarEventDetail,
  type CharacterCalendar,
  type CalendarEventDetail,
  type SessionCharacter,
} from "../lib/eve";
import { formatEveDateTime, formatTimeRemaining } from "../lib/format";
import { useErrorReporter } from "../hooks/useErrorReporter";
import CharacterSelectorStrip from "./CharacterSelectorStrip";

interface CalendarPageProps {
  characters: SessionCharacter[];
  initialCharacterId: number | null;
}

function reauthNotice() {
  return <p className="detail-empty">Sign in again to unlock the calendar for this character.</p>;
}

const RESPONSE_LABEL: Record<string, string> = {
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Tentative",
  not_responded: "Not responded",
};

function responseClass(response: string): string {
  if (response === "accepted") return "standing-text-positive";
  if (response === "declined") return "standing-text-negative";
  return "standing-text-neutral";
}

function CalendarPage({ characters, initialCharacterId }: CalendarPageProps) {
  const [selectedId, setSelectedId] = useState<number | null>(initialCharacterId ?? characters[0]?.id ?? null);
  const [calendar, setCalendar] = useState<CharacterCalendar | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CalendarEventDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const reportError = useErrorReporter();

  useEffect(() => {
    if (selectedId == null) return;
    setCalendar(null);
    setSelectedEventId(null);
    setDetail(null);
    getCharacterCalendar(selectedId)
      .then(setCalendar)
      .catch((err) => reportError(`Failed to load calendar: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function openEvent(eventId: number) {
    if (selectedId == null) return;
    setSelectedEventId(eventId);
    setDetail(null);
    setLoadingDetail(true);
    getCalendarEventDetail(selectedId, eventId)
      .then(setDetail)
      .catch((err) => reportError(`Failed to load event: ${String(err)}`))
      .finally(() => setLoadingDetail(false));
  }

  return (
    <main className="main main-calendar">
      <div className="calendar-page">
        <div className="calendar-page-header">
          <p className="eyebrow">
            <CalendarDays size={14} strokeWidth={2} /> Calendar
          </p>
          <h2>Upcoming Events</h2>
          <p className="calendar-page-subtitle">
            The next events on this character's in-game calendar - fleet ops, corp events, and anything else they've
            been invited to. ESI only returns the next 50 upcoming events.
          </p>
        </div>

        {characters.length > 0 && (
          <CharacterSelectorStrip characters={characters} selectedId={selectedId} onSelect={setSelectedId} />
        )}

        <div className="calendar-layout">
          <div className="calendar-list">
            {!calendar ? (
              <p className="detail-empty">Loading calendar...</p>
            ) : calendar.needs_reauth ? (
              reauthNotice()
            ) : calendar.entries.length === 0 ? (
              <p className="detail-empty">No upcoming events.</p>
            ) : (
              calendar.entries.map((e) => (
                <button
                  key={e.event_id}
                  type="button"
                  className={`calendar-event-row${selectedEventId === e.event_id ? " calendar-event-row-active" : ""}`}
                  onClick={() => openEvent(e.event_id)}
                >
                  <span className="calendar-event-date">{formatEveDateTime(e.event_date)}</span>
                  <span className="calendar-event-title">{e.title}</span>
                  <span className={`calendar-event-response ${responseClass(e.event_response)}`}>
                    {RESPONSE_LABEL[e.event_response] ?? e.event_response}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="calendar-detail">
            {selectedEventId == null ? (
              <p className="detail-empty">Select an event to see its details.</p>
            ) : loadingDetail || !detail ? (
              <p className="detail-empty">Loading event...</p>
            ) : (
              <div className="calendar-detail-card">
                <h3>{detail.title}</h3>
                <p className="calendar-detail-meta">
                  {formatEveDateTime(detail.date)} · starts in {formatTimeRemaining(detail.date)} · {detail.duration} min
                </p>
                <p className="calendar-detail-meta">
                  Hosted by {detail.owner_name} ({detail.owner_type})
                </p>
                <p className={`calendar-detail-meta ${responseClass(detail.response)}`}>
                  Your response: {RESPONSE_LABEL[detail.response] ?? detail.response}
                </p>
                {detail.text && <div className="calendar-detail-text">{detail.text}</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

export default CalendarPage;
