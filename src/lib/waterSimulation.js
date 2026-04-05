import {
  WATER_METRIC_OPTIONS,
  WATER_NETWORK_NODES,
  WATER_NETWORK_PIPES,
} from "../data/offlineWater.js";
import { emptyFeatureCollection } from "./navigation.js";

const HOUR_DEMAND_PROFILE = [
  0.56, 0.54, 0.52, 0.5, 0.58, 0.72, 0.87, 1, 1.08, 0.96, 0.9, 0.86,
  0.84, 0.83, 0.84, 0.9, 0.98, 1.06, 1.12, 1.08, 0.96, 0.82, 0.7, 0.62,
];
const MIN_SERVICE_PRESSURE_M = 18;
const TARGET_PRESSURE_M = 38;

const NODE_BY_ID = new Map(WATER_NETWORK_NODES.map((node) => [node.id, node]));
const OUTGOING_PIPES_BY_NODE = buildOutgoingPipes();
const DISTRICT_NODES = WATER_NETWORK_NODES.filter((node) => node.nodeType === "district");
const SOURCE_NODES = WATER_NETWORK_NODES.filter((node) => node.nodeType === "source");

export { WATER_METRIC_OPTIONS };

export function describeWaterMetric(metric, rawValue) {
  return metricDescriptor(metric, rawValue);
}

export function createEmptyWaterState() {
  return {
    pipes: emptyFeatureCollection(),
    zones: emptyFeatureCollection(),
    nodes: emptyFeatureCollection(),
    districts: [],
    summary: null,
  };
}

export function simulateWaterNetwork({ hour, metric, incidents = [] }) {
  const simulationHour = clampHour(hour);
  const demandFactor = HOUR_DEMAND_PROFILE[simulationHour] ?? 1;
  const localDemandByNodeId = new Map(
    DISTRICT_NODES.map((node) => [
      node.id,
      (node.baseDemandMLD ?? 0) * demandFactor * (node.demandWeight ?? 1),
    ]),
  );
  const downstreamDemandByNodeId = new Map();
  const nodePressureById = new Map();
  const nodeSupplyRatioById = new Map();
  const dynamicTankStorageById = new Map();
  const pipeStateById = new Map();

  SOURCE_NODES.forEach((source) => {
    const sourceDemand = computeDownstreamDemand(
      source.id,
      localDemandByNodeId,
      downstreamDemandByNodeId,
    );
    const sourceLoadRatio =
      source.maxOutputMLD > 0 ? sourceDemand / source.maxOutputMLD : 0;
    const sourcePressure = Math.max(44, (source.headM ?? 72) - Math.max(0, sourceLoadRatio - 0.75) * 12);
    const sourceAdequacy = sourceLoadRatio <= 1 ? 1 : 1 / sourceLoadRatio;

    nodePressureById.set(source.id, sourcePressure);
    nodeSupplyRatioById.set(source.id, sourceAdequacy);
    traverseWaterNetwork({
      nodeId: source.id,
      upstreamPressureM: sourcePressure,
      pathAdequacy: sourceAdequacy,
      localDemandByNodeId,
      downstreamDemandByNodeId,
      nodePressureById,
      nodeSupplyRatioById,
      pipeStateById,
      dynamicTankStorageById,
      demandFactor,
    });
  });

  const incidentImpactByDistrictId = buildIncidentImpactByDistrictId(incidents);
  applyIncidentImpactToNetworkState({
    incidentImpactByDistrictId,
    nodePressureById,
    nodeSupplyRatioById,
  });

  const districtStateById = buildDistrictStates({
    localDemandByNodeId,
    nodePressureById,
    nodeSupplyRatioById,
    incidentImpactByDistrictId,
  });
  const pipeFeatures = buildPipeFeatures(pipeStateById, districtStateById, metric);
  const zoneFeatures = buildZoneFeatures(districtStateById, metric);
  const nodeFeatures = buildNodeFeatures({
    nodePressureById,
    nodeSupplyRatioById,
    dynamicTankStorageById,
    downstreamDemandByNodeId,
    metric,
  });
  const summary = buildWaterSummary(districtStateById, pipeStateById, simulationHour);

  return {
    pipes:
      pipeFeatures.length > 0
        ? { type: "FeatureCollection", features: pipeFeatures }
        : emptyFeatureCollection(),
    zones:
      zoneFeatures.length > 0
        ? { type: "FeatureCollection", features: zoneFeatures }
        : emptyFeatureCollection(),
    nodes:
      nodeFeatures.length > 0
        ? { type: "FeatureCollection", features: nodeFeatures }
        : emptyFeatureCollection(),
    districts: [...districtStateById.values()],
    summary,
  };
}

