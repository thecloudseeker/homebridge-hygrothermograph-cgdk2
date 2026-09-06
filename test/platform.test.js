const { test } = require("node:test");
const assert = require("node:assert/strict");
const { stubModule } = require("./helpers/stubModule");
const {
  EventEmitter,
  FakePlatformAccessory,
  createSilentLog,
} = require("./helpers/fakeHap");
const { createFakeMatter } = require("./helpers/fakeMatter");

const platformPath = require.resolve("../lib/platform");

class FakeHandler {
  constructor(platformAccessory, config, log, matterAccessory) {
    this.platformAccessory = platformAccessory;
    this.config = config;
    this.log = log;
    this.matterAccessory = matterAccessory;
    this.calls = {
      temperature: [],
      humidity: [],
      battery: [],
      rssi: [],
      flush: 0,
    };
  }
  setTemperature(v) {
    this.calls.temperature.push(v);
  }
  setHumidity(v) {
    this.calls.humidity.push(v);
  }
  setBatteryLevel(v) {
    this.calls.battery.push(v);
  }
  setRSSI(v) {
    this.calls.rssi.push(v);
  }
  flushBatchedUpdate() {
    this.calls.flush += 1;
  }
}

class FakeScanner extends EventEmitter {
  constructor(address, options) {
    super();
    this.address = address;
    this.options = options;
    this.started = false;
    this.stopped = false;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeAPI extends EventEmitter {
  constructor({
    matterAvailable = false,
    matterEnabled = false,
    matterVersionSatisfied = true,
    matter,
  } = {}) {
    super();
    this.hap = { uuid: { generate: (seed) => `uuid:${seed}` } };
    this.platformAccessory = FakePlatformAccessory;
    this.registered = [];
    this.unregistered = [];
    // Matter is opt-in per test: most tests construct a plain FakeAPI (no
    // args), which must behave exactly as it did before Matter existed -
    // isMatterAvailable/isMatterEnabled/versionGreaterOrEqual simply aren't
    // there, so HygrothermographCgdk2Platform's optional-chained checks see
    // undefined and never touch `matter` at all.
    if (matterAvailable) {
      this.matter = matter || createFakeMatter();
      this.isMatterAvailable = () => true;
      this.isMatterEnabled = () => matterEnabled;
      this.versionGreaterOrEqual = () => matterVersionSatisfied;
    }
  }
  registerPlatformAccessories(pluginId, platformName, accessories) {
    this.registered.push(...accessories);
  }
  unregisterPlatformAccessories(pluginId, platformName, accessories) {
    this.unregistered.push(...accessories);
  }
}

// Stubs lib/accessory.js and lib/scanner.js so these tests exercise only
// platform.js's own discovery/routing/caching/config-merging logic, without
// touching real HAP-NodeJS, fakegato-history, or Bluetooth hardware.
function loadPlatform() {
  stubModule(platformPath, "./accessory", () => ({
    HygrothermographCgdk2AccessoryHandler: FakeHandler,
  }));
  const createdScanners = [];
  stubModule(platformPath, "./scanner", {
    Scanner: class extends FakeScanner {
      constructor(...args) {
        super(...args);
        createdScanners.push(this);
      }
    },
  });
  delete require.cache[platformPath];
  const { HygrothermographCgdk2Platform } = require("../lib/platform")({});
  return { HygrothermographCgdk2Platform, createdScanners };
}

function latestScanner(createdScanners) {
  return createdScanners[createdScanners.length - 1];
}

test("startDiscovery creates a single scanner with no address filter", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  new HygrothermographCgdk2Platform(createSilentLog(), {}, api);

  api.emit("didFinishLaunching");

  assert.equal(createdScanners.length, 1);
  assert.equal(latestScanner(createdScanners).address, null);
  assert.equal(latestScanner(createdScanners).started, true);
});

test("a newly discovered sensor gets its own accessory and handler", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {},
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.5, { address: "4c:64:a8:d0:ae:65" });

