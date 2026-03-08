# Core ML Module (iOS)

Expo native module for running Core ML models (e.g. YOLO) on iOS with Neural Engine.

## Adding the model

1. Place `new_best.mlpackage` in your app’s **iOS project** (e.g. `my-app/ios/`).
2. In Xcode: **File → Add Files to "myapp"** → select `new_best.mlpackage` → ensure **Copy items if needed** and the **myapp** target are checked.
3. In the **myapp** target → **Build Phases** → **Copy Bundle Resources** → click **+** and add `new_best.mlpackage` if it’s not already there.

The app will load `new_best` on iOS and use it for inference; on Android it falls back to TFLite.
