import { emptyFeatureCollection } from "./navigation.js";
import { WATER_NETWORK_NODES } from "../data/offlineWater.js";
import { describeWaterMetric } from "./waterSimulation.js";

const BASE_LOCAL_SAMPLE_DIVISOR = 8;
const STRESSED_LOCAL_SAMPLE_DIVISOR = 3;
const BREAK_LOCAL_SAMPLE_DIVISOR = 1;
const RESERVOIR_NODES = WATER_NETWORK_NODES.filter(
  (node) => node.nodeType === "source" || node.nodeType === "tank",
);

export function createEmptyWaterGridDisplay() {
  return {
    visibleGrid: emptyFeatureCollection(),
    breaks: emptyFeatureCollection(),
  };
}

export function buildStyledWaterGrid({ waterGrid, districts, incidents, metric }) {
  if (!Array.isArray(waterGrid?.features) || waterGrid.features.length === 0) {
    return createEmptyWaterGridDisplay();
  }

  if (!Array.isArray(districts) || districts.length === 0) {
    return createEmptyWaterGridDisplay();
  }

  const visibleFeatures = [];
  const incidentList = Array.isArray(incidents) ? incidents : incidents ? [incidents] : [];
  const incidentPointFeatures = incidentList
    .filter((incident) => Array.isArray(incident?.coordinate))
    .map((incident) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: incident.coordinate,
      },
      properties: {
        id: incident.id,
        label: incident.label ?? "Water fault",
        incidentType: incident.type ?? "pipeBreak",
      },
    }));

  waterGrid.features.forEach((feature) => {
    const featureId = feature?.properties?.id;
    const diameterClass = feature?.properties?.diameterClass ?? "lte300";
    const anchorCoordinate = getFeatureAnchorCoordinate(feature.geometry);

    if (!anchorCoordinate || !featureId) {
      return;
    }

    const district = findNearestDistrict(anchorCoordinate, districts);
    const isCriticalMain = diameterClass === "gt300";
    const isBroken = incidentList.some(
      (incident) => incident?.type === "pipeBreak" && featureId === incident.featureId,
    );
    const isAffected = incidentList.some(
      (incident) =>
        Array.isArray(incident?.coordinate) &&
        distanceMeters(anchorCoordinate, incident.coordinate) <=
          (incident.impactRadiusMeters ?? 0) * 0.58,
    );
    const sampleDivisor = isCriticalMain
      ? 1
      : isAffected
        ? BREAK_LOCAL_SAMPLE_DIVISOR
        : district?.stressed
          ? STRESSED_LOCAL_SAMPLE_DIVISOR
          : BASE_LOCAL_SAMPLE_DIVISOR;

    if (!isBroken && !isCriticalMain && hashString(featureId) % sampleDivisor !== 0) {
      return;
    }

    const pressureState = describeWaterMetric("pressure", district?.pressureM ?? 0);
    const metricValue = getDistrictMetricValue(metric, district);
    const metricState = describeWaterMetric(metric, metricValue);
    const flowMLD = district?.servedMLD ?? district?.demandMLD ?? 0;
    const flowWeight = clamp(
      flowMLD / (isCriticalMain ? 38 : 16),
      isCriticalMain ? 0.42 : 0.2,
      1,
    );
    const lineWidth = roundValue(
      (isCriticalMain ? 2.3 : 1.15) +
        flowWeight * (isCriticalMain ? 4.2 : 2.1) +
        (isAffected ? 0.95 : 0) +
        (isBroken ? 1.8 : 0),
      2,
    );
    const lineOpacity = clamp(
      (isCriticalMain ? 0.62 : 0.34) +
        flowWeight * 0.28 +
        (district?.stressed ? 0.12 : 0) +
        (isAffected ? 0.12 : 0) +
        (isBroken ? 0.12 : 0),
      0.34,
      0.98,
    );
    const contextOpacity = clamp(
      (isCriticalMain ? 0.24 : 0.12) + flowWeight * 0.16,
      0.12,
      0.42,
    );

    visibleFeatures.push({
      type: "Feature",
      geometry: feature.geometry,
      properties: {
        ...feature.properties,
        districtId: district?.id ?? null,
        pressureM: roundValue(district?.pressureM ?? 0, 1),
        flowMLD: roundValue(flowMLD, 1),
        supplyPercent: roundValue(district?.supplyPercent ?? 0, 1),
        lineColor: pressureState.color,
        metricColor: metricState.color,
        pressureColor: pressureState.color,
        lineWidth,
        lineOpacity,
        contextOpacity,
        isCriticalMain: isCriticalMain ? 1 : 0,
        isAffected: isAffected ? 1 : 0,
        isBroken: isBroken ? 1 : 0,
      },
    });
  });

  return {
    visibleGrid:
      visibleFeatures.length > 0
        ? { type: "FeatureCollection", features: visibleFeatures }
        : emptyFeatureCollection(),
    breaks:
      incidentPointFeatures.length > 0
        ? { type: "FeatureCollection", features: incidentPointFeatures }
        : emptyFeatureCollection(),
  };
}

