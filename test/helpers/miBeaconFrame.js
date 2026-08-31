const crypto = require("crypto");

// Builds a synthetic MiBeacon v4/v5 encrypted frame the same way a real
// CGDK2 does, so lib/mibeacon.js can be exercised without a real device
// capture. Byte layout mirrors custom-components/ble_monitor's decrypt side
// (the authoritative reference for this wire format), just run forwards
// (encrypt) instead of backwards (decrypt).
function buildFrame({
  mac,
  deviceId = 0x066f,
  counter = 1,
  extCounter = Buffer.from([0, 0, 0]),
  bindKey,
  plaintext,
  frameControl = 0x0058, // object_include | mac_include | is_encrypted
}) {
  const macBuf = Buffer.from(
    mac
      .split(":")
      .reverse()
      .map((h) => parseInt(h, 16)),
  );
  const frameControlBuf = Buffer.alloc(2);
  frameControlBuf.writeUInt16LE(frameControl, 0);
  const deviceIdBuf = Buffer.alloc(2);
  deviceIdBuf.writeUInt16LE(deviceId, 0);
  const counterBuf = Buffer.from([counter]);

  const nonce = Buffer.concat([macBuf, deviceIdBuf, counterBuf, extCounter]);
  const aad = Buffer.from([0x11]);
  const cipher = crypto.createCipheriv("aes-128-ccm", bindKey, nonce, {
    authTagLength: 4,
  });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    frameControlBuf,
    deviceIdBuf,
    counterBuf,
    macBuf,
    ciphertext,
    extCounter,
    tag,
  ]);
}

function temperatureHumidityObject(temperature, humidity) {
  const value = Buffer.alloc(4);
  value.writeInt16LE(Math.round(temperature * 10), 0);
  value.writeUInt16LE(Math.round(humidity * 10), 2);
  return Buffer.concat([Buffer.from([0x0d, 0x10, value.length]), value]);
}

function temperatureObject(temperature) {
  const value = Buffer.alloc(2);
  value.writeInt16LE(Math.round(temperature * 10), 0);
  return Buffer.concat([Buffer.from([0x04, 0x10, value.length]), value]);
}

function humidityObject(humidity) {
  const value = Buffer.alloc(2);
  value.writeUInt16LE(Math.round(humidity * 10), 0);
  return Buffer.concat([Buffer.from([0x06, 0x10, value.length]), value]);
}

function batteryObject(battery) {
  return Buffer.from([0x0a, 0x10, 1, battery]);
}

module.exports = {
  buildFrame,
  temperatureHumidityObject,
  temperatureObject,
  humidityObject,
  batteryObject,
};
