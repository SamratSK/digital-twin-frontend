import { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { PMTiles } from "pmtiles";
import CampusFloorplanModal from "./components/CampusFloorplanModal.jsx";
import ControlPanel from "./components/ControlPanel.jsx";
import MapLegend from "./components/MapLegend.jsx";
import StatsPanel from "./components/StatsPanel.jsx";
import {
  BMSCE_CAMPUS_BOUNDS,
  BMSCE_CAMPUS_ID,
  buildCampusBuildingGeoJSON,
  buildCampusGeoJSON,
} from "./data/offlineCampuses.js";
import { BMSCE_MEL_FLOORPLAN } from "./data/bmsceFloorplan.js";
import {
  BENGALURU_CENTER,
  MAP_LIMIT_BOUNDS,
  MAP_VIEW_BOUNDS,
  OFFLINE_DATA_PATHS,
  PMTILES_PATH,
} from "./data/offlineBengaluru.js";
import {
  buildPickedEndpointGeoJSON,
  emptyFeatureCollection,
  getPointAtDistance,
  loadOfflineRouter,
  metersBetween,
} from "./lib/navigation.js";
import {
  attachCursor,
  createEmptyOverlayData,
  createStyle,
  ensureMapImages,
  getMapPadding,
  getPmtilesProtocol,
  updateGeoJsonSource,
} from "./lib/mapStyle.js";
import {
  buildAutomaticTrafficHotspots,
  buildDefinedRoutePlan,
  buildDefinedVehicles,
  buildHotspotCenterGeoJSON,
  buildHotspotGeoJSON,
  buildTrafficHeatmapGeoJSON,
  buildVehicleProbeCenterGeoJSON,
  buildVehicleProbeGeoJSON,
  buildRandomRoutePlans,
  buildRandomVehicles,
  buildRouteFromPlan,
  buildRoutesFromPlans,
  buildRoutesGeoJSON,
  buildSimulationRoutes,
  countRuntimeVehiclesInRadius,
  countVehicleFeaturesInRadius,
  formatCoordinateLabel,
  normalizeHotspotRadius,
  normalizeVehicleProbeRadius,
  normalizeVehicleCount,
  rerouteSimulationVehicles,
} from "./lib/simulation.js";
import { simulateWaterNetwork } from "./lib/waterSimulation.js";
import {
  buildWaterIncidentHeatmapGeoJSON,
  buildWaterPressureHeatmapGeoJSON,
  buildManualWaterIncident,
  buildStyledWaterGrid,
  createEmptyWaterGridDisplay,
} from "./lib/waterGrid.js";
import { simulatePowerNetwork } from "./lib/powerSimulation.js";
import {
  buildManualPowerIncident,
  buildStyledPowerGrid,
  createEmptyPowerGridDisplay,
} from "./lib/powerGrid.js";
import {
  buildLiveTrafficSignalDisplay,
  createEmptyTrafficSignalDisplay,
  createTrafficSignalSystem,
} from "./lib/trafficSignals.js";
import {
  buildAnalysisStatsSnapshot,
  buildPowerStatsSnapshot,
  buildTrafficStatsSnapshot,
  buildWaterStatsSnapshot,
} from "./lib/dashboardStats.js";
import {
  buildSynthverseCityAnalysisGeoJSON,
  buildSynthverseEventHotspots,
  buildSynthverseTrafficEventZonesGeoJSON,
  buildSynthverseTrafficEventsGeoJSON,
  createEmptySynthverseApiState,
  DEFAULT_SYNTHVERSE_API_BASE_URL,
  fetchSynthverseAreaScore,
  fetchSynthverseApprovedEvents,
  fetchSynthverseSensors,
  normalizeSynthverseApiBaseUrl,
} from "./lib/synthverseApi.js";

const TRAFFIC_HOTSPOT_REFRESH_MS = 700;
const TRAFFIC_HOTSPOT_ACTIVATION_DELAY_MS = 900;
const SYNTHVERSE_API_LOCAL_STORAGE_KEY = "synthverse-api-base-url";
const SYNTHVERSE_CORE_REFRESH_MS = 15000;
const SYNTHVERSE_ANALYSIS_REFRESH_MS = 120000;
const CITY_ANALYSIS_MAX_CALLS = 20;
const CAMPUS_FLOORPLAN_POLL_MS = 2000;
const CAMPUS_EMERGENCY_TEMPERATURE = 37;

function createEmptyCampusFloorplanState() {
  return {
    open: false,
    campusId: BMSCE_CAMPUS_ID,
    campusLabel: "BMSCE Campus",
    loading: false,
    error: "",
    lastSyncAt: "",
    nodes: {
      exits: [...BMSCE_MEL_FLOORPLAN.exits, ...BMSCE_MEL_FLOORPLAN.lifts],
      hallway: BMSCE_MEL_FLOORPLAN.hallwayNodes,
    },
    sensors: {
      exits: [],
      hallway: [],
    },
  };
}

function createEmptyCityAnalysisState() {
  return {
    loading: false,
    connected: false,
    error: "",
    lastSyncAt: "",
    rows: [],
    geojson: emptyFeatureCollection(),
  };
}

function App() {
  const [activeSection, setActiveSection] = useState("traffic");
  const [statsPanelCollapsed, setStatsPanelCollapsed] = useState(false);
  const [statsSampleId, setStatsSampleId] = useState(0);
  const [simulationMode, setSimulationMode] = useState("defined");
  const [vehicleCountInput, setVehicleCountInput] = useState("10");
  const [vehicleProbeRadiusInput, setVehicleProbeRadiusInput] = useState("200");
  const [hotspotRadiusInput, setHotspotRadiusInput] = useState("250");
  const [synthverseApiBaseUrl] = useState(() => {
    if (typeof window === "undefined") {
      return DEFAULT_SYNTHVERSE_API_BASE_URL;
    }

    const storedValue = window.localStorage.getItem(SYNTHVERSE_API_LOCAL_STORAGE_KEY);
    return storedValue?.trim() || DEFAULT_SYNTHVERSE_API_BASE_URL;
  });
  const [trafficHeatmapEnabled, setTrafficHeatmapEnabled] = useState(true);
  const [waterHeatmapEnabled, setWaterHeatmapEnabled] = useState(true);
  const [waterHour, setWaterHour] = useState(7);
  const [waterMetric, setWaterMetric] = useState("pressure");
  const [powerHour, setPowerHour] = useState(18);
  const [powerMetric, setPowerMetric] = useState("voltage");
  const [selectedCampusId, setSelectedCampusId] = useState(BMSCE_CAMPUS_ID);
  const [overlayData, setOverlayData] = useState(createEmptyOverlayData);
  const [waterGridDisplay, setWaterGridDisplay] = useState(createEmptyWaterGridDisplay);
  const [powerGridDisplay, setPowerGridDisplay] = useState(createEmptyPowerGridDisplay);
  const [trafficSignalSystem, setTrafficSignalSystem] = useState(null);
  const [waterIncidents, setWaterIncidents] = useState([]);
  const [powerIncidents, setPowerIncidents] = useState([]);
  const [waterState, setWaterState] = useState(() =>
    simulateWaterNetwork({ hour: 7, metric: "pressure", incidents: [] }),
  );
  const [powerState, setPowerState] = useState(() =>
    simulatePowerNetwork({ hour: 18, metric: "voltage", incidents: [] }),
  );
  const [hotspots, setHotspots] = useState([]);
  const [automaticTrafficHotspots, setAutomaticTrafficHotspots] = useState([]);
  const [startSelection, setStartSelection] = useState(null);
  const [endSelection, setEndSelection] = useState(null);
  const [pickMode, setPickMode] = useState(null);
  const [mapReady, setMapReady] = useState(false);
  const [router, setRouter] = useState(null);
  const [route, setRoute] = useState(null);
  const [simulation, setSimulation] = useState(null);
  const [vehicleProbe, setVehicleProbe] = useState(null);
  const [synthverseApiState, setSynthverseApiState] = useState(createEmptySynthverseApiState);
  const [campusFloorplanState, setCampusFloorplanState] = useState(createEmptyCampusFloorplanState);
  const [cityAnalysisState, setCityAnalysisState] = useState(createEmptyCityAnalysisState);
  const [campusEmergencyDisplay, setCampusEmergencyDisplay] = useState(() => ({
    alert: emptyFeatureCollection(),
    routes: emptyFeatureCollection(),
    targets: emptyFeatureCollection(),
  }));
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const pickModeRef = useRef(null);
  const animationFrameRef = useRef(0);
  const simulationRef = useRef(null);
  const simulationElapsedRef = useRef(0);
  const vehicleRuntimeRef = useRef(new Map());
  const vehicleProbeRef = useRef(null);
  const hotspotsRef = useRef(hotspots);
  const automaticTrafficHotspotsRef = useRef([]);
  const trafficHotspotSignatureRef = useRef("");
  const activeSectionRef = useRef(activeSection);
  const trafficHeatmapEnabledRef = useRef(trafficHeatmapEnabled);
  const trafficSignalSystemRef = useRef(trafficSignalSystem);
  const trafficEventFeaturesRef = useRef([]);
  const trafficSignalFeaturesRef = useRef(overlayData.trafficSignals?.features ?? []);
  const campusFloorplanRequestIdRef = useRef(0);
  const cityAnalysisRequestInFlightRef = useRef(false);
  const hoverPopupRef = useRef(null);

  const showTrafficLayers = activeSection === "traffic";
  const showWaterLayers = activeSection === "water";
  const showPowerLayers = activeSection === "energy";
  const showAnalysisLayers = activeSection === "analysis";
  const normalizedSynthverseApiBaseUrl = normalizeSynthverseApiBaseUrl(synthverseApiBaseUrl);
  const trafficEventGeoJSON = buildSynthverseTrafficEventsGeoJSON(synthverseApiState.approvedEvents);
  const trafficEventZonesGeoJSON = buildSynthverseTrafficEventZonesGeoJSON(
    synthverseApiState.approvedEvents,
  );
  const trafficEventHotspots = buildSynthverseEventHotspots(synthverseApiState.approvedEvents);
  const campusEmergencyHotspots = buildCampusEmergencyRoutingHotspots(campusEmergencyDisplay.alert);
  const campusEmergencyRouteHotspots = buildCampusEmergencyRouteHotspots(
    campusEmergencyDisplay.routes,
  );
  const persistentRoutingHotspots = [
    ...hotspots,
    ...trafficEventHotspots,
    ...campusEmergencyHotspots,
    ...campusEmergencyRouteHotspots,
  ];
  const persistentRoutingHotspotsSignature = buildRoutingHotspotSignature(
    persistentRoutingHotspots,
  );
  const automaticTrafficHotspotsSignature = buildRoutingHotspotSignature(automaticTrafficHotspots);

  const setPickState = (nextPickMode) => {
    pickModeRef.current = nextPickMode;

    if (mapRef.current) {
      mapRef.current.getCanvas().style.cursor = nextPickMode ? "crosshair" : "";
    }

    startTransition(() => {
      setPickMode(nextPickMode);
    });
  };

  const togglePickMode = (mode) => {
    setPickState(pickModeRef.current === mode ? null : mode);
  };

  const handleMapPick = useEffectEvent((event) => {
    const nextPickMode = pickModeRef.current;
    const isWaterPickMode =
      nextPickMode === "water-break" || nextPickMode === "reservoir-failure";
    const isPowerPickMode =
      nextPickMode === "power-line-fault" || nextPickMode === "power-substation-outage";

    if (!nextPickMode) {
      const campusFeatureCount =
        mapRef.current?.queryRenderedFeatures(event.point, {
          layers: ["campus-fill", "campus-buildings-3d", "campus-labels"],
        }).length ?? 0;

      if (campusFeatureCount > 0) {
        return;
      }

      if (activeSectionRef.current !== "traffic") {
        return;
      }

      const coordinate = [event.lngLat.lng, event.lngLat.lat];
      const radiusMeters = normalizeVehicleProbeRadius(vehicleProbeRadiusInput);
      const count = countRuntimeVehiclesInRadius(
        vehicleRuntimeRef.current,
        coordinate,
        radiusMeters,
      );

      startTransition(() => {
        setVehicleProbe({
          id: "vehicle-probe",
          coordinate,
          radiusMeters,
          count,
          label: formatCoordinateLabel(coordinate),
        });
      });
      return;
    }

    const coordinate = [event.lngLat.lng, event.lngLat.lat];

    if (isWaterPickMode) {
      const incident = buildManualWaterIncident({
        mode: nextPickMode,
        coordinate,
        waterGrid: overlayData.waterGrid,
      });

      setPickState(null);

      if (!incident) {
        return;
      }

      startTransition(() => {
        setWaterIncidents((current) => [...current, incident]);
      });
      return;
    }

    if (isPowerPickMode) {
      const incident = buildManualPowerIncident({
        mode: nextPickMode,
        coordinate,
        powerGrid: overlayData.powerGrid,
        powerSubstations: overlayData.powerSubstations,
      });

      setPickState(null);

      if (!incident) {
        return;
      }

      startTransition(() => {
        setPowerIncidents((current) => [...current, incident]);
      });
      return;
    }

    if (!router) {
      return;
    }

    if (nextPickMode === "hotspot") {
      const radiusMeters = normalizeHotspotRadius(hotspotRadiusInput);
      const hotspot = {
        id: `hotspot:${Date.now()}`,
        label: `${formatCoordinateLabel(coordinate)} • ${Math.round(radiusMeters)} m`,
        coordinate,
        radiusMeters,
      };

      setPickState(null);

      startTransition(() => {
        setHotspots((current) => [...current, hotspot]);
      });
      return;
    }

    const roadCoordinate = router.nearestRoadCoordinate(coordinate) ?? coordinate;
    const selection = {
      label: formatCoordinateLabel(coordinate),
      coordinate,
      roadCoordinate,
    };

    setPickState(null);
    vehicleRuntimeRef.current = new Map();
    simulationElapsedRef.current = 0;

    startTransition(() => {
      if (nextPickMode === "start") {
        setStartSelection(selection);
      } else {
        setEndSelection(selection);
      }

      setSimulation(null);
    });
  });

  const handleStart = useEffectEvent(() => {
    if (!router) {
      return;
    }

    const vehicleCount = normalizeVehicleCount(vehicleCountInput);

    if (simulationMode === "defined") {
      if (!route) {
        return;
      }

      const vehicles = buildDefinedVehicles(route, vehicleCount);
      vehicleRuntimeRef.current = new Map();
      simulationElapsedRef.current = 0;

      startTransition(() => {
        setSimulation({
          id: `defined:${Date.now()}`,
          mode: "defined",
          routingSignature: persistentRoutingHotspotsSignature,
          automaticRoutingSignature: "",
          vehicleCount,
          routes: buildSimulationRoutes({ vehicles }),
          vehicles,
        });
      });
      return;
    }

    const routePlans = buildRandomRoutePlans(router, vehicleCount);
    const randomRoutes = buildRoutesFromPlans(
      router,
      routePlans,
      persistentRoutingHotspots,
      trafficSignalSystem,
    );

    if (randomRoutes.length === 0) {
      return;
    }

    const vehicles = buildRandomVehicles(randomRoutes);
    vehicleRuntimeRef.current = new Map();
    simulationElapsedRef.current = 0;
    simulationElapsedRef.current = 0;

    startTransition(() => {
      setSimulation({
        id: `randomized:${Date.now()}`,
        mode: "randomized",
        routingSignature: persistentRoutingHotspotsSignature,
        automaticRoutingSignature: "",
        vehicleCount: vehicles.length,
        routes: buildSimulationRoutes({ vehicles }),
        vehicles,
      });
    });
  });

  const handleCloseCampusFloorplan = useEffectEvent(() => {
    startTransition(() => {
      setCampusFloorplanState((current) => ({
        ...current,
        open: false,
      }));
    });
  });

  const handleCampusDoubleClick = useEffectEvent((event) => {
    if (pickModeRef.current) {
      return;
    }

    const campusId = event.features?.[0]?.properties?.id;
    const campusLabel = event.features?.[0]?.properties?.label ?? "BMSCE Campus";

    if (!campusId) {
      return;
    }

    event.preventDefault?.();
    event.originalEvent?.preventDefault?.();
    event.originalEvent?.stopPropagation?.();

    startTransition(() => {
      setSelectedCampusId(campusId);
      setCampusFloorplanState({
        open: true,
        campusId,
        campusLabel,
        loading: true,
        error: "",
        lastSyncAt: "",
        nodes: {
          exits: [...BMSCE_MEL_FLOORPLAN.exits, ...BMSCE_MEL_FLOORPLAN.lifts],
          hallway: BMSCE_MEL_FLOORPLAN.hallwayNodes,
        },
        sensors: {
          exits: [],
          hallway: [],
        },
      });
    });
  });

  useEffect(() => {
    if (!campusFloorplanState.open) {
      return undefined;
    }

    let cancelled = false;
    const requestId = campusFloorplanRequestIdRef.current + 1;
    campusFloorplanRequestIdRef.current = requestId;

    async function refreshCampusSensors() {
      if (!normalizedSynthverseApiBaseUrl) {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setCampusFloorplanState((current) => ({
            ...current,
            loading: false,
            error: "Floorplan backend is unavailable.",
          }));
        });
        return;
      }

      try {
        const sensors = await fetchSynthverseSensors(normalizedSynthverseApiBaseUrl);

        if (cancelled || campusFloorplanRequestIdRef.current !== requestId) {
          return;
        }

        startTransition(() => {
          setCampusFloorplanState((current) => ({
            ...current,
            loading: false,
            error: "",
            lastSyncAt: new Date().toISOString(),
            sensors: {
              exits: Array.isArray(sensors?.exits) ? sensors.exits : [],
              hallway: Array.isArray(sensors?.hallway) ? sensors.hallway : [],
            },
          }));
        });
      } catch (error) {
        if (cancelled || campusFloorplanRequestIdRef.current !== requestId) {
          return;
        }

        startTransition(() => {
          setCampusFloorplanState((current) => ({
            ...current,
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to poll campus sensors.",
          }));
        });
      }
    }

    refreshCampusSensors();
    const intervalId = window.setInterval(refreshCampusSensors, CAMPUS_FLOORPLAN_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [campusFloorplanState.open, normalizedSynthverseApiBaseUrl]);

  useEffect(() => {
    if (!router) {
      startTransition(() => {
        setCampusEmergencyDisplay({
          alert: emptyFeatureCollection(),
          routes: emptyFeatureCollection(),
          targets: emptyFeatureCollection(),
        });
      });
      return;
    }

    const allSensors = [
      ...(Array.isArray(campusFloorplanState.sensors?.hallway)
        ? campusFloorplanState.sensors.hallway
        : []),
      ...(Array.isArray(campusFloorplanState.sensors?.exits)
        ? campusFloorplanState.sensors.exits
        : []),
    ];
    const hottestTemperature = allSensors.reduce(
      (maxValue, sensor) => Math.max(maxValue, Number(sensor?.score ?? 0)),
      0,
    );

    if (hottestTemperature < CAMPUS_EMERGENCY_TEMPERATURE) {
      startTransition(() => {
        setCampusEmergencyDisplay({
          alert: emptyFeatureCollection(),
          routes: emptyFeatureCollection(),
          targets: emptyFeatureCollection(),
        });
      });
      return;
    }

    const campusCenter = getBmsceCampusCenterCoordinate();
    const emergencyRoutes = buildCampusEmergencyRoutes({
      campusCenter,
      civic: overlayData.civic,
      router,
    });

    startTransition(() => {
      setCampusEmergencyDisplay({
        alert: buildCampusEmergencyAlertGeoJSON({
          center: campusCenter,
          temperature: hottestTemperature,
        }),
        routes: buildCampusEmergencyRoutesGeoJSON(emergencyRoutes),
        targets: buildCampusEmergencyRouteTargetsGeoJSON(emergencyRoutes),
      });
    });
  }, [campusFloorplanState.sensors, overlayData.civic, router]);

  const handleZoomToCampus = useEffectEvent(() => {
    const mapInstance = mapRef.current;

    if (!mapInstance) {
      return;
    }

    startTransition(() => {
      setSelectedCampusId(BMSCE_CAMPUS_ID);
    });

    mapInstance.fitBounds(BMSCE_CAMPUS_BOUNDS, {
      padding: getMapPadding(),
      duration: 900,
      maxZoom: 17,
      pitch: 50,
      bearing: -12,
    });
  });

  const handleClear = useEffectEvent(() => {
    cancelAnimationFrame(animationFrameRef.current);
    vehicleRuntimeRef.current = new Map();
    simulationElapsedRef.current = 0;
    setPickState(null);

    startTransition(() => {
      setStartSelection(null);
      setEndSelection(null);
      setHotspots([]);
      setWaterIncidents([]);
      setPowerIncidents([]);
      setAutomaticTrafficHotspots([]);
      setVehicleProbe(null);
      setRoute(null);
      setSimulation(null);
    });
  });

  const handleDeleteHotspot = useEffectEvent((hotspotId) => {
    startTransition(() => {
      setHotspots((current) => current.filter((item) => item.id !== hotspotId));
    });
  });

  const handleDeleteWaterIncident = useEffectEvent((incidentId) => {
    startTransition(() => {
      setWaterIncidents((current) => current.filter((item) => item.id !== incidentId));
    });
  });

  const handleDeletePowerIncident = useEffectEvent((incidentId) => {
    startTransition(() => {
      setPowerIncidents((current) => current.filter((item) => item.id !== incidentId));
    });
  });

  const handleResetStart = useEffectEvent(() => {
    if (pickModeRef.current === "start") {
      setPickState(null);
    }

    vehicleRuntimeRef.current = new Map();
    simulationElapsedRef.current = 0;

    startTransition(() => {
      setStartSelection(null);
      setRoute(null);
      setSimulation(null);
    });
  });

  const handleResetEnd = useEffectEvent(() => {
    if (pickModeRef.current === "end") {
      setPickState(null);
    }

    vehicleRuntimeRef.current = new Map();

    startTransition(() => {
      setEndSelection(null);
      setRoute(null);
      setSimulation(null);
    });
  });

  const refreshSynthverseCore = useEffectEvent(async () => {
    if (!normalizedSynthverseApiBaseUrl) {
      startTransition(() => {
        setSynthverseApiState((current) => ({
          ...current,
          configured: false,
          connected: false,
          coreLoading: false,
          coreError: "",
          approvedEvents: [],
        }));
      });
      return;
    }

    startTransition(() => {
      setSynthverseApiState((current) => ({
        ...current,
        configured: true,
        coreLoading: true,
        coreError: "",
      }));
    });

    try {
      const approvedEvents = await fetchSynthverseApprovedEvents(normalizedSynthverseApiBaseUrl);

      startTransition(() => {
        setSynthverseApiState((current) => ({
          ...current,
          configured: true,
          connected: true,
          coreLoading: false,
          coreError: "",
          lastCoreSyncAt: new Date().toISOString(),
          approvedEvents,
        }));
      });
    } catch (error) {
      startTransition(() => {
        setSynthverseApiState((current) => ({
          ...current,
          configured: true,
          connected: false,
          coreLoading: false,
          coreError: error instanceof Error ? error.message : "Failed to reach Synthverse API.",
          approvedEvents: [],
        }));
      });
    }
  });

  const refreshCityAnalysis = useEffectEvent(async () => {
    if (!normalizedSynthverseApiBaseUrl) {
      startTransition(() => {
        setCityAnalysisState(createEmptyCityAnalysisState());
      });
      return;
    }

    if (cityAnalysisRequestInFlightRef.current) {
      return;
    }

    cityAnalysisRequestInFlightRef.current = true;

    startTransition(() => {
      setCityAnalysisState((current) => ({
        ...current,
        loading: true,
        error: "",
      }));
    });

    try {
      const coordinates = buildCityAnalysisGridCoordinates(MAP_VIEW_BOUNDS, 4, 5);
      const rows = (
        await Promise.all(
          coordinates.map(async (coordinate, index) => {
            const score = await fetchSynthverseAreaScore(normalizedSynthverseApiBaseUrl, coordinate);
            return score
              ? {
                  ...score,
                  location: {
                    latitude: Number(score?.location?.latitude ?? coordinate[1]),
                    longitude: Number(score?.location?.longitude ?? coordinate[0]),
                    label: `Zone ${index + 1}`,
                  },
                }
              : null;
          }),
        )
      ).filter(Boolean);

      startTransition(() => {
        setCityAnalysisState({
          loading: false,
          connected: true,
          error: "",
          lastSyncAt: new Date().toISOString(),
          rows,
          geojson: buildSynthverseCityAnalysisGeoJSON(rows),
        });
      });
    } catch (error) {
      startTransition(() => {
        setCityAnalysisState((current) => ({
          ...current,
          loading: false,
          connected: false,
          error: error instanceof Error ? error.message : "Failed to load city analysis.",
        }));
      });
    } finally {
      cityAnalysisRequestInFlightRef.current = false;
    }
  });

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setStatsSampleId((currentValue) => currentValue + 1);
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadOverlayData() {
      try {
        const [
          boundaryResponse,
          civicResponse,
          trafficSignalResponse,
          trafficDirectionResponse,
          waterGridResponse,
          waterValvesResponse,
          powerGridResponse,
          powerSubstationsResponse,
          powerTransformersResponse,
        ] =
          await Promise.all([
            fetch(OFFLINE_DATA_PATHS.boundary),
            fetch(OFFLINE_DATA_PATHS.civic),
            fetch(OFFLINE_DATA_PATHS.trafficSignals),
            fetch(OFFLINE_DATA_PATHS.trafficSignalDirections),
            fetch(OFFLINE_DATA_PATHS.waterGrid),
            fetch(OFFLINE_DATA_PATHS.waterValves),
            fetch(OFFLINE_DATA_PATHS.powerGrid),
            fetch(OFFLINE_DATA_PATHS.powerSubstations),
            fetch(OFFLINE_DATA_PATHS.powerTransformers),
          ]);

        if (
          !boundaryResponse.ok ||
          !civicResponse.ok ||
          !trafficSignalResponse.ok ||
          !trafficDirectionResponse.ok ||
          !waterGridResponse.ok ||
          !waterValvesResponse.ok ||
          !powerGridResponse.ok ||
          !powerSubstationsResponse.ok ||
          !powerTransformersResponse.ok
        ) {
          throw new Error("Failed to load offline Bengaluru overlay data.");
        }

        const [
          boundary,
          civic,
          trafficSignals,
          trafficSignalDirections,
          waterGrid,
          waterValves,
          powerGrid,
          powerSubstations,
          powerTransformers,
        ] = await Promise.all([
          boundaryResponse.json(),
          civicResponse.json(),
          trafficSignalResponse.json(),
          trafficDirectionResponse.json(),
          waterGridResponse.json(),
          waterValvesResponse.json(),
          powerGridResponse.json(),
          powerSubstationsResponse.json(),
          powerTransformersResponse.json(),
        ]);

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setOverlayData({
            boundary,
            civic,
            trafficSignals,
            trafficSignalDirections,
            waterGrid,
            waterValves,
            powerGrid,
            powerSubstations,
            powerTransformers,
            hotspots: emptyFeatureCollection(),
            hotspotCenters: emptyFeatureCollection(),
          });
        });
      } catch (error) {
        console.error("Failed to load offline overlays", error);
      }
    }

    loadOverlayData();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!normalizedSynthverseApiBaseUrl) {
      startTransition(() => {
        setSynthverseApiState((current) => ({
          ...current,
          configured: false,
          connected: false,
          coreLoading: false,
          coreError: "",
        }));
      });
      return undefined;
    }

    refreshSynthverseCore();
    const intervalId = window.setInterval(() => {
      refreshSynthverseCore();
    }, SYNTHVERSE_CORE_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [normalizedSynthverseApiBaseUrl]);

  useEffect(() => {
    if (activeSection !== "analysis") {
      return undefined;
    }

    refreshCityAnalysis();
    const intervalId = window.setInterval(() => {
      refreshCityAnalysis();
    }, SYNTHVERSE_ANALYSIS_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeSection, refreshCityAnalysis]);

  useEffect(() => {
    simulationRef.current = simulation;
  }, [simulation]);

  useEffect(() => {
    activeSectionRef.current = activeSection;

    const currentPickMode = pickModeRef.current;
    if (!currentPickMode) {
      return;
    }

    const isTrafficPickMode =
      currentPickMode === "start" || currentPickMode === "end" || currentPickMode === "hotspot";
    const isWaterPickMode =
      currentPickMode === "water-break" || currentPickMode === "reservoir-failure";
    const isPowerPickMode =
      currentPickMode === "power-line-fault" || currentPickMode === "power-substation-outage";

    if (
      (isTrafficPickMode && activeSection !== "traffic") ||
      (isWaterPickMode && activeSection !== "water") ||
      (isPowerPickMode && activeSection !== "energy")
    ) {
      setPickState(null);
    }
  }, [activeSection]);

  useEffect(() => {
    vehicleProbeRef.current = vehicleProbe;
  }, [vehicleProbe]);

  useEffect(() => {
    hotspotsRef.current = hotspots;
  }, [hotspots]);

  useEffect(() => {
    automaticTrafficHotspotsRef.current = automaticTrafficHotspots;
  }, [automaticTrafficHotspots]);

  useEffect(() => {
    trafficHeatmapEnabledRef.current = trafficHeatmapEnabled;
  }, [trafficHeatmapEnabled]);

  useEffect(() => {
    trafficSignalSystemRef.current = trafficSignalSystem;
  }, [trafficSignalSystem]);

  useEffect(() => {
    trafficEventFeaturesRef.current = trafficEventGeoJSON.features;
  }, [trafficEventGeoJSON]);

  useEffect(() => {
    trafficSignalFeaturesRef.current = overlayData.trafficSignals?.features ?? [];
  }, [overlayData.trafficSignals]);

  useEffect(() => {
    const hasTrafficSignals = Array.isArray(overlayData.trafficSignals?.features);
    const hasTrafficSignalDirections = Array.isArray(overlayData.trafficSignalDirections?.features);

    if (!hasTrafficSignals || !hasTrafficSignalDirections) {
      startTransition(() => {
        setTrafficSignalSystem(null);
      });
      return;
    }

    startTransition(() => {
      setTrafficSignalSystem(
        createTrafficSignalSystem(overlayData.trafficSignals, overlayData.trafficSignalDirections),
      );
    });
  }, [overlayData.trafficSignalDirections, overlayData.trafficSignals]);

  useEffect(() => {
    startTransition(() => {
      setWaterState(
        simulateWaterNetwork({
          hour: waterHour,
          metric: waterMetric,
          incidents: waterIncidents,
        }),
      );
    });
  }, [waterHour, waterIncidents, waterMetric]);

  useEffect(() => {
    startTransition(() => {
      setWaterGridDisplay(
        buildStyledWaterGrid({
          waterGrid: overlayData.waterGrid,
          districts: waterState.districts,
          incidents: waterIncidents,
          metric: waterMetric,
        }),
      );
    });
  }, [overlayData.waterGrid, waterIncidents, waterMetric, waterState.districts]);

  useEffect(() => {
    startTransition(() => {
      setPowerState(
        simulatePowerNetwork({
          hour: powerHour,
          metric: powerMetric,
          incidents: powerIncidents,
        }),
      );
    });
  }, [powerHour, powerIncidents, powerMetric]);

  useEffect(() => {
    startTransition(() => {
      setPowerGridDisplay(
        buildStyledPowerGrid({
          powerGrid: overlayData.powerGrid,
          districts: powerState.districts,
          incidents: powerIncidents,
          metric: powerMetric,
        }),
      );
    });
  }, [overlayData.powerGrid, powerIncidents, powerMetric, powerState.districts]);

  useEffect(() => {
    const mapInstance = mapRef.current;

    if (!mapReady || !mapInstance) {
      return undefined;
    }

    updateGeoJsonSource(mapInstance, "boundary", overlayData.boundary);
    updateGeoJsonSource(mapInstance, "campuses", buildCampusGeoJSON(selectedCampusId));
    updateGeoJsonSource(
      mapInstance,
      "campusEmergencyAlert",
      showTrafficLayers ? campusEmergencyDisplay.alert : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "campusEmergencyRoutes",
      showTrafficLayers ? campusEmergencyDisplay.routes : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "campusEmergencyRouteTargets",
      showTrafficLayers ? campusEmergencyDisplay.targets : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "campusBuildings",
      buildCampusBuildingGeoJSON(selectedCampusId),
    );
    updateGeoJsonSource(
      mapInstance,
      "civic",
      showTrafficLayers ? overlayData.civic : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "synthverseScanArea",
      emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "synthverseEmergencyFacilities",
      emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "cityAnalysis",
      showAnalysisLayers ? cityAnalysisState.geojson : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "trafficEventZones",
      showTrafficLayers ? trafficEventZonesGeoJSON : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "trafficEvents",
      showTrafficLayers ? trafficEventGeoJSON : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "trafficSignals",
      showTrafficLayers ? overlayData.trafficSignals : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "trafficSignalDirections",
      showTrafficLayers ? overlayData.trafficSignalDirections : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "waterValves",
      showWaterLayers ? overlayData.waterValves : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "powerSubstations",
      showPowerLayers ? overlayData.powerSubstations : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "powerTransformers",
      showPowerLayers ? overlayData.powerTransformers : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "hotspots",
      showTrafficLayers ? overlayData.hotspots : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "hotspotCenters",
      showTrafficLayers ? overlayData.hotspotCenters : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "trafficSignalActiveDirections",
      showTrafficLayers
        ? createEmptyTrafficSignalDisplay().activeDirections
        : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "trafficSignalActivePoints",
      showTrafficLayers ? createEmptyTrafficSignalDisplay().activeSignals : emptyFeatureCollection(),
    );

    return undefined;
  }, [
    campusEmergencyDisplay,
    cityAnalysisState.geojson,
    mapReady,
    overlayData,
    selectedCampusId,
    showAnalysisLayers,
    showPowerLayers,
    showTrafficLayers,
    showWaterLayers,
    trafficEventGeoJSON,
    trafficEventZonesGeoJSON,
    synthverseApiState.connected,
  ]);

  useEffect(() => {
    const mapInstance = mapRef.current;

    if (!mapReady || !mapInstance) {
      return undefined;
    }

    const visibleHotspots = [...hotspots, ...automaticTrafficHotspots];

    updateGeoJsonSource(
      mapInstance,
      "hotspots",
      showTrafficLayers ? buildHotspotGeoJSON(visibleHotspots) : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "hotspotCenters",
      showTrafficLayers ? buildHotspotCenterGeoJSON(visibleHotspots) : emptyFeatureCollection(),
    );

    return undefined;
  }, [automaticTrafficHotspots, hotspots, mapReady, showTrafficLayers]);

  useEffect(() => {
    const mapInstance = mapRef.current;

    if (!mapReady || !mapInstance) {
      return undefined;
    }

    updateGeoJsonSource(
      mapInstance,
      "vehicleProbeArea",
      showTrafficLayers ? buildVehicleProbeGeoJSON(vehicleProbe) : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "vehicleProbeCenter",
      showTrafficLayers
        ? buildVehicleProbeCenterGeoJSON(vehicleProbe)
        : emptyFeatureCollection(),
    );

    return undefined;
  }, [mapReady, showTrafficLayers, vehicleProbe]);

  useEffect(() => {
    const mapInstance = mapRef.current;

    if (!mapReady || !mapInstance) {
      return undefined;
    }

    updateGeoJsonSource(
      mapInstance,
      "waterZones",
      showWaterLayers ? waterState.zones : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "waterNodes",
      showWaterLayers ? waterState.nodes : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "waterGridVisible",
      showWaterLayers ? waterGridDisplay.visibleGrid : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "waterBreaks",
      showWaterLayers ? waterGridDisplay.breaks : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "powerZones",
      showPowerLayers ? powerState.zones : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "powerNodes",
      showPowerLayers ? powerState.nodes : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "powerGridVisible",
      showPowerLayers ? powerGridDisplay.visibleGrid : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "powerIncidents",
      showPowerLayers ? powerGridDisplay.incidents : emptyFeatureCollection(),
    );

    return undefined;
  }, [
    mapReady,
    powerGridDisplay,
    powerState,
    showPowerLayers,
    showWaterLayers,
    waterGridDisplay,
    waterState,
  ]);

  useEffect(() => {
    const mapInstance = mapRef.current;

    if (!mapReady || !mapInstance) {
      return undefined;
    }

    if (simulation?.id && simulation.vehicles.length > 0) {
      return undefined;
    }

    const visibleRoutes =
      simulationMode === "defined" && route
        ? [route]
        : simulation?.routes?.length > 0
          ? simulation.routes
          : [];
    const visibleTrafficHeatmap =
      showTrafficLayers && trafficHeatmapEnabled
        ? buildTrafficHeatmapGeoJSON({
            routes: visibleRoutes,
            hotspots: [
              ...persistentRoutingHotspots,
              ...automaticTrafficHotspots,
            ],
            eventFeatures: trafficEventGeoJSON.features,
            signalFeatures: overlayData.trafficSignals?.features,
          })
        : emptyFeatureCollection();

    updateGeoJsonSource(mapInstance, "trafficHeatmap", visibleTrafficHeatmap);

    return undefined;
  }, [
    mapReady,
    automaticTrafficHotspots,
    overlayData.trafficSignals,
    persistentRoutingHotspots,
    route,
    showTrafficLayers,
    simulation,
    simulationMode,
    trafficEventGeoJSON,
    trafficHeatmapEnabled,
  ]);

  useEffect(() => {
    const mapInstance = mapRef.current;

    if (!mapReady || !mapInstance) {
      return undefined;
    }

    updateGeoJsonSource(
      mapInstance,
      "waterPressureHeatmap",
      showWaterLayers && waterHeatmapEnabled
        ? buildWaterPressureHeatmapGeoJSON(waterState.districts)
        : emptyFeatureCollection(),
    );
    updateGeoJsonSource(
      mapInstance,
      "waterIncidentHeatmap",
      showWaterLayers && waterHeatmapEnabled
        ? buildWaterIncidentHeatmapGeoJSON({
            districts: waterState.districts,
            incidents: waterIncidents,
          })
        : emptyFeatureCollection(),
    );

    return undefined;
  }, [
    mapReady,
    showWaterLayers,
    waterHeatmapEnabled,
    waterIncidents,
    waterState.districts,
  ]);

  useEffect(() => {
    let cancelled = false;
    let resizeObserver;

    async function initializeMap() {
      if (!mapContainerRef.current || mapRef.current) {
        return;
      }

      const protocol = getPmtilesProtocol();
      const pmtilesUrl = new URL(PMTILES_PATH, window.location.origin).toString();
      const archive = new PMTiles(pmtilesUrl);
      protocol.add(archive);

      const mapInstance = new maplibregl.Map({
        container: mapContainerRef.current,
        style: createStyle(pmtilesUrl),
        center: BENGALURU_CENTER,
        zoom: 12,
        pitch: 46,
        bearing: -14,
        maxBounds: MAP_LIMIT_BOUNDS,
        antialias: true,
      });

      mapRef.current = mapInstance;

      if (import.meta.env.DEV) {
        window.__DT_MAP__ = mapInstance;
      }

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          mapInstance.resize();
        });
        resizeObserver.observe(mapContainerRef.current);
      }

      mapInstance.on("click", handleMapPick);
      mapInstance.on("dblclick", "campus-fill", handleCampusDoubleClick);
      mapInstance.on("dblclick", "campus-buildings-3d", handleCampusDoubleClick);
      mapInstance.on("dblclick", "campus-labels", handleCampusDoubleClick);

      mapInstance.on("load", async () => {
        if (cancelled) {
          return;
        }

        try {
          await ensureMapImages(mapInstance);
        } catch (error) {
          console.error("Failed to load map icons", error);
        }

        if (cancelled) {
          return;
        }

        mapInstance.resize();
        mapInstance.fitBounds(MAP_VIEW_BOUNDS, {
          padding: getMapPadding(),
          duration: 0,
          maxZoom: 12.75,
          pitch: 46,
          bearing: -14,
        });

        setMapReady(true);

        attachCursor(mapInstance, "civic-points", pickModeRef);
        attachCursor(mapInstance, "civic-labels", pickModeRef);
        attachCursor(mapInstance, "campus-fill", pickModeRef);
        attachCursor(mapInstance, "campus-buildings-3d", pickModeRef);
        attachCursor(mapInstance, "campus-labels", pickModeRef);
        attachCursor(mapInstance, "traffic-event-zones-fill", pickModeRef);
        attachCursor(mapInstance, "traffic-event-zones-outline", pickModeRef);
        attachCursor(mapInstance, "traffic-event-points", pickModeRef);
        attachCursor(mapInstance, "traffic-event-labels", pickModeRef);
        attachCursor(mapInstance, "city-analysis-circles", pickModeRef);
        attachCursor(mapInstance, "city-analysis-labels", pickModeRef);
        attachCursor(mapInstance, "traffic-signal-points", pickModeRef);
        attachCursor(mapInstance, "traffic-direction-cones", pickModeRef);
        attachCursor(mapInstance, "hotspot-fill", pickModeRef);
        attachCursor(mapInstance, "hotspot-centers", pickModeRef);
        attachCursor(mapInstance, "power-substations", pickModeRef);
        attachCursor(mapInstance, "power-transformers", pickModeRef);
        attachCursor(mapInstance, "water-reservoir-icons", pickModeRef);
        attachCursor(mapInstance, "water-valves", pickModeRef);
        attachHoverPopup(
          mapInstance,
          hoverPopupRef,
          ["civic-points", "civic-labels"],
          renderCivicFacilityPopupHtml,
        );
        attachHoverPopup(
          mapInstance,
          hoverPopupRef,
          ["hotspot-fill", "hotspot-centers"],
          renderHotspotPopupHtml,
        );
        attachHoverPopup(
          mapInstance,
          hoverPopupRef,
          [
            "traffic-event-zones-fill",
            "traffic-event-zones-outline",
            "traffic-event-points",
            "traffic-event-labels",
          ],
          renderTrafficEventPopupHtml,
        );
        attachHoverPopup(
          mapInstance,
          hoverPopupRef,
          ["city-analysis-circles", "city-analysis-labels"],
          renderCityAnalysisPopupHtml,
        );
        attachHoverPopup(
          mapInstance,
          hoverPopupRef,
          ["water-reservoir-icons"],
          renderWaterReservoirPopupHtml,
        );
        attachHoverPopup(
          mapInstance,
          hoverPopupRef,
          ["power-substations"],
          renderPowerSubstationPopupHtml,
        );
        bringPriorityLayersToFront(mapInstance);
      });
    }

    initializeMap();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      setMapReady(false);
      cancelAnimationFrame(animationFrameRef.current);
      vehicleRuntimeRef.current = new Map();

      if (mapRef.current) {
        hoverPopupRef.current?.remove();
        hoverPopupRef.current = null;
        mapRef.current.remove();
        mapRef.current = null;
      }

      if (import.meta.env.DEV && window.__DT_MAP__) {
        delete window.__DT_MAP__;
      }
    };
  }, []);

  useEffect(() => {
    vehicleRuntimeRef.current = new Map();
    cancelAnimationFrame(animationFrameRef.current);
    setPickState(null);

    startTransition(() => {
      setSimulation(null);
    });
  }, [simulationMode]);

  useEffect(() => {
    let cancelled = false;

    loadOfflineRouter()
      .then((loadedRouter) => {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setRouter(loadedRouter);
        });
      })
      .catch((error) => {
        console.error("Failed to load offline router", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!router || simulationMode !== "defined" || !startSelection || !endSelection) {
      startTransition(() => {
        setRoute(null);
      });
      return;
    }

    const routePlan = buildDefinedRoutePlan(startSelection, endSelection);
    const snappedStart = routePlan.routeStartCoordinate;
    const snappedEnd = routePlan.routeEndCoordinate;

    if (snappedStart[0] === snappedEnd[0] && snappedStart[1] === snappedEnd[1]) {
      startTransition(() => {
        setRoute(null);
      });
      return;
    }

    const nextRoute = buildRouteFromPlan(
      router,
      routePlan,
      persistentRoutingHotspots,
      trafficSignalSystem,
    );

    startTransition(() => {
      setRoute(nextRoute ?? null);
    });
  }, [
    endSelection,
    persistentRoutingHotspotsSignature,
    router,
    simulationMode,
    startSelection,
    trafficSignalSystem,
  ]);

  useEffect(() => {
    const currentSimulation = simulationRef.current;

    if (!router || !currentSimulation) {
      return;
    }

    const shouldRefreshPersistentRouting =
      currentSimulation.routingSignature !== persistentRoutingHotspotsSignature;
    const shouldRefreshAutomaticRouting =
      automaticTrafficHotspotsSignature &&
      currentSimulation.automaticRoutingSignature !== automaticTrafficHotspotsSignature;

    if (!shouldRefreshPersistentRouting && !shouldRefreshAutomaticRouting) {
      return;
    }

    const rerouteHotspots = shouldRefreshAutomaticRouting
      ? [...persistentRoutingHotspots, ...automaticTrafficHotspots]
      : persistentRoutingHotspots;

    const nextVehicles = rerouteSimulationVehicles({
      router,
      simulation: currentSimulation,
      runtimeByVehicleId: vehicleRuntimeRef.current,
      currentElapsedMs: simulationElapsedRef.current,
      hotspots: rerouteHotspots,
      trafficSignalSystem,
    });

    if (nextVehicles.length === 0) {
      return;
    }

    startTransition(() => {
      setSimulation((activeSimulation) => {
        if (!activeSimulation || activeSimulation !== currentSimulation) {
          return activeSimulation;
        }

        return {
          ...activeSimulation,
          routingSignature: persistentRoutingHotspotsSignature,
          automaticRoutingSignature: shouldRefreshAutomaticRouting
            ? automaticTrafficHotspotsSignature
            : activeSimulation.automaticRoutingSignature ?? "",
          routes: buildSimulationRoutes({ vehicles: nextVehicles }),
          vehicles: nextVehicles,
        };
      });
    });
  }, [
    automaticTrafficHotspotsSignature,
    persistentRoutingHotspotsSignature,
    router,
    trafficSignalSystem,
  ]);

  useEffect(() => {
    const mapInstance = mapRef.current;

    if (!mapReady || !mapInstance) {
      return undefined;
    }

    const visibleRoutes =
      !showTrafficLayers
        ? []
        : simulation?.routes?.length > 0
        ? simulation.routes
        : simulationMode === "defined" && route
          ? [route]
          : [];

    updateGeoJsonSource(mapInstance, "route", buildRoutesGeoJSON(visibleRoutes));

    return undefined;
  }, [mapReady, route, showTrafficLayers, simulation, simulationMode]);

  useEffect(() => {
    const mapInstance = mapRef.current;

    if (!mapReady || !mapInstance) {
      return undefined;
    }

    updateGeoJsonSource(
      mapInstance,
      "routeEndpoints",
      showTrafficLayers && simulationMode === "defined"
        ? buildPickedEndpointGeoJSON(startSelection, endSelection)
        : emptyFeatureCollection(),
    );

    return undefined;
  }, [endSelection, mapReady, showTrafficLayers, simulationMode, startSelection]);

  useEffect(() => {
    const mapInstance = mapRef.current;

    if (!mapReady || !mapInstance) {
      return undefined;
    }

    if (!simulation?.id || simulation.vehicles.length === 0) {
      vehicleRuntimeRef.current = new Map();
      updateGeoJsonSource(mapInstance, "vehicles", emptyFeatureCollection());
      updateGeoJsonSource(
        mapInstance,
        "trafficSignalActiveDirections",
        createEmptyTrafficSignalDisplay().activeDirections,
      );
      updateGeoJsonSource(
        mapInstance,
        "trafficSignalActivePoints",
        createEmptyTrafficSignalDisplay().activeSignals,
      );

      if (vehicleProbeRef.current?.count) {
        const nextProbe = {
          ...vehicleProbeRef.current,
          count: 0,
        };
        vehicleProbeRef.current = nextProbe;
        startTransition(() => {
          setVehicleProbe(nextProbe);
        });
      }

      if (trafficHotspotSignatureRef.current || automaticTrafficHotspotsRef.current.length > 0) {
        trafficHotspotSignatureRef.current = "";
        automaticTrafficHotspotsRef.current = [];
        startTransition(() => {
          setAutomaticTrafficHotspots([]);
        });
      }
      return undefined;
    }

    cancelAnimationFrame(animationFrameRef.current);
    let startedAt = 0;
    let lastTrafficHotspotRefreshMs = -TRAFFIC_HOTSPOT_REFRESH_MS;
    const runtimeByVehicleId = new Map();
    vehicleRuntimeRef.current = runtimeByVehicleId;
    const activeSimulationId = simulation.id;

    const animate = (timestamp) => {
      const activeSimulation = simulationRef.current;

      if (!activeSimulation || activeSimulation.id !== activeSimulationId) {
        return;
      }

      if (startedAt === 0) {
        startedAt = timestamp;
      }

      const elapsedSinceStart = Math.max(0, timestamp - startedAt);
      simulationElapsedRef.current = elapsedSinceStart;
      const features = [];
      let completedVehicles = 0;

      activeSimulation.vehicles.forEach((vehicle) => {
        const routeMetrics = vehicle.route.metrics;
        const routeLength = routeMetrics.totalDistanceMeters;

        if (vehicle.parked || routeLength <= 0) {
          const parkedCoordinate =
            routeMetrics.path[routeMetrics.path.length - 1] ?? vehicle.targetCoordinate;

          runtimeByVehicleId.set(vehicle.id, {
            coordinate: parkedCoordinate,
            bearing: 0,
            completed: true,
            distanceMeters: routeLength,
            remainingLaunchDelayMs: 0,
          });
          completedVehicles += 1;

          if (parkedCoordinate) {
            features.push({
              type: "Feature",
              geometry: {
                type: "Point",
                coordinates: parkedCoordinate,
              },
              properties: {
                id: vehicle.id,
                routeId: vehicle.routeId,
                color: vehicle.color,
                bearing: 0,
              },
            });
          }

          return;
        }

        const routeActivatedAtMs = vehicle.routeActivatedAtMs ?? vehicle.launchDelayMs ?? 0;
        const remainingLaunchDelayMs = Math.max(0, routeActivatedAtMs - elapsedSinceStart);
        if (remainingLaunchDelayMs > 0) {
          runtimeByVehicleId.set(vehicle.id, {
            coordinate: null,
            bearing: 0,
            completed: false,
            distanceMeters: 0,
            remainingLaunchDelayMs,
          });
          return;
        }

        const travelTimeMs = Math.max(0, elapsedSinceStart - routeActivatedAtMs);
        const distanceMeters = Math.min(vehicle.speedMetersPerMs * travelTimeMs, routeLength);
        const position =
          getPointAtDistance(routeMetrics, distanceMeters) ??
          getPointAtDistance(routeMetrics, 0) ?? {
            coordinates: routeMetrics.path[0],
            bearing: 0,
          };
        const completed = distanceMeters >= routeLength;

        runtimeByVehicleId.set(vehicle.id, {
          coordinate: position.coordinates,
          bearing: position.bearing,
          completed,
          distanceMeters,
          remainingLaunchDelayMs,
        });

        if (position.coordinates) {
          features.push({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: position.coordinates,
            },
            properties: {
              id: vehicle.id,
              routeId: vehicle.routeId,
              color: vehicle.color,
              bearing: position.bearing,
            },
          });
        }

        if (completed) {
          completedVehicles += 1;
        }
      });

      const trafficVisible = activeSectionRef.current === "traffic";
      updateGeoJsonSource(
        mapInstance,
        "vehicles",
        trafficVisible
          ? {
              type: "FeatureCollection",
              features,
            }
          : emptyFeatureCollection(),
      );
      const liveTrafficSignalDisplay = trafficVisible
        ? buildLiveTrafficSignalDisplay(
            trafficSignalSystemRef.current,
            activeSimulation,
            runtimeByVehicleId,
          )
        : createEmptyTrafficSignalDisplay();
      updateGeoJsonSource(
        mapInstance,
        "trafficSignalActiveDirections",
        liveTrafficSignalDisplay.activeDirections,
      );
      updateGeoJsonSource(
        mapInstance,
        "trafficSignalActivePoints",
        liveTrafficSignalDisplay.activeSignals,
      );
      updateGeoJsonSource(
        mapInstance,
        "trafficHeatmap",
        trafficVisible && trafficHeatmapEnabledRef.current
          ? buildTrafficHeatmapGeoJSON({
              routes: activeSimulation.routes,
              vehicleFeatures: features,
              hotspots: [
                ...hotspotsRef.current,
                ...automaticTrafficHotspotsRef.current,
                ...buildSynthverseEventHotspots(synthverseApiState.approvedEvents),
              ],
              eventFeatures: trafficEventFeaturesRef.current,
              signalFeatures: trafficSignalFeaturesRef.current,
            })
          : emptyFeatureCollection(),
      );

      if (
        elapsedSinceStart >= TRAFFIC_HOTSPOT_ACTIVATION_DELAY_MS &&
        elapsedSinceStart - lastTrafficHotspotRefreshMs >= TRAFFIC_HOTSPOT_REFRESH_MS
      ) {
        lastTrafficHotspotRefreshMs = elapsedSinceStart;
        const nextAutomaticTrafficHotspots = buildAutomaticTrafficHotspots(runtimeByVehicleId);
        const nextTrafficHotspotSignature = nextAutomaticTrafficHotspots
          .map((hotspot) => `${hotspot.id}:${hotspot.vehicleCount}`)
          .join("|");

        if (nextTrafficHotspotSignature !== trafficHotspotSignatureRef.current) {
          trafficHotspotSignatureRef.current = nextTrafficHotspotSignature;
          automaticTrafficHotspotsRef.current = nextAutomaticTrafficHotspots;
          startTransition(() => {
            setAutomaticTrafficHotspots(nextAutomaticTrafficHotspots);
          });
        }
      }

      if (vehicleProbeRef.current) {
        const nextCount = countVehicleFeaturesInRadius(
          features,
          vehicleProbeRef.current.coordinate,
          vehicleProbeRef.current.radiusMeters,
        );

        if (nextCount !== vehicleProbeRef.current.count) {
          const nextProbe = {
            ...vehicleProbeRef.current,
            count: nextCount,
          };
          vehicleProbeRef.current = nextProbe;
          startTransition(() => {
            setVehicleProbe((currentProbe) =>
              currentProbe
                ? {
                    ...currentProbe,
                    count: nextCount,
                  }
                : currentProbe,
            );
          });
        }
      }

      if (completedVehicles < activeSimulation.vehicles.length) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationFrameRef.current);

      if (vehicleRuntimeRef.current === runtimeByVehicleId) {
      vehicleRuntimeRef.current = new Map();
      simulationElapsedRef.current = 0;
      }

      updateGeoJsonSource(mapInstance, "vehicles", emptyFeatureCollection());
      updateGeoJsonSource(
        mapInstance,
        "trafficSignalActiveDirections",
        createEmptyTrafficSignalDisplay().activeDirections,
      );
      updateGeoJsonSource(
        mapInstance,
        "trafficSignalActivePoints",
        createEmptyTrafficSignalDisplay().activeSignals,
      );
      updateGeoJsonSource(mapInstance, "trafficHeatmap", emptyFeatureCollection());
    };
  }, [
    mapReady,
    simulation?.id,
  ]);

  useEffect(() => {
    if (!vehicleProbeRef.current) {
      return;
    }

    const radiusMeters = normalizeVehicleProbeRadius(vehicleProbeRadiusInput);
    const count = countRuntimeVehiclesInRadius(
      vehicleRuntimeRef.current,
      vehicleProbeRef.current.coordinate,
      radiusMeters,
    );
    const nextProbe = {
      ...vehicleProbeRef.current,
      radiusMeters,
      count,
    };
    vehicleProbeRef.current = nextProbe;

    startTransition(() => {
      setVehicleProbe(nextProbe);
    });
  }, [vehicleProbeRadiusInput]);

  const isDefinedMode = simulationMode === "defined";
  const vehicleCount = normalizeVehicleCount(vehicleCountInput);
  const trafficClusterSummary =
    automaticTrafficHotspots.length > 0
      ? `${automaticTrafficHotspots.length} live traffic cluster${
          automaticTrafficHotspots.length === 1 ? "" : "s"
        } rerouting vehicles`
      : null;
  const vehicleProbeSummary = vehicleProbe
    ? `${vehicleProbe.count} vehicle${vehicleProbe.count === 1 ? "" : "s"} within ${Math.round(
        vehicleProbe.radiusMeters,
      )} m of ${vehicleProbe.label}`
    : null;
  const canStart =
    !!router &&
    vehicleCount > 0 &&
    (isDefinedMode ? !!route : overlayData.boundary.features.length > 0);
  const canClear =
    !!simulation ||
    !!route ||
    !!startSelection ||
    !!endSelection ||
    !!pickMode ||
    !!vehicleProbe ||
    hotspots.length > 0 ||
    automaticTrafficHotspots.length > 0 ||
    waterIncidents.length > 0 ||
    powerIncidents.length > 0;
  const waterStatusLabel =
    waterIncidents.length > 0
      ? `${waterIncidents.length} manual water fault${waterIncidents.length > 1 ? "s" : ""}`
      : "Network stable";
  const powerStatusLabel =
    powerIncidents.length > 0
      ? `${powerIncidents.length} manual power fault${powerIncidents.length > 1 ? "s" : ""}`
      : "Grid stable";
  const trafficStats = buildTrafficStatsSnapshot({
    sampleId: statsSampleId,
    simulation,
    route,
    runtimeByVehicleId: vehicleRuntimeRef.current,
    hotspots,
    automaticTrafficHotspots,
    vehicleProbe,
    overlayData,
    synthverseApiState,
  });
  const waterStats = buildWaterStatsSnapshot({
    sampleId: statsSampleId,
    waterState,
    waterGridDisplay,
    waterIncidents,
    overlayData,
  });
  const powerStats = buildPowerStatsSnapshot({
    sampleId: statsSampleId,
    powerState,
    powerGridDisplay,
    powerIncidents,
    overlayData,
  });
  const analysisStats = buildAnalysisStatsSnapshot({
    sampleId: statsSampleId,
    cityAnalysisState,
  });

  return (
    <main className={`app${statsPanelCollapsed ? " is-stats-collapsed" : ""}`}>
      <div ref={mapContainerRef} className="map" />
      <MapLegend
        activeSection={activeSection}
        statsPanelCollapsed={statsPanelCollapsed}
      />

      <ControlPanel
        activeSection={activeSection}
        onActiveSectionChange={setActiveSection}
        vehicleCountInput={vehicleCountInput}
        onVehicleCountChange={setVehicleCountInput}
        vehicleProbeRadiusInput={vehicleProbeRadiusInput}
        onVehicleProbeRadiusChange={setVehicleProbeRadiusInput}
        vehicleProbeSummary={vehicleProbeSummary}
        trafficClusterSummary={trafficClusterSummary}
        onSimulationModeChange={setSimulationMode}
        trafficHeatmapEnabled={trafficHeatmapEnabled}
        onTrafficHeatmapEnabledChange={setTrafficHeatmapEnabled}
        synthverseApiConnected={synthverseApiState.connected}
        synthverseApprovedEvents={synthverseApiState.approvedEvents}
        hotspotRadiusInput={hotspotRadiusInput}
        onHotspotRadiusChange={setHotspotRadiusInput}
        waterHour={waterHour}
        onWaterHourChange={setWaterHour}
        waterMetric={waterMetric}
        onWaterMetricChange={setWaterMetric}
        waterHeatmapEnabled={waterHeatmapEnabled}
        onWaterHeatmapEnabledChange={setWaterHeatmapEnabled}
        waterStatusLabel={waterStatusLabel}
        waterSummary={waterState.summary}
        waterIncidents={waterIncidents}
        onDeleteWaterIncident={handleDeleteWaterIncident}
        powerHour={powerHour}
        onPowerHourChange={setPowerHour}
        powerMetric={powerMetric}
        onPowerMetricChange={setPowerMetric}
        powerStatusLabel={powerStatusLabel}
        powerSummary={powerState.summary}
        powerIncidents={powerIncidents}
        onDeletePowerIncident={handleDeletePowerIncident}
        cityAnalysisState={cityAnalysisState}
        pickMode={pickMode}
        onTogglePickMode={togglePickMode}
        hotspots={hotspots}
        onDeleteHotspot={handleDeleteHotspot}
        isDefinedMode={isDefinedMode}
        startSelection={startSelection}
        endSelection={endSelection}
        onResetStart={handleResetStart}
        onResetEnd={handleResetEnd}
        onZoomToCampus={handleZoomToCampus}
        canPickFromMap={mapReady && !!router && showTrafficLayers}
        canPickWaterFromMap={mapReady && showWaterLayers}
        canPickPowerFromMap={mapReady && showPowerLayers}
        canStart={canStart}
        canClear={canClear}
        onStart={handleStart}
        onClear={handleClear}
      />

      <StatsPanel
        activeSection={activeSection}
        collapsed={statsPanelCollapsed}
        onToggle={() => {
          setStatsPanelCollapsed((currentValue) => !currentValue);
        }}
        trafficStats={trafficStats}
        waterStats={waterStats}
        powerStats={powerStats}
        analysisStats={analysisStats}
      />

      <CampusFloorplanModal
        open={campusFloorplanState.open}
        campusLabel={campusFloorplanState.campusLabel}
        loading={campusFloorplanState.loading}
        error={campusFloorplanState.error}
        nodes={campusFloorplanState.nodes}
        sensors={campusFloorplanState.sensors}
        lastSyncAt={campusFloorplanState.lastSyncAt}
        onClose={handleCloseCampusFloorplan}
      />
    </main>
  );
}

