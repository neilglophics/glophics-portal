import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

/**
 * The notification chime, tested for the two things that are actually easy to
 * get wrong: that it stays silent when it cannot legally make noise, and that a
 * burst of arrivals is one sound rather than several.
 *
 * There is no AudioContext in Node, which is convenient — it is exactly the
 * "audio unavailable" case, and the module has to survive it rather than throw
 * into a message handler.
 */

const load = async () => {
  // Fresh module per test: the throttle and the cached context are module state.
  const url = `../lib/notify/sound.ts?t=${Math.random()}`;
  return import(url);
};

function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

function withWindow(extra: Record<string, unknown> = {}) {
  (globalThis as { window?: unknown }).window = {
    localStorage: fakeLocalStorage(),
    addEventListener: () => {},
    removeEventListener: () => {},
    ...extra,
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("soundEnabled", () => {
  it("is off when there is no window at all (server render)", async () => {
    const { soundEnabled } = await load();
    assert.equal(soundEnabled(), false);
  });

  it("defaults to ON, because an arriving message is expected to be audible", async () => {
    withWindow();
    const { soundEnabled } = await load();
    assert.equal(soundEnabled(), true);
  });

  it("is silenced only by an explicit off", async () => {
    withWindow();
    const { soundEnabled, setSoundEnabled } = await load();

    setSoundEnabled(false);
    assert.equal(soundEnabled(), false);

    setSoundEnabled(true);
    assert.equal(soundEnabled(), true);
  });

  it("persists the choice where another tab would read it", async () => {
    withWindow();
    const { setSoundEnabled } = await load();
    setSoundEnabled(false);
    assert.equal(
      (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.getItem(
        "serverManager.notificationSound",
      ),
      "off",
    );
  });
});

describe("playNotificationSound", () => {
  it("does not throw when audio is unavailable — it just reports false", async () => {
    // The important property: a missing AudioContext must never surface as an
    // exception inside a Pusher event handler.
    withWindow();
    const { playNotificationSound } = await load();
    assert.equal(playNotificationSound(), false);
  });

  it("does nothing at all when muted", async () => {
    withWindow();
    const { playNotificationSound, setSoundEnabled } = await load();
    setSoundEnabled(false);
    assert.equal(playNotificationSound(), false);
  });

  it("plays once, then throttles a burst", async () => {
    let started = 0;
    // The smallest AudioContext that satisfies the code path.
    class FakeContext {
      state = "running";
      currentTime = 0;
      destination = {};
      resume() {}
      createOscillator() {
        return {
          type: "",
          frequency: { value: 0 },
          connect: (n: unknown) => n,
          start: () => { started += 1; },
          stop: () => {},
        };
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: () => {},
            linearRampToValueAtTime: () => {},
            exponentialRampToValueAtTime: () => {},
          },
          connect: (n: unknown) => n,
        };
      }
    }
    withWindow({ AudioContext: FakeContext });

    const { playNotificationSound } = await load();

    assert.equal(playNotificationSound(), true, "first arrival should sound");
    assert.equal(started, 2, "the chime is two tones");

    // Four more arrivals in the same instant: a lively conversation must not
    // produce four overlapping chimes.
    for (let i = 0; i < 4; i += 1) {
      assert.equal(playNotificationSound(), false, "a burst should be throttled");
    }
    assert.equal(started, 2, "still just the one chime");
  });

  it("stays silent while the context is suspended — no gesture yet", async () => {
    class SuspendedContext {
      state = "suspended";
      currentTime = 0;
      destination = {};
      resume() { /* a browser refuses this without a gesture */ }
      createOscillator(): never { throw new Error("must not be reached"); }
      createGain(): never { throw new Error("must not be reached"); }
    }
    withWindow({ AudioContext: SuspendedContext });

    const { playNotificationSound } = await load();
    // Silence is the correct outcome. Fighting for permission to make noise is
    // worse than being quiet.
    assert.equal(playNotificationSound(), false);
  });
});
