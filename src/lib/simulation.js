import {
  bearingBetween,
  buildRouteMetrics,
  emptyFeatureCollection,
  getPointAtDistance,
} from "./navigation.js";
import { annotateRouteTrafficSignals } from "./trafficSignals.js";

export const BASE_ROUTE_DURATION_MS = 20000;
const CONGESTION_CLUSTER_MIN_VEHICLES = 4;
const CONGESTION_CLUSTER_RADIUS_METERS = 55;
const CONGESTION_HOTSPOT_BASE_RADIUS_METERS = 75;
const CONGESTION_HOTSPOT_MAX_RADIUS_METERS = 140;
const CONGESTION_CLUSTER_DEDUPLICATION_METERS = 70;
const MAX_CONGESTION_HOTSPOTS = 6;
const HOTSPOT_ESCAPE_PADDING_METERS = 45;
const HOTSPOT_ESCAPE_BEARING_OFFSETS = [-60, -36, -18, 0, 18, 36, 60];

const VEHICLE_COLORS = [
  "#0f172a",
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#be123c",
];

export function normalizeVehicleCount(value) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue) || parsedValue < 1) {
    return 1;
  }

  return Math.min(parsedValue, 250);
}

export function normalizeHotspotRadius(value) {
  const parsedValue = Number.parseFloat(value);

  if (!Number.isFinite(parsedValue) || parsedValue < 10) {
    return 50;
  }

  return Math.min(parsedValue, 2000);
}

export function normalizeVehicleProbeRadius(value) {
  const parsedValue = Number.parseFloat(value);

  if (!Number.isFinite(parsedValue) || parsedValue < 25) {
    return 200;
  }

  return Math.min(parsedValue, 5000);
}

export function formatCoordinateLabel([longitude, latitude]) {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

export function buildDefinedRoutePlan(startSelection, endSelection) {
  return {
    id: `${startSelection.label}:${endSelection.label}`,
    startLabel: startSelection.label,
    endLabel: endSelection.label,
    displayStartCoordinate: startSelection.coordinate,
    displayEndCoordinate: endSelection.coordinate,
    routeStartCoordinate: startSelection.roadCoordinate ?? startSelection.coordinate,
    routeEndCoordinate: endSelection.roadCoordinate ?? endSelection.coordinate,
  };
}

export function buildRouteFromPlan(router, routePlan, hotspots, trafficSignalSystem = null) {
  const routeStartCoordinate = routePlan.routeStartCoordinate;
  const routeEndCoordinate = routePlan.routeEndCoordinate;
  const displayStartCoordinate = routePlan.displayStartCoordinate ?? routeStartCoordinate;
  const displayEndCoordinate = routePlan.displayEndCoordinate ?? routeEndCoordinate;
  const waypointCoordinates = (routePlan.waypointCoordinates ?? []).filter(Boolean);

  if (waypointCoordinates.length === 0 && coordinatesEqual(routeStartCoordinate, routeEndCoordinate)) {
    return createRouteDefinition(
      {
        id: routePlan.id,
        startLabel: routePlan.startLabel,
        endLabel: routePlan.endLabel,
        startCoordinate: routeStartCoordinate,
        endCoordinate: routeEndCoordinate,
        displayStartCoordinate,
        displayEndCoordinate,
        displayCoordinates: buildDisplayRouteCoordinates(
          displayStartCoordinate,
          [routeStartCoordinate],
          displayEndCoordinate,
        ),
        driveCoordinates: [routeStartCoordinate],
        distanceMeters: 0,
        visitedNodes: 0,
      },
      trafficSignalSystem,
    );
  }

  const legCoordinates = [routeStartCoordinate, ...waypointCoordinates, routeEndCoordinate];
  let driveCoordinates = [];
  let totalDistanceMeters = 0;
  let totalVisitedNodes = 0;

  for (let legIndex = 1; legIndex < legCoordinates.length; legIndex += 1) {
    const legStartCoordinate = legCoordinates[legIndex - 1];
    const legEndCoordinate = legCoordinates[legIndex];

    if (coordinatesEqual(legStartCoordinate, legEndCoordinate)) {
      driveCoordinates = mergeCoordinateLists(driveCoordinates, [legStartCoordinate]);
      continue;
    }

    const routeResult = router.route(legStartCoordinate, legEndCoordinate, hotspots);

    if (!routeResult) {
      return null;
    }

    driveCoordinates = mergeCoordinateLists(driveCoordinates, routeResult.coordinates);
    totalDistanceMeters += routeResult.distanceMeters;
    totalVisitedNodes += routeResult.visitedNodes;
  }

  if (driveCoordinates.length === 0) {
    driveCoordinates = [routeStartCoordinate];
  }

  return createRouteDefinition(
    {
      id: routePlan.id,
      startLabel: routePlan.startLabel,
      endLabel: routePlan.endLabel,
      startCoordinate: routeStartCoordinate,
      endCoordinate: routeEndCoordinate,
      displayStartCoordinate,
      displayEndCoordinate,
      displayCoordinates: buildDisplayRouteCoordinates(
        displayStartCoordinate,
        driveCoordinates,
        displayEndCoordinate,
      ),
      driveCoordinates,
      distanceMeters: totalDistanceMeters,
      visitedNodes: totalVisitedNodes,
    },
    trafficSignalSystem,
  );
}

export function buildRoutesFromPlans(router, routePlans, hotspots, trafficSignalSystem = null) {
  return routePlans
    .map((routePlan) => buildRouteFromPlan(router, routePlan, hotspots, trafficSignalSystem))
    .filter(Boolean);
}

export function buildRoutesGeoJSON(routes) {
  const visibleRoutes = (routes ?? []).filter(
    (route) => route && route.distanceMeters > 0 && route.coordinates.length > 1,
  );

  if (visibleRoutes.length === 0) {
    return emptyFeatureCollection();
  }

  return {
    type: "FeatureCollection",
    features: visibleRoutes.map((route) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: route.coordinates,
      },
      properties: {
        id: route.id,
        distanceMeters: route.distanceMeters,
      },
    })),
  };
}

