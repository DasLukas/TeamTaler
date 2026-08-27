# TeamTaler Design System

This document is the durable source of truth for TeamTaler's visual language, reusable interaction patterns, and responsive component behavior. Product changes must update this document whenever they introduce or materially change a shared UI pattern. One-off visual QA evidence belongs in a dedicated QA record rather than here.

## Principles

- Prefer the smallest amount of interface copy that still makes an action and its consequence clear.
- Reuse shared components and design tokens instead of reproducing controls inside feature code.
- Preserve semantic HTML, keyboard operation, visible focus, accessible names, and WCAG AA contrast.
- Design member workflows mobile-first. Administrative workspaces may prioritize larger screens but must remain complete and usable on phones.
- Use Lucide as the interface icon family. Icons clarify actions; they never replace an accessible name.

## Appearance, color modes, and themes

Appearance is a color-only layer over the stable TeamTaler component system. A theme may change brand, navigation, selection, focus, and decorative accent colors; it must not change typography, spacing, geometry, icons, content hierarchy, financial semantics, or product identity. Component styles consume semantic tokens rather than palette names or raw theme colors.

The root document exposes the effective `data-theme` and resolved `data-color-scheme` attributes. `SYSTEM` follows the live `prefers-color-scheme` media query, while explicit `LIGHT` and `DARK` selections ignore later operating-system changes. Native controls use the matching CSS `color-scheme`. Public and signed-out surfaces always use the TeamTaler theme, but retain the locally mirrored account color mode to avoid a flash during startup. Authenticated group surfaces resolve their theme as the current membership override followed by the group's default.

Every palette has complete light and dark variants for canvas, raised and muted surfaces, primary and muted text, borders, shadows, shell navigation, primary interaction, selected surfaces, focus, and decorative accents. Dark variants use theme-specific tonal surface scales instead of placing every brand on TeamTaler navy: TeamTaler remains cool navy-petrol, NRW shifts toward forest neutrals, Tief im Westen owns the deep-blue scale, and Fire uses warm charcoal and ember surfaces. Status colors remain semantic and independent: success stays green without borrowing a theme's accent, warning stays amber or orange, and danger stays red even when a brand palette contains the same hue. Financial credit and outstanding-balance meanings remain unchanged.

The four supported palettes use these immutable visual anchors:

