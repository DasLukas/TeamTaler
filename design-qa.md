# Booking Workspace Production Sheet Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-production-bottom-sheet-reference.png`
- Collapsed implementation: `/tmp/teamtaler-booking-production-sheet-collapsed.png`
- Expanded implementation: `/tmp/teamtaler-booking-production-sheet-expanded.png`
- Required-reason implementation: `/tmp/teamtaler-booking-production-sheet-required-reason.png`
- Desktop stretched-card reference: `/tmp/teamtaler-cart-card-stretched-before.png`
- Desktop uniform-card implementation: `/tmp/teamtaler-cart-card-uniform-after.png`
- Selected-product reference without direct reduction: `/tmp/teamtaler-booking-production-sheet-collapsed.png`
- Quantity-one direct remove implementation: `/tmp/teamtaler-product-direct-remove-mobile.png`
- Quantity-two direct decrement implementation: `/tmp/teamtaler-product-direct-decrease-mobile.png`
- Desktop direct decrement implementation: `/tmp/teamtaler-product-direct-decrease-desktop.png`
- Final quantity-one implementation: `/tmp/teamtaler-product-direct-controls-final.png`
- Recipient dropdown keyboard failure: `/tmp/teamtaler-member-dialog-keyboard-before.png`
- Keyboard-safe recipient sheet: `/tmp/teamtaler-recipient-sheet-keyboard-after.png`
- First-product quick checkout: `/tmp/teamtaler-cart-first-product-open.png`
- Second-product automatic cart peek: `/tmp/teamtaler-cart-second-product-auto-peek.png`
- Single-target result summary: `/tmp/teamtaler-cart-single-target-result-tablet.png`
- Multi-target icon equation: `/tmp/teamtaler-cart-multi-target-icons-tablet.png`
- Minimized cart without recipient identity: `/tmp/teamtaler-cart-peek-without-recipient.png`
- Restored tablet recipient dropdown: `/tmp/teamtaler-recipient-dropdown-tablet-restored.png`
- Shared swipeable sheet handle: `/tmp/teamtaler-shared-bottom-sheet-handle.png`
- User-defined price auto-reveal: `/tmp/teamtaler-price-entry-auto-reveal.png`
- Desktop user-defined price auto-reveal: `/tmp/teamtaler-desktop-price-entry-auto-reveal.png`
- Concise temporary-guest creator: `/tmp/teamtaler-guest-creator-concise-clean.png`
- Multi-target total above equation: `/tmp/teamtaler-summary-total-above-equation.png`
- Route: `http://127.0.0.1:5173/book`
- Primary viewport: 412 × 915 CSS pixels at device scale factor 1
- Required-reason viewport: 393 × 852 CSS pixels at device scale factor 1
- Software-keyboard simulation viewport: 412 × 540 CSS pixels at device scale factor 1
- Source and primary implementation captures: 412 × 915 pixels
- State: one fixed-price product for the current member, collapsed and expanded cart states

## Full-View Comparison Evidence

The production account sheet and booking cart were captured at the same 412 × 915 viewport and reviewed together. The booking cart now matches the shared sheet's 28 px top radius, 44 × 5 px centered handle, 20 px horizontal content inset, white surface, `--shadow-sheet` elevation, slide-up motion, header typography, and Lucide close affordance.

The booking cart intentionally remains a persistent, non-modal sheet above the bottom navigation. It therefore does not copy the production modal's dimmed backdrop or cover the bottom navigation. This preserves direct product selection and navigation access while using the same visual language.

## Focused Region Comparison Evidence

- Source radius: `28px 28px 0 0`; implementation radius: `28px 28px 0 0`.
- Source shadow: `rgba(3, 24, 47, 0.14) 0 -16px 44px`; implementation uses the same `--shadow-sheet` value.
- Source handle: 44 × 5 px, horizontally centered; implementation: 44 × 5 px, horizontally centered.
- Source and implementation body inset: 20 px.
- The expanded implementation uses the same 28 px Lucide `X` icon and 1.8 stroke weight as the shared production modal.
- Selected product cards retain their original 106 px mobile footprint while reserving a separate 44 × 44 px trailing action. Quantity two uses a minus icon; quantity one uses a trash icon in the same location.