function buildOutgoingPipes() {
  const outgoingPipesByNode = new Map();

  WATER_NETWORK_PIPES.forEach((pipe) => {
    const pipes = outgoingPipesByNode.get(pipe.from) ?? [];
    pipes.push(pipe);
    outgoingPipesByNode.set(pipe.from, pipes);
  });

  return outgoingPipesByNode;
}

function computeDownstreamDemand(nodeId, localDemandByNodeId, downstreamDemandByNodeId) {
  if (downstreamDemandByNodeId.has(nodeId)) {
    return downstreamDemandByNodeId.get(nodeId);
  }

  const localDemand = localDemandByNodeId.get(nodeId) ?? 0;
  const outgoingPipes = OUTGOING_PIPES_BY_NODE.get(nodeId) ?? [];
  const childDemand = outgoingPipes.reduce(
    (totalDemand, pipe) =>
      totalDemand + computeDownstreamDemand(pipe.to, localDemandByNodeId, downstreamDemandByNodeId),
    0,
  );
  const downstreamDemand = localDemand + childDemand;

  downstreamDemandByNodeId.set(nodeId, downstreamDemand);
  return downstreamDemand;
}

function traverseWaterNetwork({
  nodeId,
  upstreamPressureM,
  pathAdequacy,
  localDemandByNodeId,
  downstreamDemandByNodeId,
  nodePressureById,
  nodeSupplyRatioById,
  pipeStateById,
  dynamicTankStorageById,
  demandFactor,
}) {
  const outgoingPipes = OUTGOING_PIPES_BY_NODE.get(nodeId) ?? [];

  outgoingPipes.forEach((pipe) => {
    const childNode = NODE_BY_ID.get(pipe.to);
    const flowMLD = downstreamDemandByNodeId.get(pipe.to) ?? 0;
    const utilization = pipe.capacityMLD > 0 ? flowMLD / pipe.capacityMLD : 0;
    const diameterPenalty = clamp(1250 / (pipe.diameterMm ?? 800), 0.7, 2);
    const staticLoss = pipe.lengthKm * (1 + 0.35 * diameterPenalty);
    const flowLoss = Math.pow(Math.max(utilization, 0), 1.7) * 16;
    const boostM = childNode?.nodeType === "pump" ? childNode.boostM ?? 0 : 0;
    const storagePct = computeTankStoragePercent(childNode, demandFactor, utilization);
    const storageBoostM =
      childNode?.nodeType === "tank" ? (storagePct - 65) * 0.08 : 0;
    const childPressureM = Math.max(
      4,
      upstreamPressureM - staticLoss - flowLoss + boostM + storageBoostM,
    );
    const capacityAdequacy = utilization <= 1 ? 1 : 1 / utilization;
    const childPathAdequacy = Math.min(pathAdequacy, capacityAdequacy);

    nodePressureById.set(pipe.to, childPressureM);
    nodeSupplyRatioById.set(pipe.to, childPathAdequacy);

    if (childNode?.nodeType === "tank") {
      dynamicTankStorageById.set(pipe.to, storagePct);
    }

    pipeStateById.set(pipe.id, {
      ...pipe,
      pressureM: childPressureM,
      flowMLD,
      utilizationPercent: Math.min(utilization * 100, 160),
      supplyPercent: childPathAdequacy * 100,
    });

    traverseWaterNetwork({
      nodeId: pipe.to,
      upstreamPressureM: childPressureM,
      pathAdequacy: childPathAdequacy,
      localDemandByNodeId,
      downstreamDemandByNodeId,
      nodePressureById,
      nodeSupplyRatioById,
      pipeStateById,
      dynamicTankStorageById,
      demandFactor,
    });
  });
}