export default App;

function formatSyncTimeLabel(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return ` · ${date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })}`;
}

function getBmsceCampusCenterCoordinate() {
  return [
    (BMSCE_CAMPUS_BOUNDS[0][0] + BMSCE_CAMPUS_BOUNDS[1][0]) / 2,
    (BMSCE_CAMPUS_BOUNDS[0][1] + BMSCE_CAMPUS_BOUNDS[1][1]) / 2,
  ];
}

function buildCampusEmergencyAlertGeoJSON({ center, temperature }) {
  if (!Array.isArray(center)) {
    return emptyFeatureCollection();
  }

  const radiusMeters = 185;

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [buildEmergencyCircleCoordinates(center, radiusMeters)],
        },
        properties: {
          id: "campus-emergency:bmsce",
          label: "BMSCE Emergency",
          temperature,
          radiusMeters,
        },
      },
    ],
  };
}

function buildCampusEmergencyRoutes({ campusCenter, civic, router }) {
  if (!Array.isArray(campusCenter) || !router) {
    return [];
  }

  const civicFeatures = Array.isArray(civic?.features) ? civic.features : [];
  const resourceTypes = ["hospital", "fire", "police"];

  return resourceTypes
    .map((assetType) => {
      const candidates = civicFeatures
        .filter((feature) => feature?.properties?.assetType === assetType)
        .map((feature) => ({
          feature,
          coordinate: feature?.geometry?.coordinates,
        }))
        .filter((candidate) => Array.isArray(candidate.coordinate))
        .sort(
          (left, right) =>
            metersBetween(campusCenter, left.coordinate) - metersBetween(campusCenter, right.coordinate),
        );

      const nearest = candidates[0];

      if (!nearest) {
        return null;
      }

      const routeStart = router.nearestRoadCoordinate(campusCenter) ?? campusCenter;
      const routeEnd = router.nearestRoadCoordinate(nearest.coordinate) ?? nearest.coordinate;
      const routeResult = router.route(routeStart, routeEnd, []);
      const routeCoordinates = routeResult?.coordinates?.length
        ? mergeEmergencyCoordinates([campusCenter], routeResult.coordinates, [nearest.coordinate])
        : [campusCenter, nearest.coordinate];

      return {
        id: `campus-emergency-route:${assetType}`,
        assetType,
        label: nearest.feature?.properties?.label ?? assetType,
        coordinates: routeCoordinates,
      };
    })
    .filter(Boolean);
}

