# Android dashboard shell

The APK loads the standalone hosted Home dashboard at `/d/home`. There is no bundled dashboard frontend or Portal navigation in that route. The default URL is `https://portal.energrid.bg/d/home`; configure the Android build without changing the Portal source:

```sh
./gradlew assembleDebug -PenergridHomeUrl=https://portal.energrid.bg/d/home
```

Use a LAB dashboard URL explicitly when building LAB:

```sh
./gradlew assembleDebug -PenergridEnvironment=lab -PenergridLabUrl=https://lab.example/d/home
```

`energridLabUrl` has no default, so a LAB build cannot silently point at HOME. Cleartext traffic is enabled only when the explicitly selected dashboard URL uses `http://`. Both the path and host must serve the existing Energrid Home dashboard and its authentication endpoints. WebView cookies are accepted and flushed across app pauses; microphone permission is limited to the configured dashboard origin.

## Notification delivery

The Portal's existing `notifications.ts` engine remains the source of notification records and history. When it creates a new record, it forwards only the record ID, severity, title, and message to the Android adapter. The adapter deduplicates IDs, posts to the `Energrid notifications` channel while the app is backgrounded, and opens the hosted dashboard when tapped. While the dashboard is visible, its own notification inbox is the only delivery surface. Android 13 and later request notification permission at app launch. The Portal's existing test action can still verify the channel.

The current Energrid repositories do not contain an FCM sender or authenticated device-token registration endpoint. FCM is therefore not enabled in this V1 APK. Notifications can reach Android while the WebView process remains alive and the Portal's existing polling observes the event; reliable delivery after Android kills the app needs an explicitly configured FCM sender and registration path in the existing notification service. No API secrets, Firebase sender credentials, or control tokens are stored in the APK, and no backend migration or production deployment was made.

## Build

Build the landscape Home shell from `apps/android/`:

```sh
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug
```

The hosted dashboard retains all device, weather, Assistant, and notification-history behavior. The native audio implementation for wake-word and tap-to-talk remains in `WakeWordController.kt`; the separate research recording/upload controls and background services have been removed from the Android product shell.
