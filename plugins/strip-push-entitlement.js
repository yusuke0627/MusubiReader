const { withEntitlementsPlist } = require('expo/config-plugins');

/**
 * Removes `aps-environment` from iOS entitlements during `expo prebuild`.
 * MusubiReader only uses on-device local notifications and does not require
 * the Push Notifications capability.
 */
function stripPushEntitlement(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    if (modConfig.modResults && 'aps-environment' in modConfig.modResults) {
      delete modConfig.modResults['aps-environment'];
    }
    return modConfig;
  });
}

module.exports = stripPushEntitlement;
