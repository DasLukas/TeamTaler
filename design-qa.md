# Mixed Activities Design QA

## Comparison Target

- Selected direction: `/Users/lukaswaschul/.codex/generated_images/01a03069-b0bd-7e63-96e1-b22687eecdbc/exec-36a903e3-1490-4a36-9a19-1f891add6322.png`
- Desktop implementation: `/tmp/teamtaler-activities-desktop.png`
- Tablet implementation: `/tmp/teamtaler-activities-tablet.png`
- Mobile implementation: `/tmp/teamtaler-activities-mobile.png`
- Mobile filter implementation: `/tmp/teamtaler-activities-filter-mobile.png`
- Full comparison: `/tmp/teamtaler-activities-comparison.png`
- Focused table comparison: `/tmp/teamtaler-activities-table-comparison.png`
- Route: `http://127.0.0.1:5173/activities`
- Desktop viewport: 1440 × 1024 CSS pixels at device scale factor 1
- Tablet viewport: 1024 × 768 CSS pixels at device scale factor 1
- Mobile viewport: 393 × 852 CSS pixels at device scale factor 1
- State: unified booking, payment, and correction history sorted by timestamp descending

## Full-View Comparison Evidence

The selected direction and implementation were reviewed side by side in `/tmp/teamtaler-activities-comparison.png`. The implementation keeps TeamTaler's existing page shell, typography, spacing, search, filter trigger, data-table surface, member avatars, and navigation. It adopts mixed activity rows, signed color-coded amounts, transaction-type chips, receipt and reversal actions, and status badges.

The following differences are intentional user overrides: `Vorgang` is the first column; the existing logical column sequence remains after it; the existing category and action columns remain available; and the implementation contains seven realistic mixed records instead of the five-row concept sample.

## Focused Region Comparison Evidence

The activity surfaces were reviewed together in `/tmp/teamtaler-activities-table-comparison.png`. Booking rows use the warm orange transaction, amount, and status treatment. Payment rows use the teal transaction, amount, and received-status treatment. Corrections use a neutral scale symbol and preserve their signed account effect. Existing product thumbnails and member avatars remain crisp, and payment details use payment method plus optional reason without a fabricated product asset.

At the 1440 px desktop viewport, all nine columns and complete reversal actions fit inside the activity region. At the 1024 px tablet viewport, transaction chips retain icon and text, long product names wrap at word boundaries, and the table preserves its supported horizontal-scroll behavior. At the 393 px mobile viewport, only the transaction icon remains visible while the accessible transaction label stays in the DOM.

## Required Fidelity Surfaces

- Fonts and typography: passed. Existing application typography and data-table hierarchy are unchanged.
- Spacing and layout rhythm: passed. Search, filter, table header, row rhythm, badges, and result count align with the current design system.
- Colors and visual tokens: passed. Booking amounts and badges use the warm app palette; payments use the teal/green app palette; reversed records retain muted styling.
- Image quality and assets: passed. Existing avatars, product thumbnails, and Lucide icons are reused.
- Copy and content: passed. `Vorgang`, `Erfasst von`, `Buchung`, `Einzahlung`, `Gebucht`, and `Eingegangen` accurately describe the normalized activity data.

## Interaction And Responsive Evidence

- One server-normalized query returns globally ordered bookings, payments, and corrections without client-side truncation.
- Every member retains personal account movements; `VIEW_ALL_BOOKING_ACTIVITY` expands bookings and `FINANCE_MANAGEMENT` independently expands payments and corrections.
- The custom `Vorgang` multi-select exposes booking, payment, and correction choices with matching icons.
- Member filtering applies to every activity source; category and product filters intentionally remain booking-specific.
- Tablet transaction labels are visible at 1024 × 768; mobile transaction labels are visually hidden at 393 × 852 while icons and accessible labels remain.
- Desktop status badges and reversal actions are fully visible within the activity region.
- Browser console warnings and errors remained empty through desktop, tablet, mobile, filter-open, and filter-applied states.

## Findings

No actionable P0, P1, or P2 visual differences remain.

## Comparison History

- Initial implementation: the 1240 px table minimum width hid status and action content at a 1440 px viewport.
- Fix: rebalanced column widths, reduced the desktop minimum width, and tightened the action-cell inset so every column and full reversal action remains visible.
- Tablet mismatch: the transaction text and a long product name crossed their available cells.
- Fix: introduced a tablet-specific table width and column allocation, then tightened the thumbnail-to-copy gap so labels and words remain intact.
- Responsive evidence: transaction copy remains visible on tablet and is icon-only on mobile as requested.

## Final Result

The final unified-feed build was rechecked on 2026-08-24 against the real local API at 1440 × 1024, 1024 × 768, and 393 × 852. The desktop table showed globally interleaved signed booking and payment rows, the type menu exposed `Buchung`, `Einzahlung`, and `Korrektur`, and applying the payment type produced exactly the server-filtered payment row with no console warnings or errors. The 1024 px sidebar breakpoint retained a centered dialog, while 393 px used the compact sheet and horizontally scrollable semantic table. The account route contained no duplicate movement table.

final result: passed

# Semantic Planning Response Choices Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-interactive-response-counts-desktop.png` and `/tmp/teamtaler-interactive-response-counts-mobile.png`, showing the earlier button-based aggregate choices.
- Implementation screenshots: `/tmp/teamtaler-radio-response-counts-desktop.png`, `/tmp/teamtaler-radio-response-counts-mobile.png`, and `/tmp/teamtaler-checkbox-registration-selected-desktop.png`.
- Poll route: `/planning/events/pev_3d4b83c01dbc9b6b116d067284bf5fc5?date=2026-09-16&view=week`.
- Registration route: `/planning/events/pev_802957a129f227863ec131de1cdd571f?date=2026-09-16&view=week`.
- State: authenticated, published poll with no current response and published registration tested in both unselected and selected states.

## Capture Normalization

| Capture | CSS viewport | Pixel dimensions | Density |
| --- | ---: | ---: | ---: |
| Desktop source | 1117 × 617 | 1117 × 617 | 1 screenshot pixel per CSS pixel |
| Desktop poll implementation | 1117 × 617 | 1117 × 617 | 1 screenshot pixel per CSS pixel |
| Desktop registration selected | 1117 × 617 | 1117 × 617 | 1 screenshot pixel per CSS pixel |
| Mobile source | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |
| Mobile poll implementation | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

The poll pairs use the same route, event data, response state, viewport, theme, density, and scroll region. The registration capture is a focused state check at the same desktop viewport.

## Full-View Comparison Evidence

The response-card composition, two-column metric grid, administrative close action, event details, sidebar, and mobile bottom navigation remain aligned with the source. The intentional change replaces repeated `Auswählen` labels with compact native choice indicators while retaining the full tile as the hit target.

## Focused Region Comparison Evidence

- Poll choices now show native radio controls in a single named group, making their mutual exclusivity visible and available to assistive technology.
- The read-only `Offen` tile remains visually neutral and contains no control.
- Registration uses a native checkbox because the member can independently join or withdraw; the server-assigned waitlist remains informational until it is the current state.
- The selected registration tile shows both the checked native control and the existing brand border and surface treatment.
- The entire bordered tile is a label-backed hit target; browser and component tests exercised clicks outside the small input itself.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. Count values remain primary, labels remain secondary, and removing duplicate action copy reduces noise without changing the established type scale.
- Spacing and layout rhythm: passed. Tile height, grid gap, card padding, divider placement, radii, and desktop/mobile composition match the source captures.
- Colors and visual tokens: passed. Native controls use the brand accent color, selected tiles reuse the established selected-surface and border tokens, and read-only tiles remain muted.
- Image quality and asset fidelity: passed. Existing product icons and branding are unchanged; native form controls replace text affordances without adding approximate assets.
- Copy and content: passed. The concise interaction hints remain, while redundant per-tile `Auswählen` and `Ausgewählt` labels are removed.

## Interaction And Responsive Evidence

- The browser accessibility tree exposes three poll radios under the `Deine Teilnahme` group, all sharing the same event-scoped name; the fourth `Offen` total is read-only.
- Clicking the registration tile label changed `Dabei` from 0 to 1, checked the control, and synchronized the current participant from `Abgemeldet` to `Dabei`; clicking it again restored the count to 0.
- Component tests confirm label-wide activation, radio grouping, authoritative poll count updates, checkbox withdrawal, and omission of controls for non-answerable events.
- Browser console checks reported no warnings or errors.
- No clipping, overlap, horizontal overflow, or unintended wrapping was visible at 1117 × 617 or 393 × 852.