function buildCampusEmergencyRoutesGeoJSON(routes) {
  const features = (routes ?? []).map((route) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: route.coordinates,
    },
    properties: {
      id: route.id,
      assetType: route.assetType,
      label: route.label,
    },
  }));

  return features.length > 0
    ? {
        type: "FeatureCollection",
        features,
      }
    : emptyFeatureCollection();
}

function buildCampusEmergencyRouteTargetsGeoJSON(routes) {
  const features = (routes ?? [])
    .map((route) => {
      const destinationCoordinate = route.coordinates?.[route.coordinates.length - 1];

      if (!Array.isArray(destinationCoordinate)) {
        return null;
      }

      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: destinationCoordinate,
        },
        properties: {
          id: `${route.id}:target`,
          label: `${formatEmergencyAssetTypeLabel(route.assetType)} · ${route.label}`,
          assetType: route.assetType,
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

function buildCampusEmergencyRoutingHotspots(alertGeoJSON) {
  const feature = alertGeoJSON?.features?.[0];
  const center = getBmsceCampusCenterCoordinate();
  const temperature = Number(feature?.properties?.temperature ?? 0);
  const radiusMeters = Number(feature?.properties?.radiusMeters ?? 185);

  if (!feature || temperature < CAMPUS_EMERGENCY_TEMPERATURE) {
    return [];
  }

  return [
    {
      id: "campus-emergency-hotspot:bmsce",
      label: "BMSCE Emergency Zone",
      message: `Campus emergency\n${Math.round(temperature)} C`,
      coordinate: center,
      radiusMeters,
      kind: "campus-emergency",
      vehicleCount: 0,
      temperature,
    },
  ];
}

function buildCampusEmergencyRouteHotspots(routesGeoJSON) {
  const features = Array.isArray(routesGeoJSON?.features) ? routesGeoJSON.features : [];

  return features.flatMap((feature) => {
    const coordinates = feature?.geometry?.coordinates;
    const assetType = feature?.properties?.assetType ?? "responder";
    const label = feature?.properties?.label ?? capitalizeWord(assetType);

    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return [];
    }

    const sampledCoordinates = sampleEmergencyRouteHotspotCoordinates(coordinates);

    return sampledCoordinates.map((coordinate, index) => ({
      id: `${feature?.properties?.id ?? `campus-emergency-route:${assetType}`}:corridor:${index + 1}`,
      label: `${formatEmergencyAssetTypeLabel(assetType)} corridor`,
      message: `${formatEmergencyAssetTypeLabel(assetType)} route\n${label}`,
      coordinate,
      radiusMeters: 68,
      blocking: true,
      kind: "campus-emergency-route",
      vehicleCount: 0,
    }));
  });
}

function sampleEmergencyRouteHotspotCoordinates(coordinates) {
  const sampledCoordinates = [];
  let distanceSinceLastSample = 0;

  for (let index = 0; index < coordinates.length; index += 1) {
    const coordinate = coordinates[index];

    if (!Array.isArray(coordinate)) {
      continue;
    }

    if (sampledCoordinates.length === 0) {
      sampledCoordinates.push(coordinate);
      continue;
    }

    const previousCoordinate = coordinates[index - 1];

    if (!Array.isArray(previousCoordinate)) {
      continue;
    }

    distanceSinceLastSample += metersBetween(previousCoordinate, coordinate);

    const isLastCoordinate = index === coordinates.length - 1;

    if (distanceSinceLastSample >= 135 || isLastCoordinate) {
      sampledCoordinates.push(coordinate);
      distanceSinceLastSample = 0;
    }
  }

  return sampledCoordinates;
}

function buildRoutingHotspotSignature(hotspots) {
  return (hotspots ?? [])
    .map((hotspot) => {
      const coordinate = Array.isArray(hotspot?.coordinate) ? hotspot.coordinate : [0, 0];
      return [
        hotspot?.id ?? "",
        hotspot?.kind ?? "",
        hotspot?.radiusMeters ?? 0,
        hotspot?.blocking ? 1 : 0,
        Number(coordinate[0]).toFixed(6),
        Number(coordinate[1]).toFixed(6),
      ].join(":");
    })
    .sort()
    .join("|");
}

function buildEmergencyCircleCoordinates(center, radiusMeters, stepCount = 48) {
  const coordinates = [];

  for (let step = 0; step <= stepCount; step += 1) {
    const bearingDegrees = (step / stepCount) * 360;
    coordinates.push(offsetEmergencyCoordinate(center, radiusMeters, bearingDegrees));
  }

  return coordinates;
}

function offsetEmergencyCoordinate(origin, distanceMeters, bearingDegrees) {
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

function mergeEmergencyCoordinates(...lists) {
  const coordinates = [];

  lists.flat().forEach((coordinate) => {
    if (!Array.isArray(coordinate)) {
      return;
    }

    const previous = coordinates[coordinates.length - 1];

    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
      coordinates.push(coordinate);
    }
  });

  return coordinates;
}

function buildCityAnalysisGridCoordinates(bounds, rowCount = 4, columnCount = 5) {
  const southWest = bounds?.[0];
  const northEast = bounds?.[1];

  if (!Array.isArray(southWest) || !Array.isArray(northEast)) {
    return [BENGALURU_CENTER];
  }

  const [west, south] = southWest;
  const [east, north] = northEast;
  const longitudeInset = (east - west) * 0.08;
  const latitudeInset = (north - south) * 0.08;
  const effectiveWest = west + longitudeInset;
  const effectiveEast = east - longitudeInset;
  const effectiveSouth = south + latitudeInset;
  const effectiveNorth = north - latitudeInset;
  const coordinates = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      if (coordinates.length >= CITY_ANALYSIS_MAX_CALLS) {
        return coordinates;
      }

      const longitude =
        effectiveWest +
        ((columnIndex + 0.5) / columnCount) * (effectiveEast - effectiveWest);
      const latitude =
        effectiveSouth +
        ((rowIndex + 0.5) / rowCount) * (effectiveNorth - effectiveSouth);
      coordinates.push([longitude, latitude]);
    }
  }

  return coordinates;
}

