package com.eason.myapp

import androidx.annotation.NonNull
import androidx.annotation.Nullable
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.frameprocessors.FrameProcessorPlugin
import my.app.streaming.StreamingModule
import java.util.Map

/**
 * Frame Processor Plugin: receives full-resolution camera frames for streaming.
 * Enqueues to StreamingModule for RTMP encoding. O(1) — no copy, no bridge.
 * Call from JS: `enqueueStreamFrame(frame)`.
 */
class StreamingFrameProcessorPlugin : FrameProcessorPlugin() {

    override fun callback(@NonNull frame: Frame, @Nullable params: Map<String, Any>?): Any? {
        return try {
            if (!frame.isValid) return null
            frame.incrementRefCount()
            StreamingModule.enqueueFrame(frame)
            null
        } catch (e: Exception) {
            try {
                frame.decrementRefCount()
            } catch (_: Exception) { }
            null
        }
    }
}
