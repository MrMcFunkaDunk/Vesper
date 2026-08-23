import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import {
  startKillHistoryBackfill,
  getKillHistoryBackfillProgress,
  type KillHistoryBackfillProgress,
} from "../lib/kills";
import { useErrorReporter } from "../hooks/useErrorReporter";

const POLL_MS = 2000;

/** One-time "Backfill Last 30 Days" control for Kill Reports/Top Stats -
 * pulls zKillboard's own bulk daily history dumps so those tabs have a
 * rolling 30-day window immediately instead of waiting a real month for
 * the live recorder to fill in on its own. */
function KillHistoryBackfillBar() {
  const [progress, setProgress] = useState<KillHistoryBackfillProgress | null>(null);
  const [starting, setStarting] = useState(false);
  const reportError = useErrorReporter();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function poll() {
    getKillHistoryBackfillProgress()
      .then(setProgress)
      .catch(() => {});
  }

  useEffect(() => {
    poll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (progress?.running) {
      pollRef.current = setInterval(poll, POLL_MS);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.running]);

  async function handleStart() {
    setStarting(true);
    try {
      await startKillHistoryBackfill();
      poll();
    } catch (err) {
      reportError(`Failed to start kill history backfill: ${String(err)}`);
    } finally {
      setStarting(false);
    }
  }

  if (!progress || (!progress.running && !progress.done)) {
    return (
      <div className="kill-backfill-bar">
        <History size={14} strokeWidth={2} />
        <span>Kill Reports and Top Stats only cover what VESPER has seen since it started running.</span>
        <button type="button" className="kill-backfill-btn" onClick={handleStart} disabled={starting}>
          {starting ? "Starting..." : "Backfill Last 30 Days"}
        </button>
      </div>
    );
  }

  if (progress.running) {
    const pct = progress.days_total > 0 ? Math.round((progress.days_done / progress.days_total) * 100) : 0;
    return (
      <div className="kill-backfill-bar">
        <History size={14} strokeWidth={2} />
        <span>
          Backfilling day {progress.days_done + 1} of {progress.days_total} ({progress.current_date}) -{" "}
          {progress.kills_recorded.toLocaleString()} kills recorded so far
        </span>
        <div className="kill-backfill-track">
          <div className="kill-backfill-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div className="kill-backfill-bar kill-backfill-done">
      <History size={14} strokeWidth={2} />
      <span>
        Backfilled {progress.days_total} days - {progress.kills_recorded.toLocaleString()} kills recorded.
        {progress.error && ` (Some days failed to import: ${progress.error})`}
      </span>
    </div>
  );
}

export default KillHistoryBackfillBar;
