"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/Avatar";
import { Icon } from "@/components/ui/Icon";
import { useIsOnline } from "@/components/providers/PresenceProvider";
import { playNotificationSound, setSoundEnabled, soundEnabled } from "@/lib/notify/sound";
import {
  desktopEnabled,
  desktopPermission,
  requestDesktopPermission,
  setDesktopEnabled,
  type DesktopPermission,
} from "@/lib/notify/desktop";
import { roleLabel } from "@/lib/shared/roles";
import { AvatarDialog } from "./AvatarDialog";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import type { AuthUser } from "@/lib/types";

export function AccountMenu({ user, avatar_url }: { user: AuthUser; avatar_url: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [password_open, setPasswordOpen] = useState(false);
  const [avatar_open, setAvatarOpen] = useState(false);
  const [signing_out, setSigningOut] = useState(false);
  const host_ref = useRef<HTMLDivElement>(null);
  const trigger_ref = useRef<HTMLButtonElement>(null);
  const online = useIsOnline(user.id);
  // Read on mount rather than at module scope: localStorage does not exist
  // during the server render, and reading it there would break hydration.
  const [sound, setSound] = useState(true);
  useEffect(() => setSound(soundEnabled()), []);

  /**
   * Desktop notifications.
   *
   * Both pieces of state are read on mount rather than rendered from the server:
   * `Notification.permission` only exists in the browser, and rendering a toggle
   * position on the server would flash the wrong one on hydration.
   */
  const [desktop, setDesktop] = useState(false);
  const [permission, setPermission] = useState<DesktopPermission>("default");
  useEffect(() => {
    setDesktop(desktopEnabled());
    setPermission(desktopPermission());
  }, []);

  async function toggleDesktop() {
    if (desktop) {
      setDesktop(false);
      setDesktopEnabled(false);
      return;
    }

    // Asked HERE, inside a click. Browsers refuse — or permanently block — a
    // permission prompt raised without a user gesture, which is why nothing
    // requests this on page load.
    const result = await requestDesktopPermission();
    setPermission(result);
    if (result === "granted") {
      setDesktopEnabled(true);
      setDesktop(true);
    }
  }

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!host_ref.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger_ref.current?.focus();
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }

  return (
    <>
      <div className="relative shrink-0" ref={host_ref}>
        <button
          ref={trigger_ref}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${open ? "Close" : "Open"} account menu for ${user.displayName}`}
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-2 rounded-full p-0.5 transition hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <Avatar
            person={{ id: user.id, name: user.displayName, avatarUrl: avatar_url }}
            size="h-10 w-10"
            online={online}
          />
          <span className="hidden pr-2 text-left xl:block">
            <span className="block max-w-32 truncate text-xs font-bold leading-tight text-ink-2">
              {user.displayName}
            </span>
            <span className="mt-0.5 block text-[9px] font-semibold uppercase tracking-[0.1em] text-faint">
              {roleLabel(user.role)}
            </span>
          </span>
        </button>

        {open ? (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-2xl bg-surface shadow-[0_20px_60px_rgba(0,0,0,0.18)] ring-1 ring-line-2"
          >
            <div className="border-b border-line bg-panel px-4 py-3">
              <p className="truncate text-sm font-bold text-ink">{user.displayName}</p>
              <p className="mt-0.5 truncate text-[11px] text-faint">
                @{user.username} · {roleLabel(user.role)}
              </p>
            </div>
            <div className="p-2">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setAvatarOpen(true);
                }}
                className="flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-xs font-semibold text-body transition hover:bg-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <Icon name="users" className="h-3.5 w-3.5 shrink-0 text-faint" />
                Profile picture
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = !sound;
                  setSound(next);
                  setSoundEnabled(next);
                  // Play it when switching ON, so the choice is confirmed by the
                  // thing being chosen rather than by a label changing.
                  if (next) playNotificationSound();
                }}
                aria-pressed={sound}
                className="flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-xs font-semibold text-body transition hover:bg-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <Icon name="bell" className="h-3.5 w-3.5 shrink-0 text-faint" />
                <span className="flex-1">Notification sound</span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                    sound ? "bg-ok-soft text-ok" : "bg-subtle-2 text-muted"
                  }`}
                >
                  {sound ? "ON" : "OFF"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => void toggleDesktop()}
                aria-pressed={desktop}
                disabled={permission === "unsupported"}
                title={
                  permission === "denied"
                    ? "Blocked in your browser settings for this site"
                    : permission === "unsupported"
                      ? "This browser has no notification support"
                      : "Show a notification outside the browser when a message arrives"
                }
                className="flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-xs font-semibold text-body transition hover:bg-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Icon name="alert" className="h-3.5 w-3.5 shrink-0 text-faint" />
                <span className="flex-1">
                  Desktop alerts
                  {/* Said out loud, because the obvious assumption about a
                      "desktop notification" is that it works with the site
                      closed — and this one does not. A setting that quietly does
                      less than the user expects is worse than one that is
                      honest about its limits. */}
                  <span className="mt-0.5 block text-[10px] font-normal text-faint">
                    {permission === "denied"
                      ? "Blocked — allow notifications in your browser settings"
                      : permission === "unsupported"
                        ? "Not supported by this browser"
                        : "Only while a tab is open"}
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                    desktop ? "bg-ok-soft text-ok" : "bg-subtle-2 text-muted"
                  }`}
                >
                  {desktop ? "ON" : "OFF"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setPasswordOpen(true);
                }}
                className="flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-xs font-semibold text-body transition hover:bg-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <Icon name="key" className="h-3.5 w-3.5 shrink-0 text-faint" />
                Change password
              </button>
              <button
                type="button"
                disabled={signing_out}
                onClick={signOut}
                className="flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-xs font-semibold text-body transition hover:bg-bad-soft hover:text-bad focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
              >
                <Icon name="logout" className="h-3.5 w-3.5 shrink-0 text-faint" />
                {signing_out ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {avatar_open ? (
        <AvatarDialog
          user={user}
          currentUrl={avatar_url}
          onClose={() => setAvatarOpen(false)}
          onDone={() => {
            setAvatarOpen(false);
            router.refresh();
          }}
        />
      ) : null}

      {password_open ? (
        <ChangePasswordDialog
          onClose={() => setPasswordOpen(false)}
          onDone={() => {
            setPasswordOpen(false);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
