import { invoke } from "@tauri-apps/api/core";

export interface IntelChannelInfo {
  channel_name: string;
  /** Which of your logged-in characters has been listening to this channel. */
  listener: string;
  /** Unix seconds - most recently active channel/character pair sorts first. */
  last_active: number;
}

/** Every distinct (channel, character) pair found in EVE's local chat logs - lets the
 * user pick a real channel name instead of typing one from memory. */
export function listIntelChannels(): Promise<IntelChannelInfo[]> {
  return invoke("list_intel_channels");
}

export interface IntelLine {
  timestamp: string;
  speaker: string;
  message: string;
}

export interface IntelChannelPoll {
  lines: IntelLine[];
  cursor: number;
}

/** Reads whatever's new in a channel's local log file since `cursor` (0 = "never
 * polled" - starts near the end rather than replaying the whole session).
 * `listener` disambiguates - channel names like "Local" aren't unique to one
 * character, every logged-in character gets their own log file for it. */
export function pollIntelChannel(channelName: string, listener: string, cursor: number): Promise<IntelChannelPoll> {
  return invoke("poll_intel_channel", { channelName, listener, cursor });
}
