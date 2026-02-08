import ExpoModulesCore
import TensorFlowLite

public class TFLiteModule: Module {
  private var interpreter: Interpreter?

  public func definition() -> ModuleDefinition {
    Name("TFLiteModule")

    AsyncFunction("loadModel") { (modelPath: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          guard let finalPath = Self.resolveModelPath(modelPath) else {
            promise.reject("MODEL_NOT_FOUND", "Model file '\(modelPath)' not found in bundle.")
            return
          }

          let interpreter = try Interpreter(modelPath: finalPath)
          try interpreter.allocateTensors()
          self.interpreter = interpreter
          promise.resolve(true)
        } catch {
          promise.reject("MODEL_LOAD_ERROR", "Error loading model: \(error.localizedDescription)")
        }
      }
    }

    AsyncFunction("runInference") { (inputArray: [Double], inputShape: [Int], promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        guard let interpreter = self.interpreter else {
          promise.reject("MODEL_NOT_LOADED", "Model not loaded. Call loadModel first.")
          return
        }

        do {
          // Always treat as Float32 (working version)
          // TensorFlow Lite handles INT8 internally and exposes Float32
          let floatData = inputArray.map { Float($0) }
          let bufferSize = inputShape.reduce(1, *)
          let inputBuffer = Data(bytes: floatData, count: bufferSize * MemoryLayout<Float>.size)

          try interpreter.copy(inputBuffer, toInputAt: 0)
          try interpreter.invoke()

          let outputTensor = try interpreter.output(at: 0)
          let outputData = outputTensor.data
          let outputCount = outputData.count / MemoryLayout<Float>.size
          let outputBuffer = outputData.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) -> [Float] in
            let floatPointer = bytes.bindMemory(to: Float.self)
            return Array(UnsafeBufferPointer(start: floatPointer.baseAddress, count: outputCount))
          }
          let result = outputBuffer.map { Double($0) }
          promise.resolve(result)
        } catch {
          promise.reject("INFERENCE_ERROR", "Error running inference: \(error.localizedDescription)")
        }
      }
    }

    AsyncFunction("close") { (promise: Promise) in
      self.interpreter = nil
      promise.resolve(nil)
    }
  }

  private static func resolveModelPath(_ modelPath: String) -> String? {
    let modelName = modelPath.replacingOccurrences(of: ".tflite", with: "")
    if let bundlePath = Bundle.main.path(forResource: modelName, ofType: "tflite") {
      return bundlePath
    }
    if let bundlePath = Bundle.main.path(forResource: modelPath, ofType: nil) {
      return bundlePath
    }
    if let bundleResourcePath = Bundle.main.resourcePath {
      let possiblePath = (bundleResourcePath as NSString).appendingPathComponent(modelPath)
      if FileManager.default.fileExists(atPath: possiblePath) {
        return possiblePath
      }
    }
    return nil
  }
}
