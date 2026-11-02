const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

const asFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const roundCoordinate = (value) => Math.round(value * 1_000_000) / 1_000_000;

const normalizeSiteAddress = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

// Korean address pickers can append a parenthesized building/administrative
// hint. Kakao's address endpoint is most reliable with the postal address
// itself, while the original value remains untouched in the contract payload.
const geocodingAddressQuery = (value) => normalizeSiteAddress(value)
  .replace(/\([^)]*\)/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Returns a complete WGS84 coordinate pair or null. Coordinates are only
 * meaningful as a pair, so malformed/partial legacy data is intentionally
 * ignored instead of guessing a missing value.
 */
function normalizeSiteCoordinates(value) {
  const siteLatitude = asFiniteNumber(value?.siteLatitude ?? value?.latitude);
  const siteLongitude = asFiniteNumber(value?.siteLongitude ?? value?.longitude);

  if (siteLatitude === null || siteLongitude === null) return null;
  if (siteLatitude < -90 || siteLatitude > 90 || siteLongitude < -180 || siteLongitude > 180) return null;

  return {
    siteLatitude: roundCoordinate(siteLatitude),
    siteLongitude: roundCoordinate(siteLongitude),
  };
}

function hasSiteCoordinateInput(value) {
  return hasOwn(value, 'siteLatitude') || hasOwn(value, 'siteLongitude');
}

function clearsSiteCoordinates(value) {
  return value?.siteLatitude === null && value?.siteLongitude === null;
}

function withSiteCoordinates(value, coordinates) {
  const next = { ...(value ?? {}) };
  delete next.siteLatitude;
  delete next.siteLongitude;
  if (coordinates) Object.assign(next, coordinates);
  return next;
}

/**
 * Applies explicit client coordinates when supplied. Older clients do not send
 * coordinate fields, so keep their stored pair only while the saved address is
 * unchanged. This prevents an old position being reused for a newly edited
 * address.
 */
function coordinatesForUpdate({ existing, incoming }) {
  if (hasSiteCoordinateInput(incoming)) {
    return clearsSiteCoordinates(incoming) ? null : normalizeSiteCoordinates(incoming);
  }

  if (normalizeSiteAddress(existing?.siteAddress) !== normalizeSiteAddress(incoming?.siteAddress)) return null;
  return normalizeSiteCoordinates(existing);
}

module.exports = {
  clearsSiteCoordinates,
  coordinatesForUpdate,
  geocodingAddressQuery,
  hasSiteCoordinateInput,
  normalizeSiteAddress,
  normalizeSiteCoordinates,
  withSiteCoordinates,
};
