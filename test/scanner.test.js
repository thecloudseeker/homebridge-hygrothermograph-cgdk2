const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { stubModule } = require("./helpers/stubModule");
const { EventEmitter, createSilentLog } = require("./helpers/fakeHap");
const {
  buildFrame,
  temperatureHumidityObject,
  batteryObject,
} = require("./helpers/miBeaconFrame");
const { cleanAddress } = require("../lib/address");

const scannerPath = require.resolve("../lib/scanner");

class FakeNoble extends EventEmitter {
  constructor() {
    super();
    this.startScanningCalls = [];
    this.stopScanningCalls = 0;
    this.startScanningImpl = () => {};
  }
  startScanning(...args) {
    this.startScanningCalls.push(args);
    this.startScanningImpl(...args);
  }
  stopScanning() {
    this.stopScanningCalls += 1;
  }
}

// Scanner.js requires @stoprocent/noble (a native module) at the top level
// and treats it as a singleton, matching real usage. To keep each test
// isolated we stub noble fresh and force a fresh require of scanner.js
// every time, rather than sharing one noble/Scanner across tests.
function loadScanner() {
  const noble = new FakeNoble();
  stubModule(scannerPath, "@stoprocent/noble", noble);
  delete require.cache[scannerPath];
  const { Scanner } = require("../lib/scanner");
  return { Scanner, noble };
}

function peripheral({ address, id, serviceData }) {
  return { address, id, advertisement: { localName: "test", serviceData } };
}

const validServiceData = (hex) => [
  { uuid: "fdcd", data: Buffer.from(hex.replace(/:/g, ""), "hex") },
];

const GOOD_HEX = "50:20:aa:bb:cc:dd:ee:ff:00:00:f5:00:26:02:00:00:50"; // 24.5C/55.0%/80%

test("isValidAddress matches everything when no address filter is set", () => {
  const { Scanner } = loadScanner();
  const scanner = new Scanner(null, { log: createSilentLog() });
  assert.equal(scanner.isValidAddress("4c:64:a8:d0:ae:65"), true);
  assert.equal(scanner.isValidAddress(undefined), true);
});

test("isValidAddress compares addresses case- and separator-insensitively", () => {
  const { Scanner } = loadScanner();
  const scanner = new Scanner("4C:64:A8:D0:AE:65", { log: createSilentLog() });
  assert.equal(scanner.isValidAddress("4c:64:a8:d0:ae:65"), true);
  assert.equal(scanner.isValidAddress("4c-64-a8-d0-ae-65"), true);
  assert.equal(scanner.isValidAddress("2c:34:b3:d4:a1:61"), false);
});

test("handleDiscover ignores a peripheral whose address doesn't match the filter", () => {
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner("4c:64:a8:d0:ae:65", { log: createSilentLog() });
  const events = [];
  scanner.on("temperatureChange", (v) => events.push(v));

  noble.emit(
    "discover",
    peripheral({
      address: "2c:34:b3:d4:a1:61",
      serviceData: validServiceData(GOOD_HEX),
    }),
  );

  assert.deepEqual(events, []);
});

test("handleDiscover ignores a peripheral with no matching service data UUID", () => {
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner(null, { log: createSilentLog() });
  const events = [];
  scanner.on("temperatureChange", (v) => events.push(v));

  noble.emit(
    "discover",
    peripheral({
      address: "4c:64:a8:d0:ae:65",
      serviceData: [{ uuid: "fe95", data: Buffer.alloc(17) }],
    }),
  );

  assert.deepEqual(events, []);
});

test("handleDiscover matches a service data UUID regardless of case", () => {
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner(null, { log: createSilentLog() });
  const events = [];
  scanner.on("temperatureChange", (v) => events.push(v));

  noble.emit(
    "discover",
    peripheral({
      address: "4c:64:a8:d0:ae:65",
      serviceData: [
        { uuid: "FDCD", data: Buffer.from(GOOD_HEX.replace(/:/g, ""), "hex") },
      ],
    }),
  );

  assert.deepEqual(events, [24.5]);
});