export function buildTrafficHeatmapGeoJSON({
  routes = [],
  vehicleFeatures = [],
  hotspots = [],
  signalFeatures = [],
  eventFeatures = [],
}) {
  const features = [];

  (signalFeatures ?? []).forEach((feature, signalIndex) => {
    const coordinate = feature?.geometry?.coordinates;

    if (!Array.isArray(coordinate)) {
      return;
    }

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: coordinate,
      },
      properties: {
        id: feature?.properties?.id ?? `signal-heat:${signalIndex}`,
        weight: 0.16,
      },
    });
  });

  (routes ?? []).forEach((route, routeIndex) => {
    const coordinates = Array.isArray(route?.coordinates) ? route.coordinates : [];
    if (coordinates.length === 0) {
      return;
    }

    const routeSampleStep = Math.max(1, Math.ceil(coordinates.length / 36));
    coordinates.forEach((coordinate, coordinateIndex) => {
      if (coordinateIndex % routeSampleStep !== 0 && coordinateIndex !== coordinates.length - 1) {
        return;
      }

      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: coordinate,
        },
      properties: {
        id: `route-heat:${routeIndex}:${coordinateIndex}`,
        weight: 0.16,
      },
    });
  });
  });

  (vehicleFeatures ?? []).forEach((feature, featureIndex) => {
    const coordinate = feature?.geometry?.coordinates;

    if (!Array.isArray(coordinate)) {
      return;
    }

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: coordinate,
      },
      properties: {
        id: feature?.properties?.id ?? `vehicle-heat:${featureIndex}`,
        weight: 0.55,
      },
    });
  });

  (eventFeatures ?? []).forEach((feature, featureIndex) => {
    const coordinate = feature?.geometry?.coordinates;

    if (!Array.isArray(coordinate)) {
      return;
    }

    const trafficScore = Number(feature?.properties?.trafficScore ?? 0);
    const expectedCrowd = Number(feature?.properties?.expectedCrowd ?? 0);
    const eventWeight = clamp(0.35 + trafficScore / 55, 0.35, 1.95);
    const spreadRadiusMeters = Math.min(220, 70 + trafficScore * 1.8 + expectedCrowd / 90);

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: coordinate,
      },
      properties: {
        id: feature?.properties?.id ?? `event-heat:${featureIndex}`,
        weight: eventWeight,
      },
    });

    [0, 72, 144, 216, 288].forEach((bearingDegrees, ringIndex) => {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: offsetCoordinate(coordinate, spreadRadiusMeters, bearingDegrees),
        },
        properties: {
          id: `${feature?.properties?.id ?? `event-heat:${featureIndex}`}:ring:${ringIndex}`,
          weight: eventWeight * 0.76,
        },
      });
    });
  });

  (hotspots ?? []).forEach((hotspot, hotspotIndex) => {
    if (!Array.isArray(hotspot?.coordinate)) {
      return;
    }

    const hotspotWeight = hotspot.kind === "automatic" ? 1.7 : 1.4;
    const spreadRadiusMeters = Math.max(
      28,
      Math.min((hotspot.radiusMeters ?? CONGESTION_HOTSPOT_BASE_RADIUS_METERS) * 0.52, 150),
    );

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: hotspot.coordinate,
      },
      properties: {
        id: hotspot.id ?? `hotspot-heat:${hotspotIndex}`,
        weight: hotspotWeight,
      },
    });

    [0, 60, 120, 180, 240, 300].forEach((bearingDegrees, ringIndex) => {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: offsetCoordinate(hotspot.coordinate, spreadRadiusMeters, bearingDegrees),
        },
        properties: {
          id: `${hotspot.id ?? `hotspot-heat:${hotspotIndex}`}:ring:${ringIndex}`,
          weight: hotspotWeight * 0.72,
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

export function buildSimulationRoutes(simulation) {
  const seen = new Set();

  return (simulation?.vehicles ?? []).flatMap((vehicle) => {
    const route = vehicle.route;
    const coordinates = buildVisibleRouteCoordinates(vehicle);

    if (!route || coordinates.length <= 1) {
      return [];
    }

    const signature = coordinates
      .map((coordinate) => `${coordinate[0].toFixed(6)},${coordinate[1].toFixed(6)}`)
      .join("|");

    if (seen.has(signature)) {
      return [];
    }

    seen.add(signature);
    return [
      {
        ...route,
        coordinates,
      },
    ];
  });
}

export function buildDefinedVehicles(route, vehicleCount) {
  return Array.from({ length: vehicleCount }, (_, index) =>
    createVehicle({
      id: `defined:vehicle:${index + 1}`,
      route: cloneRoute(route, `defined:route:${index + 1}`),
      launchDelayMs: 0,
      color: VEHICLE_COLORS[index % VEHICLE_COLORS.length],
    }),
  );
}

export function buildRandomVehicles(routes) {
  return routes.map((route, index) =>
    createVehicle({
      id: `random:vehicle:${index + 1}`,
      route: cloneRoute(route, `random:route:${index + 1}`),
      launchDelayMs: 0,
      color: VEHICLE_COLORS[index % VEHICLE_COLORS.length],
    }),
  );
}

export function buildRandomRoutePlans(router, vehicleCount) {
  const routePlans = [];
  const maxAttempts = Math.max(vehicleCount * 40, 80);

  for (let attempt = 0; attempt < maxAttempts && routePlans.length < vehicleCount; attempt += 1) {
    const startCoordinate = pickRandomRoutableCoordinate(router);
    const endCoordinate = pickRandomRoutableCoordinate(router);

    if (!startCoordinate || !endCoordinate || coordinatesEqual(startCoordinate, endCoordinate)) {
      continue;
    }

    routePlans.push({
      id: `random-route:${routePlans.length + 1}`,
      startLabel: formatCoordinateLabel(startCoordinate),
      endLabel: formatCoordinateLabel(endCoordinate),
      displayStartCoordinate: startCoordinate,
      displayEndCoordinate: endCoordinate,
      routeStartCoordinate: startCoordinate,
      routeEndCoordinate: endCoordinate,
    });
  }

  return routePlans;
}

export function rerouteSimulationVehicles({
  router,
  simulation,
  runtimeByVehicleId,
  currentElapsedMs = 0,
  hotspots,
  trafficSignalSystem = null,
}) {
  return (simulation?.vehicles ?? []).map((vehicle) => {
    const runtime =
      runtimeByVehicleId.get(vehicle.id) ?? buildVehicleRuntimeSnapshot(vehicle, currentElapsedMs);
    const trailCoordinates = mergeCoordinateLists(
      vehicle.trailCoordinates,
      buildCurrentSegmentTrailCoordinates(vehicle.route, runtime),
    );

    if (vehicle.parked || runtime?.completed) {
      const parkedCoordinate =
        runtime?.coordinate ??
        vehicle.route.driveCoordinates[vehicle.route.driveCoordinates.length - 1] ??
        vehicle.targetCoordinate;

      return createParkedVehicle(vehicle, parkedCoordinate, trailCoordinates);
    }

    const currentCoordinate =
      runtime?.coordinate ??
      vehicle.route.driveCoordinates[0] ??
      vehicle.route.startCoordinate ??
      vehicle.targetCoordinate;
    const routePlan = {
      id: vehicle.routeId,
      startLabel: formatCoordinateLabel(currentCoordinate),
      endLabel: vehicle.targetLabel,
      displayStartCoordinate: currentCoordinate,
      displayEndCoordinate: vehicle.displayTargetCoordinate,
      routeStartCoordinate: router.nearestRoadCoordinate(currentCoordinate) ?? currentCoordinate,
      routeEndCoordinate: vehicle.targetCoordinate,
    };
    const activeAutomaticHotspot = findContainingAutomaticHotspot(currentCoordinate, hotspots);

    if (activeAutomaticHotspot) {
      routePlan.waypointCoordinates = [
        buildHotspotEscapeWaypoint(router, vehicle, currentCoordinate, activeAutomaticHotspot),
      ].filter(Boolean);
    }

    const nextRoute = buildRouteFromPlan(
      router,
      routePlan,
      hotspots ?? [],
      trafficSignalSystem,
    );

    if (!nextRoute) {
      return {
        ...vehicle,
        launchDelayMs: Math.max(0, runtime?.remainingLaunchDelayMs ?? vehicle.launchDelayMs),
      };
    }

    const nextRouteActivatedAtMs =
      (runtime?.remainingLaunchDelayMs ?? 0) > 0
        ? vehicle.routeActivatedAtMs ?? vehicle.launchDelayMs ?? 0
        : inferVehicleElapsedMs(vehicle, runtime);

    return {
      ...vehicle,
      route: cloneRoute(nextRoute, vehicle.routeId),
      routeActivatedAtMs: nextRouteActivatedAtMs,
      speedMetersPerMs:
        nextRoute.metrics.totalDistanceMeters > 0
          ? nextRoute.metrics.totalDistanceMeters / BASE_ROUTE_DURATION_MS
          : 0,
      trailCoordinates,
      launchDelayMs: Math.max(0, runtime?.remainingLaunchDelayMs ?? vehicle.launchDelayMs),
      parked: nextRoute.metrics.totalDistanceMeters <= 0,
    };
  });
}

export function buildHotspotGeoJSON(hotspots) {
  return {
    type: "FeatureCollection",
    features: hotspots.map((hotspot) => ({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [buildHotspotCircleCoordinates(hotspot.coordinate, hotspot.radiusMeters)],
      },
      properties: {
        id: hotspot.id,
        label: hotspot.label,
        message: hotspot.message ?? hotspot.label,
        kind: hotspot.kind ?? "manual",
        vehicleCount: hotspot.vehicleCount ?? 0,
        radiusMeters: hotspot.radiusMeters,
      },
    })),
  };
}

export function buildHotspotCenterGeoJSON(hotspots) {
  return {
    type: "FeatureCollection",
    features: hotspots.map((hotspot) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: hotspot.coordinate,
      },
      properties: {
        id: hotspot.id,
        label: hotspot.message ?? hotspot.label,
        detail: hotspot.label,
        kind: hotspot.kind ?? "manual",
        vehicleCount: hotspot.vehicleCount ?? 0,
        radiusMeters: hotspot.radiusMeters,
      },
    })),
  };
}

