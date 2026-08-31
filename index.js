module.exports = (homebridge) => {
  const { HygrothermographCgdk2Platform, PLUGIN_IDENTIFIER, PLATFORM_NAME } =
    require("./lib/platform")(homebridge);
  homebridge.registerPlatform(
    PLUGIN_IDENTIFIER,
    PLATFORM_NAME,
    HygrothermographCgdk2Platform,
  );
};
