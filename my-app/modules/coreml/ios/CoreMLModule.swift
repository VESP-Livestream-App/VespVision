import ExpoModulesCore
import CoreML
import CoreVideo
import Vision

private struct PixelBufferError: Error {
  let message: String
}

public class CoreMLModule: Module {
  private var model: MLModel?

  public func definition() -> ModuleDefinition {
    Name("CoreMLModule")

    AsyncFunction("loadModel") { (modelName: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          guard let url = Self.resolveModelURL(modelName: modelName) else {
            promise.reject("MODEL_NOT_FOUND", "Core ML model '\(modelName)' not found in bundle.")
            return
          }
          var modelURL = url
          if url.pathExtension == "mlpackage" {
            modelURL = try MLModel.compileModel(at: url)
          }
          let config = MLModelConfiguration()
          if #available(iOS 16.0, *) {
            config.computeUnits = .cpuAndNeuralEngine
          }
          let loadedModel = try MLModel(contentsOf: modelURL, configuration: config)
          self.model = loadedModel
          promise.resolve(true)
        } catch {
          promise.reject("MODEL_LOAD_ERROR", "Error loading Core ML model: \(error.localizedDescription)")
        }
      }
    }

    AsyncFunction("runInference") { (inputArray: [Double], inputShape: [Int], promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        guard let model = self.model else {
          promise.reject("MODEL_NOT_LOADED", "Core ML model not loaded. Call loadModel first.")
          return
        }
        do {
          let floatData = inputArray.map { Float($0) }
          let pixelBufferResult = Self.floatRGBToCVPixelBuffer(floatData: floatData, shape: inputShape)
          let pixelBuffer: CVPixelBuffer
          switch pixelBufferResult {
          case .success(let buffer):
            pixelBuffer = buffer
          case .failure(let err):
            promise.reject("INFERENCE_ERROR", err.message)
            return
          }
          let request = VNCoreMLRequest(model: try VNCoreMLModel(for: model))
          request.imageCropAndScaleOption = .scaleFill
          let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
          try handler.perform([request])

          if let observations = request.results as? [VNRecognizedObjectObservation] {
            var result: [Double] = []
            for obs in observations {
              let box = obs.boundingBox
              let x1 = Double(box.origin.x)
              let y1 = Double(1 - box.origin.y - box.height)
              let x2 = x1 + Double(box.width)
              let y2 = y1 + Double(box.height)
              let conf = Double(obs.confidence)
              let ident = obs.labels.first?.identifier ?? "0"
              let classId = Double(Int(ident) ?? (ident == "basketball" ? 0 : 1))
              result.append(contentsOf: [x1, y1, x2, y2, conf, classId])
            }
            promise.resolve(result)
            return
          }
          if let obsResults = request.results as? [VNCoreMLFeatureValueObservation],
             let first = obsResults.first?.featureValue.multiArrayValue {
            var result: [Double] = []
            for i in 0..<first.count { result.append(first[i].doubleValue) }
            promise.resolve(result)
            return
          }
          promise.reject("INFERENCE_ERROR", "Vision returned no output.")
        } catch {
          promise.reject("INFERENCE_ERROR", "Error: \(error.localizedDescription)")
        }
      }
    }

    AsyncFunction("close") { (promise: Promise) in
      self.model = nil
      promise.resolve(nil)
    }
  }

  private static func floatRGBToCVPixelBuffer(floatData: [Float], shape: [Int]) -> Result<CVPixelBuffer, PixelBufferError> {
    let h: Int
    let w: Int
    if shape.count >= 4 {
      if shape[3] == 3 {
        h = shape[1]
        w = shape[2]
      } else {
        h = shape[2]
        w = shape[3]
      }
    } else {
      h = shape.count >= 2 ? shape[1] : 640
      w = shape.count >= 3 ? shape[2] : 640
    }
    let expectedCount = h * w * 3
    guard h > 0, w > 0 else {
      return .failure(PixelBufferError(message: "Invalid shape: h=\(h) w=\(w)"))
    }
    guard floatData.count >= expectedCount else {
      return .failure(PixelBufferError(message: "Input size \(floatData.count) does not match shape [\(shape.map { String($0) }.joined(separator: ","))] (need \(expectedCount))"))
    }
    let bytesPerRow = (w * 4 + 15) & ~15
    let dataSize = bytesPerRow * h
    let dataPtr = UnsafeMutableRawPointer.allocate(byteCount: dataSize, alignment: 16)
    for y in 0..<h {
      let rowPtr = dataPtr.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
      for x in 0..<w {
        let srcIdx = (y * w + x) * 3
        let r = UInt8(min(255, max(0, floatData[srcIdx] * 255)))
        let g = UInt8(min(255, max(0, floatData[srcIdx + 1] * 255)))
        let b = UInt8(min(255, max(0, floatData[srcIdx + 2] * 255)))
        let dstIdx = x * 4
        rowPtr[dstIdx] = b
        rowPtr[dstIdx + 1] = g
        rowPtr[dstIdx + 2] = r
        rowPtr[dstIdx + 3] = 255
      }
    }
    var pixelBuffer: CVPixelBuffer?
    let attrs = [kCVPixelBufferCGImageCompatibilityKey: kCFBooleanTrue!,
                 kCVPixelBufferCGBitmapContextCompatibilityKey: kCFBooleanTrue!] as CFDictionary
    let status = CVPixelBufferCreateWithBytes(
      kCFAllocatorDefault,
      w, h,
      kCVPixelFormatType_32BGRA,
      dataPtr,
      bytesPerRow,
      { _, dataPointer in
        guard let dataPointer = dataPointer else { return }
        UnsafeMutableRawPointer(mutating: dataPointer).deallocate()
      },
      nil,
      attrs,
      &pixelBuffer
    )
    guard status == kCVReturnSuccess, let buffer = pixelBuffer else {
      dataPtr.deallocate()
      return .failure(PixelBufferError(message: "CVPixelBufferCreateWithBytes failed with status \(status)"))
    }
    return .success(buffer)
  }

  private static func resolveModelURL(modelName: String) -> URL? {
    let name = modelName.replacingOccurrences(of: ".mlpackage", with: "")
    let fullName = "\(name).mlpackage"

    if let url = Bundle.main.url(forResource: name, withExtension: "mlpackage") {
      return url
    }
    if let path = Bundle.main.path(forResource: name, ofType: "mlpackage") {
      return URL(fileURLWithPath: path)
    }
    if let url = Bundle.main.url(forResource: fullName, withExtension: nil) {
      return url
    }
    if let path = Bundle.main.path(forResource: fullName, ofType: nil) {
      return URL(fileURLWithPath: path)
    }
    if let resourcePath = Bundle.main.resourcePath {
      let path = (resourcePath as NSString).appendingPathComponent(fullName)
      if FileManager.default.fileExists(atPath: path) {
        return URL(fileURLWithPath: path)
      }
      if let contents = try? FileManager.default.contentsOfDirectory(atPath: resourcePath) {
        if let match = contents.first(where: { $0 == fullName || $0.hasPrefix("\(name).") }) {
          let matchedPath = (resourcePath as NSString).appendingPathComponent(match)
          return URL(fileURLWithPath: matchedPath)
        }
      }
    }
    return nil
  }
}
