import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import errorIcon from "../assets/sidebar-icons/error.png";

type ReportError = (message: string) => void;

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

  const reportError = useCallback((msg: string) => {
    console.error(msg);
    setMessage(msg);
  }, []);

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
