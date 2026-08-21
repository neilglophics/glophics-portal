"use client";

/**
 * The notification chime.
 *
 * ── Synthesised, not a file ──
 *
 * Two short sine tones from the Web Audio API rather than an mp3. No binary in
 * the repo, nothing to licence, no request to make, and it works offline. At this
 * length a real recording would buy nothing a pair of tones does not.
 *
 * ── Browsers will not let a page make noise unprompted ──
 *
 * An AudioContext created before any user gesture starts `suspended`, and
 * resuming it without one is refused. That is a deliberate protection and worth
 * respecting rather than fighting: the context is created lazily, unlocked on the
 * first real interaction, and if it is still suspended when a message arrives the
 * chime is simply skipped. Silence is the correct failure — a page that fights
 * for permission to make noise is worse than a quiet one.
 *
 * ── It has to be muteable ──
 *
 * A sound nobody can turn off is hostile, especially on a board somebody keeps
 * open all day. The preference is persisted per browser, and read fresh on every
 * play so a change in one tab takes effect in that tab immediately.
 */

const STORAGE_KEY = "serverManager.notificationSound";

/** One chime per window, however many messages land. A burst of five arrivals
 *  should be one sound, not five overlapping ones. */
const THROTTLE_MS = 2000;

let context: AudioContext | null = null;
let unlocked = false;
let lastPlayedAt = 0;

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ??
    null
  );
}

export function soundEnabled(): boolean {
  if (typeof window === "undefined") return false;
  // Default ON: an arriving message is the kind of thing people expect to hear.
  // Only an explicit "off" silences it.
  return window.localStorage.getItem(STORAGE_KEY) !== "off";
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
}

/**
 * Called from a real user gesture, which is the only moment a browser will let an
 * AudioContext start. Registered once by the provider on the first click or
 * keypress anywhere in the app.
 */
export function unlockSound(): void {
  if (unlocked) return;

  const Ctor = audioContextCtor();
  if (!Ctor) return;

  try {
    context ??= new Ctor();
    if (context.state === "suspended") void context.resume();
    unlocked = true;
  } catch {
    // No audio available. Not a fault worth reporting to anybody.
  }
}

/** A short two-note chime. Returns whether it actually played. */
export function playNotificationSound(): boolean {
  if (!soundEnabled()) return false;

  const Ctor = audioContextCtor();
  if (!Ctor) return false;

  const now = Date.now();
  if (now - lastPlayedAt < THROTTLE_MS) return false;

  try {
    context ??= new Ctor();

    // Still locked because there has been no gesture yet. Skip rather than
    // attempt a resume that the browser will refuse and log.
    if (context.state === "suspended") {
      void context.resume();
      if (context.state === "suspended") return false;
    }

    const start = context.currentTime;
    // A rising two-note interval reads as "something arrived" rather than as an
    // error. Descending tones are what people associate with failure.
    const notes: [number, number][] = [
      [660, 0], // E5
      [880, 0.09], // A5
    ];

    for (const [frequency, offset] of notes) {
      const osc = context.createOscillator();
      const gain = context.createGain();

      osc.type = "sine";
      osc.frequency.value = frequency;

      const at = start + offset;
      // A ramp rather than a straight start/stop: an abrupt gate on a sine wave
      // produces an audible click at both ends.
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.09, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);

      osc.connect(gain).connect(context.destination);
      osc.start(at);
      osc.stop(at + 0.18);
    }

    lastPlayedAt = now;
    return true;
  } catch {
    return false;
  }
}
