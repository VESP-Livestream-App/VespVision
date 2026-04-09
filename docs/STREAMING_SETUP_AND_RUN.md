# VespVision RTMP Streaming — Setup & How to Run

## Overview

The VespVision app streams live camera video from an iOS device to an RTMP server. The stream is H.264 (Baseline), 1920×1080 at ~15 fps.

## Prerequisites

- **Mac** with ffmpeg installed: `brew install ffmpeg`
- **iPhone** and Mac on the **same Wi‑Fi network**
- **VespVision app** built and installed on the phone (`npx expo run:ios`)

## App Configuration

The app streams to `rtmp://<MAC_IP>:1935/live/stream`. Set your Mac's IP in:

- **File**: `my-app/screens/CameraFullScreen.tsx` (around line 360, in the Stream Capture toggle handler)
- **Change**: `rtmp://192.168.50.133:1935/live/stream` → `rtmp://<YOUR_MAC_IP>:1935/live/stream`

To find your Mac's IP: `ipconfig getifaddr en0` (or your Wi‑Fi interface).

---

## How to Run

### Step 1: Start the RTMP receiver on the Mac

Open a terminal and run:

```bash
ffmpeg -listen 1 -i rtmp://0.0.0.0:1935/live/stream -c copy -f nut - 2>/dev/null | ffplay -
```

This makes ffmpeg listen on port 1935 and displays the stream in an ffplay window. **Leave this running.**

### Step 2: Start the app and stream

1. Run the app: `cd my-app && npx expo run:ios`
2. Open the camera screen
3. Turn **Stream Capture** ON
4. The ffplay window on the Mac should show the live stream

### Step 3: Stop

- Turn Stream Capture OFF in the app
- Press `q` in the ffplay window, or Ctrl+C in the terminal

---

## Alternative: Save to file

To record instead of viewing live:

```bash
ffmpeg -listen 1 -i rtmp://0.0.0.0:1935/live/stream -c copy -t 60 output.mp4
```

Then play with `ffplay output.mp4`.

---

## Architecture Summary

```
iPhone (VespVision)                    Mac
┌─────────────────────┐               ┌─────────────────────────┐
│ Camera → Frame Proc │   RTMP        │ ffmpeg -listen          │
│ → Enqueue → Encode  │ ───────────►  │ → ffplay (or file)      │
│ H.264 1920×1080     │  port 1935    │                         │
└─────────────────────┘               └─────────────────────────┘
```

- **iOS**: HaishinKit RTMP + VideoToolbox H.264
- **URL**: `rtmp://<MAC_IP>:1935/live/stream`
- **Format**: H.264 Baseline, 15 fps

---

## Troubleshooting

| Issue | Check |
|-------|-------|
| ffplay shows one frame then stops | Rebuild the app after the timestamp fix. PTS must be monotonic. |
| "Connection refused" | ffmpeg must be running *before* you turn on Stream Capture. |
| No stream | Phone and Mac on same network; correct `rtmp://` URL with Mac's IP. |
| Firewall blocks port 1935 | Allow inbound TCP 1935, or disable firewall for testing. |

---

## Note on MediaMTX

MediaMTX can be used for HLS/WebRTC, but it currently times out with this setup. For viewing, use ffmpeg + ffplay as above.
