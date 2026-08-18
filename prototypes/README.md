# Prototypes

Design explorations. Nothing here is wired to the app — no `State`, no
`/api/*`, no Jira. The numbers are hand-written so a layout can be judged
without waiting on real data.

## dashboard-tailwind.html

A soft-lavender SaaS treatment of the dashboard: floating rounded shell,
sidebar with accounts as permanent navigation, gradient hero, environment
cards, and a right rail with a utilization ring.

```bash
node server.js
# → http://localhost:4000/prototypes/dashboard-tailwind.html
```

Opening the file directly works too — it needs no server.

### About the Tailwind setup

This file loads the **Tailwind v4 browser build** from a CDN, which compiles
the classes in the page at load. That keeps the prototype a single file with
no toolchain, matching how the rest of this project works.

Do not ship it that way. The browser build downloads the compiler on every
page load, flashes unstyled content before it finishes, and needs a network
round-trip to a third party. For production, compile the CSS ahead of time:

```bash
npm install -D tailwindcss @tailwindcss/cli
npx @tailwindcss/cli -i css/tailwind.src.css -o css/tailwind.css --minify
```

Then replace the CDN `<script>` and the inline `@theme` block with a single
`<link rel="stylesheet" href="css/tailwind.css">`, and move the `@theme`
block into `css/tailwind.src.css`.

**The decision that actually matters:** that command is a build step, and
this project deliberately has none — `server.js` serves the files on disk
exactly as they are, so `git pull && node server.js` is the whole setup.
Adopting Tailwind properly means a `package.json`, a `node_modules/`, and a
watch process during development, plus remembering to rebuild the CSS before
committing. That is a normal trade, but it is a real one, and it is worth
making deliberately rather than inheriting it from a prototype.

If you want the look without the toolchain, the same design can be written
against the existing `css/style.css` token system — the palette, radii and
shadows here are all expressible as plain CSS custom properties.

### Fonts

Uses **Plus Jakarta Sans** from Google Fonts, not the app's IBM Plex Sans.
The rounded, geometric feel is a large part of why the reference design
reads the way it does. Switching the app's typeface is its own decision,
independent of the layout.
