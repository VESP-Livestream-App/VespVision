import AVFoundation
import CoreMedia
import CoreVideo
import ExpoModulesCore
import Foundation
import HaishinKit
import VideoToolbox

public class StreamingModule: Module {
  private static let maxQueueSize = 3
  private static let queue = StreamingFrameQueue(maxSize: maxQueueSize)
  private static weak var sharedInstance: StreamingModule?

  private var encoderThread: Thread?
  private var isStreaming = false
  private var streamUrl: String?
  private var rtmpConnection: RTMPConnection?
  private var rtmpStream: RTMPStream?
  private var isReadyToSend = false
  private var frameCount: Int64 = 0
  private var lastConnectionStatus: String = "idle"
  private var width: Int32 = 0
  private var height: Int32 = 0

  public func definition() -> ModuleDefinition {
    Name("StreamingModule")

    Events("onDebugLog")

    OnCreate {
      StreamingModule.sharedInstance = self
    }

    AsyncFunction("startStreaming") { (url: String, promise: Promise) in
      DispatchQueue.main.async {
        guard !self.isStreaming else {
          promise.resolve(nil)
          return
        }
        Self.enqueueCount = 0
        self.streamUrl = url
        self.isStreaming = true
        self.isReadyToSend = false
        self.frameCount = 0
    Task {
      let ok = await self.setupAndConnectRTMP(url: url)
      self.isReadyToSend = ok
      Self.debugLog("isReadyToSend = \(ok)")
    }
        self.encoderThread = Thread { [weak self] in
          self?.runEncoderLoop()
        }
        self.encoderThread?.start()
        print("LOG  📹 StreamingModule: started streaming to \(url)")
        promise.resolve(nil)
      }
    }

    AsyncFunction("stopStreaming") { (promise: Promise) in
      DispatchQueue.main.async {
        Self.enqueueCount = 0
        self.isStreaming = false
        self.isReadyToSend = false
        self.encoderThread = nil
        Task {
          await self.disconnectRTMP()
        }
        print("LOG  📹 StreamingModule: stopped streaming (encoded \(self.frameCount) frames)")
        promise.resolve(nil)
      }
    }

    Function("isStreaming") { () -> Bool in
      self.isStreaming
    }

    Function("getEncodedFrameCount") { () -> Int in
      Int(self.frameCount)
    }

    Function("getConnectionStatus") { () -> String in
      self.lastConnectionStatus
    }
  }

  private static var enqueueCount: Int64 = 0

  /// Called by StreamingFrameProcessorPlugin to enqueue frames. No bridge.
  public static func enqueueFrame(_ pixelBuffer: CVPixelBuffer) {
    queue.enqueue(pixelBuffer)
    enqueueCount += 1
    if enqueueCount % 30 == 1 {
      let w = CVPixelBufferGetWidth(pixelBuffer)
      let h = CVPixelBufferGetHeight(pixelBuffer)
      debugLog("enqueueFrame: \(enqueueCount) total (\(w)×\(h))")
    }
  }

  private static func debugLog(_ message: String) {
    let msg = "LOG  📹 [DEBUG] \(message)"
    print(msg)
    DispatchQueue.main.async {
      sharedInstance?.sendEvent("onDebugLog", ["message": msg])
    }
  }

  private func parseRTMPURL(_ url: String) -> (scheme: String, host: String, port: Int, app: String, streamName: String)? {
    guard let parsed = URL(string: url),
          let scheme = parsed.scheme,
          scheme.hasPrefix("rtmp") else { return nil }
    let host = parsed.host ?? "localhost"
    let port = parsed.port ?? (scheme == "rtmps" ? 443 : 1935)
    let pathComponents = parsed.path.split(separator: "/").map(String.init)
    guard pathComponents.count >= 2 else { return nil }
    let app = pathComponents[0]
    let streamName = pathComponents[1...].joined(separator: "/")
    return (scheme, host, port, app, streamName.isEmpty ? "stream" : streamName)
  }

