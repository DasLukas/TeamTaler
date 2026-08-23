# TeamTaler

TeamTaler is a lightweight, self-hosted web application for managing shared expenses in clubs, teams, and similar groups. It combines bookings, a configurable product catalogue, member accounts, payments, optional settlement periods, roles, invitations, notifications, and audit history in one responsive German-language application.

This README is the primary entry point for the person who installs and operates a TeamTaler instance. It explains production installation, host and instance configuration, the local operator CLI, backups, upgrades, and basic troubleshooting. It intentionally does not serve as a member user manual, development guide, API reference, or architecture specification.

## What TeamTaler provides

- Multiple isolated groups in one installation.
- Group-owned roles and granular permissions for administration, bookings, finance, catalogue management, and reporting.
- Fixed-price and user-defined-price products with category, file or camera image capture, archive, and ordering support.
- Account balances, incoming payments with optional or required image/PDF receipts, immutable corrections, optional accounting periods, and settlement history.
- Searchable, column-filterable, sortable operational tables with shareable filter state, cursor-backed loading, and complete horizontally scrollable mobile columns.
- Individual invitations, CSV invitation imports, public join links, and temporary guest accounts.
- Local accounts with profile images, password recovery, verified email changes, and server-side sessions.
- In-app notifications plus independently configurable SMTP and standards-based Web Push delivery.
- Global system administration for instance settings and the complete group lifecycle.
- Reversible group archival and strongly protected permanent group deletion.
- Application-consistent backups containing SQLite data and referenced media.

## Deployment model

TeamTaler runs as one application container. The container serves both the web interface and API and stores its SQLite database, managed images, and payment receipts in one persistent Docker volume.

A supported production deployment requires:

- a Linux host with a recent Docker Engine and Docker Compose v2;
- one TeamTaler application replica;
- a local persistent filesystem for the `teamtaler-data` volume;
- an existing HTTPS reverse proxy such as Caddy, Nginx, Traefik, or Nginx Proxy Manager;
- a DNS name and valid TLS certificate for browser access;
- optionally, a TLS-capable SMTP relay for automatic email delivery;
- optionally, browser Web Push credentials for installable desktop, Android, and iOS Home Screen web apps.

SQLite on NFS, SMB, or another network filesystem is unsupported. TeamTaler does not terminate TLS, request certificates, provide an external database, or support horizontal application replicas.

## Quick start with Docker Compose

### 1. Download TeamTaler

Clone the repository and enter it:

```sh
git clone https://github.com/DasLukas/TeamTaler.git
cd TeamTaler
```

For a production installation, use a reviewed release tag and keep `TEAMTALER_VERSION` pinned instead of following an unreviewed branch or floating container tag.

### 2. Create the host configuration

Copy the supplied template:

```sh
cp .env.example .env
chmod 600 .env
```

At minimum, edit these values:

```dotenv
TEAMTALER_PUBLIC_URL=https://teamtaler.example.com
TEAMTALER_VERSION=1.0.0
TEAMTALER_HOST_PORT=8080
TEAMTALER_TRUSTED_PROXY_CIDRS=
```

`TEAMTALER_PUBLIC_URL` must be the exact browser-facing origin. Use HTTPS in production. Do not include a trailing path, credentials, query, or fragment.

Leave `TEAMTALER_TRUSTED_PROXY_CIDRS` empty until the direct proxy peer has been identified. When client-address forwarding is required, trust only the proxy address or the narrowest possible CIDR. Forwarded addresses from other peers are ignored.

Generate the persistent encryption key before enabling SMTP or storing SMTP credentials in the web interface:

```sh
openssl rand -base64 32
```

Store the result in `.env` as `TEAMTALER_EMAIL_TOKEN_KEY`. Keep this value secret, outside version control, and available during restores. Losing or changing it invalidates encrypted pending email material and a stored SMTP password.

Web Push uses an independent storage key. Generate another random 32-byte value for `TEAMTALER_PUSH_STORAGE_KEY`, then create the VAPID identity with `teamtaler admin system web-push generate`. Back up both values securely; rotating the VAPID identity deliberately requires browsers to register a new subscription.

The standard Compose deployment supplies the correct container paths. Do not change `TEAMTALER_LISTEN`, `TEAMTALER_DATA_DIR`, `TEAMTALER_DATABASE_PATH`, or `TEAMTALER_WEB_DIR` unless the corresponding mounts and deployment procedures are changed deliberately.

