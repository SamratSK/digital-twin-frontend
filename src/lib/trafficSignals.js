import {
  emptyFeatureCollection,
  getPointAtDistance,
  metersBetween,
} from "./navigation.js";

const SIGNAL_MATCH_RADIUS_METERS = 38;
const SIGNAL_APPROACH_WINDOW_METERS = 92;
const SIGNAL_RELEASE_WINDOW_METERS = 34;
const SIGNAL_BEARING_SAMPLE_METERS = 22;
const SIGNAL_BUCKET_PRECISION_DEGREES = 0.0012;
const SIGNAL_BUCKET_PADDING_DEGREES = 0.00045;

export function createEmptyTrafficSignalDisplay() {
  return {
    activeDirections: emptyFeatureCollection(),
    activeSignals: emptyFeatureCollection(),
  };
}

export function createTrafficSignalSystem(signalCollection, directionCollection) {
  const signalFeatures = Array.isArray(signalCollection?.features) ? signalCollection.features : [];
  const directionFeatures = Array.isArray(directionCollection?.features)
    ? directionCollection.features
    : [];

  if (signalFeatures.length === 0) {
    return null;
  }

  const signalsById = new Map();
  const signalFeaturesById = new Map();
  const directionFeaturesById = new Map();
  const directionFeaturesBySignalId = new Map();
  const signalIdsByBucket = new Map();

  signalFeatures.forEach((feature) => {
    const signalId = feature?.properties?.id;
    const coordinate = feature?.geometry?.coordinates;

    if (!signalId || !Array.isArray(coordinate)) {
      return;
    }

    signalsById.set(signalId, coordinate);
    signalFeaturesById.set(signalId, feature);

    const bucketId = buildBucketId(coordinate);
    const bucketSignalIds = signalIdsByBucket.get(bucketId) ?? [];
    bucketSignalIds.push(signalId);
    signalIdsByBucket.set(bucketId, bucketSignalIds);
  });

  directionFeatures.forEach((feature) => {
    const directionId = feature?.properties?.id;
    const signalId = feature?.properties?.signalId;

    if (!directionId || !signalId) {
      return;
    }

    directionFeaturesById.set(directionId, feature);
    const entries = directionFeaturesBySignalId.get(signalId) ?? [];
    entries.push(feature);
    directionFeaturesBySignalId.set(signalId, entries);
  });

  return {
    signalsById,
    signalFeaturesById,
    directionFeaturesById,
    directionFeaturesBySignalId,
    signalIdsByBucket,
  };
}

export function annotateRouteTrafficSignals(route, trafficSignalSystem) {
  if (!route || !trafficSignalSystem) {
    return {
      ...route,
      signalEvents: [],
    };
  }

  const routeMetrics = route.metrics;
  const path = routeMetrics?.path ?? [];
  const cumulativeDistances = routeMetrics?.cumulativeDistances ?? [];

  if (path.length < 2) {
    return {
      ...route,
      signalEvents: [],
    };
  }

  const bestEventBySignalId = new Map();

  for (let pointIndex = 1; pointIndex < path.length; pointIndex += 1) {
    const start = path[pointIndex - 1];
    const end = path[pointIndex];
    const candidateSignalIds = collectCandidateSignalIdsForSegment(trafficSignalSystem, start, end);

    candidateSignalIds.forEach((signalId) => {
      const signalCoordinate = trafficSignalSystem.signalsById.get(signalId);

      if (!signalCoordinate) {
        return;
      }

      const projection = projectCoordinateOntoSegment(signalCoordinate, start, end);

      if (projection.distanceMeters > SIGNAL_MATCH_RADIUS_METERS) {
        return;
      }

      const routeDistanceMeters =
        (cumulativeDistances[pointIndex - 1] ?? 0) + metersBetween(start, projection.coordinate);
      const nextEvent = buildSignalEvent({
        routeMetrics,
        routeDistanceMeters,
        signalId,
        signalCoordinate,
        directionFeatures: trafficSignalSystem.directionFeaturesBySignalId.get(signalId) ?? [],
      });
      const currentEvent = bestEventBySignalId.get(signalId);

      if (
        !currentEvent ||
        projection.distanceMeters < currentEvent.matchDistanceMeters ||
        routeDistanceMeters < currentEvent.routeDistanceMeters
      ) {
        bestEventBySignalId.set(signalId, {
          ...nextEvent,
          matchDistanceMeters: projection.distanceMeters,
        });
      }
    });
  }

  const signalEvents = [...bestEventBySignalId.values()]
    .sort((left, right) => left.routeDistanceMeters - right.routeDistanceMeters)
    .map(({ matchDistanceMeters, ...event }) => event);

  return {
    ...route,
    signalEvents,
  };
}

