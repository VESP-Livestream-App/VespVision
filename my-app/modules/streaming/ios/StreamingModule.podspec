require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'StreamingModule'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = "Expo module for RTMP streaming (H.264 encode from camera frames)."
  s.license        = 'UNLICENSED'
  s.author         = 'local'
  s.homepage       = 'https://example.com'
  s.source         = { :path => "." }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.dependency 'HaishinKit', '~> 2.0'

  s.source_files = "StreamingModule.swift"
  s.frameworks = 'VideoToolbox', 'CoreMedia', 'CoreVideo'
end