function capitalizeWord(value) {
  const text = `${value ?? ""}`;
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}

function formatEmergencyAssetTypeLabel(assetType) {
  if (assetType === "police") {
    return "Police Station";
  }

  if (assetType === "fire") {
    return "Fire Station";
  }

  if (assetType === "hospital") {
    return "Hospital";
  }

  return capitalizeWord(assetType);
}

const PRIORITY_LAYER_IDS = [
  "campus-emergency-fill",
  "campus-emergency-outline",
  "campus-emergency-target-points",
  "campus-emergency-target-labels",
  "traffic-event-zones-fill",
  "traffic-event-zones-outline",
  "traffic-event-points",
  "traffic-event-labels",
  "city-analysis-circles",
  "city-analysis-labels",
  "hotspot-fill",
  "hotspot-outline",
  "hotspot-centers",
  "hotspot-labels",
  "water-break-halo",
  "water-break-point",
  "water-reservoir-icons",
  "power-incident-halo",
  "power-incident-point",
  "power-substations",
];

function bringPriorityLayersToFront(mapInstance) {
  PRIORITY_LAYER_IDS.forEach((layerId) => {
    if (mapInstance.getLayer(layerId)) {
      mapInstance.moveLayer(layerId);
    }
  });
}

function attachHoverPopup(mapInstance, popupRef, layerIds, renderHtml) {
  layerIds.forEach((layerId) => {
    mapInstance.on("mouseenter", layerId, (event) => {
      const feature = event.features?.[0];

      if (!feature) {
        return;
      }

      const popup =
        popupRef.current ??
        new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          className: "map-hover-popup",
          offset: 14,
        });
      popupRef.current = popup;
      popup.setLngLat(event.lngLat).setHTML(renderHtml(feature.properties ?? {})).addTo(mapInstance);
    });

    mapInstance.on("mousemove", layerId, (event) => {
      const feature = event.features?.[0];

      if (!feature || !popupRef.current) {
        return;
      }

      popupRef.current
        .setLngLat(event.lngLat)
        .setHTML(renderHtml(feature.properties ?? {}));
    });

    mapInstance.on("mouseleave", layerId, () => {
      popupRef.current?.remove();
    });
  });
}

