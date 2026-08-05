# TeamTaler brand asset

`teamtaler-mark.png` is the canonical TeamTaler double-coin mark supplied by the product owner on 2026-08-05. All in-app fallback branding and installable-web-app icons are derived from this source so the product identity stays consistent across browser, iOS, and Android surfaces.

The adjacent TeamTaler wordmark must remain code-native text for accessibility and responsive rendering.

The browser and installable-web-app assets derived from the source mark are:

- `/favicon.ico` for browser tabs and legacy clients.
- `/apple-touch-icon.png` for iOS and iPadOS home screens.
- `/icons/icon-192.png` and `/icons/icon-512.png` for standard web-app installs.
- `/icons/icon-maskable-512.png` for adaptive Android launchers; the source composition keeps the coin and initials inside the maskable safe zone.

`site.webmanifest` declares the installable application identity and references these generated assets. Regenerate all derived files from `teamtaler-mark.png` whenever the source mark changes.
