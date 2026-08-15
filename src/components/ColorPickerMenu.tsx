import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PaletteColor } from "../lib/palettes";

interface ColorPickerMenuProps {
  x: number;
  y: number;
  palette: PaletteColor[];
  value: string | undefined;
  onSelect: (hex: string) => void;
  onReset: () => void;
  onClose: () => void;
}

function ColorPickerMenu({ x, y, palette, value, onSelect, onReset, onClose }: ColorPickerMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: y, left: x });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - 8;
    const maxTop = window.innerHeight - rect.height - 8;
    setPosition({
      left: Math.min(x, Math.max(8, maxLeft)),
      top: Math.min(y, Math.max(8, maxTop)),
    });
  }, [x, y]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="color-menu" style={{ top: position.top, left: position.left }} role="menu">
      <div className="color-menu-label">Icon Color</div>
      <div className="color-menu-grid">
        {palette.map((color) => (
          <button
            key={color.hex}
            type="button"
            role="menuitemradio"
            aria-checked={value === color.hex}
            aria-label={color.name}
            title={color.name}
            className={`color-swatch${value === color.hex ? " color-swatch-selected" : ""}`}
            style={{ background: color.hex }}
            onClick={() => {
              onSelect(color.hex);
              onClose();
            }}
          />
        ))}
      </div>
      <button
        type="button"
        className="color-menu-reset"
        onClick={() => {
          onReset();
          onClose();
        }}
      >
        Reset to Default
      </button>
    </div>
  );
}

export default ColorPickerMenu;
