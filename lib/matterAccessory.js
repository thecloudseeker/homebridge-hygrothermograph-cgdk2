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

function label(value) {
  return String(value).slice(0, MAX_MATTER_LABEL_LENGTH);
}

// One physical CGDK2 becomes TWO flat Matter accessories - a TemperatureSensor
// and a HumiditySensor - rather than a single composed BridgedNode carrying
// them as child `parts` endpoints.
//
// The composed shape is what Homebridge's reference plugin uses only for its
// PowerStrip demo; its own TemperatureSensorAccessory/HumiditySensorAccessory
// are separate flat accessories, and its PowerStrip carries an explicit note
// that even Apple Home mishandles composed devices (child parts show the
// parent's name). In practice a composed device also had every subscription
// to it rejected by the controller - matter.js reports that as "Subscription
// <id> reported invalid by peer", i.e. the report was sent and the controller
// refused it - while a flat accessory on the same bridge and hub stayed
// subscribed indefinitely. Flat is both what the reference does and what
// actually survives.
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

    const normalized = cleanAddress(address);
    // Shared so configureMatterAccessory can tell which sensor either half
    // belongs to when an address later becomes ignored.
    const context = { address };
    const common = {
      manufacturer: "Cleargrass Inc",
      model: "CGDK2",
      firmwareRevision: version,
      hardwareRevision: "1.0.0",
      context,
    };

    // matter.uuid is an alias of api.hap.uuid (Homebridge's own MatterAPIImpl
    // exposes it as `get uuid() { return this.api.hap.uuid }`), so these are
    // genuine HAP-flavored UUIDs - fine, since the seed strings are namespaced
    // separately from the HAP accessory's own seed in platform.js.
    //
    // `measuredValue: null` is Matter's own idiom for "no current reading"
    // (Homebridge types it as `number | null`), used until the first real
    // advertisement arrives and again once the sensor times out - rather than
    // presenting a made-up number as a genuine measurement.
    this.temperatureAccessory = {
      ...common,
      UUID: matter.uuid.generate(
        `homebridge-hygrothermograph-cgdk2:matter:${normalized}:temperature`,
      ),
      displayName: label(`${name} ${temperatureName}`),
      deviceType: matter.deviceTypes.TemperatureSensor,
      serialNumber: label(`${normalized}-temperature`),
      clusters: {
        temperatureMeasurement: {
          measuredValue: null,
          minMeasuredValue: MIN_MEASURED_TEMPERATURE,
          maxMeasuredValue: MAX_MEASURED_TEMPERATURE,
        },
      },
    };

    this.humidityAccessory = {
      ...common,
      UUID: matter.uuid.generate(
        `homebridge-hygrothermograph-cgdk2:matter:${normalized}:humidity`,
      ),
      displayName: label(`${name} ${humidityName}`),
      deviceType: matter.deviceTypes.HumiditySensor,
      serialNumber: label(`${normalized}-humidity`),
      clusters: {
        relativeHumidityMeasurement: {
          measuredValue: null,
          minMeasuredValue: 0,
          maxMeasuredValue: 10000,
        },
      },
    };
  }

  // The plain objects api.matter.registerPlatformAccessories() expects.
  toAccessories() {
    return [this.temperatureAccessory, this.humidityAccessory];
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
      this.temperatureAccessory.UUID,
      "temperatureMeasurement",
      { measuredValue },
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
      this.humidityAccessory.UUID,
      "relativeHumidityMeasurement",
      { measuredValue },
    );
  }

  async pushState(uuid, cluster, attributes) {
    if (!this.registered || this.registrationFailed) {
      return;
    }
    try {
      await this.matter.updateAccessoryState(uuid, cluster, attributes);
    } catch (error) {
      this.log.error(
        `[${this.address}] Failed to update Matter ${cluster} state:`,
        error,
      );
    }
  }
}

module.exports = { Cgdk2MatterAccessory };
