const { version } = require("../package.json");
const { cleanAddress } = require("./address");

const TEMPERATURE_PART_ID = "temperature";
const HUMIDITY_PART_ID = "humidity";

// Matches homebridge-plugins/homebridge-matter's own TemperatureSensorAccessory
// reference bounds (-50C to 100C), deliberately much wider than the CGDK2's
// physical range (see accessory.js's -10/60 HAP setProps): a configured
// temperatureOffset is added to the real reading before it reaches Matter, so
// a tight bound sized to the sensor's own range could be pushed outside it by
// the offset alone, and Matter rejects (rather than clamps, as HAP does) a
// write outside the declared min/max as a constraint violation.
const MIN_MEASURED_TEMPERATURE = -5000;
const MAX_MEASURED_TEMPERATURE = 10000;

// A composed Matter device (a non-controllable BridgedNode parent with two
// child parts) mirroring the plugin's existing HAP accessory: one physical
// CGDK2 sensor shows up as one Matter node with separate Temperature and
// Humidity tiles in the Home app, the same way it already shows up as two
// HAP services under one PlatformAccessory.
//
// Modeled on Homebridge's own reference implementation
// (homebridge-plugins/homebridge-matter's TemperatureSensorAccessory /
// HumiditySensorAccessory / PowerStripAccessory) and cross-checked against
// homebridge-ecovacs, a production plugin using the same api.matter surface.
class Cgdk2MatterAccessory {
  constructor(matter, log, { address, name, temperatureName, humidityName }) {
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

    // matter.uuid is an alias of api.hap.uuid (Homebridge's own
    // MatterAPIImpl exposes it as `get uuid() { return this.api.hap.uuid }`),
    // so this produces genuine HAP-flavored UUIDs - fine here since the seed
    // string is namespaced separately from the HAP accessory's own UUID seed
    // in platform.js, so the two never collide.
    this.UUID = matter.uuid.generate(
      `homebridge-hygrothermograph-cgdk2:matter:${cleanAddress(address)}`,
    );
    this.displayName = name;
    this.deviceType = matter.deviceTypes.BridgedNode;
    this.serialNumber = cleanAddress(address);
    this.manufacturer = "Cleargrass Inc";
    this.model = "CGDK2";
    this.firmwareRevision = version;
    this.hardwareRevision = "1.0.0";
    this.context = { address };

    // `measuredValue: null` is Matter's own idiom for "no current reading"
    // (Homebridge types it as `number | null`), used here until the first
    // real advertisement arrives and again by updateTemperature/
    // updateHumidity once the sensor times out - rather than ever presenting
    // a made-up number as a genuine measurement.
    this.parts = [
      {
        id: TEMPERATURE_PART_ID,
        displayName: temperatureName,
        deviceType: matter.deviceTypes.TemperatureSensor,
        clusters: {
          temperatureMeasurement: {
            measuredValue: null,
            minMeasuredValue: MIN_MEASURED_TEMPERATURE,
            maxMeasuredValue: MAX_MEASURED_TEMPERATURE,
          },
        },
      },
      {
        id: HUMIDITY_PART_ID,
        displayName: humidityName,
        deviceType: matter.deviceTypes.HumiditySensor,
        clusters: {
          relativeHumidityMeasurement: {
            measuredValue: null,
            minMeasuredValue: 0,
            maxMeasuredValue: 10000,
          },
        },
      },
    ];
  }

  // The plain object api.matter.registerPlatformAccessories() expects.
  toAccessory() {
    return {
      UUID: this.UUID,
      displayName: this.displayName,
      deviceType: this.deviceType,
      serialNumber: this.serialNumber,
      manufacturer: this.manufacturer,
      model: this.model,
      firmwareRevision: this.firmwareRevision,
      hardwareRevision: this.hardwareRevision,
      context: this.context,
      parts: this.parts,
    };
  }

  // Called by platform.js once registerPlatformAccessories() for this
  // instance actually resolves - only then is it safe to start pushing state.
  markRegistered() {
    this.registered = true;
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
    await this.pushState(
      "temperatureMeasurement",
      { measuredValue },
      TEMPERATURE_PART_ID,
    );
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
    await this.pushState(
      "relativeHumidityMeasurement",
      { measuredValue },
      HUMIDITY_PART_ID,
    );
  }

  async pushState(cluster, attributes, partId) {
    if (!this.registered || this.registrationFailed) {
      return;
    }
    try {
      await this.matter.updateAccessoryState(
        this.UUID,
        cluster,
        attributes,
        partId,
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