function renderHotspotPopupHtml(properties) {
  const title = escapeHtml(
    properties.kind === "automatic" ? "Traffic congestion cluster" : "Manual traffic hotspot",
  );
  const label = escapeHtml(properties.detail ?? properties.label ?? "Hotspot");
  const details = [
    `Radius · ${formatPopupValue(properties.radiusMeters, "m")}`,
    properties.kind === "automatic"
      ? `Vehicles · ${formatPopupValue(properties.vehicleCount)}`
      : null,
  ].filter(Boolean);

  return buildPopupHtml(title, label, details);
}

function renderCivicFacilityPopupHtml(properties) {
  const assetType = `${properties.assetType ?? ""}`;
  const title = escapeHtml(properties.displayName ?? properties.label ?? "Facility");
  const subtitle = escapeHtml(
    assetType === "hospital"
      ? "Hospital"
      : assetType === "police"
        ? "Police Station"
        : assetType === "fire"
          ? "Fire Station"
          : "Bengaluru civic facility",
  );
  const details = Object.entries(properties ?? {})
    .filter(([_, value]) => value !== null && value !== undefined && `${value}`.trim() !== "")
    .map(([key, value]) => `${formatPopupPropertyLabel(key)} · ${value}`)
    .filter((detail, index, list) => list.indexOf(detail) === index);

  return buildPopupHtml(title, subtitle, details);
}

