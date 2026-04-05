#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import geopandas as gpd
import osmnx as ox
import requests
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, mapping
from shapely.ops import transform


PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = PROJECT_ROOT / "public" / "data"
CACHE_DIR = PROJECT_ROOT / "cache" / "osmnx"

BBMP_WARDS_QUERY_URL = (
    "https://services-ap1.arcgis.com/Q6vQfsr0oYrwKWlE/ArcGIS/rest/services/BBMP/FeatureServer/0/query"
)
BOUNDARY_SOURCE_URL = (
    "https://services-ap1.arcgis.com/Q6vQfsr0oYrwKWlE/ArcGIS/rest/services/BBMP/FeatureServer"
)
CRS_WGS84 = "EPSG:4326"
CRS_METRIC = "EPSG:32643"
SIGNAL_CLUSTER_RADIUS_METERS = 50.0
DIRECTION_SEARCH_RADIUS_METERS = 32.0
DIRECTION_FALLBACK_RADIUS_METERS = 80.0
DIRECTION_BEARING_TOLERANCE_DEGREES = 24.0
DIRECTION_MAX_COUNT = 4

CARDINAL_BEARINGS = {
    "n": 0.0,
    "nne": 22.5,
    "ne": 45.0,
    "ene": 67.5,
    "e": 90.0,
    "ese": 112.5,
    "se": 135.0,
    "sse": 157.5,
    "s": 180.0,
    "ssw": 202.5,
    "sw": 225.0,
    "wsw": 247.5,
    "w": 270.0,
    "wnw": 292.5,
    "nw": 315.0,
    "nnw": 337.5,
}


def ensure_output_dir() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def configure_osmnx() -> None:
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(CACHE_DIR)
    ox.settings.overpass_rate_limit = False
    ox.settings.timeout = 180


def round_coordinate(value: float) -> float:
    return round(float(value), 6)


def normalize_bearing(value: float) -> float:
    return value % 360.0


def angle_difference(left: float, right: float) -> float:
    return abs((left - right + 180.0) % 360.0 - 180.0)


def as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if value is None:
        return []
    return [value]


def pick_text(*values: Any) -> str:
    for value in values:
        for item in as_list(value):
            if isinstance(item, str):
                text = item.strip()
                if text:
                    return text
    return ""


def parse_oneway(value: Any) -> bool:
    text = pick_text(value).lower()
    if text:
        return text in {"yes", "true", "1", "-1"}
    return bool(value)


def representative_point(geometry: Any) -> Point:
    if geometry.geom_type == "Point":
        return geometry
    return geometry.representative_point()


def metric_bearing(start: tuple[float, float], end: tuple[float, float]) -> float:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    return normalize_bearing(math.degrees(math.atan2(dx, dy)))


def project_point_onto_segment(
    point: tuple[float, float],
    start: tuple[float, float],
    end: tuple[float, float],
) -> tuple[float, float, float]:
    px, py = point
    sx, sy = start
    ex, ey = end
    dx = ex - sx
    dy = ey - sy
    length_squared = dx * dx + dy * dy

    if length_squared == 0:
        return sx, sy, math.hypot(px - sx, py - sy)

    t = max(0.0, min(1.0, ((px - sx) * dx + (py - sy) * dy) / length_squared))
    cx = sx + t * dx
    cy = sy + t * dy
    return cx, cy, math.hypot(px - cx, py - cy)


def make_metric_direction_polygon(point: Point, bearing: float) -> Polygon:
    theta = math.radians(bearing)
    left_theta = math.radians(bearing - 98.0)
    right_theta = math.radians(bearing + 98.0)
    origin_x = point.x
    origin_y = point.y
    left = (origin_x + math.sin(left_theta) * 8.0, origin_y + math.cos(left_theta) * 8.0)
    tip = (origin_x + math.sin(theta) * 28.0, origin_y + math.cos(theta) * 28.0)
    right = (origin_x + math.sin(right_theta) * 8.0, origin_y + math.cos(right_theta) * 8.0)
    return Polygon([(origin_x, origin_y), left, tip, right, (origin_x, origin_y)])


