# Changelog

All notable TeamTaler changes are documented in this file. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Account-synchronized light, dark, and system color modes plus four accessible color themes: TeamTaler, NRW, Tief im Westen, and Fire.
- Group-managed default themes with inheritable per-membership overrides that remain stable across sessions and group switches.
- Password-confirmed asynchronous personal and group structured-data exports with actor-owned job history, in-app completion notices, integrity metadata, and automatic 24-hour expiry.
- Authorization-preserving CSV and A4-landscape PDF downloads for activities, payments, account balances, group and personal settlements, active and archived members, and group and system audit tables. Downloads include every filtered and sorted matching row without interactive action columns.
- A card-first mobile activity feed with a persistent table toggle and dedicated compact sorting sheet, while preserving the same search, filters, exports, cursor loading, and row actions in both views.

### Changed

- The compact activity toolbar now keeps filter, sort, view, and export actions in fixed positions across card and table views.
- Cursor-backed data tables and card collections now load the next page automatically shortly before the user reaches the end, while retaining the manual action only for browsers without Intersection Observer support.
- Shared frontend colors now use semantic appearance tokens with complete light and dark variants instead of component-level brand literals.
- Dark themes now use theme-specific tonal surface, border, text, overlay, and shadow scales rather than sharing the TeamTaler navy foundation.
- The personal theme picker presents the current group default once with a dedicated inheritance badge instead of duplicating the same palette as an override.

### Fixed

- Shared table zebra and hover rows now retain dark semantic surfaces and readable text in dark mode.

### Security

- Group raw-data archives require `GROUP_ADMINISTRATION` and current-password reauthentication, are deliberately structured-only with no media or receipt bytes, and remain visible and downloadable only to their requesting actor. Personal archives are limited to the actor's profile and current-group data; no system-wide raw export exists.
- Table export requests accept only registered table identifiers and validated query state, reuse the table's existing live authorization, neutralize spreadsheet formulas, render logos from local validated bytes, and fail without truncation at bounded row, byte, and time limits.

## [1.0.1] - 2026-08-24

### Added

- Activity and audit tables now support transaction-type filters, grouped avatar-backed member filters, and chronological sorting backed by optimized query plans.

### Changed

- Authentication, finance, settlement, account-balance, form, modal, navigation, and safe-area layouts now adapt more reliably across narrow phones, tablets, and short viewports.
- User-facing email, notification, activity, and audit timestamps now use consistent German date and time formatting.
- Member selection menus now group matching people consistently and retain current profile images across booking and administration workflows.
- Document scanning now warms OpenCV before publishing contours, normalizes difficult lighting, scores document-like quadrilaterals instead of selecting the largest outline, smooths accepted corners over time, and aligns the overlay with the contained camera frame.
- Scanner color and grayscale modes now use deterministic pixel processing shared by the live editor preview and PDF renderer, while Original remains an unmodified tonal path.
- User-defined booking products now use clearer price-selection copy and more compact price labels in responsive product lists.

### Fixed

- Legacy payment-method labels remain visible in activity feeds after payment-method configuration changes.
- Decimal inputs, empty balance states, settlement filters, Web Push tests, and constrained form controls now preserve valid values and avoid misleading or overflowing states.
- Low-confidence or frame-sized document detections are no longer displayed or reused for manual capture, preventing unstable table and camera-edge crops.
- Color, grayscale, and original document selections now produce visibly distinct editor previews and persist into final PDF generation.

## [1.0.0] - 2026-08-21

### Added

- Standards-based Web Push with VAPID, encrypted per-device subscriptions, privacy-minimized payloads, and a push-only service worker.
- Versioned system, group, and per-membership notification controls for independent email and push delivery across booking, payment, settlement, due-soon, and overdue events.
- Time-zone-aware settlement reminder scheduling and a channel-neutral leased notification delivery outbox.
- Configurable payment-receipt policies with immutable image or PDF attachments for member and finance-managed payments.
- A camera-based multi-page document scanner with automatic edge detection, manual corner correction, local image processing, and bounded PDF generation.

### Changed