export function buildWaterPressureHeatmapGeoJSON(districts) {
  if (!Array.isArray(districts) || districts.length === 0) {
    return emptyFeatureCollection();
  }

  const features = [];

  districts.forEach((district) => {
    if (!Array.isArray(district?.coordinate)) {
      return;
    }

    const zoneRadiusMeters = Math.max(900, Math.min(district.zoneRadiusMeters ?? 2400, 3800));
    const pressureWeight = Math.max(0.28, Math.min((district.pressureM ?? 0) / 44, 1.18));

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: district.coordinate,
      },
      properties: {
        id: `${district.id}:pressure:center`,
        weight: pressureWeight,
      },
    });

    [0, 45, 90, 135, 180, 225, 270, 315].forEach((bearingDegrees, index) => {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: offsetCoordinate(district.coordinate, zoneRadiusMeters * 0.4, bearingDegrees),
        },
        properties: {
          id: `${district.id}:pressure:ring:${index}`,
          weight: pressureWeight * 0.88,
        },
      });
    });

    [22, 112, 202, 292].forEach((bearingDegrees, index) => {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: offsetCoordinate(district.coordinate, zoneRadiusMeters * 0.68, bearingDegrees),
        },
        properties: {
          id: `${district.id}:pressure:outer:${index}`,
          weight: pressureWeight * 0.56,
        },
      });
    });
  });

  return features.length > 0
    ? {
        type: "FeatureCollection",
        features,
      }
    : emptyFeatureCollection();
}

export function buildWaterIncidentHeatmapGeoJSON({ districts, incidents }) {
  const incidentList = Array.isArray(incidents) ? incidents : incidents ? [incidents] : [];
  const features = [];

  incidentList.forEach((incident, incidentIndex) => {
    if (!Array.isArray(incident?.coordinate)) {
      return;
    }

    const impactRadiusMeters = Math.max(
      800,
      Math.min(incident.impactRadiusMeters ?? 2400, 4800),
    );
    const severity = incident.type === "reservoirFailure" ? 1 : 0.82;

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: incident.coordinate,
      },
      properties: {
        id: incident.id ?? `water-incident:${incidentIndex}`,
        weight: severity,
      },
    });

    [0, 60, 120, 180, 240, 300].forEach((bearingDegrees, ringIndex) => {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: offsetCoordinate(
            incident.coordinate,
            impactRadiusMeters * 0.38,
            bearingDegrees,
          ),
        },
        properties: {
          id: `${incident.id ?? `water-incident:${incidentIndex}`}:ring:${ringIndex}`,
          weight: severity * 0.74,
        },
      });
    });
  });

  (districts ?? []).forEach((district) => {
    if (!Array.isArray(district?.coordinate) || !(district.breakSeverity > 0)) {
      return;
    }

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: district.coordinate,
      },
      properties: {
        id: `${district.id}:incident-intensity`,
        weight: Math.max(0.18, Math.min(district.breakSeverity, 1)),
      },
    });
  });

  return features.length > 0
    ? {
        type: "FeatureCollection",
        features,
      }
    : emptyFeatureCollection();
}

export function buildManualWaterIncident({ mode, coordinate, waterGrid }) {
  if (mode === "water-break") {
    const nearestPipe = findNearestWaterPipeCoordinate(waterGrid, coordinate);

    if (!nearestPipe) {
      return null;
    }

    return {
      id: `manual-break:${Date.now()}`,
      type: "pipeBreak",
      source: "manual",
      featureId: nearestPipe.featureId,
      coordinate: nearestPipe.coordinate,
      label: `Pipe break · ${nearestPipe.featureId}`,
      impactRadiusMeters: 2400,
    };
  }

  if (mode === "reservoir-failure") {
    const reservoirNode = findNearestReservoirNode(coordinate);

    if (!reservoirNode) {
      return null;
    }

    return {
      id: `manual-reservoir:${Date.now()}`,
      type: "reservoirFailure",
      source: "manual",
      targetNodeId: reservoirNode.id,
      coordinate: reservoirNode.coordinate,
      label: `${reservoirNode.label} failure`,
      impactRadiusMeters: 4200,
    };
  }

  return null;
}

function getDistrictMetricValue(metric, district) {
  if (!district) {
    return 0;
  }

  if (metric === "pressure") {
    return district.pressureM ?? 0;
  }

  if (metric === "flow") {
    return district.servedMLD ?? district.demandMLD ?? 0;
  }

  if (metric === "supply") {
    return district.supplyPercent ?? 0;
  }

  return Math.max(0, 100 - (district.supplyPercent ?? 0));
}

function findNearestDistrict(coordinate, districts) {
  let nearestDistrict = null;
  let nearestDistanceMeters = Number.POSITIVE_INFINITY;

  districts.forEach((district) => {
    const distance = distanceMeters(coordinate, district.coordinate);

    if (distance < nearestDistanceMeters) {
      nearestDistrict = district;
      nearestDistanceMeters = distance;
    }
  });

  return nearestDistrict;
}