test("handleDiscover emits temperature, humidity, and battery for a valid CGDK2 advertisement", () => {
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner(null, { log: createSilentLog() });
  const seen = { temperature: [], humidity: [], battery: [], change: [] };
  scanner.on("temperatureChange", (v, p) => seen.temperature.push([v, p]));
  scanner.on("humidityChange", (v, p) => seen.humidity.push([v, p]));
  scanner.on("batteryChange", (v, p) => seen.battery.push([v, p]));
  scanner.on("change", (event, p) => seen.change.push([event, p]));

  noble.emit(
    "discover",
    peripheral({
      address: "4c:64:a8:d0:ae:65",
      serviceData: validServiceData(GOOD_HEX),
    }),
  );

  assert.deepEqual(seen.temperature, [
    [24.5, { id: undefined, address: "4c:64:a8:d0:ae:65" }],
  ]);
  assert.deepEqual(seen.humidity, [
    [55, { id: undefined, address: "4c:64:a8:d0:ae:65" }],
  ]);
  assert.deepEqual(seen.battery, [
    [80, { id: undefined, address: "4c:64:a8:d0:ae:65" }],
  ]);
  assert.equal(seen.change.length, 1);
});

test("a malformed advertisement emits 'error' instead of throwing", () => {
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner(null, { log: createSilentLog() });
  const errors = [];
  scanner.on("error", (e) => errors.push(e));

  assert.doesNotThrow(() => {
    noble.emit(
      "discover",
      peripheral({
        address: "4c:64:a8:d0:ae:65",
        serviceData: [{ uuid: "fdcd", data: Buffer.alloc(5) }], // too short to parse
      }),
    );
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Service data length must be >= 17 bytes/);
});

test("onDiscover updates lastDiscoveryAt even for advertisements that don't match", () => {
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner("4c:64:a8:d0:ae:65", { log: createSilentLog() });
  assert.equal(scanner.lastDiscoveryAt, null);

  noble.emit(
    "discover",
    peripheral({ address: "2c:34:b3:d4:a1:61", serviceData: [] }),
  );

  assert.notEqual(scanner.lastDiscoveryAt, null);
});

test("start() begins scanning and stop() ends it", () => {
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner(null, { log: createSilentLog() });

  scanner.start();
  assert.equal(scanner.scanning, true);
  assert.deepEqual(noble.startScanningCalls, [[[], true]]);

  scanner.stop();
  assert.equal(scanner.scanning, false);
  assert.equal(noble.stopScanningCalls, 1);
});

test("start() schedules a restart if noble.startScanning throws", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { Scanner, noble } = loadScanner();
  noble.startScanningImpl = () => {
    throw new Error("adapter not ready");
  };
  const scanner = new Scanner(null, { log: createSilentLog() });

  scanner.start();

  assert.equal(scanner.scanning, false);
  assert.notEqual(scanner.restartTimer, null);
});

test("onScanStop schedules a restart only when forceDiscovering is enabled", () => {
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner(null, {
    log: createSilentLog(),
    forceDiscovering: false,
  });
  scanner.start();

  noble.emit("scanStop");
  assert.equal(scanner.restartTimer, null);

  scanner.forceDiscovering = true;
  noble.emit("scanStop");
  assert.notEqual(scanner.restartTimer, null);
});

test("onStateChange('poweredOn') resets restart attempts and starts scanning", () => {
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner(null, { log: createSilentLog() });
  scanner.restartAttempts = 3;

  noble.emit("stateChange", "poweredOn");

  assert.equal(scanner.restartAttempts, 0);
  assert.equal(scanner.scanning, true);
});