def dedupe_bearings(candidates: list[dict[str, float]]) -> list[float]:
    kept: list[dict[str, float]] = []

    for candidate in sorted(candidates, key=lambda item: (-item["weight"], item["distance"])):
        bearing = normalize_bearing(candidate["bearing"])
        if any(
            angle_difference(bearing, existing["bearing"]) <= DIRECTION_BEARING_TOLERANCE_DEGREES
            for existing in kept
        ):
            continue

        kept.append({"bearing": bearing, "weight": candidate["weight"]})
        if len(kept) >= DIRECTION_MAX_COUNT:
            break

    return [item["bearing"] for item in kept]


def parse_direction_values(raw_value: Any, fallback_bearing: float | None) -> list[float]:
    text = pick_text(raw_value)
    if not text:
        return []

    values: list[float] = []
    for token in re.split(r"[;,/|]", text):
        item = token.strip().lower().removesuffix("°")
        if not item:
            continue

        if item == "forward" and fallback_bearing is not None:
            values.append(normalize_bearing(fallback_bearing))
            continue

        if item == "backward" and fallback_bearing is not None:
            values.append(normalize_bearing(fallback_bearing + 180.0))
            continue

        if item in CARDINAL_BEARINGS:
            values.append(CARDINAL_BEARINGS[item])
            continue

        try:
            values.append(normalize_bearing(float(item)))
        except ValueError:
            continue

    deduped: list[float] = []
    for bearing in values:
        if any(angle_difference(bearing, existing) <= 5.0 for existing in deduped):
            continue
        deduped.append(bearing)
    return deduped


def fetch_bbmp_boundary() -> gpd.GeoDataFrame:
    params = {
        "where": "1=1",
        "outFields": "WARD_NO,WARD_NAME,WardNameAndNo",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
    }
    response = requests.get(
        BBMP_WARDS_QUERY_URL,
        params=params,
        headers={"User-Agent": "digital-twin-builder/1.0"},
        timeout=180,
    )
    response.raise_for_status()
    payload = response.json()
    wards = gpd.GeoDataFrame.from_features(payload["features"], crs=CRS_WGS84)
    dissolved = wards.dissolve().reset_index(drop=True)
    dissolved["name"] = "Bruhat Bengaluru Mahanagara Palike"
    dissolved["source"] = "BBMP wards FeatureServer"
    dissolved["wardCount"] = len(wards)
    return dissolved


def fetch_osm_features(boundary_geometry: Any, tags: dict[str, str]) -> gpd.GeoDataFrame:
    features = ox.features_from_polygon(boundary_geometry, tags)
    return features.to_crs(CRS_WGS84)


def choose_civic_label(row: Any) -> str:
    return pick_text(
        row.get("name"),
        row.get("name:en"),
        row.get("operator"),
        row.get("brand"),
    )


def infer_asset_type(row: Any, fallback_type: str) -> str:
    amenity = pick_text(row.get("amenity")).lower()
    emergency = pick_text(row.get("emergency")).lower()
    healthcare = pick_text(row.get("healthcare")).lower()
    if amenity == "police":
        return "police"
    if amenity == "fire_station" or emergency == "fire_station":
        return "fire"
    if amenity == "hospital" or healthcare == "hospital":
        return "hospital"
    return fallback_type


def normalize_civic_features(asset_type: str, raw_gdf: gpd.GeoDataFrame) -> dict[str, Any]:
    features: list[dict[str, Any]] = []

    for position, (index, row) in enumerate(raw_gdf.iterrows(), start=1):
        geometry = representative_point(row.geometry)
        osm_element, osm_id = index
        label = choose_civic_label(row)
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round_coordinate(geometry.x), round_coordinate(geometry.y)],
                },
                "properties": {
                    "id": f"{osm_element}:{osm_id}",
                    "assetType": infer_asset_type(row, asset_type),
                    "label": label,
                    "displayName": label or f"{asset_type.title()} {position}",
                },
            }
        )

    return {"type": "FeatureCollection", "features": features}


def score_signal(row: Any) -> int:
    score = 0
    if pick_text(row.get("traffic_signals:direction")):
        score += 5
    if pick_text(row.get("direction")):
        score += 3
    if pick_text(row.get("name")):
        score += 1
    if pick_text(row.get("crossing")):
        score += 1
    return score


