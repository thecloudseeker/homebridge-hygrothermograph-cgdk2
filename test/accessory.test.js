const { test } = require("node:test");
const assert = require("node:assert/strict");
const { stubModule } = require("./helpers/stubModule");
const {
  createFakeHap,
  FakePlatformAccessory,
  createSilentLog,
} = require("./helpers/fakeHap");

const accessoryPath = require.resolve("../lib/accessory");

let mqttConnectImpl = () => null;
stubModule(accessoryPath, "mqtt", {
  connect: (...args) => mqttConnectImpl(...args),
});

const fakeGatoConstructions = [];
class FakeGatoHistoryService {
  constructor(type, accessory, options) {
    fakeGatoConstructions.push({ type, accessory, options });
    this.entries = [];
  }
  addEntry(entry) {
    this.entries.push(entry);
  }
}
stubModule(accessoryPath, "fakegato-history", () => FakeGatoHistoryService);

const { Service, Characteristic, Formats, Perms } = createFakeHap();
const {
  HygrothermographCgdk2AccessoryHandler,
  RSSICharacteristic,
  LastSeenCharacteristic,
} = require("../lib/accessory")({
  hap: { Service, Characteristic, Formats, Perms },
  user: { storagePath: () => "/tmp/fakegato" },
});

function createHandler(config, log = createSilentLog()) {
  const platformAccessory = new FakePlatformAccessory(
    "Test Sensor",
    "uuid:test",
  );
  const handler = new HygrothermographCgdk2AccessoryHandler(
    platformAccessory,
    { address: "4c:64:a8:d0:ae:65", ...config },
    log,
  );
  return { handler, platformAccessory };
}

test("getInformationService sets manufacturer, model, firmware, and a serial number derived from the address", () => {
  const { platformAccessory } = createHandler({});
  const info = platformAccessory.getService(Service.AccessoryInformation);
  assert.equal(
    info.getCharacteristic(Characteristic.Manufacturer).value,
    "Cleargrass Inc",
  );
  assert.equal(info.getCharacteristic(Characteristic.Model).value, "CGDK2");
  assert.equal(
    info.getCharacteristic(Characteristic.SerialNumber).value,
    "4c64a8d0ae65",
  );
});

test("temperature is undefined until a reading has been received", () => {
  const { handler } = createHandler({});
  assert.equal(handler.temperature, undefined);
});

test("temperature applies the configured offset", () => {
  const { handler } = createHandler({ temperatureOffset: 1.5 });
  handler.setTemperature(20);
  assert.equal(handler.temperature, 21.5);
});

test("humidity applies the configured offset", () => {
  const { handler } = createHandler({ humidityOffset: -2 });
  handler.setHumidity(50);
  assert.equal(handler.humidity, 48);
});

test("a reading becomes stale (undefined) once the configured timeout elapses", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { handler } = createHandler({ timeout: 1 }); // 1 minute
  handler.setTemperature(20);
  assert.equal(handler.temperature, 20);

  t.mock.timers.tick(61 * 1000);
  assert.equal(handler.temperature, undefined);
});

test("timeout: 0 disables staleness entirely", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { handler } = createHandler({ timeout: 0 });
  handler.setTemperature(20);
  t.mock.timers.tick(1000 * 60 * 60 * 24);
  assert.equal(handler.temperature, 20);
});

test("with updateInterval set, a reading does not reach HomeKit until flushBatchedUpdate runs", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { handler, platformAccessory } = createHandler({ updateInterval: 5 });
  const temperatureCharacteristic = platformAccessory
    .getService(Service.TemperatureSensor)
    .getCharacteristic(Characteristic.CurrentTemperature);

  handler.setTemperature(20);
  assert.equal(
    temperatureCharacteristic.value,
    undefined,
    "a batched reading must not update the HomeKit characteristic by itself",
  );

  handler.flushBatchedUpdate();
  assert.equal(temperatureCharacteristic.value, 20);
});

test("flushBatchedUpdate does nothing before the configured updateInterval has elapsed", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { handler, platformAccessory } = createHandler({ updateInterval: 60 });
  const temperatureCharacteristic = platformAccessory
    .getService(Service.TemperatureSensor)
    .getCharacteristic(Characteristic.CurrentTemperature);

  handler.setTemperature(20);
  handler.flushBatchedUpdate();
  assert.equal(temperatureCharacteristic.value, 20);

  handler.setTemperature(21);
  t.mock.timers.tick(30 * 1000); // well under the 60s interval
  handler.flushBatchedUpdate();
  assert.equal(
    temperatureCharacteristic.value,
    20,
    "must not flush again before updateInterval elapses",
  );

  t.mock.timers.tick(31 * 1000); // now past it
  handler.flushBatchedUpdate();
  assert.equal(temperatureCharacteristic.value, 21);
});

