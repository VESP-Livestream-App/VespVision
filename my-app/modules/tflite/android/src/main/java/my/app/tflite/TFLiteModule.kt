package my.app.tflite

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import org.tensorflow.lite.Interpreter
import java.io.FileInputStream
import java.nio.channels.FileChannel
import java.nio.ByteBuffer
import java.nio.ByteOrder

class TFLiteModule : Module() {
  private var interpreter: Interpreter? = null

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
        
        interpreter = Interpreter(buffer)
        interpreter?.allocateTensors()
        promise.resolve(true)
      } catch (e: Exception) {
        promise.reject("MODEL_LOAD_ERROR", "Error loading model: ${e.message}", e)
      }
    }

    AsyncFunction("runInference") { inputArray: List<Double>, inputShape: List<Int>, promise: Promise ->
      val interpreter = interpreter
      if (interpreter == null) {
        promise.reject("MODEL_NOT_LOADED", "Model not loaded. Call loadModel first.", null)
        return@AsyncFunction
      }

      try {
        val floatInput = FloatArray(inputArray.size) { inputArray[it].toFloat() }
        val inputBuffer = ByteBuffer.allocateDirect(floatInput.size * 4).order(ByteOrder.nativeOrder())
        floatInput.forEach { inputBuffer.putFloat(it) }
        
        val outputTensor = interpreter.getOutputTensor(0)
        val outputShape = outputTensor.shape() 
        var outputSize = 1
        for (dim in outputShape) outputSize *= dim
        
        val outputBuffer = ByteBuffer.allocateDirect(outputSize * 4).order(ByteOrder.nativeOrder())
        
        interpreter.run(inputBuffer, outputBuffer)
        
        outputBuffer.rewind()
        val result = ArrayList<Double>()
        while (outputBuffer.hasRemaining()) {
            result.add(outputBuffer.float.toDouble())
        }
        
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("INFERENCE_ERROR", "Error running inference: ${e.message}", e)
      }
    }

    AsyncFunction("close") { promise: Promise ->
      interpreter?.close()
      interpreter = null
      promise.resolve(null)
    }
  }
}