### 3. Start the application

Pull the pinned image and start TeamTaler:

```sh
docker compose pull app
docker compose up -d app
```

To build the current checkout locally instead of using the published image:

```sh
docker compose up -d --build
```

Verify that the container is healthy:

```sh
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:8080/health/ready
```

Adjust the port in the readiness URL when `TEAMTALER_HOST_PORT` is not `8080`.

### 4. Configure the reverse proxy

Forward the public HTTPS origin to `http://127.0.0.1:8080` when the proxy runs on the Docker host. A proxy in Docker should share a dedicated external network with TeamTaler and use `http://app:8080` as its upstream.

The proxy must preserve the request method, path, query, body, cookies, `Origin`, and `X-CSRF-Token`. Its body-size limit must be at least 51 MiB to preserve the full runtime-configurable receipt range, and at least as large as `TEAMTALER_MAX_REQUEST_BYTES` when that ordinary API ceiling is configured above 51 MiB.

Ready-to-adapt Caddy, Nginx, Traefik, and shared-Docker-network examples are documented in [deploy/README.md](deploy/README.md).

### 5. Create the first administrator

Run bootstrap exactly once:

```sh
docker compose exec app teamtaler admin bootstrap \
  --email admin@example.com \
  --display-name "Team Admin" \
  --group "My Team"
```

The command securely prompts for a password. It creates:

- the first local account;
- its global `SYSTEM_ADMINISTRATOR` assignment;
- the first active group;
- the protected group-administrator membership for that account;
- the initial open accounting period.

Bootstrap refuses to run after an account already exists. It never accepts a password as a command-line argument or environment variable.

### 6. Open the instance

Open `TEAMTALER_PUBLIC_URL` in a browser and sign in with the bootstrap account. The first settings tab is **System**, where the instance identity, default currency, media and receipt limits, SMTP, public joining, maintenance mode, groups, and global system audit are managed.

## Configuration

TeamTaler separates immutable host configuration from runtime-editable instance settings.

- Host configuration is read at process start and changed through `.env` plus a container restart.
- Instance settings use environment variables as defaults. A system administrator may store versioned SQLite overrides through the System tab or CLI. A reset removes the override and immediately reveals the current environment or built-in default.

### Host configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEAMTALER_PUBLIC_URL` | `http://127.0.0.1:8080` | Exact public origin used for links, mutation-origin validation, secure cookies, and HSTS. Use HTTPS in production. |
| `TEAMTALER_TRUSTED_PROXY_CIDRS` | empty | Comma-separated direct proxy CIDRs allowed to supply forwarded client addresses. |
| `TEAMTALER_HOST_PORT` | `8080` | Host-loopback port published by Docker Compose. |
| `TEAMTALER_IMAGE` | `ghcr.io/daslukas/teamtaler` | Container image repository used by Compose. |
| `TEAMTALER_VERSION` | current release | Pinned image tag and application version. |
| `TEAMTALER_MAX_REQUEST_BYTES` | `6291456` | Request-body ceiling for ordinary API operations. Media and payment-receipt routes instead follow their live upload setting plus a fixed multipart reserve. |
| `TEAMTALER_EMAIL_TOKEN_KEY` | unset | Base64-encoded 32-byte key for encrypted email proofs and stored SMTP credentials. |
| `TEAMTALER_PUSH_STORAGE_KEY` | unset | Independent base64-encoded 32-byte key for VAPID overrides and encrypted browser subscriptions. |
| `TEAMTALER_SMTP_ALLOW_PRIVATE_NETWORK` | `false` | Allows web-configured SMTP targets on private or local networks. Enable only for a trusted private relay requirement. |
| `TEAMTALER_SMTP_TEST_RECIPIENT` | empty | Optional immutable mailbox for operator-triggered SMTP test messages. Normal application email is unaffected. |

The standard container also uses fixed runtime paths from `.env.example`. Detailed path, proxy-network, and storage guidance is in [deploy/README.md](deploy/README.md).

### Runtime-editable instance defaults

