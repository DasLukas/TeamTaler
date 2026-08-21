# TeamTaler brand assets

The product identity uses two deliberately separate asset classes:

- `teamtaler-emblem-transparent.webp` is the optimized transparent emblem used by the shared `Brand` component in application chrome and authentication layouts. The component does not accept image overrides. Group logos belong exclusively to group selectors and group-management surfaces, so changing the active group can never replace the TeamTaler identity.
- `teamtaler-mark.png` is the background-backed source mark supplied by the product owner on 2026-08-05. Browser and installable-web-app icons remain derived from this source because their launch surfaces require a stable background composition.

The adjacent TeamTaler wordmark must remain code-native text for accessibility and responsive rendering.

The browser and installable-web-app assets derived from the source mark are:

- `/favicon.ico` for browser tabs and legacy clients.
- `/apple-touch-icon.png` for iOS and iPadOS home screens.
- `/icons/icon-192.png` and `/icons/icon-512.png` for standard web-app installs.
- `/icons/icon-maskable-512.png` for adaptive Android launchers; the source composition keeps the coin and initials inside the maskable safe zone.

`site.webmanifest` declares the installable application identity and references only the background-backed generated assets. Regenerate these derived files from `teamtaler-mark.png` whenever the install identity changes; never derive them implicitly from the transparent in-app emblem.