def dedupe_signals(raw_signals: gpd.GeoDataFrame) -> tuple[gpd.GeoDataFrame, list[int]]:
    signals_wgs84 = raw_signals.copy()
    signals_metric = signals_wgs84.to_crs(CRS_METRIC)
    order = list(signals_metric.index)
    order.sort(key=lambda idx: (-score_signal(signals_wgs84.loc[idx]), str(idx)))

    kept_indices: list[Any] = []
    kept_points: list[Point] = []

    for index in order:
        point = representative_point(signals_metric.loc[index].geometry)
        if any(point.distance(existing) <= SIGNAL_CLUSTER_RADIUS_METERS for existing in kept_points):
            continue

        kept_indices.append(index)
        kept_points.append(point)

    cluster_sizes = [0] * len(kept_indices)

    for index, row in signals_metric.iterrows():
        point = representative_point(row.geometry)
        best_position = 0
        best_distance = float("inf")
        for position, kept_point in enumerate(kept_points):
            distance = point.distance(kept_point)
            if distance < best_distance:
                best_distance = distance
                best_position = position
        if best_distance <= SIGNAL_CLUSTER_RADIUS_METERS + 1e-6:
            cluster_sizes[best_position] += 1

    return signals_wgs84.loc[kept_indices].copy(), cluster_sizes


def collect_edge_direction_candidates(
    point: Point,
    edges_metric: gpd.GeoDataFrame,
    radius_meters: float,
) -> list[dict[str, float]]:
    candidates: list[dict[str, float]] = []
    spatial_index = edges_metric.sindex
    candidate_indexes = list(
        spatial_index.intersection(
            (
                point.x - radius_meters,
                point.y - radius_meters,
                point.x + radius_meters,
                point.y + radius_meters,
            )
        )
    )

    for candidate_index in candidate_indexes:
        row = edges_metric.iloc[candidate_index]
        geometry = row.geometry
        if not isinstance(geometry, LineString):
            continue

        coords = list(geometry.coords)
        best_distance = float("inf")
        best_bearing: float | None = None
        for segment_index in range(1, len(coords)):
            start = coords[segment_index - 1]
            end = coords[segment_index]
            _, _, distance = project_point_onto_segment((point.x, point.y), start, end)
            if distance < best_distance:
                best_distance = distance
                best_bearing = metric_bearing(start, end)

        if best_bearing is None or best_distance > radius_meters:
            continue

        candidates.append(
            {
                "bearing": best_bearing,
                "distance": best_distance,
                "weight": 1.0 / (1.0 + best_distance),
                "oneway": 1.0 if parse_oneway(row.get("oneway")) else 0.0,
            }
        )

    return candidates


def infer_signal_bearings(
    row: Any,
    point: Point,
    edges_metric: gpd.GeoDataFrame,
) -> list[float]:
    candidates = collect_edge_direction_candidates(point, edges_metric, DIRECTION_SEARCH_RADIUS_METERS)
    if not candidates:
        candidates = collect_edge_direction_candidates(point, edges_metric, DIRECTION_FALLBACK_RADIUS_METERS)
    if not candidates:
        return []

    explicit_direction = pick_text(row.get("traffic_signals:direction"), row.get("direction"))
    if explicit_direction:
        nearest_segment = min(candidates, key=lambda item: item["distance"])
        return parse_direction_values(explicit_direction, nearest_segment["bearing"])

    inferred: list[dict[str, float]] = []
    for candidate in candidates:
        inferred.append(candidate)
        if not candidate["oneway"]:
            inferred.append(
                {
                    "bearing": normalize_bearing(candidate["bearing"] + 180.0),
                    "distance": candidate["distance"],
                    "weight": candidate["weight"] * 0.94,
                }
            )

    return dedupe_bearings(inferred)


