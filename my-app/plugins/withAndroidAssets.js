const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const withAndroidAssets = (config) => {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const androidAssetsPath = path.join(
        projectRoot,
        'android',
        'app',
        'src',
        'main',
        'assets'
      );

      if (!fs.existsSync(androidAssetsPath)) {
        fs.mkdirSync(androidAssetsPath, { recursive: true });
      }

      // Find all .tflite files in the project root
      const files = fs.readdirSync(projectRoot);
      const tfliteFiles = files.filter((file) => file.endsWith('.tflite'));

      tfliteFiles.forEach((file) => {
        const srcPath = path.join(projectRoot, file);
        const destPath = path.join(androidAssetsPath, file);
        fs.copyFileSync(srcPath, destPath);
        console.log(`[withAndroidAssets] Copied ${file} to Android assets`);
      });

      return config;
    },
  ]);
};

module.exports = withAndroidAssets;