## Comparison History

1. Initial finding — P2: button tiles communicated clickability, but repeated action text added visual noise and did not expose the poll's mutually exclusive selection model.
2. Fix: replaced poll button semantics with a native event-scoped radio group, used a native checkbox for reversible registration, retained label-wide card targets, and preserved read-only aggregate tiles.
3. Post-fix evidence: equal-density desktop and mobile comparisons plus the selected registration capture show no remaining P0, P1, or P2 issue.

## Final Result

Poll choices now use clear radio semantics, registration uses reversible checkbox semantics, and both retain the aggregate tiles as large responsive interaction surfaces.

final result: passed

## Dashboard Ordering Iteration — 2026-09-01

- Source visual truth: `/tmp/teamtaler-dashboard-order-before.jpg`
- Rendered implementation: `/tmp/teamtaler-dashboard-order-after.jpg`
- Mobile implementation: `/tmp/teamtaler-dashboard-order-after-mobile.jpg`
- Combined comparison: `/tmp/teamtaler-dashboard-order-comparison.png`
- CSS viewport: 831 × 837 for the annotated layout and 393 × 852 for the mobile check
- Source pixels: 831 × 851; implementation pixels: 831 × 859; mobile implementation pixels: 393 × 1198
- Browser density: device pixel ratio 2; the Browser capture output was normalized to one output pixel per CSS pixel, so no additional density conversion was applied
- State: authenticated overview with an open balance, recent activities, a permission-gated group balance, and one visible planning event

### Full-View Comparison Evidence

The before and after captures were placed together in `/tmp/teamtaler-dashboard-order-comparison.png`. The source showed the planning event directly below the greeting, ahead of the open balance. The implementation keeps the open balance immediately below the greeting, retains activities and the group balance next, and places the planning card at the end of the overview content.

### Focused Region Comparison Evidence

A separate focused crop was unnecessary because the changed information hierarchy is fully legible in the combined full-view comparison. The planning card itself is unchanged and had already passed the focused Agenda-card comparison documented in the following Dashboard Agenda Card Design QA section.

### Required Fidelity Surfaces

- Fonts and typography: passed; no component typography changed.
- Spacing and layout rhythm: passed; the planning card now uses the established large section gap above it and no obsolete bottom margin.
- Colors and visual tokens: passed; no token or state color changed.
- Image quality and assets: passed; all existing logos, avatars, and Lucide icons remain unchanged.
- Copy and content: passed; no user-facing text or event content changed.

### Interaction And Responsive Evidence

- DOM order at both checked viewports is greeting, open balance, activity/group information, then planning event.
- The complete planning card still opens the expected event detail route and returns to the overview without errors.
- The 393 × 852 layout keeps the same content order in its single-column flow.
- Browser console warning and error checks were empty after reload, navigation, and responsive capture.

### Findings And Comparison History

- P1 source finding: the planning card displaced the always-primary open balance from the first content position.
- Fix: moved the unchanged `PlanningEventCard` after the dashboard's activity and group-balance region and changed its contextual margin from bottom to top.
- Post-fix evidence: `/tmp/teamtaler-dashboard-order-comparison.png` shows the requested hierarchy at the annotated viewport, and `/tmp/teamtaler-dashboard-order-after-mobile.jpg` confirms the same order on mobile.
- No actionable P0, P1, or P2 differences remain.

final result: passed

---

# Dashboard Agenda Card Design QA

## Comparison Target

- Source reference: `/tmp/teamtaler-agenda-card-reference.png`
- Mobile implementation: `/tmp/teamtaler-dashboard-agenda-card-mobile-final.png`
- Desktop implementation: `/tmp/teamtaler-dashboard-agenda-card-desktop-final.png`
- Focused comparison: `/tmp/teamtaler-dashboard-agenda-comparison-final.png`
- Reference route: `http://127.0.0.1:5173/planning?date=2026-09-01&view=agenda`
- Implementation route: `http://127.0.0.1:5173/overview`
- Mobile viewport: 393 × 852 CSS pixels
- Desktop viewport: 1440 × 900 CSS pixels
- State: the same multi-day all-day planning event rendered with live test-server data

## Full-View Comparison Evidence

The Agenda reference and Dashboard implementation were captured with the same light theme and mobile viewport. The Dashboard now renders the shared `PlanningEventCard` instead of its former dedicated preview layout. This preserves the Agenda card's border, radius, padding, type icon, time treatment, heading hierarchy, description clamp, location row, and complete-card navigation target.

The Dashboard intentionally supplies the full event schedule instead of the Agenda's selected-day label. This is a content-context difference rather than a visual divergence: Dashboard users need the event's complete date range, while the Agenda already provides the selected date in its surrounding day heading.

## Focused Region Comparison Evidence

The first Agenda card and the Dashboard card were cropped into `/tmp/teamtaler-dashboard-agenda-comparison-final.png` and reviewed together. Both surfaces use the same visual component and realistic API data. The focused comparison confirms matching typography, content order, icon size, chevron placement, description truncation, location treatment, border, and corner radius.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. The title, compact schedule, description, and metadata follow the Agenda hierarchy.
- Spacing and layout rhythm: passed. The shared component provides identical internal spacing; only the Dashboard's external section margin is contextual.
- Colors and visual tokens: passed. Existing TeamTaler surface, border, text, and planning-accent tokens are reused.
- Icons and assets: passed. The established planning-type, recurrence, location, and navigation icons are reused without substitutes.
- Content projection: passed. Description, location, series identity, and aggregate participation counts are now supplied by the privacy-safe Dashboard projection.

## Interaction And Responsive Evidence

- The complete Dashboard card navigates to the planning-event detail route and retains the current calendar-view search parameter.
- The card was verified at 393 × 852 and 1440 × 900 CSS pixels.
- The mobile accessibility snapshot contains the event type, complete schedule, title, description, and location in the link's accessible name.
- The browser console contained no warning or error entries after loading and opening the card; only development-server connection and React DevTools messages were present.
- Aggregate participation data exposes totals only and does not disclose participant identities.

## Findings

No actionable P0, P1, or P2 visual differences remain.

## Comparison History

- Initial shared-component integration: the Dashboard card matched the Agenda frame but lacked description, location, recurrence, and aggregate participation metadata because the Dashboard API summary omitted those fields.
- Fix: expanded the privacy-safe Dashboard projection and its OpenAPI contract, then reused the existing adapter and shared card without duplicating presentation logic.
- Final review: the focused comparison confirmed matching Agenda presentation with the intentionally fuller Dashboard schedule label.

## Final Result

The Dashboard planning preview now uses the Agenda card component and receives the complete privacy-safe presentation data required by it. Mobile and desktop layouts, accessibility content, navigation, API tests, component tests, lint, and type checking were verified.

final result: passed

---

# Planning Event Detail Design QA

## Comparison Target

- Source visual truth: the annotated desktop event-detail state supplied in the task, reproduced at `/tmp/teamtaler-event-detail-desktop-before-centering.png`, plus the existing compact composition at `/tmp/teamtaler-event-detail-mobile.png`.
- Implementation screenshots: `/tmp/teamtaler-event-detail-desktop-centered.png` and `/tmp/teamtaler-event-detail-mobile-centered.png`.
- Route: `/planning/events/pev_e13e49dea3a515cd7fd5b801bf598f2d?date=2026-09-09&view=week`.
- State: authenticated, published recurring calendar-only appointment, desktop sidebar expanded, no close action.

## Capture Normalization

| Capture | Screenshot pixels | CSS viewport | Output density |
| --- | ---: | ---: | ---: |
| Desktop source | 1024 × 768 | 1024 × 768 | 1 screenshot pixel per CSS pixel |
| Desktop implementation | 1024 × 768 | 1024 × 768 | 1 screenshot pixel per CSS pixel |
| Mobile source | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |
| Mobile implementation | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

The desktop captures use the same route, data, theme, viewport, and sidebar state. The mobile source predates the separately approved removal of the close action; that content difference is intentional and not a layout regression.

## Full-View Comparison

