# Stream Encoding Architecture

## Goal

Add RTMP streaming to VespVision on **iOS and Android** while **keeping inference fast** (~15ms native CoreML on iOS, TFLite on Android). Single camera, no second camera.

## Constraints (from previous attempt)

- **Inference must not slow down** — The frame processor runs on every frame; adding encoding work there caused 100ms+ latency. Encoding must be **non-blocking**.
- **No frame data over JS bridge** — Sending 1.2M+ pixels to JS is too slow. Keep encoding fully native.
- **Single camera** — Same camera feeds both preview, inference, and streaming.
- **Full resolution for streaming** — Use the non-downsized camera feed for streaming (highest quality). Inference uses 640×640 for YOLO; streaming uses the full frame (e.g. 1920×1080).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     VisionCamera Frame                           │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Frame Processor (worklet)                        │
│  • FPS counter                                                    │
│  • Inference triggers (snap / live) — PRIORITY, never blocked    │
│  • Streaming: enqueue frame ref ONLY when streaming enabled      │
│    → enqueueStreamFrame(frame) — O(1), no copy, no bridge        │
└────────────────────────────┬────────────────────────────────────┘
                             │
         ┌───────────────────┴───────────────────┐
         │                                       │
         ▼                                       ▼
┌─────────────────────┐               ┌─────────────────────────────┐
│  Inference path     │               │  Streaming path (async)     │
│  (existing)         │               │  • Full-res frame            │
│  • 640×640 for YOLO │               │  • Background thread        │
│  • iOS: CoreML      │               │  • iOS: VTCompress          │
│  • Android: TFLite  │               │  • Android: MediaCodec      │
│  • ~15ms (iOS)      │               │  • RTMP send                │
└─────────────────────┘               └─────────────────────────────┘
```

## Key Design Decisions

### 1. Full-resolution input for streaming

- **Inference**: 640×640 (letterboxed) for YOLO
- **Streaming**: Full camera resolution (e.g. 1920×1080, 1280×720) — no downsize for highest quality

### 2. Non-blocking enqueue

The frame processor only **enqueues a frame reference** when streaming is on. No encoding, no copy. The native plugin:

- Maintains a bounded queue (e.g. 2–3 frames max)
- If queue full → drop oldest, add newest (avoid backlog)
- Background encoder thread drains the queue

### 3. Throttled sampling

- Camera: ~30 fps
- Stream target: 15–30 fps
- Enqueue every 1st or 2nd frame when streaming (configurable)

### 4. Native-only pipeline

- **iOS**: `CVPixelBuffer` (full res) → `VTCompressionSession` (VideoToolbox) → H.264 → RTMP (via libRTMP or similar)
- **Android**: `Image` (full res) → `MediaCodec` → H.264 → RTMP
- No JS involvement in the encoding path

### 5. Streaming toggle

- JS: `startStreaming(rtmpUrl)` / `stopStreaming()`
- Native: starts/stops the encoder thread and RTMP connection

## Components

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `StreamingFrameProcessorPlugin` (iOS) | `plugins/streaming-frame-processor-ios/` | `enqueueStreamFrame(frame)` — O(1) enqueue when streaming on |
| `StreamingFrameProcessorPlugin` (Android) | `plugins/streaming-frame-processor-android/` | Same API — enqueue `Image` for MediaCodec |
| `StreamingModule` | Expo module (ios + android) | `startStreaming(url)`, `stopStreaming()`, encoder lifecycle |
| `CameraFullScreen` | Screen | Toggle streaming, pass `isStreaming` to frame processor (cross-platform) |

## Dependencies

- **iOS**: VideoToolbox (built-in), libRTMP or [librtmp](https://github.com/ut0py/librtmp) for RTMP
- **Android**: MediaCodec, RTMP client (e.g. [rtmp-rtsp-stream-client-java](https://github.com/pedroSG94/rtmp-rtsp-stream-client-java))

## Alternative: FFmpeg Kit

[ffmpeg-kit-react-native](https://github.com/arthenica/ffmpeg-kit) can handle H.264 + RTMP but:

- Large binary size
- Frames would need to be written to a pipe or file, then fed to FFmpeg
- More complex than a focused native module

**Recommendation**: Start with minimal native modules — VideoToolbox + libRTMP on iOS, MediaCodec + RTMP client on Android — for lower overhead.

## Platform parity

| Feature | iOS | Android |
|---------|-----|---------|
| Frame capture | `CVPixelBuffer` from `CMSampleBuffer` | `Image` from `Frame` |
| Encode | `VTCompressionSession` (VideoToolbox) | `MediaCodec` |
| RTMP | libRTMP / HaishinKit | rtmp-rtsp-stream-client-java |
| Frame processor plugin | Swift, `VISION_EXPORT_SWIFT_FRAME_PROCESSOR` | Kotlin/Java, `FrameProcessorPluginRegistry` |
