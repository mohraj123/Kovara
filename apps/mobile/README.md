# Linkora Mobile

React Native / Expo mobile app for the Linkora SocialFi platform on Stellar.

> **Status:** This package is planned and not yet scaffolded. This README and the accompanying developer guide exist to document the intended structure ahead of implementation.

## Quick Start

See [docs/mobile/DEVELOPER_GUIDE.md](../../docs/mobile/DEVELOPER_GUIDE.md) for full setup instructions covering prerequisites, simulator setup, project structure, and EAS builds.

## Tech Stack

- [Expo](https://expo.dev) (React Native)
- [Expo Router](https://docs.expo.dev/router/introduction/) — file-based navigation
- [EAS Build](https://docs.expo.dev/build/introduction/) — cloud native builds
- [Stellar Wallet Kit](https://stellarwalletkit.dev) — wallet integration
- [`packages/sdk`](../../packages/sdk) — typed Linkora contract client

## Testing

### Running Tests

```bash
npm test
```

### Snapshot Testing

This project uses Jest snapshot testing to catch unintended visual regressions in UI components. Snapshots are automatically generated for core components like PostCard, PoolCard, and EmptyState.

#### Updating Snapshots

When you intentionally change a component's visual output, you'll need to update the snapshots:

```bash
# Update all snapshots
npm test -- --updateSnapshot

# Update snapshots for a specific test file
npm test PostCard.snap.test.tsx -- --updateSnapshot
```

#### Snapshot Test Guidelines

- Snapshots should be committed to the repository
- CI will fail if snapshots change without an explicit update
- Review snapshot changes carefully during code review
- Each component should have snapshots for both default and loading states

## EAS Build Configuration

EAS (Expo Application Services) Build is configured in `eas.json`. It defines three profiles:

- **development**: For local development using a simulator or development client device.
- **preview**: For testing ad-hoc IPA builds on iOS and APK builds on Android.
- **production**: For building production app store binaries.

### Commands

To trigger a build:

```bash
# Android preview build (generates APK)
eas build --platform android --profile preview

# iOS preview build (generates IPA)
eas build --platform ios --profile preview

# Submit a production build to App Store/Google Play
eas submit --profile production
```

## Push Notifications

Push notification scaffolding is located in `notifications/`.

### Setup

Call `registerForPushNotificationsAsync()` on first launch to request user permissions and secure the push token in Expo Secure Store. Set up listeners in the app's root lifecycle:

```typescript
import { useEffect } from "react";
import { registerForPushNotificationsAsync } from "./notifications/registerForPushNotifications";
import { setupNotificationListeners } from "./notifications/notificationHandler";

useEffect(() => {
  registerForPushNotificationsAsync();
  const cleanup = setupNotificationListeners();
  return cleanup;
}, []);
```

### Notification Types & Payloads

#### 1. New Follower (`NEW_FOLLOWER`)

Triggered when a user follows another user.

- **Payload Shape:**
  ```json
  {
    "type": "NEW_FOLLOWER",
    "followerAddress": "G..."
  }
  ```
- **Routing:** Navigates directly to the follower's profile screen (`/profile/${followerAddress}`).

#### 2. Tip Received (`TIP_RECEIVED`)

Triggered when a tip is received.

- **Payload Shape:**
  ```json
  {
    "type": "TIP_RECEIVED",
    "senderAddress": "G...",
    "amount": "10",
    "asset": "XLM"
  }
  ```
- **Routing:** Navigates to the wallet details or history screen (`/wallet`).

#### 3. Pool Activity (`POOL_ACTIVITY`)

Triggered on a deposit or withdrawal from a pool.

- **Payload Shape:**
  ```json
  {
    "type": "POOL_ACTIVITY",
    "poolId": "123",
    "activityType": "deposit"
  }
  ```
- **Routing:** Navigates to the pool details page (`/pool/${poolId}`).
