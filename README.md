# TeamTaler

TeamTaler is a lightweight, self-hosted web application for shared expenses in clubs, teams, and other groups. Members and invited long-term guests book drinks, penalties, and other products against their own consolidated group account. Authorized members can assign bookings to other members, create temporary guests inline, manage the catalog, record incoming payments, optionally close accounting periods, and review an audit trail.

The application combines a responsive German-language React interface, a Go HTTP API, local content-addressed image storage, and an embedded SQLite database. Production is delivered as one container and is designed for a single application instance behind an existing HTTPS reverse proxy.

## Implemented features

- Multiple isolated groups per installation and multiple group memberships per user.
- Local accounts with self-service name, password, and verified email changes; enumeration-resistant password reset; seven-day single-use invitation links; administrator-managed public join links with local QR codes and mandatory email verification for new accounts; automatic email delivery for individual and CSV invitations; idempotent CSV invitation imports; and server-side sessions.
- Temporary guests for one-off purchases, represented by credentialless local identities with stable membership and accounting history; administrators can rename, claim, archive, reactivate, or permanently remove them through the same lifecycle used for regular members.
- Self-service profile images with a drag-and-wheel crop editor, shown consistently in member administration, role assignment, booking activity, dashboards, and account surfaces.
- Product creation and editing use the same drag-and-wheel square crop editor before uploading catalogue images.
- Group-owned roles with stable identifiers, multiple roles per member or pending invitation, and cumulative permissions. Effective access is the union of all assigned role grants; roles never deny access granted by another role.
- Four seeded roles per group: the protected `GROUP_ADMINISTRATOR` role and editable `MEMBER`, `FINANCE_MANAGER`, and `CATALOG_MANAGER` starter roles. Members with `ROLE_MANAGEMENT` can create, duplicate, rename, extend, assign, and remove every role except the reserved administrator role, subject to the administrator safeguards below.
- Thirteen stable permission keys: `GROUP_ADMINISTRATION`, `ROLE_MANAGEMENT`, `FINANCE_MANAGEMENT`, `CATALOG_MANAGEMENT`, `VIEW_MEMBER_DIRECTORY`, `VIEW_GROUP_STATISTICS`, `VIEW_ALL_BOOKING_ACTIVITY`, `RECORD_OWN_PAYMENT`, `CREATE_OWN_BOOKING`, `VOID_OWN_BOOKING`, `VOID_ANY_BOOKING`, `BOOK_FOR_OTHERS`, and `BOOK_FOR_GUESTS`.
- Permission implications are computed instead of stored redundantly: `VOID_ANY_BOOKING` also grants `VOID_OWN_BOOKING` and `VIEW_ALL_BOOKING_ACTIVITY`, while `BOOK_FOR_OTHERS` implies `VIEW_MEMBER_DIRECTORY`.
- Scope-aware permission grants are ready for group, category, and product resources. The current v1 service accepts only `GROUP` grants; `CATEGORY` and `PRODUCT` remain reserved contract shapes until resource-specific policy and UI support are implemented.
- User-defined categories with editable visual symbols, fixed-price and user-defined-price products, a two-stage archive/delete lifecycle with history-preserving product tombstones, validated integer minor-unit booking prices, immutable product/price snapshots, and JPEG/PNG/WebP uploads normalized to content-addressed PNG files.
- Idempotent single and atomic multi-member booking creation, including all-or-nothing creation and charging of temporary guests by display name, immutable acting/target membership traceability, a 30-second actor-only reason-free undo window, and reasoned audited reversals.
- Group-configurable reason requirements and freely editable, ordered reason suggestions for bookings and payments.
- Activity views display and search both the charged member and the member who made every booking; narrow phone widths reflow the rows into labelled cards, while tablet, split-view, and desktop widths retain the table with horizontal overflow contained inside its own viewport. Dashboard activity highlights third-party assignments.
- A dedicated overview combines personal account information, recent activity, permission-gated group statistics, and a clearly separated finance-gated aggregate group balance; statistics cover the current period when settlements are enabled and the complete history when they are disabled. The mobile-first booking workspace uses a privacy-minimized booking context instead of the member directory or dashboard aggregates.
- A consolidated member receivable account across all categories and anonymous group category aggregates without exposing other members' balances.
- Ordered, editable group payment methods seeded with bank transfer, cash, PayPal, and other; the first method is the form default, at least one method is retained, and historical payments preserve their original method label after later edits.
- A dedicated permission-protected finance workspace at `/finance` with lifecycle-grouped member balances, exact receivable/credit/net totals, payment management, optional period settlements, and immutable settlement history. Archived accounts remain payable; permanently removed accounts appear only while a later correction leaves a non-zero balance.
- A dedicated permission-protected catalog workspace at `/catalog` with versioned category and product management, persistent pointer/touch/keyboard drag-and-drop ordering, contextual create actions, controlled category symbols, and recoverable image uploads. The same catalog order drives booking and overview category displays.
- Optional accounting-period settlements with immutable close snapshots, due dates, settlement status, and an atomically opened successor period. Settlements are disabled by default; disabling them keeps one technical open period and the complete ledger intact so a group can use a continuous balance or later resume the same period.
- Context-rich in-app notifications for externally initiated bookings, payments, reversals, and period settlements, with unread badges on desktop navigation and the mobile overflow destination, viewport-based acknowledgement, and cursor-backed history.
- A `GROUP_ADMINISTRATION`-protected audit view, safe CSV export of recent account entries, and browser print/PDF views.
- `GROUP_ADMINISTRATION`-managed group names and logos with a drag-and-wheel crop editor that update navigation identity and replace the TeamTaler mark for members of the active group.
- Typed group-administration behavior settings with a safe default role, optional notification emails, an optional settlement feature, transaction reason rules, editable payment methods, and separate booking and payment reason suggestions.
- TeamTaler browser-tab and installable-web-app icons for desktop, iOS, iPadOS, and Android launchers.
- Online backup archives containing a consistent SQLite snapshot and every product, group, and profile image referenced by that snapshot.

