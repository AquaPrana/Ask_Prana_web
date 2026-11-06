/**
 * One screen wake lock for a Voice Chat session.
 * State changes do not request another lock. A request that finishes after the
 * session closes is released immediately, and an older session cannot release
 * a newer session's lock.
 */

export const SCREEN_WAKE_LOCK_UNAVAILABLE =
  "This browser could not keep the screen awake. The phone’s screen-timeout setting may still turn the display off.";

export type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
  removeEventListener?: (type: "release", listener: () => void) => void;
};

export type VoiceScreenWakeLock = {
  open: (sessionId: number, documentVisible: boolean) => void;
  onDocumentVisibility: (sessionId: number, documentVisible: boolean) => void;
  close: (sessionId: number) => Promise<void>;
};

export function createVoiceScreenWakeLock(options: {
  supported: boolean;
  request: () => Promise<WakeLockSentinelLike>;
  isDocumentVisible: () => boolean;
  onUnavailable: (message: string | null) => void;
}): VoiceScreenWakeLock {
  let activeSession: number | null = null;
  let held: { sessionId: number; lock: WakeLockSentinelLike; onRelease: () => void } | null = null;
  let requestingSession: number | null = null;
  let rejectedSession: number | null = null;

  const markUnavailable = (sessionId: number) => {
    rejectedSession = sessionId;
    options.onUnavailable(SCREEN_WAKE_LOCK_UNAVAILABLE);
  };

  const acquire = (sessionId: number) => {
    if (activeSession !== sessionId || rejectedSession === sessionId) return;
    if (held?.sessionId === sessionId || requestingSession === sessionId) return;
    if (!options.supported) {
      markUnavailable(sessionId);
      return;
    }
    requestingSession = sessionId;
    void options.request().then(
      (lock) => {
        if (requestingSession === sessionId) requestingSession = null;
        if (activeSession !== sessionId) {
          void lock.release().catch(() => undefined);
          return;
        }
        const onRelease = () => {
          if (held?.lock !== lock) return;
          held = null;
          if (
            activeSession === sessionId &&
            rejectedSession !== sessionId &&
            options.isDocumentVisible()
          ) {
            acquire(sessionId);
          }
        };
        lock.addEventListener?.("release", onRelease);
        held = { sessionId, lock, onRelease };
        options.onUnavailable(null);
      },
      () => {
        if (requestingSession === sessionId) requestingSession = null;
        if (activeSession !== sessionId) return;
        markUnavailable(sessionId);
      },
    );
  };

  return {
    open(sessionId, documentVisible) {
      const previous = activeSession;
      activeSession = sessionId;
      if (rejectedSession !== sessionId) rejectedSession = null;
      if (previous !== null && previous !== sessionId && held?.sessionId === previous) {
        const old = held;
        held = null;
        old.lock.removeEventListener?.("release", old.onRelease);
        void old.lock.release().catch(() => undefined);
      }
      if (documentVisible) acquire(sessionId);
    },
    onDocumentVisibility(sessionId, documentVisible) {
      if (activeSession !== sessionId || !documentVisible) return;
      acquire(sessionId);
    },
    async close(sessionId) {
      if (activeSession === sessionId) activeSession = null;
      if (rejectedSession === sessionId) rejectedSession = null;
      const current = held;
      if (!current || current.sessionId !== sessionId) {
        if (activeSession === null) options.onUnavailable(null);
        return;
      }
      held = null;
      current.lock.removeEventListener?.("release", current.onRelease);
      try {
        await current.lock.release();
      } catch {
        // The browser may already have released it.
      }
      if (activeSession === null) options.onUnavailable(null);
    },
  };
}
