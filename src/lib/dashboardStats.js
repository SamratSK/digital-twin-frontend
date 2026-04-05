function safeFeatures(collection) {
  return Array.isArray(collection?.features) ? collection.features : [];
}

function roundValue(value, digits = 1) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Number(numericValue.toFixed(digits));
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countCivicAssets(civicFeatures) {
  return civicFeatures.reduce(
    (counts, feature) => {
      const assetType = feature?.properties?.assetType;

      if (assetType === "hospital") {
        counts.hospitals += 1;
      } else if (assetType === "police_station") {
        counts.policeStations += 1;
      } else if (assetType === "fire_station") {
        counts.fireStations += 1;
      }

      return counts;
    },
    {
      hospitals: 0,
      policeStations: 0,
      fireStations: 0,
    },
  );
}

export function buildTrafficStatsSnapshot({
  sampleId,
  simulation,
  route,
  runtimeByVehicleId,
  hotspots,
  automaticTrafficHotspots,
  vehicleProbe,
  overlayData,
  synthverseApiState,
  synthverseSensorSummary,
}) {
  const runtimeEntries = [...runtimeByVehicleId.values()];
  const activeVehicles = runtimeEntries.filter(
    (runtime) => !runtime.completed && (runtime.remainingLaunchDelayMs ?? 0) <= 0,
  ).length;
  const queuedVehicles = runtimeEntries.filter(
    (runtime) => !runtime.completed && (runtime.remainingLaunchDelayMs ?? 0) > 0,
  ).length;
  const completedVehicles = runtimeEntries.filter((runtime) => runtime.completed).length;
  const totalVehicles = simulation?.vehicles?.length ?? (route ? 1 : 0);
  const routedVehicles = simulation?.routes?.length ?? (route ? 1 : 0);
  const totalRouteKm =
    (simulation?.vehicles ?? []).reduce(
      (sum, vehicle) => sum + ((vehicle?.route?.distanceMeters ?? 0) / 1000),
      0,
    ) || (route?.distanceMeters ?? 0) / 1000;
  const avgRouteKm = totalVehicles > 0 ? totalRouteKm / totalVehicles : 0;
  const avgDistanceMeters = average(runtimeEntries.map((runtime) => runtime.distanceMeters ?? 0));
  const completionPercent = totalVehicles > 0 ? (completedVehicles / totalVehicles) * 100 : 0;
  const signalCount = safeFeatures(overlayData.trafficSignals).length;
  const directionCount = safeFeatures(overlayData.trafficSignalDirections).length;
  const liveClusterVehicles = automaticTrafficHotspots.reduce(
    (sum, hotspot) => sum + (hotspot.vehicleCount ?? 0),
    0,
  );
  const civicCounts = countCivicAssets(safeFeatures(overlayData.civic));
  const approvedEvents = Array.isArray(synthverseApiState?.approvedEvents)
    ? synthverseApiState.approvedEvents
    : [];
  const peakEventTrafficScore = approvedEvents.reduce(
      (maxValue, event) => Math.max(maxValue, Number(event?.traffic_score ?? 0)),
      0,
    );

  return {
    sampleId,
    totalVehicles,
    activeVehicles,
    queuedVehicles,
    completedVehicles,
    routedVehicles,
    totalRouteKm: roundValue(totalRouteKm, 1),
    avgRouteKm: roundValue(avgRouteKm, 1),
    avgDistanceKm: roundValue(avgDistanceMeters / 1000, 1),
    completionPercent: roundValue(completionPercent, 1),
    signalCount,
    directionCount,
    manualHotspotCount: hotspots.length,
    liveClusterCount: automaticTrafficHotspots.length,
    liveClusterVehicles,
    probeCount: vehicleProbe?.count ?? 0,
    civicCounts,
    apiConfigured: Boolean(synthverseApiState?.configured),
    apiConnected: Boolean(synthverseApiState?.connected),
    apiStatusLabel:
      synthverseApiState?.coreError
        ? "Backend unavailable"
        : synthverseApiState?.connected
          ? "Live backend data"
          : "Waiting for backend data",
    pendingEventCount: 0,
    approvedEventCount: approvedEvents.length,
    peakEventTrafficScore: roundValue(peakEventTrafficScore, 0),
    resilienceScore: 0,
    scannedHospitals: 0,
    scannedPoliceStations: 0,
    scannedFireStations: 0,
    weakestSectorName: "Unavailable",
    weakestSectorFacilityCount: 0,
    accessibleExitCount: synthverseSensorSummary?.accessibleExitCount ?? 0,
    blockedExitCount: synthverseSensorSummary?.blockedExitCount ?? 0,
    avgHallwayScore: synthverseSensorSummary?.avgHallwayScore ?? 0,
    pendingEventsRows: approvedEvents
      .slice()
      .sort((left, right) => Number(right?.traffic_score ?? 0) - Number(left?.traffic_score ?? 0))
      .slice(0, 5)
      .map((event) => ({
        id: event.id,
        label: event.event_name ?? `Event ${event.id}`,
        value: Number(event.traffic_score ?? 0),
        detail: `${event.location ?? event.venue_type ?? "Unknown"} · ${event.expected_crowd ?? 0}`,
      })),
    sensorRows: (synthverseSensorSummary?.sensorRows ?? []).map((sensor) => ({
      id: sensor.id,
      label: sensor.label,
      value: Number(sensor.score ?? 0),
      detail: sensor.nodeType,
    })),
    clusters: automaticTrafficHotspots.map((hotspot, index) => ({
      id: hotspot.id,
      label: `Cluster ${index + 1}`,
      value: hotspot.vehicleCount ?? 0,
      detail: `${Math.round(hotspot.radiusMeters ?? 0)} m`,
    })),
  };
}

