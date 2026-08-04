# TeamTaler

TeamTaler is a lightweight, self-hosted web application for shared expenses in clubs, teams, and other groups. Members book drinks, penalties, and other products against their own consolidated group account. Authorized members can assign bookings to other members, manage the catalog, record incoming payments, close accounting periods, and review an audit trail.

The application combines a responsive German-language React interface, a Go HTTP API, local content-addressed image storage, and an embedded SQLite database. Production is delivered as one container and is designed for a single application instance behind an existing HTTPS reverse proxy.

## Implemented features

- Multiple isolated groups per installation and multiple group memberships per user.
- Local accounts, seven-day single-use invitation links, optional display-name suggestions, automatic email delivery for individual and CSV invitations, idempotent CSV invitation imports, and server-side sessions.
- Cumulative group roles:
  - `ADMIN` has all group capabilities and manages branding, roles, and category grants.
  - `FINANCE_MANAGER` records and reverses payments, views member accounts, and closes periods.
  - `CATALOG_MANAGER` creates and updates categories and products and uploads product images.
- Category-scoped `ASSIGN_TO_OTHERS` and `VOID_BOOKINGS` grants.
- User-defined categories without a secondary category type, integer minor-unit prices, product snapshots in bookings, and JPEG/PNG/WebP uploads normalized to content-addressed PNG files.
- Idempotent booking creation, immutable acting/target membership traceability, 30-second self-undo for self-bookings, and reasoned audited reversals.
- Mandatory reasons whenever a booking is assigned to another member.
- Activity views display and search both the charged member and the member who made every booking; dashboard activity highlights third-party assignments.
- A consolidated member receivable account across all categories, current-period personal statistics, and anonymous group category aggregates.
- Incoming payments, payment reversals, oldest-claim-first allocation, overpayment credit, and correction allocation across periods.
- Flexible accounting periods with immutable close snapshots, due dates, settlement status, and an atomically opened successor period.
- In-app notifications, an administrator-only audit view, safe CSV export of recent account entries, and browser print/PDF views.
- Administrator-managed group logos that replace the TeamTaler mark for members of the active group.
- Online backup archives containing a consistent SQLite snapshot and every image referenced by that snapshot.

The administration UI supports group branding, permission-aware individual invitations, CSV invitation imports, invitation editing/revocation/resending, active and former member management, role and category-grant updates, catalog creation, image upload, incoming payments, payment reversals, period close, and audit review. Removing a member archives only the group membership and preserves every financial and audit record; a later accepted invitation reactivates the same membership identity.

## Scope and operating constraints

- TeamTaler supports one application replica on a local filesystem. SQLite on NFS, SMB, or another network filesystem is unsupported.
- TLS is terminated by an external reverse proxy. TeamTaler does not create or renew certificates.
- Individual invitations are sent automatically when the optional TLS-secured SMTP configuration is enabled, while their links remain available for manual fallback sharing. Manual invitations may assign roles and category grants immediately. CSV imports require SMTP, create regular-member invitations only, and use the same transactional retrying outbox.
- There is no payment-provider integration, SSO, MFA, offline mutation queue, public plugin loader, or built-in metrics endpoint.
- The browser interface is German. Reusable interface, error, and accessibility copy is centralized in the i18next resource so additional locales can be added without rewriting feature components.
- Monetary values are persisted and calculated as signed integer minor units. JSON responses encode monetary fields as exact decimal strings, while command inputs use bounded JSON integers; floating-point amounts are never used for accounting.

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

   To enable automatic invitation email, configure the complete SMTP block from `.env.example` and generate the outbox encryption key once:

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
| `TEAMTALER_EMAIL_TOKEN_KEY` | With email | none | Standard-base64 encoding of exactly 32 random bytes used to encrypt queued invitation tokens. |

The application trusts forwarded client addresses only when the direct peer is inside a configured trusted CIDR. Keep both proxy and application request limits compatible; product-image and group-logo input is limited to 5 MiB before normalization.

SMTP configuration is fail-fast: supplying only part of the required block prevents startup. The relay certificate is verified, TLS 1.2 or newer is required, and authentication never occurs before encryption. TeamTaler considers a message sent after the relay accepts the SMTP `DATA` command; downstream mailbox delivery remains the relay operator's responsibility.

## Invitation email delivery

When SMTP is configured, creating an individual invitation atomically stores the invitation and its encrypted outbox job. The administrator dialog follows the delivery state until the relay accepts the message or delivery reaches a terminal failure, and it always displays the one-time acceptance link as a fallback. Without SMTP, individual invitations remain available as manually shareable links and are marked accordingly in the interface.

The same normalized email address cannot have more than one current invitation in a group. This rule is shared by individual creation and CSV imports, so repeated or mixed requests reuse the existing invitation outcome instead of creating another email job. A database trigger provides a final concurrency guard for simultaneous requests. Expired, revoked, or accepted invitations do not block a later valid invitation; only an active membership blocks another invitation, while an archived membership may be invited for reactivation.

## CSV invitation import

Administrators can upload UTF-8 CSV files from the member administration screen. The first row must contain `email` and may additionally contain `display_name`. Comma and semicolon delimiters, LF or CRLF line endings, and an optional UTF-8 BOM are accepted. Unknown columns are rejected. Example:

```csv
email,display_name
alex@example.com,Alex Member
sam@example.com,Sam Member
```

Each file is limited to 256 KiB and 100 data rows. Imported people receive no elevated role; administrators grant roles and category permissions separately after the invitation is accepted. Invalid rows, duplicate addresses, existing memberships, and already-pending invitations are reported individually without discarding valid rows.

The import creates invitations, not memberships. A membership appears only after the recipient follows the emailed one-time link and completes the existing invitation flow. The database transaction stores each invitation together with an encrypted email job and the idempotent import result. A background dispatcher retries temporary delivery failures up to five times. The plaintext token is never stored in the outbox or API result, and its encrypted copy is removed after SMTP acceptance.

The result dialog follows queued deliveries until they are sent or reach a terminal state. An administrator can explicitly requeue a failed delivery from that dialog; accepted, revoked, expired, pending, or already-sent invitations cannot be retried.

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

## Verification, build, and run

Run formatting checks, static analysis, backend and frontend tests, and production builds:

```sh
make verify
```

The stricter CI-equivalent helper also runs Go tests with the race detector:

```sh
./scripts/verify.sh
```

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

Follow the exact backup, restore, upgrade, and rollback procedures in [deploy/README.md](deploy/README.md).

## Security

TeamTaler uses Argon2id password hashing, hashed opaque server-side session tokens, an HttpOnly session cookie, a readable CSRF cookie, SameSite Strict cookies, the Secure attribute under HTTPS, exact-origin validation for mutations, bounded request bodies, trusted-proxy filtering, and in-process throttling for login and invitation acceptance. Invitation imports additionally require an idempotency key, and queued invitation tokens use AES-256-GCM authenticated encryption. Image delivery also requires active membership and a product or logo reference inside the requested group.

Financial history uses immutable `ledger_entries` plus linked counter-entries for corrections. Closed period snapshots and audit events are protected by SQLite triggers. Authorization is enforced again in backend services; frontend capability checks are presentation only.

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
