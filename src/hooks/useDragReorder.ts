import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const DRAG_THRESHOLD_PX = 6;

interface DragState {
  id: string;
  startY: number;
  dragging: boolean;
}

/**
 * Left-click-and-hold reordering for a vertical list: drag past a small
 * threshold to start moving an item, live-reorders as the pointer crosses
 * sibling midpoints, and suppresses the click that would otherwise fire on
 * release after a real drag (so plain clicks still work for selection).
 */
export function useDragReorder(order: string[], onReorder: (next: string[]) => void) {
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
      dragState.current = { id, startY: event.clientY, dragging: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragState.current;
      if (!state) return;

      if (!state.dragging) {
        if (Math.abs(event.clientY - state.startY) < DRAG_THRESHOLD_PX) return;
        state.dragging = true;
        setDraggingId(state.id);
      }

      const others = order.filter((id) => id !== state.id);
      let insertIndex = others.length;
      for (let i = 0; i < others.length; i++) {
        const el = itemRefs.current.get(others[i]);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (event.clientY < rect.top + rect.height / 2) {
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
    [order, onReorder],
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