- Operational data tables now provide server-backed search, column filters, deterministic sorting, cursor pagination, URL-persisted state, and responsive mobile layouts.
- Administration and finance workflows use shared accessible menus, modals, confirmation controls, and table primitives for consistent desktop and mobile behavior.

### Security

- Web Push secrets and browser subscription material are encrypted with purpose-separated keys, never returned by administrative APIs, and protected by HTTPS-only endpoint validation plus private-network and DNS-rebinding defenses.
- Receipt uploads enforce independent size limits, content validation, normalized image storage, authorization-bound retrieval, and backup-integrity checks.

## [0.9.0] - 2026-08-17

### Added

- Multi-group accounts can select a fixed default group or the most recently used group in account settings; the server validates membership ownership and resolves that preference for subsequent sessions.
- Global system administration now provides versioned instance settings, encrypted SMTP overrides and delivery tests, system-administrator assignments, account lookup, group provisioning and lifecycle management, and a global audit trail through both the web interface and operator CLI.
- System administrators can archive, restore, inspect, and permanently purge groups with explicit impact previews, optimistic concurrency, exact-name confirmation, and retained purge audit receipts.
- Product image editing now supports live browser-camera capture with front/rear camera switching, bounded JPEG encoding, permission recovery, and a native device-camera fallback.

### Changed

- Frontend development and container builds now consistently use Node.js 24, matching CI and the documented development environment.
- Migration `0028` makes `GROUP_ADMINISTRATOR` the only preset-backed system role, clears only the historical non-administrator preset metadata in existing groups, and seeds `Mitglied`, `Finanzverwaltung`, `Katalogverwaltung`, and default `Gast` as ordinary editable roles in new groups.
- New reserved administrator roles now start with the three protected management grants and `VIEW_MEMBER_DIRECTORY`; finance, catalog, statistics, and booking capabilities require additional role assignments. Existing group roles, grants, assignments, and defaults remain unchanged during migration.
- Persisted role names now render verbatim in role editors, selectors, summaries, and assignment controls instead of being replaced by frontend translations.
- Group settings are exposed by capability: role managers control the default role, finance managers control settlement and transaction behavior, and group administrators retain identity, branding, notification, finance, and audit controls.
- SMTP tests now work for immutable environment configuration as well as database overrides; only database-backed connection revisions participate in persisted verification state.
- The administration shell, lifecycle dialogs, audit tables, action primitives, group selector, and narrow-viewport layouts use shared accessible components and consistent responsive behavior.

### Fixed

- SMTP test delivery can use an operator-configured recipient without changing the stable test-fixture administrator identity, and configured passwords remain visually masked without being copied into form state.
- Product-image controls no longer rely on a visible browser file input and retain the existing crop and recoverable upload workflow for both files and camera captures.

### Security

- Runtime SMTP passwords are encrypted at rest with purpose-derived keys, override hosts are subject to private-network restrictions by default, and sensitive values are never returned by settings APIs.
- System-role, settings, group-lifecycle, and purge mutations revalidate authority and current versions inside serialized transactions while preserving last-administrator and accounting invariants.
- Group deletion requires archival, current impact review, exact confirmation, and a verified backup workflow before permanently removing application data.

## [0.8.0] - 2026-08-14

### Added

- A recipient-first multi-product booking cart with persistent cart-level member and temporary-guest selection, a compact recipient icon and count badge beside the open balance, per-line quantities and user-defined prices, responsive desktop/mobile summaries, and one explicit product-target confirmation.
- `POST /api/v1/groups/{groupId}/bookings/bulk` for idempotent, item-major creation of up to 25 distinct products across up to 100 explicit targets and at most 500 expanded bookings.
- Migration `0027` and four independent `OFF`, `OPTIONAL`, or `REQUIRED` reason modes for own bookings, foreign bookings, own payments, and finance-managed payments.

### Changed