The administration UI is partitioned by effective permissions. `GROUP_ADMINISTRATION` exposes a single Settings tab that groups identity, branding, and notification delivery under Group Settings, places the default membership role under Roles, Rights & Members, keeps transaction behavior in its own section, and places the settlement switch in a dedicated Finance section. The switch is off by default for every new or upgraded group. Disabling settlements removes current-period and close controls from the interface without closing, replacing, or deleting the technical open period. Re-enabling settlements resumes that same period, including every booking, correction, and payment recorded while the feature was disabled. Existing immutable settlements remain available as read-only history where entries exist. The same permission exposes membership and invitation lifecycle, temporary-guest lifecycle, public join-link management, audit history, and protected administrator transfer. `ROLE_MANAGEMENT` exposes role creation and editing in the dedicated Roles & Rights tab, where permission switches are grouped by administration and members, bookings and activity, finance and reporting, and catalog. Versioned assignments for active members and pending invitations live beside their subjects in the Members tab: desktop tables use an anchored multi-select, compact screens use cards and a bottom sheet, and draft changes are persisted only after explicit confirmation. The Members tab requires `VIEW_MEMBER_DIRECTORY` together with either administration permission, while lifecycle actions still require `GROUP_ADMINISTRATION` and ordinary role assignments require `ROLE_MANAGEMENT`. The reserved group-administrator role has the fixed name `Group administrator`, cannot be deleted, always retains its group-administration and role-management grants, and must remain assigned to at least one active membership. Every active login-enabled membership and pending invitation explicitly retains at least one role; an active credentialless temporary guest is the sole roleless exception. `MEMBER`, `FINANCE_MANAGER`, and `CATALOG_MANAGER` are editable starter roles and may be deleted when unused. Group administrators choose one non-administrative default role in Settings; it is preselected for manual invitations and temporary-guest claims, supplies CSV rows with no role value, and is assigned at the moment a public join is accepted. A default role cannot be deleted or gain `GROUP_ADMINISTRATION` until another default is selected. Notification email delivery remains disabled by default and can be enabled only while complete SMTP configuration is available; in-app delivery is always retained. Catalog and finance workspaces are controlled by `CATALOG_MANAGEMENT` and `FINANCE_MANAGEMENT`, respectively.

Regular members and temporary guests share one two-stage group lifecycle. Archiving is reversible, removes effective access and booking eligibility, and preserves payment access so an outstanding balance can be settled. Reactivation keeps the membership and history; credentialed members receive an explicit role set, while temporary guests remain roleless and may be renamed to resolve an active-name conflict. Permanent removal is available only after archival and only at an exact zero balance. It removes the subject from member administration, strips email, avatar, roles, access, and guest-name reservations, and retains a credentialless tombstone identity with the last display name and stable membership ID for booking, payment, ledger, statement, and audit history. A credentialed user's account and memberships in other groups remain unchanged. A later join creates a new membership ID; a later financial reversal may temporarily expose the deleted account in finance until it is settled again.

Long-term guests are ordinary accounts whose access is defined only by their regular roles. Temporary guests have no credentials and no roles. `BOOK_FOR_GUESTS` permits selecting existing temporary guests and creating new ones inside a booking, without granting access to the member directory. A claim invitation preserves the guest's membership, bookings, balance, statements, and audit history. Its selected regular roles are applied exactly when the account is claimed; the current default role is preselected, and changing or extending that selection requires `ROLE_MANAGEMENT`.

