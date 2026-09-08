Pod::Spec.new do |s|
  s.name           = 'RunningHealthKit'
  s.version        = '0.1.0'
  s.summary        = 'HealthKit bridge for Running OS'
  s.description    = 'Reads workouts, heart rate, running metrics, body and sleep data from HealthKit.'
  s.author         = ''
  s.homepage       = 'https://github.com/trevynfabian-bit/Running-Apps'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # HealthKit is a system framework; linking it is what makes the entitlement
  # meaningful at runtime.
  s.frameworks = 'HealthKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
