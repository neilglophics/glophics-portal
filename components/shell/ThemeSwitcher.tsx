"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";

/**
 * Appearance: palette plus light/dark/system. Ported from public/js/ui/theme.js.
 *
 * The same two localStorage keys are used, so a browser that has already picked a
 * theme in the legacy app keeps it here. The values are read before first paint
 * by the inline script in app/layout.tsx; this component only writes them and
 * applies the change live.
 *
 * NOT ported: the "custom" palette and its token editor. The pre-paint script
 * still honours a stored custom palette, so anyone who set one keeps it — there
 * is just no UI here to build a new one yet. See docs/04-MIGRATION-PLAN.md.
 */

const MODE_KEY = "serverManager.theme";
const PALETTE_KEY = "serverManager.colorTheme";

type Mode = "system" | "light" | "dark";
type Palette = "violet" | "ocean" | "emerald";

const MODES: { id: Mode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** "violet" is the base @theme in globals.css — the name is legacy, the palette
 *  is the teal Glophics brand. Kept as-is so stored preferences still resolve. */
const PALETTES: { id: Palette; label: string; swatch: string }[] = [
  { id: "violet", label: "Default", swatch: "#007f6d" },
  { id: "ocean", label: "Ocean", swatch: "#0369a1" },
  { id: "emerald", label: "Emerald", swatch: "#047857" },
];

function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(mode: Mode, palette: Palette) {
  const root = document.documentElement;
  root.dataset.theme = palette;
  root.classList.toggle("dark", mode === "dark" || (mode === "system" && prefersDark()));
}

export function ThemeSwitcher() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("system");
  const [palette, setPalette] = useState<Palette>("violet");
  const hostRef = useRef<HTMLDivElement>(null);

  // Read what the pre-paint script already applied, rather than assuming the
  // defaults — otherwise the first interaction would snap the theme back.
  useEffect(() => {
    const storedMode = localStorage.getItem(MODE_KEY) as Mode | null;
    const storedPalette = localStorage.getItem(PALETTE_KEY) as Palette | null;
    if (storedMode && MODES.some((m) => m.id === storedMode)) setMode(storedMode);
    if (storedPalette && PALETTES.some((p) => p.id === storedPalette)) setPalette(storedPalette);
  }, []);

  // "System" has to keep tracking the OS while the tab is open.
  useEffect(() => {
    if (mode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system", palette);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode, palette]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!hostRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function chooseMode(next: Mode) {
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
    apply(next, palette);
  }

  function choosePalette(next: Palette) {
    setPalette(next);
    localStorage.setItem(PALETTE_KEY, next);
    apply(mode, next);
  }

  return (
    <div className="relative shrink-0" ref={hostRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Appearance"
        aria-label="Appearance"
        onClick={() => setOpen((v) => !v)}
        className="grid h-9 w-9 place-items-center rounded-full text-faint ring-1 ring-line-2 transition hover:bg-brand-soft hover:text-brand-fg hover:ring-brand-soft"
      >
        <Icon name="gear" className="h-4 w-4" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-2 w-56 rounded-2xl bg-surface p-3 shadow-xl ring-1 ring-line"
        >
          <p className="px-1 pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-faint">Mode</p>
          <div className="flex gap-1 rounded-xl bg-subtle-2 p-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => chooseMode(m.id)}
                className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition ${
                  mode === m.id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <p className="px-1 pb-2 pt-4 text-[10px] font-bold uppercase tracking-[0.12em] text-faint">
            Palette
          </p>
          <div className="space-y-0.5">
            {PALETTES.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => choosePalette(p.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition ${
                  palette === p.id ? "bg-brand-soft text-brand-fg" : "text-body hover:bg-subtle"
                }`}
              >
                <span
                  className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-black/10"
                  style={{ background: p.swatch }}
                />
                <span className="flex-1">{p.label}</span>
                {palette === p.id ? <Icon name="check" className="h-3.5 w-3.5" /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
