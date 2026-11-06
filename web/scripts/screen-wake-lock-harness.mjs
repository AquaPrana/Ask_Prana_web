// Lifecycle checks for the Voice Chat screen wake lock.
import { createServer } from "vite";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const server = await createServer({
  root: process.cwd(),
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const { createVoiceScreenWakeLock, SCREEN_WAKE_LOCK_UNAVAILABLE } = await server.ssrLoadModule(
    "/src/lib/ask-prana-screen-wake-lock.ts",
  );

  const makeLock = () => {
    const listeners = new Set();
    return {
      released: false,
      addEventListener(_type, listener) { listeners.add(listener); },
      removeEventListener(_type, listener) { listeners.delete(listener); },
      async release() { this.released = true; },
      browserRelease() { for (const listener of listeners) listener(); },
    };
  };

  // Acquisition, no duplicate while the request or the lock is active.
  {
    let requests = 0;
    let note = "unset";
    let visible = true;
    const pending = deferred();
    const wake = createVoiceScreenWakeLock({
      supported: true,
      request: () => {
        requests += 1;
        return pending.promise;
      },
      isDocumentVisible: () => visible,
      onUnavailable: (message) => { note = message; },
    });
    wake.open(1, true);
    wake.onDocumentVisibility(1, true);
    assert(requests === 1, "a second request started before the first finished");
    const lock = makeLock();
    pending.resolve(lock);
    await Promise.resolve();
    wake.onDocumentVisibility(1, true);
    assert(requests === 1, "an active lock was requested again");
    assert(note === null, "a granted lock still showed the unavailable note");
    await wake.close(1);
    assert(lock.released, "closing Voice Chat did not release the lock");
  }

  // A request that finishes after close is released and does not stay held.
  {
    let requests = 0;
    const pending = deferred();
    const wake = createVoiceScreenWakeLock({
      supported: true,
      request: () => {
        requests += 1;
        return requests === 1 ? pending.promise : Promise.resolve(makeLock());
      },
      isDocumentVisible: () => true,
      onUnavailable: () => undefined,
    });
    wake.open(1, true);
    await wake.close(1);
    const late = makeLock();
    pending.resolve(late);
    await Promise.resolve();
    await Promise.resolve();
    assert(late.released, "a lock granted after close was kept");
    wake.open(2, true);
    await Promise.resolve();
    assert(requests === 2, "the next session did not acquire its own lock");
    await wake.close(1);
    await wake.close(2);
  }

  // An older close must not release the newer session's lock.
  {
    const locks = [];
    const wake = createVoiceScreenWakeLock({
      supported: true,
      request: async () => {
        const lock = makeLock();
        locks.push(lock);
        return lock;
      },
      isDocumentVisible: () => true,
      onUnavailable: () => undefined,
    });
    wake.open(1, true);
    await Promise.resolve();
    wake.open(2, true);
    await Promise.resolve();
    await wake.close(1);
    assert(locks[0].released, "the first session lock was not released");
    assert(!locks[1].released, "the older session released the newer lock");
    await wake.close(2);
    assert(locks[1].released, "the newer session did not release its own lock");
  }

  // Browser release while hidden waits for visibility. A rejection is not retried.
  {
    let requests = 0;
    let visible = true;
    let note = null;
    let first = null;
    const wake = createVoiceScreenWakeLock({
      supported: true,
      request: async () => {
        requests += 1;
        if (requests === 1) {
          first = makeLock();
          return first;
        }
        throw new Error("denied");
      },
      isDocumentVisible: () => visible,
      onUnavailable: (message) => { note = message; },
    });
    wake.open(3, true);
    await Promise.resolve();
    visible = false;
    first.browserRelease();
    wake.onDocumentVisibility(3, false);
    await Promise.resolve();
    assert(requests === 1, "hiding the document requested another lock");
    visible = true;
    wake.onDocumentVisibility(3, true);
    await Promise.resolve();
    assert(requests === 2, "returning to the document did not reacquire the lock");
    wake.onDocumentVisibility(3, true);
    await Promise.resolve();
    assert(requests === 2, "a rejected wake lock was requested again");
    assert(note === SCREEN_WAKE_LOCK_UNAVAILABLE, "a rejected wake lock did not explain the screen timeout");
    await wake.close(3);
  }

  // Unsupported browsers do not call request and do not retry.
  {
    let requests = 0;
    let note = null;
    const wake = createVoiceScreenWakeLock({
      supported: false,
      request: async () => {
        requests += 1;
        return makeLock();
      },
      isDocumentVisible: () => true,
      onUnavailable: (message) => { note = message; },
    });
    wake.open(4, true);
    wake.onDocumentVisibility(4, true);
    assert(requests === 0, "an unsupported browser still requested a wake lock");
    assert(note === SCREEN_WAKE_LOCK_UNAVAILABLE, "an unsupported browser did not explain the screen timeout");
    await wake.close(4);
  }

  console.log("Screen wake lock harness passed: acquisition, release, visibility recovery, duplicate requests, late completion, and rejection.");
} finally {
  await server.close();
}
