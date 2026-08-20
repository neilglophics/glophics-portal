/**
 * Named, jittered, overlap-safe intervals.
 *
 * Three things a plain `setInterval` does not give you, and all three bit the
 * previous implementation in one place or another:
 *
 *   - overlap guard: a health check or a Jira sync that runs long must not
 *     start a second copy of itself on top of the first;
 *   - jitter: several intervals started at the same instant (as they are, at
 *     boot) would otherwise always fire in the same order every time, which
 *     is a fine way to hide a bug where two jobs interact;
 *   - a single place to stop everything on shutdown, so a graceful exit does
 *     not have to remember every setInterval handle by name.
 */

const timers = new Map();

function schedule(name, intervalMs, fn, { jitterMs = 0, runImmediately = false } = {}) {
  if (timers.has(name)) throw new Error(`A job named "${name}" is already scheduled.`);

  let running = false;
  const tick = async () => {
    if (running) return; // overlap guard
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[jobs] ${name} failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  const start = () => {
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    timers.set(name, timer);
    if (runImmediately) tick().catch(() => {});
  };

  if (jitterMs > 0) {
    const delay = Math.floor(Math.random() * jitterMs);
    const initial = setTimeout(start, delay);
    initial.unref();
    // Held under the same name so stopAll() can clear it even if it fires
    // before the real interval is registered.
    timers.set(name, initial);
  } else {
    start();
  }
}

function stopAll() {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
}

module.exports = { schedule, stopAll };
