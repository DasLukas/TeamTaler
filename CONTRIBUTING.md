# Contributing to TeamTaler

Thank you for helping improve TeamTaler. Contributions must preserve its accounting guarantees, group isolation, lightweight operation, accessibility, and approved visual system.

## Language

All source code, code comments, documentation, commit messages, issue text, and pull request text must be written in English. User-facing German copy belongs in the translation catalog rather than directly in reusable components.

## Development setup

1. Install Go 1.26.x, Node.js 24.x, and npm 11.x. If you use NVM, run `nvm use` from the repository root.
2. Run `make install`.
3. Start the API with `make dev-backend`.
4. Start the frontend with `make dev-frontend`.
5. Run `make verify` before opening a pull request.

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
- Update README and ARCHITECTURE whenever setup, modules, APIs, data flow, dependencies, or deployment behavior changes.
- Preserve keyboard operation, accessible names, visible focus, semantic markup, and WCAG AA contrast.
- Preserve the accepted true-white/navy/teal TeamTaler design system. New component families require a documented product need.
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

## Commit messages

Use concise imperative English commit messages, for example:

```text
Add audited payment reversal flow
```

## Security changes

Do not submit an undisclosed vulnerability through a public pull request. Follow [SECURITY.md](SECURITY.md).
