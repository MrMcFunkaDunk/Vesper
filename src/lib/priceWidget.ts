import { invoke } from "@tauri-apps/api/core";

export function isPriceWidgetOpen(): Promise<boolean> {
  return invoke("is_price_widget_open");
}

/** Opens the floating always-on-top price widget - a small native window,
 * independent of VESPER's own window, that stays visible over the game
 * client. `regionId` fixes which region's sell-min price it looks up. */
export function openPriceWidget(regionId: number): Promise<void> {
  return invoke("open_price_widget", { regionId });
}

export function closePriceWidget(): Promise<void> {
  return invoke("close_price_widget");
}
