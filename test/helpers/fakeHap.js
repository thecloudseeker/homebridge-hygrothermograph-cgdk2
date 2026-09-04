const EventEmitter = require("events");

class FakeCharacteristic {
  constructor() {
    this.value = undefined;
    this.props = undefined;
    this.listeners = {};
  }
  on(event, handler) {
    this.listeners[event] = handler;
    return this;
  }
  setProps(props) {
    this.props = { ...this.props, ...props };
    return this;
  }
  updateValue(value) {
    this.value = value;
    return this;
  }
  // Mirrors real HAP-NodeJS's Characteristic#getDefaultValue: a sensible
  // zero-ish value based on the format set via setProps, used by custom
  // characteristics (e.g. RSSICharacteristic) to seed their initial value.
  getDefaultValue() {
    switch (this.props?.format) {
      case "string":
        return "";
      case "bool":
        return false;
      default:
        return 0;
    }
  }
}

class FakeService {
  constructor(displayName) {
    this.displayName = displayName;
    // Keyed by characteristic UUID, matching real HAP-NodeJS — which
    // dedupes (and rejects duplicate adds) by UUID, not by JS class
    // identity. This matters for restored cached accessories: they already
    // carry their previously-added characteristics, so re-adding the same
    // UUID must be detected the same way it would be in production.
    this.characteristics = new Map();
  }
  // Actually constructs the passed-in class (not a generic stand-in): a
  // custom characteristic's own constructor — where it calls setProps with
  // real Formats/Perms values — needs to genuinely run under test, or a
  // broken constructor (as happened in production) never surfaces here.
  getCharacteristic(CharClass) {
    if (!this.characteristics.has(CharClass.UUID)) {
      this.characteristics.set(CharClass.UUID, new CharClass());
    }
    return this.characteristics.get(CharClass.UUID);
  }
  // Real HAP throws if a characteristic with this UUID is already present on
  // the service — unlike getCharacteristic, it is not add-or-reuse. This bit
  // us in production: a cached accessory already has its RSSI characteristic
  // from a prior run, so calling addCharacteristic for it again on restore
  // threw "Cannot add a Characteristic with the same UUID...".
  addCharacteristic(CharClass) {
    if (this.characteristics.has(CharClass.UUID)) {
      throw new Error(
        `Cannot add a Characteristic with the same UUID as another Characteristic in this Service: ${CharClass.UUID}`,
      );
    }
    return this.getCharacteristic(CharClass);
  }
  setCharacteristic(CharClass, value) {
    this.getCharacteristic(CharClass).updateValue(value);
    return this;
  }
}

class FakePlatformAccessory {
  constructor(displayName, uuid) {
    this.displayName = displayName;
    this.UUID = uuid;
    this.context = {};
    this.services = new Map();
  }
  getService(ServiceClass) {
    return this.services.get(ServiceClass);
  }
  // Mirrors real HAP's addService: accepts either a Service subclass + name
  // (constructs a new one) or an already-built service instance (attaches
  // it directly, keyed by its own constructor) — e.g. fakegato-history hands
  // back a ready-made Service instance rather than a class to instantiate.
  addService(serviceOrClass, displayName) {
    if (typeof serviceOrClass === "function") {
      const service = new FakeService(displayName);
      this.services.set(serviceOrClass, service);
      return service;
    }
    this.services.set(serviceOrClass.constructor, serviceOrClass);
    return serviceOrClass;
  }
  removeService(service) {
    for (const [key, value] of this.services) {
      if (value === service) {
        this.services.delete(key);
      }
    }
  }
}

// Real characteristic classes always carry a static UUID (used for dedup —
// see FakeService above); give each fake built-in a distinct one too, or
// they'd all collide on the same `undefined` key.
function defineCharacteristic(name) {
  const cls = class extends FakeCharacteristic {};
  cls.UUID = `uuid:${name}`;
  return cls;
}

function createFakeHap() {
  // Real HAP's Characteristic is itself an extendable base class (plugins
  // commonly declare `class Custom extends Characteristic {}` for custom
  // characteristics), with built-ins attached as static properties on it —
  // not a plain namespace object. Mirror that shape here.
  class Characteristic extends FakeCharacteristic {}
  Characteristic.Manufacturer = defineCharacteristic("Manufacturer");
  Characteristic.Model = defineCharacteristic("Model");
  Characteristic.FirmwareRevision = defineCharacteristic("FirmwareRevision");
  Characteristic.SerialNumber = defineCharacteristic("SerialNumber");
  Characteristic.CurrentTemperature =
    defineCharacteristic("CurrentTemperature");
  Characteristic.CurrentRelativeHumidity = defineCharacteristic(
    "CurrentRelativeHumidity",
  );
  Characteristic.BatteryLevel = defineCharacteristic("BatteryLevel");
  Characteristic.ChargingState = defineCharacteristic("ChargingState");
  Characteristic.StatusLowBattery = defineCharacteristic("StatusLowBattery");
  Characteristic.StatusFault = defineCharacteristic("StatusFault");
  Characteristic.ChargingState.NOT_CHARGEABLE = 2;
  Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL = 0;
  Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW = 1;
  Characteristic.StatusFault.NO_FAULT = 0;
  Characteristic.StatusFault.GENERAL_FAULT = 1;

  const Service = {
    AccessoryInformation: class {},
    TemperatureSensor: class {},
    HumiditySensor: class {},
    Battery: class {},
  };

  // Real HAP-NodeJS 2.x only exposes Formats/Perms as top-level `hap`
  // exports, not as `Characteristic.Formats`/`Characteristic.Perms` (that
  // alias was removed; see lib/accessory.js's factory comment). Mirror that
  // shape here so a regression back to the removed alias fails the suite.
  const Formats = { INT: "int", STRING: "string" };
  const Perms = { PAIRED_READ: "pr", NOTIFY: "ev" };

  return { Service, Characteristic, Formats, Perms };
}

function createSilentLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

module.exports = {
  FakeCharacteristic,
  FakeService,
  FakePlatformAccessory,
  createFakeHap,
  createSilentLog,
  EventEmitter,
};