  private func setupAndConnectRTMP(url: String) async -> Bool {
    lastConnectionStatus = "connecting"
    guard let parsed = parseRTMPURL(url) else {
      lastConnectionStatus = "invalid_url"
      print("LOG  ❌ StreamingModule: invalid RTMP URL: \(url)")
      return false
    }
    // Disable E-RTMP HEVC params so MediaMTX expects standard H.264/AVC (not hvc1)
    let connection = RTMPConnection(
      fourCcList: nil,
      videoFourCcInfoMap: nil,
      audioFourCcInfoMap: nil,
      capsEx: 0
    )
    let stream = RTMPStream(connection: connection)
    await stream.setVideoSettings(VideoCodecSettings(
      videoSize: CGSize(width: 1920, height: 1080),
      bitRate: 2_000_000,
      profileLevel: kVTProfileLevel_H264_Baseline_AutoLevel as String,
      maxKeyFrameIntervalDuration: 2
    ))
    rtmpConnection = connection
    rtmpStream = stream
    let connectURL = "\(parsed.scheme)://\(parsed.host):\(parsed.port)/\(parsed.app)/"
    do {
      try await connection.connect(connectURL)
      print("LOG  📹 StreamingModule: RTMP connected")
      try await stream.publish(parsed.streamName)
      lastConnectionStatus = "connected"
      print("LOG  📹 StreamingModule: RTMP publishing \(parsed.streamName)")
      return true
    } catch {
      lastConnectionStatus = "failed: \(error.localizedDescription)"
      print("LOG  ❌ StreamingModule: RTMP error: \(error)")
      rtmpConnection = nil
      rtmpStream = nil
      return false
    }
  }

  private func disconnectRTMP() async {
    lastConnectionStatus = "idle"
    if let stream = rtmpStream {
      _ = try? await stream.close()
    }
    if let connection = rtmpConnection {
      try? await connection.close()
    }
    rtmpConnection = nil
    rtmpStream = nil
  }

  private func runEncoderLoop() {
    while isStreaming {
      guard let buffer = StreamingModule.queue.dequeue() else {
        Thread.sleep(forTimeInterval: 0.005)
        continue
      }
      let w = Int32(CVPixelBufferGetWidth(buffer))
      let h = Int32(CVPixelBufferGetHeight(buffer))
      if width != w || height != h {
        width = w
        height = h
        Self.debugLog("encoder: pixel buffer size \(w)×\(h)")
      }
      guard isReadyToSend, let stream = rtmpStream else {
        Thread.sleep(forTimeInterval: 0.005)
        continue
      }
      var formatDesc: CMFormatDescription?
      CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer, formatDescriptionOut: &formatDesc)
      guard let format = formatDesc else { continue }
      // 15 fps: each frame = 90000/15 = 6000 units at 90kHz for strict monotonic PTS
      let ptsValue = frameCount * 6000
      var timing = CMSampleTimingInfo(
        duration: CMTime(value: 6000, timescale: 90000),
        presentationTimeStamp: CMTime(value: ptsValue, timescale: 90000),
        decodeTimeStamp: .invalid
      )
      var sampleBuffer: CMSampleBuffer?
      let status = CMSampleBufferCreateForImageBuffer(
        allocator: nil,
        imageBuffer: buffer,
        dataReady: true,
        makeDataReadyCallback: nil,
        refcon: nil,
        formatDescription: format,
        sampleTiming: &timing,
        sampleBufferOut: &sampleBuffer
      )
      guard status == noErr, let sample = sampleBuffer else { continue }
      let sema = DispatchSemaphore(value: 0)
      Task {
        await stream.append(sample)
        sema.signal()
      }
      sema.wait()
      frameCount += 1
      if frameCount % 30 == 1 {
        Self.debugLog("Encoder: sent \(frameCount) frames (\(w)×\(h))")
      }
    }
  }
}

private final class StreamingFrameQueue {
  private let lock = NSLock()
  private var buffers: [CVPixelBuffer] = []
  private let maxSize: Int

  init(maxSize: Int) {
    self.maxSize = maxSize
  }

  func enqueue(_ buffer: CVPixelBuffer) {
    lock.lock()
    defer { lock.unlock() }
    if buffers.count >= maxSize {
      buffers.removeFirst()
    }
    buffers.append(buffer)
  }

  func dequeue() -> CVPixelBuffer? {
    lock.lock()
    defer { lock.unlock() }
    guard !buffers.isEmpty else { return nil }
    return buffers.removeFirst()
  }
}
