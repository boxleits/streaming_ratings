import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectionManager } from "../public/js/connection.js";

// Simulates the real EventSource API to the extent the manager needs,
// including a method to reproduce the exact mobile behavior: the
// connection "dies silently" (readyState -> CLOSED) WITHOUT "onerror"
// firing. That's exactly what happens on iOS/Android when the OS
// hard-kills the network connection on screen lock/backgrounding, instead
// of cleanly delivering an error to the tab.
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url) {
    this.url = url;
    this.readyState = FakeEventSource.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  // --- Test helpers, not part of the real EventSource API ---
  simulateOpen() {
    this.readyState = FakeEventSource.OPEN;
    if (this.onopen) this.onopen();
  }
  simulateMessage(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
  simulateSilentDeath() {
    this.readyState = FakeEventSource.CLOSED;
    // deliberately NOT calling this.onerror() - that's the core of the bug
  }
}
FakeEventSource.instances = [];

function fakeDocument(initialVisibility = "visible") {
  const listeners = {};
  return {
    visibilityState: initialVisibility,
    addEventListener(type, cb) {
      (listeners[type] ||= []).push(cb);
    },
    _fire(type) {
      (listeners[type] || []).forEach((cb) => cb());
    },
  };
}

function fakeWindow() {
  const listeners = {};
  return {
    addEventListener(type, cb) {
      (listeners[type] ||= []).push(cb);
    },
    _fire(type) {
      (listeners[type] || []).forEach((cb) => cb());
    },
  };
}

function freshManager(overrides = {}) {
  FakeEventSource.instances = [];
  let clock = 0;
  const doc = fakeDocument();
  const win = fakeWindow();
  const messages = [];
  const mgr = createConnectionManager({
    url: "/api/stream",
    EventSourceImpl: FakeEventSource,
    documentRef: doc,
    windowRef: win,
    staleThresholdMs: 1000,
    watchdogIntervalMs: 100000, // real timer deliberately huge; watchdog is triggered manually in tests
    now: () => clock,
    onMessage: (d) => messages.push(d),
    onBroken: () => {},
    ...overrides,
  });
  return {
    mgr,
    doc,
    win,
    messages,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("Android scenario: watchdog detects a silently dead connection and reconnects", () => {
  const { mgr, advance } = freshManager();

  mgr.start();
  assert.equal(FakeEventSource.instances.length, 1);
  FakeEventSource.instances[0].simulateOpen();

  // Connection dies silently (no onerror) - typical mobile background behavior.
  FakeEventSource.instances[0].simulateSilentDeath();

  advance(2000); // > staleThresholdMs
  mgr.ensureFreshConnection(); // this is what the setInterval watchdog would normally do

  assert.equal(
    FakeEventSource.instances.length,
    2,
    "the watchdog should have opened a new connection after the silent connection death"
  );
  mgr.stop();
});

test("reconnect is triggered as soon as the page becomes visible again (screen unlocked)", () => {
  const { mgr, doc, advance } = freshManager();

  mgr.start();
  FakeEventSource.instances[0].simulateOpen();

  advance(5000); // phone was backgrounded / screen locked for a while
  doc.visibilityState = "visible";
  doc._fire("visibilitychange");

  assert.equal(
    FakeEventSource.instances.length,
    2,
    "a visibility change should have triggered a reconnect for a stale connection"
  );
  mgr.stop();
});

test("no unnecessary reconnect while the connection is still fresh", () => {
  const { mgr, advance } = freshManager();

  mgr.start();
  FakeEventSource.instances[0].simulateOpen();

  advance(100); // well below the stale threshold
  mgr.ensureFreshConnection();

  assert.equal(FakeEventSource.instances.length, 1, "should NOT reconnect while the connection is fresh");
  mgr.stop();
});

test("visibility change does NOT trigger a reconnect if the connection is still fresh", () => {
  const { mgr, doc, advance } = freshManager();

  mgr.start();
  FakeEventSource.instances[0].simulateOpen();

  advance(100);
  doc.visibilityState = "visible";
  doc._fire("visibilitychange");

  assert.equal(FakeEventSource.instances.length, 1, "a fresh connection should remain untouched when becoming visible");
  mgr.stop();
});

test("ping events mark the connection as fresh but are NOT passed through to onMessage", () => {
  const { mgr, messages, advance } = freshManager();

  mgr.start();
  const es = FakeEventSource.instances[0];
  es.simulateOpen();

  advance(900); // just below the threshold
  es.simulateMessage({ type: "ping" });
  advance(900); // again just below the threshold SINCE the ping

  mgr.ensureFreshConnection();

  assert.equal(FakeEventSource.instances.length, 1, "a ping should have marked the connection as fresh");
  assert.equal(messages.length, 0, "a ping must not be treated like a normal message");
  mgr.stop();
});

test("normal messages are passed through to onMessage and update the timestamp", () => {
  const { mgr, messages, advance } = freshManager();

  mgr.start();
  const es = FakeEventSource.instances[0];
  es.simulateOpen();

  es.simulateMessage({ type: "upsert", id: "42", title: "Test Movie" });
  advance(900);
  mgr.ensureFreshConnection();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "42");
  assert.equal(FakeEventSource.instances.length, 1, "an upsert should have kept the connection fresh, just like ping");
  mgr.stop();
});

test("an online event also triggers a reconnect for a stale connection", () => {
  const { mgr, win, advance } = freshManager();

  mgr.start();
  FakeEventSource.instances[0].simulateOpen();

  advance(5000);
  win._fire("online");

  assert.equal(FakeEventSource.instances.length, 2, "an online event should have triggered a reconnect");
  mgr.stop();
});
