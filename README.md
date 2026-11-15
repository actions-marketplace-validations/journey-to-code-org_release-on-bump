# Release on Bump

A GitHub Action that releases npm packages when their version reaches `main`.

It publishes every package whose version isn't on npm yet, in the order they depend on each other, with provenance and **no stored npm token** (npm trusted publishing). Then each package gets a git tag and a GitHub release with generated notes. A push that doesn't change a version does nothing.

You bump the version in a PR; merging it releases.

It runs your build, types and tests first, so a broken `main` publishes nothing. It is safe to run again: a version already on npm is skipped, and one that already has a GitHub release is skipped, so a re-run finishes whatever a failed run left undone.

## Use it

Add `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches: [main]
  workflow_dispatch:

# One release at a time, and never cancelled halfway through a publish.
concurrency:
  group: release
  cancel-in-progress: false

permissions: {}

jobs:
  release:
    if: github.ref == 'refs/heads/main'
    environment: release
    runs-on: ubuntu-latest
    permissions:
      contents: write # the tags and the releases
      id-token: write # trusted publishing, and npm's provenance
    steps:
      - uses: actions/checkout@v4
      - uses: journey-to-code-org/release-on-bump@v1
```

That is the whole setup for a repository of packages under `packages/*` with `build`, `typecheck` and `test` scripts. Everything is an input; see below.

The job's `permissions`, `environment` and `concurrency` stay in your workflow, because an action can't set them, and npm's trust is bound to them.

### Once per package, on npmjs.com

npm has to trust the workflow. For each package: **Settings → Trusted publishing → GitHub Actions**, then

| Field | Value |
| --- | --- |
| Organization or user | the repository's owner |
| Repository | the repository's name |
| Workflow filename | `release.yml` |
| Environment | `release` (or none, if your job has no `environment`) |
| Allowed actions | `npm publish` |

These have to match the workflow exactly, or npm answers `E404` even though the package exists. A package can't be set up until it exists, so publish its first version by hand (`npm publish --access public`), then add it. Scoped packages are private by default; the action passes `--access public` for you.

The `release` environment is created the first time the job runs. In the repository's settings you can limit it to `main`, so that npm refuses a publish from anywhere else too.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `working-directory` | `.` | The repository root for the package(s), if it isn't the checkout's root. |
| `packages` | `auto` | `auto` reads the root `package.json`'s `workspaces` (or publishes the root package if there are none). Or a comma or newline separated list of directories or `dir/*` patterns. `!dir` leaves one out. |
| `branch` | `main` | The only branch that may publish. Any other fails before publishing anything. |
| `tag-format` | `v{version}`, or `{dir}-v{version}` for a monorepo | With `{dir}`, `{name}` (the package name without its scope) and `{version}`. |
| `node-version` | `22` | Ignored when `node-version-file` is set. |
| `node-version-file` | | `.nvmrc`, `.node-version`. |
| `npm-version` | `11` | Trusted publishing needs npm 11.5.1 or later. Empty keeps Node's own. |
| `cache` | `npm` | What setup-node caches. Empty for none. |
| `install` | `npm ci` | Empty to skip. |
| `verify` | build, typecheck and test, each only if the script exists | Commands to run before anything is published, one per line. Empty to skip. |
| `access` | `public` | `public` or `restricted`. |
| `provenance` | `true` | |
| `npm-token` | | Only if trusted publishing isn't set up. Replaces the OIDC login. |
| `github-token` | the workflow's | Makes the tags and releases. Use a token with the Workflows permission if the commit being released changes `.github/workflows`. |
| `dry-run` | `false` | Everything but publish and release (`npm publish --dry-run`). |

### Outputs

`published` (what this run published), `released` (what is on npm at the repository's version) and `tags` (the releases this run created). Each is one `<dir> <version>` per line, apart from `tags`.

## How it decides

- **Order.** A package that depends on another one in the repository (`dependencies`, `peerDependencies`, `optionalDependencies`) is published after it.
- **Prereleases.** A version with a `-` in it (`1.0.0-rc.1`) is published under the `next` tag and released as a prerelease, so it's never what `npm install` gives.
- **The release commit.** Each release is tagged on the commit that set the version, not the one that triggered the run, so a re-run after a failure still tags the right commit.
- **A version npm hasn't started serving.** npm can take minutes to serve a version it has accepted. What this run published counts as released without asking again.
- **Private packages** and packages without a `version` are skipped.

## Not covered

- It doesn't bump versions or write changelogs. That is the PR that precedes it.
- Workspace patterns are `dir/*` and plain paths; `**` is an error, not a silent skip.
- npm only. A repository that also publishes elsewhere (a VS Code extension, binaries) can use this for the npm part and add its own steps after it.

## By hand

The engine is one dependency-free file. For a first publish, or to see what a release would do:

```sh
node scripts/release.mjs --dry-run   # from the repository's root, with this repository's scripts/ path
```

Without `--dry-run` it needs `npm login`, `gh auth login`, the right branch and a clean tree.

## Development

```sh
npm test
```

The tests use throwaway git repositories and stand-ins for `npm` and `gh`, so they need no network. CI also runs the action on a fixture package with `dry-run`.

## License

MIT
