import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import errorIcon from "../assets/sidebar-icons/error.png";
import { useTheme, isPremiumTheme } from "./useTheme";

type ReportError = (message: string) => void;

/** A brief signal-degradation flicker (RGB split + power sag - see
 * .premium-signal-degraded in premium-structure.css) at the instant a real
 * error surfaces, under a premium deck only. This is the one deliberate
 * trigger for that visual language in the whole app - reportError is
 * already the single choke point every feature's error path already goes
 * through, so hooking it here means the glitch only ever fires for a
 * genuine failure, never as ambient decoration. Auto-clears well before
 * anyone's done reading the modal - it marks the moment something broke,
 * it doesn't stay broken-looking while they read why. */
const DEGRADED_FLICKER_MS = 650;

const ErrorReporterContext = createContext<ReportError | null>(null);

/**
 * Standing app-wide convention: any error worth telling the user about goes
 * through this, not a bare console.error. It logs to the console AND shows
 * the Error-icon modal front and centre, so failures are never silent.
 */
export function useErrorReporter(): ReportError {
  const reportError = useContext(ErrorReporterContext);
  if (!reportError) {
    throw new Error("useErrorReporter must be used within an ErrorReporterProvider");
  }
  return reportError;
}

interface ErrorReporterProviderProps {
  children: ReactNode;
}

export function ErrorReporterProvider({ children }: ErrorReporterProviderProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [theme] = useTheme();

  const reportError = useCallback((msg: string) => {
    console.error(msg);
    setMessage(msg);
  }, []);

  useEffect(() => {
    if (!message || !isPremiumTheme(theme)) return;
    document.body.classList.add("premium-signal-degraded");
    const timeout = setTimeout(() => document.body.classList.remove("premium-signal-degraded"), DEGRADED_FLICKER_MS);
    return () => {
      clearTimeout(timeout);
      document.body.classList.remove("premium-signal-degraded");
    };
  }, [message, theme]);

  return (
    <ErrorReporterContext.Provider value={reportError}>
      {children}
      {message && (
        <div className="error-modal-backdrop" role="presentation" onClick={() => setMessage(null)}>
          <div
            className="error-modal"
            role="alertdialog"
            aria-modal="true"
            aria-label="System error"
            onClick={(e) => e.stopPropagation()}
          >
            <img src={errorIcon} alt="" className="error-modal-icon" />
            <h3>System Error</h3>
            <p>{message}</p>
            <button type="button" onClick={() => setMessage(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </ErrorReporterContext.Provider>
  );
}
