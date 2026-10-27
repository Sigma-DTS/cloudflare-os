import { useEffect, useRef } from "react";
import { useKumoToastManager } from "@cloudflare/kumo";
import { useRouter } from "@tanstack/react-router";
import { RpcStub, RpcTarget } from "capnweb";
import type {
  AuthenticatedApi,
  NotificationSubscriber,
  UserNotification,
} from "@gadgets/workshop-shared/api";
import { logRpcFailure } from "../../rpcErrors";
import { nativeApp } from "../native-app/nativeApp";
import { isChatVisible } from "./visibleChat";

const DEVICE_REGISTRATION_EVENT = "cloudflare-os:notification-device-registration";
const NOTIFICATION_AUTHORIZATION_REQUEST_EVENT =
  "cloudflare-os:notification-authorization-request";

type LegacyNativeNotificationWindow = Window & {
  __CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__?: string;
  __CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__?: () => void;
  webkit?: { messageHandlers?: { cloudflareOSNotificationReady?: {
    postMessage: (message: { type: "ready" | "failed" }) => void;
  } } };
};

class NotificationSubscriberImpl extends RpcTarget implements NotificationSubscriber {
  constructor(
    private readonly present: (notification: UserNotification) => void,
    private readonly onReleased: () => void,
  ) {
    super();
  }

  async notify(notification: UserNotification): Promise<void> {
    if (document.visibilityState !== "visible") {
      throw new Error("notification client is not visible");
    }
    this.present(notification);
  }

  // capnweb calls this once the server drops its last reference to the subscriber.
  [Symbol.dispose]() {
    this.onReleased();
  }
}

const eventDeviceRegistration = (event: Event): string | undefined => {
  if (!(event instanceof CustomEvent)) return undefined;
  let detail = event.detail as { deviceRegistrationId?: unknown } | null;
  return typeof detail?.deviceRegistrationId === "string" ? detail.deviceRegistrationId : undefined;
};

