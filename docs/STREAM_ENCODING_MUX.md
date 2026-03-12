# Stream Encoding: Mux RTMP Integration

The client will use **Mux** for live streaming. Mux accepts RTMP ingest.

## Current Implementation

- **iOS**: HaishinKit handles encoding + RTMP. Turn on Stream Capture to send to the configured URL.
- **Android**: RootEncoder + frame queue wired. Full MediaCodec → sendVideo flow needs completion.

## Testing with a local RTMP server

1. Run [MediaMTX](https://github.com/bluenviron/mediamtx) or nginx-rtmp locally.
2. Use URL `rtmp://localhost:1935/live/stream` (or your server's URL).
3. Play the stream in VLC: `ffplay rtmp://localhost:1935/live/stream`

## Mux RTMP URL format

| Use case | URL |
|----------|-----|
| Standard RTMP | `rtmp://global-live.mux.com:5222/app` |
| Secure RTMPS | `rtmps://global-live.mux.com:443/app` |

**Important:** Mux uses port **5222** (not the usual 1935).

## Full ingest URL

```
rtmp://global-live.mux.com:5222/app/{STREAM_KEY}
```

The **Stream Key** comes from creating a live stream via the [Mux API](https://www.mux.com/docs/guides/start-live-streaming).

## Encoder settings (Mux recommendations)

Current encoder is already aligned with Mux:

| Setting | Current | Mux recommendation |
|---------|---------|--------------------|
| Video codec | H.264 Main | H.264 Main |
| Keyframe interval | 2 s (30 frames @ 15 fps) | 2 s |
| Frame rate | 15 fps | 15–30 fps |
| Bitrate | Auto (VideoToolbox) | 1000–5000 kbps depending on resolution |

## Next step: RTMP client

Right now the encoder produces H.264 but does **not** send it over RTMP. To stream to Mux:

1. Add an RTMP client library (e.g. [HaishinKit](https://github.com/shogo4405/HaishinKit.swift) or [librtmp](https://github.com/ut0py/librtmp))
2. In the `VTCompressionSession` output callback, convert each `CMSampleBuffer` to FLV video tags and send via RTMP
3. Connect to `rtmp://global-live.mux.com:5222/app/{STREAM_KEY}` before encoding
4. Send SPS/PPS (from format description) as FLV sequence header, then append each encoded frame

## Mux live stream creation (server-side)

Create a live stream via Mux API to get the stream key:

```bash
curl https://api.mux.com/video/v1/live_streams \
  -H "Content-Type: application/json" \
  -u "$MUX_TOKEN_ID:$MUX_TOKEN_SECRET" \
  -d '{
    "playback_policy": ["public"],
    "new_asset_settings": { "playback_policy": ["public"] }
  }'
```

Response includes `stream_key` and `playback_ids` for the viewer URL.