function getFeatureAnchorCoordinate(geometry) {
  const coordinatePath = getPrimaryCoordinatePath(geometry);

  if (!coordinatePath || coordinatePath.length === 0) {
    return null;
  }

  return coordinatePath[Math.floor(coordinatePath.length / 2)] ?? coordinatePath[0] ?? null;
}

function getPrimaryCoordinatePath(geometry) {
  if (!geometry) {
    return null;
  }

  if (geometry.type === "LineString") {
    return Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
  }

  if (geometry.type !== "MultiLineString" || !Array.isArray(geometry.coordinates)) {
    return null;
  }

  let longestPath = null;
  let longestLength = -1;

  geometry.coordinates.forEach((lineCoordinates) => {
    const currentLength = Array.isArray(lineCoordinates) ? lineCoordinates.length : 0;

    if (currentLength > longestLength) {
      longestPath = lineCoordinates;
      longestLength = currentLength;
    }
  });

  return longestPath;
}

function distanceMeters(from, to) {
  if (!Array.isArray(from) || !Array.isArray(to)) {
    return Number.POSITIVE_INFINITY;
  }

  const meanLatitudeRadians = (((from[1] ?? 0) + (to[1] ?? 0)) / 2) * (Math.PI / 180);
  const metersPerDegreeLatitude = 111320;
  const metersPerDegreeLongitude = Math.cos(meanLatitudeRadians) * 111320;
  const deltaLongitudeMeters = ((to[0] ?? 0) - (from[0] ?? 0)) * metersPerDegreeLongitude;
  const deltaLatitudeMeters = ((to[1] ?? 0) - (from[1] ?? 0)) * metersPerDegreeLatitude;

  return Math.hypot(deltaLongitudeMeters, deltaLatitudeMeters);
}

function findNearestReservoirNode(coordinate) {
  let nearestNode = null;
  let nearestDistanceMeters = Number.POSITIVE_INFINITY;

  RESERVOIR_NODES.forEach((node) => {
    const distance = distanceMeters(coordinate, node.coordinate);

    if (distance < nearestDistanceMeters) {
      nearestNode = node;
      nearestDistanceMeters = distance;
    }
  });

  return nearestNode;
}

function findNearestWaterPipeCoordinate(waterGrid, coordinate) {
  if (!Array.isArray(waterGrid?.features) || !Array.isArray(coordinate)) {
    return null;
  }

  let nearestCandidate = null;

  waterGrid.features.forEach((feature) => {
    const featureId = feature?.properties?.id;
    const lineGroups = getCoordinateGroups(feature.geometry);

    if (!featureId || lineGroups.length === 0) {
      return;
    }

    lineGroups.forEach((lineCoordinates) => {
      for (let index = 0; index < lineCoordinates.length - 1; index += 1) {
        const segmentStart = lineCoordinates[index];
        const segmentEnd = lineCoordinates[index + 1];
        const projectedCoordinate = projectCoordinateOntoSegment(
          coordinate,
          segmentStart,
          segmentEnd,
        );
        const projectedDistanceMeters = distanceMeters(coordinate, projectedCoordinate);

        if (projectedDistanceMeters < (nearestCandidate?.distanceMeters ?? Number.POSITIVE_INFINITY)) {
          nearestCandidate = {
            featureId,
            coordinate: projectedCoordinate,
            distanceMeters: projectedDistanceMeters,
          };
        }
      }
    });
  });

  return nearestCandidate;
}

function getCoordinateGroups(geometry) {
  if (!geometry) {
    return [];
  }

  if (geometry.type === "LineString") {
    return Array.isArray(geometry.coordinates) ? [geometry.coordinates] : [];
  }

  if (geometry.type === "MultiLineString") {
    return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  }

  return [];
}

function projectCoordinateOntoSegment(point, start, end) {
  const meanLatitudeRadians =
    (((point[1] ?? 0) + (start[1] ?? 0) + (end[1] ?? 0)) / 3) * (Math.PI / 180);
  const metersPerDegreeLatitude = 111320;
  const metersPerDegreeLongitude = Math.cos(meanLatitudeRadians) * 111320;
  const pointX = (point[0] ?? 0) * metersPerDegreeLongitude;
  const pointY = (point[1] ?? 0) * metersPerDegreeLatitude;
  const startX = (start[0] ?? 0) * metersPerDegreeLongitude;
  const startY = (start[1] ?? 0) * metersPerDegreeLatitude;
  const endX = (end[0] ?? 0) * metersPerDegreeLongitude;
  const endY = (end[1] ?? 0) * metersPerDegreeLatitude;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const denominator = deltaX ** 2 + deltaY ** 2;

  if (denominator === 0) {
    return start;
  }

  const ratio = clamp(
    ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / denominator,
    0,
    1,
  );
  const snappedX = startX + deltaX * ratio;
  const snappedY = startY + deltaY * ratio;

  return [snappedX / metersPerDegreeLongitude, snappedY / metersPerDegreeLatitude];
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

function hashString(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0);
}

function roundValue(value, precision) {
  const factor = 10 ** precision;
  return Math.round((value ?? 0) * factor) / factor;
}

function clamp(value, minValue, maxValue) {
  return Math.min(maxValue, Math.max(minValue, value));
}