- **TeamTaler** preserves the existing navy and teal identity, led by `#03182f` and `#007c73`.
- **NRW** uses green `#009136`, white `#ffffff`, and red `#e2001a`, sampled from the [official NRW flag image](https://www.im.nrw/themen/verwaltung/beflaggung-und-wappen/landesflagge). Controls use darker or lighter derived greens where the anchor itself does not meet text contrast.
- **Tief im Westen** uses Bochum dark blue `#0f2864`, link blue `#002d9a`, bright blue `#0ab4ff`, and yellow `#ffcc01`, taken from the [official City of Bochum web presentation](https://www.bochum.de/Kultur-in-Bochum/Informationen-fuer-Kulturschaffende).
- **Fire** uses the [official RAL 3000 web swatch](https://www.ral-farben.de/farbe/ral-classic/ral-3000/9127), `#962a27`, as its screen reference and combines it with ember amber and charcoal. The CSS value is a reproducible screen approximation, not a colorimetric substitute for a physical RAL sample.

Normal text and controls meet WCAG AA contrast in all eight theme and color-scheme combinations. Focus indicators retain at least 3:1 contrast with adjacent colors. Bright anchors such as Bochum blue and yellow use dark foreground text; dark anchors use white. Theme previews show the immutable palette anchors listed above, while their selection, focus, surface, and text states continue to use the active semantic tokens.

The account appearance controls apply and persist each selection immediately. A failed write restores both the previous rendered appearance and session cache. The current group default appears once in the personal picker with a visible `Gruppenstandard` badge; choosing it stores the durable null override instead of copying the current theme value, so later administrator changes continue to propagate. The group-administration default requires the standard explicit Save action because it changes every inheriting membership.

## Action buttons

`web/src/components/ui/Button.tsx` is the only standard component for labelled actions. Feature code must not recreate its spacing, variants, or responsive behavior.

Every standard action button contains both:

1. a semantic leading icon that describes the action; and
2. a short visible text label that states the action.

Choose the icon for the action's meaning, not merely its location or color. Reuse established mappings such as `Save` for saving, `X` for cancelling, `Check` for confirming, `Plus` for creating, `Pencil` for editing, `Copy` for copying, `RotateCcw` for resetting, `RefreshCw` for resending or refreshing, `Archive` for archiving, and `Trash2` for destructive deletion. Icons inside the shared button are decorative to assistive technology because the text label provides the accessible name.

When an action group lacks horizontal space, reduce button padding before removing information. A dense action may set `collapseLabelAt` to the shared `narrow` range or to the space-constrained `tablet` range; within that range the component becomes a 44-pixel icon button and visually hides its label. The tablet option deliberately restores visible labels on phones when the owning layout stacks actions at full width. Such a button must provide an explicit `aria-label`, and the label remains available to assistive technology. Full-width, primary, confirmation, and safety-critical actions keep their visible label unless their owning pattern proves that the available width is insufficient.

Purpose-built icon-only utility controls, including close, disclosure, menu, and sheet-handle buttons, use `IconButton` or another documented shared primitive. They must expose an `aria-label` and title or equivalent tooltip. Native buttons are reserved for semantic composite widgets such as tabs, listbox options, toggles, and selectable cards; they are not a shortcut around the standard action component.

The `ButtonProps` type requires both an icon and children, so newly introduced text-only standard buttons fail TypeScript validation. Responsive icon-only behavior is tested at the shared component level and must also be exercised in the feature that opts into it.

## Selection menus

Domain choices that benefit from branded or visual identity use the shared `SelectMenu` with a rendered value and option. Group choices consistently pair the protected `GroupMark` logo-or-initial visual with the group name, including account preferences and application navigation. Multiple-choice table filters use the shared `MultiSelectMenu` dropdown when the option set is a compact semantic list; persistent exposed checkbox grids are reserved for workflows where comparing every option at once is the primary task.

Both custom menus preserve native form semantics through accessible combobox, listbox, checkbox, and label relationships. Feature code supplies data and optional visuals but does not recreate menu positioning, keyboard behavior, focus handling, overflow, or elevation.

## Item micro-actions

An action attached to one existing item in a table, list, or card uses the shared `ItemAction` component. It renders a small borderless action with a semantic leading icon and a short visible text label, matching the visual weight of a link while retaining native button behavior. Examples include editing or renewing an invitation, archiving or reactivating a member or group, and opening a permanent-deletion confirmation.

Item micro-actions keep their visible labels at every viewport and wrap as a group when space is constrained. Their accessible names include the affected item when multiple equal actions can appear on one page. A destructive row trigger remains visually neutral; the subsequent confirmation dialog communicates severity and uses the destructive button variant for the irreversible commit. Primary creation, save, submit, and dialog-confirmation controls are not micro-actions and continue to use the standard `Button` variants.

## Confirmation dialogs

Application actions never use browser-native `confirm`, `alert`, or `prompt` dialogs. Confirmable actions use the shared `ConfirmationDialog` component so focus restoration, keyboard dismissal, pending-state protection, responsive action layout, error presentation, icons, and destructive emphasis remain consistent. Feature-specific multi-step workflows may compose the shared `Modal` primitive when they require inputs or richer state, but simple message-and-action confirmations must not recreate dialog markup inside feature code.

## Modal dialogs and bottom sheets

`web/src/components/ui/Modal.tsx` owns modal width, height, overflow, safe-area handling, and responsive sheet behavior. Feature styles must not set a modal's width, maximum width, height, or overflow. Callers select one of the shared `standard`, `wide`, or `workspace` sizes; every `sheet` becomes exactly viewport-wide below the shared compact breakpoint regardless of its desktop size.

On compact screens, input-heavy, selection-heavy, or multi-state workflows use the shared `sheet` variant. This includes creation, editing, import, assignment, and recovery flows whose content may grow or require scrolling. Short decision-only confirmations remain centered dialogs so their visual weight matches the limited decision. Feature code must choose between these two patterns by workflow complexity rather than by the current amount of content.

Modal headers and action footers remain visible. Only the body between them may scroll. Persistent cancel, reset, save, apply, and confirmation controls are passed through the shared `footer` property instead of being placed inside the scrolling content. A nested workflow that owns its own mutation state uses the shared `ModalFooter` compound component to portal those actions into the same fixed footer; feature code must not recreate a fixed or sticky footer. When a footer submit button belongs to a form in the body, the button references that form by its stable `id`. This structure applies equally to centered desktop dialogs and mobile bottom sheets, including when the software keyboard reduces the visual viewport.

Custom multi-select menus expose a search field when the option catalog can grow beyond a short fixed set. Audit action and resource-type filters always use this searchable pattern. Their choices come from the complete authorized server-side audit scope rather than from the currently loaded page or a duplicated frontend registry, so every newly persisted action or resource type becomes selectable automatically.

## Responsive administrative workspaces

Administrative pages remain complete and operable down to the application's 320-pixel minimum viewport. Page grids, panels, cards, forms, and flex children use shrinkable tracks so feature content never creates page-level horizontal scrolling. Long account addresses, identifiers, status details, and audit metadata wrap within their owning surface. Multi-column forms collapse to one column, related actions stack or use the shared button's documented compact presentation, and touch targets retain their minimum size.

Primary tab navigation remains a semantic, keyboard-operable tab list. On narrow viewports it may scroll horizontally within its own full-bleed strip, uses scroll snapping to keep tab labels legible, and never widens the page or the active panel. Feature-specific content must not rely on clipping or `overflow-x: hidden` to conceal a sizing defect.

## Audit tables

Group and instance audit feeds use the shared `AuditEventTable` component. Both contexts preserve the same chronological columns, typography, row behavior, and responsive overflow treatment; feature code only normalizes its API records into the shared entry shape. On narrow viewports the table scrolls within its own bordered region and never expands the page.

## Responsive collection views

Feature-owned card views may replace a shared data table's viewport on phones when scanning complete records vertically is materially easier than horizontal column navigation. Cards and tables must consume the same sorted collection, query controls, export action, cursor loading, empty/error state, and item actions; they are representations of one result set rather than separate data flows. Only the active representation is rendered, avoiding duplicate media requests and hidden interactive controls.

The mobile activity feed defaults to cards below 768 pixels and safely stores the last card/table choice as a versioned device preference. Its icon-only view action always names the destination view, while cards retain a dedicated accessible sorting sheet because table-header sorting is unavailable. Tablet and desktop continue to use the semantic table. Every activity card exposes the transaction type, signed amount, detail, member and actor identities, lifecycle state, category, timestamp, posting state, receipt, and reversal action without relying on color or icons alone.

## Documentation ownership

- This file owns enduring visual and interaction-system rules.
- `ARCHITECTURE.md` owns structural frontend constraints and component boundaries.
- `CONTRIBUTING.md` owns implementation and verification requirements.
- `design-qa.md` and future QA records contain time-bound comparison evidence, not normative design rules.
- `README.md` remains the production system-administrator entry point and does not contain contributor design guidance.
