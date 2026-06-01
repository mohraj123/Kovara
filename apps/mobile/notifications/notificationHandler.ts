import * as Notifications from "expo-notifications";
import { router } from "expo-router";

// Configure how notifications are handled when the app is in the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export interface NotificationPayload {
  type: "NEW_FOLLOWER" | "TIP_RECEIVED" | "POOL_ACTIVITY";
  followerAddress?: string;
  senderAddress?: string;
  amount?: string;
  asset?: string;
  poolId?: string;
  activityType?: string;
}

export function setupNotificationListeners() {
  // Listener for foreground notifications
  const notificationListener = Notifications.addNotificationReceivedListener((notification) => {
    console.log("Notification received in foreground:", notification);
  });

  // Listener for notification taps (when user interacts with a notification)
  const responseListener = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as NotificationPayload;
    console.log("Notification response (tap) received:", data);

    if (!data || !data.type) return;

    switch (data.type) {
      case "NEW_FOLLOWER":
        if (data.followerAddress) {
          router.push(`/profile/${data.followerAddress}` as Parameters<typeof router.push>[0]);
        }
        break;
      case "TIP_RECEIVED":
        router.push("/wallet" as Parameters<typeof router.push>[0]);
        break;
      case "POOL_ACTIVITY":
        if (data.poolId) {
          router.push(`/pool/${data.poolId}` as Parameters<typeof router.push>[0]);
        }
        break;
      default:
        console.warn("Unknown notification type:", data.type);
    }
  });

  return () => {
    Notifications.removeNotificationSubscription(notificationListener);
    Notifications.removeNotificationSubscription(responseListener);
  };
}
