package my.app.streaming

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.util.Log
import com.mrousavy.camera.frameprocessors.Frame
import com.pedro.rtmp.rtmp.RtmpClient
import com.pedro.rtmp.utils.ConnectChecker
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class StreamingModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StreamingModule")

    AsyncFunction("startStreaming") { url: String, promise: Promise ->
      if (isStreaming.get()) {
        promise.resolve(null)
        return@AsyncFunction
      }
      streamUrl = url
      isStreaming.set(true)
      frameCount.set(0)
      encoderThread = Thread { runEncoderLoop() }
      encoderThread?.start()
      Log.d(TAG, "StreamingModule: started streaming to $url")
      promise.resolve(null)
    }

    AsyncFunction("stopStreaming") { promise: Promise ->
      isStreaming.set(false)
      encoderThread = null
      disconnectRtmp()
      Log.d(TAG, "StreamingModule: stopped streaming (encoded ${frameCount.get()} frames)")
      promise.resolve(null)
    }

    Function("isStreaming") { isStreaming.get() }

    Function("getEncodedFrameCount") { frameCount.get() }
  }

  private fun runEncoderLoop() {
    while (isStreaming.get()) {
      val frame = frameQueue.dequeue() ?: run {
        Thread.sleep(5)
        continue
      }
      try {
        if (!frame.isValid) continue
        val image = frame.image ?: continue
        if (rtmpClient == null || !rtmpClient!!.isConnected) {
          connectRtmp(streamUrl)
        }
        rtmpClient?.let { client ->
          if (client.isConnected) {
            encodeAndSend(image, frame)
            frameCount.incrementAndGet()
          }
        }
      } finally {
        try { frame.decrementRefCount() } catch (_: Exception) {}
      }
    }
  }

  private fun connectRtmp(url: String) {
    try {
      val client = RtmpClient(connectChecker)
      client.setOnlyVideo(true)
      client.connect(url)
      rtmpClient = client
      Log.d(TAG, "StreamingModule: RTMP connected to $url")
    } catch (e: Exception) {
      Log.e(TAG, "StreamingModule: RTMP connect failed: ${e.message}")
    }
  }

  private fun disconnectRtmp() {
    try {
      rtmpClient?.disconnect()
    } catch (_: Exception) {}
    rtmpClient = null
  }

  private fun encodeAndSend(image: android.media.Image, frame: Frame) {
    // Simplified: RootEncoder expects specific flow. For now log that we got a frame.
    // Full implementation would: create MediaCodec, feed YUV from Image, get encoded output, send via rtmpClient.sendVideo()
    if (frameCount.get() % 30 == 1L) {
      Log.d(TAG, "Encoder: received frame ${frameCount.get()} (${image.width}x${image.height})")
    }
  }

  companion object {
    private const val TAG = "StreamingModule"
    private const val MAX_QUEUE_SIZE = 3

    private val frameQueue = object {
      private val queue = ConcurrentLinkedQueue<Frame>()
      private val size = AtomicInteger(0)

      fun enqueue(frame: Frame) {
        if (size.get() >= MAX_QUEUE_SIZE) {
          val oldest = queue.poll()
          if (oldest != null) {
            size.decrementAndGet()
            try { oldest.decrementRefCount() } catch (_: Exception) {}
          }
        }
        queue.offer(frame)
        size.incrementAndGet()
      }

      fun dequeue(): Frame? {
        val f = queue.poll() ?: return null
        size.decrementAndGet()
        return f
      }
    }

    @JvmStatic
    fun enqueueFrame(frame: Frame) {
      frameQueue.enqueue(frame)
    }
  }

  private var encoderThread: Thread? = null
  private var streamUrl: String = ""
  private var rtmpClient: RtmpClient? = null
  private val isStreaming = AtomicBoolean(false)
  private val frameCount = AtomicInteger(0)

  private val connectChecker = object : ConnectChecker {
    override fun onConnectionStarted(url: String) {}
    override fun onConnectionSuccess() {
      Log.d(TAG, "RTMP connection success")
    }
    override fun onConnectionFailed(reason: String) {
      Log.e(TAG, "RTMP connection failed: $reason")
    }
    override fun onDisconnect() {
      Log.d(TAG, "RTMP disconnected")
    }
    override fun onAuthError() {}
    override fun onAuthSuccess() {}
  }
}
