// src/utils/equalityGuards.ts
// Guards for state that is measured rather than discrete.
//
// React bails out of a re-render when a setState is handed the identical value, so a guard here
// is not about correctness - it is about not scheduling the work at all. Both matter on a path
// that fires per frame: ResizeObserver can deliver a callback for a resize that changed nothing
// this component cares about (a sibling moved, a scrollbar appeared elsewhere in the subtree), and
// the resulting no-op setState still walks the update queue.

/**
 * Returns a setter that drops writes equal to what the state already holds.
 *
 * The identity check is on the value the caller passes, so callers must pass primitives (or an
 * object they already build fresh). For a measured size that is always true.
 */
export const keepIfChanged = <T,>(current: T, next: T): T => (current === next ? current : next);

/**
 * Returns a setter for a measured width/height pair that drops writes equal to the current pair.
 *
 * Sizes are the case that makes this worth a helper: a ResizeObserver callback usually carries
 * both dimensions, and guarding only one leaves a re-render on every notification.
 */
export const keepIfSizeChanged = (
    current: { width: number; height: number },
    next: { width: number; height: number },
): { width: number; height: number } => (
    current.width === next.width && current.height === next.height ? current : next
);

/**
 * True when a ResizeObserver entry's content rect is worth acting on.
 *
 * Zero is excluded on purpose: an element that is display:none, detached mid-transition, or not
 * yet laid out reports 0x0, and writing that into layout state collapses a visualizer to nothing.
 * Callers that can render at zero (a panel that genuinely has no height yet) should not use this.
 */
export const isMeasurableSize = (width: number, height: number): boolean => width > 0 && height > 0;
