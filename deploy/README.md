# Deployment and operations

TeamTaler runs as one application container behind an existing HTTPS reverse proxy. The container serves the API and compiled frontend and stores its SQLite database, normalized managed images, payment receipts, and backup/restore staging data in one persistent volume.

## Supported topology

- Run exactly one TeamTaler application replica.
- Keep `/var/lib/teamtaler` on a local filesystem. Do not use NFS, SMB, or a replicated network volume for SQLite.
- Terminate TLS at a reverse proxy and keep TeamTaler on a private or loopback HTTP connection.
- Set `TEAMTALER_PUBLIC_URL` to the exact browser origin, including scheme and any non-default port.
- Restrict `TEAMTALER_TRUSTED_PROXY_CIDRS` to the direct proxy peers. Do not trust an entire network unless every host on it is trusted to supply client-address headers.

Leave `TEAMTALER_TRUSTED_PROXY_CIDRS` empty until the connection source has been identified. For a proxy container, inspect the dedicated proxy network and trust only that container's stable address (`/32` for IPv4 or `/128` for IPv6). For a host proxy connecting through a published Docker port, the application may see the Docker bridge gateway rather than `127.0.0.1`; inspect the TeamTaler network and verify the observed peer before adding its single-address CIDR. With no trusted CIDR, forwarded addresses are ignored and login throttling treats the proxy peer as the client.

## Network layouts

### Reverse proxy on the Docker host

The default `compose.yaml` publishes TeamTaler as:

```text
127.0.0.1:8080 -> app:8080
```

The host port can be changed with `TEAMTALER_HOST_PORT`. Configure the host proxy to use `http://127.0.0.1:8080` as its upstream. The examples in `deploy/proxy/Caddyfile` and `deploy/proxy/nginx.conf` use this layout.

The Nginx file is a location/server template and intentionally omits deployment-specific certificate/key directives. The Caddy example relies on Caddy's configured certificate automation.

### Reverse proxy in Docker

Create or reuse an external network and attach TeamTaler:

```sh
docker network create proxy
docker compose -f compose.yaml -f deploy/compose.proxy-network.yaml up -d
```

Set `TEAMTALER_PROXY_NETWORK` when the external network is not named `proxy`. The override removes the host port mapping. Attach the proxy to the same network and use `http://app:8080` as the upstream instead of `127.0.0.1`.

`deploy/proxy/traefik-labels.yaml` is a Compose override fragment for a Traefik deployment. Adapt its hostname, entrypoint, and certificate resolver before combining it with the main Compose file.

## Proxy requirements

The proxy must:

- forward the original method, path, query, request body, cookies, `Origin`, and `X-CSRF-Token` header;
- append the client address to `X-Forwarded-For` when per-client throttling through a trusted proxy is required;
- allow request bodies of at least 51 MiB so the live receipt-upload setting can use its full 50 MiB range plus multipart reserve;
- use timeouts longer than the application's 30-second request read/write limits.

Preserving `Host` and setting `X-Forwarded-Proto` are recommended conventional proxy behavior and are shown in the templates. The current server uses the configured public URL—not forwarded scheme/host values—as its canonical origin and secure-cookie signal. It consumes `X-Forwarded-For` only when the direct connection originates from a configured trusted CIDR.

## TLS

TLS is outside the TeamTaler process; the application does not generate or renew certificates.

- Internet-facing deployments should use a publicly trusted ACME certificate.
- Private deployments may use a proxy-managed private CA, but its root certificate must be installed on every client.
- Use an HTTPS `TEAMTALER_PUBLIC_URL` in production so the session and CSRF cookies receive the Secure attribute and HSTS is enabled.

## Initial start

Create `.env`, set the public URL and proxy CIDRs, and start a pinned release:

```sh
cp .env.example .env
${EDITOR:-vi} legal/IMPRESSUN.md legal/PRIVACY.md
docker compose pull app
docker compose up -d app
```

For a source build, replace those two commands with:

```sh
docker compose up -d --build
```

Bootstrap exactly once:

```sh
docker compose exec app teamtaler admin bootstrap \
  --email admin@example.com \
  --display-name "Team Admin" \
  --group "My Team"
```

Bootstrap creates the first local account, assigns its global `SYSTEM_ADMINISTRATOR` role, and creates the initial active group with that account as its protected group administrator. Upgrades never promote an existing account implicitly. For an existing installation, grant the first global role locally:

```sh
docker compose exec app teamtaler admin system-admin grant \
  --email admin@example.com
```

Verify startup:

```sh
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:8080/health/ready
```

Adjust the readiness URL when `TEAMTALER_HOST_PORT` is not `8080`.

