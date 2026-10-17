# Android notifications

## Local notification test

The mobile APK creates the `Energrid alerts` notification channel. On Android 13 and later it asks for `POST_NOTIFICATIONS` permission when the user taps **Send test** in Mobile > Settings. Android 11 does not show that runtime prompt. Tapping the notification opens the mobile app. This is a local notification test; it does not need the Energrid API or an internet connection.

Build the single adaptive app from `apps/android/`:

```sh
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug
```

There is one package, `bg.energrid.home`, for both phones and tablets. The same APK selects `/mobile/` with portrait navigation on phones and `/home/` with landscape kiosk behavior on tablets. Web workflows stay in the portal; Android provides only OS integrations such as microphone capture and notifications.

## Phone recording while locked

On the mobile app, open **Settings** and use **Train “Energrid”** to start a background category such as Ordinary conversation. Background capture runs in a microphone foreground service with a persistent **Energrid audio capture** notification and a CPU wake lock. Use the notification's **Stop** action or the in-app button to finish; audio is written locally in five-minute WAV segments. No microphone stream is sent to the server.

Test this before a long session: start a short background capture while the app is open, confirm the ongoing recording notification, lock the phone for one or two minutes, then unlock and stop. Confirm the status returns to saved and the segment count increases. Keep Energrid allowed to run in the background in Samsung battery settings. The 8-second wake-phrase clip and live assistant conversation are not background services; they require the app to stay visible. Android may still stop any app under user force-stop or aggressive system restrictions.

## Remote push: recommended next step

FCM requires a trusted sender environment in addition to the Android app. Energrid’s API can send through the FCM HTTP v1 API or Firebase Admin SDK; the sender credential must stay on the server and must never be embedded in the APK or returned to the portal. The private-network API can initiate outbound requests to FCM; no inbound phone connection to the home network is needed. See the [Firebase server environment guide](https://firebase.google.com/docs/cloud-messaging/server-environment) and [HTTP v1 send guide](https://firebase.google.com/docs/cloud-messaging/send/v1-api).

Before enabling push, implement:

- A Firebase project, Android app registration for `bg.energrid.home`, and the matching `google-services.json` kept out of source control if it contains project-specific configuration.
- Authenticated token registration bound server-side to the signed-in user, tenant, site, and app installation. Treat FCM tokens as secrets; never accept a client-supplied tenant binding without authorization.
- Token refresh/update, logout revocation, invalid-token cleanup, and per-user/site notification preferences.
- A durable event/outbox record with deduplication, severity, expiry, and delivery attempts. Do not send directly from sensor ingestion before policy evaluation.
- Per-device subscriptions rather than broad FCM topics for private home alerts. Topics can cross user/site boundaries if misconfigured.
- Delivery-attempt and acknowledgement history in Energrid. FCM acceptance means the request was accepted for delivery; it is not proof the person saw or acknowledged the alert.
- Server-side credentials via a protected secret or workload identity. Use least privilege, OAuth short-lived access, TLS, retry with exponential backoff, and redact tokens and message contents from logs.

No Firebase project, token registration, remote push sender, backend route, or backend service change is included in this first local-notification milestone.
