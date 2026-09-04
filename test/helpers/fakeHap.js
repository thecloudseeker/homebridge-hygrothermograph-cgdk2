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
    this.characteristics = new Map();
  }
  // Actually constructs the passed-in class (not a generic stand-in): a
  // custom characteristic's own constructor — where it calls setProps with
  // real Formats/Perms values — needs to genuinely run under test, or a
  // broken constructor (as happened in production) never surfaces here.
  getCharacteristic(CharClass) {
    if (!this.characteristics.has(CharClass)) {
      this.characteristics.set(CharClass, new CharClass());
    }
    return this.characteristics.get(CharClass);
  }
  // Real HAP dedupes by UUID: adding an already-present custom characteristic
  // returns the existing instance instead of creating a duplicate. Reuse-by-
  // key here gives us that same idempotency (and still only constructs once).
  addCharacteristic(CharClass) {
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

function createFakeHap() {
  // Real HAP's Characteristic is itself an extendable base class (plugins
  // commonly declare `class Custom extends Characteristic {}` for custom
  // characteristics), with built-ins attached as static properties on it —
  // not a plain namespace object. Mirror that shape here.
  class Characteristic extends FakeCharacteristic {}
  Characteristic.Manufacturer = class extends FakeCharacteristic {};
  Characteristic.Model = class extends FakeCharacteristic {};
  Characteristic.FirmwareRevision = class extends FakeCharacteristic {};
  Characteristic.SerialNumber = class extends FakeCharacteristic {};
  Characteristic.CurrentTemperature = class extends FakeCharacteristic {};
  Characteristic.CurrentRelativeHumidity = class extends FakeCharacteristic {};
  Characteristic.BatteryLevel = class extends FakeCharacteristic {};
  Characteristic.ChargingState = class extends FakeCharacteristic {};
  Characteristic.StatusLowBattery = class extends FakeCharacteristic {};
  Characteristic.StatusFault = class extends FakeCharacteristic {};
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