  assert.equal(platform.handlers.size, 1);
  assert.equal(api.registered.length, 1);
  const handler = platform.handlers.get("4c64a8d0ae65");
  assert.equal(handler.calls.temperature[0], 21.5);
});

test("two distinct sensors get two distinct accessories, each receiving only its own readings", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {},
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.5, { address: "4c:64:a8:d0:ae:65" });
  scanner.emit("humidityChange", 55, { address: "4c:64:a8:d0:ae:65" });
  scanner.emit("temperatureChange", 19.0, { address: "2c:34:b3:d4:a1:61" });

  assert.equal(platform.handlers.size, 2);
  assert.equal(api.registered.length, 2);

  const h1 = platform.handlers.get("4c64a8d0ae65");
  const h2 = platform.handlers.get("2c34b3d4a161");
  assert.equal(h1.calls.temperature[0], 21.5);
  assert.equal(h1.calls.humidity[0], 55);
  assert.equal(h2.calls.temperature[0], 19.0);
  assert.equal(h2.calls.humidity.length, 0);
});

test("the scanner's rssiChange event routes to the matching handler's setRSSI", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {},
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.5, { address: "4c:64:a8:d0:ae:65" });
  scanner.emit("rssiChange", -55, { address: "4c:64:a8:d0:ae:65" });

  const handler = platform.handlers.get("4c64a8d0ae65");
  assert.deepEqual(handler.calls.rssi, [-55]);
});

test("re-discovering the same sensor (even with different address casing) reuses its handler", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {},
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.5, { address: "4c:64:a8:d0:ae:65" });
  scanner.emit("temperatureChange", 22.0, { address: "4C:64:A8:D0:AE:65" });

  assert.equal(platform.handlers.size, 1);
  assert.equal(api.registered.length, 1);
  const handler = platform.handlers.get("4c64a8d0ae65");
  assert.deepEqual(handler.calls.temperature, [21.5, 22.0]);
});

test("an ignored address never gets an accessory", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    { ignoredAddresses: ["4c:64:a8:d0:ae:65"] },
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 99.9, { address: "4c:64:a8:d0:ae:65" });

  assert.equal(platform.handlers.size, 0);
  assert.equal(api.registered.length, 0);
});

test("a malformed (non-string) entry in ignoredAddresses does not crash discovery", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const errors = [];
  const log = { ...createSilentLog(), error: (...args) => errors.push(args) };
  const platform = new HygrothermographCgdk2Platform(
    log,
    { ignoredAddresses: [42, null, "2c:34:b3:d4:a1:61"] },
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  assert.doesNotThrow(() => {
    scanner.emit("temperatureChange", 21.0, { address: "4c:64:a8:d0:ae:65" });
  });

  assert.equal(platform.handlers.size, 1);
  assert.equal(
    errors.length,
    0,
    "a valid reading alongside junk entries should not itself log an error",
  );
});

test("a non-array sensors/ignoredAddresses config value does not crash discovery", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    { sensors: "oops, not an array", ignoredAddresses: "also not an array" },
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  assert.doesNotThrow(() => {
    scanner.emit("temperatureChange", 21.0, { address: "4c:64:a8:d0:ae:65" });
  });
  assert.equal(platform.handlers.size, 1);
});

test("configureAccessory catches and logs rather than throwing on a malformed cached accessory", () => {
  const { HygrothermographCgdk2Platform } = loadPlatform();
  const api = new FakeAPI();
  const errors = [];
  const log = { ...createSilentLog(), error: (...args) => errors.push(args) };
  const platform = new HygrothermographCgdk2Platform(
    log,
    { sensors: "not an array" },
    api,
  );
  const cached = new FakePlatformAccessory("Broken", "uuid:broken");
  cached.context.address = 12345; // not a string

  assert.doesNotThrow(() => platform.configureAccessory(cached));
});

