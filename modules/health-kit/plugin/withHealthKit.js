/**
 * Expo config plugin for HealthKit.
 *
 * HealthKit will not function without three things in the built app, and all
 * three are native-project concerns that `app.json` alone cannot express:
 *
 *   1. The `com.apple.developer.healthkit` entitlement.
 *   2. `NSHealthShareUsageDescription` in Info.plist. Without it iOS
 *      terminates the app the moment it asks for authorization — it is a hard
 *      crash, not a denied prompt.
 *   3. The HealthKit device capability, so the App Store does not offer the
 *      app to devices that cannot run it.
 *
 * This plugin injects all three during `expo prebuild`, which keeps the native
 * projects generated rather than checked in.
 */

const {
  withEntitlementsPlist,
  withInfoPlist,
  createRunOncePlugin,
} = require('expo/config-plugins');

const DEFAULT_SHARE_USAGE =
  'Running OS reads your workouts, heart rate, running metrics and sleep to calculate your training load, recovery and readiness.';

/**
 * @param {import('expo/config').ExpoConfig} config
 * @param {{ healthSharePermission?: string, backgroundDelivery?: boolean }} [options]
 */
const withHealthKit = (config, options = {}) => {
  // --- Entitlements --------------------------------------------------------
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.developer.healthkit'] = true;

    // Background delivery lets iOS wake the app when new samples arrive.
    // Opt-in, because it requires justification during App Review.
    if (options.backgroundDelivery) {
      const existing = mod.modResults['com.apple.developer.healthkit.access'] || [];
      mod.modResults['com.apple.developer.healthkit.access'] = Array.from(
        new Set([...existing, 'health-records']),
      );
    }
    return mod;
  });

  // --- Info.plist ----------------------------------------------------------
  config = withInfoPlist(config, (mod) => {
    // Read permission. Omitting this crashes the app at the authorization call.
    mod.modResults.NSHealthShareUsageDescription =
      options.healthSharePermission ??
      mod.modResults.NSHealthShareUsageDescription ??
      DEFAULT_SHARE_USAGE;

    // The app never writes to HealthKit, so no NSHealthUpdateUsageDescription
    // is declared. Requesting write access it does not use would be asking for
    // a permission under false pretences.

    // Advertise the requirement so the App Store filters incompatible devices.
    const capabilities = mod.modResults.UIRequiredDeviceCapabilities || [];
    if (!capabilities.includes('healthkit')) {
      mod.modResults.UIRequiredDeviceCapabilities = [...capabilities, 'healthkit'];
    }

    if (options.backgroundDelivery) {
      const modes = mod.modResults.UIBackgroundModes || [];
      if (!modes.includes('processing')) {
        mod.modResults.UIBackgroundModes = [...modes, 'processing'];
      }
    }

    return mod;
  });

  return config;
};

module.exports = createRunOncePlugin(withHealthKit, 'running-health-kit', '0.1.0');
