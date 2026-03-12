const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');
const {
  addBuildSourceFileToGroup,
  getPbxproj,
  getProjectName,
} = require('@expo/config-plugins/build/ios/utils/Xcodeproj');
const Paths = require('@expo/config-plugins/build/ios/Paths');

const PLUGIN_SOURCE_DIR_IOS = path.join(__dirname, 'streaming-frame-processor-ios');
const PLUGIN_SOURCE_DIR_ANDROID = path.join(__dirname, 'streaming-frame-processor-android');
const SWIFT_FILE = 'StreamingFrameProcessorPlugin.swift';
const M_TEMPLATE = 'StreamingFrameProcessorPluginExport.m.template';
const M_FILE = 'StreamingFrameProcessorPluginExport.m';
const ANDROID_PLUGIN_FILES = ['StreamingFrameProcessorPlugin.kt', 'StreamingFrameProcessorPluginPackage.kt'];

function withStreamingFrameProcessorPlugin(config) {
  let cfg = config;
  cfg = withDangerousMod(cfg, [
    'ios',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const platformRoot = config.modRequest.platformProjectRoot;

      if (!fs.existsSync(platformRoot)) {
        console.warn('[withStreamingFrameProcessorPlugin] ios folder not found, skipping (run prebuild first)');
        return config;
      }

      const projectName = getProjectName(projectRoot);
      const appDir = path.join(platformRoot, projectName);

      if (!fs.existsSync(appDir)) {
        console.warn('[withStreamingFrameProcessorPlugin] app dir not found:', appDir);
        return config;
      }

      const swiftSrc = path.join(PLUGIN_SOURCE_DIR_IOS, SWIFT_FILE);
      const mTemplatePath = path.join(PLUGIN_SOURCE_DIR_IOS, M_TEMPLATE);

      if (!fs.existsSync(swiftSrc) || !fs.existsSync(mTemplatePath)) {
        console.warn('[withStreamingFrameProcessorPlugin] iOS plugin source files not found in', PLUGIN_SOURCE_DIR_IOS);
        return config;
      }

      fs.copyFileSync(swiftSrc, path.join(appDir, SWIFT_FILE));

      let mContent = fs.readFileSync(mTemplatePath, 'utf8');
      mContent = mContent.replace(/__PROJECT_NAME__/g, projectName);
      fs.writeFileSync(path.join(appDir, M_FILE), mContent, 'utf8');

      const projectPath = Paths.getPBXProjectPath(projectRoot);
      const project = getPbxproj(projectRoot);

      const filepathSwift = `${projectName}/${SWIFT_FILE}`;
      const filepathM = `${projectName}/${M_FILE}`;

      if (!project.hasFile(filepathSwift)) {
        addBuildSourceFileToGroup({
          filepath: filepathSwift,
          groupName: projectName,
          project,
        });
      }
      if (!project.hasFile(filepathM)) {
        addBuildSourceFileToGroup({
          filepath: filepathM,
          groupName: projectName,
          project,
        });
      }

      fs.writeFileSync(projectPath, project.writeSync(), 'utf8');
      console.log('[withStreamingFrameProcessorPlugin] Added streaming frame processor plugin to iOS project');

      return config;
    },
  ]);

  cfg = withDangerousMod(cfg, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const platformRoot = config.modRequest.platformProjectRoot;
      const packageName = (config.expo?.android?.package ?? 'com.eason.myapp').trim();
      const javaDir = path.join(platformRoot, 'app', 'src', 'main', 'java', ...packageName.split('.'));

      if (!fs.existsSync(platformRoot)) {
        console.warn('[withStreamingFrameProcessorPlugin] android folder not found, skipping (run prebuild first)');
        return config;
      }

      if (!fs.existsSync(javaDir)) {
        fs.mkdirSync(javaDir, { recursive: true });
      }

      for (const file of ANDROID_PLUGIN_FILES) {
        const srcPath = path.join(PLUGIN_SOURCE_DIR_ANDROID, file);
        const destPath = path.join(javaDir, file);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
          console.log('[withStreamingFrameProcessorPlugin] Copied', file, 'to Android');
        } else {
          console.warn('[withStreamingFrameProcessorPlugin] Android plugin file not found:', srcPath);
        }
      }

      const mainApplicationPath = path.join(javaDir, 'MainApplication.kt');
      if (fs.existsSync(mainApplicationPath)) {
        let mainApp = fs.readFileSync(mainApplicationPath, 'utf8');
        if (!mainApp.includes('StreamingFrameProcessorPluginPackage')) {
          mainApp = mainApp.replace(
            '// add(MyReactNativePackage())',
            'add(StreamingFrameProcessorPluginPackage())'
          );
          fs.writeFileSync(mainApplicationPath, mainApp, 'utf8');
          console.log('[withStreamingFrameProcessorPlugin] Registered StreamingFrameProcessorPluginPackage in MainApplication');
        }
      }

      return config;
    },
  ]);

  return cfg;
}

module.exports = withStreamingFrameProcessorPlugin;
