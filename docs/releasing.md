# Releasing

The npm package is `devbits-web-search`. The source repository is [devbitsxyz/devbits-web-search](https://github.com/devbitsxyz/devbits-web-search), and the project website is [devbits.xyz](https://devbits.xyz).

## Prepare the release

1. Review the changes intended for release. Check that the version in `package.json` and the lockfile match, and replace the changelog's `Unreleased` label with the release date when the release is ready.
2. Run the tests and inspect the package:

   ```sh
   npm ci
   npm test
   npm run test:package
   npm run test:install
   npm pack --dry-run
   ```

3. Run the integration test against the supported Harness runtime:

   ```sh
   DSH_RUNTIME_DIR=/path/to/harness/node_modules npm run test:harness
   ```

4. Review the npm file list. It should contain the runtime source, bundle patch, package metadata, README, license, user guides, logo, and locale. Local profiles, keys, tests, screenshots, and contributor instructions should stay out of the archive. README screenshots use their GitHub URLs, so push those images before publishing.
5. Confirm the package name, repository URL, homepage, Node requirement, peer dependency, and `publishConfig.access: public`. Check the README's installation commands against the version being released. Remove its pre-release notice only after npm publication succeeds.

`test:install` downloads dependencies into a temporary empty project, installs the packed package, and verifies its public exports without workspace dependencies. Set `DSH_RUNTIME_DIR` when running it to also exercise the installed package through native Harness loading, settings, diagnostics, and tool dispatch. Run on Node 22.12 and Node 24 before release. CI covers the unit, tarball, and clean-install checks on Node 22 and 24.

The automated provider tests use fixtures and do not verify a paid provider account or its available quota. Record any separate live-provider testing accurately.

Before the first release, use an empty Harness profile to install the packed archive through **Plugins → Add plugin**. Enable it, open its settings, and run **Test search** with DuckDuckGo. Capture documentation screenshots from that profile without real credentials or personal chats. Keep the installed package and screenshots in sync with the release candidate.

Set the GitHub repository description to the package description and use topics such as `deepseek-harness`, `web-search`, `local-models`, `duckduckgo`, and `searxng`. These repository settings are separate from npm's package keywords. Verify the default branch matches the README image URLs (`main`).

## Publish

Publishing is a separate maintainer action. Confirm that the npm account has permission to publish this package and that the version has not already been published. Do not share login tokens or one-time codes in issues or release notes.

After reviewing the release, publish publicly:

```sh
npm publish --access public
```

The package's `prepublishOnly` hook runs unit and package checks. The native Harness integration test remains a separate release check.

After publishing, verify the registry version and install it into a temporary Harness profile. Confirm that the plugin appears, its settings page loads, and native search dispatch works. Then tag the matching commit and create the GitHub release using the changelog entry.
