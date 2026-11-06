# Engineering documentation

- Treat source code, migrations and checked-in deployment configuration as the implementation source of truth. Link to them and state when behavior is inferred or unverified.
- Update the relevant `docs/` page when a change alters an architecture boundary, device lifecycle, public or internal contract, persistence, authorization, protocol behavior, deployment or recovery procedure. Update navigation when adding or renaming a handbook page.
- Keep Markdown as the source of truth. Run `pnpm docs:build` when changing handbook pages or VitePress configuration; do not run application services or use live databases as documentation checks.
- Mark planned, in-progress and unverified behavior clearly. Each implementation milestone should state which documentation changed, or why none was needed.
- Reconcile milestone status in the existing handbook roadmap/backlog (`docs/audit-and-gaps.md` and the owning topic page): implemented, verified, blocked or planned. Do not create a parallel roadmap.
- Record verification with its scope: tests/builds, runtime environment and source commit, date, and operations actually performed. Passing tests do not establish live hardware behavior.
- State deployment status separately from Git integration. A local commit is not a Pi or production deployment; deployment claims require an observed target version and health check.
- Keep outstanding limitations, unresolved defects and the next actionable step visible. A milestone is not complete solely because code builds or tests pass.
- Update an ADR only when a durable architecture decision changes. Routine implementation details belong in the owning topic page and do not require a new ADR.

- Before making any code or architecture changes, read and follow [Engineering Principles & Development Standards](docs/ENGINEERING.md). These standards are mandatory for all development, reviews, refactoring, and testing.