test("batteryStatus is NORMAL above the low-battery threshold and LOW at or below it", () => {
  const { handler } = createHandler({ lowBattery: 20 });
  handler.setBatteryLevel(50);
  assert.equal(
    handler.batteryStatus,
    Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
  );
  handler.setBatteryLevel(20);
  assert.equal(
    handler.batteryStatus,
    Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
  );
});

test("a lowBattery threshold of 0 falls back to the default of 10 (falsy-zero quirk)", () => {
  const { handler } = createHandler({ lowBattery: 0 });
  assert.equal(handler.batteryLevelThreshold, 10);
});

test("statusFault is NO_FAULT while readings are fresh and GENERAL_FAULT once the sensor times out", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { handler } = createHandler({ timeout: 1 }); // 1 minute
  handler.setTemperature(20);
  assert.equal(handler.statusFault, Characteristic.StatusFault.NO_FAULT);

  t.mock.timers.tick(61 * 1000);
  assert.equal(handler.statusFault, Characteristic.StatusFault.GENERAL_FAULT);
});

test("a stale sensor logs the timeout warning once, not once per getter read", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const warnings = [];
  const log = { ...createSilentLog(), warn: (...args) => warnings.push(args) };
  const { handler } = createHandler({ timeout: 1 }, log); // 1 minute

  handler.setTemperature(20);
  t.mock.timers.tick(61 * 1000);

  // Several timeout-gated getters are read after the sensor has gone stale
  // (as flushBatchedUpdate/setTemperature/setHumidity all do) — this must
  // only log the warning once, not once per read.
  void handler.temperature;
  void handler.humidity;
  void handler.batteryLevel;
  void handler.statusFault;

  assert.equal(warnings.length, 1);
});

test("setTemperature pushes StatusFault to the temperature service", () => {
  const { handler, platformAccessory } = createHandler({});
  const statusFault = platformAccessory
    .getService(Service.TemperatureSensor)
    .getCharacteristic(Characteristic.StatusFault);

  handler.setTemperature(20);
  assert.equal(statusFault.value, Characteristic.StatusFault.NO_FAULT);
});

test("setHumidity pushes StatusFault to the humidity service", () => {
  const { handler, platformAccessory } = createHandler({});
  const statusFault = platformAccessory
    .getService(Service.HumiditySensor)
    .getCharacteristic(Characteristic.StatusFault);

  handler.setHumidity(50);
  assert.equal(statusFault.value, Characteristic.StatusFault.NO_FAULT);
});

test("rssi is undefined until a reading has been received", () => {
  const { handler } = createHandler({});
  assert.equal(handler.rssi, undefined);
});

test("setRSSI records the value and pushes it to the temperature service", () => {
  const { handler, platformAccessory } = createHandler({});
  const rssiCharacteristic = platformAccessory
    .getService(Service.TemperatureSensor)
    .getCharacteristic(RSSICharacteristic);

  handler.setRSSI(-55);

  assert.equal(handler.rssi, -55);
  assert.equal(rssiCharacteristic.value, -55);
});

test("setRSSI(null) is ignored", () => {
  const { handler } = createHandler({});
  handler.setRSSI(-55);
  handler.setRSSI(null);
  assert.equal(handler.rssi, -55);
});

test("reconstructing a handler against an accessory that already has its RSSI/Last Seen characteristics (simulating a restored cached accessory) does not throw", () => {
  const { platformAccessory } = createHandler({});
  // A restart restores the same platformAccessory object from Homebridge's
  // cache — already carrying the characteristics added during the first
  // construction above. Real HAP's addCharacteristic throws on a duplicate
  // UUID (unlike getCharacteristic's add-or-reuse); this reproduces that
  // exact restore path.
  assert.doesNotThrow(() => {
    new HygrothermographCgdk2AccessoryHandler(
      platformAccessory,
      { address: "4c:64:a8:d0:ae:65" },
      createSilentLog(),
    );
  });
});

test("setRSSI logs signal strength at info level when logSignalStrength is enabled", () => {
  const infoMessages = [];
  const log = {
    ...createSilentLog(),
    info: (message) => infoMessages.push(message),
  };
  const { handler } = createHandler({ logSignalStrength: true }, log);

  handler.setRSSI(-55);

  assert.deepEqual(infoMessages, [
    "[4c:64:a8:d0:ae:65] Signal strength: -55 dBm",
  ]);
});

