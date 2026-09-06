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
