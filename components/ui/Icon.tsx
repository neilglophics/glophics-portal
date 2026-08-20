import type { IconName } from "@/lib/shared/tokens";

/**
 * The icon set, ported element-for-element from Tokens.ICONS in the legacy
 * public/js/ui/tokens.js. Kept as JSX rather than flattened path strings so the
 * circles and rounded rects stay exactly as drawn.
 *
 * All icons are 24×24, stroked, and inherit `currentColor` — so an icon is
 * coloured by the text colour of whatever contains it, never by a prop.
 */
const SHAPES: Record<IconName, React.ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  servers: (
    <>
      <rect x="2.5" y="5" width="19" height="6" rx="2" />
      <rect x="2.5" y="14" width="19" height="6" rx="2" />
    </>
  ),
  pulse: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  list: <path d="M4 6h16M4 12h16M4 18h10" />,
  alert: (
    <>
      <path d="M12 8v5M12 16.5v.01" />
      <circle cx="12" cy="12" r="8.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0113 0" />
      <path d="M16 5.2a3.5 3.5 0 010 5.6M18 14.3a6.5 6.5 0 013.5 5.7" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3" />
    </>
  ),
  check: <path d="M4 12.5l5 5L20 6.5" />,
  plug: (
    <>
      <path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 01-12 0z" />
      <path d="M12 18v3" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 10-2.3 5.6" />
      <path d="M20 4.5V11h-6.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8.5a6 6 0 10-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5z" />
      <path d="M10.5 19a2 2 0 003 0" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M10.9 12.1L20 3M17 6l2.5 2.5M14.5 8.5L17 11" />
    </>
  ),
  logout: <path d="M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 01-2-2V6a2 2 0 012-2h6" />,
  external: <path d="M7 17L17 7M9 7h8v8" />,
  note: (
    <>
      <path d="M4 4.5h16v11l-4 4H4z" />
      <path d="M20 15.5h-4v4" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chevron: <path d="M9 5l7 7-7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  // New for chat — drawn to match the set's weight and 24×24 box.
  chat: (
    <>
      <path d="M20.5 11.4c0 4-3.8 7.3-8.5 7.3-1 0-2-.15-2.9-.42L4 20.5l1.45-3.6A6.9 6.9 0 013.5 11.4C3.5 7.4 7.3 4.1 12 4.1s8.5 3.3 8.5 7.3z" />
    </>
  ),
};

export function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {SHAPES[name]}
    </svg>
  );
}