| Environment default | Built-in default | System setting |
| --- | --- | --- |
| `TEAMTALER_INSTANCE_NAME` | `TeamTaler` | Public instance name. |
| `TEAMTALER_DEFAULT_CURRENCY` | `EUR` | Currency suggested for newly created groups. Existing groups are unchanged. |
| `TEAMTALER_MEDIA_UPLOAD_MAX_BYTES` | `5242880` | Shared raw upload limit for product images, group logos, and avatars. |
| `TEAMTALER_ATTACHMENT_UPLOAD_MAX_BYTES` | `15728640` | Raw upload limit for one payment receipt. |
| `TEAMTALER_PUBLIC_JOIN_ENABLED` | `true` | Global availability of otherwise valid public join links. |
| `TEAMTALER_MAINTENANCE_MODE` | `false` | Read-only maintenance policy. Login, reads, logout, health checks, and system administration remain available. |
| `TEAMTALER_MAINTENANCE_MESSAGE` | empty | Short public maintenance notice. |
| `TEAMTALER_WEB_PUSH_ENABLED` | `false` | Enables Web Push only when the subject, VAPID private key, and storage key are complete. |
| `TEAMTALER_WEB_PUSH_SUBJECT` | empty | VAPID contact as `mailto:` or an absolute HTTPS URL. |
| `TEAMTALER_WEB_PUSH_VAPID_PRIVATE_KEY` | empty | Secret URL-safe VAPID P-256 private key; the public key is derived by the server. |

The media and receipt limits are editable without a restart through the System tab or `teamtaler admin system settings set`. Media must be a whole MiB value from 1 through 25 MiB; receipts must be a whole MiB value from 1 through 50 MiB. The server applies each live value plus a 1-MiB multipart reserve to the matching routes, independently of `TEAMTALER_MAX_REQUEST_BYTES`. Receipt images are decoded, dimension-checked, metadata-stripped, and normalized; bounded PDFs are validated and stored as opaque documents. Configure a reverse proxy for at least 51 MiB so it does not override the maximum receipt setting.

Group administrators configure receipt handling independently for every payment method as disabled, optional, or required. New groups start with Bank transfer without a receipt, Shopping with a required receipt, Cash and PayPal without receipts, and Other with an optional receipt. Members may select a JPEG, PNG, WebP, or PDF from the device, use a photo-library source, or create a locally processed multi-page PDF through the camera-only document scanner. Imported files remain separate from camera scan sessions. A payment keeps exactly one immutable receipt, including after reversal. The affected member and current holders of `FINANCE_MANAGEMENT` may retrieve it; storage identifiers are never exposed through the API.

The scanner prepares OpenCV locally before exposing automatic contours, rejects low-confidence and frame-edge candidates, smooths accepted corners, and keeps the overlay aligned with the actual contained camera image. Manual capture remains available when automatic detection cannot initialize and uses default editable corners unless a recent validated contour exists. The editor provides Original, optimized Color, and Grayscale modes. Color performs bounded white balancing, tonal normalization, restrained saturation, and sharpening; Grayscale performs luminance-based contrast normalization and sharpening. The editor preview and generated PDF use the same deterministic pixel implementation, so the selected mode is visible before applying it and does not depend on browser canvas-filter support.

### SMTP and email delivery

SMTP enables automatic invitation delivery, public-join email verification, password recovery, verified email changes, and optional notification email. Group and member invitations remain manually shareable through their one-time links without SMTP. Renewing an open invitation always rotates and displays a new link; if SMTP has been enabled since the invitation was created, that renewal is also queued for email delivery.

Several groups may invite the same previously unknown email address independently, including as an ordinary member or first group administrator. The first accepted invitation creates the single global TeamTaler account. Every other invitation remains valid for its own group and role set, but acceptance then requires that account's current password. If two forms are submitted concurrently, one creates the account and the other refreshes safely into existing-account mode; TeamTaler never creates duplicate accounts or combines permissions across groups.

Configure SMTP either as an environment default or from **Einstellungen → System → E-Mail (SMTP)**. The required values are:

```dotenv
TEAMTALER_SMTP_HOST=smtp.example.com
TEAMTALER_SMTP_PORT=587
TEAMTALER_SMTP_USERNAME=teamtaler@example.com
TEAMTALER_SMTP_PASSWORD=replace-with-a-secret
TEAMTALER_SMTP_FROM_ADDRESS=teamtaler@example.com
TEAMTALER_SMTP_FROM_NAME=TeamTaler
TEAMTALER_SMTP_TLS_MODE=starttls
```

