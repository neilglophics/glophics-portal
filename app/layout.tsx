import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Glophics Portal",
  description: "Which QA/staging environments are free, and which are held by a Jira ticket.",
};

/**
 * Applied before the body renders so a dark-mode user never sees a white flash.
 * Ported from the inline script in the legacy public/index.html.
 *
 * This has to be inline and blocking: any deferred script runs after first paint,
 * which is exactly the flash it exists to prevent. `dangerouslySetInnerHTML` is
 * the only way to emit a script body in JSX, and it is safe here because the
 * content is this constant — nothing user-supplied reaches it.
 *
 * The stored palette values are validated against a whitelist and a strict hex
 * pattern before being written as CSS custom properties, so a tampered
 * localStorage cannot inject a value into the stylesheet.
 */
const THEME_INIT = `
try {
  var palettes = ["violet", "ocean", "emerald", "custom"];
  var modes = ["system", "light", "dark"];
  var palette = localStorage.getItem("serverManager.colorTheme");
  var mode = localStorage.getItem("serverManager.theme");
  if (palettes.indexOf(palette) < 0) palette = "violet";
  if (modes.indexOf(mode) < 0) mode = "system";
  var dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = palette;
  document.documentElement.classList.toggle("dark", dark);
  if (palette === "custom") {
    var stored = JSON.parse(localStorage.getItem("serverManager.customThemeTokens") || "null");
    var tokens = stored && stored[dark ? "dark" : "light"];
    if (!tokens) {
      document.documentElement.dataset.theme = "violet";
    } else {
      Object.keys(tokens).forEach(function (property) {
        var value = tokens[property];
        if (property.indexOf("--color-") === 0 && /^#[0-9a-f]{6}$/i.test(value)) {
          document.documentElement.style.setProperty(property, value);
        }
      });
    }
  }
} catch (e) {
  document.documentElement.dataset.theme = "violet";
  document.documentElement.classList.toggle("dark", matchMedia("(prefers-color-scheme: dark)").matches);
}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      {/* overflow-hidden guarantees only the sidebar and main pane scroll, never
          the document, so the shell can never be pushed off-screen. */}
      <body className="h-full overflow-hidden bg-canvas font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