- Product selection now adds or increments cart lines while preserving the two-action fixed-price self-booking path. Successful carts clear their draft and restore the authenticated member as the safe target default.
- Cart line details now scroll independently so the result summary and primary booking action remain visible together at every supported viewport height.
- Mandatory shared booking reasons now stay in the persistent checkout directly above its primary action, eliminating a separate mobile reveal step.
- The compact booking cart now follows the production bottom-sheet geometry, handle, elevation, spacing, motion, and close affordance for a consistent mobile interaction language.
- Compact carts now open quick checkout for the first fixed-price product, collapse to a live cart peek after subsequent fixed-price selections or a downward handle swipe, and reopen details automatically for products requiring price input.
- Selecting a user-defined-price product in a populated cart now brings its exact line into view and focuses the required price input immediately on mobile, tablet, and desktop.
- Desktop cart lines now retain their intrinsic card height instead of stretching to fill the available inspector when only a few products are selected.
- Selected catalog cards now expose direct decrement controls and switch to an explicit remove action at quantity one.
- Open booking carts now omit recipient names, reduce single-target summaries to the booking result and total, use an accessible icon equation for multi-target results, and remain fully visible beside the persistent sidebar on landscape tablets.
- Minimized booking carts now omit recipient names from both visible and assistive text, leaving only the product count and total.
- All shared mobile bottom sheets now support handle-based downward dismissal with drag-following motion, velocity-aware thresholds, snap-back, and pointer-event fallbacks; the recipient picker remains an anchored dropdown on tablets and desktops.
- The temporary-guest creator now omits its redundant visible label and uses “Neuer Gast” as the concise name placeholder while retaining an accessible control name.
- Multi-recipient cart summaries now lead with the total and place the smaller product-person equation on its own line underneath.
- Administration now uses one accessible three-position segmented control per reason context. Transaction forms hide disabled reasons, keep optional reasons editable, and place mandatory reasons in the required checkout path.

### Security

- Bulk carts revalidate every target permission, product version, price, quantity, and open-period precondition before writing, then commit guest identities, immutable bookings, balanced ledger entries, allocations, notifications, audits, and one idempotency result in a single transaction.
- Booking and payment writes reload the active reason mode inside their transaction; `OFF` discards submitted reason text and `REQUIRED` rejects empty values before financial records are written.

## [0.7.0] - 2026-08-12

### Added

- Migration `0025` and a group-level `settlementsEnabled` setting in the dedicated administration Finance section, disabled by default for every new and upgraded group.
- Migration `0026` and the visible `MEMBER_MANAGEMENT` permission, implied hidden directory read, and one-time backfill for every existing role with direct group administration.
- A shared drag-and-wheel square crop editor for group logos, profile images, and product images during creation or editing.

### Changed

- Refocused the member overview on personal balance, recent activity, and one signed complete-ledger group balance. Category cards, booking counts, progress bars, and period-scoped group summaries moved out of the overview, while `VIEW_GROUP_STATISTICS` now protects the net group receivable returned by the dashboard.
- Groups can use a continuous balance without settlement-period UI. Disabling settlements preserves the technical open period, immutable history, and full-ledger balances; re-enabling resumes the same period with all activity recorded in the meantime.
- Group category statistics use the complete history while settlements are disabled and the current open period while they are enabled. Existing settlement history remains read-only and is shown only when present.
- Group-logo, profile-image, and product-image previews no longer render a synthetic background behind the image; saved crops preserve the chosen position and scale through the existing upload API.
- The role editor groups permission switches into labelled administration, booking, finance, and catalog sections for faster scanning on desktop and mobile.
- Separated membership, invitation, guest, public-join, default-role, and ordinary role-assignment operations from technical group configuration. Settings/Audit, Members, and Roles & Rights now mount independently for group, member, and role management.
- The reserved group-administrator role now retains direct `GROUP_ADMINISTRATION`, `MEMBER_MANAGEMENT`, and `ROLE_MANAGEMENT` grants; all three switches remain enabled and locked.

### Fixed

- Made the overview group-balance card rely solely on the server-filtered `groupOutstandingMinor` field, avoiding false hiding from stale client-side grants, and renamed the visible permission to “Group balance”.
- Local group-logo and profile-image previews remain visible during React development checks, and long selected filenames no longer widen the page beyond the viewport.
- Booking activity and dashboard rows now refresh current actor and target profile images after an avatar upload or replacement.