export function buildAutomaticTrafficHotspots(runtimeByVehicleId) {
  if (!runtimeByVehicleId || runtimeByVehicleId.size < CONGESTION_CLUSTER_MIN_VEHICLES) {
    return [];
  }

  const activeVehicles = [...runtimeByVehicleId.entries()]
    .map(([id, runtime]) => ({
      id,
      coordinate: runtime?.coordinate,
      completed: runtime?.completed,
      remainingLaunchDelayMs: runtime?.remainingLaunchDelayMs ?? 0,
    }))
    .filter(
      (vehicle) =>
        Array.isArray(vehicle.coordinate) &&
        !vehicle.completed &&
        vehicle.remainingLaunchDelayMs <= 0,
    );

  if (activeVehicles.length < CONGESTION_CLUSTER_MIN_VEHICLES) {
    return [];
  }

  const candidates = activeVehicles
    .map((centerVehicle) => {
      const members = activeVehicles.filter(
        (vehicle) =>
          distanceMeters(centerVehicle.coordinate, vehicle.coordinate) <=
          CONGESTION_CLUSTER_RADIUS_METERS,
      );

      if (members.length < CONGESTION_CLUSTER_MIN_VEHICLES) {
        return null;
      }

      const centerCoordinate = [
        members.reduce((sum, member) => sum + member.coordinate[0], 0) / members.length,
        members.reduce((sum, member) => sum + member.coordinate[1], 0) / members.length,
      ];
      const radiusMeters = Math.min(
        CONGESTION_HOTSPOT_MAX_RADIUS_METERS,
        CONGESTION_HOTSPOT_BASE_RADIUS_METERS + (members.length - CONGESTION_CLUSTER_MIN_VEHICLES) * 12,
      );
      const memberIds = members.map((member) => member.id).sort();

      return {
        id: `traffic:${memberIds.join("|")}`,
        label: `${members.length} vehicles · ${formatCoordinateLabel(centerCoordinate)}`,
        message: `Traffic cluster\n${members.length} vehicles`,
        coordinate: centerCoordinate,
        radiusMeters,
        vehicleCount: members.length,
        kind: "automatic",
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.vehicleCount - left.vehicleCount);

  const hotspots = [];

  candidates.forEach((candidate) => {
    if (hotspots.length >= MAX_CONGESTION_HOTSPOTS) {
      return;
    }

    const overlapsExisting = hotspots.some(
      (hotspot) =>
        distanceMeters(candidate.coordinate, hotspot.coordinate) <=
        CONGESTION_CLUSTER_DEDUPLICATION_METERS,
    );

    if (!overlapsExisting) {
      hotspots.push(candidate);
    }
  });

  return hotspots;
}

export function buildVehicleProbeGeoJSON(probe) {
  if (!probe?.coordinate || !probe?.radiusMeters) {
    return emptyFeatureCollection();
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [buildHotspotCircleCoordinates(probe.coordinate, probe.radiusMeters)],
        },
        properties: {
          id: probe.id ?? "vehicle-probe",
          count: probe.count ?? 0,
          radiusMeters: probe.radiusMeters,
        },
      },
    ],
  };
}

