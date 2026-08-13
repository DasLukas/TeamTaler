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

## Final Result

final result: passed