## Required Fidelity Surfaces

- Fonts and typography: passed. Existing Inter tokens, heading weight, compact labels, and button typography remain unchanged and align with the production component.
- Spacing and layout rhythm: passed. Radius, handle, body inset, header spacing, elevation, and persistent checkout rhythm match the production sheet system.
- Colors and visual tokens: passed. The implementation reuses the production white surface, muted handle, sheet shadow, teal summary, and primary action tokens.
- Image quality and assets: passed. Existing brand and product assets are unchanged; the close affordance reuses the existing Lucide icon dependency.
- Copy and content: passed. Booking-specific cart, recipient, result, reason, and action copy remain task-appropriate while adopting the production component structure.

## Interaction And Responsive Evidence

- Selecting a fixed-price product reveals the collapsed sheet with the result and booking action visible above mobile navigation.
- `Bearbeiten` expands line editing; the close icon restores the collapsed state.
- At 393 × 852, four products across two recipients keep the mandatory reason and disabled confirmation action fully visible.
- Entering the mandatory reason enables the eight-booking confirmation action.
- At 1024 × 768, the desktop inspector remains non-sheet, contains its own scroll region, and has no horizontal overflow.
- At 1024 × 768, one fixed-price line retains its intrinsic 150 px height instead of stretching to the 427 px details region. Additional fixed-price lines use the same intrinsic height and spacing.
- On a 412 × 915 viewport, selecting a product exposes two unambiguous actions: the main card increases quantity and the trailing 44 px control decreases it. Decreasing from two to one replaces the minus with an explicit remove action; removing the final unit clears the cart.
- The selected product's accessible main action changes from “add” to “increase”, while its reduction and removal controls expose independent accessible names.
- Browser console warnings and errors were checked after the target interactions.
- On phones and tablets, the recipient editor uses the shared modal sheet with a fixed header and isolated scrolling content; desktop retains the anchored dropdown.
- At 412 × 540, the former dropdown placed the guest add action below the viewport. The revised sheet ends exactly at the 540 px visual viewport edge and keeps the guest input and 42 px add action visible at 512 px, including while the text field is focused.
- Shared modal sheets synchronize their height and bottom offset with `window.visualViewport`, so a keyboard that overlays rather than resizes the layout viewport cannot cover the focused controls.
- At 393 × 852, the first fixed-price product opens the complete 257 px quick-checkout sheet. Selecting a second fixed-price product automatically reduces it to a 77 px peek directly above the 76 px mobile navigation, revealing substantially more catalogue content without losing count, recipient, or total.
- The open cart exposes only the production handle; the separate visible minimize icon is removed. The handle accepts a downward drag and a tap or keyboard fallback, while the complete peek reopens the checkout with one tap.
- A user-defined-price product bypasses automatic minimization and opens the details state so its required price input is immediately available.
- The open cart header no longer repeats the selected recipient name. With one recipient, the result area contains only the booking count and total; with several recipients, Lucide product, people, and booking icons replace the repeated word labels while the complete equation remains available to screen readers.
- At 957 × 632, the landscape-tablet sheet begins at the 250 px sidebar boundary, spans the remaining 707 px, and keeps its complete result and action area visible without horizontal overflow.
- At 393 × 852, the minimized 77 px cart exposes only `Warenkorb`, the product count, total, and expand icon. Recipient names are absent from both its visible content and accessible button name.
- Every shared mobile sheet exposes a 72 × 28 px interactive handle area around the existing 44 × 5 px visual grip. Pointer, touch, and mouse-fallback tests cover drag following, the 64 px and velocity close thresholds, incomplete-gesture snap-back, and accessible tap dismissal without attaching dismissal to scrollable content.
- At 957 × 632, the recipient picker is again a 340 px anchored dropdown aligned to its square trigger, with no native modal backdrop or sheet handle. Its complete member list and guest controls remain independently scrollable.
- At 957 × 632, selecting a fifth, user-defined-price product scrolls the cart details region to `scrollTop: 610`, keeps the complete 238.5 px target line inside the 292.7 px details viewport, and focuses its 48 px price input. The persistent checkout remains fully inside the viewport at 510.5–620 px, and neither the document nor body gains horizontal overflow.
- At 1440 × 900, selecting the same fifth, user-defined-price product scrolls the desktop inspector to `scrollTop: 304`, keeps its 238.5 px line and 48 px focused input fully inside the 598.5 px details viewport, and retains the checkout at 738–868 px without horizontal overflow.
- The temporary-guest creator removes the redundant visible “Gast direkt hinzufügen” label and uses “Neuer Gast” inside the input. The field retains the former accessible name, its adjacent plus action remains disabled while empty and enabled after text input, and the 1024 × 768 anchored picker has no horizontal overflow.
- At 957 × 632, the multi-target checkout leads with the 18 px `3,00 €` total and places the 14 px icon equation on its own line 4 px underneath. The divider is removed, the complete localized equation remains available to assistive technology, and the summary has no overflow.

