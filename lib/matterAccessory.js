const { version } = require("../package.json");
const { cleanAddress } = require("./address");

// Matches homebridge-plugins/homebridge-matter's own TemperatureSensorAccessory
// reference bounds (-50C to 100C), deliberately much wider than the CGDK2's
// physical range (see accessory.js's -10/60 HAP setProps): a configured
// temperatureOffset is added to the real reading before it reaches Matter, so
// a tight bound sized to the sensor's own range could be pushed outside it by
// the offset alone, and Matter rejects (rather than clamps, as HAP does) a
// write outside the declared min/max as a constraint violation.
const MIN_MEASURED_TEMPERATURE = -5000;
const MAX_MEASURED_TEMPERATURE = 10000;

// Matter caps these string fields at 32 characters. Trimming here keeps
// Homebridge's core from truncating them itself and warning about it on
// every single load.
const MAX_MATTER_LABEL_LENGTH = 32;

// PowerSource enum values (Matter Core spec 11.7).
const POWER_SOURCE_STATUS_ACTIVE = 1;
const BAT_CHARGE_LEVEL_OK = 0;
const BAT_CHARGE_LEVEL_WARNING = 1;
const BAT_REPLACEABILITY_UNSPECIFIED = 0;

function label(value) {
  return String(value).slice(0, MAX_MATTER_LABEL_LENGTH);
}

// One physical CGDK2 becomes ONE Matter endpoint carrying temperature,
// humidity and the battery together, declared as both a TemperatureSensor and
// a HumiditySensor (Matter allows several device types on one endpoint).
//
// Controllers differ in what they call a "device": IKEA Dirigera lists every
// sensor endpoint as its own product. Both earlier layouts therefore showed
// up twice there - two flat devices (5.5.2-5.6.x), and a composed BridgedNode
// with separate temperature/humidity child endpoints (5.7.0) - each entry
// showing the same readings. A single endpoint is one product everywhere.
//
// Homebridge has no ready-made combined device type, so this composes one
// from its public api.matter.deviceTypes: TemperatureSensor plus the
// HumiditySensor's relativeHumidityMeasurement behavior. The descriptor's
// deviceTypeList adds HumiditySensor next to TemperatureSensor; matter.js
// adds BridgedNode and PowerSource itself.
class Cgdk2MatterAccessory {
  // Also used by platform.js to recognize (and drop) cached Matter
  // accessories left over from an earlier layout.
  static uuidFor(matter, address) {
    return matter.uuid.generate(
      `homebridge-hygrothermograph-cgdk2:matter:${cleanAddress(address)}:sensor`,
    );
  }

  constructor(matter, log, { address, name }) {
    this.matter = matter;
    this.log = log;
    this.address = address;

    // Set once api.matter.registerPlatformAccessories() for this instance has
    // resolved or rejected. Until it resolves - or if it never does - state
    // pushes are dropped rather than attempted: Homebridge's own
    // updateAccessoryState() re-validates readiness on every call and throws
    // the same way registration itself can (e.g. "Matter is not enabled for
    // this bridge" - api.matter can be defined merely because some other,
    // unrelated bridge has Matter on, even when this one doesn't). Without
    // this guard every single reading would log a fresh error forever.
    this.registered = false;
    this.registrationFailed = false;

    // matter.uuid is an alias of api.hap.uuid (Homebridge's own MatterAPIImpl
    // exposes it as `get uuid() { return this.api.hap.uuid }`), so this is a
    // genuine HAP-flavored UUID - fine, since the seed string is namespaced
    // separately from the HAP accessory's own seed in platform.js.
    //
    // `null` is Matter's own idiom for "no current reading" (Homebridge types
    // these as `number | null`), used until the first real advertisement
    // arrives and again once the sensor times out - rather than presenting a
    // made-up number as a genuine measurement.
    const { TemperatureSensor, HumiditySensor } = matter.deviceTypes;
    this.accessory = {
      UUID: Cgdk2MatterAccessory.uuidFor(matter, address),
      displayName: label(name),
      deviceType: TemperatureSensor.with(
        HumiditySensor.behaviors.relativeHumidityMeasurement,
      ),
      serialNumber: label(cleanAddress(address)),
      manufacturer: "Cleargrass Inc",
      model: "CGDK2",
      firmwareRevision: version,
      hardwareRevision: "1.0.0",
      context: { address },
      clusters: {
        descriptor: {
          deviceTypeList: [
            {
              deviceType: TemperatureSensor.deviceType,
              revision: TemperatureSensor.deviceRevision,
            },
            {
              deviceType: HumiditySensor.deviceType,
              revision: HumiditySensor.deviceRevision,
            },
          ],
        },
        temperatureMeasurement: {
          measuredValue: null,
          minMeasuredValue: MIN_MEASURED_TEMPERATURE,
          maxMeasuredValue: MAX_MEASURED_TEMPERATURE,
        },
        relativeHumidityMeasurement: {
          measuredValue: null,
          minMeasuredValue: 0,
          maxMeasuredValue: 10000,
        },
        powerSource: {
          status: POWER_SOURCE_STATUS_ACTIVE,
          order: 0,
          description: "Battery",
          endpointList: [],
          batPercentRemaining: null,
          batChargeLevel: BAT_CHARGE_LEVEL_OK,
          batReplacementNeeded: false,
          batReplaceability: BAT_REPLACEABILITY_UNSPECIFIED,
        },
      },
    };
  }

