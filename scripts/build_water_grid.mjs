import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import { kml } from "@tmcw/togeojson";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmpDir = path.join(repoRoot, "tmp");
const outputDir = path.join(repoRoot, "public", "data");

const WATER_DATASETS = [
  {
    id: "gt300",
    url: "https://data.opencity.in/dataset/97e5e83e-3c77-4de1-9221-97a3ab1f7784/resource/6c3e5957-82bf-4922-8513-b3ee622f1125/download/f6c32921-8975-44d3-9b55-2174396e0991.kml",
    cacheName: "water_gt_300.kml",
    diameterClass: "gt300",
    diameterLabel: ">300 mm",
  },
  {
    id: "lte300",
    url: "https://data.opencity.in/dataset/97e5e83e-3c77-4de1-9221-97a3ab1f7784/resource/439d1c8b-aa78-4f5a-917c-62b3d6db77b0/download/4f999482-f969-484e-9209-64e54fba9055.kml",
    cacheName: "water_lte_300.kml",
    diameterClass: "lte300",
    diameterLabel: "<=300 mm",
  },
];

const VALVE_DATASET = {
  url: "https://data.opencity.in/dataset/97e5e83e-3c77-4de1-9221-97a3ab1f7784/resource/36cd4629-8d09-4b18-8ff1-836aaa92d55a/download/1c11262f-2cfb-424d-b4bb-a9cdd86d0c52.kml",
  cacheName: "water_valves.kml",
};

async function main() {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const gridFeatures = [];

  for (const dataset of WATER_DATASETS) {
    const cachePath = path.join(tmpDir, dataset.cacheName);
    await ensureDownloaded(cachePath, dataset.url);
    const geojson = kmlToGeoJson(cachePath);
    const lineFeatures = convertPipeFeatures(geojson.features, dataset);
    gridFeatures.push(...lineFeatures);
    console.log(`Converted ${lineFeatures.length} water-grid features from ${dataset.id}`);
  }

  const valvesCachePath = path.join(tmpDir, VALVE_DATASET.cacheName);
  await ensureDownloaded(valvesCachePath, VALVE_DATASET.url);
  const valveGeoJson = kmlToGeoJson(valvesCachePath);
  const valveFeatures = convertValveFeatures(valveGeoJson.features);

  const gridOutputPath = path.join(outputDir, "bengaluru-water-grid.geojson");
  const valvesOutputPath = path.join(outputDir, "bengaluru-water-valves.geojson");

  writeGeoJson(gridOutputPath, {
    type: "FeatureCollection",
    features: gridFeatures,
  });
  writeGeoJson(valvesOutputPath, {
    type: "FeatureCollection",
    features: valveFeatures,
  });

  console.log(
    JSON.stringify(
      {
        gridFeatures: gridFeatures.length,
        valveFeatures: valveFeatures.length,
        gridOutputPath,
        valvesOutputPath,
      },
      null,
      2,
    ),
  );
}

async function ensureDownloaded(targetPath, url) {
  if (fs.existsSync(targetPath)) {
    return;
  }

  console.log(`Downloading ${url}`);
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(targetPath, bytes);
}

function kmlToGeoJson(filePath) {
  const xml = new DOMParser().parseFromString(fs.readFileSync(filePath, "utf8"), "text/xml");
  return kml(xml);
}

function convertPipeFeatures(features, dataset) {
  const outputFeatures = [];
  let featureIndex = 0;

  features.forEach((feature) => {
    const geometry = normalizeLineGeometry(feature.geometry);

    if (!geometry) {
      return;
    }

    outputFeatures.push({
      type: "Feature",
      geometry: simplifyLineGeometry(geometry),
      properties: {
        id: `${dataset.id}:${featureIndex + 1}`,
        diameterClass: dataset.diameterClass,
        diameterLabel: dataset.diameterLabel,
      },
    });
    featureIndex += 1;
  });

  return outputFeatures;
}

function convertValveFeatures(features) {
  return features
    .filter((feature) => feature.geometry?.type === "Point")
    .map((feature, index) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: roundCoordinate(feature.geometry.coordinates),
      },
      properties: {
        id: `valve:${index + 1}`,
        valveId: feature.properties?.ValveID ?? feature.properties?.KGISValveID ?? index + 1,
        diameterMm: Number.parseFloat(feature.properties?.Diameter) || null,
        status: feature.properties?.Status ?? "Unknown",
      },
    }));
}

function normalizeLineGeometry(geometry) {
  if (!geometry) {
    return null;
  }

  if (geometry.type === "LineString") {
    return geometry;
  }

  if (geometry.type === "MultiLineString") {
    return geometry;
  }

  if (geometry.type === "GeometryCollection") {
    const lineGeometries = geometry.geometries.filter(
      (candidateGeometry) =>
        candidateGeometry.type === "LineString" || candidateGeometry.type === "MultiLineString",
    );

    if (lineGeometries.length === 0) {
      return null;
    }

    if (lineGeometries.length === 1) {
      return lineGeometries[0];
    }

    return {
      type: "MultiLineString",
      coordinates: lineGeometries.flatMap((candidateGeometry) =>
        candidateGeometry.type === "LineString"
          ? [candidateGeometry.coordinates]
          : candidateGeometry.coordinates,
      ),
    };
  }

  return null;
}

function simplifyLineGeometry(geometry) {
  if (geometry.type === "LineString") {
    return {
      type: "LineString",
      coordinates: simplifyCoordinates(geometry.coordinates),
    };
  }

  return {
    type: "MultiLineString",
    coordinates: geometry.coordinates
      .map((coordinates) => simplifyCoordinates(coordinates))
      .filter((coordinates) => coordinates.length >= 2),
  };
}

function simplifyCoordinates(coordinates) {
  const nextCoordinates = [];

  coordinates.forEach((coordinate) => {
    const roundedCoordinate = roundCoordinate(coordinate);
    const previousCoordinate = nextCoordinates[nextCoordinates.length - 1];

    if (
      !previousCoordinate ||
      previousCoordinate[0] !== roundedCoordinate[0] ||
      previousCoordinate[1] !== roundedCoordinate[1]
    ) {
      nextCoordinates.push(roundedCoordinate);
    }
  });

  return nextCoordinates;
}

function roundCoordinate(coordinate) {
  return [
    roundValue(coordinate[0], 6),
    roundValue(coordinate[1], 6),
  ];
}

function roundValue(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function writeGeoJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