test("configureAccessory restores a cached accessory's handler immediately, before didFinishLaunching", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {},
    api,
  );
  const cached = new FakePlatformAccessory("CGDK2 AE:65", "uuid:cached");
  cached.context.address = "4c:64:a8:d0:ae:65";

  platform.configureAccessory(cached);

  assert.equal(platform.handlers.size, 1);
  assert.equal(
    api.registered.length,
    0,
    "restoring from cache must not re-register",
  );

  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);
  scanner.emit("temperatureChange", 20.0, { address: "4c:64:a8:d0:ae:65" });

  assert.equal(
    platform.handlers.size,
    1,
    "rediscovery reuses the restored handler",
  );
  assert.equal(api.registered.length, 0);
});

test("configureAccessory ignores a cached accessory with no known address", () => {
  const { HygrothermographCgdk2Platform } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {},
    api,
  );
  const orphan = new FakePlatformAccessory("Orphan", "uuid:orphan");

  platform.configureAccessory(orphan);

  assert.equal(platform.handlers.size, 0);
});

test("a per-address override in config.sensors merges with platform-level defaults", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {
      lowBattery: 20,
      sensors: [
        { address: "4c:64:a8:d0:ae:65", name: "Living Room", lowBattery: 5 },
      ],
    },
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.0, { address: "4c:64:a8:d0:ae:65" });
  scanner.emit("temperatureChange", 21.0, { address: "2c:34:b3:d4:a1:61" });

  const overridden = platform.handlers.get("4c64a8d0ae65");
  const usingDefault = platform.handlers.get("2c34b3d4a161");
  assert.equal(overridden.config.name, "Living Room");
  assert.equal(overridden.config.lowBattery, 5);
  assert.equal(overridden.config.address, "4c:64:a8:d0:ae:65");
  assert.equal(usingDefault.config.lowBattery, 20);
  assert.equal(usingDefault.config.name, undefined);
});

test("a sensor's bindKey is parsed into the scanner's bindKeys map", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  new HygrothermographCgdk2Platform(
    createSilentLog(),
    {
      sensors: [
        {
          address: "4c:64:a8:d0:ae:65",
          bindKey: "0123456789abcdef0123456789abcdef",
        },
      ],
    },
    api,
  );
  api.emit("didFinishLaunching");

  const { bindKeys } = latestScanner(createdScanners).options;
  const key = bindKeys.get("4c64a8d0ae65");
  assert.ok(Buffer.isBuffer(key));
  assert.equal(key.toString("hex"), "0123456789abcdef0123456789abcdef");
});

test("an invalid bindKey is skipped with a warning instead of crashing discovery", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const warnings = [];
  const log = { ...createSilentLog(), warn: (msg) => warnings.push(msg) };
  new HygrothermographCgdk2Platform(
    log,
    { sensors: [{ address: "4c:64:a8:d0:ae:65", bindKey: "not-hex" }] },
    api,
  );

  assert.doesNotThrow(() => api.emit("didFinishLaunching"));

  const { bindKeys } = latestScanner(createdScanners).options;
  assert.equal(bindKeys.size, 0);
  assert.equal(warnings.length, 1);
});

test("multiple sensors each get their own distinct bindKey correctly mapped", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  new HygrothermographCgdk2Platform(
    createSilentLog(),
    {
      sensors: [
        { address: "4c:64:a8:d0:ae:65", bindKey: "1".repeat(32) },
        { address: "2c:34:b3:d4:a1:61", bindKey: "2".repeat(32) },
      ],
    },
    api,
  );
  api.emit("didFinishLaunching");

  const { bindKeys } = latestScanner(createdScanners).options;
  assert.equal(bindKeys.size, 2);
  assert.equal(bindKeys.get("4c64a8d0ae65").toString("hex"), "1".repeat(32));
  assert.equal(bindKeys.get("2c34b3d4a161").toString("hex"), "2".repeat(32));
});