export function buildVehicleProbeCenterGeoJSON(probe) {
  if (!probe?.coordinate) {
    return emptyFeatureCollection();
  }

  const vehicleLabel = `${probe.count ?? 0} vehicle${probe.count === 1 ? "" : "s"}`;

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: probe.coordinate,
        },
        properties: {
          id: probe.id ?? "vehicle-probe",
          count: probe.count ?? 0,
          radiusMeters: probe.radiusMeters ?? 0,
          label: `${vehicleLabel}\n${Math.round(probe.radiusMeters ?? 0)} m`,
        },
      },
    ],
  };
}

export function countRuntimeVehiclesInRadius(runtimeByVehicleId, centerCoordinate, radiusMeters) {
  if (!runtimeByVehicleId || !centerCoordinate || !radiusMeters) {
    return 0;
  }

  let count = 0;
  runtimeByVehicleId.forEach((runtime) => {
    if (
      Array.isArray(runtime?.coordinate) &&
      distanceMeters(centerCoordinate, runtime.coordinate) <= radiusMeters
    ) {
      count += 1;
    }
  });
  return count;
}

export function countVehicleFeaturesInRadius(vehicleFeatures, centerCoordinate, radiusMeters) {
  if (!Array.isArray(vehicleFeatures) || !centerCoordinate || !radiusMeters) {
    return 0;
  }

  return vehicleFeatures.reduce((count, feature) => {
    const coordinate = feature?.geometry?.coordinates;
    return Array.isArray(coordinate) && distanceMeters(centerCoordinate, coordinate) <= radiusMeters
      ? count + 1
      : count;
  }, 0);
}