/** Connects the authenticated SPA to native enrollment and live notification delivery. */
export const NotificationBridge = ({
  authenticatedApi,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>;
}) => {
  const toasts = useKumoToastManager();
  const addToast = useRef(toasts.add);
  addToast.current = toasts.add;
  const router = useRouter();
  const currentApi = useRef(authenticatedApi);
  currentApi.current = authenticatedApi;
  const askedNative = useRef(false);
  const pendingAuthorization = useRef<Promise<string> | undefined>(undefined);
  const registrationAttempts = useRef(new Map<string, Promise<"ready" | "failed">>());

  useEffect(() => {
    let legacyWindow = window as LegacyNativeNotificationWindow;
    let notifications = nativeApp()?.notifications;
    let cancelled = false;
    let requestingAuthorization = false;
    const reportingRegistrations = new Set<string>();
    let reportRegistration = (outcome: "ready" | "failed") => {
      if (notifications) {
        notifications.registrationFinished(outcome);
      } else {
        legacyWindow.webkit?.messageHandlers?.cloudflareOSNotificationReady
          ?.postMessage({ type: outcome });
      }
    };
    const requestRegistration = async () => {
      if (requestingAuthorization) return;
      requestingAuthorization = true;
      try {
        if (notifications?.authorizationRequired) {
          const request = pendingAuthorization.current ??
            currentApi.current.authorizeNotificationDevice();
          pendingAuthorization.current = request;
          const authorization = await request.finally(() => {
            if (pendingAuthorization.current === request) pendingAuthorization.current = undefined;
          });
          if (!cancelled) notifications.requestDeviceRegistration(authorization);
        } else if (notifications) {
          notifications.requestDeviceRegistration();
        } else {
          legacyWindow.__CLOUDFLARE_OS_REQUEST_NOTIFICATION_DEVICE_REGISTRATION__?.();
        }
      } catch (error) {
        if (!cancelled) {
          reportRegistration("failed");
          logRpcFailure("Failed to authorize notification device:", error);
        }
      } finally {
        requestingAuthorization = false;
      }
    };
    let register = async (deviceRegistrationId: string | undefined) => {
      if (!deviceRegistrationId || reportingRegistrations.has(deviceRegistrationId)) return;
      reportingRegistrations.add(deviceRegistrationId);
      let attempt = registrationAttempts.current.get(deviceRegistrationId);
      if (!attempt) {
        // The native handle is single-use. Retain its one exchange so Strict Mode's replacement
        // effect can report the outcome without redeeming the handle again.
        if (legacyWindow.__CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__ ===
            deviceRegistrationId) {
          delete legacyWindow.__CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__;
        }
        attempt = (async () => {
          try {
            if (notifications?.authorizationRequired) {
              await currentApi.current.registerAuthorizedNotificationDevice(deviceRegistrationId);
            } else {
              await currentApi.current.registerNotificationDevice(deviceRegistrationId);
            }
            return "ready" as const;
          } catch (error) {
            logRpcFailure("Failed to register notification device:", error);
            return "failed" as const;
          }
        })();
        registrationAttempts.current.set(deviceRegistrationId, attempt);
      }
      const outcome = await attempt;
      if (!cancelled) reportRegistration(outcome);
    };
    let onDeviceRegistration = (event: Event) => {
      void register(eventDeviceRegistration(event));
    };

    // The legacy globals remain only for the currently distributed TestFlight build. New shells
    // expose notification controls through the same versioned object as navigation and login.
    let injected = notifications?.currentDeviceRegistration() ??
      legacyWindow.__CLOUDFLARE_OS_NOTIFICATION_DEVICE_REGISTRATION__;
    void register(injected);
    window.addEventListener(DEVICE_REGISTRATION_EVENT, onDeviceRegistration);
    const onAuthorizationRequest = () => { void requestRegistration(); };
    window.addEventListener(NOTIFICATION_AUTHORIZATION_REQUEST_EVENT, onAuthorizationRequest);
    // Each id costs a central registration. Ask at most once per authenticated mount, and not at
    // all when native already injected one. A pending grant survives Strict Mode's effect replay.
    if (!askedNative.current || pendingAuthorization.current) {
      askedNative.current = true;
      if (!injected) {
        void requestRegistration();
      }
    }
    return () => {
      cancelled = true;
      window.removeEventListener(DEVICE_REGISTRATION_EVENT, onDeviceRegistration);
      window.removeEventListener(NOTIFICATION_AUTHORIZATION_REQUEST_EVENT, onAuthorizationRequest);
    };
  // Enrollment belongs to this authenticated mount, not each replacement WebSocket stub.
  }, []);

  useEffect(() => {
    let subscription: RpcStub<{}> | undefined;

    let updateSubscription = () => {
      subscription?.[Symbol.dispose]();
      subscription = undefined;
      if (document.visibilityState !== "visible") return;

      let live = false;
      let subscriber = new NotificationSubscriberImpl(notification => {
        let { id, kind, workspaceId, chatId, chatTitle } = notification;
        if (isChatVisible(workspaceId, chatId)) return;
        let completed = kind === "taskCompleted";
        addToast.current({
          id,
          title: `${chatTitle || "Task"} ${completed ? "completed" : "needs permission"}`,
          variant: completed ? "success" : "info",
          actions: [{
            children: "Open task",
            onClick: () => router.navigate({
              to: "/workspace/$id",
              params: { id: workspaceId },
              search: { chat: chatId, showChat: true },
            }),
          }],
        });
      }, () => {
        // Released while still ours, after it took: the User DO reset and forgot it. (A failed
        // subscribe releases it too, so `live` keeps that from retrying in a loop.)
        if (live && subscription === nextSubscription) updateSubscription();
      }) as unknown as RpcStub<NotificationSubscriber>;
      let nextSubscription = authenticatedApi.subscribeToNotifications(subscriber);
      subscription = nextSubscription;
      nextSubscription.then(() => { live = true; }, error => {
        if (subscription !== nextSubscription) return;
        logRpcFailure("Notification subscription failed:", error);
      });
    };

    document.addEventListener("visibilitychange", updateSubscription);
    updateSubscription();
    return () => {
      document.removeEventListener("visibilitychange", updateSubscription);
      subscription?.[Symbol.dispose]();
      subscription = undefined;
    };
  }, [authenticatedApi, router]);

  return null;
};
