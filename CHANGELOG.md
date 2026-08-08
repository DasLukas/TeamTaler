# Changelog

All notable TeamTaler changes are documented in this file. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Group-owned, many-to-many roles with stable identifiers, cumulative permission grants, multiple roles per membership or pending invitation, four seeded starter roles, and a role-centered administration workflow.
- Ten stable group permission keys covering group administration, role management, finance, catalog, complete booking activity, own-account payments, own booking creation, own or arbitrary booking reversal, and booking for other members.
- Additive v1 role, permission-definition, and role-assignment endpoints with optimistic ETag concurrency control and tenant-bound identifiers.
- A scope-aware permission-grant contract that stores `GROUP`, `CATEGORY`, and `PRODUCT` scope shapes while accepting only group-wide grants in v1.
- A group-owned default role that preselects manual invitations and safely supplies CSV rows without an explicit role value.
- Administrator-managed public join links with configurable finite or unlimited lifetime, local QR generation and download, copy support, immediate disable, and token rotation.
- Email-verified public registration for new accounts plus authenticated direct joining and archived-membership reactivation for existing accounts.
- An accessible multi-choice booking target dropdown plus an additive atomic batch-booking endpoint for applying one product, quantity, price, and reason to multiple members.

### Changed

- Moved role assignment from the role-definition workspace into responsive member and pending-invitation directories with compact multi-select triggers, explicit draft confirmation, optimistic-conflict refresh, and protected last-administrator controls. Unchanged preset descriptions are localized in the German interface without overwriting stored canonical values.
- Made `MEMBER`, `FINANCE_MANAGER`, and `CATALOG_MANAGER` ordinary editable and deletable starter roles, removed implicit member-role assignment, and require every active membership and pending invitation to retain at least one explicit role.
- Added `CREATE_OWN_BOOKING` as the independent self-booking capability. Booking navigation and target choices now reflect `CREATE_OWN_BOOKING` and `BOOK_FOR_OTHERS`, while permission-less finance or catalog roles remain possible.
- Kept manual invitation roles explicit while preselecting the configured default. CSV imports now accept case-insensitive role names per row, use `|` for multiple roles, and fall back to the safe group default; the former shared `roleId` parameter remains compatible.
- Users with `BOOK_FOR_OTHERS` can select multiple active targets while retaining their own membership as the default when `CREATE_OWN_BOOKING` is also effective; the confirmation shows per-member and combined totals.
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

- Protected the reserved group-administrator role, its fixed identity, and its non-removable core grants, and require every group to retain at least one active assignment of that exact role.
- Revalidate permissions and last-administrator invariants inside serialized SQLite write transactions so revocation is immediate and concurrent demotions or archival cannot lock a group out.
- Prevent default roles from being deleted or receiving `GROUP_ADMINISTRATION`, avoiding accidental administrative access through invitation defaults or CSV imports.
- Store reusable public join tokens as hashes plus authenticated ciphertext, keep them in URL fragments, require mailbox verification for new accounts, return enumeration-resistant registration responses, and invalidate pending proofs atomically on rotation or disable.
- Validate every multi-booking target and permission before writing, and commit all booking, ledger, allocation, notification, audit, and idempotency rows atomically.

## [0.5.2] - 2026-08-07

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

[Unreleased]: https://github.com/DasLukas/TeamTaler/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/DasLukas/TeamTaler/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/DasLukas/TeamTaler/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/DasLukas/TeamTaler/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/DasLukas/TeamTaler/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/DasLukas/TeamTaler/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/DasLukas/TeamTaler/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DasLukas/TeamTaler/releases/tag/v0.1.0
