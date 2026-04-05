import { BENGALURU_CENTER } from "../data/offlineBengaluru.js";
import { emptyFeatureCollection } from "./navigation.js";

const FALLBACK_SYNTHVERSE_API_BASE_URL = "http://10.80.20.66:5000";
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const CITY_RESILIENCE_GEOCODE_CACHE_PREFIX = "city-resilience-geocode:";

export const DEFAULT_SYNTHVERSE_API_BASE_URL =
  typeof import.meta !== "undefined"
    ? normalizeSynthverseApiBaseUrl(
        import.meta.env.VITE_SYNTHVERSE_API_BASE_URL ?? FALLBACK_SYNTHVERSE_API_BASE_URL,
      )
    : FALLBACK_SYNTHVERSE_API_BASE_URL;
export const SYNTHVERSE_SCAN_RADIUS_METERS = 10000;

export function normalizeSynthverseApiBaseUrl(value) {
  const normalizedValue = `${value ?? ""}`.trim();
  return normalizedValue.replace(/\/+$/, "");
}

export function createEmptySynthverseApiState() {
  return {
    configured: false,
    connected: false,
    coreLoading: false,
    emergencyLoading: false,
    coreError: "",
    emergencyError: "",
    lastCoreSyncAt: "",
    lastEmergencySyncAt: "",
    scanCoordinate: BENGALURU_CENTER,
    nodes: {
      exits: [],
      hallway: [],
    },
    sensors: {
      exits: [],
      hallway: [],
    },
    approvedEvents: [],
    emergency: {
      hospitals: [],
      fireStations: [],
      policeStations: [],
      score: null,
    },
  };
}

export async function fetchSynthverseNodes(baseUrl) {
  return requestJson(baseUrl, "/api/nodes");
}

export async function fetchSynthverseSensors(baseUrl) {
  return requestJson(baseUrl, "/api/sensors");
}

export async function fetchSynthverseApprovedEvents(baseUrl) {
  const response = await requestJson(baseUrl, "/api/events");
  return Array.isArray(response?.data?.events) ? response.data.events : [];
}

export async function fetchSynthverseCityResilience(baseUrl, city = "Bengaluru") {
  const query = `city=${encodeURIComponent(city)}`;
  const response = await requestJson(baseUrl, `/api/city_resilience?${query}`);
  return response?.data ?? null;
}

export async function enrichCityResilienceWithCoordinates(cityResilience, city = "Bengaluru") {
  const weakestZones = Array.isArray(cityResilience?.weakest_zones)
    ? cityResilience.weakest_zones
    : [];

  const enrichedWeakestZones = [];

  for (const zone of weakestZones) {
    const fallbackCoordinate = resolveCityResilienceSectorCoordinate(zone?.sector);
    const resolvedCoordinate = await resolveCityResilienceGeocode(zone?.sector, city, fallbackCoordinate);

    enrichedWeakestZones.push({
      ...zone,
      latitude: resolvedCoordinate?.[1] ?? fallbackCoordinate?.[1] ?? BENGALURU_CENTER[1],
      longitude: resolvedCoordinate?.[0] ?? fallbackCoordinate?.[0] ?? BENGALURU_CENTER[0],
    });
  }

  return {
    ...cityResilience,
    weakest_zones: enrichedWeakestZones,
  };
}

export async function fetchSynthverseEmergencyResources(baseUrl, coordinate) {
  const [longitude, latitude] = coordinate ?? BENGALURU_CENTER;
  const query = `latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`;

  const [hospitals, fireStations, policeStations, score] = await Promise.all([
    requestJson(baseUrl, `/api/hospitals?${query}`),
    requestJson(baseUrl, `/api/fire_stations?${query}`),
    requestJson(baseUrl, `/api/police_stations?${query}`),
    requestJson(baseUrl, `/api/score?${query}`),
  ]);

  return {
    hospitals: Array.isArray(hospitals?.data) ? hospitals.data : [],
    fireStations: Array.isArray(fireStations?.data) ? fireStations.data : [],
    policeStations: Array.isArray(policeStations?.data) ? policeStations.data : [],
    score: score?.data ?? null,
  };
}