`CREATE_OWN_BOOKING` permits bookings against the current member's account. `BOOK_FOR_OTHERS` independently permits reasoned bookings for other credentialed members and implies `VIEW_MEMBER_DIRECTORY`. `BOOK_FOR_GUESTS` independently permits bookings for existing or newly created temporary guests and does not require a reason or expose the member directory. The booking context and every write classify targets by their current credentials, so each permission authorizes only its own target class. The batch transaction creates every new credentialless identity, roleless active membership, booking, balanced ledger pair, notification, audit event, and idempotency result together; any invalid target or guest rolls back the entire command. Temporary guests appear after regular members under a visual separator. Active temporary-guest names are case-insensitively unique; a duplicate returns `409` with the existing membership ID for an explicit reuse choice and never merges silently. A role may therefore manage finance or catalog data without receiving any booking capability. `VOID_OWN_BOOKING` applies when the current member is either the booking actor or the charged target. Only a booking created by the current member has a 30-second reason-free window; later actor reversal and reversal of an incoming third-party booking always require a reason. `VOID_ANY_BOOKING` permits reversal of every group booking and always requires a reason when the current member is neither its actor nor target. `VIEW_ALL_BOOKING_ACTIVITY` expands only the activity feed; it does not expose another member's personal account or change mutation permissions. `VIEW_MEMBER_DIRECTORY` protects email, role, and effective-grant listings, while `VIEW_GROUP_STATISTICS` independently protects anonymous group category totals.

## Binding UI/UX principles

TeamTaler is mobile-first for regular members. Member-facing workflows must be designed and reviewed at a narrow mobile viewport before being enhanced for wider screens. Desktop layouts may expose more context, but they must not define the interaction model for everyday member tasks.

Interface copy follows a strict "as little as possible, as much as necessary" rule. Labels, hints, empty states, validation messages, and confirmations must use short, familiar German words and direct sentences. Copy must help the user understand the current state or next action without repeating what the interface already shows. Technical implementation details, internal terminology, permission keys, API concepts, and long explanations do not belong in the interface. When an error requires user action, the message describes only the user-visible effect and the simplest next step.

The canonical member routes are `/book` for the permission-gated booking workflow and `/overview` for personal information plus permission-gated anonymized group statistics. The overview deliberately adapts its information and actions to effective permissions and the settlement setting: personal information remains available to active login accounts, anonymous group category information requires `VIEW_GROUP_STATISTICS`, the group-wide outstanding amount remains finance-managed, and payment, finance, catalog, group-administration, and role-management actions appear only when their matching permission is effective. When settlements are disabled, overview, account, and finance surfaces omit references to a current period and show category statistics across the complete ledger history; when enabled, the existing current-period labels and statistics return. The consolidated member and group balances always use the complete ledger and therefore do not change when the setting is toggled. Members with `RECORD_OWN_PAYMENT` can start a reviewed own-account payment from the overview balance card or `/account`; narrow screens use a bottom sheet and wider screens use a dialog. `/catalog` is visible and queryable only with `CATALOG_MANAGEMENT`, while `/finance` requires `FINANCE_MANAGEMENT` and uses finance-authorized account summaries rather than the protected member directory. Payment target selectors group regular members before temporary guests using credential-derived summary data. Administration mounts only the sections allowed by `GROUP_ADMINISTRATION` or `ROLE_MANAGEMENT`; its member section additionally requires `VIEW_MEMBER_DIRECTORY`, and denied sections do not start protected queries. Booking navigation appears with at least one of `CREATE_OWN_BOOKING`, `BOOK_FOR_OTHERS`, or `BOOK_FOR_GUESTS`; it loads the technical open period, own balance, current membership, filtered minimal targets, and `canBookForGuests` from `/booking-context`, never from the directory or dashboard. After login, invitation acceptance, or group switching, the landing route is selected by the fixed priority booking, finance, catalog, administration, then overview. The overflow menu exposes notifications first, followed by authorized management workspaces in the fixed order finance, catalog, administration, account, and logout. The exact unread count appears on the overflow button until every new notification has intersected the visible notification viewport. The legacy `/reports` route redirects to `/overview`.

Fast product booking is the primary interaction goal. A regular member must be able to create the common fixed-price self-booking with as few deliberate interactions as possible. Once the desired product is visible, the default flow must require no more than two actions: select the product and confirm the booking. Additional input or confirmation is permitted only when required by the booking itself, such as a user-defined price, non-default quantity, one or more target members, or a mandatory shared reason.

Member-facing changes must therefore preserve these constraints:

- The primary booking action remains immediately discoverable and thumb-reachable on common phone widths without horizontal scrolling.
- Common defaults select the current member, quantity one, and the catalog price without asking the member to re-enter known information.
- Secondary information and administrative controls must not obstruct or lengthen the standard self-booking path.
- Successful booking feedback must be brief and automatically return the interface to a ready-to-book state.
- The booking workspace may preselect a category for orientation, but it must never preselect a product or open confirmation controls before an explicit product selection.
- New steps, dialogs, or confirmations in the standard booking path require a documented product, accounting, security, or safety reason.

## Scope and operating constraints

- TeamTaler supports one application replica on a local filesystem. SQLite on NFS, SMB, or another network filesystem is unsupported.
- TLS is terminated by an external reverse proxy. TeamTaler does not create or renew certificates.
- Individual and temporary-guest claim invitations are sent automatically when the optional TLS-secured SMTP configuration is enabled, while their links remain available for manual fallback sharing. Public join links require this delivery configuration because new accounts must prove mailbox ownership. Manual invitations start with the configured default role but may assign any non-empty multi-role selection. CSV rows may name one or more roles and otherwise use the configured default; no role is added after invitation creation. Temporary-guest claims preselect that same default role and persist the exact authorized role selection. Imports use the same transactional retrying outbox. The same SMTP relay can optionally deliver a short email alongside each in-app notification; credentialless guests never produce an email job, and members with `GROUP_ADMINISTRATION` control the group preference.
- There is no payment-provider integration, SSO, MFA, offline mutation queue, public plugin loader, or built-in metrics endpoint.
- The browser interface is German. Reusable interface, error, and accessibility copy is centralized in the i18next resource so additional locales can be added without rewriting feature components.
- Monetary values are persisted and calculated as signed integer minor units. JSON responses encode monetary fields as exact decimal strings, while command inputs use bounded JSON integers; floating-point amounts are never used for accounting. Fixed prices are server-authoritative, while user-defined product prices must be supplied and validated for each booking.

## Repository structure

- `cmd/teamtaler` contains the server and operator CLI entry point.
- `internal` contains the backend modules for authentication, groups, CSV member import, SMTP email delivery, catalog, shared image media, bookings, finance, periods, notifications, audit, backup, HTTP delivery, and SQLite infrastructure.
- `migrations` contains the forward-only SQLite schema embedded into the Go binary.
- `web` contains the React/Vite single-page application organized by feature.
- `api/openapi.yaml` is the machine-readable HTTP contract.
- `deploy` contains Compose networking and reverse-proxy examples.
- `scripts` contains verification and Compose backup helpers.

See [ARCHITECTURE.md](ARCHITECTURE.md) for module boundaries, data flow, persistence details, dependencies, and extension policy. Release changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Requirements

For container operation:

- A recent Docker Engine with BuildKit.
- Docker Compose v2.
- An existing HTTPS reverse proxy such as Caddy, Nginx, Traefik, or Nginx Proxy Manager.
- A local persistent filesystem for the TeamTaler data volume.

For local development:

- Go 1.26.x.
- Node.js 24.x and npm compatible with `web/package-lock.json`.
- A modern Chromium, Firefox, or Safari browser.

## Installation with Docker Compose

1. Clone the repository and enter it:

   ```sh
   git clone https://github.com/DasLukas/TeamTaler.git
   cd TeamTaler
   ```

2. Create local configuration:

   ```sh
   cp .env.example .env
   ```

3. Set `TEAMTALER_PUBLIC_URL` to the exact external origin and restrict `TEAMTALER_TRUSTED_PROXY_CIDRS` to the addresses from which the proxy connects. The public URL must use HTTPS for secure production cookies.

   To enable automatic invitations, verified public joining, password reset, verified email changes, and optional notification email, configure the complete SMTP block from `.env.example` and generate the email-token encryption key once:

   ```sh
   openssl rand -base64 32
   ```

   Store the result in `TEAMTALER_EMAIL_TOKEN_KEY`. Keep this key and the SMTP password outside version control and preserve the key across restores while pending email jobs may exist.

4. Build and start the application:

   ```sh
   docker compose up -d --build
   ```

   To use a published image instead, set `TEAMTALER_VERSION` to a reviewed semantic version, then run `docker compose pull app` followed by `docker compose up -d app`.

5. Create the first account, group, administrator membership, and open period:

   ```sh
   docker compose exec app teamtaler admin bootstrap \
     --email admin@example.com \
     --display-name "Team Admin" \
     --group "My Team"
   ```

   The command requests a password when one is not provided and suppresses terminal echo on a TTY. It also accepts `TEAMTALER_BOOTSTRAP_PASSWORD` or a password on standard input for controlled automation. Avoid `--password` in shell history. No default account is created, and bootstrap refuses to run after an account already exists.

