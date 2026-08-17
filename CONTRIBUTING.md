# Contributing to TeamTaler

Thank you for helping improve TeamTaler. Contributions must preserve its accounting guarantees, group isolation, lightweight operation, accessibility, and approved visual system.

## Language

All source code, code comments, documentation, commit messages, issue text, and pull request text must be written in English. User-facing German copy belongs in the translation catalog rather than directly in reusable components.

## Documentation ownership

Every document has one primary audience and must remain within that boundary:

- `README.md` is the canonical first-run and operations guide for a production instance administrator. It must remain understandable without repository or architecture knowledge and contain the short product scope, supported production requirements, installation, host and runtime configuration, operator CLI, routine backup/upgrade guidance, health checks, and basic troubleshooting.
- `deploy/README.md` contains detailed deployment topology, reverse-proxy, storage, backup, restore, upgrade, and monitoring procedures.
- `ARCHITECTURE.md` contains module boundaries, internal data flows, persistence and migration details, authorization design, UI architecture constraints, dependencies, development-runtime topology, and extension policy.
- `DESIGN.md` is the durable source of truth for visual language, reusable interaction patterns, button anatomy, and responsive component behavior.
- `SECURITY.md` contains vulnerability reporting, security properties, trust boundaries, and operational hardening.
- `CONTRIBUTING.md` contains local development, test fixtures, quality gates, branch workflow, and contributor conventions.
- `CHANGELOG.md` contains release-specific behavior and migration notes.
- `api/openapi.yaml` contains the complete public HTTP contract.

Do not turn `README.md` into a member user manual, feature-by-feature UI walkthrough, repository map, architecture specification, migration ledger, development fixture guide, design rationale, or AI/agent instruction surface. Codex or other agent-environment mechanics belong in repository-scoped agent instructions or, when they describe the shared development runtime, in `ARCHITECTURE.md`. When a change crosses audiences, update each owning document with the smallest information needed by that audience instead of duplicating one long explanation across files.

## Development setup

1. Install Go 1.26.x, Node.js 24.x, and npm 11.x. If you use NVM, run `nvm use` from the repository root.
2. Run `make install`.
3. Start the API with `TEAMTALER_PUBLIC_URL=http://127.0.0.1:5173 make dev-backend`.
4. Start the frontend with `make dev-frontend`.
5. Run `make verify` before opening a pull request.

Keep the checkout on a local, non-cloud-synchronized filesystem. In particular, do not place `node_modules` under iCloud Drive, Dropbox, OneDrive, or a similar file provider: conflict copies and on-demand downloads can corrupt package trees or prevent Vitest workers from starting. If the generated dependency tree becomes inconsistent, restore it from the committed lockfile with `cd web && npm ci` rather than editing or copying individual package files.

Vite listens on `127.0.0.1:5173`, proxies `/api` to `127.0.0.1:8080`, and requires the backend public URL to match the browser-facing Vite origin so mutation-origin validation succeeds.

For frontend-only visual development, copy `web/.env.example` to `web/.env.local` and set `VITE_DEMO_MODE=true`. Demo transport and sample assets are available only in Vite development mode and are excluded from production builds.

### Disposable full-stack test server

Run the real API, Vite frontend, and an isolated seeded SQLite database with:

```sh
make test-server
```

The runtime binds only to loopback and deletes its temporary database when stopped. The fixture contains `TeamTaler Demo Club` and `TeamTaler Weekend Club`. Every seeded login uses `TeamTaler-Test-2026!`:

- `admin@example.test` is a protected group administrator in both groups.
- `jonas@example.test` has finance and catalogue management roles.
- `marie@example.test` has ordinary member, self-payment, and third-party booking access.
- `lena@example.test` belongs to both groups with deliberately mixed booking permissions.
- `noah@example.test` belongs only to `TeamTaler Weekend Club`.
- `systemonly@example.test` is a global system administrator without group membership.

Optional SMTP delivery is read from the ignored `.env.test-server.local` file. The test-server script accepts only the documented SMTP variables and never evaluates the file as shell code. Incomplete credentials disable delivery without blocking startup.

The Codex **Start test server** environment action calls the same `make test-server` target. Its process ownership, readiness probes, fixture composition, and cleanup boundaries are documented in [ARCHITECTURE.md](ARCHITECTURE.md#development-test-runtime).

## Branch workflow

- Create feature and fix branches from `dev`.
- Keep each branch focused on one coherent change.
- Open a pull request back to `dev` and use squash merge after required checks pass.
- Releases merge `dev` into `main` and receive a semantic version tag.
- Hotfixes start from `main` and must be merged back to `dev` after release.

Do not force-push shared branches or commit generated runtime data, local configuration, databases, uploads, backups, credentials, or tokens.

## Engineering requirements

- Keep domain modules independent and avoid duplicated business rules.
- Put authorization in server-side policy functions and test the complete role matrix.
- Use integer minor units for money. Never use floating-point arithmetic for financial values.
- Never delete or overwrite posted financial history. Use linked reversal commands.
- Add a forward migration and integration test for every schema change.
- Keep API changes documented and backward compatible within a version.
- Document every exported Go symbol, public TypeScript interface, public component, and central function with complete GoDoc or JSDoc.
- Update the owning documents from the documentation matrix whenever operator setup, configuration, CLI behavior, modules, APIs, data flow, dependencies, security, or deployment behavior changes. Only operator-visible information belongs in `README.md`.
- Preserve keyboard operation, accessible names, visible focus, semantic markup, and WCAG AA contrast.
- Preserve the accepted true-white/navy/teal TeamTaler design system. New component families require a documented product need.
- Use the shared action components and follow the icon, text-label, responsive-compaction, and accessibility rules in `DESIGN.md`.
- Treat regular-member workflows as mobile-first: design and verify narrow phone layouts before adding desktop enhancements.
- Preserve the standard fixed-price self-booking interaction budget: after a product is visible, selection and confirmation are the only required actions unless the command requires additional data.
- Document the product, accounting, security, or safety reason for every new step, dialog, or confirmation added to the standard booking path.

## Tests

Changes should add tests at the lowest reliable level and include integration or end-to-end coverage when boundaries are involved. Security-sensitive changes require negative tests.

At minimum, pull requests must pass:

- Go formatting, vet, unit, integration, and race tests.
- Frontend lint, typecheck, unit tests, and production build.
- Browser end-to-end tests for affected workflows.
- Mobile-viewport interaction-count verification for every booking-flow change.
- Migration and container smoke tests when persistence or deployment changes.
- Accessibility and visual regression checks for user-interface changes.

Run the standard formatter, linter, static analysis, unit tests, and production builds with:

```sh
make verify
```

Run the stricter race-enabled verification and the desktop/mobile Playwright acceptance suite with:

```sh
./scripts/verify.sh
make test-e2e
```

Install Playwright's Chromium runtime once with `cd web && npx playwright install chromium` when no compatible browser is present. Build distributable artifacts without running tests with `make build`; the binary is written to `bin/teamtaler` and the frontend to `web/dist`.

## Commit messages

Use concise imperative English commit messages, for example:

```text
Add audited payment reversal flow
```

## Security changes

Do not submit an undisclosed vulnerability through a public pull request. Follow [SECURITY.md](SECURITY.md).
