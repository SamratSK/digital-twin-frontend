const LEGEND_ITEMS = {
  traffic: {
    title: "Traffic Legend",
    items: [
      { id: "cool", label: "Cool traffic", swatchClassName: "is-traffic-cool" },
      { id: "hot", label: "Hotspot / congestion", swatchClassName: "is-traffic-hot" },
      { id: "event", label: "Live event zone", swatchClassName: "is-event" },
      { id: "route", label: "Vehicle route", swatchClassName: "is-route" },
      { id: "signal", label: "Active signal arrow", swatchClassName: "is-signal" },
    ],
  },
  water: {
    title: "Water Legend",
    items: [
      { id: "low-pressure", label: "Low pressure", swatchClassName: "is-water-low" },
      { id: "high-pressure", label: "High pressure", swatchClassName: "is-water-high" },
      {
        id: "reservoir",
        label: "Reservoir / tank",
        iconSrc: "/icons/water-reservoir.png",
        iconAlt: "Water reservoir icon",
      },
      { id: "incident", label: "Pipe break / mishap heat", swatchClassName: "is-water-incident" },
    ],
  },
  energy: {
    title: "Energy Legend",
    items: [
      { id: "normal-load", label: "Normal load", swatchClassName: "is-energy-normal" },
      { id: "high-load", label: "High load", swatchClassName: "is-energy-high" },
      {
        id: "substation",
        label: "Substation",
        iconSrc: "/icons/power-substation.png",
        iconAlt: "Power substation icon",
      },
      { id: "fault", label: "Fault / outage", swatchClassName: "is-energy-fault" },
    ],
  },
};

export default function MapLegend({ activeSection, statsPanelCollapsed }) {
  const legend = LEGEND_ITEMS[activeSection] ?? LEGEND_ITEMS.traffic;

  return (
    <aside className={`map-legend${statsPanelCollapsed ? " is-stats-collapsed" : ""}`}>
      <div className="map-legend-title">{legend.title}</div>
      <div className="map-legend-list">
        {legend.items.map((item) => (
          <div key={item.id} className="map-legend-item">
            {item.iconSrc ? (
              <img className="map-legend-icon" src={item.iconSrc} alt={item.iconAlt} />
            ) : (
              <span className={`map-legend-swatch ${item.swatchClassName ?? ""}`} />
            )}
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