test("setRSSI does not log signal strength by default", () => {
  const infoMessages = [];
  const log = {
    ...createSilentLog(),
    info: (message) => infoMessages.push(message),
  };
  const { handler } = createHandler({}, log);

  handler.setRSSI(-55);

  assert.deepEqual(infoMessages, []);
});

test("lastSeen is undefined until a reading has been received", () => {
  const { handler } = createHandler({});
  assert.equal(handler.lastSeen, undefined);
});

test("lastSeen reflects the last successful reading once one exists", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { handler } = createHandler({});
  handler.setTemperature(20);
  assert.equal(handler.lastSeen, new Date().toISOString());
});

test("setRSSI does not push Last Seen before any reading has been received", () => {
  const { handler, platformAccessory } = createHandler({});
  const lastSeenCharacteristic = platformAccessory
    .getService(Service.TemperatureSensor)
    .getCharacteristic(LastSeenCharacteristic);

  assert.doesNotThrow(() => handler.setRSSI(-55));
  assert.equal(
    lastSeenCharacteristic.value,
    "",
    "must stay at its unset default, not be pushed a timestamp",
  );
});

test("setRSSI pushes Last Seen once a reading exists", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { handler, platformAccessory } = createHandler({});
  const lastSeenCharacteristic = platformAccessory
    .getService(Service.TemperatureSensor)
    .getCharacteristic(LastSeenCharacteristic);

  handler.setTemperature(20);
  handler.setRSSI(-55);

  assert.equal(lastSeenCharacteristic.value, new Date().toISOString());
});

test("getBatteryService creates a Battery service by default", () => {
  const { platformAccessory } = createHandler({});
  assert.notEqual(platformAccessory.getService(Service.Battery), undefined);
});

test("getBatteryService removes an existing Battery service when disableBatteryLevel is set", () => {
  const platformAccessory = new FakePlatformAccessory(
    "Test",
    "uuid:disable-battery",
  );
  platformAccessory.addService(Service.Battery, "Battery"); // as if restored from a prior session
  new HygrothermographCgdk2AccessoryHandler(
    platformAccessory,
    { address: "4c:64:a8:d0:ae:65", disableBatteryLevel: true },
    createSilentLog(),
  );
  assert.equal(platformAccessory.getService(Service.Battery), undefined);
});

test("setupMQTTClient does not connect when mqtt config is absent", () => {
  let called = false;
  mqttConnectImpl = () => {
    called = true;
    return null;
  };
  const { handler } = createHandler({});
  assert.equal(called, false);
  assert.equal(handler.mqttClient, undefined);
});

test("setupMQTTClient connects and separates topic keys from library options", () => {
  const fakeClient = { connected: true, on() {}, publish() {}, end() {} };
  let connectArgs;
  mqttConnectImpl = (url, opts) => {
    connectArgs = [url, opts];
    return fakeClient;
  };

  const { handler } = createHandler({
    mqtt: {
      url: "mqtt://test.mosquitto.org",
      temperatureTopic: "sensors/temperature",
      username: "admin",
    },
  });

  assert.equal(connectArgs[0], "mqtt://test.mosquitto.org");
  assert.deepEqual(connectArgs[1], { username: "admin" });
  assert.equal(handler.temperatureMQTTTopic, "sensors/temperature");
  assert.equal(handler.mqttClient, fakeClient);
});

test("publishValueToMQTT publishes only when connected, with a topic, and a non-null value", () => {
  const published = [];
  const fakeClient = {
    connected: true,
    on() {},
    publish(topic, value, opts) {
      published.push({ topic, value, opts });
    },
    end() {},
  };
  mqttConnectImpl = () => fakeClient;

  const { handler } = createHandler({
    mqtt: { url: "mqtt://x", temperatureTopic: "t", qos: 1, retain: true },
  });

  handler.setTemperature(21.5);
  assert.deepEqual(published, [
    { topic: "t", value: "21.5", opts: { qos: 1, retain: true } },
  ]);

  published.length = 0;
  fakeClient.connected = false;
  handler.setTemperature(22);
  assert.deepEqual(published, []);
});

test("onCharacteristicGetValue calls back with an error for an unset field", () => {
  const { handler } = createHandler({});
  let result;
  handler.onCharacteristicGetValue("temperature", (err, value) => {
    result = [err, value];
  });
  assert.notEqual(result[0], null);
  assert.equal(result[1], undefined);
});

test("onCharacteristicGetValue calls back with the value once set", () => {
  const { handler } = createHandler({});
  handler.setTemperature(20);
  let result;
  handler.onCharacteristicGetValue("temperature", (err, value) => {
    result = [err, value];
  });
  assert.equal(result[0], null);
  assert.equal(result[1], 20);
});

