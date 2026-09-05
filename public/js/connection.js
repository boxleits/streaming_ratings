// Connection manager for the /api/stream SSE endpoint.
//
// Deliberately built as a pure factory function with injected dependencies
// (EventSource implementation, document/window, "now" function) so its
// behavior can be tested without a real browser - in particular the mobile
// scenario where a connection "dies silently" (readyState becomes CLOSED
// without "onerror" firing), e.g. when iOS/Android hard-kills the network
// connection when the screen locks.
export function createConnectionManager({
  url,
  EventSourceImpl,
  documentRef,
  windowRef,
  staleThresholdMs = 35000,
  watchdogIntervalMs = 10000,
  onMessage,
  onBroken,
  now = () => Date.now(),
}) {
  let currentSource = null;
  let lastEventAt = now();
  let watchdogTimer = null;

  function connect() {
    if (currentSource) {
      try {
        currentSource.close();
      } catch (err) {
        /* already dead, doesn't matter */
      }
      currentSource = null;
    }

    const es = new EventSourceImpl(url);
    currentSource = es;

    es.onopen = () => {
      lastEventAt = now();
    };

    es.onmessage = (evt) => {
      lastEventAt = now();
      let data;
      try {
        data = JSON.parse(evt.data);
      } catch (err) {
        return;
      }
      if (data.type === "ping") return; // pure liveness signal, no UI action
      if (onMessage) onMessage(data);
    };

    es.onerror = () => {
      if (onBroken) onBroken();
      // Deliberately NO manual close()/reconnect here - per spec, the
      // browser retries on its own. The watchdog below catches the cases
      // where that doesn't work reliably (e.g. after mobile backgrounding)
      // or where "onerror" never fires at all.
    };

    return es;
  }

  function isClosed() {
    if (!currentSource) return true;
    const CLOSED = EventSourceImpl.CLOSED ?? 2;
    return currentSource.readyState === CLOSED;
  }

  function ensureFreshConnection() {
    const staleFor = now() - lastEventAt;
    if (staleFor > staleThresholdMs || isClosed()) {
      connect();
    }
  }

  function start() {
    connect();
    watchdogTimer = setInterval(ensureFreshConnection, watchdogIntervalMs);
    if (watchdogTimer && typeof watchdogTimer.unref === "function") {
      watchdogTimer.unref(); // doesn't keep e.g. Node processes/tests alive unnecessarily
    }
    if (documentRef) {
      documentRef.addEventListener("visibilitychange", () => {
        if (documentRef.visibilityState === "visible") ensureFreshConnection();
      });
    }
    if (windowRef) {
      windowRef.addEventListener("pageshow", () => ensureFreshConnection());
      windowRef.addEventListener("online", () => ensureFreshConnection());
    }
  }

  function stop() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (currentSource) currentSource.close();
  }

  return { start, stop, ensureFreshConnection };
}