test("a sensor with no bindKey configured contributes nothing to the bindKeys map", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  new HygrothermographCgdk2Platform(
    createSilentLog(),
    { sensors: [{ address: "4c:64:a8:d0:ae:65", name: "Living Room" }] },
    api,
  );
  api.emit("didFinishLaunching");

  const { bindKeys } = latestScanner(createdScanners).options;
  assert.equal(bindKeys.size, 0);
});

test("the platform's own top-level `name` does not leak into a discovered sensor's default name", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    { name: "HygrotermographCGDK2" }, // as Homebridge platform blocks commonly carry
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.0, { address: "4c:64:a8:d0:ae:65" });

  const handler = platform.handlers.get("4c64a8d0ae65");
  assert.equal(handler.config.name, undefined);
  assert.equal(api.registered[0].displayName, "CGDK2 AE:65");
});

test("shutdown stops the shared scanner and ends every handler's MQTT client", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {},
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);
  scanner.emit("temperatureChange", 21.0, { address: "4c:64:a8:d0:ae:65" });

  let ended = false;
  platform.handlers.get("4c64a8d0ae65").mqttClient = {
    end: () => (ended = true),
  };

  api.emit("shutdown");

  assert.equal(scanner.stopped, true);
  assert.equal(ended, true);
});

test("the scanner's 'change' event flushes the corresponding handler's batched update", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    { updateInterval: 5 },
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.0, { address: "4c:64:a8:d0:ae:65" });
  const handler = platform.handlers.get("4c64a8d0ae65");
  assert.equal(handler.calls.flush, 0, "discovery alone must not flush");

  scanner.emit("change", {}, { address: "4c:64:a8:d0:ae:65" });
  assert.equal(
    handler.calls.flush,
    1,
    "the scanner's change event must flush the handler",
  );
});

test("configureAccessory unregisters an already-cached accessory whose address became ignored", () => {
  const { HygrothermographCgdk2Platform } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    { ignoredAddresses: ["4c:64:a8:d0:ae:65"] },
    api,
  );
  const cached = new FakePlatformAccessory("CGDK2 AE:65", "uuid:cached");
  cached.context.address = "4c:64:a8:d0:ae:65";

  platform.configureAccessory(cached);

  assert.equal(
    platform.handlers.size,
    0,
    "must not restore a handler for a now-ignored address",
  );
  assert.deepEqual(api.unregistered, [cached]);
});

test("a per-sensor name override is applied to the accessory at creation time", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  new HygrothermographCgdk2Platform(
    createSilentLog(),
    { sensors: [{ address: "4c:64:a8:d0:ae:65", name: "Living Room" }] },
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.0, { address: "4c:64:a8:d0:ae:65" });

  assert.equal(api.registered.length, 1);
  assert.equal(api.registered[0].displayName, "Living Room");
});

test("startDiscovery logs which configured sensors it's still waiting to discover", () => {
  const { HygrothermographCgdk2Platform } = loadPlatform();
  const api = new FakeAPI();
  const infoMessages = [];
  const log = { ...createSilentLog(), info: (msg) => infoMessages.push(msg) };
  new HygrothermographCgdk2Platform(
    log,
    {
      sensors: [
        { address: "4c:64:a8:d0:ae:65" },
        { address: "2c:34:b3:d4:a1:61" },
      ],
    },
    api,
  );

  api.emit("didFinishLaunching");

  assert.ok(
    infoMessages.some(
      (msg) =>
        msg ===
        "Waiting to discover 2 configured sensor(s): [4c:64:a8:d0:ae:65, 2c:34:b3:d4:a1:61]",
    ),
  );
});

test("startDiscovery does not log a waiting list when no sensors are configured", () => {
  const { HygrothermographCgdk2Platform } = loadPlatform();
  const api = new FakeAPI();
  const infoMessages = [];
  const log = { ...createSilentLog(), info: (msg) => infoMessages.push(msg) };
  new HygrothermographCgdk2Platform(log, {}, api);

  api.emit("didFinishLaunching");

  assert.ok(!infoMessages.some((msg) => msg.startsWith("Waiting to discover")));
});