function createRouteDefinition(
  {
    id,
    startLabel,
    endLabel,
    startCoordinate,
    endCoordinate,
    displayStartCoordinate,
    displayEndCoordinate,
    displayCoordinates,
    driveCoordinates,
    distanceMeters,
    visitedNodes,
  },
  trafficSignalSystem,
) {
  const routeDefinition = {
    id,
    start: { label: startLabel },
    end: { label: endLabel },
    startCoordinate,
    endCoordinate,
    displayStartCoordinate,
    displayEndCoordinate,
    coordinates: displayCoordinates,
    driveCoordinates,
    distanceMeters,
    visitedNodes,
    metrics: buildRouteMetrics(driveCoordinates),
  };

  return annotateRouteTrafficSignals(routeDefinition, trafficSignalSystem);
}

function createVehicle({ id, route, launchDelayMs, color }) {
  return {
    id,
    routeId: route.id,
    route,
    launchDelayMs,
    routeActivatedAtMs: launchDelayMs,
    speedMetersPerMs:
      route.metrics.totalDistanceMeters > 0
        ? route.metrics.totalDistanceMeters / BASE_ROUTE_DURATION_MS
        : 0,
    color,
    targetCoordinate: route.endCoordinate,
    targetLabel: route.end.label,
    displayTargetCoordinate: route.displayEndCoordinate,
    parked: route.metrics.totalDistanceMeters <= 0,
    trailCoordinates: [],
  };
}

