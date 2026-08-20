import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const DRAG_THRESHOLD_PX = 6;

interface DragState {
  id: string;
  startX: number;
  startY: number;
  dragging: boolean;
}

/**
 * Left-click-and-hold reordering for a vertical list (or a wrapping row of
 * chips, via axis "wrap"): drag past a small threshold to start moving an
 * item, live-reorders as the pointer crosses sibling midpoints, and
 * suppresses the click that would otherwise fire on release after a real
 * drag (so plain clicks still work for selection).
 */
export function useDragReorder(order: string[], onReorder: (next: string[]) => void, axis: "vertical" | "wrap" = "vertical") {
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const dragState = useRef<DragState | null>(null);
  const justDraggedRef = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const setItemRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) itemRefs.current.set(id, el);
      else itemRefs.current.delete(id);
    },
    [],
  );

  const handlePointerDown = useCallback(
    (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      dragState.current = { id, startX: event.clientX, startY: event.clientY, dragging: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragState.current;
      if (!state) return;

      if (!state.dragging) {
        const moved =
          axis === "wrap"
            ? Math.hypot(event.clientX - state.startX, event.clientY - state.startY)
            : Math.abs(event.clientY - state.startY);
        if (moved < DRAG_THRESHOLD_PX) return;
        state.dragging = true;
        setDraggingId(state.id);
      }

      const others = order.filter((id) => id !== state.id);
      let insertIndex = others.length;
      for (let i = 0; i < others.length; i++) {
        const el = itemRefs.current.get(others[i]);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (axis === "wrap") {
          // Reading order: a point counts as "before" a chip if it's above
          // the chip's row entirely, or in the same row but left of its
          // horizontal midpoint - so drags reorder left-to-right, top-to-
          // bottom the way the chips actually wrap, not by Y alone.
          const inRow = event.clientY >= rect.top && event.clientY < rect.bottom;
          if (event.clientY < rect.top || (inRow && event.clientX < rect.left + rect.width / 2)) {
            insertIndex = i;
            break;
          }
        } else if (event.clientY < rect.top + rect.height / 2) {
          insertIndex = i;
          break;
        }
      }

      const next = [...others];
      next.splice(insertIndex, 0, state.id);
      if (next.some((id, i) => id !== order[i])) {
        onReorder(next);
      }
    },
    [order, onReorder, axis],
  );

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (dragState.current?.dragging) {
      justDraggedRef.current = true;
    }
    dragState.current = null;
    setDraggingId(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const consumeJustDragged = useCallback(() => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return true;
    }
    return false;
  }, []);

  return { draggingId, setItemRef, handlePointerDown, handlePointerMove, handlePointerUp, consumeJustDragged };
}