test("a configured sensor ignored via ignoredAddresses is excluded from the waiting list", () => {
  const { HygrothermographCgdk2Platform } = loadPlatform();
  const api = new FakeAPI();
  const infoMessages = [];
  const log = { ...createSilentLog(), info: (msg) => infoMessages.push(msg) };
  new HygrothermographCgdk2Platform(
    log,
    {
      ignoredAddresses: ["4c:64:a8:d0:ae:65"],
      sensors: [
        { address: "4c:64:a8:d0:ae:65" },
        { address: "2c:34:b3:d4:a1:61" },
      ],
    },
    api,
  );

  api.emit("didFinishLaunching");

  assert.ok(
    infoMessages.some(
      (msg) =>
        msg ===
        "Waiting to discover 1 configured sensor(s): [2c:34:b3:d4:a1:61]",
    ),
  );
});

test("the scanner's 'change' event logs a first-discovery confirmation for a new address", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const infoMessages = [];
  const log = { ...createSilentLog(), info: (msg) => infoMessages.push(msg) };
  new HygrothermographCgdk2Platform(log, {}, api);
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("change", {}, { address: "4c:64:a8:d0:ae:65" });

  assert.ok(
    infoMessages.includes(
      "[4c:64:a8:d0:ae:65] Sensor discovered - now receiving readings.",
    ),
  );
});

test("the first-discovery confirmation is only logged once per address, even across repeated 'change' events", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const infoMessages = [];
  const log = { ...createSilentLog(), info: (msg) => infoMessages.push(msg) };
  new HygrothermographCgdk2Platform(log, {}, api);
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("change", {}, { address: "4c:64:a8:d0:ae:65" });
  scanner.emit("change", {}, { address: "4c:64:a8:d0:ae:65" });

  const matches = infoMessages.filter((msg) =>
    msg.includes("Sensor discovered"),
  );
  assert.equal(matches.length, 1);
});

test("discovering a configured (but not yet the last) sensor lists what's still pending", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const infoMessages = [];
  const log = { ...createSilentLog(), info: (msg) => infoMessages.push(msg) };
  new HygrothermographCgdk2Platform(
    log,
    {
      sensors: [
        { address: "4c:64:a8:d0:ae:65" },
        { address: "2c:34:b3:d4:a1:61" },
      ],
    },
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("change", {}, { address: "4c:64:a8:d0:ae:65" });

  assert.ok(
    infoMessages.includes(
      "[4c:64:a8:d0:ae:65] Sensor discovered - now receiving readings. Still waiting for: [2c:34:b3:d4:a1:61]",
    ),
  );
});

test("discovering the last remaining configured sensor announces that all have been found", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const infoMessages = [];
  const log = { ...createSilentLog(), info: (msg) => infoMessages.push(msg) };
  new HygrothermographCgdk2Platform(
    log,
    {
      sensors: [
        { address: "4c:64:a8:d0:ae:65" },
        { address: "2c:34:b3:d4:a1:61" },
      ],
    },
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("change", {}, { address: "4c:64:a8:d0:ae:65" });
  scanner.emit("change", {}, { address: "2c:34:b3:d4:a1:61" });

  assert.ok(
    infoMessages.includes(
      "[2c:34:b3:d4:a1:61] Sensor discovered - now receiving readings. All configured sensors have been found.",
    ),
  );
});

test("an ignored address never triggers a first-discovery confirmation", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const infoMessages = [];
  const log = { ...createSilentLog(), info: (msg) => infoMessages.push(msg) };
  new HygrothermographCgdk2Platform(
    log,
    { ignoredAddresses: ["4c:64:a8:d0:ae:65"] },
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("change", {}, { address: "4c:64:a8:d0:ae:65" });

  assert.ok(!infoMessages.some((msg) => msg.includes("Sensor discovered")));
});

