const SERVICE_DATA_UUID = "fdcd";

const MAC_START = 2;
const MAC_END = 8;

const EventTypes = {
  temperatureAndHumidity: 4109
};

class Parser {
  constructor(buffer) {
    this.baseByteLength = 5;
    if (buffer == null) {
      throw new Error("A buffer must be provided.");
    }
    this.buffer = buffer;
    if (buffer.length < this.baseByteLength) {
      throw new Error(
        `Service data length must be >= 5 bytes. ${this.toString()}`
      );
    }
  }

  parse() {
    this.eventType = 4109;
    this.event = this.parseEventData();
    return {
      macAddress: this.macAddress,
      eventType: this.eventType,
      event: this.event
    };
  }

  parseMacAddress() {
    if (!this.frameControl.hasMacAddress) {
      return null;
    }
    const macBuffer = this.buffer.slice(MAC_START, MAC_END);
    return Buffer.from(macBuffer)
      .reverse()
      .toString("hex");
  }

  parseEventType() {
    return 4109;
  }

  parseEventData() {
    return this.parseTemperatureAndHumidityEvent();
  }

  parseTemperatureAndHumidityEvent() {
    const temperature = this.buffer.readInt16LE(10) / 10;
    const humidity = this.buffer.readUInt16LE(12) / 10;
    const battery = this.buffer.readUInt8(16);
    return { temperature, humidity, battery };
  }

  toString() {
    return this.buffer.toString("hex");
  }
}

module.exports = {
  Parser,
  EventTypes,
  SERVICE_DATA_UUID
};