test("fakegato history is not created when fakeGatoEnabled is false", () => {
  const before = fakeGatoConstructions.length;
  createHandler({ fakeGatoEnabled: false });
  assert.equal(fakeGatoConstructions.length, before);
});

test("fakegato history is created with a filename derived from the sensor's address", () => {
  const before = fakeGatoConstructions.length;
  createHandler({ fakeGatoEnabled: true });
  assert.equal(fakeGatoConstructions.length, before + 1);
  const last = fakeGatoConstructions[fakeGatoConstructions.length - 1];
  assert.equal(last.type, "room");
  assert.equal(last.options.filename, "fakegato-history_4c64a8d0ae65.json");
});

test("fakeGatoOptions is merged into the fakegato-history constructor options", () => {
  const before = fakeGatoConstructions.length;
  createHandler({
    fakeGatoEnabled: true,
    fakeGatoOptions: { minutes: 5, disableTimer: true },
  });
  assert.equal(fakeGatoConstructions.length, before + 1);
  const last = fakeGatoConstructions[fakeGatoConstructions.length - 1];
  assert.equal(last.options.minutes, 5);
  assert.equal(last.options.disableTimer, true);
  // The computed defaults are still present alongside the extra options.
  assert.equal(last.options.filename, "fakegato-history_4c64a8d0ae65.json");
  assert.equal(last.options.storage, "fs");
});

test("fakeGatoOptions can override the computed defaults (filename/path/storage)", () => {
  const before = fakeGatoConstructions.length;
  createHandler({
    fakeGatoEnabled: true,
    fakeGatoOptions: { storage: "googleDrive" },
  });
  assert.equal(fakeGatoConstructions.length, before + 1);
  const last = fakeGatoConstructions[fakeGatoConstructions.length - 1];
  assert.equal(last.options.storage, "googleDrive");
});

test("fakegato history behaves exactly as before when fakeGatoOptions is not configured", () => {
  const before = fakeGatoConstructions.length;
  createHandler({ fakeGatoEnabled: true });
  const last = fakeGatoConstructions[fakeGatoConstructions.length - 1];
  assert.equal(fakeGatoConstructions.length, before + 1);
  assert.deepEqual(Object.keys(last.options).sort(), [
    "filename",
    "path",
    "storage",
  ]);
});

test("the fakegato history service is actually attached to the platform accessory, not just constructed", () => {
  const { handler, platformAccessory } = createHandler({
    fakeGatoEnabled: true,
  });
  const attached = platformAccessory.getService(FakeGatoHistoryService);
  assert.notEqual(
    attached,
    undefined,
    "must be attached via addService, or HomeKit/Eve never sees it",
  );
  assert.equal(attached, handler.fakeGatoHistoryService);
});

test("fakegato history is constructed with the real platform accessory, not the handler itself", () => {
  const before = fakeGatoConstructions.length;
  const { platformAccessory } = createHandler({ fakeGatoEnabled: true });
  const last = fakeGatoConstructions[fakeGatoConstructions.length - 1];
  assert.equal(fakeGatoConstructions.length, before + 1);
  assert.equal(last.accessory, platformAccessory);
});

test("a restored (cached) accessory reuses its existing fakegato history service instead of creating a duplicate", () => {
  const platformAccessory = new FakePlatformAccessory(
    "Test",
    "uuid:cached-fakegato",
  );
  const first = new HygrothermographCgdk2AccessoryHandler(
    platformAccessory,
    { address: "4c:64:a8:d0:ae:65", fakeGatoEnabled: true },
    createSilentLog(),
  );
  const before = fakeGatoConstructions.length;
  const second = new HygrothermographCgdk2AccessoryHandler(
    platformAccessory,
    { address: "4c:64:a8:d0:ae:65", fakeGatoEnabled: true },
    createSilentLog(),
  );
  assert.equal(
    fakeGatoConstructions.length,
    before,
    "must not construct a second one",
  );
  assert.equal(second.fakeGatoHistoryService, first.fakeGatoHistoryService);
});

test("addFakeGatoHistoryEntry records an entry only once both temperature and humidity are known", () => {
  const { handler } = createHandler({ fakeGatoEnabled: true });
  const service = handler.fakeGatoHistoryService;
  handler.setTemperature(20);
  assert.equal(service.entries.length, 0);
  handler.setHumidity(50);
  assert.equal(service.entries.length, 1);
  assert.equal(service.entries[0].temp, 20);
  assert.equal(service.entries[0].humidity, 50);
});
