const { createRequire } = require("module");

// Injects a fake module into Node's require cache, resolved as if required
// from `baseFile`, so `require(request)` from source under test returns the
// fake instead of loading the real (often native, or deeply HAP-integrated)
// module. Returns a function that restores the previous cache entry.
function stubModule(baseFile, request, exportsValue) {
  const path = createRequire(baseFile).resolve(request);
  const previous = require.cache[path];
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports: exportsValue,
  };
  return () => {
    if (previous == null) {
      delete require.cache[path];
    } else {
      require.cache[path] = previous;
    }
  };
}

module.exports = { stubModule };
