# Engineering documentation

- Treat source code, migrations and checked-in deployment configuration as the implementation source of truth. Link to them and state when behavior is inferred or unverified.
- Update the relevant `docs/` page when a change alters an architecture boundary, device lifecycle, public or internal contract, persistence, authorization, protocol behavior, deployment or recovery procedure. Update navigation when adding or renaming a handbook page.
- Keep Markdown as the source of truth. Run `pnpm docs:build` when changing handbook pages or VitePress configuration; do not run application services or use live databases as documentation checks.
- Mark planned, in-progress and unverified behavior clearly. Each implementation milestone should state which documentation changed, or why none was needed.
