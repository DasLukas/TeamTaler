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
- Stable permission-key enforcement for group administration, role management, finance, catalog, booking activity, own-account payments, own booking creation, booking reversal, third-party booking, member-directory reads, and group-statistic reads.
- Credentialless temporary-guest identity, privacy-minimized booking data, and history-preserving login claim boundaries.
- Protected role administration and the invariant that every group retains an active assignment of its reserved group-administrator role.
- Authentication sessions, invitation links, public join links, verified registrations, and CSRF protection.
- Append-only financial corrections and auditable administrative changes.
- Image parsing and local file storage.
- Trusted reverse proxy headers and canonical origin validation.
- Backup archive validation and upgrade safety.

A person with unrestricted access to the host, container volume, or SQLite file can read or change application data. TeamTaler does not claim tamper resistance against a compromised host administrator. Operators are responsible for host hardening, TLS configuration, encrypted offsite backups, and access to deployment secrets.

Authorization is additive: a membership's effective permissions are the union of grants in all assigned roles. There are no direct member exceptions and no deny grants. `VOID_ANY_BOOKING` implies `VOID_OWN_BOOKING` and `VIEW_ALL_BOOKING_ACTIVITY`; `BOOK_FOR_OTHERS` implies `VIEW_MEMBER_DIRECTORY`. Clients must use the server-provided effective grants and capabilities instead of recreating implication logic from role names. Group, category, and product scope shapes are tenant-bound in storage, but v1 accepts only group-wide grants. Mutation requests containing category or product scopes are rejected until resource-specific enforcement is implemented.

`CREATE_OWN_BOOKING`, `BOOK_FOR_OTHERS`, and `BOOK_FOR_GUESTS` authorize independent target classes. Self-booking can charge only the authenticated membership. Booking for others can charge only credentialed foreign memberships, requires a reason, and implies `VIEW_MEMBER_DIRECTORY`. Booking for guests can charge existing or newly created credentialless memberships, requires no reason, and grants no directory access. A mixed batch must satisfy every permission represented by its targets. It revalidates current credentials, tenant ownership, active state, display names, product version, price, and open period before inserting any identity or accounting row. Guest identities, memberships, bookings, paired ledger entries, notifications, audit records, and the request-hash-bound idempotency result commit together, preventing partial batches, cross-group substitution, and duplicate guests on retry. Existing IDs and new names share a maximum of 100. Active temporary-guest names are case-insensitively unique; a `409` may disclose only the conflicting membership ID to an authorized guest booker so reuse remains explicit and never becomes an implicit merge.

A temporary guest remains a normal membership backed by a required user reference, but that user row has both email and password hash null under a database constraint. Authentication requires real credentials, so the identity cannot log in or receive a session. Synthetic addresses and placeholder passwords are forbidden. Credentialless temporary guests are the sole active-membership exception to the minimum-role rule and deliberately have no grants. Roles may be prepared only through an open claim invitation and are applied exactly when credentials are established. Every login-enabled active membership and pending invitation retains at least one explicit role. Notification delivery may retain an in-app event for the stable membership, but it never queues email while the address is null. Period statements preserve a nullable close-time email without weakening ledger or statement immutability.

`VIEW_MEMBER_DIRECTORY` protects membership email, role, and effective-grant data. `VIEW_GROUP_STATISTICS` protects anonymous group category totals; without it the dashboard returns an empty aggregate array. The group outstanding amount remains independently gated by `FINANCE_MANAGEMENT`. `/booking-context` is a separate minimization boundary: it returns the actor's own balance and only membership ID, display name, optional avatar, and derived guest status for allowed targets. Booking activity carries server-resolved actor and target display names and therefore does not need to fetch the protected directory.

