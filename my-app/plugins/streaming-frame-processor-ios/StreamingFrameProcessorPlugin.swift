import CoreVideo
import Foundation
import StreamingModule
import VisionCamera

/// Frame Processor Plugin: receives full-resolution camera frames for streaming.
/// Enqueues to StreamingModule for H.264 encoding. O(1) — no copy, no bridge.
/// Call from JS: `enqueueStreamFrame(frame)`.
@objc(StreamingFrameProcessorPlugin)
public class StreamingFrameProcessorPlugin: FrameProcessorPlugin {
  public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]! = [:]) {
    super.init(proxy: proxy, options: options)
  }

  public override func callback(_ frame: Frame, withArguments arguments: [AnyHashable: Any]?) -> Any? {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(frame.buffer) else { return nil }
    StreamingModule.enqueueFrame(pixelBuffer)
    return nil
  }
}