function computeTankStoragePercent(node, demandFactor, utilization) {
  if (!node || node.nodeType !== "tank") {
    return 0;
  }

  const baseStorage = node.storagePct ?? 72;
  return clamp(baseStorage - Math.max(0, demandFactor - 0.8) * 18 - Math.max(0, utilization - 0.8) * 12, 32, 94);
}

function buildIncidentImpactByDistrictId(incidents) {
  const incidentImpactByDistrictId = new Map();
  const incidentList = Array.isArray(incidents) ? incidents : incidents ? [incidents] : [];

  incidentList.forEach((incident) => {
    if (!incident?.coordinate) {
      return;
    }

    const impactRadiusMeters = incident.impactRadiusMeters ?? 3800;
    const incidentWeight = incident.type === "reservoirFailure" ? 1.22 : 1;
    let nearestDistrict = null;
    let nearestDistanceMeters = Number.POSITIVE_INFINITY;

    DISTRICT_NODES.forEach((districtNode) => {
      const distance = distanceMeters(incident.coordinate, districtNode.coordinate);

      if (distance < nearestDistanceMeters) {
        nearestDistrict = districtNode;
        nearestDistanceMeters = distance;
      }

      if (distance > impactRadiusMeters) {
        return;
      }

      const severity = clamp((1 - distance / impactRadiusMeters) * incidentWeight, 0.18, 1);
      const currentImpact = incidentImpactByDistrictId.get(districtNode.id);

      incidentImpactByDistrictId.set(districtNode.id, {
        distanceMeters: Math.min(currentImpact?.distanceMeters ?? Number.POSITIVE_INFINITY, distance),
        severity: clamp((currentImpact?.severity ?? 0) + severity, 0, 1),
      });
    });

    if (nearestDistrict && !incidentImpactByDistrictId.has(nearestDistrict.id)) {
      incidentImpactByDistrictId.set(nearestDistrict.id, {
        distanceMeters: nearestDistanceMeters,
        severity: incident.type === "reservoirFailure" ? 0.78 : 0.55,
      });
    }
  });

  return incidentImpactByDistrictId;
}

function applyIncidentImpactToNetworkState({
  incidentImpactByDistrictId,
  nodePressureById,
  nodeSupplyRatioById,
}) {
  incidentImpactByDistrictId.forEach((impact, districtId) => {
    const currentPressure = nodePressureById.get(districtId) ?? TARGET_PRESSURE_M;
    const currentSupplyRatio = nodeSupplyRatioById.get(districtId) ?? 1;
    const pressureDrop = 6 + impact.severity * 18;
    const supplyPenalty = 0.2 + impact.severity * 0.52;

    nodePressureById.set(districtId, Math.max(4, currentPressure - pressureDrop));
    nodeSupplyRatioById.set(districtId, Math.max(0.16, currentSupplyRatio * (1 - supplyPenalty)));
  });
}

function buildDistrictStates({
  localDemandByNodeId,
  nodePressureById,
  nodeSupplyRatioById,
  incidentImpactByDistrictId,
}) {
  const districtStateById = new Map();

  DISTRICT_NODES.forEach((districtNode) => {
    const demandMLD = localDemandByNodeId.get(districtNode.id) ?? 0;
    const pressureM = nodePressureById.get(districtNode.id) ?? 0;
    const adequacyRatio = nodeSupplyRatioById.get(districtNode.id) ?? 0;
    const breakImpact = incidentImpactByDistrictId.get(districtNode.id);
    const pressureScore = clamp((pressureM - MIN_SERVICE_PRESSURE_M) / (TARGET_PRESSURE_M - MIN_SERVICE_PRESSURE_M), 0, 1);
    const supplyRatio = clamp(adequacyRatio * (0.45 + pressureScore * 0.55), 0, 1);
    const servedMLD = demandMLD * supplyRatio;

    districtStateById.set(districtNode.id, {
      ...districtNode,
      pressureM,
      demandMLD,
      servedMLD,
      shortfallMLD: Math.max(0, demandMLD - servedMLD),
      supplyPercent: supplyRatio * 100,
      breakDistanceMeters: breakImpact?.distanceMeters ?? null,
      breakSeverity: breakImpact?.severity ?? 0,
      isBreakAffected: Boolean(breakImpact),
      stressed:
        supplyRatio * 100 < 85 ||
        pressureM < MIN_SERVICE_PRESSURE_M ||
        (breakImpact?.severity ?? 0) >= 0.25,
    });
  });

  return districtStateById;
}