The reserved `GROUP_ADMINISTRATOR` role has the fixed name `Group administrator`, cannot be deleted, and cannot lose `GROUP_ADMINISTRATION` or `ROLE_MANAGEMENT`. At least one active membership must retain an assignment of that exact role; a custom role containing `GROUP_ADMINISTRATION` does not satisfy the invariant. `MEMBER`, `FINANCE_MANAGER`, and `CATALOG_MANAGER` are editable starter roles with no special security status. Creating or modifying ordinary roles requires `ROLE_MANAGEMENT`. Changing the administrator grant or the reserved administrator role additionally requires `GROUP_ADMINISTRATION`; assigning the reserved role requires `GROUP_ADMINISTRATION`, while assigning another role containing administrator access requires both permissions.

The group default role is a convenience default for future invitations, not an implicit permanent assignment. It is tenant-bound by foreign key, cannot be deleted while selected, and cannot contain `GROUP_ADMINISTRATION`. The same restriction is rechecked when settings or grants change, preventing CSV fallback from silently becoming an administrative privilege-escalation path.

Long-term guests have no special security classification. They are credentialed accounts governed by ordinary, additive roles and may use any safe default role. Temporary-guest creation is authorized only by `BOOK_FOR_GUESTS`; there is no feature switch, guest role, role-name heuristic, or settings endpoint.

Temporary-guest rename, archive, and claim creation require `GROUP_ADMINISTRATION`. A claim targets only an active credentialless guest, requires at least one regular role, and permits at most one open invitation. Without `ROLE_MANAGEMENT`, the only permitted selection is exactly the current safe default role. Other role sets require `ROLE_MANAGEMENT`, and administrator-capable roles retain their existing protected checks. Acceptance consumes the token once, preserves the membership and every accounting reference, attaches credentials or an authenticated existing identity, rejects a conflicting group membership, clears the temporary name key, and assigns exactly the invitation's roles.

One reusable public join link may be enabled per group only by `GROUP_ADMINISTRATION` and only while complete TLS-secured SMTP delivery and authenticated token encryption are configured. Its random secret is hashed for lookup and separately encrypted for administrator recovery; API request paths and server logs never contain it because browsers keep it in the URL fragment. Finite lifetimes range from one hour to 365 days. Unlimited links are an explicit administrator choice and can be rotated or disabled immediately. Both operations invalidate the older URL and QR code plus every pending verification proof in the same transaction.

Existing accounts must authenticate before a public join. New accounts receive a one-hour, single-use mailbox proof through the leased encrypted outbox; no membership is created before successful verification. Start and resend responses do not reveal whether an email address already belongs to an account or registration. Acceptance assigns the group's current safe default role rather than any role encoded by the link or client. Archived memberships are reactivated only after their former role set is replaced by that default, preventing retained privilege from an earlier membership.

Role and assignment mutations use strong version ETags. Services reload effective permissions and enforce the last-administrator invariant within the same serialized SQLite write transaction as the mutation, preventing stale sessions and concurrent demotions from creating a lockout. Permission results are not cached across requests. Frontend route guards and hidden controls are usability measures only and are never authorization boundaries.

## Operational guidance

- Expose TeamTaler only through HTTPS in production.
- Configure the narrowest possible trusted proxy CIDRs.
- Never place the SQLite database on NFS or SMB.
- Keep the data volume, backups, and reverse proxy credentials private.
- Run one TeamTaler application replica per database.
- Back up before every upgrade and test restores regularly.
- Review role assignments after migration `0017`; legacy category-specific grants are intentionally removed and must not be replaced with broader group-wide grants without an explicit access review.
- Before migration `0021`, verify a backup and update strict API consumers for nullable membership/statement email and the `isTemporaryGuest` field. The migration grants the two new read permissions to every existing role solely to preserve prior access and grants `BOOK_FOR_GUESTS` only to existing administrator roles; review and narrow those grants deliberately after rollout if needed.
- Treat `BOOK_FOR_GUESTS` as authority to create persistent accounting identities. Review audit events and revoke it from roles that do not need temporary-guest booking.
- Prefer finite public join-link lifetimes, rotate a link after broad or unintended distribution, and disable it as soon as open enrollment ends.
- Do not log or share session cookies, invitation URLs, public join URLs, mailbox verification URLs, password reset material, or data archives.
