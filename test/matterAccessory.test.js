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

test("toAccessories() builds two flat sensors rather than one composed device with parts", () => {
  const { accessory, matter } = createMatterAccessory();
  const [temperature, humidity] = accessory.toAccessories();

  assert.equal(accessory.toAccessories().length, 2);
  assert.equal(temperature.deviceType, matter.deviceTypes.TemperatureSensor);
  assert.equal(humidity.deviceType, matter.deviceTypes.HumiditySensor);
  for (const built of [temperature, humidity]) {
    assert.equal(
      built.parts,
      undefined,
      "a composed device had every subscription to it rejected by the controller",
    );
    assert.notEqual(built.deviceType, matter.deviceTypes.BridgedNode);
    assert.deepEqual(built.context, { address: "58:2d:34:13:20:a8" });
  }
});

test("each sensor gets its own UUID, serial number and name", () => {
  const { accessory } = createMatterAccessory();
  const [temperature, humidity] = accessory.toAccessories();

  assert.notEqual(temperature.UUID, humidity.UUID);
  assert.notEqual(temperature.serialNumber, humidity.serialNumber);
  assert.equal(temperature.displayName, "CGDK2 20A8 Temperature");
  assert.equal(humidity.displayName, "CGDK2 20A8 Humidity");
});

test("names and serial numbers are trimmed to the 32 characters Matter allows", () => {
  const { accessory } = createMatterAccessory(createFakeMatter(), {
    name: "A really quite excessively long sensor name",
  });
  const [temperature, humidity] = accessory.toAccessories();

  for (const built of [temperature, humidity]) {
    assert.ok(built.displayName.length <= 32);
    assert.ok(built.serialNumber.length <= 32);
  }
});

test("the initial cluster state is null (no reading yet), not a placeholder number", () => {
  const { accessory } = createMatterAccessory();
  const [temperature, humidity] = accessory.toAccessories();

  assert.equal(temperature.clusters.temperatureMeasurement.measuredValue, null);
  assert.equal(
    humidity.clusters.relativeHumidityMeasurement.measuredValue,
    null,
  );
});

test("the declared temperature range is much wider than the sensor's physical range, to tolerate a configured offset", () => {
  const { accessory } = createMatterAccessory();
  const [temperature] = accessory.toAccessories();

  assert.equal(
    temperature.clusters.temperatureMeasurement.minMeasuredValue,
    -5000,
  );
  assert.equal(
    temperature.clusters.temperatureMeasurement.maxMeasuredValue,
    10000,
  );
});

test("the UUIDs are derived from the address and are stable across instances", () => {
  const matter = createFakeMatter();
  const { accessory: first } = createMatterAccessory(matter);
  const { accessory: second } = createMatterAccessory(matter);
  assert.deepEqual(
    first.toAccessories().map((built) => built.UUID),
    second.toAccessories().map((built) => built.UUID),
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
  assert.notEqual(
    first.temperatureAccessory.UUID,
    second.temperatureAccessory.UUID,
  );
  assert.notEqual(first.humidityAccessory.UUID, second.humidityAccessory.UUID);
});

test("pushState does nothing before markRegistered() has been called", async () => {
  const { accessory, matter } = createMatterAccessory();
  await accessory.updateTemperature(21.3);
  assert.equal(matter.stateUpdates.length, 0);
});

test("pushState does nothing after markRegistrationFailed() has been called", async () => {
  const { accessory, matter } = createMatterAccessory();
  accessory.markRegistered();
  accessory.markRegistrationFailed();
  await accessory.updateTemperature(21.3);
  assert.equal(matter.stateUpdates.length, 0);
});

test("updateTemperature pushes measuredValue in hundredths of a degree to the temperature sensor", async () => {
  const { accessory, matter } = createRegisteredMatterAccessory();
  await accessory.updateTemperature(21.3);

  assert.equal(matter.stateUpdates.length, 1);
  assert.deepEqual(matter.stateUpdates[0], {
    uuid: accessory.temperatureAccessory.UUID,
    cluster: "temperatureMeasurement",
    attributes: { measuredValue: 2130 },
    partId: undefined,
  });
});

test("updateHumidity pushes measuredValue in hundredths of a percent to the humidity sensor", async () => {
  const { accessory, matter } = createRegisteredMatterAccessory();
  await accessory.updateHumidity(55.5);

  assert.equal(matter.stateUpdates.length, 1);
  assert.deepEqual(matter.stateUpdates[0], {
    uuid: accessory.humidityAccessory.UUID,
    cluster: "relativeHumidityMeasurement",
    attributes: { measuredValue: 5550 },
    partId: undefined,
  });
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
