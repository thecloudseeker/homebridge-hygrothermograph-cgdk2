const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const MiBeacon = require("../lib/mibeacon");
const {
  buildFrame,
  temperatureHumidityObject,
  temperatureObject,
  humidityObject,
  batteryObject,
} = require("./helpers/miBeaconFrame");

const MAC = "4c:64:a8:d0:ae:65";
const BIND_KEY = crypto.randomBytes(16);

test("SERVICE_DATA_UUID matches the Xiaomi MiBeacon advertisement UUID", () => {
  assert.equal(MiBeacon.SERVICE_DATA_UUID, "fe95");
});

test("parseBindKey accepts a 32-character hex string", () => {
  const key = "0123456789abcdef0123456789ABCDEF";
  const result = MiBeacon.parseBindKey(key.slice(0, 32));
  assert.equal(result.length, 16);
  assert.ok(Buffer.isBuffer(result));
});

test("parseBindKey rejects the wrong length or non-hex input", () => {
  assert.throws(
    () => MiBeacon.parseBindKey("too-short"),
    MiBeacon.MiBeaconError,
  );
  assert.throws(
    () => MiBeacon.parseBindKey("z".repeat(32)),
    MiBeacon.MiBeaconError,
  );
  assert.throws(() => MiBeacon.parseBindKey(undefined), MiBeacon.MiBeaconError);
});

test("parse() decrypts a combined temperature+humidity object (0x100d)", () => {
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: temperatureHumidityObject(24.5, 55),
  });

  assert.deepEqual(MiBeacon.parse(frame, BIND_KEY), {
    temperature: 24.5,
    humidity: 55,
  });
});

test("parse() decrypts negative temperatures correctly (signed int16LE)", () => {
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: temperatureHumidityObject(-5, 40),
  });

  const event = MiBeacon.parse(frame, BIND_KEY);
  assert.equal(event.temperature, -5);
  assert.equal(event.humidity, 40);
});

test("parse() decrypts separate temperature (0x1004), humidity (0x1006), and battery (0x100a) objects", () => {
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: Buffer.concat([
      temperatureObject(21.3),
      humidityObject(48.2),
      batteryObject(76),
    ]),
  });

  assert.deepEqual(MiBeacon.parse(frame, BIND_KEY), {
    temperature: 21.3,
    humidity: 48.2,
    battery: 76,
  });
});

test("parse() returns only the fields present in a partial advertisement", () => {
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: batteryObject(90),
  });

  assert.deepEqual(MiBeacon.parse(frame, BIND_KEY), { battery: 90 });
});

test("parse() returns null when the decrypted payload has no recognized objects", () => {
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: Buffer.from([0xff, 0xff, 1, 0x00]), // unknown object type
  });

  assert.equal(MiBeacon.parse(frame, BIND_KEY), null);
});

test("parse() throws when the bindKey is wrong (CCM auth failure)", () => {
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: temperatureHumidityObject(24.5, 55),
  });

  const wrongKey = crypto.randomBytes(16);
  assert.throws(() => MiBeacon.parse(frame, wrongKey), MiBeacon.MiBeaconError);
});

test("decrypt throws when the frame is not marked as encrypted", () => {
  const unencrypted = Buffer.alloc(20);
  unencrypted.writeUInt16LE(0x0050, 0); // object_include | mac_include, no is_encrypted bit
  assert.throws(() => MiBeacon.parse(unencrypted, BIND_KEY), /not encrypted/);
});

test("decrypt throws when the frame has no object payload", () => {
  const noObject = Buffer.alloc(20);
  noObject.writeUInt16LE(0x0018, 0); // mac_include | is_encrypted, no object_include
  assert.throws(() => MiBeacon.parse(noObject, BIND_KEY), /no object payload/);
});

test("decrypt throws when the frame has no embedded MAC address", () => {
  const noMac = Buffer.alloc(20);
  noMac.writeUInt16LE(0x0048, 0); // object_include | is_encrypted, no mac_include
  assert.throws(
    () => MiBeacon.parse(noMac, BIND_KEY),
    /no embedded MAC address/,
  );
});

