# Changelog

All notable TeamTaler changes are documented in this file. The project follows [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/DasLukas/TeamTaler/releases/tag/v0.1.0