## Findings

No actionable P0, P1, or P2 differences remain.

The absence of a modal backdrop and continued visibility of bottom navigation are intentional persistent-sheet behavior, not fidelity defects.

## Comparison History

- Initial mismatch: the booking cart was rectangular, translucent, lacked the production handle and radius, used a custom shadow, and exposed a text-only expanded close action.
- Fix: reused the production sheet radius, handle dimensions, elevation token, surface color, horizontal inset, motion, heading treatment, and close icon affordance.
- Post-fix evidence: the collapsed and expanded captures match the production component's core visual surfaces while preserving the booking workflow's persistent non-modal behavior.
- Follow-up mismatch: a single desktop cart line stretched from its intrinsic 150 px height to the complete 427 px details region.
- Follow-up fix: aligned the details grid and line grid to the start and made implicit line tracks use `max-content` sizing.
- Follow-up evidence: the revised one-line capture measures 150 px while the scrollable details region remains 427 px, leaving predictable whitespace below the card without changing checkout placement.
- Direct-control mismatch: selected catalog cards exposed only increment through the product surface, so decrement or removal required opening the cart.
- Direct-control fix: split the selected card into a large increment target and a separate 44 px decrement target that becomes a trash action at quantity one.
- Direct-control evidence: mobile quantity-one and quantity-two captures retain the product layout without horizontal overflow; the full interaction loop returns the product to quantity zero and removes the cart sheet.
- Recipient-picker mismatch: the anchored mobile dropdown used a percentage-based viewport limit and allowed the guest input and add action to fall below a reduced visual viewport.
- Recipient-picker fix: compact screens now use the existing production modal sheet, a fixed header, a dedicated scroll region, safe-area padding, focus scroll alignment, and visual-viewport keyboard offsets.
- Recipient-picker evidence: the complete member list, guest input, and add action remain visible and operable at a simulated 412 × 540 software-keyboard height.
- Cart-height mismatch: the open checkout remained large while the user continued selecting ordinary products, obscuring catalogue choices.
- Cart-height fix: introduced explicit peek, summary, and details states; removed the separate minimize icon; added handle drag thresholds; and automatically selects peek after every subsequent fixed-price product tap while retaining details for required price entry.
- Cart-height evidence: the rendered 393 × 852 flow transitions from the complete first-product checkout to a 77 px second-product peek with no horizontal overflow and reopens without changing cart intent.
- Price-entry visibility fix: every compact user-defined-product selection emits a new reveal request, opens cart details, aligns the matching line inside the internal scroll region, and focuses the required price field without moving the persistent checkout.
- Price-entry visibility evidence: after four fixed-price lines, the fifth user-defined line and its focused input were both fully visible; Browser console errors and warnings remained empty.
- Desktop parity fix: price-entry reveal requests are no longer limited to compact layouts, so the persistent desktop inspector applies the same exact-line scroll and input-focus behavior.

## Final Result

final result: passed
