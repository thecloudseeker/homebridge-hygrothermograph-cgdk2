// Fakes Homebridge's api.matter surface (registerPlatformAccessories,
// unregisterPlatformAccessories, updateAccessoryState, uuid.generate,
// deviceTypes) closely enough to exercise this plugin's Matter registration
// and state-push logic without a real Matter server. Modeled directly on
// how homebridge-plugins/homebridge-matter and homebridge-ecovacs actually
// call this API in production - see lib/matterAccessory.js.
//
// `registrationError`, when set, makes registerPlatformAccessories reject
// with it instead of succeeding - mirroring Homebridge's own MatterAPIImpl,
// which rejects with e.g. "Matter is not enabled for this bridge" when
// api.matter is defined only because a *different*, unrelated bridge has
// Matter configured (verified against Homebridge 2.4.0's real source).
function createFakeMatter({ registrationError } = {}) {
  // Keyed by UUID, mirroring how the real Matter server tracks accessories.
  const accessories = new Map();
  // Every updateAccessoryState call ever made, in order, so tests can assert
  // on both the latest value and the full push history (e.g. dedup, or that
  // a stale reading did not push anything).
  const stateUpdates = [];

  return {
    accessories,
    stateUpdates,
    uuid: {
      generate: (seed) => `matter-uuid:${seed}`,
    },
    deviceTypes: {
      BridgedNode: "BridgedNode",
      TemperatureSensor: "TemperatureSensor",
      HumiditySensor: "HumiditySensor",
    },
    async registerPlatformAccessories(
      pluginIdentifier,
      platformName,
      accessoryList,
    ) {
      if (registrationError != null) {
        throw registrationError;
      }
      for (const accessory of accessoryList) {
        accessories.set(accessory.UUID, accessory);
      }
    },
    async unregisterPlatformAccessories(
      pluginIdentifier,
      platformName,
      accessoryList,
    ) {
      for (const accessory of accessoryList) {
        accessories.delete(accessory.UUID);
      }
    },
    async updateAccessoryState(uuid, cluster, attributes, partId) {
      stateUpdates.push({ uuid, cluster, attributes, partId });
    },
    async getAccessoryState(uuid, cluster, partId) {
      for (let i = stateUpdates.length - 1; i >= 0; i -= 1) {
        const update = stateUpdates[i];
        if (
          update.uuid === uuid &&
          update.cluster === cluster &&
          update.partId === partId
        ) {
          return update.attributes;
        }
      }
      return undefined;
    },
  };
}

// A recording double for lib/matterAccessory.js's Cgdk2MatterAccessory,
// for tests that only care whether/what the accessory handler pushes to it
// (e.g. that setTemperature forwards the offset-adjusted value), without
// exercising the full api.matter registration plumbing above.
function createFakeMatterAccessory() {
  return {
    temperatureCalls: [],
    humidityCalls: [],
    batteryCalls: [],
    async updateTemperature(celsius) {
      this.temperatureCalls.push(celsius);
    },
    async updateHumidity(percent) {
      this.humidityCalls.push(percent);
    },
    async updateBattery(percent, lowThreshold) {
      this.batteryCalls.push(
        lowThreshold === undefined ? [percent] : [percent, lowThreshold],
      );
    },
  };
}

module.exports = { createFakeMatter, createFakeMatterAccessory };
