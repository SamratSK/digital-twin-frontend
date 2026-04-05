import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Droplets,
  Gauge,
  Route,
  ShieldAlert,
  Waves,
  Zap,
} from "lucide-react";

const HISTORY_LIMIT = 24;

function appendHistory(history, sample) {
  if (!sample || sample.sampleId === undefined || sample.sampleId === null) {
    return history;
  }

  if (history[history.length - 1]?.sampleId === sample.sampleId) {
    return history;
  }

  return [...history.slice(-(HISTORY_LIMIT - 1)), sample];
}

function StatTile({ label, value, detail }) {
  return (
    <div className="stats-tile">
      <div className="stats-tile-label">{label}</div>
      <div className="stats-tile-value">{value}</div>
      {detail ? <div className="stats-tile-detail">{detail}</div> : null}
    </div>
  );
}

function ChartCard({ title, subtitle, children }) {
  return (
    <section className="stats-card">
      <div className="stats-card-head">
        <div className="stats-card-title">{title}</div>
        {subtitle ? <div className="stats-card-subtitle">{subtitle}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Legend({ items }) {
  return (
    <div className="stats-legend">
      {items.map((item) => (
        <div key={item.label} className="stats-legend-item">
          <span className="stats-legend-swatch" style={{ background: item.color }} />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function buildLinePath(values, width, height, padding) {
  if (!Array.isArray(values) || values.length === 0) {
    return "";
  }

  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const maxValue = Math.max(...values, 1);
  const minValue = Math.min(...values, 0);
  const range = Math.max(maxValue - minValue, 1);

  return values
    .map((value, index) => {
      const x =
        padding +
        (values.length === 1 ? innerWidth / 2 : (innerWidth * index) / (values.length - 1));
      const y = padding + innerHeight - ((value - minValue) / range) * innerHeight;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function buildAreaPath(values, width, height, padding) {
  if (!Array.isArray(values) || values.length === 0) {
    return "";
  }

  const linePath = buildLinePath(values, width, height, padding);
  if (!linePath) {
    return "";
  }

  const innerWidth = width - padding * 2;
  const baselineY = height - padding;
  const endX =
    padding + (values.length === 1 ? innerWidth / 2 : innerWidth);

  return `${linePath} L ${endX.toFixed(2)} ${baselineY.toFixed(2)} L ${padding.toFixed(
    2,
  )} ${baselineY.toFixed(2)} Z`;
}

function LineChart({ primary = [], secondary = [], primaryColor, secondaryColor }) {
  const width = 280;
  const height = 132;
  const padding = 12;
  const maxLength = Math.max(primary.length, secondary.length);
  const primaryValues = maxLength > 0 ? primary : [0];
  const secondaryValues = maxLength > 0 ? secondary : [0];

  return (
    <svg className="stats-line-chart" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id="statsAreaPrimary" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={primaryColor} stopOpacity="0.24" />
          <stop offset="100%" stopColor={primaryColor} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {[0, 1, 2, 3].map((index) => {
        const y = padding + ((height - padding * 2) * index) / 3;
        return <line key={index} x1={padding} y1={y} x2={width - padding} y2={y} className="stats-grid-line" />;
      })}

      <path d={buildAreaPath(primaryValues, width, height, padding)} fill="url(#statsAreaPrimary)" />
      <path d={buildLinePath(primaryValues, width, height, padding)} fill="none" stroke={primaryColor} strokeWidth="2.5" />
      <path
        d={buildLinePath(secondaryValues, width, height, padding)}
        fill="none"
        stroke={secondaryColor}
        strokeWidth="2"
        strokeDasharray="5 4"
      />
    </svg>
  );
}

function BarListChart({ items, color }) {
  const maxValue = Math.max(...items.map((item) => item.value), 1);

  return (
    <div className="stats-bar-list">
      {items.map((item) => (
        <div key={item.label} className="stats-bar-row">
          <div className="stats-bar-meta">
            <span>{item.label}</span>
            <span>{item.detail}</span>
          </div>
          <div className="stats-bar-track">
            <div
              className="stats-bar-fill"
              style={{
                width: `${(item.value / maxValue) * 100}%`,
                background: color,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionHeader({ icon, title, subtitle }) {
  const Icon = icon;

  return (
    <div className="stats-section-header">
      <div className="stats-section-icon">
        <Icon />
      </div>
      <div className="stats-section-copy">
        <div className="stats-section-title">{title}</div>
        <div className="stats-section-subtitle">{subtitle}</div>
      </div>
    </div>
  );
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value ?? 0);
}

function formatOneDecimal(value) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
    value ?? 0,
  );
}

export default function StatsPanel({
  activeSection,
  collapsed,
  onToggle,
  trafficStats,
  waterStats,
  powerStats,
  analysisStats,
}) {
  const [history, setHistory] = useState({
    traffic: [],
    water: [],
    energy: [],
    analysis: [],
  });

  useEffect(() => {
    setHistory((current) => ({
      ...current,
      traffic: appendHistory(current.traffic, {
        sampleId: trafficStats.sampleId,
        primary: trafficStats.activeVehicles,
        secondary: trafficStats.completedVehicles,
        tertiary: trafficStats.liveClusterCount,
      }),
    }));
  }, [trafficStats.sampleId, trafficStats.activeVehicles, trafficStats.completedVehicles, trafficStats.liveClusterCount]);

  useEffect(() => {
    setHistory((current) => ({
      ...current,
      water: appendHistory(current.water, {
        sampleId: waterStats.sampleId,
        primary: waterStats.totalDemandMLD,
        secondary: waterStats.servedMLD,
        tertiary: waterStats.averagePressureM,
      }),
    }));
  }, [waterStats.sampleId, waterStats.totalDemandMLD, waterStats.servedMLD, waterStats.averagePressureM]);

  useEffect(() => {
    setHistory((current) => ({
      ...current,
      energy: appendHistory(current.energy, {
        sampleId: powerStats.sampleId,
        primary: powerStats.totalDemandMW,
        secondary: powerStats.servedMW,
        tertiary: powerStats.averageVoltageKV,
      }),
    }));
  }, [powerStats.sampleId, powerStats.totalDemandMW, powerStats.servedMW, powerStats.averageVoltageKV]);

  useEffect(() => {
    setHistory((current) => ({
      ...current,
      analysis: appendHistory(current.analysis, {
        sampleId: analysisStats.sampleId,
        primary: analysisStats.averageScore,
        secondary: analysisStats.weakestScore,
        tertiary: analysisStats.strongestScore,
      }),
    }));
  }, [analysisStats.sampleId, analysisStats.averageScore, analysisStats.weakestScore, analysisStats.strongestScore]);

  return (
    <aside className={`stats-panel${collapsed ? " is-collapsed" : ""}`}>
      <div className="stats-panel-shell">
        <button type="button" className="stats-panel-toggle" onClick={onToggle} aria-label={collapsed ? "Expand stats panel" : "Collapse stats panel"}>
          {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>

        {collapsed ? (
          <div className="stats-panel-collapsed-label">
            {activeSection === "traffic"
              ? "Traffic"
              : activeSection === "water"
                ? "Water"
                : activeSection === "energy"
                  ? "Energy"
                  : "Analysis"}
          </div>
        ) : (
          <div className="stats-panel-body">
            {activeSection === "traffic" ? (
              <>
                <SectionHeader
                  icon={Activity}
                  title="Traffic Analytics"
                  subtitle="Live movement, routing, signals and congestion"
                />

                <div className="stats-grid">
                  <StatTile label="Active" value={formatInteger(trafficStats.activeVehicles)} detail={`${formatInteger(trafficStats.totalVehicles)} total`} />
                  <StatTile label="Arrived" value={formatInteger(trafficStats.completedVehicles)} detail={`${formatOneDecimal(trafficStats.completionPercent)}% complete`} />
                  <StatTile label="Queued" value={formatInteger(trafficStats.queuedVehicles)} detail="Awaiting route execution" />
                  <StatTile label="Routes" value={formatInteger(trafficStats.routedVehicles)} detail={`${formatOneDecimal(trafficStats.avgRouteKm)} km avg`} />
                  <StatTile label="Signals" value={formatInteger(trafficStats.signalCount)} detail={`${formatInteger(trafficStats.directionCount)} directions`} />
                  <StatTile label="Clusters" value={formatInteger(trafficStats.liveClusterCount)} detail={`${formatInteger(trafficStats.liveClusterVehicles)} vehicles`} />
                  <StatTile label="Hotspots" value={formatInteger(trafficStats.manualHotspotCount)} detail="Manual avoidance zones" />
                  <StatTile label="Probe" value={formatInteger(trafficStats.probeCount)} detail="Vehicles in selected radius" />
                </div>

                <ChartCard title="Flow Timeline" subtitle="Active vehicles against arrivals">
                  <Legend
                    items={[
                      { label: "Active", color: "#2563eb" },
                      { label: "Arrived", color: "#16a34a" },
                    ]}
                  />
                  <LineChart
                    primary={history.traffic.map((item) => item.primary)}
                    secondary={history.traffic.map((item) => item.secondary)}
                    primaryColor="#2563eb"
                    secondaryColor="#16a34a"
                  />
                </ChartCard>

                <ChartCard title="Congestion Watch" subtitle="Live cluster size">
                  {trafficStats.clusters.length > 0 ? (
                    <BarListChart items={trafficStats.clusters} color="#dc2626" />
                  ) : (
                    <div className="stats-empty-state">No active traffic clusters</div>
                  )}
                </ChartCard>

                <ChartCard title="Network Support" subtitle="Civic assets on the map">
                  <div className="stats-grid stats-grid-compact">
                    <StatTile label="Hospitals" value={formatInteger(trafficStats.civicCounts.hospitals)} />
                    <StatTile label="Police" value={formatInteger(trafficStats.civicCounts.policeStations)} />
                    <StatTile label="Fire" value={formatInteger(trafficStats.civicCounts.fireStations)} />
                    <StatTile label="Distance" value={`${formatOneDecimal(trafficStats.avgDistanceKm)} km`} detail="Avg vehicle travel" />
                  </div>
                </ChartCard>

                <ChartCard title="Live Events" subtitle={trafficStats.apiStatusLabel}>
                  {trafficStats.apiConnected ||
                  trafficStats.pendingEventCount > 0 ||
                  trafficStats.approvedEventCount > 0 ? (
                    <div className="stats-grid stats-grid-compact">
                      <StatTile label="Live" value={formatInteger(trafficStats.approvedEventCount)} />
                      <StatTile label="Peak Score" value={formatInteger(trafficStats.peakEventTrafficScore)} detail="Highest event traffic score" />
                      <StatTile label="Backend" value={trafficStats.apiConnected ? "Live" : "Down"} detail="Feed status" />
                      <StatTile label="Feed" value={trafficStats.apiConnected ? "OK" : "Wait"} detail="Approved event stream" />
                    </div>
                  ) : (
                    <div className="stats-empty-state">No live event feed available.</div>
                  )}
                </ChartCard>
              </>
            ) : null}

            {activeSection === "water" ? (
              <>
                <SectionHeader
                  icon={Droplets}
                  title="Water Analytics"
                  subtitle="Pressure, demand, supply and outage impact"
                />

                <div className="stats-grid">
                  <StatTile label="Demand" value={`${formatOneDecimal(waterStats.totalDemandMLD)} MLD`} detail={`${formatOneDecimal(waterStats.servedMLD)} MLD served`} />
                  <StatTile label="Pressure" value={`${formatOneDecimal(waterStats.averagePressureM)} m`} detail={`${formatOneDecimal(waterStats.avgSupplyPercent)}% avg supply`} />
                  <StatTile label="Stress" value={formatInteger(waterStats.stressedZoneCount)} detail={`${formatInteger(waterStats.breakAffectedZoneCount)} affected`} />
                  <StatTile label="Incidents" value={formatInteger(waterStats.incidentCount)} detail="Manual failures" />
                  <StatTile label="Valves" value={formatInteger(waterStats.valveCount)} detail={`${formatInteger(waterStats.visiblePipeCount)} visible lines`} />
                  <StatTile label="Sources" value={formatInteger(waterStats.sourceCount)} detail={`${formatInteger(waterStats.tankCount)} tanks`} />
                  <StatTile label="Pumps" value={formatInteger(waterStats.pumpCount)} detail={`${formatInteger(waterStats.districtCount)} districts`} />
                  <StatTile label="Peak Util." value={`${formatOneDecimal(waterStats.peakPipeUtilizationPercent)}%`} detail="Highest pipe load" />
                </div>

                <ChartCard title="Demand vs Delivery" subtitle="Live water throughput">
                  <Legend
                    items={[
                      { label: "Demand", color: "#0ea5e9" },
                      { label: "Served", color: "#2563eb" },
                    ]}
                  />
                  <LineChart
                    primary={history.water.map((item) => item.primary)}
                    secondary={history.water.map((item) => item.secondary)}
                    primaryColor="#0ea5e9"
                    secondaryColor="#2563eb"
                  />
                </ChartCard>

                <ChartCard title="Pressure Watch" subtitle="Lowest-pressure districts">
                  {waterStats.topDistricts.length > 0 ? (
                    <BarListChart items={waterStats.topDistricts} color="#38bdf8" />
                  ) : (
                    <div className="stats-empty-state">Water layer is off</div>
                  )}
                </ChartCard>
              </>
            ) : null}

            {activeSection === "energy" ? (
              <>
                <SectionHeader
                  icon={Zap}
                  title="Energy Analytics"
                  subtitle="Voltage, load, supply and fault stress"
                />

                <div className="stats-grid">
                  <StatTile label="Demand" value={`${formatOneDecimal(powerStats.totalDemandMW)} MW`} detail={`${formatOneDecimal(powerStats.servedMW)} MW served`} />
                  <StatTile label="Voltage" value={`${formatOneDecimal(powerStats.averageVoltageKV)} kV`} detail={`${formatOneDecimal(powerStats.avgSupplyPercent)}% avg supply`} />
                  <StatTile label="Stress" value={formatInteger(powerStats.stressedZoneCount)} detail={`${formatInteger(powerStats.incidentCount)} incidents`} />
                  <StatTile label="Substations" value={formatInteger(powerStats.substationCount)} detail={`${formatInteger(powerStats.transformerCount)} transformers`} />
                  <StatTile label="Visible Lines" value={formatInteger(powerStats.visibleLineCount)} detail="Rendered grid segments" />
                  <StatTile label="Nodes" value={formatInteger(powerStats.activeSubstationNodeCount)} detail={`${formatInteger(powerStats.sourceCount)} sources`} />
                  <StatTile label="Districts" value={formatInteger(powerStats.districtCount)} detail="Monitored zones" />
                  <StatTile label="Peak Util." value={`${formatOneDecimal(powerStats.peakLineUtilizationPercent)}%`} detail="Highest line load" />
                </div>

                <ChartCard title="Demand vs Delivery" subtitle="Live power throughput">
                  <Legend
                    items={[
                      { label: "Demand", color: "#f59e0b" },
                      { label: "Served", color: "#ca8a04" },
                    ]}
                  />
                  <LineChart
                    primary={history.energy.map((item) => item.primary)}
                    secondary={history.energy.map((item) => item.secondary)}
                    primaryColor="#f59e0b"
                    secondaryColor="#ca8a04"
                  />
                </ChartCard>

                <ChartCard title="Voltage Watch" subtitle="Lowest-voltage districts">
                  {powerStats.topDistricts.length > 0 ? (
                    <BarListChart items={powerStats.topDistricts} color="#f59e0b" />
                  ) : (
                    <div className="stats-empty-state">Energy layer is off</div>
                  )}
                </ChartCard>
              </>
            ) : null}

            {activeSection === "analysis" ? (
              <>
                <SectionHeader
                  icon={BarChart3}
                  title="City Analysis"
                  subtitle="Sector resilience scores from backend sampling"
                />

                <div className="stats-grid">
                  <StatTile label="Samples" value={formatInteger(analysisStats.sampleCount)} detail={analysisStats.connected ? "Live score grid" : "Backend offline"} />
                  <StatTile label="Average" value={formatOneDecimal(analysisStats.averageScore)} detail="Average city resilience score" />
                  <StatTile label="Weakest" value={formatInteger(analysisStats.weakestScore)} detail={analysisStats.weakestSectorName} />
                  <StatTile label="Strongest" value={formatInteger(analysisStats.strongestScore)} detail={analysisStats.strongestSectorName} />
                  <StatTile label="Hospitals" value={formatInteger(analysisStats.hospitals)} detail="Total across sampled sectors" />
                  <StatTile label="Police" value={formatInteger(analysisStats.policeStations)} detail="Total across sampled sectors" />
                  <StatTile label="Fire" value={formatInteger(analysisStats.fireStations)} detail="Total across sampled sectors" />
                  <StatTile label="Weakest Cap." value={formatInteger(analysisStats.weakestSectorFacilityCount)} detail="Facilities in weakest sector" />
                </div>

                <ChartCard title="Score Timeline" subtitle={analysisStats.lastSyncAt ? `Updated ${new Date(analysisStats.lastSyncAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}` : "Awaiting backend data"}>
                  <Legend
                    items={[
                      { label: "Average", color: "#2563eb" },
                      { label: "Weakest", color: "#dc2626" },
                    ]}
                  />
                  <LineChart
                    primary={history.analysis.map((item) => item.primary)}
                    secondary={history.analysis.map((item) => item.secondary)}
                    primaryColor="#2563eb"
                    secondaryColor="#dc2626"
                  />
                </ChartCard>

                <ChartCard title="Weakest Sector Watch" subtitle={analysisStats.error ? analysisStats.error : "Lowest scoring sampled sectors"}>
                  {analysisStats.weakestSectors.length > 0 ? (
                    <BarListChart items={analysisStats.weakestSectors} color="#f97316" />
                  ) : (
                    <div className="stats-empty-state">No city score data</div>
                  )}
                </ChartCard>
              </>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}
