const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createFakeMatter } = require("./helpers/fakeMatter");
const { createSilentLog } = require("./helpers/fakeHap");
const { Cgdk2MatterAccessory } = require("../lib/matterAccessory");

function createMatterAccessory(matter = createFakeMatter(), overrides = {}) {
  const accessory = new Cgdk2MatterAccessory(matter, createSilentLog(), {
    address: "58:2d:34:13:20:a8",
    name: "CGDK2 20A8",
    temperatureName: "Temperature",
    humidityName: "Humidity",
    ...overrides,
  });
  return { accessory, matter };
}

// Most tests below need pushState's `registered` guard open, since that's
// what markRegistered() exists to gate - see the dedicated
// "before registration"/"registration failed" tests for the guard itself.
function createRegisteredMatterAccessory(...args) {
  const result = createMatterAccessory(...args);
  result.accessory.markRegistered();
  return result;
}

function partOf(built, id) {
  return built.parts.find((part) => part.id === id);
}

test("toAccessories() builds one composed device with a temperature and a humidity part", () => {
  const { accessory, matter } = createMatterAccessory();
  const built = accessory.toAccessories();

  assert.equal(built.length, 1);
  const [device] = built;
  assert.equal(device.deviceType, matter.deviceTypes.BridgedNode);
  assert.deepEqual(
    device.parts.map((part) => [part.id, part.deviceType]),
    [
      ["temperature", matter.deviceTypes.TemperatureSensor],
      ["humidity", matter.deviceTypes.HumiditySensor],
    ],
  );
  assert.deepEqual(device.context, { address: "58:2d:34:13:20:a8" });
});

test("the device carries the sensor name, and each part its own reading name", () => {
  const { accessory } = createMatterAccessory();
  const [device] = accessory.toAccessories();

  assert.equal(device.displayName, "CGDK2 20A8");
  assert.equal(partOf(device, "temperature").displayName, "Temperature");
  assert.equal(partOf(device, "humidity").displayName, "Humidity");
  assert.equal(device.serialNumber, "582d341320a8");
});

test("names and serial numbers are trimmed to the 32 characters Matter allows", () => {
  const { accessory } = createMatterAccessory(createFakeMatter(), {
    address: "5C61F8CE-9F0B-4371-B996-5C9AE0E0D14B",
    name: "A really quite excessively long sensor name",
    temperatureName: "A really quite excessively long temperature name",
  });
  const [device] = accessory.toAccessories();

  assert.ok(device.displayName.length <= 32);
  assert.ok(device.serialNumber.length <= 32);
  assert.ok(partOf(device, "temperature").displayName.length <= 32);
});

test("the device declares a battery PowerSource with every attribute the Battery feature requires", () => {
  const { accessory } = createMatterAccessory();
  const [device] = accessory.toAccessories();

  assert.deepEqual(device.clusters.powerSource, {
    status: 1,
    order: 0,
    description: "Battery",
    endpointList: [],
    batPercentRemaining: null,
    batChargeLevel: 0,
    batReplacementNeeded: false,
    batReplaceability: 0,
  });
});

test("the initial reading state is null (no reading yet), not a placeholder number", () => {
  const { accessory } = createMatterAccessory();
  const [device] = accessory.toAccessories();

  assert.equal(
    partOf(device, "temperature").clusters.temperatureMeasurement.measuredValue,
    null,
  );
  assert.equal(
    partOf(device, "humidity").clusters.relativeHumidityMeasurement
      .measuredValue,
    null,
  );
});

test("the declared temperature range is much wider than the sensor's physical range, to tolerate a configured offset", () => {
  const { accessory } = createMatterAccessory();
  const { temperatureMeasurement } = partOf(
    accessory.toAccessories()[0],
    "temperature",
  ).clusters;

  assert.equal(temperatureMeasurement.minMeasuredValue, -5000);
  assert.equal(temperatureMeasurement.maxMeasuredValue, 10000);
});

test("the UUID is derived from the address, stable across instances, and matches uuidFor()", () => {
  const matter = createFakeMatter();
  const { accessory: first } = createMatterAccessory(matter);
  const { accessory: second } = createMatterAccessory(matter);

  assert.equal(first.accessory.UUID, second.accessory.UUID);
  assert.equal(
    first.accessory.UUID,
    Cgdk2MatterAccessory.uuidFor(matter, "58:2D:34:13:20:A8"),
  );
});

test("two different addresses get different UUIDs", () => {
  const matter = createFakeMatter();
  const { accessory: first } = createMatterAccessory(matter, {
    address: "58:2d:34:13:20:a8",
  });
  const { accessory: second } = createMatterAccessory(matter, {
    address: "4c:64:a8:d0:ae:65",
  });
  assert.notEqual(first.accessory.UUID, second.accessory.UUID);
});

