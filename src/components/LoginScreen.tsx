import { useState } from "react";
import { startLogin } from "../lib/eve";
import { DASHBOARD_SCOPES } from "../lib/scopes";
import Wordmark from "./Wordmark";

interface LoginScreenProps {
  onLoggedIn: () => void;
}

function LoginScreen({ onLoggedIn }: LoginScreenProps) {
  const [status, setStatus] = useState<"idle" | "pending" | "error">("idle");
  const [error, setError] = useState("");

  async function handleLogin() {
    setStatus("pending");
    setError("");
    try {
      await startLogin(DASHBOARD_SCOPES);
      onLoggedIn();
    } catch (err) {
      setStatus("error");
      setError(String(err));
    }
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
          <p className="login-status">
            Finish signing in in the browser window that just opened.
          </p>
        )}
        {status === "error" && <p className="login-error">{error}</p>}
      </div>
    </div>
  );
}

export default LoginScreen;