export function buildSynthverseEmergencyGeoJSON(emergency) {
  const facilities = [
    ...(emergency?.hospitals ?? []).map((facility) => ({
      ...facility,
      assetType: "hospital",
    })),
    ...(emergency?.fireStations ?? []).map((facility) => ({
      ...facility,
      assetType: "fire_station",
    })),
    ...(emergency?.policeStations ?? []).map((facility) => ({
      ...facility,
      assetType: "police_station",
    })),
  ];

  if (facilities.length === 0) {
    return emptyFeatureCollection();
  }

  return {
    type: "FeatureCollection",
    features: facilities
      .filter(
        (facility) =>
          Number.isFinite(Number(facility?.longitude)) &&
          Number.isFinite(Number(facility?.latitude)),
      )
      .map((facility, index) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [Number(facility.longitude), Number(facility.latitude)],
        },
        properties: {
          id: `${facility.assetType}:${facility.name ?? index}:${index}`,
          label: facility.name ?? "",
          assetType: facility.assetType,
          sectorId: facility.sector_id ?? "",
          distanceKm: Number(facility.distance_km ?? 0),
        },
      })),
  };
}

export function buildSynthverseTrafficEventsGeoJSON(events) {
  const features = (Array.isArray(events) ? events : [])
    .map((event, index) => {
      const resolved = resolveSynthverseEventCoordinate(event);

      if (!resolved) {
        return null;
      }

      const trafficScore = Number(event?.traffic_score ?? 0);
      const expectedCrowd = Number(event?.expected_crowd ?? 0);
      const locationLabel = `${event?.venue_type ?? event?.location ?? resolved.matchLabel ?? "Unknown"}`;

      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: resolved.coordinate,
        },
        properties: {
          id: `traffic-event:${event?.id ?? index}`,
          eventId: event?.id ?? index,
          label: event?.event_name ?? `Event ${index + 1}`,
          locationLabel,
          trafficScore,
          expectedCrowd,
          date: event?.date ?? "",
          resolvedFrom: resolved.matchLabel,
        },
      };
    })
    .filter(Boolean);

  return features.length > 0
    ? {
        type: "FeatureCollection",
        features,
      }
    : emptyFeatureCollection();
}

export function buildSynthverseTrafficEventZonesGeoJSON(events) {
  const features = (Array.isArray(events) ? events : [])
    .map((event, index) => {
      const resolved = resolveSynthverseEventCoordinate(event);

      if (!resolved) {
        return null;
      }

      const expectedCrowd = Number(event?.expected_crowd ?? 0);
      const trafficScore = Number(event?.traffic_score ?? 0);
      const radiusMeters = Math.max(
        180,
        Math.min(1800, 140 + expectedCrowd * 0.18 + trafficScore * 4),
      );

      return {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [buildCircleCoordinates(resolved.coordinate, radiusMeters)],
        },
        properties: {
          id: `traffic-event-zone:${event?.id ?? index}`,
          eventId: event?.id ?? index,
          label: event?.event_name ?? `Event ${index + 1}`,
          locationLabel: `${event?.venue_type ?? event?.location ?? resolved.matchLabel ?? "Unknown"}`,
          trafficScore,
          expectedCrowd,
          radiusMeters,
          date: event?.date ?? "",
        },
      };
    })
    .filter(Boolean);

  return features.length > 0
    ? {
        type: "FeatureCollection",
        features,
      }
    : emptyFeatureCollection();
}

export function buildSynthverseEventHotspots(events) {
  return (Array.isArray(events) ? events : [])
    .map((event, index) => {
      const resolved = resolveSynthverseEventCoordinate(event);

      if (!resolved) {
        return null;
      }

      const expectedCrowd = Number(event?.expected_crowd ?? 0);
      const trafficScore = Number(event?.traffic_score ?? 0);
      const radiusMeters = Math.max(
        180,
        Math.min(1800, 140 + expectedCrowd * 0.18 + trafficScore * 4),
      );

      return {
        id: `event:${event?.id ?? index}`,
        label: event?.event_name ?? `Event ${index + 1}`,
        message: `${event?.event_name ?? `Event ${index + 1}`}\nExpected crowd ${Math.round(expectedCrowd) || 0}`,
        coordinate: resolved.coordinate,
        radiusMeters,
        kind: "event",
        vehicleCount: 0,
        trafficScore,
        expectedCrowd,
        locationLabel: `${event?.venue_type ?? event?.location ?? resolved.matchLabel ?? "Unknown"}`,
        date: event?.date ?? "",
      };
    })
    .filter(Boolean);
}

export function buildSynthverseScanAreaGeoJSON(coordinate, radiusMeters = SYNTHVERSE_SCAN_RADIUS_METERS) {
  if (!Array.isArray(coordinate)) {
    return emptyFeatureCollection();
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [buildCircleCoordinates(coordinate, radiusMeters)],
        },
        properties: {
          id: "synthverse-scan-area",
          radiusMeters,
        },
      },
    ],
  };
}

