# Security policy

## Supported versions

Security fixes are provided for the latest stable minor release. Operators should run a pinned release image and apply supported updates after creating a verified backup.

| Version | Supported |
| --- | --- |
| Latest stable release | Yes |
| Older releases | No |
| Development branches | No production support |

## Reporting a vulnerability

Do not disclose an unpatched vulnerability in a public issue, pull request, discussion, or chat.

Use the repository's private GitHub Security Advisory reporting flow. Include:

- Affected version or commit.
- The smallest reproducible scenario.
- Expected and observed behavior.
- Security impact and required privileges.
- Any suggested mitigation.

Maintainers will acknowledge a complete report within seven calendar days, validate the finding, coordinate a fix and release, and credit the reporter when requested. Please allow a reasonable remediation window before public disclosure.

## Security model

TeamTaler treats the following as security boundaries:

- Group isolation and object-level authorization.
- Administrator, finance, catalog, and category permission enforcement.
- Authentication sessions, invitation links, and CSRF protection.
- Append-only financial corrections and auditable administrative changes.
- Image parsing and local file storage.
- Trusted reverse proxy headers and canonical origin validation.
- Backup archive validation and upgrade safety.

A person with unrestricted access to the host, container volume, or SQLite file can read or change application data. TeamTaler does not claim tamper resistance against a compromised host administrator. Operators are responsible for host hardening, TLS configuration, encrypted offsite backups, and access to deployment secrets.

## Operational guidance

- Expose TeamTaler only through HTTPS in production.
- Configure the narrowest possible trusted proxy CIDRs.
- Never place the SQLite database on NFS or SMB.
- Keep the data volume, backups, and reverse proxy credentials private.
- Run one TeamTaler application replica per database.
- Back up before every upgrade and test restores regularly.
- Do not log or share session cookies, invitation URLs, password reset material, or data archives.
