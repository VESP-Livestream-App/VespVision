import CoreImage
import CoreMLModule
import CoreVideo
import Foundation
import UIKit
import VisionCamera

/// Frame Processor Plugin: takes camera frame → resize+letterbox to 640×640 → Core ML inference → returns detections.
/// Call from JS: `runYOLOFromFrame(frame)`. No 1.23M numbers over the bridge.
@objc(YOLOFrameProcessorPlugin)
public class YOLOFrameProcessorPlugin: FrameProcessorPlugin {
  private static let targetSize = 640

  public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]! = [:]) {
    super.init(proxy: proxy, options: options)
  }

  public override func callback(_ frame: Frame, withArguments arguments: [AnyHashable: Any]?) -> Any? {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(frame.buffer) else { return nil }
    guard let input640 = Self.resizeAndLetterbox(pixelBuffer, to: Self.targetSize) else { return nil }
    let result = CoreMLModule.runInferenceFromPixelBuffer(input640)
    return result
  }

  /// Resize CVPixelBuffer to targetSize×targetSize with letterbox (black padding). Returns new CVPixelBuffer.
  private static func resizeAndLetterbox(_ source: CVPixelBuffer, to targetSize: Int) -> CVPixelBuffer? {
    let w = CVPixelBufferGetWidth(source)
    let h = CVPixelBufferGetHeight(source)
    guard w > 0, h > 0 else { return nil }

    let scale = min(Double(targetSize) / Double(w), Double(targetSize) / Double(h))
    let scaledW = Int(round(Double(w) * scale))
    let scaledH = Int(round(Double(h) * scale))
    let padX = (targetSize - scaledW) / 2
    let padY = (targetSize - scaledH) / 2

    let ciImage = CIImage(cvPixelBuffer: source)
    let scaledImage = ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
      .transformed(by: CGAffineTransform(translationX: CGFloat(padX), y: CGFloat(padY)))
    let blackBg = CIImage(color: CIColor.black).cropped(to: CGRect(x: 0, y: 0, width: targetSize, height: targetSize))
    let composited = scaledImage.composited(over: blackBg)

    var dest: CVPixelBuffer?
    let attrs: [String: Any] = [
      kCVPixelBufferCGImageCompatibilityKey as String: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ]
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      targetSize,
      targetSize,
      kCVPixelFormatType_32BGRA,
      attrs as CFDictionary,
      &dest
    )
    guard status == kCVReturnSuccess, let buffer = dest else { return nil }

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let context = CIContext(options: [.useSoftwareRenderer: false])
    context.render(composited, to: buffer, bounds: CGRect(x: 0, y: 0, width: targetSize, height: targetSize), colorSpace: colorSpace)

    return buffer
  }
}
