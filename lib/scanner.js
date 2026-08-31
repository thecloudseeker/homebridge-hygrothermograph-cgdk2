const EventEmitter = require("events");
const noble = require("@stoprocent/noble");
const { Parser, EventTypes, SERVICE_DATA_UUID } = require("./parser");
const { cleanAddress } = require("./address");

const DEFAULT_RESTART_DELAY = 2500;
const MAX_RESTART_DELAY = 60000;
const RESTART_JITTER = 500;
const WATCHDOG_INTERVAL = 30000;
const WATCHDOG_TIMEOUT = 180000;

class Scanner extends EventEmitter {
  constructor(address, options) {
    super();
    options = options || {};
    const {
      log = console,
      forceDiscovering = true,
      restartDelay = DEFAULT_RESTART_DELAY,
    } = options;
    this.log = log;
    this.address = address;
    this.forceDiscovering = forceDiscovering;
    this.restartDelay = restartDelay;

    this.scanning = false;
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.watchdogTimer = null;
    this.lastDiscoveryAt = null;

    this.configure();
  }

  configure() {
    // noble is a singleton shared by every accessory this plugin creates, so
    // each Scanner instance adds its own listener set. Raise the cap so
    // running several sensors doesn't trigger Node's MaxListenersExceeded
    // warning noise.
    noble.setMaxListeners(0);
    noble.on("discover", this.onDiscover.bind(this));
    noble.on("scanStart", this.onScanStart.bind(this));
    noble.on("scanStop", this.onScanStop.bind(this));
    noble.on("warning", this.onWarning.bind(this));
    noble.on("stateChange", this.onStateChange.bind(this));
    // Without a listener here, noble emitting "error" (e.g. an HCI socket
    // failure) would throw and take down the whole Homebridge process.
    noble.on("error", this.onNobleError.bind(this));
  }

  start() {
    this.log.debug("Start scanning.");
    try {
      noble.startScanning([], true);
      this.scanning = true;
      this.lastDiscoveryAt = Date.now();
      this.startWatchdog();
    } catch (e) {
      this.scanning = false;
      this.log.error(e);
      this.scheduleRestart();
    }
  }

  stop() {
    this.scanning = false;
    this.clearRestartTimer();
    this.stopWatchdog();
    noble.stopScanning();
  }

  onStateChange(state) {
    if (state === "poweredOn") {
      this.restartAttempts = 0;
      this.start();
    } else {
      this.log.info(`Stop scanning. (${state})`);
      this.stop();
    }
  }

  onWarning(message) {
    this.log.info("Warning: ", message);
  }

  onNobleError(error) {
    this.log.error("Bluetooth adapter error:", error);
  }

  onScanStart() {
    this.log.debug("Started scanning.");
    this.restartAttempts = 0;
    this.clearRestartTimer();
  }

  onScanStop() {
    this.log.debug("Stopped scanning.");
    this.stopWatchdog();
    // We are scanning but something stopped it. Restart scan.
    if (this.scanning && this.forceDiscovering) {
      this.scheduleRestart();
    }
  }

  scheduleRestart() {
    this.clearRestartTimer();
    const delay =
      Math.min(
        this.restartDelay * 2 ** this.restartAttempts,
        MAX_RESTART_DELAY,
      ) +
      Math.random() * RESTART_JITTER;
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.log.debug(`Restarting scan (attempt ${this.restartAttempts}).`);
      this.start();
    }, delay);
    if (typeof this.restartTimer.unref === "function") {
      this.restartTimer.unref();
    }
  }

  clearRestartTimer() {
    if (this.restartTimer != null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  // Some adapter/driver failures stop delivering advertisements without ever
  // emitting "scanStop" (a wedged HCI dongle, a silently dropped USB device,
  // certain Raspberry Pi + Bluetooth combinations). Since real BLE traffic
  // (any nearby phone, watch, etc., not just our target sensor) is almost
  // never absent for minutes at a time, prolonged silence is a reliable
  // signal that the scan has died and needs to be force-restarted.
  startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(
      () => this.checkForStalledScan(),
      WATCHDOG_INTERVAL,
    );
    if (typeof this.watchdogTimer.unref === "function") {
      this.watchdogTimer.unref();
    }
  }

  stopWatchdog() {
    if (this.watchdogTimer != null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  checkForStalledScan() {
    if (!this.scanning || this.lastDiscoveryAt == null) {
      return;
    }
    const silentFor = Date.now() - this.lastDiscoveryAt;
    if (silentFor < WATCHDOG_TIMEOUT) {
      return;
    }
    this.log.warn(
      `No BLE advertisements seen for ${Math.round(
        silentFor / 1000,
      )}s. The Bluetooth adapter may have stalled, forcing a scan restart.`,
    );
    this.stop();
    this.scheduleRestart();
  }

  onDiscover(peripheral) {
    this.lastDiscoveryAt = Date.now();
    try {
      this.handleDiscover(peripheral);
    } catch (error) {
      this.emit("error", error);
    }
  }

  handleDiscover(peripheral) {
    const {
      advertisement: { serviceData } = {},
      id,
      address,
    } = peripheral || {};

    if (!this.isValidAddress(address) && !this.isValidAddress(id)) {
      return;
    }

    const miServiceData = this.getValidServiceData(serviceData);
    if (!miServiceData) {
      return;
    }

    this.logPeripheral({ peripheral, serviceData: miServiceData });

    const result = this.parseServiceData(miServiceData.data);
    if (result == null) {
      return;
    }

    const { eventType, event } = result;
    switch (eventType) {
      case EventTypes.temperatureAndHumidity: {
        const { temperature, humidity, battery } = event;
        this.emit("temperatureChange", temperature, { id, address });
        this.emit("humidityChange", humidity, { id, address });
        this.emit("batteryChange", battery, { id, address });
        break;
      }
      default: {
        this.emit("error", new Error(`Unknown event type ${eventType}`));
        return;
      }
    }
    this.emit("change", event, { id, address });
  }

  isValidAddress(address) {
    return (
      this.address == null ||
      cleanAddress(this.address) === cleanAddress(address)
    );
  }

  getValidServiceData(serviceData) {
    return (
      serviceData &&
      serviceData.find((data) => data.uuid.toLowerCase() === SERVICE_DATA_UUID)
    );
  }

  parseServiceData(serviceData) {
    try {
      return new Parser(serviceData).parse();
    } catch (error) {
      this.emit("error", error);
    }
  }

  logPeripheral({
    peripheral: {
      address,
      id,
      rssi,
      advertisement: { localName },
    },
    serviceData,
  }) {
    this.log.debug(`[${address || id}] Discovered peripheral ->
      Id: ${id}
      LocalName: ${localName}
      rssi: ${rssi}
      serviceData: ${serviceData.data.toString("hex")}`);
  }
}

module.exports = { Scanner };