Use `starttls` for explicit TLS, commonly on port 587, or `tls` for implicit TLS, commonly on port 465. The System tab and CLI prefill port 587 with `starttls` when no SMTP default exists. Plaintext SMTP is unsupported. Supplying only part of the required environment block prevents startup.

A complete environment SMTP configuration is active after startup. A configuration stored through the System tab or CLI is encrypted, starts disabled, and must send a successful test message to the current system administrator or the immutable `TEAMTALER_SMTP_TEST_RECIPIENT` override. Enable it only after the exact stored revision is marked as tested.

The System tab and local CLI can send a test message through either effective configuration source. Testing an environment configuration performs delivery without creating database revision state; testing a stored configuration also verifies its exact unchanged revision.

The disposable `make test-server` fixture always keeps the stable `admin@example.test` administrator login. When complete SMTP credentials are loaded from `.env.test-server.local`, the script routes operator-triggered SMTP test messages to `TEAMTALER_SMTP_FROM_ADDRESS` through `TEAMTALER_SMTP_TEST_RECIPIENT`; other application email flows retain their actual fixture recipients. The shared development password printed by the script remains unchanged.

Runtime SMTP targets are restricted to public network addresses by default. The exact host and port supplied by the immutable environment SMTP block remain allowed for an existing private relay. Set `TEAMTALER_SMTP_ALLOW_PRIVATE_NETWORK=true` only when system administrators must configure additional private targets and are trusted with that network access.

### Web Push notifications

TeamTaler implements the browser Push API directly with VAPID; it does not require Firebase or another notification provider. Configure Web Push through `.env`, **Settings → System → Web Push**, or the local operator CLI. A complete environment configuration needs `TEAMTALER_WEB_PUSH_ENABLED=true`, a valid VAPID subject and private key, and the separate `TEAMTALER_PUSH_STORAGE_KEY`. An explicitly enabled but incomplete environment block prevents startup.

Permission is requested only after a signed-in user selects **Enable push notifications**. Each browser installation becomes an account-owned device that can be renamed or revoked. Browser consent is reconciled only for the same account; switching accounts requires a new explicit opt-in and replaces any unknown prior browser subscription. iPhone and iPad users must first install TeamTaler on the Home Screen. Push messages deliberately contain only the group name, generic event copy, a relative route, and an opaque notification identifier; member names, products, amounts, and due dates remain behind authenticated in-app navigation.

System administrators control whether email and push channels are available. Group administrators choose the allowed event types and settlement-reminder schedule. Every member then selects email and push independently for each allowed event; selecting both produces both deliveries, while the in-app inbox remains the canonical history. Existing security, invitation, password-reset, and email-verification messages are transactional and are not optional notification events.

## System administration

`SYSTEM_ADMINISTRATOR` is a global instance role. It is separate from every group role and does not implicitly grant access to group members, bookings, catalogue data, or finances. The role can be granted or revoked only from the local CLI and never appears in web role editors.

The bootstrap account receives the role automatically on a new installation. Existing installations upgraded to the system-administration release receive no automatic promotion. Grant the first assignment locally:

```sh
docker compose exec app teamtaler admin system-admin grant \
  --email admin@example.com
```

The target account must already exist. Keep at least two active system administrators where the operating model permits it. The last active assignment cannot be revoked normally.

A system administrator without group membership can still log in and sees only System, Account, and Logout. Global administration does not widen access to group business data.

Groups created for an existing account become active immediately and assign that account only the protected group-administrator role. A group created for a new email address remains in `PROVISIONING` until its protected first-administrator invitation is accepted. TeamTaler always returns a one-time link for manual sharing; active SMTP additionally sends the same invitation by email. Archival is reversible. Permanent purge is available only after archival and requires impact review, a current version check, and the exact current group name.

## Operator CLI

Run operator commands inside the application container:

```sh
docker compose exec app teamtaler <command>
```

Commands that change SQLite directly should not be run concurrently from multiple operator shells. Scalar setting commands default to the current revision when `--revision` is omitted; automation should pass the previously read revision and use `--json` where supported. Secrets are read from a terminal or standard input and are never accepted as ordinary arguments.

### System administrator assignments

```sh
teamtaler admin system-admin list [--json]
teamtaler admin system-admin grant --email EMAIL [--json]
teamtaler admin system-admin revoke --email EMAIL [--json]
```

Example:

```sh
docker compose exec app teamtaler admin system-admin list
```

### Instance settings

