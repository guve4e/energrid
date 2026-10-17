# Energrid Research Audio Ingest

This is a separate Python standard-library service. It does not import, start, or modify Energrid backend services. It listens only on a private interface address; the default is loopback. Do not forward its port from the router or expose it to the public internet.

## Linux setup

Use Python 3.9 or newer. From the repository, choose a private LAN address assigned to the Linux storage computer (for example, `192.168.1.60`) and a directory on a filesystem with enough free space.

```sh
python3 --version
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
mkdir -p /srv/energrid-audio
export ENERGRID_INGEST_TOKEN='paste-the-generated-secret-here'
python3 apps/audio-ingest/server.py \
  --host 192.168.1.60 \
  --port 8765 \
  --storage /srv/energrid-audio \
  --quota-gb 100 \
  --min-free-mb 2048
```

The bearer token must be at least 24 characters. Keep it private. Restrict TCP port `8765` in the Linux firewall to the home LAN subnet. The service rejects wildcard and public bind addresses, checks both the configured storage quota and real free disk space, and reports both through `GET /health`. `GET /health` is intentionally unauthenticated and contains no recording metadata.

For a persistent installation, run it under an unprivileged Linux account using systemd. Keep the token in a private environment file rather than in the unit command line. Set the unit to restart on failure and the storage path on a mounted disk. Test a reboot and a service restart before leaving unattended collection enabled.

### AMD home-server user service

The checked-in `energrid-audio-ingest.service` is configured for the current AMD host and runs as the `home` user. Install the updated `server.py` and `review.html` into `/home/home/energrid-audio-ingest`, then create `/home/home/.config/energrid-audio-ingest.env` with one line, `ENERGRID_INGEST_TOKEN=<the existing token>`, and permissions `600`. Do not put the token in the unit file or command line. Install and start the unit with:

```sh
mkdir -p ~/.config/systemd/user
cp energrid-audio-ingest.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now energrid-audio-ingest.service
```

User services start at login by default. To start this service automatically after boot before `home` logs in, an administrator must enable lingering once with `sudo loginctl enable-linger home`. The unit checks that the data partition is mounted before starting. A missing mount fails closed; it never creates a substitute storage directory on the root filesystem.

## Android configuration

Start the service, then open the tablet's Energrid Assistant page and expand **LAN storage and reviewed recordings**. Enter `http://192.168.1.60:8765`, paste the same token, and save. Android stores the token encrypted with Android Keystore. Only RFC1918 IPv4 or `.local` destination names are accepted. Audio is never sent unless this destination is explicitly configured.

Choose a recording category, confirm that everyone present consents, and start the session. The persistent Android notification has a Stop action. The app writes local five-minute PCM WAV segments first; upload happens independently in 1 MiB chunks and resumes from the server-acknowledged byte offset after a Wi-Fi interruption or server restart. Recording does not wait for the server. Manual assistant turns pause the recorder, finalize a segment, then resume the same session. Those gaps are therefore explicit session boundaries, not overlapping microphone capture.

## Review and export

Open `http://192.168.1.60:8765/` on a trusted LAN browser, enter the bearer token, and review recordings. Listen to a segment, mark any wake-word time at the audio playhead, then assign a human label. Labels from the detector are never promoted automatically. Deletion is permanent on the storage server.

To create an offline dataset, first choose one or more complete sessions to reserve only for test. Then run:

```sh
python3 apps/audio-ingest/export_dataset.py /srv/energrid-audio /srv/energrid-export \
  --test-session SESSION_ID_FROM_REVIEW \
  --validation-ratio 0.2
```

Repeat `--test-session` for additional sessions. The command refuses to overwrite a nonempty output directory, includes only human-reviewed confirmed labels, verifies WAV format and SHA-256, deduplicates identical source segments, and assigns whole sessions to splits. For confirmed-positive five-minute sessions, it exports 2.5-second clips only around wake-word timestamps explicitly marked during review (0.75 seconds before and 1.75 seconds after). A positive label without a marked occurrence is excluded from positive training examples. Confirmed-negative/background WAVs remain intact. Unlabeled and uncertain audio is excluded. The test-session IDs must be selected explicitly; test sessions are not mixed with training or validation.

## Storage behavior

- Original uploaded WAV bytes are stored without transcoding under `sessions/<device>/<session>/<date>/<category>/`.
- `index.jsonl` is the authoritative searchable index; each session also has a `session.jsonl` manifest.
- Upload IDs and hashes make retries idempotent. Interrupted chunks remain under `.uploads/` and resume on the next retry.
- The Android keeps local files; server acknowledgment does not silently delete the tablet copy. Android stops capture at 2 GiB of app-managed sample data or below 256 MiB free space. Server uploads are rejected before the configured quota or minimum free-space reserve is crossed.
- Existing tablet wake samples are not moved or deleted. The existing Share samples archive continues to contain old WAV/CSV data and now includes sidecar JSON metadata.

## Limitations to validate on hardware

Android can restart a sticky foreground service after ordinary process reclamation, but force-stop, reboot, battery-management policy, revoked microphone permission, and OEM restrictions can prevent or stop microphone capture. The tablet must display an ongoing notification while recording. Verify screen-off behavior and a one-hour run on the actual Galaxy Tab S5e; no software build can certify the device's battery-policy configuration by itself.

The upload transport is plain HTTP intended for an isolated trusted LAN. Do not use public Wi-Fi or expose the bearer token to untrusted devices. Add TLS at a trusted local reverse proxy if the LAN itself is not trusted.
