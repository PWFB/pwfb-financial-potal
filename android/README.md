# PWFB Financial Potal Android app

This Android wrapper opens the live portal at:

https://pwfb-financial-potal-web.onrender.com

## Build outputs

The GitHub Actions workflow **PWFB Financial Potal Android APK and AAB** builds:

- `PWFB-Financial-Potal-debug.apk` — installable on Android for testing.
- `PWFB-Financial-Potal-release-unsigned.aab` — Android App Bundle for the release-signing step.
- `SHA256SUMS.txt` — checksums for both build outputs.

Run it from GitHub Actions using **Run workflow**, or push changes under `android/` to `main`.

## Signing note

The APK is debug-signed for testing. The AAB is deliberately unsigned because a production Play Store upload must be signed with the owner's private upload/release key. Do not publish an unsigned bundle. Configure a protected release keystore and credentials before making a Play Store release.

The app needs internet access because portal content is served securely from the live website. The web session depends on the portal and its backend being available.
