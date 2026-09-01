const mqtt = require("mqtt");
const { version } = require("../package.json");

let Service;
let Characteristic;
let FakeGatoHistoryService;
let RSSICharacteristic;
let LastSeenCharacteristic;
let homebridgeAPI;

const defaultTimeout = 15;

// Custom characteristics (not part of the standard HAP characteristic set),
// exposed on the temperature service for diagnostics. Fixed, hardcoded UUIDs
// so they keep their identity across Homebridge restarts.
const RSSI_CHARACTERISTIC_UUID = "d0d8b37f-dfbc-4a52-8b0f-5ff4f15c727b";
const LAST_SEEN_CHARACTERISTIC_UUID = "0005deca-a339-49e4-b63a-84328ed87443";

class HygrothermographCgdk2AccessoryHandler {
  constructor(platformAccessory, config, log) {
    this.platformAccessory = platformAccessory;
    this.log = log;
    this.config = config || {};

    this.latestTemperature = undefined;
    this.latestHumidity = undefined;
    this.latestBatteryLevel = undefined;
    this.latestRSSI = undefined;
    this.lastUpdatedAt = undefined;
    this.lastBatchUpdatedAt = undefined;

    this.informationService = this.getInformationService();
    this.temperatureService = this.getTemperatureService();
    this.humidityService = this.getHumidityService();
    this.batteryService = this.getBatteryService();
    this.fakeGatoHistoryService = this.getFakeGatoHistoryService();

    this.temperatureMQTTTopic = undefined;
    this.humidityMQTTTopic = undefined;
    this.batteryMQTTTopic = undefined;
    this.mqttClient = this.setupMQTTClient();

    this.log.debug(`Initialized accessory for ${this.config.address}`);
  }

  setTemperature(newValue, force = false) {
    if (newValue == null) {
      return;
    }
    this.latestTemperature = newValue;
    this.lastUpdatedAt = Date.now();
    if (this.useBatchUpdating && force === false) {
      return;
    }
    this.temperatureService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .updateValue(newValue);
    this.temperatureService
      .getCharacteristic(Characteristic.StatusFault)
      .updateValue(this.statusFault);
    this.addFakeGatoHistoryEntry();
    this.publishValueToMQTT(this.temperatureMQTTTopic, this.temperature);
  }

  get temperature() {
    if (this.hasTimedOut() || this.latestTemperature == null) {
      return;
    }
    return this.latestTemperature + this.temperatureOffset;
  }

  setHumidity(newValue, force = false) {
    if (newValue == null) {
      return;
    }
    this.latestHumidity = newValue;
    this.lastUpdatedAt = Date.now();
    if (this.useBatchUpdating && force === false) {
      return;
    }
    this.humidityService
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .updateValue(newValue);
    this.humidityService
      .getCharacteristic(Characteristic.StatusFault)
      .updateValue(this.statusFault);
    this.addFakeGatoHistoryEntry();
    this.publishValueToMQTT(this.humidityMQTTTopic, this.humidity);
  }

  get humidity() {
    if (this.hasTimedOut() || this.latestHumidity == null) {
      return;
    }
    return this.latestHumidity + this.humidityOffset;
  }

  setBatteryLevel(newValue, force = false) {
    if (newValue == null) {
      return;
    }
    this.latestBatteryLevel = newValue;
    this.lastUpdatedAt = Date.now();
    if (this.useBatchUpdating && force === false) {
      return;
    }
    if (this.batteryService != null) {
      this.batteryService
        .getCharacteristic(Characteristic.BatteryLevel)
        .updateValue(newValue);
    }
    this.publishValueToMQTT(this.batteryMQTTTopic, this.batteryLevel);
  }

  get batteryLevel() {
    if (this.hasTimedOut()) {
      return;
    }
    return this.latestBatteryLevel;
  }

  get batteryStatus() {
    let batteryStatus;
    if (this.batteryLevel == null) {
      batteryStatus = undefined;
    } else if (this.batteryLevel > this.batteryLevelThreshold) {
      batteryStatus = Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    } else {
      batteryStatus = Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
    }
    return batteryStatus;
  }

  get batteryLevelThreshold() {
    return this.config.lowBattery || 10;
  }

  setRSSI(newValue) {
    if (newValue == null) {
      return;
    }
    this.latestRSSI = newValue;
    if (this.logSignalStrength) {
      this.log.info(
        `[${this.config.address}] Signal strength: ${newValue} dBm`,
      );
    }
    this.temperatureService
      .getCharacteristic(RSSICharacteristic)
      .updateValue(newValue);
    if (this.lastUpdatedAt != null) {
      this.temperatureService
        .getCharacteristic(LastSeenCharacteristic)
        .updateValue(this.lastUpdatedISO8601);
    }
  }

