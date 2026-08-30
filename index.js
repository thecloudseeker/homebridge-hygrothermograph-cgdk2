module.exports = homebridge => {
  const { HygrothermographCgdk2Accessory } = require("./lib/accessory")(
    homebridge
  );
  homebridge.registerAccessory(
    "@thecloudseeker/homebridge-hygrothermograph-cgdk2",
    "HygrotermographCGDK2",
    HygrothermographCgdk2Accessory
  );
};