  // The plain objects api.matter.registerPlatformAccessories() expects.
  toAccessories() {
    return [this.accessory];
  }

  // Called by platform.js once registerPlatformAccessories() for this
  // instance actually resolves - only then is it safe to start pushing state.
  markRegistered() {
    this.registered = true;
  }

  // Homebridge restores a cached Matter accessory onto its existing endpoint
  // and only swaps in the new metadata, so a changed displayName (e.g. a
  // renamed sensor) would never reach controllers. NodeLabel is the one
  // naming attribute that may change at runtime, so push it explicitly.
  async syncNodeLabel() {
    await this.pushState("bridgedDeviceBasicInformation", {
      nodeLabel: this.accessory.displayName,
    });
  }

  // Called by platform.js if registerPlatformAccessories() rejects. Pushes
  // are dropped permanently for this run rather than retried: a rejection
  // here reflects this bridge's Matter configuration (or its absence), which
  // won't change without a restart.
  markRegistrationFailed() {
    this.registrationFailed = true;
  }

  async updateTemperature(celsius) {
    const measuredValue = celsius == null ? null : Math.round(celsius * 100);
    await this.pushState("temperatureMeasurement", { measuredValue });
  }

  async updateHumidity(percent) {
    // Matter's relativeHumidityMeasurement range (0-10000, i.e. 0-100%) is
    // the full valid domain per spec - unlike temperature there's no wider
    // bound to declare instead, so a configured humidityOffset pushing the
    // adjusted value outside 0-100 is clamped rather than rejected outright.
    const measuredValue =
      percent == null
        ? null
        : Math.round(Math.min(100, Math.max(0, percent)) * 100);
    await this.pushState("relativeHumidityMeasurement", { measuredValue });
  }

  // batPercentRemaining is in half-percent units (0-200). The charge level
  // mirrors HAP's StatusLowBattery: at or below `lowThreshold` is a warning.
  async updateBattery(percent, lowThreshold) {
    if (percent == null) {
      await this.pushState("powerSource", {
        batPercentRemaining: null,
        batChargeLevel: BAT_CHARGE_LEVEL_OK,
      });
      return;
    }
    const clamped = Math.min(100, Math.max(0, percent));
    await this.pushState("powerSource", {
      batPercentRemaining: Math.round(clamped * 2),
      batChargeLevel:
        clamped > lowThreshold ? BAT_CHARGE_LEVEL_OK : BAT_CHARGE_LEVEL_WARNING,
    });
  }

  async pushState(cluster, attributes) {
    if (!this.registered || this.registrationFailed) {
      return;
    }
    try {
      await this.matter.updateAccessoryState(
        this.accessory.UUID,
        cluster,
        attributes,
      );
    } catch (error) {
      this.log.error(
        `[${this.address}] Failed to update Matter ${cluster} state:`,
        error,
      );
    }
  }
}

module.exports = { Cgdk2MatterAccessory };
