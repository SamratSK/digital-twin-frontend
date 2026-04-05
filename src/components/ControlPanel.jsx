import { useEffect, useState } from "react";
import { Car, Droplets, Zap } from "lucide-react";
import { POWER_METRIC_OPTIONS } from "../data/offlinePower.js";
import { WATER_METRIC_OPTIONS } from "../data/offlineWater.js";

function ResetIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M4.8 8.2A5.7 5.7 0 1 1 6 14.7"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M4.6 4.8v3.9h3.9"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function SectionButton({ sectionId, label, activeSection, onActivate, children }) {
  const isActive = activeSection === sectionId;

  return (
    <button
      type="button"
      className={`sidebar-section-button${isActive ? " is-active" : ""}`}
      aria-label={label}
      title={label}
      onClick={() => onActivate(sectionId)}
    >
      <span className="sidebar-section-icon">{children}</span>
    </button>
  );
}

function Card({ title, children }) {
  return (
    <section className="control-card">
      <div className="control-card-title">{title}</div>
      {children}
    </section>
  );
}

function PanelIntro({ title, subtitle }) {
  return (
    <div className="panel-intro">
      <h3 className="panel-intro-title">{title}</h3>
      {subtitle ? <div className="panel-intro-subtitle">{subtitle}</div> : null}
    </div>
  );
}

