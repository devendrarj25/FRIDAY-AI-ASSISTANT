import { useSyncExternalStore } from "react";
import { notifications, type NotificationsState } from "./notifications";

const server: NotificationsState = notifications.getSnapshot();

export function useNotifications(): NotificationsState {
  return useSyncExternalStore(notifications.subscribe, notifications.getSnapshot, () => server);
}