function cloneRoute(route, id) {
  return {
    ...route,
    id,
  };
}

function createParkedVehicle(vehicle, coordinate, trailCoordinates) {
  return {
    ...vehicle,
    launchDelayMs: 0,
    routeActivatedAtMs: 0,
    route: createRouteDefinition({
      id: vehicle.routeId,
      startLabel: vehicle.targetLabel,
      endLabel: vehicle.targetLabel,
      startCoordinate: coordinate,
      endCoordinate: coordinate,
      displayStartCoordinate: coordinate,
      displayEndCoordinate: coordinate,
      displayCoordinates: [coordinate],
      driveCoordinates: [coordinate],
      distanceMeters: 0,
      visitedNodes: 0,
    }),
    trailCoordinates,
    parked: true,
  };
}

function buildVisibleRouteCoordinates(vehicle) {
  return mergeCoordinateLists(vehicle.trailCoordinates, vehicle.route?.coordinates ?? []);
}

function buildCurrentSegmentTrailCoordinates(route, runtime) {
  if (!route) {
    return [];
  }

  const routeMetrics = route.metrics;
  const routeLength = routeMetrics?.totalDistanceMeters ?? 0;

  if (!routeMetrics || routeMetrics.path.length === 0) {
    return [];
  }

  if (runtime?.completed) {
    return route.coordinates;
  }

  const distanceMeters = Math.max(0, Math.min(runtime?.distanceMeters ?? 0, routeLength));
  const driveTrailCoordinates = buildDriveTrailCoordinates(
    routeMetrics,
    distanceMeters,
    runtime?.coordinate,
  );

  return mergeCoordinateLists(
    route.displayStartCoordinate ? [route.displayStartCoordinate] : [],
    driveTrailCoordinates,
  );
}

