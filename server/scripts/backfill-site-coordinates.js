const mysql = require('mysql2/promise');

const { config } = require('../src/config');
const { KakaoAddressGeocoder } = require('../src/services/site-geocoder.service');
const { normalizeSiteCoordinates } = require('../src/site-location');

const entities = {
  contracts: { table: 'contracts' },
  schedules: { table: 'schedules' },
};

const usage = `
Usage:
  node scripts/backfill-site-coordinates.js [--apply] [--entity=all|contracts|schedules] [--limit=250] [--delay-ms=150]

Defaults to a dry run: it reads only and does not call Kakao or update data.
Use --apply only after migration 004_site_coordinates.sql has completed.
`;

const parsePositiveInteger = (value, option, { max = 10_000, min = 0 } = {}) => {
  if (!/^\d+$/.test(String(value))) throw new Error(`${option} must be a whole number.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${option} must be between ${min} and ${max}.`);
  }
  return number;
};

function parseOptions(argv) {
  const options = {
    apply: false,
    delayMs: 150,
    entity: 'all',
    limit: 250,
  };

  for (const argument of argv) {
    if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--help' || argument === '-h') {
      console.info(usage.trim());
      process.exit(0);
    } else if (argument.startsWith('--entity=')) {
      options.entity = argument.slice('--entity='.length);
    } else if (argument.startsWith('--limit=')) {
      options.limit = parsePositiveInteger(argument.slice('--limit='.length), '--limit', { min: 1 });
    } else if (argument.startsWith('--delay-ms=')) {
      options.delayMs = parsePositiveInteger(argument.slice('--delay-ms='.length), '--delay-ms', { max: 10_000 });
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!['all', ...Object.keys(entities)].includes(options.entity)) {
    throw new Error('--entity must be all, contracts, or schedules.');
  }
  return options;
}

const parseJson = (value) => {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const addressForPayload = (payload) => String(payload?.siteAddress || '').trim();
const storedAddressForComparison = (payload) => (
  typeof payload?.siteAddress === 'string' ? payload.siteAddress : undefined
);

function coordinatesFromRow(row, payload) {
  return normalizeSiteCoordinates({
    siteLatitude: row.site_latitude,
    siteLongitude: row.site_longitude,
  }) ?? normalizeSiteCoordinates(payload);
}

async function listCandidates(connection, entity, limit) {
  const [rows] = await connection.execute(
    `SELECT id, user_id, site_latitude, site_longitude, payload
     FROM ${entity.table}
     WHERE site_latitude IS NULL OR site_longitude IS NULL
     ORDER BY id ASC
     LIMIT ?`,
    [limit],
  );
  return rows;
}

async function updateCoordinates(connection, entity, row, expectedSiteAddress, coordinates) {
  const [result] = await connection.execute(
    `UPDATE ${entity.table}
     SET site_latitude = ?, site_longitude = ?,
         payload = JSON_SET(JSON_REMOVE(payload, '$.siteLatitude', '$.siteLongitude'),
                            '$.siteLatitude', ?, '$.siteLongitude', ?),
         updated_at = NOW(3)
     WHERE id = ? AND user_id = ? AND (site_latitude IS NULL OR site_longitude IS NULL)
       AND (? IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.siteAddress')) <=> ?)`,
    [
      coordinates.siteLatitude,
      coordinates.siteLongitude,
      coordinates.siteLatitude,
      coordinates.siteLongitude,
      row.id,
      row.user_id,
      expectedSiteAddress ?? null,
      expectedSiteAddress ?? null,
    ],
  );
  return result.affectedRows;
}

async function processEntity({ connection, entityName, geocoder, options, rows }) {
  const entity = entities[entityName];
  const summary = {
    candidates: rows.length,
    geocoded: 0,
    legacyCoordinatesPromoted: 0,
    missingAddress: 0,
    notFound: 0,
    skippedConcurrentUpdate: 0,
    wouldGeocode: 0,
    wouldPromoteLegacyCoordinates: 0,
  };

  for (const row of rows) {
    const payload = parseJson(row.payload);
    let coordinates = coordinatesFromRow(row, payload);
    let source = coordinates ? 'legacy' : null;
    const address = addressForPayload(payload);

    if (!coordinates) {
      if (!address) {
        summary.missingAddress += 1;
        continue;
      }
      if (!options.apply) {
        summary.wouldGeocode += 1;
        continue;
      }

      const result = await geocoder.geocode(address);
      if (!result) {
        summary.notFound += 1;
        continue;
      }
      coordinates = normalizeSiteCoordinates(result);
      source = 'geocoded';
    }

    if (!options.apply) {
      if (source === 'legacy') summary.wouldPromoteLegacyCoordinates += 1;
      continue;
    }

    const updated = await updateCoordinates(
      connection,
      entity,
      row,
      storedAddressForComparison(payload),
      coordinates,
    );
    if (!updated) {
      summary.skippedConcurrentUpdate += 1;
      continue;
    }
    if (source === 'legacy') summary.legacyCoordinatesPromoted += 1;
    if (source === 'geocoded') {
      summary.geocoded += 1;
      if (options.delayMs > 0) await sleep(options.delayMs);
    }
  }

  return summary;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const entityNames = options.entity === 'all' ? Object.keys(entities) : [options.entity];
  const connection = await mysql.createConnection({
    charset: 'utf8mb4',
    connectTimeout: config.db.connectTimeout,
    database: config.db.database,
    host: config.db.host,
    password: config.db.password,
    port: config.db.port,
    user: config.db.user,
  });
  const geocoder = new KakaoAddressGeocoder({
    apiKey: config.siteGeocoder.kakaoRestApiKey,
    baseUrl: config.siteGeocoder.kakaoLocalApiBaseUrl,
    timeoutMs: config.siteGeocoder.kakaoLocalApiTimeoutMs,
  });

  try {
    const candidatesByEntity = new Map();
    for (const entityName of entityNames) {
      candidatesByEntity.set(entityName, await listCandidates(connection, entities[entityName], options.limit));
    }
    const needsRemoteGeocoding = [...candidatesByEntity.values()].some((rows) => rows.some((row) => {
      const payload = parseJson(row.payload);
      return !coordinatesFromRow(row, payload) && Boolean(addressForPayload(payload));
    }));
    if (options.apply && needsRemoteGeocoding && !geocoder.apiKey) {
      throw new Error('KAKAO_REST_API_KEY must be configured before geocoding saved addresses.');
    }

    if (!options.apply) {
      console.info('Dry run only: no Kakao requests or database updates will be made. Add --apply to write missing coordinates.');
    }
    for (const entityName of entityNames) {
      const summary = await processEntity({
        connection,
        entityName,
        geocoder,
        options,
        rows: candidatesByEntity.get(entityName),
      });
      console.info(JSON.stringify({ entity: entityName, mode: options.apply ? 'apply' : 'dry-run', ...summary }));
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`Site-coordinate backfill failed: ${error.message}`);
  process.exitCode = 1;
});