```sh
teamtaler admin system settings show [--json]
teamtaler admin system settings set \
  [--revision VERSION] \
  [--instance-name NAME] \
  [--default-currency EUR] \
  [--media-upload-max-bytes BYTES] \
  [--attachment-upload-max-bytes BYTES] \
  [--public-join-enabled true|false] \
  [--maintenance-mode true|false] \
  [--maintenance-message MESSAGE] \
  [--json]
teamtaler admin system settings reset \
  --key KEY [--key KEY ...] \
  [--revision VERSION] [--json]
```

Reset keys are:

- `instance.name`
- `instance.default_currency`
- `media.upload_max_bytes`
- `attachment.upload_max_bytes`
- `access.public_join_enabled`
- `maintenance.enabled`
- `maintenance.message`

Examples:

```sh
docker compose exec app teamtaler admin system settings show
docker compose exec app teamtaler admin system settings set \
  --instance-name "My Club" \
  --default-currency EUR
docker compose exec app teamtaler admin system settings reset \
  --key maintenance.enabled \
  --key maintenance.message
```

### SMTP

```sh
teamtaler admin system smtp show [--json]
teamtaler admin system smtp set \
  [--revision VERSION] \
  [--enabled true|false] \
  [--host HOST] [--port PORT] \
  [--tls-mode starttls|tls] \
  [--username USER] \
  [--from-address EMAIL] [--from-name NAME] \
  [--password-stdin] [--json]
teamtaler admin system smtp test [--email ADMIN_EMAIL] [--json]
teamtaler admin system smtp reset
```

Typical stored-SMTP workflow:

```sh
docker compose exec app teamtaler admin system smtp set \
  --host smtp.example.com \
  --port 587 \
  --tls-mode starttls \
  --username teamtaler@example.com \
  --from-address teamtaler@example.com \
  --from-name TeamTaler \
  --password-stdin

docker compose exec app teamtaler admin system smtp test \
  --email admin@example.com

docker compose exec app teamtaler admin system smtp set \
  --enabled true
```

When exactly one active system administrator exists, `smtp test` may omit `--email`. With multiple assignments, select the audited recipient explicitly.

### Web Push

```sh
teamtaler admin system web-push show [--json]
teamtaler admin system web-push generate [--revision VERSION] [--confirm-rotation] [--json]
teamtaler admin system web-push set [--revision VERSION] [--enabled true|false] [--subject SUBJECT] [--private-key-stdin] [--confirm-rotation] [--json]
teamtaler admin system web-push test [--email ADMIN_EMAIL] [--subscription-id DEVICE_ID] [--json]
teamtaler admin system web-push reset [--revision VERSION] [--json]
```

Private key input is accepted only from standard input or an interactive terminal. Replacing an existing VAPID identity requires `--confirm-rotation`; a rotation advances the public key identifier, and browsers reconcile and replace subscriptions on their next authenticated visit. When exactly one active system administrator exists, `web-push test` may omit `--email`.

### Group lifecycle

```sh
teamtaler admin system groups list [--actor-email ADMIN_EMAIL] [--json]
teamtaler admin system groups create \
  --name NAME \
  --initial-admin-email EMAIL \
  [--currency EUR] \
  [--actor-email ADMIN_EMAIL] [--json]
teamtaler admin system groups archive \
  --id GROUP_ID --revision VERSION \
  [--actor-email ADMIN_EMAIL] [--json]
teamtaler admin system groups restore \
  --id GROUP_ID --revision VERSION \
  [--actor-email ADMIN_EMAIL] [--json]
teamtaler admin system groups purge \
  --id GROUP_ID --revision VERSION \
  [--confirm-name NAME] \
  [--actor-email ADMIN_EMAIL] [--json]
```

Read the current group ID, status, and version with `groups list` before a lifecycle mutation. When several active system administrators exist, `--actor-email` identifies the audit actor.

When `groups create` provisions a previously unknown address, the command prints the one-time invitation link. JSON output includes `group`, `acceptUrl`, `emailDeliveryStatus`, and the exact `expiresAt` timestamp. Share the link manually; when effective SMTP is active, TeamTaler also queues the same invitation for email delivery.

Interactive purge prompts for the exact group name. Non-interactive use requires `--confirm-name`. Purge succeeds only for an archived group at the supplied version and permanently removes its active application data. Review the web deletion-impact report and create a verified off-host backup first.