def build_signal_outputs(
    deduped_signals: gpd.GeoDataFrame,
    cluster_sizes: list[int],
    edges_metric: gpd.GeoDataFrame,
) -> tuple[dict[str, Any], dict[str, Any]]:
    to_wgs84 = Transformer.from_crs(CRS_METRIC, CRS_WGS84, always_xy=True).transform
    metric_signals = deduped_signals.to_crs(CRS_METRIC)
    point_features: list[dict[str, Any]] = []
    direction_features: list[dict[str, Any]] = []

    for position, ((index, row), cluster_size) in enumerate(
        zip(deduped_signals.iterrows(), cluster_sizes),
        start=1,
    ):
        osm_element, osm_id = index
        signal_id = f"{osm_element}:{osm_id}"
        geometry = representative_point(row.geometry)
        point_features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round_coordinate(geometry.x), round_coordinate(geometry.y)],
                },
                "properties": {
                    "id": signal_id,
                    "label": pick_text(row.get("name")),
                    "displayName": pick_text(row.get("name")) or f"Traffic Signal {position}",
                    "clusterSize": int(cluster_size),
                    "suppressedCount": max(int(cluster_size) - 1, 0),
                },
            }
        )

        metric_point = representative_point(metric_signals.loc[index].geometry)
        bearings = infer_signal_bearings(row, metric_point, edges_metric)
        for bearing_index, bearing in enumerate(bearings, start=1):
            polygon = transform(to_wgs84, make_metric_direction_polygon(metric_point, bearing))
            direction_features.append(
                {
                    "type": "Feature",
                    "geometry": mapping(polygon),
                    "properties": {
                        "id": f"{signal_id}:{bearing_index}",
                        "signalId": signal_id,
                        "bearing": round(float(bearing), 1),
                    },
                }
            )

    return (
        {"type": "FeatureCollection", "features": point_features},
        {"type": "FeatureCollection", "features": direction_features},
    )


def write_json(filename: str, payload: dict[str, Any]) -> None:
    output_path = OUTPUT_DIR / filename
    with output_path.open("w", encoding="utf-8") as output_file:
        json.dump(payload, output_file, separators=(",", ":"))
    print(f"Wrote {filename}")


def main() -> None:
    ensure_output_dir()
    configure_osmnx()

    boundary_gdf = fetch_bbmp_boundary()
    boundary_geometry = boundary_gdf.geometry.iloc[0]
    boundary_geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": mapping(boundary_geometry),
                "properties": {
                    "name": boundary_gdf.at[0, "name"],
                    "source": boundary_gdf.at[0, "source"],
                    "sourceUrl": BOUNDARY_SOURCE_URL,
                    "wardCount": int(boundary_gdf.at[0, "wardCount"]),
                },
            }
        ],
    }
    write_json("bengaluru-boundary.geojson", boundary_geojson)

    hospitals = fetch_osm_features(boundary_geometry, {"amenity": "hospital", "healthcare": "hospital"})
    police = fetch_osm_features(boundary_geometry, {"amenity": "police"})
    fire = fetch_osm_features(boundary_geometry, {"amenity": "fire_station", "emergency": "fire_station"})
    civic_features = {
        "type": "FeatureCollection",
        "features": [
            *normalize_civic_features("hospital", hospitals)["features"],
            *normalize_civic_features("police", police)["features"],
            *normalize_civic_features("fire", fire)["features"],
        ],
    }
    write_json("bengaluru-civic.geojson", civic_features)

    raw_signals = fetch_osm_features(boundary_geometry, {"highway": "traffic_signals"})
    deduped_signals, cluster_sizes = dedupe_signals(raw_signals)
    drive_graph = ox.graph_from_polygon(
        boundary_geometry,
        network_type="drive",
        simplify=True,
        retain_all=False,
        truncate_by_edge=True,
    )
    drive_edges = ox.graph_to_gdfs(drive_graph, nodes=False).to_crs(CRS_METRIC)
    traffic_signal_geojson, traffic_signal_directions_geojson = build_signal_outputs(
        deduped_signals,
        cluster_sizes,
        drive_edges,
    )
    write_json("bengaluru-traffic-signals.geojson", traffic_signal_geojson)
    write_json("bengaluru-traffic-signal-directions.geojson", traffic_signal_directions_geojson)

    print(
        "Boundary wards:",
        boundary_geojson["features"][0]["properties"]["wardCount"],
        "| hospitals:",
        len(hospitals),
        "| police:",
        len(police),
        "| fire:",
        len(fire),
        "| raw signals:",
        len(raw_signals),
        "| deduped signals:",
        len(traffic_signal_geojson["features"]),
    )


if __name__ == "__main__":
    main()
