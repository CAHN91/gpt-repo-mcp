# Release Checklist

This checklist is for maintainers preparing a public GitHub release or npm
package from GPT Repo MCP.

## Release Content

- Confirm the version and release date are correct in `package.json` and
  `CHANGELOG.md`.
- Confirm the migration guide describes any breaking tool, configuration, or
  workflow changes.
- Confirm README installation, connection, and first-use instructions still
  match the released behavior.
- Confirm user-facing capability, security, tool, and write-workflow guides are
  current.
- Confirm the release contains no local configuration, runtime state, generated
  output, credentials, active tunnel URLs, or machine-specific paths.

## Verification

Run from a clean checkout:

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run check:public
npm run verify:dist
npm audit --omit=dev
npm pack --dry-run
git diff --check
```

Review any full-audit development advisory against
[Dependency security](DEPENDENCY_SECURITY.md). Do not use
`npm audit fix --force` as a release shortcut.

## Security And Safety

- Confirm no new production dependency advisory is unresolved.
- Confirm dependency licenses remain compatible with the project license.
- Confirm the secret scan reports no credentials, private keys, tokens, or
  sensitive personal information.
- Confirm the server still binds locally by default.
- Confirm mutating tools remain opt-in and path-scoped.
- Confirm validation still uses approved profiles rather than arbitrary
  commands.
- Confirm no tool can push, merge, deploy, reset, stash, rewrite history, or
  execute arbitrary shell commands.

## Documentation

- Read the GitHub-rendered README from the perspective of a first-time user.
- Check all local documentation links.
- Confirm technical contributor guides describe current architecture rather
  than historical implementation work.
- Confirm examples contain placeholders, not real repository paths, email
  addresses, connector ids, or tunnel values.

## GitHub Release

- Use a concise title and release notes based on `CHANGELOG.md`.
- Explain user-visible improvements and migration steps before implementation
  details.
- Create the version tag from the reviewed release commit.
- Wait for required CI checks before publishing the release.
- After publishing, verify the tag, release assets, README links, and install
  instructions from the public repository.

## npm Publication

- Treat npm publication as a separate explicit decision.
- Verify package name, version, license, repository metadata, files, and
  executable entries in the `npm pack --dry-run` output.
- Confirm the package privacy setting is intentional before publishing.
- Install the packed archive in a temporary directory and verify the CLI,
  build output, and server health check.