## Instance administration

The host remains authoritative for the public URL, listener, trusted proxy CIDRs, database/data/web paths, container port and image, `TEAMTALER_EMAIL_TOKEN_KEY`, and `TEAMTALER_MAX_REQUEST_BYTES`. Changing those environment values requires a container restart. The environment also provides defaults for the live instance settings:

```text
TEAMTALER_INSTANCE_NAME=TeamTaler
TEAMTALER_DEFAULT_CURRENCY=EUR
TEAMTALER_TIMEZONE=Europe/Berlin
TEAMTALER_MEDIA_UPLOAD_MAX_BYTES=5242880
TEAMTALER_ATTACHMENT_UPLOAD_MAX_BYTES=15728640
TEAMTALER_PUBLIC_JOIN_ENABLED=true
TEAMTALER_MAINTENANCE_MODE=false
TEAMTALER_MAINTENANCE_MESSAGE=
```

Compose also mounts `./legal` read-only at `/etc/teamtaler/legal`. The application reads `IMPRESSUN.md` and `PRIVACY.md` on demand whenever no database override exists, so an atomic host-side edit becomes visible without a restart. Both files are bounded UTF-8 Markdown templates and must be completed with the actual operator, controller, and processing details before public access is enabled. A legal-document override saved under **Settings → System → Legal content** takes precedence until that document is reset.

A system administrator may persist versioned overrides from the System settings tab or the local `teamtaler admin system` CLI. Persisted values take precedence and become effective without restarting; reset removes the override and reveals the current environment or code default. Media and receipt endpoints derive their request ceiling from their respective live setting and are not capped by `TEAMTALER_MAX_REQUEST_BYTES`; that variable remains the ordinary API request ceiling. Configure an optional reverse proxy to accept at least 51 MiB so the full 50-MiB receipt range plus multipart reserve remains usable. Image decoder and normalized-output protections remain fixed.

Persisted SMTP credentials require `TEAMTALER_EMAIL_TOKEN_KEY`. The application derives a separate encryption key for the SMTP password and never returns it from the API or CLI. Every changed persisted SMTP revision starts disabled, must successfully send a test message to the current system administrator, and may be enabled only while that exact revision remains tested. Existing complete environment SMTP defaults remain available without this migration-time test. Email workers re-read effective settings before each job and pause without consuming attempts while SMTP is disabled or maintenance mode is active.

Web Push requires the independent `TEAMTALER_PUSH_STORAGE_KEY`, a VAPID subject, and a VAPID private key. Generate and back up the storage key separately from `TEAMTALER_EMAIL_TOKEN_KEY`; generate or rotate the VAPID identity through `teamtaler admin system web-push generate`. An explicitly enabled but incomplete environment block fails startup. A database override without the immutable storage key remains inactive and resettable. Rotation changes the public key identifier and causes signed-in browsers to replace their subscriptions on the next visit.

Browser push services are external HTTPS destinations selected by the browser. The application rejects credentials, redirects, private and reserved network addresses, and DNS rebinding before delivery. Outbound firewall policy must allow public TCP 443 to the push services used by supported browsers. Web Push on iOS and iPadOS requires an installed Home Screen web app; browser-tab use alone cannot receive push there.

Runtime SMTP targets resolve through a dial-time network policy. Public addresses are allowed, while private, loopback, link-local, carrier-grade NAT, benchmarking, and other non-public ranges are blocked to prevent the settings UI from becoming an internal network probe. The exact relay host and port supplied through the immutable SMTP environment block remain allowed for existing private relay deployments. Set the host-only `TEAMTALER_SMTP_ALLOW_PRIVATE_NETWORK=true` switch only when administrators are trusted to configure other private relays; DNS is still resolved and pinned to the checked address for each connection.

System roles are independent of group membership and can be granted, listed, or revoked only through the local CLI. The last active system administrator cannot be revoked normally. A system administrator who does not belong to any group can still log in and use the System and Account views; the role itself does not grant access to group business data.

If a `PROVISIONING` group's first-administrator invitation expires or must be invalidated, use the renewal action in the System workspace. It requires the group's current ETag, atomically replaces the invitation and pending delivery, and returns a new manually shareable link; active SMTP additionally queues email delivery. All prior links remain invalid. Restoring an archived provisioning group never re-enables an older invitation, so issue a fresh one explicitly after restoration when onboarding must continue.