### Security

- Period close now rechecks `settlementsEnabled` inside the server-side write transaction and rejects close attempts while settlements are disabled; hidden client controls are presentation only.
- Local image previews now decode selected files into a canvas without creating a DOM resource-URL source sink.

## [0.6.0] - 2026-08-09

### Added

- Group-level booking and payment settings for conditional reasons, ordered editable payment methods, and separate freely editable booking and payment reason suggestions.
- Migration `0024` seeds the four existing payment methods for every group and preserves immutable payment-method label snapshots after later configuration changes.
- Self-service display-name, password, and verified email-address changes, plus enumeration-resistant password reset and public authentication capability discovery.
- One-hour, single-use account-security actions with hashed proofs and a leased encrypted email outbox for password-reset and email-change delivery.
- Group-owned, many-to-many roles with stable identifiers, cumulative permission grants, multiple roles per membership or pending invitation, four seeded starter roles, and a role-centered administration workflow.
- Fourteen stable group permission keys covering group administration, member management, role management, finance, catalog, complete booking activity, own-account payments, own booking creation, own or arbitrary booking reversal, booking for other members, booking for temporary guests, member-directory visibility, and anonymous group-statistic visibility.
- Additive v1 role, permission-definition, and role-assignment endpoints with optimistic ETag concurrency control and tenant-bound identifiers.
- A scope-aware permission-grant contract that stores `GROUP`, `CATEGORY`, and `PRODUCT` scope shapes while accepting only group-wide grants in v1.
- A group-owned default role that preselects manual invitations and safely supplies CSV rows without an explicit role value.
- Administrator-managed public join links with configurable finite or unlimited lifetime, local QR generation and download, copy support, immediate disable, and token rotation.
- Email-verified public registration for new accounts plus authenticated direct joining and archived-membership reactivation for existing accounts.
- An accessible multi-choice booking target dropdown plus an additive atomic batch-booking endpoint for applying one product, quantity, price, and reason to multiple members.
- Temporary guests for one-off bookings, with credentialless identities and stable memberships, inline atomic creation by display name, first-class accounting history, administrator rename/archive controls, and history-preserving login claim invitations.
- `BOOK_FOR_GUESTS` as an independent capability for selecting existing temporary guests and creating new ones inline without exposing the member directory.
- A privacy-minimized booking-context endpoint containing only the open period, own balance, current membership, booking-safe targets, and server-derived guest-creation capability.
- A unified two-stage membership lifecycle: reversible archival and reactivation for regular members and temporary guests, followed by zero-balance permanent removal through a history-preserving tombstone.
- Additive membership reactivation and permanent-removal endpoints plus migration `0023` lifecycle state, indexes, and database guards.

### Changed

- Consolidated group identity, branding, email notification, default-role, and transaction controls into one structured administration Settings tab.

