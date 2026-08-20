import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "vesper.intel.liveChannel";

/** Which local chat channel the Intel Check "Live" tab watches - persisted so it
 * doesn't need re-picking every time the app restarts. Stored as "channel|listener"
 * since the same channel name can appear once per logged-in character. */
export function useIntelChannel() {
  const [channel, setChannel] = useState<{ channelName: string; listener: string } | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const [channelName, listener] = raw.split("|");
      return channelName ? { channelName, listener: listener ?? "" } : null;
    } catch {
      return null;
    }
  });

  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      if (channel) {
        localStorage.setItem(STORAGE_KEY, `${channel.channelName}|${channel.listener}`);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Not worth surfacing - worst case the choice doesn't persist.
    }
  }, [channel]);

  return [channel, setChannel] as const;
}