export default function ControlPanel({
  activeSection,
  onActiveSectionChange,
  vehicleCountInput,
  onVehicleCountChange,
  vehicleProbeRadiusInput,
  onVehicleProbeRadiusChange,
  vehicleProbeSummary,
  trafficClusterSummary,
  onSimulationModeChange,
  trafficHeatmapEnabled,
  onTrafficHeatmapEnabledChange,
  synthverseApiConnected,
  synthverseApprovedEvents,
  hotspotRadiusInput,
  onHotspotRadiusChange,
  pickMode,
  onTogglePickMode,
  hotspots,
  onDeleteHotspot,
  isDefinedMode,
  startSelection,
  endSelection,
  onResetStart,
  onResetEnd,
  onZoomToCampus,
  canPickFromMap,
  canPickWaterFromMap,
  canPickPowerFromMap,
  waterHour,
  onWaterHourChange,
  waterMetric,
  onWaterMetricChange,
  waterHeatmapEnabled,
  onWaterHeatmapEnabledChange,
  waterStatusLabel,
  waterSummary,
  waterIncidents,
  onDeleteWaterIncident,
  powerHour,
  onPowerHourChange,
  powerMetric,
  onPowerMetricChange,
  powerStatusLabel,
  powerSummary,
  powerIncidents,
  onDeletePowerIncident,
  canStart,
  canClear,
  onStart,
  onClear,
}) {
  const [clockLabel, setClockLabel] = useState(() => formatDateTime(new Date()));
  const warningCount =
    (trafficClusterSummary ? 1 : 0) + waterIncidents.length + powerIncidents.length;
  const systemTone =
    warningCount >= 3 ? "critical" : warningCount > 0 ? "warning" : "operational";
  const systemLabel =
    systemTone === "critical"
      ? "CRITICAL"
      : systemTone === "warning"
        ? "WARNING"
        : "OPERATIONAL";

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setClockLabel(formatDateTime(new Date()));
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <>
      <header className="app-topbar">
        <div className="command-brand">
          <div className="command-title">Operation NEO</div>
          <div className="command-subtitle">Bengaluru Command</div>
        </div>

        <div className="command-clock">{clockLabel}</div>

        <div className={`command-status is-${systemTone}`}>
          <span>{systemLabel}</span>
        </div>
      </header>

      <aside className="app-sidebar">
        <div className="sidebar-rail">
          <SectionButton
            sectionId="traffic"
            label="Traffic"
            activeSection={activeSection}
            onActivate={onActiveSectionChange}
          >
            <Car />
          </SectionButton>
          <SectionButton
            sectionId="water"
            label="Water"
            activeSection={activeSection}
            onActivate={onActiveSectionChange}
          >
            <Droplets />
          </SectionButton>
          <SectionButton
            sectionId="energy"
            label="Energy"
            activeSection={activeSection}
            onActivate={onActiveSectionChange}
          >
            <Zap />
          </SectionButton>
        </div>

        <div className="sidebar-panel">
          {activeSection === "traffic" ? (
            <div className="sidebar-panel-body">
              <PanelIntro title="Traffic" subtitle="Routing, monitoring and hotspots" />

              <Card title="Hotspots">
                <div className="input-row">
                  <label className="input-label" htmlFor="hotspot-radius">
                    Radius
                  </label>
                  <input
                    id="hotspot-radius"
                    className="count-input"
                    inputMode="numeric"
                    type="number"
                    min="10"
                    step="10"
                    value={hotspotRadiusInput}
                    onChange={(event) => {
                      onHotspotRadiusChange(event.target.value);
                    }}
                  />
                </div>

                <button
                  type="button"
                  className={`pick-button${pickMode === "hotspot" ? " is-active" : ""}`}
                  onClick={() => onTogglePickMode("hotspot")}
                  disabled={!canPickFromMap}
                >
                  Add Manual Hotspot
                </button>

                {hotspots.length > 0 ? (
                  <div className="hotspot-list" aria-label="Hotspots">
                    {hotspots.map((hotspot, index) => (
                      <div key={hotspot.id} className="hotspot-item">
                        <span>
                          Hotspot {index + 1} · {hotspot.label}
                        </span>
                        <button
                          type="button"
                          className="hotspot-delete"
                          onClick={() => onDeleteHotspot(hotspot.id)}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="panel-empty">No manual hotspots</div>
                )}
              </Card>

              <Card title="Live Events">
                {synthverseApiConnected || synthverseApprovedEvents.length > 0 ? (
                  <>
                    <div className="water-summary" aria-label="Live traffic event summary">
                      <div className="summary-card">
                        <span>Live Events</span>
                        <strong>{synthverseApprovedEvents.length}</strong>
                      </div>
                      <div className="summary-card">
                        <span>Peak Score</span>
                        <strong>
                          {synthverseApprovedEvents.reduce(
                            (maxValue, event) =>
                              Math.max(maxValue, Number(event.traffic_score ?? 0)),
                            0,
                          )}
                        </strong>
                      </div>
                      <div className="summary-card">
                        <span>Status</span>
                        <strong>{synthverseApiConnected ? "Live" : "Cached"}</strong>
                      </div>
                    </div>

                    {synthverseApprovedEvents.length > 0 ? (
                      <div className="hotspot-list" aria-label="Approved Synthverse events">
                        {synthverseApprovedEvents.slice(0, 5).map((event) => (
                          <div key={event.id} className="api-event-item">
                            <div className="api-event-copy">
                              <span>{event.event_name}</span>
                              <small>
                                {event.venue_type ?? event.location ?? "Unknown"} · {event.date} · score{" "}
                                {event.traffic_score}
                              </small>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="panel-empty">No live events</div>
                    )}
                  </>
                ) : (
                  <div className="panel-empty">No live event feed available</div>
                )}
              </Card>

              <Card title="Simulation">
                <div className="mode-toggle" role="tablist" aria-label="Simulation mode">
                  <button
                    type="button"
                    className={`toggle-button${isDefinedMode ? " is-active" : ""}`}
                    onClick={() => onSimulationModeChange("defined")}
                  >
                    Defined
                  </button>
                  <button
                    type="button"
                    className={`toggle-button${!isDefinedMode ? " is-active" : ""}`}
                    onClick={() => onSimulationModeChange("randomized")}
                  >
                    Randomized
                  </button>
                </div>

                <div className="input-row">
                  <label className="input-label" htmlFor="vehicle-count">
                    Vehicles
                  </label>
                  <input
                    id="vehicle-count"
                    className="count-input"
                    inputMode="numeric"
                    type="number"
                    min="1"
                    step="1"
                    value={vehicleCountInput}
                    onChange={(event) => {
                      onVehicleCountChange(event.target.value);
                    }}
                  />
                </div>

                {isDefinedMode ? (
                  <>
                    <div className="picker-row">
                      <button
                        type="button"
                        className={`pick-button${pickMode === "start" ? " is-active" : ""}`}
                        onClick={() => onTogglePickMode("start")}
                        disabled={!canPickFromMap}
                      >
                        Pick Start
                      </button>

                      <div className={`selection-chip${startSelection ? "" : " is-empty"}`}>
                        <span>{startSelection?.label ?? "Not set"}</span>
                        <button
                          type="button"
                          className="icon-button"
                          onClick={onResetStart}
                          disabled={!startSelection}
                          aria-label="Reset start"
                        >
                          <ResetIcon />
                        </button>
                      </div>
                    </div>

                    <div className="picker-row">
                      <button
                        type="button"
                        className={`pick-button${pickMode === "end" ? " is-active" : ""}`}
                        onClick={() => onTogglePickMode("end")}
                        disabled={!canPickFromMap}
                      >
                        Pick End
                      </button>

                      <div className={`selection-chip${endSelection ? "" : " is-empty"}`}>
                        <span>{endSelection?.label ?? "Not set"}</span>
                        <button
                          type="button"
                          className="icon-button"
                          onClick={onResetEnd}
                          disabled={!endSelection}
                          aria-label="Reset end"
                        >
                          <ResetIcon />
                        </button>
                      </div>
                    </div>
                  </>
                ) : null}

                <div className="action-row">
                  <button
                    type="button"
                    className="navigate-button"
                    onClick={onStart}
                    disabled={!canStart}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    className="clear-button"
                    onClick={onClear}
                    disabled={!canClear}
                  >
                    Clear
                  </button>
                </div>

                <button type="button" className="campus-button" onClick={onZoomToCampus}>
                  Zoom to Campus
                </button>
              </Card>

              <Card title="Monitoring">
                <button
                  type="button"
                  className={`toggle-button heatmap-button${
                    trafficHeatmapEnabled ? " is-active" : ""
                  }`}
                  onClick={() => onTrafficHeatmapEnabledChange(!trafficHeatmapEnabled)}
                >
                  {trafficHeatmapEnabled ? "Hide Traffic Heatmap" : "Show Traffic Heatmap"}
                </button>

                <div className="input-row">
                  <label className="input-label" htmlFor="vehicle-probe-radius">
                    Probe
                  </label>
                  <input
                    id="vehicle-probe-radius"
                    className="count-input"
                    inputMode="numeric"
                    type="number"
                    min="25"
                    step="25"
                    value={vehicleProbeRadiusInput}
                    onChange={(event) => {
                      onVehicleProbeRadiusChange(event.target.value);
                    }}
                  />
                </div>

                <div className={`probe-alert${vehicleProbeSummary ? "" : " is-empty"}`}>
                  {vehicleProbeSummary ?? "Click map for live vehicle count"}
                </div>

                {trafficClusterSummary ? (
                  <div className="traffic-alert">{trafficClusterSummary}</div>
                ) : null}
              </Card>
            </div>
          ) : null}

          {activeSection === "water" ? (
            <div className="sidebar-panel-body">
              <PanelIntro
                title="Water Distribution"
                subtitle="Pressure, flow and network faults"
              />

              <Card title="Simulation">
                <button
                  type="button"
                  className={`toggle-button heatmap-button${
                    waterHeatmapEnabled ? " is-active" : ""
                  }`}
                  onClick={() => onWaterHeatmapEnabledChange(!waterHeatmapEnabled)}
                >
                  {waterHeatmapEnabled ? "Hide Water Heatmap" : "Show Water Heatmap"}
                </button>

                <div className="input-row">
                  <label className="input-label" htmlFor="water-metric">
                    Metric
                  </label>
                  <select
                    id="water-metric"
                    className="count-input"
                    value={waterMetric}
                    onChange={(event) => {
                      onWaterMetricChange(event.target.value);
                    }}
                  >
                    {WATER_METRIC_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="input-row">
                  <label className="input-label" htmlFor="water-hour">
                    Hour
                  </label>
                  <div className="slider-stack">
                    <input
                      id="water-hour"
                      className="slider-input"
                      type="range"
                      min="0"
                      max="23"
                      step="1"
                      value={waterHour}
                      onChange={(event) => {
                        onWaterHourChange(Number.parseInt(event.target.value, 10) || 0);
                      }}
                    />
                    <div className="hour-display">{formatHourLabel(waterHour)}</div>
                  </div>
                </div>

                {waterSummary ? (
                  <div className="water-summary" aria-label="Water summary">
                    <div className="summary-card">
                      <span>Demand</span>
                      <strong>{waterSummary.totalDemandMLD.toFixed(0)} MLD</strong>
                    </div>
                    <div className="summary-card">
                      <span>Pressure</span>
                      <strong>{waterSummary.averagePressureM.toFixed(0)} m</strong>
                    </div>
                    <div className="summary-card">
                      <span>Stress</span>
                      <strong>{waterSummary.stressedZoneCount} zones</strong>
                    </div>
                  </div>
                ) : null}

                <div
                  className={`water-alert${
                    waterStatusLabel !== "Network stable" ? " is-active" : ""
                  }`}
                >
                  {waterStatusLabel}
                </div>
              </Card>

              <Card title="Faults">
                <div className="action-row">
                  <button
                    type="button"
                    className={`pick-button${pickMode === "water-break" ? " is-active" : ""}`}
                    onClick={() => onTogglePickMode("water-break")}
                    disabled={!canPickWaterFromMap}
                  >
                    Pipe Break
                  </button>
                  <button
                    type="button"
                    className={`pick-button${
                      pickMode === "reservoir-failure" ? " is-active" : ""
                    }`}
                    onClick={() => onTogglePickMode("reservoir-failure")}
                    disabled={!canPickWaterFromMap}
                  >
                    Reservoir Fail
                  </button>
                </div>

                {waterIncidents.length > 0 ? (
                  <div className="hotspot-list" aria-label="Water incidents">
                    {waterIncidents.map((incident, index) => (
                      <div key={incident.id} className="water-incident-item">
                        <span>
                          Fault {index + 1} · {incident.label}
                        </span>
                        <button
                          type="button"
                          className="hotspot-delete"
                          onClick={() => onDeleteWaterIncident(incident.id)}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="panel-empty">No water faults</div>
                )}
              </Card>
            </div>
          ) : null}

          {activeSection === "energy" ? (
            <div className="sidebar-panel-body">
              <PanelIntro title="Power Grid" subtitle="Voltage, load and grid incidents" />

              <Card title="Simulation">
                <div className="input-row">
                  <label className="input-label" htmlFor="power-metric">
                    Metric
                  </label>
                  <select
                    id="power-metric"
                    className="count-input"
                    value={powerMetric}
                    onChange={(event) => {
                      onPowerMetricChange(event.target.value);
                    }}
                  >
                    {POWER_METRIC_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="input-row">
                  <label className="input-label" htmlFor="power-hour">
                    Hour
                  </label>
                  <div className="slider-stack">
                    <input
                      id="power-hour"
                      className="slider-input"
                      type="range"
                      min="0"
                      max="23"
                      step="1"
                      value={powerHour}
                      onChange={(event) => {
                        onPowerHourChange(Number.parseInt(event.target.value, 10) || 0);
                      }}
                    />
                    <div className="hour-display">{formatHourLabel(powerHour)}</div>
                  </div>
                </div>

                {powerSummary ? (
                  <div className="water-summary" aria-label="Power summary">
                    <div className="summary-card summary-card-power">
                      <span>Demand</span>
                      <strong>{powerSummary.totalDemandMW.toFixed(0)} MW</strong>
                    </div>
                    <div className="summary-card summary-card-power">
                      <span>Voltage</span>
                      <strong>{powerSummary.averageVoltageKV.toFixed(0)} kV</strong>
                    </div>
                    <div className="summary-card summary-card-power">
                      <span>Stress</span>
                      <strong>{powerSummary.stressedZoneCount} zones</strong>
                    </div>
                  </div>
                ) : null}

                <div
                  className={`power-alert${
                    powerStatusLabel !== "Grid stable" ? " is-active" : ""
                  }`}
                >
                  {powerStatusLabel}
                </div>
              </Card>

              <Card title="Faults">
                <div className="action-row">
                  <button
                    type="button"
                    className={`pick-button${
                      pickMode === "power-line-fault" ? " is-active" : ""
                    }`}
                    onClick={() => onTogglePickMode("power-line-fault")}
                    disabled={!canPickPowerFromMap}
                  >
                    Line Fault
                  </button>
                  <button
                    type="button"
                    className={`pick-button${
                      pickMode === "power-substation-outage" ? " is-active" : ""
                    }`}
                    onClick={() => onTogglePickMode("power-substation-outage")}
                    disabled={!canPickPowerFromMap}
                  >
                    Substation Out
                  </button>
                </div>

                {powerIncidents.length > 0 ? (
                  <div className="hotspot-list" aria-label="Power incidents">
                    {powerIncidents.map((incident, index) => (
                      <div key={incident.id} className="power-incident-item">
                        <span>
                          Fault {index + 1} · {incident.label}
                        </span>
                        <button
                          type="button"
                          className="hotspot-delete"
                          onClick={() => onDeletePowerIncident(incident.id)}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="panel-empty">No energy faults</div>
                )}
              </Card>
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function formatHourLabel(hour) {
  const normalizedHour = Number.parseInt(hour, 10) || 0;
  const suffix = normalizedHour >= 12 ? "PM" : "AM";
  const displayHour = normalizedHour % 12 || 12;
  return `${displayHour}:00 ${suffix}`;
}

function formatDateTime(value) {
  return value.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