test("a per-sensor mqtt override merges with (not replaces) the platform-level mqtt config", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {
      mqtt: { url: "mqtt://broker", username: "admin" },
      sensors: [
        {
          address: "4c:64:a8:d0:ae:65",
          mqtt: { temperatureTopic: "custom/topic" },
        },
      ],
    },
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.0, { address: "4c:64:a8:d0:ae:65" });

  const handler = platform.handlers.get("4c64a8d0ae65");
  assert.deepEqual(handler.config.mqtt, {
    url: "mqtt://broker",
    username: "admin",
    temperatureTopic: "custom/topic",
  });
});

test("without Matter available, a discovered sensor's handler gets no Matter accessory", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI();
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {},
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.5, { address: "4c:64:a8:d0:ae:65" });

  const handler = platform.handlers.get("4c64a8d0ae65");
  assert.equal(handler.matterAccessory, undefined);
  assert.equal(api.registered.length, 1, "the HAP accessory is unaffected");
});

test("with Matter available but not enabled on this bridge, no Matter accessory is registered", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI({ matterAvailable: true, matterEnabled: false });
  new HygrothermographCgdk2Platform(createSilentLog(), {}, api);
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.5, { address: "4c:64:a8:d0:ae:65" });

  assert.equal(api.matter.accessories.size, 0);
});

test("with Matter enabled, a newly discovered sensor also gets a composed Matter accessory registered", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI({ matterAvailable: true, matterEnabled: true });
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {},
    api,
  );
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.5, { address: "4c:64:a8:d0:ae:65" });

  const handler = platform.handlers.get("4c64a8d0ae65");
  assert.notEqual(handler.matterAccessory, undefined);
  assert.equal(api.matter.accessories.size, 1);
  const [registered] = api.matter.accessories.values();
  assert.equal(registered.UUID, handler.matterAccessory.UUID);
  assert.equal(registered.deviceType, api.matter.deviceTypes.BridgedNode);
  assert.equal(registered.parts.length, 2);
});

// Relies on handlerFor()'s own `this.handlers` dedup (see "re-discovering
// the same sensor ... reuses its handler" above) rather than any separate
// Matter-specific dedup: buildMatterAccessory has none, since registerHandler
// (its only caller) is itself never invoked twice for the same address.
test("re-discovering the same sensor does not register a second Matter accessory", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI({ matterAvailable: true, matterEnabled: true });
  new HygrothermographCgdk2Platform(createSilentLog(), {}, api);
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.5, { address: "4c:64:a8:d0:ae:65" });
  scanner.emit("temperatureChange", 21.6, { address: "4C:64:A8:D0:AE:65" });

  assert.equal(api.matter.accessories.size, 1);
});

test("configureMatterAccessory unregisters a cached Matter accessory whose address became ignored", () => {
  const { HygrothermographCgdk2Platform } = loadPlatform();
  const matter = createFakeMatter();
  const cachedMatterAccessory = {
    UUID: "matter-uuid:cached",
    displayName: "CGDK2 AE:65",
    context: { address: "4c:64:a8:d0:ae:65" },
  };
  matter.accessories.set(cachedMatterAccessory.UUID, cachedMatterAccessory);
  const api = new FakeAPI({
    matterAvailable: true,
    matterEnabled: true,
    matter,
  });
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    { ignoredAddresses: ["4c:64:a8:d0:ae:65"] },
    api,
  );

  platform.configureMatterAccessory(cachedMatterAccessory);

  assert.equal(matter.accessories.has(cachedMatterAccessory.UUID), false);
});

test("configureMatterAccessory leaves a cached Matter accessory alone when its address is still active", () => {
  const { HygrothermographCgdk2Platform } = loadPlatform();
  const matter = createFakeMatter();
  const cachedMatterAccessory = {
    UUID: "matter-uuid:cached",
    displayName: "CGDK2 AE:65",
    context: { address: "4c:64:a8:d0:ae:65" },
  };
  matter.accessories.set(cachedMatterAccessory.UUID, cachedMatterAccessory);
  const api = new FakeAPI({
    matterAvailable: true,
    matterEnabled: true,
    matter,
  });
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {},
    api,
  );

  platform.configureMatterAccessory(cachedMatterAccessory);

  assert.equal(matter.accessories.has(cachedMatterAccessory.UUID), true);
});