export function buildWaterStatsSnapshot({
  sampleId,
  waterState,
  waterGridDisplay,
  waterIncidents,
  overlayData,
}) {
  const districts = waterState?.districts ?? [];
  const nodeFeatures = safeFeatures(waterState?.nodes);
  const visibleGrid = safeFeatures(waterGridDisplay?.visibleGrid);
  const supplyPercents = districts.map((district) => district.supplyPercent ?? 0);
  const avgSupplyPercent = average(supplyPercents);
  const sourceCount = nodeFeatures.filter((node) => node?.properties?.nodeType === "source").length;
  const tankCount = nodeFeatures.filter((node) => node?.properties?.nodeType === "tank").length;
  const pumpCount = nodeFeatures.filter((node) => node?.properties?.nodeType === "pump").length;
  const summary = waterState?.summary;
  const topDistricts = [...districts]
    .sort((left, right) => {
      if ((right.shortfallMLD ?? 0) !== (left.shortfallMLD ?? 0)) {
        return (right.shortfallMLD ?? 0) - (left.shortfallMLD ?? 0);
      }

      return (left.pressureM ?? Number.POSITIVE_INFINITY) - (right.pressureM ?? Number.POSITIVE_INFINITY);
    })
    .slice(0, 5)
    .map((district) => ({
      id: district.id,
      label: district.label,
      value: roundValue(district.pressureM ?? 0, 0),
      detail: `${roundValue(district.supplyPercent ?? 0, 0)}% supply`,
    }));

  return {
    sampleId,
    totalDemandMLD: roundValue(summary?.totalDemandMLD ?? 0, 1),
    servedMLD: roundValue(summary?.servedMLD ?? 0, 1),
    averagePressureM: roundValue(summary?.averagePressureM ?? 0, 1),
    stressedZoneCount: summary?.stressedZoneCount ?? 0,
    breakAffectedZoneCount: summary?.breakAffectedZoneCount ?? 0,
    peakPipeUtilizationPercent: roundValue(summary?.peakPipeUtilizationPercent ?? 0, 1),
    avgSupplyPercent: roundValue(avgSupplyPercent, 1),
    incidentCount: waterIncidents.length,
    districtCount: districts.length,
    visiblePipeCount: visibleGrid.length,
    valveCount: safeFeatures(overlayData.waterValves).length,
    sourceCount,
    tankCount,
    pumpCount,
    topDistricts,
  };
}