- Booking and payment reason requirements are now enforced from current group settings inside their write transactions; payment forms use the first configured method as their default and retain at least one method.
- Revoke every session after a password replacement, password-reset confirmation, or email-change confirmation, while preserving the existing user, membership, balance, statement, and audit identities during an email change.
- Keep display-name and authenticated password changes available without SMTP, while password reset and verified email-change entry points report unavailable and fail closed until complete SMTP and token-encryption configuration is present.
- Moved role assignment from the role-definition workspace into responsive member and pending-invitation directories with compact multi-select triggers, explicit draft confirmation, optimistic-conflict refresh, and protected last-administrator controls. Unchanged preset descriptions are localized in the German interface without overwriting stored canonical values.
- Made `MEMBER`, `FINANCE_MANAGER`, and `CATALOG_MANAGER` ordinary editable and deletable starter roles, removed implicit member-role assignment, and require every login-enabled active membership and pending invitation to retain at least one explicit role. Credentialless temporary guests are the sole roleless exception.
- Added independent `CREATE_OWN_BOOKING`, `BOOK_FOR_OTHERS`, and `BOOK_FOR_GUESTS` target classes. Booking navigation and target choices reflect their union, while permission-less finance or catalog roles remain possible.
- Kept manual invitation roles explicit while preselecting the configured default. CSV imports now accept case-insensitive role names per row, use `|` for multiple roles, and fall back to the safe group default; the former shared `roleId` parameter remains compatible.
- Users with `BOOK_FOR_OTHERS` can select credentialed foreign members, while users with `BOOK_FOR_GUESTS` can select existing temporary guests or add new names. Their own membership remains the default only when `CREATE_OWN_BOOKING` is effective. Existing IDs and new names share one 1-to-100 target limit and one idempotent all-or-nothing transaction.
- Grouped finance payment targets into regular members, temporary guests, archived accounts, and deleted accounts with a non-zero balance without querying the protected member directory.
- Unified active-member actions under Archive, renamed former members to archived members, and added lifecycle-aware Reactivate and Delete actions with retained historical Deleted badges.
- Protected member email, role, and grant listings with `VIEW_MEMBER_DIRECTORY`, protected anonymous category totals with `VIEW_GROUP_STATISTICS`, made `BOOK_FOR_OTHERS` imply directory access, and preserved upgraded behavior by granting both reads to every existing role.
- Skip period statements and close notifications for idle credentialless guests while retaining nullable-email statements for guests with financial activity.
- Added server-resolved actor and target display names to booking responses so activity clients no longer require the protected member directory. `Membership.userId` remains required, while temporary-guest membership and statement emails can be null and `isTemporaryGuest` is derived only from missing credentials.
- Added deterministic permission-aware landing routes and documented that overview information and actions are filtered by effective permissions.
- Removed the deprecated booking-activity group-settings adapter and its base-role version field; activity visibility is managed only through role grants.
- Simplified role editing to one direct Save action and removed implementation-specific scope guidance from the user interface.
- Kept role-assignment actions visible while constraining overflow to the role list in desktop popovers and mobile sheets.
- Stacked the role selector above the permission editor on medium-width displays so editor controls remain readable and unclipped.
- Constrained long role titles to their own selector card with accessible hover text instead of allowing them to overlap adjacent roles.
- Replaced redundant preset and locked-name labels with a clearly disabled visual state for immutable role-name fields.
- Reduced the permission editor heading to its essential label by removing redundant scope and role-union helper text.
- Removed the redundant explanatory badge from the arbitrary-booking-reversal permission while retaining computed permission implications.
- Aligned the duplicate-role action with the role title across desktop, medium-width, and mobile editor layouts.
- Removed non-interactive information icons from permission rows and reclaimed their unused layout column.
- Replaced authorization decisions based on legacy role names, direct group permissions, and category grants with a centralized effective-permission policy. Effective permissions are the union of assigned role grants; `VOID_ANY_BOOKING` implies `VOID_OWN_BOOKING` and `VIEW_ALL_BOOKING_ACTIVITY`.
- Preserved legacy v1 role and self-payment fields as deprecated adapters. Legacy preset writes leave custom roles intact, while non-empty legacy category-grant writes now fail validation instead of silently widening access.
- Booking responses now expose whether the current member may reverse a booking, whether a reason is required, and the optional end of the actor-only 30-second reason-free window. `VOID_OWN_BOOKING` covers both actor- and target-related bookings, while an incoming third-party booking always requires a reversal reason.
- Migration `0017` maps existing administrator, finance, catalog, self-payment, activity-visibility, active-membership, and open-invitation state into roles. Legacy membership and invitation category grants are intentionally removed rather than converted to unsafe group-wide access.

### Security