- The desktop navigation, event card, and lifecycle action now share one 400 px column centered within the available main content.
- The 400 px desktop column preserves the mobile information hierarchy: one metadata column, the same text wrapping behavior, and vertically stacked sections.
- The mobile implementation remains edge-aligned to the existing 20 px content gutters, has no horizontal overflow, and keeps its full-width destructive action.
- The calendar-only constraint is scoped to this event type; response-based event detail layouts retain their two-column desktop composition.

## Focused Region Comparison

A focused comparison was required for the navigation row, card, and lifecycle action because these were the annotated elements.

- Desktop main-content center: `637 px`.
- Desktop wrapper, card, and cancel-action center: `637 px`.
- Desktop wrapper and card width: `400 px`.
- Desktop metadata columns: `1`.
- Mobile card and cancel-action center: `196.5 px`, matching the 393 px viewport center.
- Mobile card and action width: `353 px`; edit control remains a 44 px icon-only target.

## Fidelity Surfaces

- Fonts and typography: existing product typography, weights, line heights, and wrapping are unchanged; the narrower desktop column intentionally preserves the mobile hierarchy.
- Spacing and layout rhythm: the previously unused right grid track is removed for calendar-only appointments; navigation, card, and action now form one centered rhythm.
- Colors and visual tokens: all existing semantic surface, brand, border, and danger tokens are unchanged.
- Image quality and asset fidelity: the existing logo and Lucide interface icons are unchanged; no raster asset or replacement artwork was introduced.
- Copy and content: all event copy is unchanged. The missing close action is the separately approved calendar-only behavior.

## Comparison History

1. Initial finding — P2: the compact card occupied the left track of a two-column grid while the second track was empty, leaving the desktop screen visibly unbalanced.
2. First fix — P2 remained: a centered 560 px column balanced the screen but changed metadata to two columns and no longer matched the mobile information hierarchy.
3. Final fix: the centered column was reduced to 400 px. The card returned to a single metadata column while retaining desktop spacing and a centered action. Desktop and mobile post-fix captures show no remaining P0, P1, or P2 mismatch.

## Browser Verification

- Page identity and meaningful content passed.
- No framework error overlay was present.
- Browser console contained no warnings or errors.
- Edit interaction passed: selecting `Bearbeiten` opened the populated event-edit route; browser Back restored the centered detail view.
- Mobile responsive check passed with no clipping or horizontal overflow.

## Findings

No actionable P0, P1, or P2 findings remain.

## Follow-up Polish

No P3 follow-up is required for the annotated region.

final result: passed

---

# Planning Event Detail Information Order Design QA

## Comparison Target

- Source visual truth: the annotated mobile event-detail state supplied in the task, reproduced before the change at `/tmp/teamtaler-event-detail-order-before-full.png`.
- Implementation screenshots: `/tmp/teamtaler-event-detail-order-after-mobile.png` and `/tmp/teamtaler-event-detail-order-after-desktop.png`.
- Route: `/planning/events/pev_14a4c09aef365c82918808e6887eee64?date=2026-09-09&view=week`.
- State: authenticated, ended recurring appointment with registration, capacity, waitlist, response deadline, and one cancelled occurrence.

## Capture Normalization

| Capture | CSS viewport | State |
| --- | ---: | --- |
| Mobile source | 393 × 852 | Original detail order |
| Mobile implementation | 393 × 852 | Updated detail order, card-focused scroll position |
| Desktop implementation | 1024 × 768 | Updated detail order, sidebar expanded |

## Full-View Comparison

The event card now follows the same reading sequence as the event form: location, description, schedule, and recurrence. The type and lifecycle status remain the card header because they provide context for all following content. The response deadline remains part of the schedule block because it is a time constraint rather than descriptive content.

The change preserves the existing card width, border, radius, typography, semantic colors, and responsive page composition. Only the internal information order and consistent section spacing changed.

## Focused Region Comparison

- Before: recurrence, schedule, location, response deadline, description.
- After: location, description, schedule with response deadline, recurrence.
- The mobile accessibility tree exposes the same updated sequence as the visible card.
- The desktop accessibility tree exposes the same updated sequence without horizontal overflow or reflow regressions.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. Existing labels, values, weights, and line heights are retained.
- Spacing and layout rhythm: passed. A shared detail-section grid applies the existing spacing token consistently between the reordered blocks.
- Colors and visual tokens: passed. Existing TeamTaler surface, border, text, and planning-accent tokens are unchanged.
- Icons and assets: passed. The existing event-type and recurrence icons are reused without substitutes.
- Copy and content: passed. No event copy or localized label changed.

## Interaction And Responsive Evidence

- Selecting `Bearbeiten` opened the populated edit route successfully.
- The edit form exposes `Ort`, `Beschreibung`, `Zeitplan`, and `Wiederholung` in the reference order used by the detail card.
- Returning to the detail route preserved the reordered card state.
- Mobile verification passed at 393 × 852 CSS pixels.
- Desktop verification passed at 1024 × 768 CSS pixels.

## Comparison History

1. Initial finding — P2: the detail card surfaced recurrence first and description last, conflicting with the creation/edit form's information sequence.
2. Fix: grouped location, description, schedule, and recurrence into a single ordered detail-section layout while keeping the response deadline inside the schedule block.
3. Final review: mobile and desktop captures, accessibility trees, and the edit interaction confirm the new order with no remaining P0, P1, or P2 mismatch.

## Final Result

The planning event detail card now matches the event form's information hierarchy across recurring and non-recurring event types.

final result: passed

---

# Planning Series Range Line Break Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-event-detail-order-after-mobile.png`, matching the annotated one-line planning-series summary.
- Implementation screenshots: `/tmp/teamtaler-series-summary-line-break-after-mobile.png` and `/tmp/teamtaler-series-summary-line-break-after-desktop.png`.
- Route: `/planning/events/pev_14a4c09aef365c82918808e6887eee64?date=2026-09-09&view=week`.
- State: authenticated, ended weekly appointment with registration and a five-occurrence series range.

## Capture Normalization

| Capture | CSS viewport | Output density |
| --- | ---: | ---: |
| Mobile source | 393 × 852 | 1 screenshot pixel per CSS pixel |
| Mobile implementation | 393 × 852 | 1 screenshot pixel per CSS pixel |
| Desktop implementation | 1024 × 768 | 1 screenshot pixel per CSS pixel |

## Full-View Comparison Evidence

The planning-series panel remains in the same card position and keeps its existing width, padding, icon, colors, type hierarchy, and surface treatment. Only the recurrence range moved from the pattern line to its own line.

## Focused Region Comparison Evidence

The source shows `Wöchentlich am Mi · endet nach 5 Terminen` as one flowing text value. The revised panel shows `Wöchentlich am Mi` on the first summary line and `endet nach 5 Terminen` directly below it. Both lines share the existing muted text style and align to the same content column.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. Font family, size, weight, line height, and label hierarchy are unchanged.
- Spacing and layout rhythm: passed. The new range line uses the existing two-pixel summary grid gap without changing card padding.
- Colors and visual tokens: passed. Existing semantic planning tokens are unchanged.
- Image quality and asset fidelity: passed. The existing recurrence icon remains unchanged; no new assets were introduced.
- Copy and content: passed. The recurrence pattern and range copy are unchanged; the visual separator is replaced by the requested line boundary.

## Interaction And Responsive Evidence

- The event-detail route loaded successfully at mobile and desktop viewports.
- Selecting `Bearbeiten` opened the populated edit route; returning restored the detail page with the two-line series summary.
- Browser console checks reported no warnings or errors.
- No clipping, overlap, horizontal overflow, or unintended wrapping was visible at either checked viewport.

## Comparison History

1. Initial finding — P2: the recurrence range continued on the same line as the recurrence pattern and wrapped based on available width.
2. Fix: exposed pattern and range as structured recurrence-summary parts, then rendered each as an independent line in the event-detail card.
3. Final review: the mobile and desktop captures show a stable explicit line boundary with no remaining P0, P1, or P2 mismatch.

## Final Result

The recurrence range now starts on its own line across responsive layouts while compact form summaries retain their existing single-line format.

final result: passed

---

# Planning Event Header Cancellation Action Design QA

## Comparison Target

- Source visual truth: the annotated event-detail screenshot supplied in the task, with the previous below-card action placement reproduced at `/tmp/teamtaler-event-detail-desktop.png` and `/tmp/teamtaler-event-detail-mobile-actions.png`.
- Implementation screenshots: `/tmp/teamtaler-cancel-header-after-desktop.png` and `/tmp/teamtaler-cancel-header-after-mobile.png`.
- Primary route: `/planning/events/pev_3d4b83c01dbc9b6b116d067284bf5fc5?date=2026-09-16&view=week`.
- Additional state: published calendar-only appointment at `/planning/events/pev_ade8033e15cdf22584ed11700427eb53?date=2026-09-11&view=week`.

