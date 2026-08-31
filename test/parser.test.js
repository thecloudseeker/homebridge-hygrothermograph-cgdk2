const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Parser, EventTypes, SERVICE_DATA_UUID } = require("../lib/parser");

function bufferFrom(hex) {
  return Buffer.from(hex.replace(/:/g, ""), "hex");
}

test("SERVICE_DATA_UUID matches the CGDK2 advertisement UUID", () => {
  assert.equal(SERVICE_DATA_UUID, "fdcd");
});

test("EventTypes.temperatureAndHumidity matches the CGDK2 event type", () => {
  assert.equal(EventTypes.temperatureAndHumidity, 4109);
});

test("constructor throws when no buffer is provided", () => {
  assert.throws(() => new Parser(), /A buffer must be provided/);
  assert.throws(() => new Parser(null), /A buffer must be provided/);
});

test("constructor throws when the buffer is shorter than the minimum required length", () => {
  const tooShort = bufferFrom(
    "50:20:aa:bb:cc:dd:ee:ff:00:00:f5:00:26:02:00:00",
  );
  assert.equal(tooShort.length, 16);
  assert.throws(
    () => new Parser(tooShort),
    /Service data length must be >= 17 bytes/,
  );
});

test("parse() decodes temperature, humidity, and battery from a well-formed buffer", () => {
  const buffer = bufferFrom(
    "50:20:aa:bb:cc:dd:ee:ff:00:00:f5:00:26:02:00:00:50",
  );
  const result = new Parser(buffer).parse();

  assert.deepEqual(result, {
    eventType: EventTypes.temperatureAndHumidity,
    event: { temperature: 24.5, humidity: 55, battery: 80 },
  });
});

test("parse() decodes negative temperatures correctly (signed int16LE)", () => {
  // Same buffer as above, but bytes 10-11 replaced with -5.0C (0xFFCE, little-endian).
  const buffer = bufferFrom(
    "50:20:aa:bb:cc:dd:ee:ff:00:00:ce:ff:26:02:00:00:50",
  );
  const { event } = new Parser(buffer).parse();
  assert.equal(event.temperature, -5);
});

test("parse() does not return a macAddress field", () => {
  const buffer = bufferFrom(
    "50:20:aa:bb:cc:dd:ee:ff:00:00:f5:00:26:02:00:00:50",
  );
  const result = new Parser(buffer).parse();
  assert.equal("macAddress" in result, false);
});

test("toString() renders the buffer as a hex string", () => {
  const buffer = bufferFrom(
    "50:20:aa:bb:cc:dd:ee:ff:00:00:f5:00:26:02:00:00:50",
  );
  assert.equal(new Parser(buffer).toString(), buffer.toString("hex"));
});
