package my.app.tflite

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import org.tensorflow.lite.Interpreter
// import org.tensorflow.lite.Delegate
// import org.tensorflow.lite.gpu.CompatibilityList
// import org.tensorflow.lite.gpu.GpuDelegate
import java.io.FileInputStream
import java.nio.channels.FileChannel
import java.nio.ByteBuffer
import java.nio.ByteOrder

class TFLiteModule : Module() {
  private var interpreter: Interpreter? = null
  // private var gpuDelegate: GpuDelegate? = null

  override fun definition() = ModuleDefinition {
    Name("TFLiteModule")

    AsyncFunction("loadModel") { modelPath: String, promise: Promise ->
      try {
        val context = appContext.reactContext ?: throw Exception("Context not found")
        val fileDescriptor = context.assets.openFd(modelPath)
        val inputStream = FileInputStream(fileDescriptor.fileDescriptor)
        val fileChannel = inputStream.channel
        val startOffset = fileDescriptor.startOffset
        val declaredLength = fileDescriptor.declaredLength
        val buffer = fileChannel.map(FileChannel.MapMode.READ_ONLY, startOffset, declaredLength)
        
        // Initialize Options
        val options = Interpreter.Options()
        
        try {
            // Attempt to use NNAPI for acceleration
            // options.setUseNNAPI(true)
            
            /*
            val compatList = CompatibilityList()
            if (compatList.isDelegateSupportedOnThisDevice) {
                val delegateOptions = compatList.bestOptionsForThisDevice
                gpuDelegate = GpuDelegate(delegateOptions)
                options.addDelegate(gpuDelegate as Delegate)
            } else {
                // Fallback to XNNPACK (enabled by default)
            }
            */
        } catch (e: Exception) {
            e.printStackTrace()
        }
        
        // Set number of threads for CPU fallback
        options.setNumThreads(4)

        interpreter = Interpreter(buffer, options)
        interpreter?.allocateTensors()
        promise.resolve(true)
      } catch (e: Exception) {
        promise.reject("MODEL_LOAD_ERROR", "Error loading model: ${e.message}", e)
      }
    }

    // Accept List<Double> (0-1 normalized) from JS so iOS and Android share the same bridge type and avoid Uint8Array crash on iOS
    AsyncFunction("runInference") { inputArray: List<Double>, inputShape: List<Int>, promise: Promise ->
      val interpreter = interpreter
      if (interpreter == null) {
        promise.reject("MODEL_NOT_LOADED", "Model not loaded. Call loadModel first.", null)
        return@AsyncFunction
      }

      try {
        val inputTensor = interpreter.getInputTensor(0)
        val inputDataType = inputTensor.dataType()
        
        android.util.Log.d("TFLiteModule", "Input Tensor: Type=$inputDataType, Bytes=${inputTensor.numBytes()}")

        val numElements = inputArray.size
        val inputBuffer: ByteBuffer

        if (inputDataType == org.tensorflow.lite.DataType.FLOAT32 && inputTensor.numBytes() == numElements * 4) {
             inputBuffer = ByteBuffer.allocateDirect(inputTensor.numBytes()).order(ByteOrder.nativeOrder())
             val floatView = inputBuffer.asFloatBuffer()
             for (v in inputArray) {
                 floatView.put(v.toFloat())
             }
        } else if (inputDataType == org.tensorflow.lite.DataType.UINT8 && inputTensor.numBytes() == numElements) {
             inputBuffer = ByteBuffer.allocateDirect(numElements).order(ByteOrder.nativeOrder())
             for (v in inputArray) {
                 inputBuffer.put((v.coerceIn(0.0, 1.0) * 255).toInt().toByte())
             }
        } else {
             promise.reject("INPUT_SIZE_MISMATCH", "Model expects ${inputTensor.numBytes()} bytes but input has $numElements elements. Check input shape/type.", null)
             return@AsyncFunction
        }
        
        val outputTensor = interpreter.getOutputTensor(0)
        val outputBytesNeeded = outputTensor.numBytes()
        
        android.util.Log.d("TFLiteModule", "Output Tensor: Type=${outputTensor.dataType()}, Bytes=$outputBytesNeeded")

        val outputBuffer = ByteBuffer.allocateDirect(outputBytesNeeded).order(ByteOrder.nativeOrder())
        
        interpreter.run(inputBuffer, outputBuffer)
        
        outputBuffer.rewind()
        
        val result = ArrayList<Double>()
        if (outputTensor.dataType() == org.tensorflow.lite.DataType.FLOAT32) {
             val floatOut = outputBuffer.asFloatBuffer()
             val numFloats = outputBytesNeeded / 4
             for (i in 0 until numFloats) {
                 result.add(floatOut.get(i).toDouble())
             }
        } else if (outputTensor.dataType() == org.tensorflow.lite.DataType.UINT8) {
             // Handle quantized output if needed
             for (i in 0 until outputBytesNeeded) {
                 result.add((outputBuffer.get(i).toInt() and 0xFF).toDouble())
             }
        } else {
             // Attempt generic float read
             try {
                val floatOut = outputBuffer.asFloatBuffer()
                val numFloats = outputBytesNeeded / 4
                for (i in 0 until numFloats) {
                    result.add(floatOut.get(i).toDouble())
                }
             } catch (e: Exception) {
                 promise.reject("UNSUPPORTED_OUTPUT_TYPE", "Output type ${outputTensor.dataType()} not yet supported", null)
                 return@AsyncFunction
             }
        }
        
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("INFERENCE_ERROR", "Error running inference: ${e.message}", e)
      }
    }

    AsyncFunction("close") { promise: Promise ->
      // gpuDelegate?.close()
      // gpuDelegate = null
      interpreter?.close()
      interpreter = null
      promise.resolve(null)
    }
  }
}