## Capture Normalization

| Capture | CSS viewport | Output density |
| --- | ---: | ---: |
| Desktop implementation | 1117 × 617 | 1 screenshot pixel per CSS pixel |
| Mobile implementation | 393 × 852 | 1 screenshot pixel per CSS pixel |

The supplied annotated desktop reference and the implementation use the same event type, state, theme, sidebar state, and target route. The older local source reproductions document the previous below-card lifecycle action placement across desktop and mobile.

## Full-View Comparison Evidence

The cancellation action now appears in the navigation row immediately before the edit action. On desktop both actions retain their established labels and semantic danger/brand treatments. On mobile both actions collapse to aligned 44 px icon buttons while preserving accessible names and titles.

For poll and registration events, the close action remains below the event card as the only management action in that location. Published calendar-only appointments no longer render any lifecycle action below the card.

## Focused Region Comparison Evidence

- Desktop: `Absagen` and `Bearbeiten` form one right-aligned action group opposite `Zurück zum Kalender`, in the requested order.
- Mobile: the danger cancel icon is immediately left of the brand edit icon; both controls retain 44 × 44 px touch targets.
- The previous duplicate visual grouping below the card is removed; `Schließen` remains independently discoverable for response-based event types.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. Existing button typography and navigation hierarchy are unchanged.
- Spacing and layout rhythm: passed. The header actions reuse the established spacing token and align to the back link.
- Colors and visual tokens: passed. Existing brand, danger, border, and surface tokens are unchanged.
- Image quality and asset fidelity: passed. Existing Lucide cancel and edit icons are reused; no new assets were introduced.
- Copy and content: passed. The labels `Absagen`, `Bearbeiten`, and `Schließen` are unchanged.

## Interaction And Responsive Evidence

- Selecting the mobile cancel icon for a recurring poll opened `Welche Termine absagen?` with all three series scopes.
- Closing the dialog restored the unchanged event-detail route.
- A published calendar-only appointment, poll, and registration event were checked; cancellation precedes editing in each applicable header.
- Browser console checks reported no warnings or errors.
- No clipping, overlap, horizontal overflow, or unintended wrapping was visible at either checked viewport.

## Comparison History

1. Initial finding — P2: cancellation was grouped below the event card, separating two event-level editing actions and consuming additional vertical space.
2. Fix: moved cancellation into a shared navigation action group before editing, left closing in the below-card management area, and enabled accessible icon-only collapse on narrow viewports.
3. Final review: desktop and mobile captures plus the cancellation-dialog interaction show no remaining P0, P1, or P2 mismatch.

## Final Result

Cancellation is consistently placed before editing for every cancellable event type and collapses to an accessible icon-only control when space is limited.

final result: passed

---

# Planning Response Closing Action Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-cancel-header-after-desktop.png`, matching the annotated state where `Schließen` appeared below the event card.
- Implementation screenshots: `/tmp/teamtaler-close-in-responses-after-desktop.png` and `/tmp/teamtaler-close-in-responses-after-mobile.png`.
- Route: `/planning/events/pev_3d4b83c01dbc9b6b116d067284bf5fc5?date=2026-09-16&view=week`.
- State: authenticated, published recurring poll with three unanswered participants.

## Capture Normalization

| Capture | CSS viewport | Output density |
| --- | ---: | ---: |
| Desktop source | 1117 × 617 | 1 screenshot pixel per CSS pixel |
| Desktop implementation | 1117 × 617 | 1 screenshot pixel per CSS pixel |
| Mobile implementation | 393 × 852 | 1 screenshot pixel per CSS pixel |

The desktop captures use the same route, data, theme, viewport, and expanded-sidebar state. The mobile capture uses the same event and interaction state at the established narrow viewport.

## Full-View Comparison Evidence

The closing action moved from the event-content column into the response-summary card. This removes the detached action row below the event and places the command next to the data it controls. The card grid, event content, participation controls, and participant list retain their existing responsive composition.

## Focused Region Comparison Evidence

- The response metrics remain unchanged in a two-by-two grid.
- A subtle card-footer divider separates the management command from the metrics.
- `Schließen` uses the existing small ghost-button treatment, matching low-emphasis state-changing actions elsewhere in TeamTaler.
- The action remains right-aligned on desktop and mobile without consuming a separate content row.

## Interaction And Semantic Decision

`Schließen` remains a native button rather than a link because it changes server state and opens a confirmation dialog instead of navigating. The lower visual emphasis comes from the ghost treatment, not from incorrect link semantics.

Selecting the action opened `Terminstatus ändern?` with the existing explanation and cancel/confirm controls. Closing the dialog restored the unchanged event-detail route. Browser console checks reported no warnings or errors.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. Existing response metrics and action typography remain unchanged.
- Spacing and layout rhythm: passed. The action uses the established small card-footer spacing and border tokens.
- Colors and visual tokens: passed. Existing brand, surface, border, and muted-action tokens are reused.
- Image quality and asset fidelity: passed. The existing close/check icon remains unchanged; no new assets were introduced.
- Copy and content: passed. Response metrics and the `Schließen` label are unchanged.

## Comparison History

1. Initial finding — P2: the close command was visually detached from the response data it controls and competed with event-level cancellation.
2. Fix: moved the close command into the response-summary card, retained button semantics, and reduced its emphasis with the shared small ghost treatment.
3. Final review: desktop and mobile captures plus the confirmation interaction show no remaining P0, P1, or P2 mismatch.

## Final Result

The close command is now semantically and visually grouped with response management for poll and registration events.

final result: passed

---

# Unified Planning Responses Card Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-close-in-responses-after-desktop.png` and `/tmp/teamtaler-close-in-responses-after-mobile.png`, showing the separate personal-participation card before consolidation.
- Implementation screenshots: `/tmp/teamtaler-participation-in-responses-after-desktop.png` and `/tmp/teamtaler-participation-in-responses-after-mobile.png`.
- Route: `/planning/events/pev_3d4b83c01dbc9b6b116d067284bf5fc5?date=2026-09-16&view=week`.
- State: authenticated, published recurring poll with three unanswered participants.

## Capture Normalization

| Capture | CSS viewport | Pixel dimensions | Density |
| --- | ---: | ---: | ---: |
| Desktop source | 1117 × 617 | 1117 × 617 | 1 screenshot pixel per CSS pixel |
| Desktop implementation | 1117 × 617 | 1117 × 617 | 1 screenshot pixel per CSS pixel |
| Mobile source | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |
| Mobile implementation | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

The paired captures use the same event data, theme, viewport, and response state. The mobile pair is scrolled to the event-card and response-card boundary so the responsive consolidation is directly comparable.

## Full-View Comparison Evidence

The separate `Deine Teilnahme` card is removed. Response totals, the current member's response controls, and the administrative close action now form one ordered response-management card. The event information remains in the primary column, while the participant directory remains a separate card because it is a different browsing task.

## Focused Region Comparison Evidence

- Group totals remain the first and most prominent content in the `Rückmeldungen` card.
- `Deine Teilnahme` is now a level-three subsection immediately below the totals, separated with the existing border and spacing tokens.
- The three poll choices retain their existing labels, icons, selected-state semantics, and touch-target sizes; wrapping remains stable at desktop and mobile widths.
- `Schließen` remains the final, lower-emphasis administrative action with a separate divider and native button semantics.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. The response card uses an `h2` for the card title and an `h3` for the personal-response subsection without changing the established font family or weights.
- Spacing and layout rhythm: passed. Existing card padding, grid gaps, dividers, radii, and shadows are reused, and the removed duplicate card reduces redundant vertical spacing.
- Colors and visual tokens: passed. Existing surface, border, muted, and brand tokens are unchanged.
- Image quality and asset fidelity: passed. Existing Lucide participation and closing icons are reused; no image assets were added or approximated.
- Copy and content: passed. Totals, choice labels, participant labels, and the administrative action copy remain unchanged.

## Interaction And Responsive Evidence