test("pushState does nothing before markRegistered() has been called", async () => {
  const { accessory, matter } = createMatterAccessory();
  await accessory.updateTemperature(21.3);
  await accessory.updateBattery(80, 10);
  await accessory.syncNodeLabel();
  assert.equal(matter.stateUpdates.length, 0);
});

test("pushState does nothing after markRegistrationFailed() has been called", async () => {
  const { accessory, matter } = createMatterAccessory();
  accessory.markRegistered();
  accessory.markRegistrationFailed();
  await accessory.updateTemperature(21.3);
  assert.equal(matter.stateUpdates.length, 0);
});

test("updateTemperature pushes measuredValue in hundredths of a degree to the temperature part", async () => {
  const { accessory, matter } = createRegisteredMatterAccessory();
  await accessory.updateTemperature(21.3);

  assert.deepEqual(matter.stateUpdates, [
    {
      uuid: accessory.accessory.UUID,
      cluster: "temperatureMeasurement",
      attributes: { measuredValue: 2130 },
      partId: "temperature",
    },
  ]);
});

test("updateHumidity pushes measuredValue in hundredths of a percent to the humidity part", async () => {
  const { accessory, matter } = createRegisteredMatterAccessory();
  await accessory.updateHumidity(55.5);

  assert.deepEqual(matter.stateUpdates, [
    {
      uuid: accessory.accessory.UUID,
      cluster: "relativeHumidityMeasurement",
      attributes: { measuredValue: 5550 },
      partId: "humidity",
    },
  ]);
});

test("updateHumidity clamps an offset-adjusted value to the 0-100 range Matter allows", async () => {
  const { accessory, matter } = createRegisteredMatterAccessory();
  await accessory.updateHumidity(103);
  await accessory.updateHumidity(-3);

  assert.deepEqual(
    matter.stateUpdates.map((update) => update.attributes.measuredValue),
    [10000, 0],
  );
});

test("updateTemperature(null) and updateHumidity(null) push null - Matter's own idiom for no current reading - rather than nothing", async () => {
  const { accessory, matter } = createRegisteredMatterAccessory();
  await accessory.updateTemperature(null);
  await accessory.updateHumidity(undefined);

  assert.equal(matter.stateUpdates.length, 2);
  assert.equal(matter.stateUpdates[0].attributes.measuredValue, null);
  assert.equal(matter.stateUpdates[1].attributes.measuredValue, null);
});

test("updateBattery pushes batPercentRemaining in half-percent units to the device itself, not a part", async () => {
  const { accessory, matter } = createRegisteredMatterAccessory();
  await accessory.updateBattery(87, 10);

  assert.deepEqual(matter.stateUpdates, [
    {
      uuid: accessory.accessory.UUID,
      cluster: "powerSource",
      attributes: { batPercentRemaining: 174, batChargeLevel: 0 },
      partId: undefined,
    },
  ]);
});

test("updateBattery flags a warning at or below the low-battery threshold, matching HAP's StatusLowBattery", async () => {
  const { accessory, matter } = createRegisteredMatterAccessory();
  await accessory.updateBattery(11, 10);
  await accessory.updateBattery(10, 10);
  await accessory.updateBattery(3, 10);

  assert.deepEqual(
    matter.stateUpdates.map((update) => update.attributes.batChargeLevel),
    [0, 1, 1],
  );
});

test("updateBattery clamps to 0-100% and pushes null when there is no reading", async () => {
  const { accessory, matter } = createRegisteredMatterAccessory();
  await accessory.updateBattery(120, 10);
  await accessory.updateBattery(-5, 10);
  await accessory.updateBattery(null);

  assert.deepEqual(
    matter.stateUpdates.map((update) => update.attributes.batPercentRemaining),
    [200, 0, null],
  );
});

test("syncNodeLabel pushes the sensor's current name as the device's NodeLabel", async () => {
  const { accessory, matter } = createRegisteredMatterAccessory();
  await accessory.syncNodeLabel();

  assert.deepEqual(matter.stateUpdates, [
    {
      uuid: accessory.accessory.UUID,
      cluster: "bridgedDeviceBasicInformation",
      attributes: { nodeLabel: "CGDK2 20A8" },
      partId: undefined,
    },
  ]);
});

test("a rejected updateAccessoryState is logged rather than thrown", async () => {
  const errors = [];
  const log = { ...createSilentLog(), error: (...args) => errors.push(args) };
  const matter = createFakeMatter();
  matter.updateAccessoryState = async () => {
    throw new Error("Matter server unavailable");
  };
  const accessory = new Cgdk2MatterAccessory(matter, log, {
    address: "58:2d:34:13:20:a8",
    name: "CGDK2 20A8",
    temperatureName: "Temperature",
    humidityName: "Humidity",
  });
  accessory.markRegistered();

  await assert.doesNotReject(() => accessory.updateTemperature(21));
  assert.equal(errors.length, 1);
});
