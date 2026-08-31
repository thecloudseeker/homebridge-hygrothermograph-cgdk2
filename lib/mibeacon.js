const crypto = require("crypto");

// Xiaomi MiBeacon v4/v5 service data, as broadcast by the CGDK2 whenever it
// hasn't been forced into the unencrypted Qingping-native format (0xfdcd,
// see parser.js) via the Qingping+ app. Byte offsets below are relative to
// the service data payload as delivered by noble (AD length/type/UUID
// already stripped), which is 4 bytes shorter than the raw AD structure the
// MiBeacon spec itself counts from.
const SERVICE_DATA_UUID = "fe95";

const FRAME_CONTROL_OBJECT_INCLUDE = 1 << 6;
const FRAME_CONTROL_CAPABILITY_INCLUDE = 1 << 5;
const FRAME_CONTROL_MAC_INCLUDE = 1 << 4;
const FRAME_CONTROL_IS_ENCRYPTED = 1 << 3;
const CAPABILITY_IO = 0x20;

const OBJECT_TEMPERATURE = 0x1004;
const OBJECT_HUMIDITY = 0x1006;
const OBJECT_BATTERY = 0x100a;
const OBJECT_TEMPERATURE_AND_HUMIDITY = 0x100d;

const AAD = Buffer.from([0x11]);
const AUTH_TAG_LENGTH = 4;
const EXT_COUNTER_LENGTH = 3;
const TRAILER_LENGTH = EXT_COUNTER_LENGTH + AUTH_TAG_LENGTH;
const BIND_KEY_LENGTH = 16;

class MiBeaconError extends Error {}

function parseBindKey(value) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{32}$/.test(value)) {
    throw new MiBeaconError(
      "bindKey must be a 32-character hex string (16 bytes).",
    );
  }
  return Buffer.from(value, "hex");
}

function decrypt(buffer, bindKey) {
  if (!Buffer.isBuffer(bindKey) || bindKey.length !== BIND_KEY_LENGTH) {
    throw new MiBeaconError(
      `bindKey must be a ${BIND_KEY_LENGTH}-byte buffer.`,
    );
  }
  if (buffer.length < 5) {
    throw new MiBeaconError(
      `MiBeacon frame too short. ${buffer.toString("hex")}`,
    );
  }

  const frameControl = buffer.readUInt16LE(0);
  if ((frameControl & FRAME_CONTROL_OBJECT_INCLUDE) === 0) {
    throw new MiBeaconError("MiBeacon frame has no object payload.");
  }
  if ((frameControl & FRAME_CONTROL_IS_ENCRYPTED) === 0) {
    throw new MiBeaconError(
      "MiBeacon frame is not encrypted; a bindKey is not applicable to it.",
    );
  }
  if ((frameControl & FRAME_CONTROL_MAC_INCLUDE) === 0) {
    throw new MiBeaconError(
      "MiBeacon frame has no embedded MAC address; cannot build a decryption nonce.",
    );
  }

  // Frame control (2) + device ID (2) + frame counter (1).
  let offset = 5;
  if (buffer.length < offset + 6) {
    throw new MiBeaconError("MiBeacon frame too short for a MAC address.");
  }
  const macReversed = buffer.subarray(offset, offset + 6);
  offset += 6;

  if (frameControl & FRAME_CONTROL_CAPABILITY_INCLUDE) {
    if (buffer.length < offset + 1) {
      throw new MiBeaconError(
        "MiBeacon frame too short for a capability byte.",
      );
    }
    const capability = buffer.readUInt8(offset);
    offset += 1;
    if (capability & CAPABILITY_IO) {
      offset += 1;
    }
  }

  if (buffer.length < offset + TRAILER_LENGTH) {
    throw new MiBeaconError(
      "MiBeacon frame too short for its encrypted trailer.",
    );
  }

  const deviceIdAndCounter = buffer.subarray(2, 5);
  const extCounter = buffer.subarray(
    buffer.length - TRAILER_LENGTH,
    buffer.length - AUTH_TAG_LENGTH,
  );
  const authTag = buffer.subarray(buffer.length - AUTH_TAG_LENGTH);
  const ciphertext = buffer.subarray(offset, buffer.length - TRAILER_LENGTH);
  const nonce = Buffer.concat([macReversed, deviceIdAndCounter, extCounter]);

  try {
    const decipher = crypto.createDecipheriv("aes-128-ccm", bindKey, nonce, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    decipher.setAAD(AAD, { plaintextLength: ciphertext.length });
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new MiBeaconError(
      `Failed to decrypt MiBeacon payload (wrong bindKey?): ${error.message}`,
    );
  }
}

function parseObjects(payload) {
  const event = {};
  let offset = 0;
  while (offset + 3 <= payload.length) {
    const typeCode = payload.readUInt16LE(offset);
    const length = payload.readUInt8(offset + 2);
    const valueStart = offset + 3;
    const valueEnd = valueStart + length;
    if (valueEnd > payload.length) {
      break;
    }
    const value = payload.subarray(valueStart, valueEnd);
    switch (typeCode) {
      case OBJECT_TEMPERATURE:
        if (value.length === 2) {
          event.temperature = value.readInt16LE(0) / 10;
        }
        break;
      case OBJECT_HUMIDITY:
        if (value.length === 2) {
          event.humidity = value.readUInt16LE(0) / 10;
        }
        break;
      case OBJECT_BATTERY:
        if (value.length === 1) {
          event.battery = value.readUInt8(0);
        }
        break;
      case OBJECT_TEMPERATURE_AND_HUMIDITY:
        if (value.length === 4) {
          event.temperature = value.readInt16LE(0) / 10;
          event.humidity = value.readUInt16LE(2) / 10;
        }
        break;
      default:
        break;
    }
    offset = valueEnd;
  }
  return event;
}

// Returns { temperature?, humidity?, battery? } (only the fields present in
// this particular advertisement — the CGDK2 does not necessarily send all
// three in every packet), or null if the decrypted payload carried none of
// them.
function parse(buffer, bindKey) {
  const payload = decrypt(buffer, bindKey);
  const event = parseObjects(payload);
  return Object.keys(event).length === 0 ? null : event;
}

module.exports = {
  SERVICE_DATA_UUID,
  MiBeaconError,
  parseBindKey,
  parse,
};