- The desktop and mobile DOM expose `Rückmeldungen` as the outer region and `Deine Teilnahme` as its nested subsection.
- Opening `Schließen` displayed the existing confirmation dialog; pressing Escape closed it without changing the event.
- Poll and registration component tests confirm that personal response controls and closing remain inside the same response-summary card.
- Non-answerable response events no longer render an empty personal-participation heading.
- Browser console checks reported no warnings or errors.
- No clipping, overlap, horizontal overflow, or unintended wrapping was visible at either checked viewport.

## Comparison History

1. Initial finding — P2: the member's response controls were isolated in a separate card even though they operate on the totals shown directly beside or below them.
2. Fix: moved personal participation into a semantic subsection of the response-summary card, retained the participant directory as a separate task area, and suppressed the subsection when no response is possible.
3. Final review: equal-density desktop and mobile comparisons, semantic DOM inspection, and confirmation-dialog interaction show no remaining P0, P1, or P2 mismatch.

## Final Result

Response totals, personal participation, and response closing now form one coherent, responsive management card without changing the underlying actions.

final result: passed

---

# Interactive Planning Response Totals Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-participation-in-responses-after-desktop.png` and `/tmp/teamtaler-participation-in-responses-after-mobile.png`, showing the earlier response card with a separate participation-control row.
- Implementation screenshots: `/tmp/teamtaler-interactive-response-counts-desktop.png`, `/tmp/teamtaler-interactive-response-counts-mobile.png`, and `/tmp/teamtaler-interactive-registration-selected-desktop.png`.
- Poll route: `/planning/events/pev_3d4b83c01dbc9b6b116d067284bf5fc5?date=2026-09-16&view=week`.
- Registration route: `/planning/events/pev_802957a129f227863ec131de1cdd571f?date=2026-09-16&view=week`.
- State: authenticated, published poll and published capacity-aware registration.

## Capture Normalization

| Capture | CSS viewport | Pixel dimensions | Density |
| --- | ---: | ---: | ---: |
| Desktop source | 1117 × 617 | 1117 × 617 | 1 screenshot pixel per CSS pixel |
| Desktop poll implementation | 1117 × 617 | 1117 × 617 | 1 screenshot pixel per CSS pixel |
| Desktop registration selected | 1117 × 617 | 1117 × 617 | 1 screenshot pixel per CSS pixel |
| Mobile source | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |
| Mobile poll implementation | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

The poll pairs use the same route, event data, response state, viewport, theme, and density. The registration capture provides focused evidence for the selected and synchronized count state.

## Full-View Comparison Evidence

The separate participation buttons are removed. Each selectable aggregate is now a native button that combines total, response label, and action affordance in one consistent tile. The read-only `Offen` and unavailable waitlist totals remain visually related but omit the border and action label, making their non-interactive role clear.

## Focused Region Comparison Evidence

- Poll: `Dabei`, `Vielleicht`, and `Nicht dabei` use bordered tiles with visible `Auswählen` copy; `Offen` remains a neutral metric.
- Registration: `Dabei` is the registration control, while `Warteliste` is initially informational because capacity assignment is server-controlled.
- Selected registration: the chosen tile receives brand border and surface treatment, `aria-pressed="true"`, and visible `Ausgewählt` copy.
- Re-selecting the active registration or waitlist tile withdraws the current member without introducing a detached button.
- The response-closing action remains visually and semantically separate from personal participation.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. Totals remain the strongest tile content, response labels remain secondary, and action text uses the established small brand weight.
- Spacing and layout rhythm: passed. Equal-height tiles preserve the two-column rhythm at desktop and mobile widths without adding a second control section.
- Colors and visual tokens: passed. Neutral metrics, actionable borders, hover surfaces, focus rings, and selected surfaces use existing semantic tokens.
- Image quality and asset fidelity: passed. No image assets or substitute drawings were introduced.
- Copy and content: passed. The short poll and registration instructions explain the direct interaction and the selected registration state explains repeat-click withdrawal.

## Interaction And Responsive Evidence

- A real registration click changed the `Dabei` total from 0 to 1, set the tile to `Ausgewählt`, and changed the current member in the participant list from `Offen` to `Dabei`.
- Clicking the selected registration tile again returned the total to 0, cleared `aria-pressed`, and updated the participant list to `Abgemeldet`.
- The participant query is invalidated together with event totals and dashboard data, preventing mixed stale states.
- Poll interaction tests confirm that choosing `Dabei` changes its count from 0 to 1 and `Offen` from 3 to 2 using the authoritative server response.
- Registration tests confirm repeat-click withdrawal and count reset.
- Browser console checks reported no warnings or errors.
- No clipping, overlap, horizontal overflow, or unintended wrapping was visible at 1117 × 617 or 393 × 852.

## Comparison History

1. Initial finding — P1: aggregate tiles looked informational while personal choices remained detached, so the intended direct interaction was impossible.
2. First fix: converted eligible totals into native buttons with explicit instruction, action copy, selected styling, keyboard focus treatment, and server-backed count updates.
3. Browser finding — P2: the selected tile and total updated, but the participant list retained the previous response until another reload.
4. Second fix: invalidated the event participant query after every successful response mutation and repeated registration plus withdrawal in the live browser.
5. Final review: desktop, mobile, selected-state, DOM, interaction, and console evidence show no remaining P0, P1, or P2 issue.

## Final Result

Poll responses and event registrations now happen directly through their aggregate tiles, with authoritative counts, clear selected states, withdrawal behavior, and synchronized participant data.

final result: passed

---

# Responsive Planning Series Summary Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-series-layout-before-837.png` and `/tmp/teamtaler-radio-response-counts-mobile.png`.
- Implementation screenshots: `/tmp/teamtaler-series-layout-wide-after-837.png` and `/tmp/teamtaler-series-layout-mobile-after-393.png`.
- Route: `/planning/events/pev_3d4b83c01dbc9b6b116d067284bf5fc5?date=2026-09-16&view=week`.
- State: authenticated, published recurring poll with the series summary visible.

## Capture Normalization

| Capture | CSS viewport | Pixel dimensions | Density |
| --- | ---: | ---: | ---: |
| Wide source | 837 × 563 | 837 × 563 | 1 screenshot pixel per CSS pixel |
| Wide implementation | 837 × 563 | 837 × 563 | 1 screenshot pixel per CSS pixel |
| Mobile source | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |
| Mobile implementation | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

The paired captures use the same event, theme, route, responsive mode, and one-to-one screenshot density. The mobile response count differs because the member response changed between captures; the compared series-summary state is otherwise equivalent.

## Full-View Comparison Evidence

The redundant `Terminserie` heading is removed without changing the surrounding event card, response card, or navigation. The shorter summary reduces vertical height at both viewports and preserves the existing icon, background, padding, and hierarchy.

## Focused Region Comparison Evidence

- At a 837 px viewport, the series container is wide enough to render `Wöchentlich am Mi · endet nach 5 Terminen` on one line.
- At a 393 px viewport, the series container remains below the 360 px component threshold, hides the separator, and renders the two phrases on separate lines.
- The breakpoint is based on the summary component's own inline size rather than the global viewport, so the behavior also remains correct inside narrower desktop columns.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. The existing muted summary typography is retained and the unnecessary bold heading is removed.
- Spacing and layout rhythm: passed. Wide content becomes one compact line; mobile retains a balanced two-line stack without overflow.
- Colors and visual tokens: passed. The existing brand-subtle surface and text tokens are unchanged.
- Image quality and asset fidelity: passed. The existing Lucide recurrence icon is retained; no new assets are introduced.
- Copy and content: passed. Only the requested `Terminserie` label is removed, and the two recurrence phrases remain unchanged.

## Interaction And Responsive Evidence

- Browser DOM inspection confirms that `Terminserie` is absent from the detail summary.
- Wide DOM and screenshot evidence show the centered dot; mobile DOM and screenshot evidence show no visible separator.
- Browser console checks reported no warnings or errors.
- No clipping, overlap, horizontal overflow, or unintended wrapping was visible at either viewport.

## Comparison History

1. Initial finding — P2: the summary repeated a heading already implied by the recurrence icon and stacked short phrases even when ample horizontal space was available.
2. Fix: removed the heading and added a component-size container query that switches between an inline dotted summary and a separator-free two-line mobile summary.
3. Post-fix evidence: normalized wide and mobile comparisons show no remaining P0, P1, or P2 issue.

## Final Result

The planning series summary is now concise and responds to its actual available width.

final result: passed

---

