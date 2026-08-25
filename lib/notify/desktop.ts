"use client";

/**
 * Desktop notifications — the operating-system kind, outside the browser window.
 *
 * ── What this can and cannot do, stated plainly ──
 *
 * This is the **Notification API**, which is delivered by the page. It fires while
 * a tab of this app is open — including when that tab is in the background, behind
 * another window, or on another virtual desktop. It does **not** fire when the
 * site is closed, because there is no page running to raise it.
 *
 * Notifying somebody who has closed the site entirely needs a different mechanism:
 * a Service Worker plus **Web Push** with VAPID keys, a per-device subscription
 * stored server-side, and a push send from the server on every message. That is a
 * real feature with real consequences — a background worker, a subscription
 * lifecycle to keep clean as devices come and go, and messages leaving through
 * a push service. It is deliberately NOT what this file does, and the toggle says
 * so, because a notification setting that quietly does less than the user assumes
 * is worse than one that is honest.
 *
 * ── Permission is asked for on a gesture, never on load ──
 *
 * Browsers increasingly refuse — or permanently block — a permission prompt that
 * appears without one, and Firefox and Safari require a user gesture outright. So
 * nothing here asks until somebody turns the toggle on. A page that demands
 * permission on arrival is the reason browsers made this hostile.
 *
 * Same shape as lib/notify/sound.ts: a per-browser preference in localStorage,
 * read fresh on every use so a change in one tab takes effect there immediately.
 */

const STORAGE_KEY = "serverManager.desktopNotifications";

/** One notification per conversation at a time. Re-using the tag REPLACES the
 *  previous one rather than stacking, so a burst of five messages in one thread is
 *  one notification showing the latest, not a column of five. */
const tagFor = (conversationId: string) => `chat:${conversationId}`;

export type DesktopPermission = "unsupported" | "default" | "granted" | "denied";

export function desktopPermission(): DesktopPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as DesktopPermission;
}

/**
 * The stored preference.
 *
 * Default OFF, unlike the chime. A sound is contained in the tab; an OS
 * notification puts this app in front of whatever somebody is doing, so it is
 * opt-in — and it cannot be on by default anyway, since it needs a permission
 * only the person can grant.
 */
export function desktopEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (desktopPermission() !== "granted") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "on";
}

export function setDesktopEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
}

/**
 * Asks the browser, from a user gesture.
 *
 * Returns the resulting permission so the caller can say something useful — in
 * particular, `denied` is close to permanent: browsers do not re-prompt, and the
 * only way back is the site settings panel. Telling somebody that is much better
 * than a toggle that silently refuses to stay on.
 */
export async function requestDesktopPermission(): Promise<DesktopPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";

  try {
    return (await Notification.requestPermission()) as DesktopPermission;
  } catch {
    // Older Safari used a callback form and can reject. Not worth a shim: the
    // toggle simply does not turn on.
    return desktopPermission();
  }
}

/**
 * Raises one notification, if it is wanted and allowed.
 *
 * Never throws. It is called from the middle of an event handler that also has to
 * update the badge and the conversation list, and a browser refusing to show a
 * notification must not take those with it.
 *
 * Clicking focuses this window and navigates to the conversation — the whole point
 * of the notification is to get somebody back to the message.
 */
export function showDesktopNotification(input: {
  title: string;
  body: string;
  conversationId: string;
  href: string;
}): boolean {
  if (!desktopEnabled()) return false;

  try {
    const notification = new Notification(input.title, {
      body: input.body,
      tag: tagFor(input.conversationId),
      // The app icon rather than none, so it is identifiable in a stack of
      // notifications from other apps.
      icon: "/favicon.ico",
      // Not `requireInteraction`: a work chat should not leave a notification on
      // screen until it is dismissed by hand.
      silent: false,
    });

    notification.onclick = () => {
      // Focus first — on most platforms this raises the browser window — then
      // navigate. `window.focus()` alone lands them on whatever page was open.
      window.focus();
      window.location.href = input.href;
      notification.close();
    };

    return true;
  } catch {
    // Some browsers throw when constructing a Notification on a page that is not
    // allowed one, rather than returning a permission that says so.
    return false;
  }
}
