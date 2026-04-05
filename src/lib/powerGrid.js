import { emptyFeatureCollection } from "./navigation.js";
import { describePowerMetric } from "./powerSimulation.js";

export function createEmptyPowerGridDisplay() {
  return {
    visibleGrid: emptyFeatureCollection(),
    incidents: emptyFeatureCollection(),
  };
}

export function buildStyledPowerGrid({ powerGrid, districts, incidents, metric }) {
  if (!Array.isArray(powerGrid?.features) || powerGrid.features.length === 0) {
    return createEmptyPowerGridDisplay();
  }

  if (!Array.isArray(districts) || districts.length === 0) {
    return createEmptyPowerGridDisplay();
  }

  const incidentList = Array.isArray(incidents) ? incidents : incidents ? [incidents] : [];
  const visibleFeatures = powerGrid.features.map((feature) => {
    const district = findNearestDistrict(getFeatureAnchorCoordinate(feature.geometry), districts);
    const metricValue = getDistrictMetricValue(metric, district);
    const metricState = describePowerMetric(metric, metricValue);
    const voltageState = describePowerMetric("voltage", district?.voltageKV ?? 0);
    const loadWeight = clamp((district?.servedMW ?? district?.demandMW ?? 0) / 340, 0.22, 1);
    const lineVoltageKV = feature.properties?.voltageKV ?? 66;
    const baseWidth = clamp(lineVoltageKV / 80, 0.9, 3.4);
    const isIncidentAffected = incidentList.some(
      (incident) =>
        Array.isArray(incident?.coordinate) &&
        distanceMeters(getFeatureAnchorCoordinate(feature.geometry), incident.coordinate) <=
          (incident.impactRadiusMeters ?? 0) * 0.62,
    );
    const isFaulted = incidentList.some(
      (incident) => incident?.type === "lineFault" && incident.featureId === feature.properties?.id,
    );

    return {
      type: "Feature",
      geometry: feature.geometry,
      properties: {
        ...feature.properties,
        districtId: district?.id ?? null,
        voltageKV: roundValue(district?.voltageKV ?? 0, 1),
        loadMW: roundValue(district?.servedMW ?? district?.demandMW ?? 0, 1),
        supplyPercent: roundValue(district?.supplyPercent ?? 0, 1),
        lineColor: metricState.color,
        voltageColor: voltageState.color,
        lineWidth: roundValue(baseWidth + loadWeight * 1.9 + (isFaulted ? 1.4 : 0), 2),
        lineOpacity: clamp(0.42 + loadWeight * 0.36 + (isIncidentAffected ? 0.14 : 0), 0.42, 0.96),
        contextOpacity: clamp(0.14 + loadWeight * 0.16, 0.14, 0.36),
        isFaulted: isFaulted ? 1 : 0,
        isIncidentAffected: isIncidentAffected ? 1 : 0,
      },
    };
  });

  const incidentFeatures = incidentList
    .filter((incident) => Array.isArray(incident?.coordinate))
    .map((incident) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: incident.coordinate,
      },
      properties: {
        id: incident.id,
        label: incident.label ?? "Power fault",
        incidentType: incident.type ?? "lineFault",
      },
    }));

  return {
    visibleGrid: { type: "FeatureCollection", features: visibleFeatures },
    incidents:
      incidentFeatures.length > 0
        ? { type: "FeatureCollection", features: incidentFeatures }
        : emptyFeatureCollection(),
  };
}

export function buildManualPowerIncident({
  mode,
  coordinate,
  powerGrid,
  powerSubstations,
}) {
  if (mode === "power-line-fault") {
    const nearestLine = findNearestLineCoordinate(powerGrid, coordinate);

    if (!nearestLine) {
      return null;
    }

    return {
      id: `power-line-fault:${Date.now()}`,
      type: "lineFault",
      featureId: nearestLine.featureId,
      coordinate: nearestLine.coordinate,
      label: `Line fault · ${nearestLine.featureId}`,
      impactRadiusMeters: 2600,
    };
  }

  if (mode === "power-substation-outage") {
    const nearestSubstation = findNearestPointFeature(powerSubstations, coordinate);

    if (!nearestSubstation) {
      return null;
    }

    return {
      id: `power-substation-outage:${Date.now()}`,
      type: "substationOutage",
      targetId: nearestSubstation.properties?.id ?? "substation",
      coordinate: nearestSubstation.geometry.coordinates,
      label: `${nearestSubstation.properties?.name ?? "Substation"} outage`,
      impactRadiusMeters: 3800,
    };
  }

  return null;
}

function getDistrictMetricValue(metric, district) {
  if (!district) {
    return 0;
  }

  if (metric === "voltage") {
    return district.voltageKV ?? 0;
  }

  if (metric === "load") {
    return district.servedMW ?? district.demandMW ?? 0;
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

function findNearestPointFeature(featureCollection, coordinate) {
  if (!Array.isArray(featureCollection?.features)) {
    return null;
  }

  let nearestFeature = null;
  let nearestDistanceMeters = Number.POSITIVE_INFINITY;

  featureCollection.features.forEach((feature) => {
    if (feature.geometry?.type !== "Point") {
      return;
    }

    const distance = distanceMeters(coordinate, feature.geometry.coordinates);

    if (distance < nearestDistanceMeters) {
      nearestFeature = feature;
      nearestDistanceMeters = distance;
    }
  });

  return nearestFeature;
}

function findNearestLineCoordinate(featureCollection, coordinate) {
  if (!Array.isArray(featureCollection?.features)) {
    return null;
  }

  let nearestCandidate = null;

  featureCollection.features.forEach((feature) => {
    const coordinateGroups = getCoordinateGroups(feature.geometry);
    const featureId = feature.properties?.id;

    if (!featureId || coordinateGroups.length === 0) {
      return;
    }

    coordinateGroups.forEach((lineCoordinates) => {
      for (let index = 0; index < lineCoordinates.length - 1; index += 1) {
        const projectedCoordinate = projectCoordinateOntoSegment(
          coordinate,
          lineCoordinates[index],
          lineCoordinates[index + 1],
        );
        const distance = distanceMeters(coordinate, projectedCoordinate);

        if (distance < (nearestCandidate?.distanceMeters ?? Number.POSITIVE_INFINITY)) {
          nearestCandidate = {
            featureId,
            coordinate: projectedCoordinate,
            distanceMeters: distance,
          };
        }
      }
    });
  });

  return nearestCandidate;
}

function getFeatureAnchorCoordinate(geometry) {
  const coordinateGroups = getCoordinateGroups(geometry);

  if (coordinateGroups.length === 0 || coordinateGroups[0].length === 0) {
    return null;
  }

  const primaryLine = coordinateGroups.reduce((longest, current) =>
    current.length > longest.length ? current : longest,
  );

  return primaryLine[Math.floor(primaryLine.length / 2)] ?? primaryLine[0] ?? null;
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

function roundValue(value, precision) {
  const factor = 10 ** precision;
  return Math.round((value ?? 0) * factor) / factor;
}

function clamp(value, minValue, maxValue) {
  return Math.min(maxValue, Math.max(minValue, value));
}
