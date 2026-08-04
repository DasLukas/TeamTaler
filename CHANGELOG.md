# Changelog

All notable TeamTaler changes are documented in this file. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/DasLukas/TeamTaler/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DasLukas/TeamTaler/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DasLukas/TeamTaler/releases/tag/v0.1.0
