/**
 * Development-only stage timings for one Voice Chat turn.
 * The id is the recording's turn id, so silence, transcription, the answer,
 * and playback share one line. Nothing here records audio, credentials, or transcript text.
 */

let activeTurnId: string | null = null;

export function beginVoiceTurnTiming(turnId: string) {
  if (process.env.NODE_ENV === "production") return;
  activeTurnId = turnId;
}

export function currentVoiceTurnId() {
  return activeTurnId;
}

export function logVoiceTurnStage(
  stage: string,
  detail?: Record<string, string | number | boolean | null>,
) {
  if (process.env.NODE_ENV === "production") return;
  console.debug("[AskPranaVoiceTiming]", stage, {
    turnId: activeTurnId,
    at: Math.round(performance.now()),
    ...detail,
  });
}
