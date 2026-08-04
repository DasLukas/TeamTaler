# Deployment and operations

TeamTaler runs as one application container behind an existing HTTPS reverse proxy. The container serves the API and compiled frontend and stores its SQLite database, normalized product images and group logos, and backup/restore staging data in one persistent volume.

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
- allow request bodies large enough for `TEAMTALER_MAX_REQUEST_BYTES`;
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

Verify startup:

```sh
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:8080/health/ready
```

Adjust the readiness URL when `TEAMTALER_HOST_PORT` is not `8080`.

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

The application first creates a SQLite `VACUUM INTO` snapshot, then includes every image referenced by the snapshot and a manifest containing SHA-256 checksums. Archive creation uses temporary files and publishes the completed archive with mode `0600`. After a successful host copy, the helper removes the source archive from the named volume. If the copy fails, it deliberately leaves the source path in the volume and reports that path for recovery.

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

6. Verify readiness, login, representative member balances, a closed statement, image loading, notifications, and audit history.

Restore accepts only regular files at the database, manifest, and image paths and limits expanded content to 2 GiB. Before replacing data it validates manifest structure and timestamps, file checksums, image content addresses, SQLite integrity, foreign keys, supported migration versions, and exact correspondence between database image references and archived images.

With `--force`, the configured database file, its WAL/SHM files, and the `images` directory move to a timestamped `.restore-backup-*` directory under the data volume. Keep that recovery directory until post-restore verification succeeds, then remove it deliberately to reclaim space.

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