- Keep password-reset requests account-enumeration resistant, require the current password for authenticated credential changes, carry account-action secrets only in URL fragments and JSON bodies, and remove encrypted outbox secrets after relay acceptance or cancellation.
- Protected the reserved group-administrator role, its fixed identity, and its non-removable core grants, and require every group to retain at least one active assignment of that exact role.
- Revalidate permissions and last-administrator invariants inside serialized SQLite write transactions so revocation is immediate and concurrent demotions or archival cannot lock a group out.
- Prevent default roles from being deleted or receiving `GROUP_ADMINISTRATION` or `MEMBER_MANAGEMENT`, avoiding accidental administrative access through invitation defaults or CSV imports.
- Store reusable public join tokens as hashes plus authenticated ciphertext, keep them in URL fragments, require mailbox verification for new accounts, return enumeration-resistant registration responses, and invalidate pending proofs atomically on rotation or disable.
- Validate every multi-booking target and permission before writing, and commit all booking, ledger, allocation, notification, audit, and idempotency rows atomically.
- Couple nullable guest email and password-hash state at the database boundary, exclude credentialless identities from authentication, forbid synthetic credentials, and suppress notification email jobs without a real address.
- Recheck claim, rename, archive, selected regular roles, and inline temporary-guest creation inside serialized transactions. Claim acceptance preserves the membership and ledger history while applying exactly the invitation's roles.
- Keep group statistics, member-directory fields, and other members' balances out of the booking context; frontend guest grouping and route guards remain presentation controls rather than authorization boundaries.
- Recheck tenant ownership, lifecycle state, roles, and the exact zero balance inside serialized archive, reactivation, and permanent-removal transactions. Permanent removal strips access and personal projections while retaining an immutable membership tombstone and last display name for finance, booking, statement, and audit history.

### Fixed

- Reworked booking activities into labelled responsive cards on narrow phone widths, preventing page-level horizontal overflow and keeping mobile navigation viewport-attached while scrolling.
- Expanded the desktop activity workspace to the available content width and retained the booking table on tablet, split-view, and desktop widths with horizontal overflow contained inside the table viewport.

## [0.5.1] - 2026-08-07

### Fixed

- Corrected the PayPal payment-method migration to suspend and restore ledger immutability triggers transactionally while rebuilding the constrained payment table, with regression coverage matching production schemas.

## [0.5.0] - 2026-08-06

### Added

- Context-rich notifications for external booking assignments and reversals, administrative payments and reversals, and generated period settlements.
- Exact unread-count badges on desktop notifications and the mobile overflow button, with notifications available first in the overflow menu and acknowledged after entering the viewport.
- Cursor-backed notification history, batch read acknowledgements, and an administrator-controlled optional SMTP notification outbox.
- History-preserving product tombstones that permanently remove booked products from the catalog without changing immutable booking, ledger, settlement, or audit data.

## [0.4.0] - 2026-08-06

### Added

- A dedicated role-protected catalog workspace with contextual round product and category creation actions.
- A dedicated role-protected finance workspace with consolidated active and former member balances, exact receivable/credit/net totals, responsive account presentation, payments, and settlements.
- A finance-manager account-summary endpoint that includes zero balances, preserves full signed 64-bit precision, and remains strictly group-scoped.
- Self-service profile-image upload and removal with protected delivery plus consistent avatars in member, permission, booking, dashboard, and account views.
- Administrator-only group-name editing with immediate navigation updates, server validation, and audit logging.
- Persisted, editable category symbols with an accessible administration picker and consistent booking, dashboard, and report rendering.

### Changed

- Limited mobile primary navigation to overview, booking, activities, and overflow for every role; authorized finance and catalog destinations now live exclusively under overflow.
- Reordered the mobile overflow menu by capability as finance, catalog, administration, account, and logout.
- Moved category and product management out of administration and added role-aware desktop and overflow catalog navigation while retaining the existing global create actions.
- Mobile booking confirmation now uses a viewport-attached modal sheet that covers the inactive bottom navigation, respects device safe areas, contains scrolling, and restores focus to the selected product when closed.
- Moved payment and settlement management out of administration and added role-aware desktop and overflow finance navigation.
- Dashboard greetings now follow local night, morning, daytime, and evening hours and refresh while the page stays open.
- Booking activity rows now show compact product thumbnails when a catalogue image is available.
- Product image selections can now be removed explicitly and are cleared reliably between product form sessions.

## [0.3.0] - 2026-08-04

### Added