### General operations

```sh
teamtaler serve
teamtaler version
teamtaler healthcheck [--url URL] [--timeout DURATION]
teamtaler backup create --output FILE.tar.gz
teamtaler restore --input FILE.tar.gz [--force]
```

## Backup, restore, and upgrades

Create an online application-consistent backup from the Compose deployment:

```sh
./scripts/backup.sh
```

The resulting archive contains a consistent SQLite snapshot, referenced images and payment receipts, a format manifest, and SHA-256 checksums. Copy completed archives away from the Docker host and encrypt them with an external backup system. TeamTaler does not schedule backups or enforce retention.

Restore only while the application is stopped. A restore validates archive paths, sizes, checksums, image and receipt content addresses, SQLite integrity, foreign keys, exact reference inventories, and migration compatibility before replacing data. The exact procedure, including the one-off Compose command and recovery directory, is documented in [deploy/README.md](deploy/README.md#restore).

Before every upgrade:

1. Read [CHANGELOG.md](CHANGELOG.md).
2. Create and copy an off-host backup.
3. Verify that the archive can be opened and that a restore procedure is available.
4. Set `TEAMTALER_VERSION` to the reviewed release.
5. Pull and restart the application:

   ```sh
   docker compose pull app
   docker compose up -d app
   ```

6. Verify readiness, login, representative balances, images, payment receipts, and audit history.

Migrations are forward-only. Rollback requires the previous image together with a compatible pre-upgrade backup. Do not run an older binary against a database already migrated by a newer release. Automatic unreviewed container updates are not recommended for financial data.

## Monitoring and logs

```sh
docker compose ps
docker compose logs --tail=200 app
docker compose exec app teamtaler healthcheck \
  --url http://127.0.0.1:8080/health/ready
```

- `GET /health/live` confirms that the HTTP process responds.
- `GET /health/ready` confirms that startup and a database ping succeed.
- Compose rotates application logs at 10 MiB and retains three files by default.

Monitor container restarts, readiness, reverse-proxy TLS expiry, data-volume disk usage, backup results, and the host backup directory with external tooling. TeamTaler does not expose Prometheus metrics or built-in alert delivery.

## Troubleshooting

### The container is unhealthy

Inspect `docker compose logs app`. Common causes are an incomplete SMTP environment block, an invalid `TEAMTALER_PUBLIC_URL`, an inaccessible data volume, or a database created by a newer TeamTaler version.

### Login works, but mutations fail

Confirm that `TEAMTALER_PUBLIC_URL` exactly matches the browser origin and that the reverse proxy preserves `Origin`, cookies, and `X-CSRF-Token`.

### Client addresses or rate limits are incorrect

Confirm the direct peer address seen by TeamTaler. Configure only that proxy address in `TEAMTALER_TRUSTED_PROXY_CIDRS`; do not trust all container networks as a shortcut.

### Uploads fail with HTTP 413

Check the effective media or receipt limit in the System tab. If a reverse proxy is used, its body limit must allow at least 51 MiB for the maximum 50 MiB receipt setting plus multipart overhead. `TEAMTALER_MAX_REQUEST_BYTES` applies only to ordinary non-upload API requests.

### The System tab is missing after an upgrade

Existing accounts are not promoted automatically. Grant `SYSTEM_ADMINISTRATOR` locally with `teamtaler admin system-admin grant --email EMAIL`, then reload the session.

### SMTP cannot be enabled

Verify that the configuration is complete, TLS mode and port match the relay, `TEAMTALER_EMAIL_TOKEN_KEY` is present, and the current stored revision has sent a successful test message. For a private relay, review the host-only private-network policy before enabling it.

## Further documentation

- [Deployment and operations](deploy/README.md) — reverse proxy layouts, storage, backup, restore, upgrade, and monitoring procedures.
- [Security policy](SECURITY.md) — reporting, security boundaries, and operational hardening.
- [Architecture](ARCHITECTURE.md) — modules, data flows, persistence, migrations, UI constraints, dependencies, and extension policy.
- [OpenAPI specification](api/openapi.yaml) — complete HTTP contract.
- [Contributing](CONTRIBUTING.md) — development environment, testing, branch workflow, and documentation ownership.
- [Changelog](CHANGELOG.md) — release changes and migration notes.

## License

TeamTaler is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Copyright © 2026 TeamTaler contributors.
