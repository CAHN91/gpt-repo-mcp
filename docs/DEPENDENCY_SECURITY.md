# Dependency Security

Dependency advisories are handled from the checked-in lockfile. Do not use
`npm audit fix --force`; it may replace the MCP SDK with an older incompatible
version.

## Current production dependency decisions

| Dependency | Reachability | Resolution |
| --- | --- | --- |
| `body-parser` | Reachable through the server's bounded `express.json` middleware. | Keep the compatible fixed transitive release selected by the lockfile. |
| `fast-uri` | Potentially reachable through AJV-backed validation in the MCP SDK. | Keep the compatible fixed 3.x release selected by the lockfile. |
| `hono` | The project does not import Hono adapters directly, but it ships under the MCP SDK. | Keep the compatible fixed 4.x release selected by the lockfile. |
| `@hono/node-server` | Reachable through the MCP SDK Streamable HTTP transport. | Temporarily override to fixed `2.0.12` because MCP SDK 1.29.0 still requests vulnerable 1.x. |

The `@hono/node-server` override must be removed once
`@modelcontextprotocol/sdk` declares a fixed compatible range. Review the
override no later than 2026-10-26. Any override change requires the MCP
contract tests, server network-boundary tests, full test suite, build, and
`verify:dist`.

## Current development-only advisories

The projected OSS lockfile currently has no production advisories. Its full
audit has five transitive findings confined to build, lint, and test tooling:

| Package | Toolchain path | Current decision |
| --- | --- | --- |
| `brace-expansion` | `typescript-eslint` and ESLint minimatch chains | Keep the current compatible lock selection; review upstream updates by 2026-08-31. |
| `esbuild` | `tsup`, `tsx`, and Vite | Development process only; review coordinated toolchain updates by 2026-08-31. |
| `js-yaml` | ESLint configuration loading | Development process only; review the next compatible ESLint release by 2026-08-31. |
| `postcss` | `tsup` and Vite | No production runtime path; review coordinated toolchain updates by 2026-08-31. |
| `vite` | Vitest | Test process only; review the next compatible Vitest/Vite release by 2026-08-31. |

These are explicit temporary classifications, not blanket audit suppression.
`security/oss-security-policy.json` locks the package names, severities, and
review deadline. A new package, changed severity, production finding, or
expired deadline fails the release security scan. Upgrade the owning direct
development dependencies together, regenerate the projected lockfile, and run
the full candidate verification; do not apply forced semver-major audit fixes.

## Verification

Run:

```bash
npm audit --omit=dev
npm audit
npm ls @modelcontextprotocol/sdk @hono/node-server hono body-parser fast-uri ajv
```

Treat a new production advisory as an investigation task: trace its dependency
path and runtime reachability, prefer a compatible lockfile update, and add an
override only when upstream has no usable fixed range and the affected path has
integration coverage.