test("decrypt throws on a truncated frame instead of reading out of bounds", () => {
  const tooShort = Buffer.from([0x58, 0x00, 0x6f, 0x06]);
  assert.throws(
    () => MiBeacon.parse(tooShort, BIND_KEY),
    MiBeacon.MiBeaconError,
  );
});

test("decrypt handles the optional capability byte(s) when present", () => {
  // capability_include (bit5) set, capability byte has the IO bit (0x20) set
  // too, so decrypt() must skip 2 capability bytes, not 1, before ciphertext.
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: temperatureHumidityObject(19.9, 60.1),
    frameControl: 0x0078, // object_include | capability_include | mac_include | is_encrypted
  });
  // Splice in 2 capability bytes right after the MAC (offset 5 + 6 = 11).
  const capabilityBytes = Buffer.from([0x25, 0x00]); // 0x20 bit set -> IO byte follows
  const withCapability = Buffer.concat([
    frame.subarray(0, 11),
    capabilityBytes,
    frame.subarray(11),
  ]);

  assert.deepEqual(MiBeacon.parse(withCapability, BIND_KEY), {
    temperature: 19.9,
    humidity: 60.1,
  });
});

test("decrypt skips exactly one capability byte when the IO bit is not set", () => {
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: temperatureHumidityObject(19.9, 60.1),
    frameControl: 0x0078, // object_include | capability_include | mac_include | is_encrypted
  });
  // 0x05 does not have the 0x20 IO bit set -> only 1 capability byte, no IO byte.
  const capabilityByte = Buffer.from([0x05]);
  const withCapability = Buffer.concat([
    frame.subarray(0, 11),
    capabilityByte,
    frame.subarray(11),
  ]);

  assert.deepEqual(MiBeacon.parse(withCapability, BIND_KEY), {
    temperature: 19.9,
    humidity: 60.1,
  });
});

test("decrypt throws when capability_include is set but the buffer ends right before it", () => {
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: temperatureHumidityObject(19.9, 60.1),
    frameControl: 0x0078, // object_include | capability_include | mac_include | is_encrypted
  });
  const truncatedAtCapability = frame.subarray(0, 11); // ends exactly after the MAC

  assert.throws(
    () => MiBeacon.parse(truncatedAtCapability, BIND_KEY),
    /too short for a capability byte/,
  );
});

test("decrypt throws on a completely empty buffer instead of a raw RangeError", () => {
  assert.throws(
    () => MiBeacon.parse(Buffer.alloc(0), BIND_KEY),
    MiBeacon.MiBeaconError,
  );
});

test("parse() returns null for a zero-length (object-less) encrypted payload", () => {
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: Buffer.alloc(0),
  });

  assert.equal(MiBeacon.parse(frame, BIND_KEY), null);
});

test("parse() keeps objects parsed before a truncated trailing object instead of discarding everything", () => {
  const corruptTrailer = Buffer.from([0x06, 0x10, 0x05]); // claims 5 bytes follow; none do
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: Buffer.concat([temperatureObject(22.0), corruptTrailer]),
  });

  assert.deepEqual(MiBeacon.parse(frame, BIND_KEY), { temperature: 22.0 });
});

test("decrypt rejects a bindKey that isn't a 16-byte buffer, independent of parseBindKey", () => {
  const frame = buildFrame({
    mac: MAC,
    bindKey: BIND_KEY,
    plaintext: temperatureHumidityObject(24.5, 55),
  });

  assert.throws(
    () => MiBeacon.parse(frame, "not-a-buffer"),
    /must be a 16-byte buffer/,
  );
  assert.throws(
    () => MiBeacon.parse(frame, Buffer.alloc(15)),
    /must be a 16-byte buffer/,
  );
});

test("parseBindKey rejects strings one character shorter or longer than 32", () => {
  assert.throws(
    () => MiBeacon.parseBindKey("a".repeat(31)),
    MiBeacon.MiBeaconError,
  );
  assert.throws(
    () => MiBeacon.parseBindKey("a".repeat(33)),
    MiBeacon.MiBeaconError,
  );
});
