# Bengaluru Twin

React app with:

- a real Bengaluru basemap from `public/data/bengaluru.pmtiles`
- a local road network from `public/data/road-graph.json`
- an official BBMP boundary built from the BBMP wards FeatureServer
- MapLibre + official `pmtiles` integration
- local hospitals, fire stations, police stations, and deduplicated directional traffic signals
- start/end vehicle navigation with animated movement on the road graph

## Refresh Offline Layers

```bash
npm run build:data
```

This downloads the official BBMP ward polygons, dissolves them into the Bengaluru boundary, fetches hospitals, police stations, fire stations, and traffic signals from OSM inside that boundary, and clusters traffic signals to one retained point per 50 m.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
