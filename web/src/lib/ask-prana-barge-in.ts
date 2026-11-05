/**
 * Loudness gate for interrupting a spoken reply.
 *
 * The reply's echo is measured only during the opening moment. Later peaks of
 * the same reply must not raise the volume the user has to beat. Quieter
 * playback lowers that level; a return to the measured reply can come back up
 * to the learned ceiling and no higher.
 */

/** Opening stretch used to measure the reply's own echo. */
export const BARGE_IN_ECHO_LEARN_MS = 450;
/** During that opening only, the measurement settles on the reply quickly. */
export const BARGE_IN_ECHO_LEARN_ATTACK_MS = 80;
/** After that, a quieter reply lowers the interruption level. */
export const BARGE_IN_ECHO_RELEASE_MS = 900;
/** Speech this much louder than the current echo can interrupt. */
export const BARGE_IN_ECHO_RATIO = 1.4;
/**
 * A level this close to the learned echo is the reply itself (including a
 * sentence that comes back after a pause), not a new voice.
 */
export const BARGE_IN_ECHO_REJOIN_RATIO = 0.75;

export type BargeInEchoState = {
  echoRef: number;
  echoCeiling: number;
};

export type BargeInEchoStep = BargeInEchoState & {
  /** True when this sample is the reply returning to its learned loudness. */
  rejoin: boolean;
};

export function stepBargeInEcho(
  state: BargeInEchoState,
  smoothed: number,
  elapsedMs: number,
  mode: "learn" | "follow",
): BargeInEchoStep {
  const elapsed = Math.max(0, elapsedMs);
  const level = Math.max(0, smoothed);
  if (mode === "learn") {
    const tau = level > state.echoRef ? BARGE_IN_ECHO_LEARN_ATTACK_MS : BARGE_IN_ECHO_RELEASE_MS;
    const echoRef = state.echoRef + (level - state.echoRef) * Math.min(1, elapsed / tau);
    return { echoRef, echoCeiling: echoRef, rejoin: false };
  }

  const ceiling = state.echoCeiling;
  if (!(ceiling > 0)) {
    // The opening window was silent. The first audible level becomes the
    // ceiling once, and that frame is still the reply.
    return { echoRef: level, echoCeiling: level, rejoin: true };
  }

  const rejoin =
    level >= ceiling * BARGE_IN_ECHO_REJOIN_RATIO &&
    level <= ceiling * BARGE_IN_ECHO_RATIO;
  if (rejoin) {
    // Back within the reply we already measured. Do not raise the ceiling.
    return { echoRef: Math.min(level, ceiling), echoCeiling: ceiling, rejoin: true };
  }
  if (level < state.echoRef) {
    const drop = (state.echoRef - level) * Math.min(1, elapsed / BARGE_IN_ECHO_RELEASE_MS);
    return {
      echoRef: Math.max(level, state.echoRef - drop),
      echoCeiling: ceiling,
      rejoin: false,
    };
  }
  // Louder than the current echo, and louder than the learned reply.
  // Leave both where they are so this cannot become the required volume.
  return { echoRef: state.echoRef, echoCeiling: ceiling, rejoin: false };
}
