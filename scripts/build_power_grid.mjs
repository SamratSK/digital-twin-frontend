import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmpDir = path.join(repoRoot, "tmp");
const outputDir = path.join(repoRoot, "public", "data");
const pointCachePath = path.join(tmpDir, "bengaluru-power-points-osm.json");
const lineCachePath = path.join(tmpDir, "bengaluru-power-lines-osm.json");
const overpassUrl = "https://overpass-api.de/api/interpreter";
const bbox = {
  south: 12.84,
  west: 77.47,
  north: 13.13,
  east: 77.77,
};

async function main() {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const overpassJson = await loadOverpassData();
  const { lineFeatures, substationFeatures, transformerFeatures } =
    convertOverpassFeatures(overpassJson.elements ?? []);

  const lineOutputPath = path.join(outputDir, "bengaluru-power-grid.geojson");
  const substationOutputPath = path.join(outputDir, "bengaluru-power-substations.geojson");
  const transformerOutputPath = path.join(outputDir, "bengaluru-power-transformers.geojson");

  writeGeoJson(lineOutputPath, {
    type: "FeatureCollection",
    features: lineFeatures,
  });
  writeGeoJson(substationOutputPath, {
    type: "FeatureCollection",
    features: substationFeatures,
  });
  writeGeoJson(transformerOutputPath, {
    type: "FeatureCollection",
    features: transformerFeatures,
  });

  console.log(
    JSON.stringify(
      {
        lineFeatures: lineFeatures.length,
        substationFeatures: substationFeatures.length,
        transformerFeatures: transformerFeatures.length,
        lineOutputPath,
        substationOutputPath,
        transformerOutputPath,
      },
      null,
      2,
    ),
  );
}

async function loadOverpassData() {
  const [pointJson, lineJson] = await Promise.all([
    loadOverpassQuery(pointCachePath, buildPointQuery()),
    loadOverpassQuery(lineCachePath, buildLineQuery()),
  ]);

  return {
    elements: [...(pointJson.elements ?? []), ...(lineJson.elements ?? [])],
  };
}

async function loadOverpassQuery(targetPath, query) {
  if (fs.existsSync(targetPath)) {
    return JSON.parse(fs.readFileSync(targetPath, "utf8"));
  }

  const response = await fetch(overpassUrl, {
    method: "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      "user-agent": "Mozilla/5.0",
    },
    body: query,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Overpass power data: ${response.status}`);
  }

  const json = await response.json();
  fs.writeFileSync(targetPath, JSON.stringify(json));
  return json;
}

function buildPointQuery() {
  return `
[out:json][timeout:180];
(
  node["power"="substation"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  way["power"="substation"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  relation["power"="substation"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  node["power"="transformer"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out center tags;
`.trim();
}

function buildLineQuery() {
  return `
[out:json][timeout:180];
(
  way["power"~"^(line|minor_line|cable)$"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  relation["power"~"^(line|minor_line|cable)$"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out geom tags;
`.trim();
}

function convertOverpassFeatures(elements) {
  const lineFeatures = [];
  const substationFeatures = [];
  const transformerFeatures = [];

  elements.forEach((element) => {
    const powerTag = element.tags?.power;

    if (powerTag === "substation") {
      const pointCoordinate = getElementPointCoordinate(element);

      if (!pointCoordinate) {
        return;
      }

      substationFeatures.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: pointCoordinate,
        },
        properties: {
          id: `${element.type}:${element.id}`,
          name:
            element.tags?.name ??
            element.tags?.["name:en"] ??
            `Substation ${substationFeatures.length + 1}`,
          voltageKV: parseVoltageKV(element.tags?.voltage),
          operator: element.tags?.operator ?? null,
          substationType: element.tags?.substation ?? null,
        },
      });
      return;
    }

    if (powerTag === "transformer") {
      const pointCoordinate = getElementPointCoordinate(element);

      if (!pointCoordinate) {
        return;
      }

      transformerFeatures.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: pointCoordinate,
        },
        properties: {
          id: `${element.type}:${element.id}`,
          voltageKV: parseVoltageKV(element.tags?.voltage),
          ratingMVA: parseNumericValue(element.tags?.rating),
        },
      });
      return;
    }

    if (!["line", "minor_line", "cable"].includes(powerTag)) {
      return;
    }

    const geometry = normalizeLineGeometry(element);

    if (!geometry) {
      return;
    }

    lineFeatures.push({
      type: "Feature",
      geometry,
      properties: {
        id: `${element.type}:${element.id}`,
        powerType: powerTag,
        voltageKV: parseVoltageKV(element.tags?.voltage) ?? inferVoltageKVFromType(powerTag),
        circuits: parseNumericValue(element.tags?.circuits),
        operator: element.tags?.operator ?? null,
        name: element.tags?.name ?? null,
      },
    });
  });

  return { lineFeatures, substationFeatures, transformerFeatures };
}

function getElementPointCoordinate(element) {
  if (typeof element.lon === "number" && typeof element.lat === "number") {
    return roundCoordinate([element.lon, element.lat]);
  }

  if (element.center && typeof element.center.lon === "number" && typeof element.center.lat === "number") {
    return roundCoordinate([element.center.lon, element.center.lat]);
  }

  return null;
}

function normalizeLineGeometry(element) {
  if (!Array.isArray(element.geometry) || element.geometry.length < 2) {
    return null;
  }

  const coordinates = simplifyCoordinates(
    element.geometry.map((coordinate) => [coordinate.lon, coordinate.lat]),
  );

  if (coordinates.length < 2) {
    return null;
  }

  return {
    type: "LineString",
    coordinates,
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

function parseVoltageKV(value) {
  if (!value) {
    return null;
  }

  const rawValues = `${value}`
    .split(/[;\/,]/)
    .map((token) => Number.parseFloat(token))
    .filter((token) => Number.isFinite(token) && token > 0);

  if (rawValues.length === 0) {
    return null;
  }

  const nextValue = Math.max(...rawValues);
  return nextValue >= 1000 ? roundValue(nextValue / 1000, 1) : roundValue(nextValue, 1);
}

function parseNumericValue(value) {
  const nextValue = Number.parseFloat(value);
  return Number.isFinite(nextValue) ? nextValue : null;
}

function inferVoltageKVFromType(powerType) {
  if (powerType === "line") {
    return 220;
  }

  if (powerType === "minor_line") {
    return 66;
  }

  return 33;
}

function roundCoordinate(coordinate) {
  return [roundValue(coordinate[0], 6), roundValue(coordinate[1], 6)];
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
