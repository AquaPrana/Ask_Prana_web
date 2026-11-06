/**
 * Ordered Voice Chat language changes.
 * A new capture starts only after the previous recorder or recognizer is released.
 * Rapid taps keep the latest language; an older turn cannot cancel that capture.
 */

export type VoiceLanguageSwitchHandlers<Mode extends string> = {
  /** Drop an in-flight listen so it cannot become the active session. */
  invalidate: () => void;
  cancelCapture: () => Promise<void>;
  startCapture: (mode: Mode) => Promise<unknown>;
  isSessionOpen: () => boolean;
  isMuted: () => boolean;
};

export type VoiceLanguageSwitch<Mode extends string> = {
  request: (mode: Mode) => Promise<void>;
  abandon: () => void;
};

/**
 * True only when this attempt still owns the capture.
 * A newer language selection has a different attempt id and must be left running.
 */
export function shouldReleaseOwnedCapture(ownerAttempt: number, currentAttempt: number): boolean {
  return ownerAttempt === currentAttempt;
}

export function createVoiceLanguageSwitch<Mode extends string>(
  handlers: VoiceLanguageSwitchHandlers<Mode>,
): VoiceLanguageSwitch<Mode> {
  let token = 0;
  let latestMode: Mode | null = null;
  let chain: Promise<void> = Promise.resolve();

  const request = (mode: Mode) => {
    token += 1;
    const myToken = token;
    latestMode = mode;
    handlers.invalidate();
    const run = chain.then(async () => {
      if (myToken !== token) return;
      await handlers.cancelCapture();
      if (myToken !== token) return;
      if (!handlers.isSessionOpen() || handlers.isMuted()) return;
      const selected = latestMode;
      if (selected == null || myToken !== token) return;
      await handlers.startCapture(selected);
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const abandon = () => {
    token += 1;
    latestMode = null;
    handlers.invalidate();
  };

  return { request, abandon };
}