- Per-product fixed or user-defined pricing with currency-aware browser validation, server-enforced booking prices, immutable price snapshots, and demo-mode coverage.
- Version-aware category and product editing in the administration UI, including archive controls and recoverable product-image replacement.
- TeamTaler favicon, Apple touch icon, and standard and maskable web-app icons for installed browser applications.

### Changed

- Manual invitations can now assign an optional display-name suggestion, group roles, and category grants; accepted invitations apply all defaults atomically.
- Member administration now separates open invitations, active members, and former members, with invitation editing, revocation, token-rotating resend, direct rights navigation, membership archival, and stable-ID reactivation.
- Invitation acceptance now uses a rate-limited, secret-minimal preview, pre-fills names for new accounts, and preserves the global display name of existing accounts.
- Individual invitations now use the configured transactional SMTP outbox automatically while retaining a visible fallback link and live delivery status in the administrator UI.
- Active invitation email addresses are deduplicated consistently across manual creation, repeated CSV imports, and mixed import paths, with a database trigger protecting concurrent requests.

### Security

- The last active administrator cannot be archived, self-removal requires explicit confirmation, and member removal preserves all financial and audit history while clearing effective access.
- Invitation resend is idempotent, rotates the token and expiry, invalidates older links, and blocks duplicate delivery while an outbox job is pending or sending.
- Fixed-price bookings now reject client-supplied price overrides, while user-defined prices are bounded and included in idempotency and audit metadata.

## [0.2.0] - 2026-08-04

### Added

- Administrator-managed group logos with immediate desktop/mobile branding updates, secure normalized storage, default-logo restoration, and backup coverage.
- Idempotent CSV invitation imports with per-row results, encrypted transactional email outbox delivery, mandatory SMTP TLS, bounded retries, and responsive administrator UI.

### Changed

- Removed the redundant standard/penalty category type so each user-defined category is the sole product classification.
- Generalized third-party booking reasons, quantities, and the 30-second self-undo rule across all categories.

### Security

- Prevented unvalidated local logo files from being rendered before server-side normalization and required an explicitly supported browser media type before upload.

## [0.1.0] - 2026-08-04

### Added

- Multi-group local accounts with administrator, finance manager, and catalog manager roles.
- Category-scoped rights for third-party assignment and audited booking reversal.
- Standard and penalty product categories with price snapshots and normalized local images.
- Self-service bookings, mandatory reasons for third-party penalties, notifications, and a 30-second self-undo window.
- Append-only account entries, incoming payments, FIFO allocations, overpayment credit, and linked payment reversals.
- Immutable accounting-period close snapshots, member settlement views, CSV export, and print-friendly output.
- German responsive React interface with desktop, tablet, and mobile navigation.
- Single-container Go, React, and SQLite deployment behind an existing TLS reverse proxy.
- Online backup and staged restore commands, health probes, hardened Compose defaults, and multi-architecture release automation.
- OpenAPI 3.1 contract, architecture documentation, contribution guidance, security policy, and AGPL-3.0-only licensing.
- Exact decimal-string encoding for response monetary fields, preserving the full signed 64-bit minor-unit range in browsers.
- Currency-aware browser parsing and formatting for zero-, two-, and three-decimal currencies without floating-point arithmetic.
- Reload-safe, actor- and payload-scoped idempotency reservations for high-risk browser mutations.
- Recoverable product image uploads that never duplicate an already-created product.
- Explicit acting and charged membership display for every booking, including searchable third-party-assignment cues.
- Canonical backup-entry allowlisting, target-width Argon2 parameter parsing, and directory-confined SPA asset serving with traversal regression coverage.

[Unreleased]: https://github.com/DasLukas/TeamTaler/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/DasLukas/TeamTaler/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/DasLukas/TeamTaler/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/DasLukas/TeamTaler/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/DasLukas/TeamTaler/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/DasLukas/TeamTaler/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/DasLukas/TeamTaler/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/DasLukas/TeamTaler/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/DasLukas/TeamTaler/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/DasLukas/TeamTaler/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/DasLukas/TeamTaler/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/DasLukas/TeamTaler/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DasLukas/TeamTaler/releases/tag/v0.1.0
