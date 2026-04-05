import {
  POWER_METRIC_OPTIONS,
  POWER_NETWORK_LINES,
  POWER_NETWORK_NODES,
} from "../data/offlinePower.js";
import { emptyFeatureCollection } from "./navigation.js";

const HOUR_LOAD_PROFILE = [
  0.58, 0.54, 0.52, 0.5, 0.56, 0.68, 0.82, 0.9, 0.95, 0.93, 0.9, 0.88,
  0.89, 0.92, 0.97, 1.02, 1.08, 1.16, 1.22, 1.18, 1.06, 0.92, 0.78, 0.66,
];
const POWER_DEMAND_SCALE = 0.42;
const MIN_SERVICE_VOLTAGE_KV = 44;
const TARGET_VOLTAGE_KV = 66;

const NODE_BY_ID = new Map(POWER_NETWORK_NODES.map((node) => [node.id, node]));
const OUTGOING_LINES_BY_NODE = buildOutgoingLines();
const DISTRICT_NODES = POWER_NETWORK_NODES.filter((node) => node.nodeType === "district");
const SOURCE_NODES = POWER_NETWORK_NODES.filter((node) => node.nodeType === "source");

export { POWER_METRIC_OPTIONS };

export function createEmptyPowerState() {
  return {
    lines: emptyFeatureCollection(),
    zones: emptyFeatureCollection(),
    nodes: emptyFeatureCollection(),
    districts: [],
    summary: null,
  };
}

export function describePowerMetric(metric, rawValue) {
  return metricDescriptor(metric, rawValue);
}

