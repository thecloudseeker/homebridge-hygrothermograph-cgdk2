const { Scanner } = require("./scanner");
const MiBeacon = require("./mibeacon");
const { cleanAddress } = require("./address");

const PLUGIN_IDENTIFIER = "@thecloudseeker/homebridge-hygrothermograph-cgdk2";
const PLATFORM_NAME = "HygrotermographCGDK2";

const defaultForceDiscoveringDelay = 2.5;

let HygrothermographCgdk2AccessoryHandler;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function defaultNameFor(address) {
  return address == null ? "CGDK2" : `CGDK2 ${address.slice(-5).toUpperCase()}`;
}

class HygrothermographCgdk2Platform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    // Keyed by normalized (colon-stripped, lowercased) BLE address.
    this.handlers = new Map();

    this.api.on("didFinishLaunching", () => {
      try {
        this.startDiscovery();
      } catch (error) {
        this.log.error("Failed to start Bluetooth discovery:", error);
      }
    });
    this.api.on("shutdown", () => {
      try {
        this.shutdown();
      } catch (error) {
        this.log.error("Error during shutdown:", error);
      }
    });
  }

  // Called once per cached accessory at launch, before didFinishLaunching.
  // Restores it immediately so its characteristics have get-handlers wired
  // up from the start, rather than leaving it dead until BLE re-discovers it.
  configureAccessory(accessory) {
    try {
      const address = accessory.context.address;
      if (address == null) {
        this.log.warn(
          `Ignoring cached accessory with no known address: ${accessory.displayName}`,
        );
        return;
      }
      if (this.ignoredAddresses.has(cleanAddress(address))) {
        this.log.info(
          `Removing previously-discovered accessory for now-ignored address: ${accessory.displayName}`,
        );
        this.api.unregisterPlatformAccessories(
          PLUGIN_IDENTIFIER,
          PLATFORM_NAME,
          [accessory],
        );
        return;
      }
      this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
      this.registerHandler(address, accessory);
    } catch (error) {
      this.log.error("Failed to restore cached accessory:", error);
    }
  }

  get ignoredAddresses() {
    if (this.ignoredAddressesCache == null) {
      this.ignoredAddressesCache = new Set(
        asArray(this.config.ignoredAddresses).map(cleanAddress),
      );
    }
    return this.ignoredAddressesCache;
  }

  get bindKeys() {
    if (this.bindKeysCache == null) {
      this.bindKeysCache = new Map();
      for (const sensor of asArray(this.config.sensors)) {
        if (
          sensor == null ||
          sensor.address == null ||
          sensor.bindKey == null
        ) {
          continue;
        }
        try {
          this.bindKeysCache.set(
            cleanAddress(sensor.address),
            MiBeacon.parseBindKey(sensor.bindKey),
          );
        } catch (error) {
          this.log.warn(
            `Ignoring invalid bindKey for sensor ${sensor.address}: ${error.message}`,
          );
        }
      }
    }
    return this.bindKeysCache;
  }

  get forceDiscoveringDelay() {
    const seconds =
      this.config.forceDiscoveringDelay == null
        ? defaultForceDiscoveringDelay
        : this.config.forceDiscoveringDelay;
    return seconds * 1000;
  }

  configFor(address) {
    const normalized = cleanAddress(address);
    const override = asArray(this.config.sensors).find(
      (sensor) => sensor != null && cleanAddress(sensor.address) === normalized,
    );
    // `name` is excluded from the spread: it identifies the platform block
    // itself (Homebridge convention, though this schema's singular:true
    // normally keeps config-ui-x from writing one), not a per-sensor default.
    // Left in, every auto-discovered sensor without its own sensors[].name
    // override would get the platform's name instead of falling back to
    // defaultNameFor(address).
    const { ignoredAddresses, sensors, name, ...defaults } = this.config;
    const mqtt =
      defaults.mqtt != null || override?.mqtt != null
        ? { ...defaults.mqtt, ...override?.mqtt }
        : undefined;
    return { ...defaults, ...override, mqtt, address };
  }

  registerHandler(
    address,
    platformAccessory,
    sensorConfig = this.configFor(address),
  ) {
    const normalized = cleanAddress(address);
    const handler = new HygrothermographCgdk2AccessoryHandler(
      platformAccessory,
      sensorConfig,
      this.log,
    );
    this.handlers.set(normalized, handler);
    return handler;
  }

  handlerFor(peripheral) {
    const address = peripheral.address || peripheral.id;
    const normalized = cleanAddress(address);
    if (this.ignoredAddresses.has(normalized)) {
      return null;
    }
    const existing = this.handlers.get(normalized);
    if (existing != null) {
      return existing;
    }

    const sensorConfig = this.configFor(address);
    const uuid = this.api.hap.uuid.generate(
      `homebridge-hygrothermograph-cgdk2:${normalized}`,
    );
    const platformAccessory = new this.api.platformAccessory(
      sensorConfig.name || defaultNameFor(address),
      uuid,
    );
    platformAccessory.context.address = address;
    this.api.registerPlatformAccessories(PLUGIN_IDENTIFIER, PLATFORM_NAME, [
      platformAccessory,
    ]);

    return this.registerHandler(address, platformAccessory, sensorConfig);
  }

  route(peripheral, callback) {
    try {
      const handler = this.handlerFor(peripheral);
      if (handler != null) {
        callback(handler);
      }
    } catch (error) {
      this.log.error("Failed to handle a sensor reading:", error);
    }
  }

  startDiscovery() {
    this.scanner = new Scanner(null, {
      log: this.log,
      forceDiscovering: this.config.forceDiscovering !== false,
      restartDelay: this.forceDiscoveringDelay,
      bindKeys: this.bindKeys,
    });
    this.scanner.on("temperatureChange", (temperature, peripheral) => {
      this.route(peripheral, (handler) => handler.setTemperature(temperature));
    });
    this.scanner.on("humidityChange", (humidity, peripheral) => {
      this.route(peripheral, (handler) => handler.setHumidity(humidity));
    });
    this.scanner.on("batteryChange", (batteryLevel, peripheral) => {
      this.route(peripheral, (handler) =>
        handler.setBatteryLevel(batteryLevel),
      );
    });
    this.scanner.on("change", (event, peripheral) => {
      this.route(peripheral, (handler) => handler.flushBatchedUpdate());
    });
    this.scanner.on("error", (error) => {
      this.log.error(error);
    });
    this.scanner.start();
  }

  shutdown() {
    try {
      if (this.scanner != null) {
        this.scanner.stop();
      }
    } catch (error) {
      this.log.error("Failed to stop the Bluetooth scanner:", error);
    }
    for (const handler of this.handlers.values()) {
      try {
        if (handler.mqttClient != null) {
          handler.mqttClient.end(true);
        }
      } catch (error) {
        this.log.error("Failed to close an MQTT client:", error);
      }
    }
  }
}

module.exports = (homebridge) => {
  ({ HygrothermographCgdk2AccessoryHandler } =
    require("./accessory")(homebridge));
  return { HygrothermographCgdk2Platform, PLUGIN_IDENTIFIER, PLATFORM_NAME };
};