test("onStateChange(non-poweredOn) stops scanning", () => {
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner(null, { log: createSilentLog() });
  scanner.start();

  noble.emit("stateChange", "poweredOff");

  assert.equal(scanner.scanning, false);
  assert.equal(noble.stopScanningCalls, 1);
});

test("scheduleRestart uses capped exponential backoff", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0); // strip jitter for deterministic assertions
  const { Scanner } = loadScanner();
  const scanner = new Scanner(null, {
    log: createSilentLog(),
    restartDelay: 1000,
  });

  const delays = [];
  const originalSetTimeout = global.setTimeout;
  t.mock.method(global, "setTimeout", (fn, delay) => {
    delays.push(delay);
    return originalSetTimeout(fn, delay);
  });

  scanner.scheduleRestart(); // attempt 0 -> 1000 * 2^0 = 1000
  scanner.scheduleRestart(); // attempt 1 -> 1000 * 2^1 = 2000
  scanner.scheduleRestart(); // attempt 2 -> 1000 * 2^2 = 4000

  assert.deepEqual(delays, [1000, 2000, 4000]);

  scanner.restartAttempts = 20; // absurdly high, must stay capped
  scanner.scheduleRestart();
  assert.equal(delays[3], 60000);
});

test("the watchdog force-restarts a scan that has gone silent too long", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner(null, { log: createSilentLog() });

  scanner.start();
  assert.equal(noble.stopScanningCalls, 0);

  t.mock.timers.tick(179000); // just under the 3-minute watchdog timeout
  assert.equal(noble.stopScanningCalls, 0);

  t.mock.timers.tick(2000); // now past it
  assert.equal(noble.stopScanningCalls, 1);
  assert.notEqual(scanner.restartTimer, null);
});

test("handleDiscover decrypts an encrypted MiBeacon advertisement when a bindKey is configured", () => {
  const { Scanner, noble } = loadScanner();
  const address = "4c:64:a8:d0:ae:65";
  const bindKey = crypto.randomBytes(16);
  const bindKeys = new Map([[cleanAddress(address), bindKey]]);
  const scanner = new Scanner(null, { log: createSilentLog(), bindKeys });
  const seen = { temperature: [], humidity: [] };
  scanner.on("temperatureChange", (v) => seen.temperature.push(v));
  scanner.on("humidityChange", (v) => seen.humidity.push(v));

  const frame = buildFrame({
    mac: address,
    bindKey,
    plaintext: temperatureHumidityObject(24.5, 55),
  });

  noble.emit(
    "discover",
    peripheral({
      address,
      serviceData: [{ uuid: "fe95", data: frame }],
    }),
  );

  assert.deepEqual(seen.temperature, [24.5]);
  assert.deepEqual(seen.humidity, [55]);
});

test("handleDiscover ignores an encrypted MiBeacon advertisement when no bindKey is configured, warning once", () => {
  const { Scanner, noble } = loadScanner();
  const address = "4c:64:a8:d0:ae:65";
  const warnings = [];
  const log = { ...createSilentLog(), warn: (msg) => warnings.push(msg) };
  const scanner = new Scanner(null, { log });
  const events = [];
  scanner.on("temperatureChange", (v) => events.push(v));

  const frame = buildFrame({
    mac: address,
    bindKey: crypto.randomBytes(16),
    plaintext: temperatureHumidityObject(24.5, 55),
  });

  noble.emit(
    "discover",
    peripheral({ address, serviceData: [{ uuid: "fe95", data: frame }] }),
  );
  noble.emit(
    "discover",
    peripheral({ address, serviceData: [{ uuid: "fe95", data: frame }] }),
  );

  assert.deepEqual(events, []);
  assert.equal(warnings.length, 1);
});

