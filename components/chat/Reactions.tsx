"use client";

import { useEffect, useRef, useState } from "react";
import {
  REACTION_EMOJI,
  REACTION_LABEL,
  reactedByViewer,
  reactionTooltip,
  type ReactionEmoji,
  type ReactionGroup,
} from "@/lib/chat/reactions";

/**
 * The reaction row under a message, and the picker that adds to it.
 *
 * ── Three ways to find out who reacted ──
 *
 * The requirement is one thing; the affordance has to be three, because a
 * `title` tooltip does not exist on a touchscreen and hover does not exist on a
 * phone at all:
 *
 *   hover   `title` on each pill — free, and what a mouse user reaches for first.
 *   tap     the ⊕ opens a panel that lists every reaction with its reactors, so
 *           the same information is one tap away with no hover involved.
 *   keyboard the pills and the ⊕ are real buttons, so Tab reaches them and the
 *           same panel opens on Enter.
 *
 * ── Why the pill row is a row of buttons and not one control ──
 *
 * Tapping an existing pill toggles YOUR reaction with that emoji — the gesture
 * everybody already expects from every other chat app. Making it a single control
 * with a menu would put a click between the reader and the thing they wanted to
 * agree with.
 */

export function Reactions({
  reactions,
  viewerId,
  onToggle,
  align,
  disabled,
}: {
  reactions: ReactionGroup[];
  viewerId: string;
  onToggle: (emoji: string) => void;
  /** Follows the bubble's side, so the row reads as belonging to the message
   *  rather than floating between two of them. */
  align: "left" | "right";
  /** A message still sending, or one that has been deleted, cannot be reacted
   *  to — there is no server-side id to attach a reaction to yet in the first
   *  case, and nothing to react to in the second. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // Close on a click anywhere else, and on Escape. Both registered only while
  // open, so a thread with fifty messages is not fifty idle document listeners.
  useEffect(() => {
    if (!open) return;

    function onDocumentDown(event: MouseEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onDocumentDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocumentDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (disabled && !reactions.length) return null;

  return (
    <div
      ref={wrapper}
      className={`relative mt-1 flex flex-wrap items-center gap-1 ${
        align === "right" ? "justify-end" : ""
      }`}
    >
      {reactions.map((group) => {
        const mine = reactedByViewer(group, viewerId);
        return (
          <button
            key={group.emoji}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(group.emoji)}
            // The hover affordance. Says who, not just how many.
            title={`${reactionTooltip(group, viewerId)} reacted ${group.emoji}`}
            // Announced as a toggle, so a screen reader says "pressed" rather
            // than leaving the reader to infer it from a ring they cannot see.
            aria-pressed={mine}
            aria-label={`${group.users.length} ${group.emoji} — ${reactionTooltip(group, viewerId)}`}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
              mine
                ? "bg-brand-soft text-brand-fg ring-1 ring-brand-soft"
                : "bg-subtle-2 text-muted ring-1 ring-line-2 hover:bg-subtle"
            }`}
          >
            <span aria-hidden="true">{group.emoji}</span>
            <span>{group.users.length}</span>
          </button>
        );
      })}

      {disabled ? null : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={reactions.length ? "React, or see who reacted" : "Add a reaction"}
          title={reactions.length ? "React, or see who reacted" : "Add a reaction"}
          className={`grid h-6 w-6 place-items-center rounded-full text-[11px] transition ${
            open
              ? "bg-brand-soft text-brand-fg ring-1 ring-brand-soft"
              : "text-faintest ring-1 ring-line-2 hover:bg-subtle hover:text-muted"
          }`}
        >
          <span aria-hidden="true">☺</span>
        </button>
      )}

      {open ? (
        <div
          role="dialog"
          aria-label="Reactions"
          // Above the row rather than below it: the newest messages sit at the
          // bottom of the scroller, where "below" is off-screen.
          className={`absolute bottom-full z-20 mb-1 w-max max-w-[16rem] rounded-2xl bg-surface p-2 shadow-xl ring-1 ring-line ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <div className="flex items-center gap-0.5">
            {REACTION_EMOJI.map((emoji) => {
              const group = reactions.find((g) => g.emoji === emoji);
              const mine = !!group && reactedByViewer(group, viewerId);
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    onToggle(emoji);
                    // Closed on pick. Reacting twice in a row is rare; a panel
                    // left open over the next message is not.
                    setOpen(false);
                  }}
                  aria-pressed={mine}
                  title={`${REACTION_LABEL[emoji as ReactionEmoji]}${mine ? " — remove yours" : ""}`}
                  className={`grid h-8 w-8 place-items-center rounded-full text-base transition hover:bg-subtle ${
                    mine ? "bg-brand-soft ring-1 ring-brand-soft" : ""
                  }`}
                >
                  <span aria-hidden="true">{emoji}</span>
                  <span className="sr-only">{REACTION_LABEL[emoji as ReactionEmoji]}</span>
                </button>
              );
            })}
          </div>

          {reactions.length ? (
            <div className="mt-2 space-y-1 border-t border-line pt-2">
              {reactions.map((group) => (
                <p key={group.emoji} className="flex items-start gap-1.5 text-[11px] text-faint">
                  <span aria-hidden="true" className="shrink-0">
                    {group.emoji}
                  </span>
                  {/* The full list here, not the abbreviated tooltip — this panel
                      is what somebody opens BECAUSE they want all the names. */}
                  <span className="min-w-0">
                    {group.users.map((u) => (u.id === viewerId ? "You" : u.displayName)).join(", ")}
                  </span>
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
