"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/Avatar";
import { Icon } from "@/components/ui/Icon";
import { roleLabel } from "@/lib/shared/roles";
import { useIsOnline } from "@/components/providers/PresenceProvider";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { AvatarDialog } from "./AvatarDialog";
import type { AuthUser } from "@/lib/types";

/**
 * The signed-in account dropdown. Ported from Shell.renderAccountMenu.
 *
 * Closes on an outside click and on Escape. The legacy version needed a
 * capture-phase listener to avoid closing itself in the same gesture that opened
 * it — that problem was an artifact of re-rendering the button out from under the
 * click, which React does not do here, so a plain listener is enough.
 */
export function AccountMenu({ user, avatarUrl }: { user: AuthUser; avatarUrl: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const online = useIsOnline(user.id);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
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
    // A full navigation, not router.push: it drops every cached Server Component
    // payload along with the session, so nothing from the signed-in board can be
    // read out of the router cache afterwards.
    window.location.href = "/login";
  }

  return (
    <>
      <div className="relative shrink-0" ref={hostRef}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex shrink-0 items-center gap-3 rounded-full pl-0 pr-1 transition hover:opacity-80"
        >
          <Avatar person={{ id: user.id, name: user.displayName, avatarUrl }} size="h-10 w-10" online={online} />
          <span className="hidden text-left lg:block">
            <span className="block text-sm font-semibold leading-tight">{user.displayName}</span>
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-faint">
              {roleLabel(user.role)}
            </span>
          </span>
        </button>

        {open ? (
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-2 w-56 rounded-2xl bg-surface p-2 shadow-xl ring-1 ring-line"
          >
            <div className="border-b border-line px-3 pb-2.5 pt-1.5">
              <p className="truncate text-sm font-semibold">{user.displayName}</p>
              <p className="truncate text-[11px] text-faint">@{user.username}</p>
            </div>
            <div className="pt-1.5">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setAvatarOpen(true);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-body transition hover:bg-subtle hover:text-ink"
              >
                <Icon name="users" className="h-3.5 w-3.5 shrink-0 text-faint" />
                Profile picture
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setPasswordOpen(true);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-body transition hover:bg-subtle hover:text-ink"
              >
                <Icon name="key" className="h-3.5 w-3.5 shrink-0 text-faint" />
                Change password
              </button>
              <button
                type="button"
                disabled={signingOut}
                onClick={signOut}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-body transition hover:bg-subtle hover:text-ink disabled:opacity-50"
              >
                <Icon name="logout" className="h-3.5 w-3.5 shrink-0 text-faint" />
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {avatarOpen ? (
        <AvatarDialog
          user={user}
          currentUrl={avatarUrl}
          onClose={() => setAvatarOpen(false)}
          onDone={() => router.refresh()}
        />
      ) : null}

      {passwordOpen ? (
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
