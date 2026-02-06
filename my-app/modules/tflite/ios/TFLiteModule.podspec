require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'TFLiteModule'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = "Expo module wrapper around TensorFlow Lite for on-device inference."
  s.license        = 'UNLICENSED'
  s.author         = 'local'
  s.homepage       = 'https://example.com'
  s.source         = { :path => "." }
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'TensorFlowLiteSwift', '~> 2.14.0'

  s.source_files = "**/*.{h,m,swift}"
end