6. Configure the reverse proxy to forward the external HTTPS origin to `127.0.0.1:8080`. Templates and container-network instructions are in [deploy/README.md](deploy/README.md).

The default Compose file binds the application port to host loopback, runs the process as a non-root user, drops Linux capabilities, uses a read-only root filesystem, and stores the database and images in the `teamtaler-data` volume.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TEAMTALER_PUBLIC_URL` | Production | `http://127.0.0.1:8080` | Exact root origin used for origin checks, invitation links, and secure-cookie selection. HTTPS is required unless the host is loopback; subpaths, credentials, queries, and fragments are rejected. |
| `TEAMTALER_TRUSTED_PROXY_CIDRS` | Behind a proxy | empty | Comma-separated CIDRs whose forwarded client-address headers are trusted. |
| `TEAMTALER_LISTEN` | No | `127.0.0.1:8080` | HTTP listen address. Compose sets `0.0.0.0:8080` inside the container. |
| `TEAMTALER_DATA_DIR` | No | `./data` | Persistent directory for images, backup/restore staging, and the default database. |
| `TEAMTALER_DATABASE_PATH` | No | `<data-dir>/teamtaler.db` | SQLite database path. Configuration requires this path to be a direct child of the data directory; a custom filename is supported. |
| `TEAMTALER_WEB_DIR` | No | `./web/dist` | Compiled frontend directory served by the Go process. |
| `TEAMTALER_MAX_REQUEST_BYTES` | No | `6291456` | Maximum HTTP request body size in bytes. |
| `TEAMTALER_SMTP_HOST` | With email | disabled | SMTP hostname or IP address without a scheme or port. |
| `TEAMTALER_SMTP_PORT` | With email | none | SMTP submission port, commonly `587` for STARTTLS or `465` for implicit TLS. |
| `TEAMTALER_SMTP_USERNAME` | With email | none | SMTP authentication username. |
| `TEAMTALER_SMTP_PASSWORD` | With email | none | SMTP authentication secret. Never commit it. |
| `TEAMTALER_SMTP_FROM_ADDRESS` | With email | none | Single ASCII envelope and message sender mailbox. |
| `TEAMTALER_SMTP_FROM_NAME` | No | empty | Optional sender display name. |
| `TEAMTALER_SMTP_TLS_MODE` | With email | `starttls` | Mandatory transport mode: `starttls` or `tls`; plaintext SMTP is unsupported. |
| `TEAMTALER_EMAIL_TOKEN_KEY` | With email | none | Standard-base64 encoding of exactly 32 random bytes used to encrypt queued invitation, public-join, account-action, and verification tokens. |

The application trusts forwarded client addresses only when the direct peer is inside a configured trusted CIDR. Keep both proxy and application request limits compatible; product-image and group-logo input is limited to 5 MiB before normalization.

SMTP configuration is fail-fast: supplying only part of the required block prevents startup. The relay certificate is verified, TLS 1.2 or newer is required, and authentication never occurs before encryption. TeamTaler considers a message sent after the relay accepts the SMTP `DATA` command; downstream mailbox delivery remains the relay operator's responsibility.

## Email delivery

When SMTP is configured, creating an individual invitation atomically stores the invitation and its encrypted outbox job. The group-administration dialog follows the delivery state until the relay accepts the message or delivery reaches a terminal failure, and it always displays the one-time acceptance link as a fallback. Without SMTP, individual invitations remain available as manually shareable links and are marked accordingly in the interface.

Password reset and verified email changes are available only when the complete SMTP block and `TEAMTALER_EMAIL_TOKEN_KEY` are configured. `GET /api/v1/auth/capabilities` exposes that runtime availability without account information so clients can hide only the unavailable email-dependent actions; local display-name and authenticated password changes remain available. Password-reset requests return the same empty `202` response for known and unknown addresses. Reset and email-change proofs expire after one hour, are consumed once, and are delivered in URL fragments such as `/reset-password#token=...` and `/email-change/confirm#token=...`; they never belong in request paths or query strings. A password change, successful reset, or confirmed email change revokes every session for the account, including the session that initiated an authenticated change. Email confirmation updates the existing user identity in place, so memberships, balances, statements, and audit history remain attached to their existing identifiers.

