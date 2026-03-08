require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'CoreMLModule'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = "Expo module for Core ML inference (Neural Engine on iOS)."
  s.license        = 'UNLICENSED'
  s.author         = 'local'
  s.homepage       = 'https://example.com'
  s.source         = { :path => "." }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.source_files = "CoreMLModule.swift"
end
