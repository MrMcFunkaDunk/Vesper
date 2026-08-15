import { useRef, useState } from "react";
import { startLogin, cancelLogin } from "../lib/eve";
import { DASHBOARD_SCOPES } from "../lib/scopes";
import Wordmark from "./Wordmark";

interface LoginScreenProps {
  onLoggedIn: () => void;
}

function LoginScreen({ onLoggedIn }: LoginScreenProps) {
  const [status, setStatus] = useState<"idle" | "pending" | "error">("idle");
  const [error, setError] = useState("");
  const cancelledRef = useRef(false);

  async function handleLogin() {
    setStatus("pending");
    setError("");
    try {
      await startLogin(DASHBOARD_SCOPES);
      onLoggedIn();
    } catch (err) {
      if (cancelledRef.current) {
        cancelledRef.current = false;
        setStatus("idle");
      } else {
        setStatus("error");
        setError(String(err));
      }
    }
  }

  async function handleCancel() {
    cancelledRef.current = true;
    await cancelLogin();
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <Wordmark className="login-word" />
        <span className="brand-subtitle">Capsuleer Operations System</span>
        <div className="login-divider" />
        <p className="eyebrow">Secure Capsuleer Authentication</p>
        {/* TODO: swap for CCP's official "Log in with EVE Online" button asset */}
        <button
          type="button"
          className="sso-button"
          onClick={handleLogin}
          disabled={status === "pending"}
        >
          {status === "pending" ? "Waiting for login..." : "Log in with EVE Online"}
        </button>
        {status === "pending" && (
          <>
            <p className="login-status">
              Finish signing in in the browser window that just opened.
            </p>
            <button type="button" className="login-cancel" onClick={handleCancel}>
              Cancel and try again
            </button>
          </>
        )}
        {status === "error" && <p className="login-error">{error}</p>}
      </div>
    </div>
  );
}

export default LoginScreen;