function buildDriveTrailCoordinates(routeMetrics, distanceMeters, currentCoordinate) {
  const { path, cumulativeDistances } = routeMetrics;

  if (path.length === 0) {
    return [];
  }

  const totalDistance = cumulativeDistances[cumulativeDistances.length - 1] ?? 0;
  const clampedDistance = Math.max(0, Math.min(distanceMeters, totalDistance));
  const coordinates = [path[0]];

  if (clampedDistance <= 0) {
    return coordinates;
  }

  for (let index = 1; index < path.length; index += 1) {
    const segmentEndDistance = cumulativeDistances[index] ?? 0;

    if (segmentEndDistance < clampedDistance) {
      coordinates.push(path[index]);
      continue;
    }

    if (segmentEndDistance === clampedDistance) {
      coordinates.push(path[index]);
      return coordinates;
    }

    if (currentCoordinate && !coordinatesEqual(coordinates[coordinates.length - 1], currentCoordinate)) {
      coordinates.push(currentCoordinate);
    }
    return coordinates;
  }

  return coordinates;
}

function mergeCoordinateLists(left = [], right = []) {
  const coordinates = [];

  [...left, ...right].forEach((coordinate) => {
    if (!coordinate) {
      return;
    }

    if (!coordinatesEqual(coordinates[coordinates.length - 1], coordinate)) {
      coordinates.push(coordinate);
    }
  });

  return coordinates;
}