export function simulatePowerNetwork({ hour, metric, incidents = [] }) {
  const simulationHour = clampHour(hour);
  const demandFactor = HOUR_LOAD_PROFILE[simulationHour] ?? 1;
  const localDemandByNodeId = new Map(
    DISTRICT_NODES.map((node) => [
      node.id,
      (node.baseDemandMW ?? 0) * POWER_DEMAND_SCALE * demandFactor * (node.demandWeight ?? 1),
    ]),
  );
  const downstreamDemandByNodeId = new Map();
  const nodeVoltageById = new Map();
  const nodeSupplyRatioById = new Map();
  const lineStateById = new Map();

  SOURCE_NODES.forEach((source) => {
    const sourceDemand = computeDownstreamDemand(
      source.id,
      localDemandByNodeId,
      downstreamDemandByNodeId,
    );
    const sourceLoadRatio = source.maxOutputMW > 0 ? sourceDemand / source.maxOutputMW : 0;
    const sourceVoltageKV = Math.max(
      source.sourceVoltageKV * 0.72,
      (source.sourceVoltageKV ?? 400) - Math.max(0, sourceLoadRatio - 0.78) * 55,
    );
    const sourceAdequacy = sourceLoadRatio <= 1 ? 1 : 1 / sourceLoadRatio;

    nodeVoltageById.set(source.id, sourceVoltageKV);
    nodeSupplyRatioById.set(source.id, sourceAdequacy);
    traversePowerNetwork({
      nodeId: source.id,
      upstreamVoltageKV: sourceVoltageKV,
      pathAdequacy: sourceAdequacy,
      localDemandByNodeId,
      downstreamDemandByNodeId,
      nodeVoltageById,
      nodeSupplyRatioById,
      lineStateById,
    });
  });

  const incidentImpactByDistrictId = buildIncidentImpactByDistrictId(incidents);
  applyIncidentImpactToPowerState({
    incidentImpactByDistrictId,
    nodeVoltageById,
    nodeSupplyRatioById,
  });

  const districtStateById = buildDistrictStates({
    localDemandByNodeId,
    nodeVoltageById,
    nodeSupplyRatioById,
    incidentImpactByDistrictId,
  });
  const lineFeatures = buildLineFeatures(lineStateById, districtStateById, metric);
  const zoneFeatures = buildZoneFeatures(districtStateById, metric);
  const nodeFeatures = buildNodeFeatures({
    nodeVoltageById,
    nodeSupplyRatioById,
    downstreamDemandByNodeId,
    metric,
  });
  const summary = buildPowerSummary(districtStateById, lineStateById, simulationHour);

  return {
    lines:
      lineFeatures.length > 0
        ? { type: "FeatureCollection", features: lineFeatures }
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

function buildOutgoingLines() {
  const outgoingLinesByNode = new Map();

  POWER_NETWORK_LINES.forEach((line) => {
    const lines = outgoingLinesByNode.get(line.from) ?? [];
    lines.push(line);
    outgoingLinesByNode.set(line.from, lines);
  });

  return outgoingLinesByNode;
}

function computeDownstreamDemand(nodeId, localDemandByNodeId, downstreamDemandByNodeId) {
  if (downstreamDemandByNodeId.has(nodeId)) {
    return downstreamDemandByNodeId.get(nodeId);
  }

  const localDemand = localDemandByNodeId.get(nodeId) ?? 0;
  const outgoingLines = OUTGOING_LINES_BY_NODE.get(nodeId) ?? [];
  const childDemand = outgoingLines.reduce(
    (totalDemand, line) =>
      totalDemand + computeDownstreamDemand(line.to, localDemandByNodeId, downstreamDemandByNodeId),
    0,
  );
  const downstreamDemand = localDemand + childDemand;

  downstreamDemandByNodeId.set(nodeId, downstreamDemand);
  return downstreamDemand;
}

function traversePowerNetwork({
  nodeId,
  upstreamVoltageKV,
  pathAdequacy,
  localDemandByNodeId,
  downstreamDemandByNodeId,
  nodeVoltageById,
  nodeSupplyRatioById,
  lineStateById,
}) {
  const outgoingLines = OUTGOING_LINES_BY_NODE.get(nodeId) ?? [];

  outgoingLines.forEach((line) => {
    const childNode = NODE_BY_ID.get(line.to);
    const flowMW = downstreamDemandByNodeId.get(line.to) ?? 0;
    const effectiveCapacityMW = (line.capacityMW ?? 0) * 3.2;
    const utilization = effectiveCapacityMW > 0 ? flowMW / effectiveCapacityMW : 0;
    const displayUtilization = line.capacityMW > 0 ? flowMW / line.capacityMW : 0;
    const voltagePenalty = clamp(110 / (line.nominalVoltageKV ?? 110), 0.24, 1.25);
    const staticDropKV = line.lengthKm * (0.08 + 0.14 * voltagePenalty);
    const loadDropKV = Math.pow(Math.max(utilization, 0), 1.65) * (5.5 * voltagePenalty);
    const targetVoltageKV =
      childNode?.nodeType === "substation"
        ? childNode.nominalVoltageKV ?? line.nominalVoltageKV ?? upstreamVoltageKV
        : childNode?.nodeType === "district"
          ? line.nominalVoltageKV ?? childNode.nominalVoltageKV ?? 66
          : line.nominalVoltageKV ?? upstreamVoltageKV;
    const deliveredBaseVoltageKV = Math.min(upstreamVoltageKV, targetVoltageKV);
    const transformDropKV =
      childNode?.nodeType === "substation"
        ? deliveredBaseVoltageKV * ((childNode.transformLossPercent ?? 1.5) / 100)
        : 0;
    const childVoltageKV = Math.max(
      childNode?.nodeType === "district" ? 6.6 : 11,
      deliveredBaseVoltageKV - staticDropKV - loadDropKV - transformDropKV,
    );
    const capacityAdequacy = utilization <= 1 ? 1 : 1 / utilization;
    const childPathAdequacy = Math.min(pathAdequacy, capacityAdequacy);

    nodeVoltageById.set(line.to, childVoltageKV);
    nodeSupplyRatioById.set(line.to, childPathAdequacy);
    lineStateById.set(line.id, {
      ...line,
      voltageKV: childVoltageKV,
      flowMW,
      utilizationPercent: Math.min(displayUtilization * 100, 175),
      supplyPercent: childPathAdequacy * 100,
    });

    traversePowerNetwork({
      nodeId: line.to,
      upstreamVoltageKV: childVoltageKV,
      pathAdequacy: childPathAdequacy,
      localDemandByNodeId,
      downstreamDemandByNodeId,
      nodeVoltageById,
      nodeSupplyRatioById,
      lineStateById,
    });
  });
}

function buildIncidentImpactByDistrictId(incidents) {
  const incidentImpactByDistrictId = new Map();
  const incidentList = Array.isArray(incidents) ? incidents : incidents ? [incidents] : [];

  incidentList.forEach((incident) => {
    if (!incident?.coordinate) {
      return;
    }

    const impactRadiusMeters = incident.impactRadiusMeters ?? 3200;
    const incidentWeight = incident.type === "substationOutage" ? 1.32 : 1;
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

      const severity = clamp((1 - distance / impactRadiusMeters) * incidentWeight, 0.2, 1);
      const currentImpact = incidentImpactByDistrictId.get(districtNode.id);

      incidentImpactByDistrictId.set(districtNode.id, {
        distanceMeters: Math.min(currentImpact?.distanceMeters ?? Number.POSITIVE_INFINITY, distance),
        severity: clamp((currentImpact?.severity ?? 0) + severity, 0, 1),
      });
    });

    if (nearestDistrict && !incidentImpactByDistrictId.has(nearestDistrict.id)) {
      incidentImpactByDistrictId.set(nearestDistrict.id, {
        distanceMeters: nearestDistanceMeters,
        severity: incident.type === "substationOutage" ? 0.82 : 0.58,
      });
    }
  });

  return incidentImpactByDistrictId;
}

