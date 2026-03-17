const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');
const {
  addBuildSourceFileToGroup,
  getPbxproj,
  getProjectName,
} = require('@expo/config-plugins/build/ios/utils/Xcodeproj');
const Paths = require('@expo/config-plugins/build/ios/Paths');

const PLUGIN_SOURCE_DIR = path.join(__dirname, 'yolo-frame-processor-ios');
const SWIFT_FILE = 'YOLOFrameProcessorPlugin.swift';
const M_TEMPLATE = 'YOLOFrameProcessorPluginExport.m.template';
const M_FILE = 'YOLOFrameProcessorPluginExport.m';

function withYOLOFrameProcessorPlugin(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const platformRoot = config.modRequest.platformProjectRoot;

      if (!fs.existsSync(platformRoot)) {
        console.warn('[withYOLOFrameProcessorPlugin] ios folder not found, skipping (run prebuild first)');
        return config;
      }

      const projectName = getProjectName(projectRoot);
      const appDir = path.join(platformRoot, projectName);

      if (!fs.existsSync(appDir)) {
        console.warn('[withYOLOFrameProcessorPlugin] app dir not found:', appDir);
        return config;
      }

      const swiftSrc = path.join(PLUGIN_SOURCE_DIR, SWIFT_FILE);
      const mTemplatePath = path.join(PLUGIN_SOURCE_DIR, M_TEMPLATE);

      if (!fs.existsSync(swiftSrc) || !fs.existsSync(mTemplatePath)) {
        console.warn('[withYOLOFrameProcessorPlugin] plugin source files not found in', PLUGIN_SOURCE_DIR);
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
      console.log('[withYOLOFrameProcessorPlugin] Added YOLO frame processor plugin to iOS project');

      return config;
    },
  ]);
}

module.exports = withYOLOFrameProcessorPlugin;
