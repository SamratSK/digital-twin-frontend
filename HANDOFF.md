# Bengaluru Digital Twin Handoff

Project path: `/Users/kantheshamurthy/Desktop/digital-twin`

## Stack
- React + Vite
- MapLibre GL
- PMTiles
- Fully offline local data

## Primary Goal
- Real 3D Bengaluru map
- Offline civic / traffic / water / energy simulation layers
- Operations-style dashboard UI
- Vehicle routing on real road graph
- Direction-aware traffic signals
- Manual and automatic congestion / hotspot handling

## Current UI
- Dark operations dashboard inspired by a tactical command interface
- Top command bar
- Fixed left sidebar
- Sidebar has `Traffic` / `Water` / `Energy` icons
- Hover / focus / click on icon switches active panel
- Map is the central main canvas

## Key Files
- App wiring / state / map lifecycle: `src/App.jsx`
- Dashboard UI: `src/components/ControlPanel.jsx`
- Global styling / operations-shell layout: `src/styles.css`
- Vehicle simulation / hotspots / reroutes: `src/lib/simulation.js`
- Traffic signal system: `src/lib/trafficSignals.js`
- MapLibre sources / layers: `src/lib/mapStyle.js`
- Offline road router: `src/lib/navigation.js`
- Offline basemap / data paths: `src/data/offlineBengaluru.js`
- Campus overlay data: `src/data/offlineCampuses.js`

## Map / Data
- Local PMTiles basemap: `public/data/bengaluru.pmtiles`
- Local road graph: `public/data/road-graph.json`
- Local civic overlays:
  - `public/data/bengaluru-boundary.geojson`
  - `public/data/bengaluru-civic.geojson`
  - `public/data/bengaluru-traffic-signals.geojson`
  - `public/data/bengaluru-traffic-signal-directions.geojson`
  - `public/data/bengaluru-water-grid.geojson`
  - `public/data/bengaluru-water-valves.geojson`
  - `public/data/bengaluru-power-grid.geojson`
  - `public/data/bengaluru-power-substations.geojson`
  - `public/data/bengaluru-power-transformers.geojson`

## Implemented Features
- Offline real Bengaluru basemap via PMTiles
- Bengaluru official boundary rendered
- Hospitals, police stations, fire stations rendered from offline data
- Traffic signals deduped and rendered from offline data
- Traffic signal direction arrows:
  - static blue arrows always visible
  - active green arrow lights based on routed vehicle movement
- Vehicle routing:
  - start / end picked on map
  - route follows road graph, not straight lines
  - defined and randomized simulation modes
- Vehicles:
  - currently spawn together for defined mode
  - cluster detection creates temporary automatic traffic hotspots
  - vehicles reroute around those hotspots and still aim for destination
- Hotspots:
  - manual traffic hotspots
  - automatic congestion hotspots
  - hotspot avoidance in routing
- Live vehicle probe:
  - click map to get number of active vehicles within radius
- Water:
  - toggleable layer / system
  - real offline grid geometry
  - simple pressure / flow / supply simulation
  - manual pipe break / reservoir fail
- Energy:
  - toggleable layer / system
  - offline grid geometry
  - simple voltage / load / supply simulation
  - manual line fault / substation outage
- Campus:
  - BMSCE highlighted
  - clickable
  - zoom to campus button
  - sample alert on click

## Traffic Logic Details
- Traffic signal index + live activation: `src/lib/trafficSignals.js`
- Route annotation with signal events happens during route creation
- Active arrow is chosen from routed bearing before / after signal
- Matching windows were widened so signals are visible in practice

## Congestion Logic Details
- Auto cluster detection is in `src/lib/simulation.js`
- Active congestion hotspots are generated from live vehicle runtime positions
- App refreshes cluster state during animation in `src/App.jsx`
- Vehicles reroute from current position
- If inside an automatic hotspot, reroute uses an escape waypoint around hotspot before continuing to target

## Current UI Implementation Details
- Top bar starts in `src/components/ControlPanel.jsx`
- Sidebar section switching is in `src/components/ControlPanel.jsx`
- Traffic panel includes:
  - defined / randomized toggle
  - vehicle count
  - pick start / end
  - start / clear
  - zoom to campus
  - probe radius / live vehicle count
  - manual hotspot tools
- Water and Energy panels each include:
  - on / off toggle
  - metric
  - hour
  - summary
  - fault controls

## User Preferences / Constraints
- No fluff
- Real map only, not cartoon / mock
- Offline-first
- Minimal unnecessary menus
- Tactical / professional dashboard aesthetic preferred
- User is sensitive to visual quality and realism
- If changing UI, preserve map prominence and operational feel

## Build Status
- `npm run build` passes

## Run
- `npm install`
- `npm run dev`

## Caveat
- Latest dark dashboard redesign was build-verified, but not browser-interaction-verified after the final styling pass. If continuing work, first do a browser pass and check:
  - sidebar sizing
  - mobile overlap
  - top bar / map spacing
  - section switching
  - control usability over real map