function applyIncidentImpactToPowerState({
  incidentImpactByDistrictId,
  nodeVoltageById,
  nodeSupplyRatioById,
}) {
  incidentImpactByDistrictId.forEach((impact, districtId) => {
    const currentVoltage = nodeVoltageById.get(districtId) ?? TARGET_VOLTAGE_KV;
    const currentSupplyRatio = nodeSupplyRatioById.get(districtId) ?? 1;
    const voltageDropKV = 10 + impact.severity * 48;
    const supplyPenalty = 0.24 + impact.severity * 0.56;

    nodeVoltageById.set(districtId, Math.max(3.3, currentVoltage - voltageDropKV));
    nodeSupplyRatioById.set(districtId, Math.max(0.14, currentSupplyRatio * (1 - supplyPenalty)));
  });
}

function buildDistrictStates({
  localDemandByNodeId,
  nodeVoltageById,
  nodeSupplyRatioById,
  incidentImpactByDistrictId,
}) {
  const districtStateById = new Map();

  DISTRICT_NODES.forEach((districtNode) => {
    const demandMW = localDemandByNodeId.get(districtNode.id) ?? 0;
    const voltageKV = nodeVoltageById.get(districtNode.id) ?? 0;
    const adequacyRatio = nodeSupplyRatioById.get(districtNode.id) ?? 0;
    const incidentImpact = incidentImpactByDistrictId.get(districtNode.id);
    const voltageScore = clamp(
      (voltageKV - MIN_SERVICE_VOLTAGE_KV) / (TARGET_VOLTAGE_KV - MIN_SERVICE_VOLTAGE_KV),
      0,
      1,
    );
    const supplyRatio = clamp(adequacyRatio * (0.42 + voltageScore * 0.58), 0, 1);
    const servedMW = demandMW * supplyRatio;

    districtStateById.set(districtNode.id, {
      ...districtNode,
      voltageKV,
      demandMW,
      servedMW,
      shortfallMW: Math.max(0, demandMW - servedMW),
      supplyPercent: supplyRatio * 100,
      incidentDistanceMeters: incidentImpact?.distanceMeters ?? null,
      incidentSeverity: incidentImpact?.severity ?? 0,
      isIncidentAffected: Boolean(incidentImpact),
      stressed:
        supplyRatio * 100 < 88 ||
        voltageKV < MIN_SERVICE_VOLTAGE_KV ||
        (incidentImpact?.severity ?? 0) >= 0.24,
    });
  });

  return districtStateById;
}

function buildLineFeatures(lineStateById, districtStateById, metric) {
  return POWER_NETWORK_LINES.map((line) => {
    const lineState = lineStateById.get(line.id);

    if (!lineState) {
      return null;
    }

    const fromNode = NODE_BY_ID.get(line.from);
    const toNode = NODE_BY_ID.get(line.to);
    const districtState = districtStateById.get(line.to);
    const metricState =
      metric === "voltage"
        ? metricDescriptor(metric, lineState.voltageKV)
        : metric === "load"
          ? metricDescriptor(metric, lineState.flowMW)
          : metric === "supply"
            ? metricDescriptor(metric, districtState?.supplyPercent ?? lineState.supplyPercent)
            : metricDescriptor(metric, lineState.utilizationPercent);

    return {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [fromNode.coordinate, toNode.coordinate],
      },
      properties: {
        id: line.id,
        label: line.label,
        nominalVoltageKV: line.nominalVoltageKV,
        capacityMW: line.capacityMW,
        flowMW: roundValue(lineState.flowMW, 1),
        voltageKV: roundValue(lineState.voltageKV, 1),
        utilizationPercent: roundValue(lineState.utilizationPercent, 1),
        supplyPercent: roundValue(districtState?.supplyPercent ?? lineState.supplyPercent, 1),
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
      metric === "voltage"
        ? metricDescriptor(metric, districtState.voltageKV)
        : metric === "load"
          ? metricDescriptor(metric, districtState.servedMW)
          : metric === "supply"
            ? metricDescriptor(metric, districtState.supplyPercent)
            : metricDescriptor(
                metric,
                districtState.shortfallMW > 0 ? 100 - districtState.supplyPercent : 0,
              );

    return {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [buildZonePolygon(districtNode.coordinate, districtNode.zoneRadiusMeters ?? 2400)],
      },
      properties: {
        id: districtNode.id,
        label: districtNode.label,
        demandMW: roundValue(districtState.demandMW, 1),
        servedMW: roundValue(districtState.servedMW, 1),
        shortfallMW: roundValue(districtState.shortfallMW, 1),
        voltageKV: roundValue(districtState.voltageKV, 1),
        supplyPercent: roundValue(districtState.supplyPercent, 1),
        isIncidentAffected: districtState.isIncidentAffected ? 1 : 0,
        incidentSeverity: roundValue(districtState.incidentSeverity, 2),
        metricValue: metricState.value,
        metricLabel: metricState.label,
        metricColor: metricState.color,
      },
    };
  }).filter(Boolean);
}

