export interface PaletteColor {
  name: string;
  hex: string;
}

/**
 * The 12-color set from EVE's own Neocom icon-color picker, reused here for
 * sidebar item recoloring. Grey is the implicit default (not selectable) -
 * kept separate so other palettes added later don't collide with this one.
 */
export const SIDEBAR_DEFAULT_COLOR = "#9CA3AF";

export const SIDEBAR_PALETTE: PaletteColor[] = [
  { name: "Red", hex: "#FF4040" },
  { name: "Orange", hex: "#FF9F40" },
  { name: "Yellow", hex: "#FFFF40" },
  { name: "Green", hex: "#9FFF40" },
  { name: "Teal", hex: "#40FF9F" },
  { name: "Blue", hex: "#4040FF" },
  { name: "Indigo", hex: "#409FFF" },
  { name: "Purple", hex: "#9F40FF" },
  { name: "Pink", hex: "#FF40FF" },
  { name: "Bright Pink", hex: "#FF409F" },
  { name: "Cyan", hex: "#40FFFF" },
  { name: "Lime Green", hex: "#40FF40" },
];
