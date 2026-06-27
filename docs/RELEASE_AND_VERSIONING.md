# Release and Versioning Guidance

This document explains the release process and versioning strategy for the packages in this repository. We follow Semantic Versioning (SemVer) for all releases.

## Release Process Overview

Our project consists of multiple packages, including contracts, SDKs, web frontend, and mobile apps. 

### 1. Contract Packages (`packages/contracts`)
- **Versioning**: Bump versions in `Cargo.toml`.
- **Release**: Contracts are compiled to WebAssembly (WASM). Releases are tagged and the optimized WASM files are attached to GitHub releases. Ensure all contract optimizations (e.g., `< 256KB`) are met before tagging.
- **Deployment**: After a release, the contract is deployed to testnet for final verification, then to mainnet.

### 2. SDK Packages
- **Versioning**: Bump version in `package.json`.
- **Release**: SDKs are published to the npm registry.
- **Process**:
  - Update `CHANGELOG.md`.
  - Run `npm run build` and ensure all tests pass.
  - Create a release PR. Once merged, CI will automatically publish to npm using the `release` GitHub workflow.

### 3. Web Packages
- **Versioning**: Bump version in `package.json`.
- **Release**: The web app is continuously deployed (e.g., via Vercel or similar platforms).
- **Process**: Merging to the `main` branch triggers a production build and deployment. Production releases are tagged in git (`web-vX.Y.Z`).

### 4. Mobile Packages
- **Versioning**: Update version in `package.json`, `build.gradle` (Android), and `Info.plist` (iOS).
- **Release**: Mobile builds are distributed via App Store Connect and Google Play Console.
- **Process**: 
  - A release tag triggers the mobile CI/CD pipeline (e.g., Fastlane) to build and submit the app to the respective beta testing tracks (TestFlight/Play Console Internal).
  - Once QA is complete, the build is promoted to production.

## Creating a Release

1. **Prepare Release**: Create a `release/vX.Y.Z` branch. Update versions across necessary packages.
2. **Changelog**: Update the changelog with all notable changes.
3. **PR and Review**: Submit the release PR for review.
4. **Tagging**: Once merged, create a Git tag (e.g., `vX.Y.Z`).
5. **CI/CD**: The tag will trigger the respective deployment and publishing pipelines.