function buildPipeFeatures(pipeStateById, districtStateById, metric) {
  return WATER_NETWORK_PIPES.map((pipe) => {
    const pipeState = pipeStateById.get(pipe.id);

    if (!pipeState) {
      return null;
    }

    const fromNode = NODE_BY_ID.get(pipe.from);
    const toNode = NODE_BY_ID.get(pipe.to);
    const districtState = districtStateById.get(pipe.to);
    const metricState =
      metric === "pressure"
        ? metricDescriptor(metric, pipeState.pressureM)
        : metric === "flow"
          ? metricDescriptor(metric, pipeState.flowMLD)
          : metric === "supply"
            ? metricDescriptor(metric, districtState?.supplyPercent ?? pipeState.supplyPercent)
            : metricDescriptor(metric, pipeState.utilizationPercent);

    return {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [fromNode.coordinate, toNode.coordinate],
      },
      properties: {
        id: pipe.id,
        label: pipe.label,
        diameterMm: pipe.diameterMm,
        capacityMLD: pipe.capacityMLD,
        flowMLD: roundValue(pipeState.flowMLD, 1),
        pressureM: roundValue(pipeState.pressureM, 1),
        utilizationPercent: roundValue(pipeState.utilizationPercent, 1),
        supplyPercent: roundValue(districtState?.supplyPercent ?? pipeState.supplyPercent, 1),
        metricValue: metricState.value,
        metricLabel: metricState.label,
        metricColor: metricState.color,
      },
    };
  }).filter(Boolean);
}

function buildZoneFeatures(districtStateById, metric) {
  return DISTRICT_NODES.map((districtNode) => {
    const districtState = districtStateById.get(districtNode.id);

    if (!districtState) {
      return null;
    }

    const metricState =
      metric === "pressure"
        ? metricDescriptor(metric, districtState.pressureM)
        : metric === "flow"
          ? metricDescriptor(metric, districtState.servedMLD)
          : metric === "supply"
            ? metricDescriptor(metric, districtState.supplyPercent)
            : metricDescriptor(metric, districtState.shortfallMLD > 0 ? 100 - districtState.supplyPercent : 0);

    return {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [buildZonePolygon(districtNode.coordinate, districtNode.zoneRadiusMeters ?? 2400)],
      },
      properties: {
        id: districtNode.id,
        label: districtNode.label,
        demandMLD: roundValue(districtState.demandMLD, 1),
        servedMLD: roundValue(districtState.servedMLD, 1),
        shortfallMLD: roundValue(districtState.shortfallMLD, 1),
        pressureM: roundValue(districtState.pressureM, 1),
        supplyPercent: roundValue(districtState.supplyPercent, 1),
        isBreakAffected: districtState.isBreakAffected ? 1 : 0,
        breakSeverity: roundValue(districtState.breakSeverity, 2),
        metricValue: metricState.value,
        metricLabel: metricState.label,
        metricColor: metricState.color,
      },
    };
  }).filter(Boolean);
}

function buildNodeFeatures({
  nodePressureById,
  nodeSupplyRatioById,
  dynamicTankStorageById,
  downstreamDemandByNodeId,
  metric,
}) {
  return WATER_NETWORK_NODES.map((node) => {
    const pressureM = nodePressureById.get(node.id) ?? node.headM ?? 0;
    const supplyPercent = (nodeSupplyRatioById.get(node.id) ?? 1) * 100;
    const storagePct = dynamicTankStorageById.get(node.id) ?? node.storagePct ?? null;
    const downstreamDemand = downstreamDemandByNodeId.get(node.id) ?? 0;
    const metricSourceValue =
      metric === "pressure"
        ? pressureM
        : metric === "flow"
          ? downstreamDemand
          : metric === "supply"
            ? supplyPercent
            : storagePct ?? 0;
    const metricState = metricDescriptor(metric, metricSourceValue);

    return {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: node.coordinate,
      },
      properties: {
        id: node.id,
        label: node.label,
        nodeType: node.nodeType,
        showLabel: node.nodeType !== "district",
        pressureM: roundValue(pressureM, 1),
        supplyPercent: roundValue(supplyPercent, 1),
        downstreamDemandMLD: roundValue(downstreamDemand, 1),
        storagePct: storagePct === null ? null : roundValue(storagePct, 1),
        isBreakAffected:
          node.nodeType === "district" && (nodeSupplyRatioById.get(node.id) ?? 1) < 0.9 ? 1 : 0,
        metricValue: metricState.value,
        metricLabel: metricState.label,
        metricColor: metricState.color,
      },
    };
  });
}