A member with `GROUP_ADMINISTRATION` can create one active public join link from the Members workspace and share either its URL or its locally generated QR code. The administrator chooses one hour, six hours, one day, seven days, 30 days, a custom duration between one hour and 365 days, or unlimited availability. Lifetime changes preserve the current token; rotation replaces the URL and QR code, while deactivation removes the stored token. Both operations invalidate pending registrations immediately. Existing accounts authenticate before joining. New accounts receive a one-hour, one-time mailbox-verification message and become members only after successful verification. The role assigned at acceptance is always the group's then-current safe default role, including when an archived membership is reactivated. SMTP and `TEAMTALER_EMAIL_TOKEN_KEY` are therefore mandatory before a public link can be enabled.

The same normalized email address cannot have more than one current invitation in a group. This rule is shared by individual creation and CSV imports, so repeated or mixed requests reuse the existing invitation outcome instead of creating another email job. A database trigger provides a final concurrency guard for simultaneous requests. Expired, revoked, or accepted invitations do not block a later valid invitation; only an active membership blocks another invitation, while an archived membership may be invited for reactivation.

Every externally initiated booking assignment or reversal, group-managed payment or reversal for another member, and generated period settlement creates an in-app notification inside the originating business transaction. When SMTP is configured and a member with `GROUP_ADMINISTRATION` has enabled notification emails for the group, the same transaction also creates a notification-email outbox job. The worker sends short localized event details and a link to the notification inbox, retries temporary failures up to five times, and never delays or replaces in-app delivery. If SMTP is unavailable, the administration switch is visible but disabled.

## CSV invitation import

Members with `GROUP_ADMINISTRATION` can upload UTF-8 CSV files from the member administration screen. The first row must contain `email` and may additionally contain `display_name` and `roles`. Role names are matched case-insensitively within the group; multiple names use `|`. A missing or blank `roles` value uses the configured default role. If no default is configured, that row is reported as invalid. Comma and semicolon delimiters, LF or CRLF line endings, and an optional UTF-8 BOM are accepted. Unknown columns are rejected. Example:

```csv
email,display_name,roles
alex@example.com,Alex Member,
sam@example.com,Sam Member,Finance manager|Catalog manager
```

Each file is limited to 256 KiB and 100 data rows. Unknown role names, a missing fallback, invalid rows, duplicate addresses, existing memberships, and already-pending invitations are reported individually without discarding valid rows. The former repeated `roleId` query parameter remains as a deprecated shared fallback for API compatibility.

The import creates invitations, not memberships. A membership appears only after the recipient follows the emailed one-time link and completes the existing invitation flow. The database transaction stores each invitation together with an encrypted email job and the idempotent import result. A background dispatcher retries temporary delivery failures up to five times. The plaintext token is never stored in the outbox or API result, and its encrypted copy is removed after SMTP acceptance.

The result dialog follows queued deliveries until they are sent or reach a terminal state. A member with `GROUP_ADMINISTRATION` can explicitly requeue a failed delivery from that dialog; accepted, revoked, expired, pending, or already-sent invitations cannot be retried.

## Local development

Install all dependencies:

```sh
make install
```

Bootstrap a local database once:

```sh
go run ./cmd/teamtaler admin bootstrap \
  --email admin@example.test \
  --display-name "Local Admin" \
  --group "Local Team"
```

Run the API and Vite server in separate terminals. The public URL must match the browser-facing Vite origin so mutation origin checks succeed:

```sh
TEAMTALER_PUBLIC_URL=http://127.0.0.1:5173 make dev-backend
```

```sh
make dev-frontend
```

Vite listens on `127.0.0.1:5173` and proxies `/api` to `127.0.0.1:8080`.

For frontend-only visual development, copy `web/.env.example` to `web/.env.local` and run the Vite server without the API. Demo transport and its sample images are loaded only when `VITE_DEMO_MODE=true` and Vite is in development mode. Production builds contain neither demo fixtures nor demo assets.

### Disposable full-stack test server

The Codex environment action **Start test server** starts the real Go backend on `127.0.0.1:8080`, the Vite frontend on `127.0.0.1:5173`, and a fresh isolated SQLite database with representative catalog, role, permission, booking, notification, and payment data. The same workflow is available from a terminal:

```sh
make test-server
```

The fixture contains `TeamTaler Demo Club` and `TeamTaler Weekend Club`. The second group includes the `Refreshments` category with the fixed-price `Club Coffee` product. All seeded accounts use the password `TeamTaler-Test-2026!`:

- `admin@example.test` has the protected group-administrator role in both groups.
- `jonas@example.test` has the finance-manager and catalog-manager preset roles.
- `marie@example.test` has the member starter role plus a dedicated editable role for self-payments and bookings for other members.
- `lena@example.test` belongs to both groups and has a regular member role in the second group.
- `noah@example.test` has a regular member role and belongs only to `TeamTaler Weekend Club`.

The server binds only to loopback. Stopping the action terminates both processes and removes that run's disposable database. Generated binaries remain below the ignored `tmp/test-server` directory so later starts can reuse Go's build cache.