function renderTrafficEventPopupHtml(properties) {
  const title = escapeHtml(properties.label ?? "Live event");
  const subtitle = escapeHtml(properties.locationLabel ?? "Bengaluru");
  const details = [
    properties.date ? `Date · ${escapeHtml(properties.date)}` : null,
    `Traffic score · ${formatPopupValue(properties.trafficScore)}`,
    `Expected crowd · ${formatPopupValue(properties.expectedCrowd)}`,
    properties.radiusMeters ? `Impact radius · ${formatPopupValue(properties.radiusMeters, "m")}` : null,
  ].filter(Boolean);

  return buildPopupHtml(title, subtitle, details);
}

function renderCityAnalysisPopupHtml(properties) {
  const title = escapeHtml(`Score ${formatPopupValue(properties.totalScore)}`);
  const subtitle = escapeHtml(properties.weakestSectorName ?? "City analysis sector");
  const details = [
    `Hospitals · ${formatPopupValue(properties.hospitals)}`,
    `Police stations · ${formatPopupValue(properties.policeStations)}`,
    `Fire stations · ${formatPopupValue(properties.fireStations)}`,
    `Weakest sector facilities · ${formatPopupValue(properties.weakestSectorFacilityCount)}`,
  ].filter(Boolean);

  return buildPopupHtml(title, subtitle, details);
}