  get rssi() {
    return this.latestRSSI;
  }

  get lastSeen() {
    return this.lastUpdatedAt == null ? undefined : this.lastUpdatedISO8601;
  }

  get statusFault() {
    return this.hasTimedOut()
      ? Characteristic.StatusFault.GENERAL_FAULT
      : Characteristic.StatusFault.NO_FAULT;
  }

  get temperatureName() {
    return this.config.temperatureName || "Temperature";
  }

  get humidityName() {
    return this.config.humidityName || "Humidity";
  }

  get serialNumber() {
    return this.config.address.replace(/:/g, "");
  }

  get lastUpdatedISO8601() {
    return new Date(this.lastUpdatedAt).toISOString();
  }

  get fakeGatoStoragePath() {
    return this.config.fakeGatoStoragePath || homebridgeAPI.user.storagePath();
  }

  get timeout() {
    return this.config.timeout == null ? defaultTimeout : this.config.timeout;
  }

  get isFakeGatoEnabled() {
    return this.config.fakeGatoEnabled || false;
  }

  get useBatchUpdating() {
    return this.config.updateInterval != null;
  }

  get temperatureOffset() {
    return this.config.temperatureOffset || 0;
  }

  get humidityOffset() {
    return this.config.humidityOffset || 0;
  }

  get isBatteryLevelDisabled() {
    return this.config.disableBatteryLevel || false;
  }

  get logSignalStrength() {
    return this.config.logSignalStrength || false;
  }

  isReadyForBatchUpdate() {
    if (this.useBatchUpdating === false) {
      return false;
    }
    if (this.lastBatchUpdatedAt == null) {
      return true;
    }
    const timeoutMilliseconds = 1000 * this.config.updateInterval;
    return this.lastBatchUpdatedAt + timeoutMilliseconds <= Date.now();
  }

  // Called on every BLE advertisement seen for this sensor (not just when a
  // value changes). setTemperature/setHumidity/setBatteryLevel already
  // recorded the latest raw values but, when updateInterval is configured,
  // held off pushing them anywhere (see the useBatchUpdating guard in each
  // setter). This is what actually flushes them on schedule.
  flushBatchedUpdate() {
    if (this.isReadyForBatchUpdate() === false) {
      return;
    }
    this.log.debug("Batch updating values");
    this.lastBatchUpdatedAt = Date.now();
    this.setTemperature(this.temperature, true);
    this.setHumidity(this.humidity, true);
    this.setBatteryLevel(this.batteryLevel, true);
  }

  hasTimedOut() {
    if (this.timeout === 0) {
      return false;
    }
    if (this.lastUpdatedAt == null) {
      return false;
    }
    const timeoutMilliseconds = 1000 * 60 * this.timeout;
    const timedOut = this.lastUpdatedAt <= Date.now() - timeoutMilliseconds;
    if (timedOut) {
      this.log.warn(
        `[${this.config.address}] Timed out, last update: ${this.lastUpdatedISO8601}`,
      );
    }
    return timedOut;
  }

  addFakeGatoHistoryEntry() {
    if (
      !this.isFakeGatoEnabled ||
      this.temperature == null ||
      this.humidity == null
    ) {
      return;
    }
    this.fakeGatoHistoryService.addEntry({
      time: new Date().getTime() / 1000,
      temp: this.temperature,
      humidity: this.humidity,
    });
  }

  setupMQTTClient() {
    const config = this.config.mqtt;
    if (config == null || config.url == null) {
      return;
    }
    const {
      temperatureTopic,
      humidityTopic,
      batteryTopic,
      url,
      ...mqttOptions
    } = config;

    this.temperatureMQTTTopic = temperatureTopic;
    this.humidityMQTTTopic = humidityTopic;
    this.batteryMQTTTopic = batteryTopic;

    const client = mqtt.connect(url, mqttOptions);
    client.on("connect", () => {
      this.log.info("MQTT Client connected.");
    });
    client.on("reconnect", () => {
      this.log.debug("MQTT Client reconnecting.");
    });
    client.on("close", () => {
      this.log.debug("MQTT Client disconnected");
    });
    client.on("error", (error) => {
      this.log.error(error);
      client.end();
    });
    return client;
  }

  publishValueToMQTT(topic, value) {
    if (
      this.mqttClient == null ||
      this.mqttClient.connected === false ||
      topic == null ||
      value == null
    ) {
      return;
    }
    this.mqttClient.publish(topic, String(value), {
      qos: this.config.mqtt.qos || 0,
      retain: this.config.mqtt.retain || false,
    });
  }