export function buildSynthverseCityAnalysisGeoJSON(cityResilience) {
  const weakestZones = Array.isArray(cityResilience?.weakest_zones)
    ? cityResilience.weakest_zones
    : [];
  const features = weakestZones
    .map((zone, index) => {
      const resolvedCoordinate = resolveCityResilienceSectorCoordinate(zone?.sector);

      if (!resolvedCoordinate) {
        return null;
      }

      const score = Number(zone?.score ?? 0);
      const hospitals = Number(zone?.metrics?.hospitals ?? 0);
      const policeStations = Number(zone?.metrics?.police ?? 0);
      const fireStations = Number(zone?.metrics?.fire ?? 0);

      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [
            Number(zone?.longitude ?? resolvedCoordinate[0]),
            Number(zone?.latitude ?? resolvedCoordinate[1]),
          ],
        },
        properties: {
          id: `city-analysis:${index + 1}`,
          label: `${Math.round(score)}`,
          totalScore: score,
          hospitals,
          policeStations,
          fireStations,
          weakestSectorName: zone?.sector ?? "Unavailable",
          weakestSectorFacilityCount: hospitals + policeStations + fireStations,
          facilityCount: hospitals + policeStations + fireStations,
          reason: zone?.reason ?? "",
          latitude: Number(zone?.latitude ?? resolvedCoordinate[1]),
          longitude: Number(zone?.longitude ?? resolvedCoordinate[0]),
        },
      };
    })
    .filter(Boolean);

  return features.length > 0
    ? {
        type: "FeatureCollection",
        features,
      }
    : emptyFeatureCollection();
}

export function summarizeSynthverseSensors(nodes, sensors) {
  const exitNodes = Array.isArray(nodes?.exits) ? nodes.exits : [];
  const hallwayNodes = Array.isArray(nodes?.hallway) ? nodes.hallway : [];
  const exitSensors = Array.isArray(sensors?.exits) ? sensors.exits : [];
  const hallwaySensors = Array.isArray(sensors?.hallway) ? sensors.hallway : [];
  const exitScoreById = new Map(exitSensors.map((sensor) => [sensor.id, Number(sensor.score ?? 0)]));
  const hallwayScoreById = new Map(
    hallwaySensors.map((sensor) => [sensor.id, Number(sensor.score ?? 0)]),
  );
  const accessibleExitCount = exitNodes.filter(
    (node) => (exitScoreById.get(node.id) ?? 0) < 100,
  ).length;
  const blockedExitCount = Math.max(0, exitNodes.length - accessibleExitCount);
  const hallwayScores = hallwayNodes.map((node) => hallwayScoreById.get(node.id) ?? 0);
  const avgHallwayScore =
    hallwayScores.length > 0
      ? hallwayScores.reduce((sum, value) => sum + value, 0) / hallwayScores.length
      : 0;
  const sensorRows = [
    ...exitNodes.map((node) => ({
      id: node.id,
      label: node.label,
      nodeType: "exit",
      score: exitScoreById.get(node.id) ?? 0,
    })),
    ...hallwayNodes.map((node) => ({
      id: node.id,
      label: node.label,
      nodeType: "hallway",
      score: hallwayScoreById.get(node.id) ?? 0,
    })),
  ]
    .sort((left, right) => right.score - left.score)
    .slice(0, 6);

  return {
    exitCount: exitNodes.length,
    hallwayCount: hallwayNodes.length,
    accessibleExitCount,
    blockedExitCount,
    avgHallwayScore: roundValue(avgHallwayScore, 1),
    sensorRows,
  };
}

const SYNTHVERSE_EVENT_LOCATION_COORDINATES = {
  "560001": [77.5946, 12.9762],
  "560002": [77.5713, 12.9569],
  "560003": [77.57, 13.002],
  "560004": [77.5712, 12.9419],
  "560005": [77.6174, 12.9966],
  "560007": [77.6151, 12.9943],
  "560008": [77.6244, 12.9779],
  "560010": [77.5556, 12.9916],
  "560011": [77.596, 12.93],
  "560017": [77.6591, 12.9605],
  "560025": [77.6026, 12.9622],
  "560029": [77.6108, 12.9343],
  "560034": [77.6245, 12.9352],
  "560037": [77.7132, 12.9698],
  "560038": [77.64, 12.973],
  "560040": [77.5391, 12.9719],
  "560043": [77.5987, 13.0207],
  "560048": [77.7501, 12.9961],
  "560066": [77.7481, 12.9925],
  "560068": [77.6243, 12.8993],
  "560070": [77.585, 12.928],
  "560071": [77.6462, 12.9601],
  "560076": [77.6088, 12.9143],
  "560078": [77.5851, 12.9079],
  "560085": [77.5658, 12.9255],
  "560091": [77.514, 13.032],
  "560092": [77.596, 13.1],
  "560093": [77.6675, 12.9867],
  "560100": [77.664, 12.845],
};