Optional SMTP delivery for this disposable server is read from the ignored `.env.test-server.local` file. The file accepts only the documented SMTP variables and is never sourced as shell code. When username or password is empty, the action starts normally with email delivery disabled. For IONOS, use `smtp.ionos.de` on port `587` with `starttls`; the authenticated mailbox is also used as the sender unless `TEAMTALER_SMTP_FROM_ADDRESS` is set explicitly. Restart the action after changing the file.

## Verification, build, and run

Run formatting checks, static analysis, backend and frontend tests, and production builds:

```sh
make verify
```

The stricter CI-equivalent helper also runs Go tests with the race detector:

```sh
./scripts/verify.sh
```

Run the focused full-stack role and permission acceptance suite in desktop and
narrow mobile viewports with:

```sh
make test-e2e
```

Playwright starts and removes the disposable test server automatically. Install
its Chromium runtime once with `cd web && npx playwright install chromium` when
no compatible local browser is available.

Build without Docker:

```sh
make build
```

The resulting binary is `./bin/teamtaler`, and the frontend output is `./web/dist`. Run them from the repository root:

```sh
./bin/teamtaler serve
```

Runtime data is written to `./data` by default and is excluded from Git.

Available operator commands are:

```text
teamtaler serve
teamtaler version
teamtaler healthcheck [--url URL] [--timeout DURATION]
teamtaler admin bootstrap --email EMAIL --display-name NAME --group GROUP [--currency EUR]
teamtaler backup create --output FILE.tar.gz
teamtaler restore --input FILE.tar.gz [--force]
```

## Backup, restore, and upgrades

Create an online application-consistent backup from the Compose deployment:

```sh
./scripts/backup.sh
```

The archive contains a `VACUUM INTO` SQLite snapshot, referenced content-addressed images, a format manifest, and SHA-256 checksums. Copy completed archives to separate storage and encrypt them with a backup tool such as Restic or Borg.

Restore only while the application is stopped. The restore implementation rejects unsafe archive paths, unsupported entries, oversized expanded content, checksum mismatches, invalid image content addresses, SQLite integrity or foreign-key failures, unsupported migration versions, missing referenced images, and unreferenced archived images. It preserves replaced local data in a timestamped recovery directory when `--force` is used.

Migration `0017` upgrades the legacy fixed-role model to group-owned roles. Before installing this upgrade, create and verify an application backup. The migration creates the four preset roles in every group, assigns the base role to active memberships and open invitations, maps legacy administrator, finance, and catalog roles to their corresponding presets, preserves direct self-payment access through a visible editable migration role, and maps the legacy group-wide activity switch to `VIEW_ALL_BOOKING_ACTIVITY` on the base role. Archived memberships retain no assignments. Accepted invitations that reactivate an archived membership replace assignments atomically with the base role plus the invitation's selected roles; a database recovery guard adds the reserved administrator role only when the group would otherwise have no active reserved administrator.

Migration `0018` makes the post-migration model fully explicit. It adds `CREATE_OWN_BOOKING`, grants it to the administrator and member starter roles, removes special protection from the member role, and requires every active membership and pending invitation to keep at least one role. Existing assignments are preserved. Migration `0021` narrows that invariant only for a credentialless temporary guest; every login-enabled membership and pending invitation still requires a role. New manual and CSV invitations must specify one or more roles, and acceptance or reactivation applies exactly those selected roles. Only the reserved group-administrator role remains immutable and undeletable.

Migration `0019` adds the group-owned default role used by new invitations. Existing groups use their `MEMBER` preset when it still exists; groups where that editable starter was deleted remain unset until a group administrator chooses a safe role. New groups default to `MEMBER`. Referential constraints prevent deletion of the selected role, while service and database policy prevent it from granting `GROUP_ADMINISTRATION`.

Migration `0020` adds one versioned public join-link record per group, email-verified pending registrations, and a leased encrypted verification-email outbox. It does not enable a link automatically. Enabling requires complete SMTP configuration and an existing safe default role. Rotation and deactivation invalidate pending registrations, and expired links remain administratively visible without exposing their token.

Migration `0021` adds temporary guests and three permissions. It permits a `users` row to omit email and password only as a coupled pair, keeps every `memberships.user_id` required, allows only credentialless active memberships to omit role assignments, adds the case-insensitive `temporary_guest_name_key`, allows a period-statement email snapshot to be null, and lets a claim invitation target one stable membership. It adds `VIEW_MEMBER_DIRECTORY`, `VIEW_GROUP_STATISTICS`, and `BOOK_FOR_GUESTS` to the permission registry. Every existing role receives the two read grants so upgraded groups retain their former reads; only existing and future group-administrator roles receive `BOOK_FOR_GUESTS` automatically. No group, role, membership, invitation, or account is converted automatically.

