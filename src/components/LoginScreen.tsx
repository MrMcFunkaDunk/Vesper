import { useState } from "react";
import { startLogin } from "../lib/eve";

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
      await startLogin([]);
      onLoggedIn();
    } catch (err) {
      setStatus("error");
      setError(String(err));
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <span className="brand-mark login-brand-mark">EC</span>
        <h1>EVE Companion</h1>
        <p>
          Sign in with your EVE Online account to pull your characters' data
          into one place.
        </p>
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
