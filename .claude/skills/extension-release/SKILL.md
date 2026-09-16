---
name: extension-release
description: Use when cutting a release — packaging for Chrome and Firefox, linting, version bumps, and store submission. Not needed for day-to-day feature work.
---

# Extension release process

## Pre-release

1. Run `npm run check` (typecheck + tests) — must be clean.
2. Run the full `extension-security-review` checklist, not just on the
   diff since last release — on the whole `src/vault`, `src/background`,
   `src/content`.
3. `web-ext lint` (Mozilla's linter, also flags most Chrome MV3 issues) —
   install as a dev dependency if not already present:
   `npm install --save-dev web-ext`.

## Version bump

Bump the version in **both** `package.json` and `manifest.json` — they can
drift silently since nothing currently enforces they match. Consider adding
a `scripts/check-version-sync.js` check to `npm run check` once the
manifest exists, so this stops being a manual step.

## Packaging

- **Chrome**: zip the built `dist/` output directly
  (`cd dist && zip -r ../vcf-chrome-<version>.zip .`), upload via the
  Chrome Web Store developer dashboard or the Chrome Web Store publish API.
- **Firefox**: `web-ext build` from the Firefox-targeted build output
  produces a signable zip. Firefox requires either self-distribution with a
  signed XPI (`web-ext sign`, needs AMO API credentials) or listing on AMO.
- Keep Chrome and Firefox as separate build outputs (different manifest
  background field per `mv3-extension`) rather than trying to ship one
  identical zip to both stores.

## Store submission notes

- AMO (Firefox) review can take from minutes to days depending on
  permissions requested; a `host_permissions`-requesting extension may get
  manual review. Don't assume same-day turnaround when planning a release.
- Chrome Web Store review is typically faster but also not instant — don't
  time a release announcement to the exact submission moment.
- Store listing should link to the source repo (open source, MIT) and to
  `docs/secret-schema.md` for setup — reviewers on both stores are more
  favorable to extensions that are auditable and explain exactly what data
  they touch.

## Changelog

Keep a `CHANGELOG.md` (Keep a Changelog format) — start it at the first
real release rather than backfilling later; this is a security-relevant
tool and users deciding whether to upgrade benefit from knowing what
changed, especially anything touching auth or storage.