# Planning Response Deadline Placement Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-response-deadline-before-877.png`.
- Implementation screenshots: `/tmp/teamtaler-response-deadline-after-877.png` and `/tmp/teamtaler-response-deadline-after-mobile-393.png`.
- Route: `/planning/events/pev_3d4b83c01dbc9b6b116d067284bf5fc5?date=2026-09-16&view=week`.
- State: authenticated, published recurring poll with a response deadline and administrative close action.

## Capture Normalization

| Capture | CSS viewport | Pixel dimensions | Density |
| --- | ---: | ---: | ---: |
| Wide source | 877 × 617 | 877 × 617 | 1 screenshot pixel per CSS pixel |
| Wide implementation | 877 × 617 | 877 × 617 | 1 screenshot pixel per CSS pixel |
| Mobile implementation | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

The wide source and implementation use the same event, state, theme, viewport, scroll region, and one-to-one density. The mobile capture verifies the responsive footer independently.

## Full-View Comparison Evidence

The response deadline is removed from the event timing grid and added to the response-card footer. The footer now expresses one coherent response-management row: deadline information is left-aligned and the close action remains right-aligned.

## Focused Region Comparison Evidence

- The event card now contains only the appointment start and end timing.
- The response footer retains its divider and places the deadline label and value on the left.
- `Schließen` remains a lower-emphasis action on the right of the same row.
- At 393 px, both items remain on one readable line without clipping or reducing the existing touch target.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. The deadline uses established metadata sizes and weights, while the close action keeps its existing emphasis.
- Spacing and layout rhythm: passed. Footer alignment, divider, gaps, padding, and card height remain balanced on wide and mobile views.
- Colors and visual tokens: passed. Existing muted, strong-text, border, and brand tokens are reused.
- Image quality and asset fidelity: passed. Existing product and Lucide assets are unchanged.
- Copy and content: passed. The complete `Rückmeldeschluss` label and localized date-time value are preserved.

## Interaction And Responsive Evidence

- DOM inspection exposes the deadline as a semantic definition list inside the `Rückmeldungen` region and before the close button.
- The response-card close action remains interactive and its existing confirmation flow is unchanged.
- Browser console checks reported no warnings or errors.
- No clipping, overlap, horizontal overflow, or unintended wrapping was visible at 877 × 617 or 393 × 852.

## Comparison History

1. Initial finding — P2: the response deadline appeared as general appointment timing even though it governs the response controls in a separate card.
2. Fix: moved the semantic deadline metadata into the response footer and changed the footer layout to left/right alignment.
3. Post-fix evidence: normalized wide comparison and mobile responsive evidence show no remaining P0, P1, or P2 issue.

## Final Result

The deadline and close action now form one coherent response-management footer across desktop and mobile.

final result: passed

---

# Completed Response Deadline Alignment Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-response-deadline-completed-before-1094.png`.
- Implementation screenshots: `/tmp/teamtaler-response-deadline-completed-after-1094.png`, `/tmp/teamtaler-response-deadline-published-after-1094.png`, and `/tmp/teamtaler-response-deadline-completed-after-mobile-393.png`.
- Routes: completed registration `/planning/events/pev_14a4c09aef365c82918808e6887eee64?date=2026-09-09&view=week`; published poll `/planning/events/pev_3d4b83c01dbc9b6b116d067284bf5fc5?date=2026-09-16&view=week`.
- State: authenticated; completed registration without a close action, plus a published poll with a close action as the control case.

## Capture Normalization

| Capture | CSS viewport | Pixel dimensions | Density |
| --- | ---: | ---: | ---: |
| Wide source | 1094 × 617 | 1094 × 617 | 1 screenshot pixel per CSS pixel |
| Wide implementation | 1094 × 617 | 1094 × 617 | 1 screenshot pixel per CSS pixel |
| Mobile implementation | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

The wide source and implementation use the same completed event, theme, viewport, scroll region, and one-to-one density. The published and mobile captures verify the conditional footer states.

## Full-View Comparison Evidence

The completed-event response deadline now remains at the left edge of the response footer instead of inheriting the absent close action's right alignment. The surrounding event, response totals, participant list, and navigation are unchanged.

## Focused Region Comparison Evidence

- In the completed registration, the deadline is the footer's only child and aligns with the response-card content inset.
- In the published poll, the deadline stays left while `Schließen` stays right in the same footer row.
- At 393 px, the completed-event deadline remains left-aligned with no clipping or unintended wrapping.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. Existing deadline label and value styles are unchanged.
- Spacing and layout rhythm: passed. Only the conditional horizontal alignment changes; card padding, divider, and gaps remain consistent.
- Colors and visual tokens: passed. No token or color changes were introduced.
- Image quality and asset fidelity: passed. Existing brand and icon assets are unchanged.
- Copy and content: passed. The localized deadline label and value remain intact.

## Interaction And Responsive Evidence

- DOM inspection confirms the completed footer has one deadline child and no close action.
- The published control state contains two footer children, with the deadline left and the close action right.
- Browser page identity, meaningful DOM content, framework-overlay absence, and console health passed.
- No clipping, overlap, horizontal overflow, or unintended wrapping was visible at 1094 × 617 or 393 × 852.

## Comparison History

1. Initial finding — P2: a generic last-child auto margin pushed the deadline to the right whenever the optional close action was absent.
2. Fix: scoped the auto margin to footer buttons only and added a completed-event regression test.
3. Post-fix evidence: normalized wide comparison, published-state control, and mobile capture show no remaining P0, P1, or P2 issue.

## Final Result

The response deadline now stays left-aligned in every event status while optional management actions retain their intended right alignment.

final result: passed

---

# Registration Capacity And Waitlist Design QA

Superseded by the compact waitlist-tile iteration documented below.

## Comparison Target

- Source visual truth: `/tmp/teamtaler-registration-capacity-before-1094.png`.
- Implementation screenshots: `/tmp/teamtaler-registration-capacity-after-1094.png`, `/tmp/teamtaler-registration-capacity-joined-1094.png`, and `/tmp/teamtaler-registration-capacity-after-mobile-393.png`.
- Source route: `/planning/events/pev_44ecdd17e84c556a2374c656feea1ffa?date=2026-09-16&view=week`.
- Capacity-state route: `/planning/events/pev_802957a129f227863ec131de1cdd571f?date=2026-09-16&view=week`.
- State: authenticated, published registration events; one unlimited without a waitlist and one limited to three places with an active waitlist.

## Capture Normalization

| Capture | CSS viewport | Pixel dimensions | Density |
| --- | ---: | ---: | ---: |
| Wide source | 1094 × 617 | 1094 × 617 | 1 screenshot pixel per CSS pixel |
| Wide implementation | 1094 × 617 | 1094 × 617 | 1 screenshot pixel per CSS pixel |
| Wide selected state | 1094 × 617 | 1094 × 617 | 1 screenshot pixel per CSS pixel |
| Mobile implementation | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

The source and first implementation capture use the same route, state, theme, viewport, scroll region, and one-to-one density. The limited-capacity route supplies the additional occupancy, waitlist, and interaction evidence.

## Full-View Comparison Evidence

The response card now exposes registration availability before the response choices. Unlimited registrations state `Unbegrenzte Plätze` and `Keine Warteliste`; limited registrations state free places, occupied places, and whether the waitlist is active without disturbing the event-detail layout.

## Focused Region Comparison Evidence

- The availability panel is visually grouped within `Rückmeldungen` and remains subordinate to the section heading.
- A limited event shows `3 Plätze frei`, `0 von 3 Plätzen belegt`, `Warteliste aktiv`, and the number waiting.
- After selecting `Dabei`, the same panel updates to `2 Plätze frei` and `1 von 3 Plätzen belegt`; the selected aggregate tile is visibly marked.
- At 393 px, the availability headline, waitlist badge, occupancy, response choices, and bottom navigation remain readable without horizontal overflow.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. Availability uses the existing metadata and heading scale, while current free capacity receives the strongest weight.
- Spacing and layout rhythm: passed. The panel follows the response-card inset, radius, and spacing system; desktop and mobile content remain balanced.
- Colors and visual tokens: passed. Existing brand-subtle, surface, border, muted-text, and selected-state tokens communicate the new status.
- Image quality and asset fidelity: passed. No new imagery or substitute assets were introduced.
- Copy and content: passed. Capacity, occupancy, and waitlist availability are explicit for limited and unlimited registrations.