function buildWaterSummary(districtStateById, pipeStateById, hour) {
  const districtStates = [...districtStateById.values()];
  const pipeStates = [...pipeStateById.values()];
  const totalDemandMLD = districtStates.reduce((sum, district) => sum + district.demandMLD, 0);
  const servedMLD = districtStates.reduce((sum, district) => sum + district.servedMLD, 0);
  const averagePressureM =
    districtStates.length > 0
      ? districtStates.reduce((sum, district) => sum + district.pressureM, 0) / districtStates.length
      : 0;
  const stressedZoneCount = districtStates.filter(
    (district) => district.stressed,
  ).length;
  const breakAffectedZoneCount = districtStates.filter((district) => district.isBreakAffected).length;
  const peakPipeUtilizationPercent =
    pipeStates.length > 0
      ? pipeStates.reduce((maxValue, pipeState) => Math.max(maxValue, pipeState.utilizationPercent), 0)
      : 0;

  return {
    hour,
    totalDemandMLD: roundValue(totalDemandMLD, 1),
    servedMLD: roundValue(servedMLD, 1),
    averagePressureM: roundValue(averagePressureM, 1),
    stressedZoneCount,
    breakAffectedZoneCount,
    peakPipeUtilizationPercent: roundValue(peakPipeUtilizationPercent, 1),
  };
}

function metricDescriptor(metric, rawValue) {
  if (metric === "pressure") {
    return {
      value: roundValue(rawValue, 1),
      label: `${roundValue(rawValue, 0)} m`,
      color: colorFromStops(rawValue, [
        [0, "#e0f2fe"],
        [12, "#bae6fd"],
        [20, "#7dd3fc"],
        [28, "#38bdf8"],
        [36, "#2563eb"],
        [44, "#1d4ed8"],
        [52, "#1e3a8a"],
      ]),
    };
  }

  if (metric === "flow") {
    return {
      value: roundValue(rawValue, 1),
      label: `${roundValue(rawValue, 0)} MLD`,
      color: colorFromStops(rawValue, [
        [0, "#dbeafe"],
        [20, "#93c5fd"],
        [40, "#38bdf8"],
        [60, "#0284c7"],
        [80, "#075985"],
      ]),
    };
  }

  if (metric === "supply") {
    return {
      value: roundValue(rawValue, 1),
      label: `${roundValue(rawValue, 0)}%`,
      color: colorFromStops(rawValue, [
        [0, "#991b1b"],
        [55, "#ea580c"],
        [75, "#eab308"],
        [90, "#0ea5e9"],
        [100, "#1d4ed8"],
      ]),
    };
  }

  return {
    value: roundValue(rawValue, 1),
    label: `${roundValue(rawValue, 0)}%`,
    color: colorFromStops(rawValue, [
      [0, "#dbeafe"],
      [55, "#38bdf8"],
      [75, "#facc15"],
      [90, "#f97316"],
      [110, "#b91c1c"],
    ]),
  };
}

function buildZonePolygon(center, radiusMeters, steps = 20) {
  const coordinates = [];

  for (let step = 0; step <= steps; step += 1) {
    coordinates.push(offsetCoordinate(center, radiusMeters, (step / steps) * 360));
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

function colorFromStops(value, stops) {
  const nextValue = Number.isFinite(value) ? value : 0;

  for (let index = 0; index < stops.length; index += 1) {
    if (nextValue <= stops[index][0]) {
      return stops[index][1];
    }
  }

  return stops[stops.length - 1][1];
}

function roundValue(value, precision) {
  const factor = 10 ** precision;
  return Math.round((value ?? 0) * factor) / factor;
}

function clamp(value, minValue, maxValue) {
  return Math.min(maxValue, Math.max(minValue, value));
}

function clampHour(value) {
  return clamp(Number.parseInt(value, 10) || 0, 0, 23);
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
