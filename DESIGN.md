# TeamTaler Design System

This document is the durable source of truth for TeamTaler's visual language, reusable interaction patterns, and responsive component behavior. Product changes must update this document whenever they introduce or materially change a shared UI pattern. One-off visual QA evidence belongs in a dedicated QA record rather than here.

## Principles

- Prefer the smallest amount of interface copy that still makes an action and its consequence clear.
- Reuse shared components and design tokens instead of reproducing controls inside feature code.
- Preserve semantic HTML, keyboard operation, visible focus, accessible names, and WCAG AA contrast.
- Design member workflows mobile-first. Administrative workspaces may prioritize larger screens but must remain complete and usable on phones.
- Use Lucide as the interface icon family. Icons clarify actions; they never replace an accessible name.

## Action buttons

`web/src/components/ui/Button.tsx` is the only standard component for labelled actions. Feature code must not recreate its spacing, variants, or responsive behavior.

Every standard action button contains both:

1. a semantic leading icon that describes the action; and
2. a short visible text label that states the action.

Choose the icon for the action's meaning, not merely its location or color. Reuse established mappings such as `Save` for saving, `X` for cancelling, `Check` for confirming, `Plus` for creating, `Pencil` for editing, `Copy` for copying, `RotateCcw` for resetting, `RefreshCw` for resending or refreshing, `Archive` for archiving, and `Trash2` for destructive deletion. Icons inside the shared button are decorative to assistive technology because the text label provides the accessible name.

When an action group lacks horizontal space, reduce button padding before removing information. A dense action may set `collapseLabelAt` to the shared `narrow` range or to the space-constrained `tablet` range; within that range the component becomes a 44-pixel icon button and visually hides its label. The tablet option deliberately restores visible labels on phones when the owning layout stacks actions at full width. Such a button must provide an explicit `aria-label`, and the label remains available to assistive technology. Full-width, primary, confirmation, and safety-critical actions keep their visible label unless their owning pattern proves that the available width is insufficient.

Purpose-built icon-only utility controls, including close, disclosure, menu, and sheet-handle buttons, use `IconButton` or another documented shared primitive. They must expose an `aria-label` and title or equivalent tooltip. Native buttons are reserved for semantic composite widgets such as tabs, listbox options, toggles, and selectable cards; they are not a shortcut around the standard action component.

The `ButtonProps` type requires both an icon and children, so newly introduced text-only standard buttons fail TypeScript validation. Responsive icon-only behavior is tested at the shared component level and must also be exercised in the feature that opts into it.

## Item micro-actions

An action attached to one existing item in a table, list, or card uses the shared `ItemAction` component. It renders a small borderless action with a semantic leading icon and a short visible text label, matching the visual weight of a link while retaining native button behavior. Examples include editing or renewing an invitation, archiving or reactivating a member or group, and opening a permanent-deletion confirmation.

Item micro-actions keep their visible labels at every viewport and wrap as a group when space is constrained. Their accessible names include the affected item when multiple equal actions can appear on one page. A destructive row trigger remains visually neutral; the subsequent confirmation dialog communicates severity and uses the destructive button variant for the irreversible commit. Primary creation, save, submit, and dialog-confirmation controls are not micro-actions and continue to use the standard `Button` variants.

## Confirmation dialogs

Application actions never use browser-native `confirm`, `alert`, or `prompt` dialogs. Confirmable actions use the shared `ConfirmationDialog` component so focus restoration, keyboard dismissal, pending-state protection, responsive action layout, error presentation, icons, and destructive emphasis remain consistent. Feature-specific multi-step workflows may compose the shared `Modal` primitive when they require inputs or richer state, but simple message-and-action confirmations must not recreate dialog markup inside feature code.

## Responsive administrative workspaces

Administrative pages remain complete and operable down to the application's 320-pixel minimum viewport. Page grids, panels, cards, forms, and flex children use shrinkable tracks so feature content never creates page-level horizontal scrolling. Long account addresses, identifiers, status details, and audit metadata wrap within their owning surface. Multi-column forms collapse to one column, related actions stack or use the shared button's documented compact presentation, and touch targets retain their minimum size.

Primary tab navigation remains a semantic, keyboard-operable tab list. On narrow viewports it may scroll horizontally within its own full-bleed strip, uses scroll snapping to keep tab labels legible, and never widens the page or the active panel. Feature-specific content must not rely on clipping or `overflow-x: hidden` to conceal a sizing defect.

## Audit tables

Group and instance audit feeds use the shared `AuditEventTable` component. Both contexts preserve the same chronological columns, typography, row behavior, and responsive overflow treatment; feature code only normalizes its API records into the shared entry shape. On narrow viewports the table scrolls within its own bordered region and never expands the page.

## Documentation ownership

- This file owns enduring visual and interaction-system rules.
- `ARCHITECTURE.md` owns structural frontend constraints and component boundaries.
- `CONTRIBUTING.md` owns implementation and verification requirements.
- `design-qa.md` and future QA records contain time-bound comparison evidence, not normative design rules.
- `README.md` remains the production system-administrator entry point and does not contain contributor design guidance.