function renderWaterReservoirPopupHtml(properties) {
  const title = escapeHtml(properties.label ?? "Reservoir");
  const subtitle = escapeHtml(
    properties.nodeType === "tank" ? "Storage tank" : "Reservoir / source node",
  );
  const details = [
    `Pressure · ${formatPopupValue(properties.pressureM, "m")}`,
    `Supply · ${formatPopupValue(properties.supplyPercent, "%")}`,
    properties.storagePct === null || properties.storagePct === undefined
      ? null
      : `Storage · ${formatPopupValue(properties.storagePct, "%")}`,
    `Demand · ${formatPopupValue(properties.downstreamDemandMLD, "MLD")}`,
  ].filter(Boolean);

  return buildPopupHtml(title, subtitle, details);
}

function renderPowerSubstationPopupHtml(properties) {
  const title = escapeHtml(properties.label ?? "Substation");
  const subtitle = escapeHtml("Power substation");
  const details = [
    `Voltage · ${formatPopupValue(properties.voltageKV, "kV")}`,
    `Supply · ${formatPopupValue(properties.supplyPercent, "%")}`,
    `Load · ${formatPopupValue(properties.downstreamDemandMW, "MW")}`,
  ].filter(Boolean);

  return buildPopupHtml(title, subtitle, details);
}

function buildPopupHtml(title, subtitle, details) {
  const detailHtml = details
    .map((detail) => `<div class="map-hover-popup-detail">${escapeHtml(detail)}</div>`)
    .join("");

  return `
    <div class="map-hover-popup-copy">
      <div class="map-hover-popup-title">${title}</div>
      <div class="map-hover-popup-subtitle">${subtitle}</div>
      ${detailHtml}
    </div>
  `;
}

function formatPopupValue(value, suffix = "") {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return "0";
  }

  const roundedValue =
    Math.abs(numericValue) >= 100 ? Math.round(numericValue) : Number(numericValue.toFixed(1));
  return suffix ? `${roundedValue} ${suffix}` : `${roundedValue}`;
}

function formatPopupPropertyLabel(value) {
  return `${value ?? ""}`
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