Migration `0022` adds one-hour account-security actions and a leased encrypted email outbox for password resets and verified email changes. Existing accounts, sessions, memberships, balances, and history remain unchanged. The feature remains unavailable until complete SMTP and token-encryption configuration is present.

Migration `0023` adds the permanent-removal timestamp and lifecycle indexes to memberships. It does not delete or rewrite historical financial records. Permanent removal requires an archived membership with an exact zero balance, retains its stable membership ID and last display name through a credentialless tombstone identity, and leaves the original account and its memberships in other groups unchanged.

Migration `0025` adds `settlements_enabled` to every group settings record with a required false default. Existing groups therefore move to continuous-balance mode without closing or replacing their current technical period, rewriting ledger entries, or changing consolidated balances. Enabling settlements later continues that same open period, including activity recorded while the feature was disabled; prior statements and closed periods remain immutable.

Legacy category grants on memberships and invitations are intentionally removed during `0017`. They are not widened to group grants because doing so would increase access. Review role assignments after the upgrade and create appropriate group-wide roles only where the broader access is intended. The v1 data model already represents category and product scopes, but the service rejects them until resource-specific evaluation and management UI are available. Downgrade migrations are not provided; rollback requires the pre-upgrade backup and a compatible older image.

The HTTP upgrade keeps the endpoints below `/api/v1` and adds booking context, temporary-guest lifecycle commands, unified member reactivation and permanent removal, three permission definitions, booking display names and lifecycle statuses, and the optional `temporaryGuestDisplayNames` batch field. Existing clients may continue sending only `targetMembershipIds`. `Membership.userId` remains required, while `Membership.email` and statement email snapshots can be null and `Membership.isTemporaryGuest` is derived only from missing credentials. The bundled API and SPA are deployed together, so operators should back up, install one matching release, and verify readiness. Deprecated role strings remain projections of preset assignments; legacy writes preserve custom roles, require the current assignment ETag, and enforce the same non-empty assignment policy as the dynamic API. See [api/openapi.yaml](api/openapi.yaml) for the complete wire contract.

Follow the exact backup, restore, upgrade, and rollback procedures in [deploy/README.md](deploy/README.md).

## Security

TeamTaler uses Argon2id password hashing, hashed opaque server-side session tokens, an HttpOnly session cookie, a readable CSRF cookie, SameSite Strict cookies, the Secure attribute under HTTPS, exact-origin validation for mutations, bounded request bodies, trusted-proxy filtering, and in-process throttling for login and invitation acceptance. Credentialless guest identities satisfy a database constraint requiring both email and password hash to be absent, can never authenticate, never receive synthetic email addresses, and never enqueue notification email. Invitation imports and accounting mutations additionally require an idempotency key, and queued invitation tokens use AES-256-GCM authenticated encryption. Temporary-guest creation shares the batch-booking idempotency and transaction boundary. Image delivery also requires active membership and a product or logo reference inside the requested group.

Financial history uses immutable `ledger_entries` plus linked counter-entries for corrections. Closed period snapshots and audit events are protected by SQLite triggers. Disabling settlements is a presentation and close-policy change, not an accounting mutation: consolidated balances still use the complete ledger, the technical open period remains available for writes, and the server rejects period-close commands while the setting is off. The self-payment API derives the target membership exclusively from the authenticated group session, requires CSRF and idempotency protection, records the `SELF_SERVICE` audit source, and never grants payment-list or reversal access. A central backend policy resolves stable permission keys from current role assignments for each request; permission changes are not session-cached. Member-directory and group-statistic reads require positive grants, while the booking context exposes only the actor's own balance and booking-safe target fields. Critical role, claim, assignment, and membership archival operations recheck authorization inside their serialized SQLite write transaction. Database constraints and service checks preserve credential invariants, claim-role preparation, the fixed protected administrator role, and at least one active assignment of that exact role. Frontend capability checks are presentation only.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open a public issue for an undisclosed vulnerability.

## Development workflow and branch strategy

- `main` contains publishable releases only.
- `dev` is the integration branch.
- Feature and fix branches start from `dev` and return through reviewed pull requests.
- Release pull requests merge `dev` into `main`; the resulting commit receives a semantic version tag such as `v0.2.0`.
- Hotfixes start from `main`, are released there, and are merged back into `dev`.

All code, comments, project documentation, commit messages, and pull request text are written in English. See [CONTRIBUTING.md](CONTRIBUTING.md) for quality and review requirements.

## License

TeamTaler is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Copyright © 2026 TeamTaler contributors.
