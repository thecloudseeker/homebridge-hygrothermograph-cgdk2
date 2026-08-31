function cleanAddress(address) {
  return address == null
    ? address
    : String(address).toLowerCase().replace(/[:-]/g, "");
}

module.exports = { cleanAddress };