test("handleDiscover prefers the unencrypted native format over an encrypted advertisement", () => {
  const { Scanner, noble } = loadScanner();
  const address = "4c:64:a8:d0:ae:65";
  const bindKey = crypto.randomBytes(16);
  const bindKeys = new Map([[cleanAddress(address), bindKey]]);
  const scanner = new Scanner(null, { log: createSilentLog(), bindKeys });
  const events = [];
  scanner.on("temperatureChange", (v) => events.push(v));

  const encryptedFrame = buildFrame({
    mac: address,
    bindKey,
    plaintext: batteryObject(1), // deliberately different from GOOD_HEX's 24.5C
  });

  noble.emit(
    "discover",
    peripheral({
      address,
      serviceData: [
        ...validServiceData(GOOD_HEX),
        { uuid: "fe95", data: encryptedFrame },
      ],
    }),
  );

  assert.deepEqual(events, [24.5]);
});

test("handleDiscover matches the encrypted MiBeacon service data UUID regardless of case", () => {
  const { Scanner, noble } = loadScanner();
  const address = "4c:64:a8:d0:ae:65";
  const bindKey = crypto.randomBytes(16);
  const bindKeys = new Map([[cleanAddress(address), bindKey]]);
  const scanner = new Scanner(null, { log: createSilentLog(), bindKeys });
  const events = [];
  scanner.on("temperatureChange", (v) => events.push(v));

  const frame = buildFrame({
    mac: address,
    bindKey,
    plaintext: temperatureHumidityObject(24.5, 55),
  });

  noble.emit(
    "discover",
    peripheral({ address, serviceData: [{ uuid: "FE95", data: frame }] }),
  );

  assert.deepEqual(events, [24.5]);
});

test("the bindKeys lookup is case- and separator-insensitive, matching how sensors[].address is normalized", () => {
  const { Scanner, noble } = loadScanner();
  const bindKey = crypto.randomBytes(16);
  // Configured (as a user would type it in config.json) with uppercase and colons...
  const bindKeys = new Map([[cleanAddress("4C:64:A8:D0:AE:65"), bindKey]]);
  const scanner = new Scanner(null, { log: createSilentLog(), bindKeys });
  const events = [];
  scanner.on("temperatureChange", (v) => events.push(v));

  // ...but noble reports it lowercase, no separators.
  const discoveredAddress = "4c64a8d0ae65";
  const frame = buildFrame({
    mac: "4c:64:a8:d0:ae:65",
    bindKey,
    plaintext: temperatureHumidityObject(24.5, 55),
  });

  noble.emit(
    "discover",
    peripheral({
      address: discoveredAddress,
      serviceData: [{ uuid: "fe95", data: frame }],
    }),
  );

  assert.deepEqual(events, [24.5]);
});

test("a wrong bindKey emits 'error' instead of throwing", () => {
  const { Scanner, noble } = loadScanner();
  const address = "4c:64:a8:d0:ae:65";
  const bindKeys = new Map([[cleanAddress(address), crypto.randomBytes(16)]]);
  const scanner = new Scanner(null, { log: createSilentLog(), bindKeys });
  const errors = [];
  scanner.on("error", (e) => errors.push(e));

  const frame = buildFrame({
    mac: address,
    bindKey: crypto.randomBytes(16), // different key than what's configured
    plaintext: temperatureHumidityObject(24.5, 55),
  });

  assert.doesNotThrow(() => {
    noble.emit(
      "discover",
      peripheral({ address, serviceData: [{ uuid: "fe95", data: frame }] }),
    );
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Failed to decrypt MiBeacon payload/);
});

test("the watchdog does not fire while advertisements keep arriving", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { Scanner, noble } = loadScanner();
  const scanner = new Scanner(null, { log: createSilentLog() });
  scanner.start();

  // A discovery every 60s, well under the 3-minute watchdog timeout.
  for (let i = 0; i < 5; i += 1) {
    t.mock.timers.tick(60000);
    noble.emit(
      "discover",
      peripheral({ address: "4c:64:a8:d0:ae:65", serviceData: [] }),
    );
  }

  assert.equal(noble.stopScanningCalls, 0);
});
