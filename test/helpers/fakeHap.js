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
}

class FakeService {
  constructor(displayName) {
    this.displayName = displayName;
    this.characteristics = new Map();
  }
  getCharacteristic(CharClass) {
    if (!this.characteristics.has(CharClass)) {
      this.characteristics.set(CharClass, new FakeCharacteristic());
    }
    return this.characteristics.get(CharClass);
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
  const Characteristic = {
    Manufacturer: class extends FakeCharacteristic {},
    Model: class extends FakeCharacteristic {},
    FirmwareRevision: class extends FakeCharacteristic {},
    SerialNumber: class extends FakeCharacteristic {},
    CurrentTemperature: class extends FakeCharacteristic {},
    CurrentRelativeHumidity: class extends FakeCharacteristic {},
    BatteryLevel: class extends FakeCharacteristic {},
    ChargingState: class extends FakeCharacteristic {},
    StatusLowBattery: class extends FakeCharacteristic {},
  };
  Characteristic.ChargingState.NOT_CHARGEABLE = 2;
  Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL = 0;
  Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW = 1;

  const Service = {
    AccessoryInformation: class {},
    TemperatureSensor: class {},
    HumiditySensor: class {},
    Battery: class {},
  };

  return { Service, Characteristic };
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
