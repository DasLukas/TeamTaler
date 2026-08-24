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
