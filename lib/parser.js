const SERVICE_DATA_UUID = "fdcd";

const MIN_BYTE_LENGTH = 17;

const EventTypes = {
  temperatureAndHumidity: 4109,
};

class Parser {
  constructor(buffer) {
    if (buffer == null) {
      throw new Error("A buffer must be provided.");
    }
    this.buffer = buffer;
    if (buffer.length < MIN_BYTE_LENGTH) {
      throw new Error(
        `Service data length must be >= ${MIN_BYTE_LENGTH} bytes. ${this.toString()}`,
      );
    }
  }

  parse() {
    this.eventType = EventTypes.temperatureAndHumidity;
    this.event = this.parseEventData();
    return {
      eventType: this.eventType,
      event: this.event,
    };
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
  SERVICE_DATA_UUID,
};