// Homebridge's own Matter API rejects registerPlatformAccessories() called
// before didFinishLaunching ("Do this from your platform's
// 'didFinishLaunching' event, not during plugin initialisation" - verified
// against Homebridge 2.4.0's real source), and configureAccessory (which
// restores cached accessories) runs before that point.
test("a cached accessory restored via configureAccessory gets its Matter accessory only once didFinishLaunching fires, not during the restore itself", () => {
  const { HygrothermographCgdk2Platform } = loadPlatform();
  const api = new FakeAPI({ matterAvailable: true, matterEnabled: true });
  const platform = new HygrothermographCgdk2Platform(
    createSilentLog(),
    {},
    api,
  );
  const cached = new FakePlatformAccessory("CGDK2 AE:65", "uuid:cached");
  cached.context.address = "4c:64:a8:d0:ae:65";

  platform.configureAccessory(cached);
  const handler = platform.handlers.get("4c64a8d0ae65");
  assert.equal(
    handler.matterAccessory,
    undefined,
    "must not attempt Matter registration before didFinishLaunching",
  );
  assert.equal(api.matter.accessories.size, 0);

  api.emit("didFinishLaunching");

  assert.notEqual(handler.matterAccessory, undefined);
  assert.equal(api.matter.accessories.size, 1);
});

test("matterEnabled additionally requires versionGreaterOrEqual('2.4.0'), not just isMatterAvailable/isMatterEnabled", () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const api = new FakeAPI({
    matterAvailable: true,
    matterEnabled: true,
    matterVersionSatisfied: false,
  });
  new HygrothermographCgdk2Platform(createSilentLog(), {}, api);
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.5, { address: "4c:64:a8:d0:ae:65" });

  assert.equal(api.matter.accessories.size, 0);
});

// isMatterEnabled() is not a reliable "Matter works on THIS bridge" signal by
// itself (verified against Homebridge 2.4.0's real source): on a plugin
// running on the main bridge it is set merely because *some* bridge in the
// whole config has Matter on, including an unrelated plugin's own child
// bridge, and registerPlatformAccessories then rejects with "Matter is not
// enabled for this bridge". Without handling that, every subsequent reading
// would try to push to an accessory that was never actually registered.
// The actual "no repeated error spam on every subsequent reading" behavior
// is Cgdk2MatterAccessory.pushState's own guard, exercised directly in
// matterAccessory.test.js ("pushState does nothing after
// markRegistrationFailed()"); platform.test.js stubs out lib/accessory.js
// entirely (FakeHandler never touches matterAccessory), so this only checks
// that the platform correctly marks the real Cgdk2MatterAccessory instance
// as failed - once - rather than that no fake spam.
test("a rejected Matter registration marks the accessory failed (once, not registered) instead of silently succeeding", async () => {
  const { HygrothermographCgdk2Platform, createdScanners } = loadPlatform();
  const matter = createFakeMatter({
    registrationError: new Error("Matter is not enabled for this bridge"),
  });
  const errors = [];
  const log = { ...createSilentLog(), error: (...args) => errors.push(args) };
  const api = new FakeAPI({
    matterAvailable: true,
    matterEnabled: true,
    matter,
  });
  const platform = new HygrothermographCgdk2Platform(log, {}, api);
  api.emit("didFinishLaunching");
  const scanner = latestScanner(createdScanners);

  scanner.emit("temperatureChange", 21.5, { address: "4c:64:a8:d0:ae:65" });
  const handler = platform.handlers.get("4c64a8d0ae65");
  assert.notEqual(handler.matterAccessory, undefined);

  // The registration promise's rejection handler runs on a later microtask.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(handler.matterAccessory.registered, false);
  assert.equal(handler.matterAccessory.registrationFailed, true);
  assert.equal(errors.length, 1);
});