export function buildPowerStatsSnapshot({
  sampleId,
  powerState,
  powerGridDisplay,
  powerIncidents,
  overlayData,
}) {
  const districts = powerState?.districts ?? [];
  const nodeFeatures = safeFeatures(powerState?.nodes);
  const visibleGrid = safeFeatures(powerGridDisplay?.visibleGrid);
  const supplyPercents = districts.map((district) => district.supplyPercent ?? 0);
  const avgSupplyPercent = average(supplyPercents);
  const summary = powerState?.summary;
  const substationNodeCount = nodeFeatures.filter(
    (node) => node?.properties?.nodeType === "substation",
  ).length;
  const sourceCount = nodeFeatures.filter((node) => node?.properties?.nodeType === "source").length;
  const topDistricts = [...districts]
    .sort((left, right) => {
      if ((right.shortfallMW ?? 0) !== (left.shortfallMW ?? 0)) {
        return (right.shortfallMW ?? 0) - (left.shortfallMW ?? 0);
      }

      return (left.voltageKV ?? Number.POSITIVE_INFINITY) - (right.voltageKV ?? Number.POSITIVE_INFINITY);
    })
    .slice(0, 5)
    .map((district) => ({
      id: district.id,
      label: district.label,
      value: roundValue(district.voltageKV ?? 0, 0),
      detail: `${roundValue(district.supplyPercent ?? 0, 0)}% supply`,
    }));

  return {
    sampleId,
    totalDemandMW: roundValue(summary?.totalDemandMW ?? 0, 1),
    servedMW: roundValue(summary?.servedMW ?? 0, 1),
    averageVoltageKV: roundValue(summary?.averageVoltageKV ?? 0, 1),
    stressedZoneCount: summary?.stressedZoneCount ?? 0,
    peakLineUtilizationPercent: roundValue(summary?.peakLineUtilizationPercent ?? 0, 1),
    avgSupplyPercent: roundValue(avgSupplyPercent, 1),
    incidentCount: powerIncidents.length,
    districtCount: districts.length,
    visibleLineCount: visibleGrid.length,
    substationCount: safeFeatures(overlayData.powerSubstations).length,
    transformerCount: safeFeatures(overlayData.powerTransformers).length,
    activeSubstationNodeCount: substationNodeCount,
    sourceCount,
    topDistricts,
  };
}

export function buildAnalysisStatsSnapshot({
  sampleId,
  cityAnalysisState,
}) {
  const cityData = cityAnalysisState?.data ?? null;
  const rows = Array.isArray(cityData?.weakest_zones) ? cityData.weakest_zones : [];
  const totalScores = rows.map((row) => Number(row?.score ?? 0)).filter(Number.isFinite);
  const averageScore =
    totalScores.length > 0
      ? totalScores.reduce((sum, value) => sum + value, 0) / totalScores.length
      : 0;
  const strongestRow =
    rows.length > 0
      ? rows.reduce((best, row) =>
          Number(row?.score ?? 0) > Number(best?.score ?? -Infinity) ? row : best,
        rows[0])
      : null;
  const weakestRow =
    rows.length > 0
      ? rows.reduce((best, row) =>
          Number(row?.score ?? Infinity) < Number(best?.score ?? Infinity) ? row : best,
        rows[0])
      : null;
  const weakestSectors = rows
    .map((row, index) => ({
      id: `${row?.sector ?? "sector"}:${index}`,
      label: row?.sector ?? "Unavailable",
      value: Number(row?.score ?? 0),
      detail: row?.reason ?? `${Number(row?.metrics?.hospitals ?? 0) + Number(row?.metrics?.police ?? 0) + Number(row?.metrics?.fire ?? 0)} facilities`,
    }))
    .sort((left, right) => left.value - right.value)
    .slice(0, 5);
  const facilityTotals = rows.reduce(
    (totals, row) => {
      totals.hospitals += Number(row?.metrics?.hospitals ?? 0);
      totals.policeStations += Number(row?.metrics?.police ?? 0);
      totals.fireStations += Number(row?.metrics?.fire ?? 0);
      return totals;
    },
    {
      hospitals: 0,
      policeStations: 0,
      fireStations: 0,
    },
  );

  return {
    sampleId,
    loading: Boolean(cityAnalysisState?.loading),
    connected: Boolean(cityAnalysisState?.connected),
    error: cityAnalysisState?.error ?? "",
    lastSyncAt: cityAnalysisState?.lastSyncAt ?? "",
    city: cityData?.city ?? "Bengaluru",
    totalInfrastructureCount: Number(cityData?.total_infrastructure_count ?? 0),
    sampleCount: rows.length,
    averageScore: roundValue(averageScore, 1),
    strongestScore: roundValue(strongestRow?.score ?? 0, 0),
    weakestScore: roundValue(weakestRow?.score ?? 0, 0),
    strongestSectorName: strongestRow?.sector ?? "Unavailable",
    weakestSectorName: weakestRow?.sector ?? "Unavailable",
    weakestSectorFacilityCount:
      Number(weakestRow?.metrics?.hospitals ?? 0) +
      Number(weakestRow?.metrics?.police ?? 0) +
      Number(weakestRow?.metrics?.fire ?? 0),
    hospitals: facilityTotals.hospitals,
    policeStations: facilityTotals.policeStations,
    fireStations: facilityTotals.fireStations,
    weakestSectors,
  };
}