function buildNodeFeatures({
  nodeVoltageById,
  nodeSupplyRatioById,
  downstreamDemandByNodeId,
  metric,
}) {
  return POWER_NETWORK_NODES.map((node) => {
    const voltageKV = nodeVoltageById.get(node.id) ?? node.sourceVoltageKV ?? node.nominalVoltageKV ?? 0;
    const supplyPercent = (nodeSupplyRatioById.get(node.id) ?? 1) * 100;
    const downstreamDemand = downstreamDemandByNodeId.get(node.id) ?? 0;
    const metricSourceValue =
      metric === "voltage"
        ? voltageKV
        : metric === "load"
          ? downstreamDemand
          : metric === "supply"
            ? supplyPercent
            : Math.max(0, 100 - supplyPercent);
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
        voltageKV: roundValue(voltageKV, 1),
        supplyPercent: roundValue(supplyPercent, 1),
        downstreamDemandMW: roundValue(downstreamDemand, 1),
        metricValue: metricState.value,
        metricLabel: metricState.label,
        metricColor: metricState.color,
      },
    };
  });
}

function buildPowerSummary(districtStateById, lineStateById, hour) {
  const districtStates = [...districtStateById.values()];
  const lineStates = [...lineStateById.values()];
  const totalDemandMW = districtStates.reduce((sum, district) => sum + district.demandMW, 0);
  const servedMW = districtStates.reduce((sum, district) => sum + district.servedMW, 0);
  const averageVoltageKV =
    districtStates.length > 0
      ? districtStates.reduce((sum, district) => sum + district.voltageKV, 0) / districtStates.length
      : 0;
  const stressedZoneCount = districtStates.filter((district) => district.stressed).length;
  const peakLineUtilizationPercent =
    lineStates.length > 0
      ? lineStates.reduce(
          (maxValue, lineState) => Math.max(maxValue, lineState.utilizationPercent),
          0,
        )
      : 0;

  return {
    hour,
    totalDemandMW: roundValue(totalDemandMW, 1),
    servedMW: roundValue(servedMW, 1),
    averageVoltageKV: roundValue(averageVoltageKV, 1),
    stressedZoneCount,
    peakLineUtilizationPercent: roundValue(peakLineUtilizationPercent, 1),
  };
}

function metricDescriptor(metric, rawValue) {
  if (metric === "voltage") {
    return {
      value: roundValue(rawValue, 1),
      label: `${roundValue(rawValue, 0)} kV`,
      color: colorFromStops(rawValue, [
        [0, "#7f1d1d"],
        [28, "#dc2626"],
        [55, "#f59e0b"],
        [80, "#facc15"],
        [110, "#14b8a6"],
        [180, "#0f766e"],
        [260, "#155e75"],
      ]),
    };
  }

  if (metric === "load") {
    return {
      value: roundValue(rawValue, 1),
      label: `${roundValue(rawValue, 0)} MW`,
      color: colorFromStops(rawValue, [
        [0, "#e0f2fe"],
        [140, "#7dd3fc"],
        [260, "#38bdf8"],
        [380, "#0284c7"],
        [520, "#075985"],
      ]),
    };
  }

  if (metric === "supply") {
    return {
      value: roundValue(rawValue, 1),
      label: `${roundValue(rawValue, 0)}%`,
      color: colorFromStops(rawValue, [
        [0, "#991b1b"],
        [55, "#dc2626"],
        [75, "#f59e0b"],
        [90, "#14b8a6"],
        [100, "#0f766e"],
      ]),
    };
  }

  return {
    value: roundValue(rawValue, 1),
    label: `${roundValue(rawValue, 0)}%`,
    color: colorFromStops(rawValue, [
      [0, "#e0f2fe"],
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