Group archive is reversible and blocks regular access immediately. Permanent purge requires an archived group, the current optimistic version, and exact group-name confirmation in the web interface or local CLI. Review the deletion-impact counts and create a verified backup before purging. The purge removes group-owned rows and unreferenced managed media from the active application data, retaining only a minimal global deletion receipt. It cannot erase copies already present in application archives, off-host backups, volume snapshots, or storage-device remanence; delete those copies according to the deployment's retention policy.

## Backup

Create an online application-consistent archive:

```sh
./scripts/backup.sh
```

The script asks the running application container to write:

```text
/var/lib/teamtaler/backups/teamtaler-YYYYMMDDTHHMMSSZ.tar.gz
```

copies that completed file to:

```text
./backups/teamtaler-YYYYMMDDTHHMMSSZ.tar.gz
```

The application first creates a SQLite `VACUUM INTO` snapshot, then includes every managed image and payment receipt referenced by the snapshot together with a manifest containing SHA-256 checksums. Archive creation uses temporary files and publishes the completed archive with mode `0600`. After a successful host copy, the helper removes the source archive from the named volume. If the copy fails, it deliberately leaves the source path in the volume and reports that path for recovery.

Copy backups to storage outside the Docker host and encrypt them. TeamTaler does not schedule backups, enforce retention, upload off-site copies, or encrypt archives. A sample policy is seven daily, four weekly, and twelve monthly archives, but the required schedule and retention must follow the deployment's recovery objectives.

Test restore regularly and before relying on a new application release.

## Restore

The standard Compose restore workflow uses:

- `TEAMTALER_DATA_DIR=/var/lib/teamtaler`;
- `TEAMTALER_DATABASE_PATH=/var/lib/teamtaler/teamtaler.db`;
- the archive is available in the host's private `./backups` directory.

The restore implementation installs the archive's internal `teamtaler.db` snapshot at the configured `TEAMTALER_DATABASE_PATH`. A custom database filename is supported when the path is a direct child of `TEAMTALER_DATA_DIR`; paths outside the data directory or in nested subdirectories are rejected so recovery and installation stay on one mounted filesystem.

1. Record the exact TeamTaler image version currently deployed.
2. Copy the selected archive into `./backups` and restrict access to it.
3. Stop the application:

   ```sh
   docker compose stop app
   ```

4. Run restore in a one-off container with the same compatible image:

   ```sh
   docker compose run --rm --no-deps \
     -v "$PWD/backups:/restore:ro" \
     app restore \
     --input "/restore/teamtaler-YYYYMMDDTHHMMSSZ.tar.gz" \
     --force
   ```

5. Start TeamTaler:

   ```sh
   docker compose up -d app
   ```

6. Verify readiness, login, representative member balances, a closed statement, managed-image and payment-receipt loading, notifications, and audit history.

Restore accepts only regular files at the canonical database, manifest, managed-image, and receipt paths and limits expanded content to 2 GiB. Before replacing data it validates manifest structure and timestamps, file checksums, content addresses, SQLite integrity, foreign keys, supported migration versions, and exact correspondence between database references and archived files.

With `--force`, the configured database file, its WAL/SHM files, and the `images` and `attachments` directories move to a timestamped `.restore-backup-*` directory under the data volume. Keep that recovery directory until post-restore verification succeeds, then remove it deliberately to reclaim space.

Never unpack an untrusted archive directly into the volume. Never run restore while the application is serving traffic.

## Upgrade

1. Read the release notes and migration warnings.
2. Create a backup, copy it off-host, and verify that the archive can be opened.
3. Set `TEAMTALER_VERSION` in `.env` to a reviewed semantic version.
4. Pull and restart:

   ```sh
   docker compose pull app
   docker compose up -d app
   ```

5. Wait for readiness and perform the same functional checks used after restore.
6. Retain the pre-upgrade archive and previous image until the new version is accepted.

Migrations are forward-only. Do not start an older binary against a database opened and migrated by a newer binary. Rollback means stopping the application, selecting the previous image, and restoring the matching pre-upgrade archive.

Automatic unreviewed container updates are not recommended for financial data.

## Monitoring

- `GET /health/live` returns `{"status":"ok"}` when the HTTP process responds.
- `GET /health/ready` returns `{"status":"ready"}` after a successful database ping. Startup has already applied or validated migrations before the server begins listening.
- The Compose health check calls the readiness URL through `teamtaler healthcheck`.
- Application logs contain structured key-value request metadata. Compose rotates `json-file` logs at 10 MiB and retains three files by default.

TeamTaler does not expose Prometheus metrics, distributed traces, or built-in alert delivery. Monitor container restarts, readiness, disk usage for the data volume and host backup directory, failed-copy archives left in the volume, backup job results, and reverse-proxy TLS expiry with external tooling.
