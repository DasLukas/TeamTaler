# TeamTaler brand asset

`teamtaler-mark.png` is the original TeamTaler coin-and-team mark generated with the built-in OpenAI image generation tool on 2026-08-04. The magenta generation background was removed locally and the final asset contains transparency.

The adjacent TeamTaler wordmark must remain code-native text for accessibility and responsive rendering.

The browser and installable-web-app assets derived from the source mark are:

- `/favicon.ico` for browser tabs and legacy clients.
- `/apple-touch-icon.png` for iOS and iPadOS home screens.
- `/icons/icon-192.png` and `/icons/icon-512.png` for standard web-app installs.
- `/icons/icon-maskable-512.png` with an opaque brand background and safe padding for adaptive Android launchers.

`site.webmanifest` declares the installable application identity and references these generated assets. Regenerate all derived files from `teamtaler-mark.png` whenever the source mark changes.