export function buildLiveTrafficSignalDisplay(trafficSignalSystem, simulation, runtimeByVehicleId) {
  if (!trafficSignalSystem || !simulation?.vehicles?.length) {
    return createEmptyTrafficSignalDisplay();
  }

  const activeDirectionCounts = new Map();
  const activeSignalCounts = new Map();

  simulation.vehicles.forEach((vehicle) => {
    const runtime = runtimeByVehicleId.get(vehicle.id);

    if (!runtime?.coordinate || (runtime?.remainingLaunchDelayMs ?? 0) > 0) {
      return;
    }

    const activeEvent = findActiveSignalEvent(vehicle.route?.signalEvents ?? [], runtime);

    if (!activeEvent) {
      return;
    }

    activeSignalCounts.set(activeEvent.signalId, (activeSignalCounts.get(activeEvent.signalId) ?? 0) + 1);

    if (activeEvent.directionFeatureId) {
      activeDirectionCounts.set(
        activeEvent.directionFeatureId,
        (activeDirectionCounts.get(activeEvent.directionFeatureId) ?? 0) + 1,
      );
    }
  });

  const activeDirectionFeatures = [...activeDirectionCounts.entries()]
    .map(([directionId, activeCount]) => {
      const feature = trafficSignalSystem.directionFeaturesById.get(directionId);

      if (!feature) {
        return null;
      }

      return {
        ...feature,
        properties: {
          ...feature.properties,
          activeCount,
        },
      };
    })
    .filter(Boolean);

  const activeSignalFeatures = [...activeSignalCounts.entries()]
    .map(([signalId, activeCount]) => {
      const feature = trafficSignalSystem.signalFeaturesById.get(signalId);

      if (!feature) {
        return null;
      }

      return {
        ...feature,
        properties: {
          ...feature.properties,
          activeCount,
        },
      };
    })
    .filter(Boolean);

  return {
    activeDirections:
      activeDirectionFeatures.length > 0
        ? { type: "FeatureCollection", features: activeDirectionFeatures }
        : emptyFeatureCollection(),
    activeSignals:
      activeSignalFeatures.length > 0
        ? { type: "FeatureCollection", features: activeSignalFeatures }
        : emptyFeatureCollection(),
  };
}

function buildSignalEvent({
  routeMetrics,
  routeDistanceMeters,
  signalId,
  signalCoordinate,
  directionFeatures,
}) {
  const routeLength = routeMetrics?.totalDistanceMeters ?? 0;
  const beforePoint = getPointAtDistance(
    routeMetrics,
    Math.max(0, routeDistanceMeters - SIGNAL_BEARING_SAMPLE_METERS),
  );
  const atPoint = getPointAtDistance(routeMetrics, routeDistanceMeters);
  const afterPoint = getPointAtDistance(
    routeMetrics,
    Math.min(routeLength, routeDistanceMeters + SIGNAL_BEARING_SAMPLE_METERS),
  );
  const incomingBearing = beforePoint?.bearing ?? atPoint?.bearing ?? 0;
  const outgoingBearing = afterPoint?.bearing ?? atPoint?.bearing ?? incomingBearing;
  const directionFeature = pickBestDirectionFeature(directionFeatures, outgoingBearing);

  return {
    signalId,
    coordinate: signalCoordinate,
    routeDistanceMeters,
    incomingBearing,
    outgoingBearing,
    turnType: classifyTurn(incomingBearing, outgoingBearing),
    directionFeatureId: directionFeature?.properties?.id ?? null,
  };
}

function findActiveSignalEvent(signalEvents, runtime) {
  if (!Array.isArray(signalEvents) || signalEvents.length === 0 || !runtime) {
    return null;
  }

  const traveledDistanceMeters = runtime.distanceMeters ?? 0;
  let bestEvent = null;
  let bestScore = Number.POSITIVE_INFINITY;

  signalEvents.forEach((event) => {
    const deltaMeters = event.routeDistanceMeters - traveledDistanceMeters;

    if (deltaMeters > SIGNAL_APPROACH_WINDOW_METERS || deltaMeters < -SIGNAL_RELEASE_WINDOW_METERS) {
      return;
    }

    const score = deltaMeters >= 0 ? deltaMeters : Math.abs(deltaMeters) * 0.6;

    if (score < bestScore) {
      bestScore = score;
      bestEvent = event;
    }
  });

  return bestEvent;
}