## Interaction And Responsive Evidence

- Selecting `Dabei` changed the rendered totals from 0/3 occupied and 3 free to 1/3 occupied and 2 free; selecting it again restored the original test data.
- Full-capacity logic is covered for an active waitlist and for registrations without a waitlist: the waitlist tile becomes the action only when entry is possible.
- Browser page identity, meaningful DOM content, framework-overlay absence, console health, and responsive overflow checks passed.
- No clipping, overlap, or unintended horizontal scrolling was visible at 1094 × 617 or 393 × 852.

## Comparison History

1. Initial finding — P2: aggregate totals did not reveal the registration capacity, remaining availability, or whether a waitlist existed.
2. Fix: added a semantic availability panel, native occupancy progress, explicit waitlist status, and capacity-aware response actions and hints.
3. Post-fix evidence: normalized source comparison, a real limited-capacity interaction, and the mobile capture show no remaining P0, P1, or P2 issue.

## Final Result

Registration events now communicate capacity and waitlist behavior before members commit to a response, including full and unlimited states.

final result: passed

---

# Compact Registration Capacity Tile Design QA

Superseded by the unlimited-capacity refinement documented below.

## Comparison Target

- Source visual truth: `/tmp/teamtaler-capacity-tile-before-1024.png`.
- Implementation screenshots: `/tmp/teamtaler-capacity-tile-after-1024.png`, `/tmp/teamtaler-capacity-tile-limited-after-1024.png`, `/tmp/teamtaler-capacity-tile-joined-1024.png`, and `/tmp/teamtaler-capacity-tile-after-mobile-393.png`.
- Unlimited route: `/planning/events/pev_44ecdd17e84c556a2374c656feea1ffa?date=2026-09-16&view=week`.
- Limited route: `/planning/events/pev_802957a129f227863ec131de1cdd571f?date=2026-09-16&view=week`.
- State: authenticated, published registration events with unlimited and limited capacity, including an active selected response.

## Capture Normalization

| Capture | CSS viewport | Pixel dimensions | Density |
| --- | ---: | ---: | ---: |
| Wide source | 1024 × 768 | 1024 × 768 | 1 screenshot pixel per CSS pixel |
| Wide implementation | 1024 × 768 | 1024 × 768 | 1 screenshot pixel per CSS pixel |
| Wide limited and selected states | 1024 × 768 | 1024 × 768 | 1 screenshot pixel per CSS pixel |
| Mobile implementation | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

The source and primary implementation capture use the same route, state, dark theme, viewport, scroll region, and one-to-one density. The limited-capacity captures verify the alternate data and selected states.

## Full-View Comparison Evidence

The standalone availability panel is removed. Capacity and waitlist status now live inside the existing `Warteliste` aggregate tile, restoring the compact two-tile composition and reducing response-card height.

## Focused Region Comparison Evidence

- An unlimited event shows `0 Warteliste` with `Nicht aktiv · Unbegrenzt` inside the same tile.
- A limited event shows `Aktiv · 3 von 3 frei` without adding another visual container.
- After selecting `Dabei`, the waitlist tile updates to `Aktiv · 2 von 3 frei` while the selected registration tile remains visually explicit.
- At 393 px, both tiles retain equal height, readable metadata, and the existing touch targets without horizontal overflow.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. Count and label retain their hierarchy; status and capacity use the existing small metadata scale.
- Spacing and layout rhythm: passed. The original two-column response grid is restored and the card is materially shorter.
- Colors and visual tokens: passed. Existing passive and selected count-tile tokens are retained without introducing another surface.
- Image quality and asset fidelity: passed. No image or icon changes were introduced.
- Copy and content: passed. `Aktiv` or `Nicht aktiv` states whether the waitlist exists, while remaining or unlimited capacity is explicit in the same tile.

## Interaction And Responsive Evidence

- Selecting `Dabei` updated the compact capacity text from `3 von 3 frei` to `2 von 3 frei`; selecting it again restored the original test data.
- Full-capacity behavior with and without a waitlist remains covered by component tests.
- Browser page identity, meaningful DOM content, framework-overlay absence, console health, and horizontal-overflow checks passed.
- No clipping, overlap, or unintended horizontal scrolling was visible at 1024 × 768 or 393 × 852. The annotation marker visible in the mobile evidence belongs to the browser review layer, not the app UI.

## Comparison History

1. Initial finding — P2: the standalone availability surface duplicated information and made the response card visually heavier than its two aggregate controls.
2. Fix: removed the separate surface and placed waitlist status plus compact capacity text directly in the waitlist tile.
3. Post-fix evidence: normalized source comparison, limited and selected states, and mobile evidence show no remaining P0, P1, or P2 issue.

## Final Result

Capacity and waitlist information are now compact, contextual, and available within the existing aggregate tile.

final result: passed

---

# Unlimited Registration Tile Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-unlimited-tile-before-1024.png`.
- Implementation screenshots: `/tmp/teamtaler-unlimited-tile-after-1024.png`, `/tmp/teamtaler-limited-waitlist-tile-after-1024.png`, and `/tmp/teamtaler-unlimited-tile-after-mobile-393.png`.
- Unlimited route: `/planning/events/pev_44ecdd17e84c556a2374c656feea1ffa?date=2026-09-16&view=week`.
- Limited control route: `/planning/events/pev_802957a129f227863ec131de1cdd571f?date=2026-09-16&view=week`.
- State: authenticated, published registration events with unlimited capacity and with three configured places plus an active waitlist.

## Capture Normalization

| Capture | CSS viewport | Pixel dimensions | Density |
| --- | ---: | ---: | ---: |
| Desktop source | 1024 × 768 | 1024 × 768 | 1 screenshot pixel per CSS pixel |
| Desktop implementation | 1024 × 768 | 1024 × 768 | 1 screenshot pixel per CSS pixel |
| Desktop limited-capacity control | 1024 × 768 | 1024 × 768 | 1 screenshot pixel per CSS pixel |
| Mobile implementation | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

The source and primary implementation use the same route, authenticated state, dark theme, viewport, scroll region, and one-to-one density. The limited route is a control state for preserving capacity-aware waitlist behavior.

## Full-View Comparison Evidence

The unlimited registration no longer presents a zero-value waitlist or an inactive waitlist status. Its second aggregate tile is now a passive `Unbegrenzt` / `Plätze` information tile, while the limited registration retains the existing `Warteliste` count, active status, and remaining-capacity copy.

## Focused Region Comparison Evidence

The aggregate tiles are fully readable in the full-view captures, so an additional crop was not needed. At both 1024 × 768 and 393 × 852, the neutral unlimited tile matches the height, radius, spacing, and alignment of the adjacent interactive `Dabei` tile without displaying a checkbox or suggesting a waitlist action.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. `Unbegrenzt` is the primary value and `Plätze` is the muted category label, mirroring the neighboring aggregate hierarchy without forcing a numeric count.
- Spacing and layout rhythm: passed. The two-column response grid, tile height, inset, and responsive card rhythm are unchanged.
- Colors and visual tokens: passed. The passive tile keeps the existing muted-surface and text tokens; the actionable attendance tile retains its border and native checkbox affordance.
- Image quality and asset fidelity: passed. No imagery, logos, icons, or substitute assets were changed.
- Copy and content: passed. The irrelevant `0 Warteliste` and `Nicht aktiv` strings are absent only when no capacity limit exists; limited registrations keep explicit waitlist and availability details.

## Interaction And Responsive Evidence

- The unlimited tile is intentionally informational and exposes no focusable selection control; the adjacent `Dabei` tile remains the only registration action.
- The limited-capacity control route still renders `Warteliste`, `Aktiv`, and `3 von 3 frei`, and component tests cover the selected, full-with-waitlist, and full-without-waitlist interaction branches.
- Browser page identity, meaningful DOM content, framework-overlay absence, and console health passed. Direct pointer actions were intercepted by the active browser annotation layer, so interaction mutation evidence comes from the focused component tests rather than the annotated browser surface.
- No clipping, overlap, or unintended wrapping is visible at 1024 × 768 or 393 × 852. The blue numbered marker belongs to the browser review layer, not the application UI.

## Comparison History