  getFakeGatoHistoryService() {
    if (!this.isFakeGatoEnabled) {
      return;
    }
    const existing = this.platformAccessory.getService(FakeGatoHistoryService);
    if (existing != null) {
      return existing;
    }
    const serialNumber = this.serialNumber || this.constructor.name;
    const filename = `fakegato-history_${serialNumber}.json`;
    const path = this.fakeGatoStoragePath;
    const service = new FakeGatoHistoryService("room", this.platformAccessory, {
      filename,
      path,
      storage: "fs",
      ...this.config.fakeGatoOptions,
    });
    this.platformAccessory.addService(service);
    return service;
  }

  getInformationService() {
    const service =
      this.platformAccessory.getService(Service.AccessoryInformation) ||
      this.platformAccessory.addService(Service.AccessoryInformation);
    service
      .setCharacteristic(Characteristic.Manufacturer, "Cleargrass Inc")
      .setCharacteristic(Characteristic.Model, "CGDK2")
      .setCharacteristic(Characteristic.FirmwareRevision, version)
      .setCharacteristic(Characteristic.SerialNumber, this.serialNumber);
    return service;
  }

  onCharacteristicGetValue(field, callback) {
    const value = this[field];
    if (value == null) {
      callback(new Error(`Undefined characteristic value for ${field}`));
    } else {
      callback(null, value);
    }
  }

  getTemperatureService() {
    const temperatureService =
      this.platformAccessory.getService(Service.TemperatureSensor) ||
      this.platformAccessory.addService(
        Service.TemperatureSensor,
        this.temperatureName,
      );
    temperatureService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on("get", this.onCharacteristicGetValue.bind(this, "temperature"));
    temperatureService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -10 });
    temperatureService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ maxValue: 60 });
    temperatureService
      .getCharacteristic(Characteristic.StatusFault)
      .on("get", this.onCharacteristicGetValue.bind(this, "statusFault"));
    temperatureService
      .addCharacteristic(RSSICharacteristic)
      .on("get", this.onCharacteristicGetValue.bind(this, "rssi"));
    temperatureService
      .addCharacteristic(LastSeenCharacteristic)
      .on("get", this.onCharacteristicGetValue.bind(this, "lastSeen"));
    return temperatureService;
  }

  getHumidityService() {
    const humidityService =
      this.platformAccessory.getService(Service.HumiditySensor) ||
      this.platformAccessory.addService(
        Service.HumiditySensor,
        this.humidityName,
      );
    humidityService
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on("get", this.onCharacteristicGetValue.bind(this, "humidity"));
    humidityService
      .getCharacteristic(Characteristic.StatusFault)
      .on("get", this.onCharacteristicGetValue.bind(this, "statusFault"));
    return humidityService;
  }

  getBatteryService() {
    const existing = this.platformAccessory.getService(Service.Battery);
    if (this.isBatteryLevelDisabled) {
      if (existing != null) {
        this.platformAccessory.removeService(existing);
      }
      return undefined;
    }
    // hap-nodejs 2.x (Homebridge 2.0) removed the "BatteryService" alias in
    // favor of "Battery"; the "Battery" name has existed since hap-nodejs
    // 0.x, so using it here keeps this working on both Homebridge 1.x and 2.x.
    const batteryService =
      existing || this.platformAccessory.addService(Service.Battery, "Battery");
    batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .on("get", this.onCharacteristicGetValue.bind(this, "batteryLevel"));
    batteryService.setCharacteristic(
      Characteristic.ChargingState,
      Characteristic.ChargingState.NOT_CHARGEABLE,
    );
    batteryService
      .getCharacteristic(Characteristic.StatusLowBattery)
      .on("get", this.onCharacteristicGetValue.bind(this, "batteryStatus"));
    return batteryService;
  }
}

module.exports = (homebridge) => {
  FakeGatoHistoryService = require("fakegato-history")(homebridge);
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridgeAPI = homebridge;

  RSSICharacteristic = class extends Characteristic {
    constructor() {
      super("Signal Strength (RSSI)", RSSI_CHARACTERISTIC_UUID);
      this.setProps({
        format: Characteristic.Formats.INT,
        perms: [Characteristic.Perms.PAIRED_READ, Characteristic.Perms.NOTIFY],
        minValue: -100,
        maxValue: 0,
      });
      this.value = this.getDefaultValue();
    }
  };
  RSSICharacteristic.UUID = RSSI_CHARACTERISTIC_UUID;

  LastSeenCharacteristic = class extends Characteristic {
    constructor() {
      super("Last Seen", LAST_SEEN_CHARACTERISTIC_UUID);
      this.setProps({
        format: Characteristic.Formats.STRING,
        perms: [Characteristic.Perms.PAIRED_READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  };
  LastSeenCharacteristic.UUID = LAST_SEEN_CHARACTERISTIC_UUID;

  return {
    HygrothermographCgdk2AccessoryHandler,
    RSSICharacteristic,
    LastSeenCharacteristic,
  };
};