function classifyTurn(incomingBearing, outgoingBearing) {
  const delta = normalizeSignedBearing(outgoingBearing - incomingBearing);

  if (Math.abs(delta) <= 28) {
    return "straight";
  }

  if (delta > 0) {
    return "right";
  }

  return "left";
}

function pickBestDirectionFeature(directionFeatures, targetBearing) {
  if (!Array.isArray(directionFeatures) || directionFeatures.length === 0) {
    return null;
  }

  let bestFeature = null;
  let bestAngleDelta = Number.POSITIVE_INFINITY;

  directionFeatures.forEach((feature) => {
    const featureBearing = Number.parseFloat(feature?.properties?.bearing);

    if (!Number.isFinite(featureBearing)) {
      return;
    }

    const angleDelta = Math.abs(normalizeSignedBearing(featureBearing - targetBearing));

    if (angleDelta < bestAngleDelta) {
      bestAngleDelta = angleDelta;
      bestFeature = feature;
    }
  });

  return bestFeature;
}

function collectCandidateSignalIdsForSegment(trafficSignalSystem, start, end) {
  const minLongitude = Math.min(start[0], end[0]) - SIGNAL_BUCKET_PADDING_DEGREES;
  const maxLongitude = Math.max(start[0], end[0]) + SIGNAL_BUCKET_PADDING_DEGREES;
  const minLatitude = Math.min(start[1], end[1]) - SIGNAL_BUCKET_PADDING_DEGREES;
  const maxLatitude = Math.max(start[1], end[1]) + SIGNAL_BUCKET_PADDING_DEGREES;
  const startLngBucket = Math.floor(minLongitude / SIGNAL_BUCKET_PRECISION_DEGREES);
  const endLngBucket = Math.floor(maxLongitude / SIGNAL_BUCKET_PRECISION_DEGREES);
  const startLatBucket = Math.floor(minLatitude / SIGNAL_BUCKET_PRECISION_DEGREES);
  const endLatBucket = Math.floor(maxLatitude / SIGNAL_BUCKET_PRECISION_DEGREES);
  const signalIds = new Set();

  for (let lngBucket = startLngBucket; lngBucket <= endLngBucket; lngBucket += 1) {
    for (let latBucket = startLatBucket; latBucket <= endLatBucket; latBucket += 1) {
      const bucketSignalIds = trafficSignalSystem.signalIdsByBucket.get(`${lngBucket}:${latBucket}`) ?? [];

      bucketSignalIds.forEach((signalId) => {
        signalIds.add(signalId);
      });
    }
  }

  return [...signalIds];
}

function buildBucketId(coordinate) {
  return `${Math.floor(coordinate[0] / SIGNAL_BUCKET_PRECISION_DEGREES)}:${Math.floor(
    coordinate[1] / SIGNAL_BUCKET_PRECISION_DEGREES,
  )}`;
}

function projectCoordinateOntoSegment(point, start, end) {
  const meanLatitudeRadians = (((point[1] ?? 0) + (start[1] ?? 0) + (end[1] ?? 0)) / 3) * (Math.PI / 180);
  const metersPerDegreeLatitude = 111320;
  const metersPerDegreeLongitude = Math.cos(meanLatitudeRadians) * metersPerDegreeLatitude;
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
    return {
      coordinate: start,
      distanceMeters: metersBetween(point, start),
    };
  }

  const ratio = Math.max(
    0,
    Math.min(1, ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / denominator),
  );
  const snappedCoordinate = [
    (startX + deltaX * ratio) / metersPerDegreeLongitude,
    (startY + deltaY * ratio) / metersPerDegreeLatitude,
  ];

  return {
    coordinate: snappedCoordinate,
    distanceMeters: metersBetween(point, snappedCoordinate),
  };
}

function normalizeSignedBearing(value) {
  const normalizedValue = ((value + 540) % 360) - 180;
  return normalizedValue === -180 ? 180 : normalizedValue;
}