const SYNTHVERSE_EVENT_LOCATION_ALIASES = [
  { key: "yelahanka", coordinate: [77.596, 13.1] },
  { key: "hebbal", coordinate: [77.593, 13.042] },
  { key: "malleshwaram", coordinate: [77.57, 13.002] },
  { key: "malleswaram", coordinate: [77.57, 13.002] },
  { key: "rr nagar", coordinate: [77.518, 12.925] },
  { key: "rajarajeshwari nagar", coordinate: [77.518, 12.925] },
  { key: "jayanagar", coordinate: [77.585, 12.928] },
  { key: "electronic city", coordinate: [77.664, 12.845] },
  { key: "indiranagar", coordinate: [77.64, 12.973] },
  { key: "kr puram", coordinate: [77.698, 13.013] },
  { key: "k r puram", coordinate: [77.698, 13.013] },
  { key: "koramangala", coordinate: [77.6245, 12.9352] },
  { key: "whitefield", coordinate: [77.7481, 12.9925] },
  { key: "peenya", coordinate: [77.514, 13.032] },
  { key: "bommasandra", coordinate: [77.682, 12.835] },
  { key: "domlur", coordinate: [77.6591, 12.9605] },
  { key: "basavanagudi", coordinate: [77.5712, 12.9419] },
  { key: "mg road", coordinate: [77.6035, 12.9758] },
  { key: "richmond", coordinate: [77.6026, 12.9622] },
];

const CITY_RESILIENCE_SECTOR_ALIASES = [
  { key: "electronic city phase ii", coordinate: [77.682, 12.839] },
  { key: "electronic city", coordinate: [77.664, 12.845] },
  { key: "hsr layout sector 1", coordinate: [77.638, 12.912] },
  { key: "hsr layout", coordinate: [77.651, 12.914] },
  { key: "whitefield itpl", coordinate: [77.747, 12.989] },
  { key: "whitefield", coordinate: [77.7481, 12.9925] },
  { key: "koramangala", coordinate: [77.6245, 12.9352] },
  { key: "jp nagar", coordinate: [77.5851, 12.9079] },
  { key: "banashankari", coordinate: [77.5613, 12.925] },
  { key: "rr nagar", coordinate: [77.518, 12.925] },
  { key: "rajarajeshwari nagar", coordinate: [77.518, 12.925] },
  { key: "yelahanka", coordinate: [77.596, 13.1] },
  { key: "hebbal", coordinate: [77.593, 13.042] },
  { key: "malleshwaram", coordinate: [77.57, 13.002] },
  { key: "malleswaram", coordinate: [77.57, 13.002] },
  { key: "indiranagar", coordinate: [77.64, 12.973] },
  { key: "marathahalli", coordinate: [77.701, 12.956] },
  { key: "bommanahalli", coordinate: [77.6305, 12.9003] },
];

