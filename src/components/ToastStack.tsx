import { X } from "lucide-react";
import { useToast } from "../hooks/useToast";

function ToastStack() {
  const { toasts, dismissToast } = useToast();
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast-card">
          <div className="toast-card-body">
            <p className="toast-card-title">{toast.title}</p>
            {toast.message && <p className="toast-card-message">{toast.message}</p>}
          </div>
          <button type="button" className="toast-card-dismiss" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default ToastStack;