1. Initial finding — P2: an unlimited registration displayed `0 Warteliste` and `Nicht aktiv`, implying a capacity constraint and waitlist feature that do not exist.
2. Fix: replaced that entire aggregate state with a passive `Unbegrenzt` / `Plätze` tile and removed the unavailable waitlist count and status from the rendered accessibility tree.
3. Post-fix evidence: normalized desktop comparison, the limited-capacity control, the mobile capture, and the regression test show no remaining P0, P1, or P2 issue.

## Final Result

Unlimited registrations now communicate their actual availability without exposing a meaningless waitlist total or suggesting an unavailable interaction.

final result: passed

---

# Response Capacity Hierarchy And Participant Sorting Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-response-hierarchy-before-1094.png` and `/tmp/teamtaler-response-hint-before-1024.png`.
- Implementation screenshots: `/tmp/teamtaler-response-hierarchy-after-1094.png`, `/tmp/teamtaler-response-hint-after-1024.png`, and `/tmp/teamtaler-response-hierarchy-after-mobile-393.png`.
- Limited-capacity route: `/planning/events/pev_6e2749598b3e358346446b617bedcb57?date=2026-09-16&view=week`.
- Unlimited-capacity route: `/planning/events/pev_44ecdd17e84c556a2374c656feea1ffa?date=2026-09-16&view=week`.
- State: authenticated, published registration events; the limited event has one of three places occupied and no member waiting.

## Capture Normalization

| Capture | CSS viewport | Pixel dimensions | Density |
| --- | ---: | ---: | ---: |
| Limited source and implementation | 1094 × 617 | 1094 × 617 | 1 screenshot pixel per CSS pixel |
| Unlimited source and implementation | 1024 × 768 | 1024 × 768 | 1 screenshot pixel per CSS pixel |
| Limited mobile implementation | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

Each before-and-after pair uses the same route, group, authenticated state, theme, viewport, scroll region, and one-to-one density.

## Full-View Comparison Evidence

The redundant response instruction is removed. In the limited state, `2 frei` and `1 von 3 belegt` now form the primary capacity hierarchy, followed by a low-utilization green progress indicator. `Warteliste · 0` is visually reduced to secondary metadata. The unlimited state remains a compact `Unbegrenzt` / `Plätze` information tile without introducing a progress control.

## Focused Region Comparison Evidence

- The limited response card is shorter despite carrying more useful capacity information because the instructional paragraph is gone.
- The native progress element is labelled `1 von 3 Plätzen belegt`, exposes `value=1` and `max=3`, and uses a green low-utilization tone. Medium and high utilization tones are covered by focused component tests and use the existing warning and danger tokens.
- The attendance checkbox remains the dominant interactive choice. A full event with an enabled waitlist uses an explicit `Auf Warteliste eintragen` accessible label.
- At 393 px, both tiles remain on one row, their values stay readable, and the progress track does not overflow the response card.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. Available places receive the strongest weight, occupancy is supporting copy, and waitlist count is the smallest text.
- Spacing and layout rhythm: passed. Removing the hint tightens the response card while the two-tile grid, footer, and responsive rhythm remain aligned.
- Colors and visual tokens: passed. Utilization uses existing success, warning, and danger tokens as a supplemental signal; absolute numbers remain the primary information.
- Image quality and asset fidelity: passed. No imagery, logos, icons, or substitute assets were introduced or changed.
- Copy and content: passed. The card now communicates absolute available and occupied counts directly, with the waitlist clearly demoted to secondary context.

## Interaction, Sorting, And Responsive Evidence

- Selecting the `Dabei` checkbox changed the browser-rendered count from zero to one; selecting it again restored zero without console warnings or errors.
- Participant ordering is covered with mixed response fixtures: `Dabei`, `Vielleicht`, `Warteliste`, `Nicht dabei`, `Offen`, and `Abgemeldet`, with German alphabetical ordering inside each response group.
- Browser page identity, meaningful DOM content, framework-overlay absence, console health, progress semantics, and responsive rendering passed.
- No clipping, overlap, or horizontal overflow is visible at 1094 × 617, 1024 × 768, or 393 × 852.

## Comparison History

1. Initial findings — P2: redundant instructional copy consumed space; waitlist count visually competed with more important capacity data; participant ordering depended on API order.
2. Fixes: removed routine response hints, replaced the waitlist-led tile with absolute availability and occupancy plus a semantic utilization bar, demoted the waitlist to small metadata, and added deterministic status/name sorting.
3. Post-fix evidence: normalized desktop and mobile comparisons, browser interaction evidence, semantic progress inspection, and mixed-status regression tests show no remaining P0, P1, or P2 issue.

## Final Result

The response card now prioritizes the decision-relevant capacity state, keeps waitlist information appropriately secondary, and presents participants in a predictable response-first order.

final result: passed

---

# Participant Response Dividers Design QA

## Comparison Target

- Source visual truth: `/tmp/teamtaler-account-reference.jpg`, specifically the divider-led account settings rows requested as the established TeamTaler pattern.
- Implementation screenshots: `/tmp/teamtaler-participant-groups-after-desktop-focused.jpg` and `/tmp/teamtaler-participant-groups-after-mobile-rows.jpg`.
- Route: `/planning/events/pev_6e2749598b3e358346446b617bedcb57?date=2026-09-16&view=week`.
- State: authenticated, dark theme, published registration event with one attending and two unanswered participants.

## Capture Normalization

| Capture | CSS viewport | Pixel dimensions | Density |
| --- | ---: | ---: | ---: |
| Account divider reference | 1094 × 617 | 1094 × 617 | 1 screenshot pixel per CSS pixel |
| Participant groups, desktop | 1094 × 617 | 1094 × 617 | 1 screenshot pixel per CSS pixel |
| Participant groups, mobile | 393 × 852 | 393 × 852 | 1 screenshot pixel per CSS pixel |

The desktop comparison uses the same application theme, viewport, browser density, and authenticated group. The mobile capture keeps the same event and data state while exercising the responsive shell.

## Full-View Comparison Evidence

The participant card now uses the same quiet hierarchy as TeamTaler account settings: the card heading is followed by a hairline, subsequent response sections are separated by another hairline, and no nested cards or colored status badges compete with the member names. `Dabei` and `Offen` act as compact section labels with their totals aligned to the opposite edge.

## Focused Region Comparison Evidence

- Desktop: the response sections align to the participant card's content column, the first divider starts directly below the card heading, and the second divider separates `Offen` from `Dabei` without adding excess vertical space.
- Mobile: the 393 px capture shows the complete card without horizontal overflow. Long-name capacity is preserved by the flexible text column, while avatars, group counts, and section dividers retain their alignment.
- Accessibility: each response section has a labelled level-three heading and its own semantic list. The status is stated once by the group heading instead of being redundantly repeated on every participant row.

## Required Fidelity Surfaces

- Typography and hierarchy: passed. Group labels reuse the existing compact uppercase brand treatment; member names retain normal reading weight and the counts are visually secondary.
- Spacing and layout rhythm: passed. Divider spacing follows the account reference, removes redundant row-by-row status copy, and remains compact on desktop and mobile.
- Colors and visual tokens: passed. Borders, muted counts, branded labels, surfaces, and text use existing TeamTaler tokens in both themes.
- Image quality and asset fidelity: passed. Existing avatar and brand assets remain unchanged; no generated, placeholder, or substitute imagery was introduced.
- Copy and content: passed. Visible groups are named from the existing participation translations, empty groups are omitted, and participant names remain alphabetically sorted inside their response state.

## Interaction And Browser Evidence

- Page identity matched the requested event URL and the document title remained `TeamTaler`.
- The browser DOM contained meaningful event, response, and participant content with labelled `DABEI 1` and `OFFEN 2` sections; no framework overlay was present.
- Keyboard interaction changed the selected `Dabei` response from one to zero and then restored it to one, updating the grouped participant state accordingly.
- Browser warnings and errors: none.
- Focused component tests cover all six possible response groups and German alphabetical ordering within a group.

## Comparison History

1. Initial finding — P2: sorting by response was behaviorally correct, but the flat list only repeated a status on each row and did not expose the group structure the user requested.
2. Fix: introduced semantic response sections, subtle divider lines, compact section labels and counts, and removed duplicated per-row status text.
3. Post-fix evidence: the desktop/account comparison, complete 393 px mobile capture, accessibility tree, restored keyboard interaction, and mixed-status regression test show no remaining P0, P1, or P2 issue.

## Final Result

The participant list now communicates response grouping through the same divider-led visual language used elsewhere in TeamTaler, with less repetition and clearer scan order.

final result: passed
