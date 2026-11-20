# Worker-only browser client qualification

The browser-refresh client pins the vendor-published
`@cloudflare/puppeteer@1.5.0-rc.0`, not the moving `next` tag. This is an ESM-only
Workers port, not a claim that the release candidate is stable. Its native npm
graph removes the old Node browser installer and its archive/FTP dependencies.
The application keeps the default import, `launch(env.BROWSER)`, existing login
flow, refresh guards and Meter lease; it does not enable RPC/lab mode, persistent
sessions or keep-alive.

## Dependency boundary

Only the Puppeteer root range changes. The additional exact root devDependency
`@types/node@26.6.5` preserves the baseline test/build type provider: the new client
requires Node 18 types, which npm must nest under it instead of hoisting into
Vitest/Vite's incompatible peer position. Both `undici-types@8.9.0` (root types)
and `5.26.5` (nested types) remain transitive. No override, installer replacement,
SDK upgrade or toolchain version refresh is required.

Resolution uses npm 11.19.0 with `.npmrc` settings `min-release-age=3` and
`ignore-scripts=true`. Existing legacy-peer and registry settings are preserved.
The baseline install-hook candidates are `core-js-pure@3.51.0`, `esbuild@0.28.2`,
`fsevents@2.3.3` and `workerd@1.20261023.1`; none has a lifecycle exception.
Explicit repository test/typegen/dry-run commands are not lifecycle exemptions.
A broken artifact requires an exact scoped review, not enabling all hooks.

## Qualification, not live login testing

GitHub Actions runs the clean installation, native installed-graph inspection,
complete advisory inventory, type generation, strict typecheck, both coverage
projects with unchanged floors, deployment dry-run and request-only E2E. It
retains the lock, audit JSON, coverage summary and dry-run bundle for seven days.
No E2E launches a browser, calls Kagi or uses production credentials.
The complete audit is deliberately fail-closed at every advisory severity, not
an evidence-only step: any advisory holds qualification before later commands.

- `test/ci/browser-dependencies.test.ts` pins the artifact, checks every lock
  location for the removed installer packages, and scans installed runtime JS for
  named bundled copies/imports. During the initial 1.4 migration it also compares
  every retained version/integrity to the exact PR base, including nested and
  platform-optional pins. This does not freeze unrelated dependencies on future
  PRs where the browser pin is unchanged.
- `test/workers/refresh-lease.test.ts` covers free guards, held/forced/free leases
  and fail-closed Meter errors. Refused guards must not acquire a browser.
- `test/workers/refresh-browser.test.ts` mocks browser operations but uses Workers
  Meter/KV. It covers form/UA/options, success, missing cookies, login refusal,
  operational failures, persistence, cleanup and same-isolate single-flight.
- `test/workers/puppeteer-contract.test.ts` imports the real installed package
  without a package mock. A bounded in-process WebSocket/CDP peer qualifies
  binding acquisition, page bootstrap, close, refused upgrade, malformed replies
  and timeout behavior. It is not a complete browser or Kagi emulator.

Package-name/content scans are regression checks, not proof against arbitrary
unbranded copied code or all future advisories. A branch audit is not evidence
that default-branch Dependabot alerts have closed: verify those after merge.

## Revisit and rollback

Do not float this prerelease pin. A later stable release must retain worker-only
packaging and pass the same dependency, real-package transport and refresh delta
qualification. A failed check holds the candidate for a bounded technical
correction; do not automatically choose a major installer override or a private
extractor patch. Reverting this change restores known vulnerable installer
packages and is not an approved production rollback. Deployment and any
production-reaching merge retain their separate release approval gates.

REA angle: inspect the vendor's shipped export map, manifest, binding transport
and runtime artifacts instead of inventing a resolver or assuming Node-only
installer code is harmless.

Sources: [vendor package](https://www.npmjs.com/package/@cloudflare/puppeteer/v/1.5.0-rc.0),
[vendor source](https://github.com/cloudflare/browser-run/tree/main/packages/puppeteer-cloudflare),
[npm config](https://docs.npmjs.com/cli/v11/using-npm/config).
