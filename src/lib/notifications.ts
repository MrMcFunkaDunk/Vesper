import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

/** Checks the OS notification permission, prompting once if it's never been
 * asked. Returns false (never throws) if denied or unavailable - callers
 * degrade quietly rather than erroring the whole feature over a permission
 * the user chose not to grant. */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === "granted";
    }
    return granted;
  } catch {
    return false;
  }
}

/** Fires a native desktop notification. Fire-and-forget, silently a no-op
 * if permission was never granted - callers should gate on their own
 * preference toggle before calling this, not on the permission state. */
export function notify(title: string, body: string) {
  try {
    sendNotification({ title, body });
  } catch {
    // Best-effort - a notification failing shouldn't break the feature that triggered it.
  }
}