function clamp(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function inferVehicleElapsedMs(vehicle, runtime) {
  const routeActivatedAtMs = vehicle.routeActivatedAtMs ?? vehicle.launchDelayMs ?? 0;

  if ((runtime?.remainingLaunchDelayMs ?? 0) > 0) {
    return Math.max(0, routeActivatedAtMs - (runtime?.remainingLaunchDelayMs ?? 0));
  }

  if (
    Number.isFinite(runtime?.distanceMeters) &&
    Number.isFinite(vehicle?.speedMetersPerMs) &&
    vehicle.speedMetersPerMs > 0
  ) {
    return routeActivatedAtMs + runtime.distanceMeters / vehicle.speedMetersPerMs;
  }

  return routeActivatedAtMs;
}

function buildVehicleRuntimeSnapshot(vehicle, currentElapsedMs) {
  if (!vehicle?.route?.metrics) {
    return null;
  }

  const routeMetrics = vehicle.route.metrics;
  const routeLength = routeMetrics.totalDistanceMeters ?? 0;
  const routeActivatedAtMs = vehicle.routeActivatedAtMs ?? vehicle.launchDelayMs ?? 0;
  const remainingLaunchDelayMs = Math.max(0, routeActivatedAtMs - currentElapsedMs);

  if (remainingLaunchDelayMs > 0) {
    return {
      coordinate: null,
      bearing: 0,
      completed: false,
      distanceMeters: 0,
      remainingLaunchDelayMs,
    };
  }

  const travelTimeMs = Math.max(0, currentElapsedMs - routeActivatedAtMs);
  const distanceMeters = Math.min((vehicle.speedMetersPerMs ?? 0) * travelTimeMs, routeLength);
  const position =
    getPointAtDistance(routeMetrics, distanceMeters) ??
    getPointAtDistance(routeMetrics, 0) ?? {
      coordinates: routeMetrics.path[0] ?? vehicle.targetCoordinate ?? null,
      bearing: 0,
    };

  return {
    coordinate: position.coordinates,
    bearing: position.bearing,
    completed: distanceMeters >= routeLength,
    distanceMeters,
    remainingLaunchDelayMs: 0,
  };
}

function pickRandomRoutableCoordinate(router) {
  const nodeCount = router?.nodeLngs?.length ?? 0;

  if (nodeCount === 0) {
    return null;
  }

  const randomNodeId = Math.floor(Math.random() * nodeCount);
  return router.getNodeCoordinate(randomNodeId);
}

function buildDisplayRouteCoordinates(startCoordinate, driveCoordinates, endCoordinate) {
  const coordinates = [];

  if (startCoordinate) {
    coordinates.push(startCoordinate);
  }

  driveCoordinates.forEach((coordinate) => {
    if (!coordinatesEqual(coordinates[coordinates.length - 1], coordinate)) {
      coordinates.push(coordinate);
    }
  });

  if (endCoordinate && !coordinatesEqual(coordinates[coordinates.length - 1], endCoordinate)) {
    coordinates.push(endCoordinate);
  }

  return coordinates;
}

function findContainingAutomaticHotspot(currentCoordinate, hotspots) {
  if (!currentCoordinate || !Array.isArray(hotspots)) {
    return null;
  }

  const automaticHotspots = hotspots
    .filter(
      (hotspot) =>
        hotspot?.kind === "automatic" &&
        distanceMeters(currentCoordinate, hotspot.coordinate) <= hotspot.radiusMeters,
    )
    .sort(
      (left, right) =>
        distanceMeters(currentCoordinate, left.coordinate) -
        distanceMeters(currentCoordinate, right.coordinate),
    );

  return automaticHotspots[0] ?? null;
}

function buildHotspotCircleCoordinates(center, radiusMeters, stepCount = 48) {
  const coordinates = [];

  for (let step = 0; step <= stepCount; step += 1) {
    const bearing = (step / stepCount) * 360;
    coordinates.push(offsetCoordinate(center, radiusMeters, bearing));
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

function buildHotspotEscapeWaypoint(router, vehicle, currentCoordinate, hotspot) {
  if (!router || !vehicle || !currentCoordinate || !hotspot?.coordinate) {
    return null;
  }

  const targetCoordinate = vehicle.targetCoordinate ?? currentCoordinate;
  const baseBearing = bearingBetween(hotspot.coordinate, targetCoordinate);
  const bearingOffset =
    HOTSPOT_ESCAPE_BEARING_OFFSETS[hashString(vehicle.id) % HOTSPOT_ESCAPE_BEARING_OFFSETS.length];
  const escapeCoordinate = offsetCoordinate(
    hotspot.coordinate,
    hotspot.radiusMeters + HOTSPOT_ESCAPE_PADDING_METERS,
    normalizeBearingDegrees(baseBearing + bearingOffset),
  );

  return router.nearestRoadCoordinate(escapeCoordinate) ?? escapeCoordinate;
}

function distanceMeters(left, right) {
  if (!left || !right) {
    return Number.POSITIVE_INFINITY;
  }

  const earthRadiusMeters = 6371000;
  const [leftLongitude, leftLatitude] = left;
  const [rightLongitude, rightLatitude] = right;
  const deltaLatitude = ((rightLatitude - leftLatitude) * Math.PI) / 180;
  const deltaLongitude = ((rightLongitude - leftLongitude) * Math.PI) / 180;
  const leftLatitudeRadians = (leftLatitude * Math.PI) / 180;
  const rightLatitudeRadians = (rightLatitude * Math.PI) / 180;
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(leftLatitudeRadians) *
      Math.cos(rightLatitudeRadians) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function hashString(value) {
  return [...`${value}`].reduce(
    (hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) >>> 0,
    0,
  );
}

function normalizeBearingDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function coordinatesEqual(left, right) {
  if (!left || !right) {
    return false;
  }

  return left[0] === right[0] && left[1] === right[1];
}
