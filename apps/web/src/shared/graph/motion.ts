/** Easing for camera moves. Strong ease-out arrives gently; ease-in-out suits a deliberate dive. */
export const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One step's timeline: the camera moves first, then the narrator speaks, then data moves. */
export const STEP_LEAD_MS = 350;
export const PACKET_LEAD_S = 0.5;
/** The camera's glide between steps; the narrator waits for most of it, not all. */
export const SCENE_CAMERA_MS = 450;
/** A packet crosses a link in TRAVEL_S; the next one sets off PACKET_GAP_S after the last. */
export const TRAVEL_S = 1.3;
export const PACKET_GAP_S = 1.7;