function resolveSynthverseEventCoordinate(event) {
  const rawCandidates = [
    `${event?.venue_type ?? ""}`,
    `${event?.location ?? ""}`,
    `${event?.event_name ?? ""}`,
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  for (const candidate of rawCandidates) {
    const pincodeMatch = candidate.match(/\b56\d{4}\b/);

    if (pincodeMatch && SYNTHVERSE_EVENT_LOCATION_COORDINATES[pincodeMatch[0]]) {
      return {
        coordinate: SYNTHVERSE_EVENT_LOCATION_COORDINATES[pincodeMatch[0]],
        matchLabel: pincodeMatch[0],
      };
    }

    const normalizedCandidate = candidate.toLowerCase();
    const aliasMatch = SYNTHVERSE_EVENT_LOCATION_ALIASES.find((alias) =>
      normalizedCandidate.includes(alias.key),
    );

    if (aliasMatch) {
      return {
        coordinate: aliasMatch.coordinate,
        matchLabel: aliasMatch.key,
      };
    }
  }

  return rawCandidates.length > 0
    ? {
        coordinate: BENGALURU_CENTER,
        matchLabel: "bengaluru",
      }
    : null;
}

function resolveCityResilienceSectorCoordinate(sector) {
  const normalizedSector = `${sector ?? ""}`.trim().toLowerCase();

  if (!normalizedSector) {
    return BENGALURU_CENTER;
  }

  const aliasMatch = CITY_RESILIENCE_SECTOR_ALIASES.find((alias) =>
    normalizedSector.includes(alias.key),
  );

  return aliasMatch?.coordinate ?? BENGALURU_CENTER;
}

async function resolveCityResilienceGeocode(sector, city, fallbackCoordinate) {
  const normalizedSector = `${sector ?? ""}`.trim();

  if (!normalizedSector) {
    return fallbackCoordinate ?? BENGALURU_CENTER;
  }

  const cacheKey = `${CITY_RESILIENCE_GEOCODE_CACHE_PREFIX}${city.toLowerCase()}:${normalizedSector.toLowerCase()}`;
  const cachedCoordinate = getCachedGeocodeCoordinate(cacheKey);

  if (cachedCoordinate) {
    return cachedCoordinate;
  }

  try {
    const query = `${normalizedSector}, ${city}, Karnataka, India`;
    const searchParams = new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: "1",
    });
    const response = await fetch(`${NOMINATIM_SEARCH_URL}?${searchParams.toString()}`);

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const results = await response.json();
    const bestResult = Array.isArray(results) ? results[0] : null;
    const longitude = Number(bestResult?.lon);
    const latitude = Number(bestResult?.lat);

    if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
      const coordinate = [longitude, latitude];
      setCachedGeocodeCoordinate(cacheKey, coordinate);
      await wait(1100);
      return coordinate;
    }
  } catch {
    // Fall back to local alias/center when the free geocoder is unavailable.
  }

  if (fallbackCoordinate) {
    setCachedGeocodeCoordinate(cacheKey, fallbackCoordinate);
  }

  return fallbackCoordinate ?? BENGALURU_CENTER;
}

function getCachedGeocodeCoordinate(cacheKey) {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(cacheKey);

    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue);

    if (
      Array.isArray(parsedValue) &&
      Number.isFinite(Number(parsedValue[0])) &&
      Number.isFinite(Number(parsedValue[1]))
    ) {
      return [Number(parsedValue[0]), Number(parsedValue[1])];
    }
  } catch {
    return null;
  }

  return null;
}

function setCachedGeocodeCoordinate(cacheKey, coordinate) {
  if (typeof window === "undefined" || !Array.isArray(coordinate)) {
    return;
  }

  try {
    window.localStorage.setItem(cacheKey, JSON.stringify(coordinate));
  } catch {
    // Ignore storage failures.
  }
}

function wait(durationMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

function buildCircleCoordinates(center, radiusMeters, stepCount = 48) {
  const coordinates = [];

  for (let step = 0; step <= stepCount; step += 1) {
    coordinates.push(offsetCoordinate(center, radiusMeters, (step / stepCount) * 360));
  }

  return coordinates;
}

function offsetCoordinate(origin, distanceMeters, bearingDegrees) {
  const earthRadiusMeters = 6371000;
  const angularDistance = distanceMeters / earthRadiusMeters;
  const bearingRadians = (bearingDegrees * Math.PI) / 180;
  const [longitude, latitude] = origin;
  const latitudeRadians = (latitude * Math.PI) / 180;
  const longitudeRadians = (longitude * Math.PI) / 180;
  const nextLatitude = Math.asin(
    Math.sin(latitudeRadians) * Math.cos(angularDistance) +
      Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearingRadians),
  );
  const nextLongitude =
    longitudeRadians +
    Math.atan2(
      Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
      Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(nextLatitude),
    );

  return [(nextLongitude * 180) / Math.PI, (nextLatitude * 180) / Math.PI];
}

async function requestJson(baseUrl, path, init = undefined) {
  const normalizedBaseUrl = normalizeSynthverseApiBaseUrl(baseUrl);

  if (!normalizedBaseUrl) {
    throw new Error("Synthverse API base URL is not configured.");
  }

  let response;

  try {
    response = await fetch(`${normalizedBaseUrl}${path}`, init);
  } catch {
    throw new Error("Synthverse backend unavailable.");
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

function roundValue(value, digits = 1) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Number(numericValue.toFixed(digits));
}
