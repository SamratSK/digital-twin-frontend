const ROAD_GRAPH_PATH = "/data/road-graph.json";
const LAT_SCALE_METERS = 111_320;
const MAX_NEAREST_NODE_CACHE_ENTRIES = 4096;
const MAX_ROUTE_CACHE_ENTRIES = 128;
const HOTSPOT_ENTRY_PENALTY_METERS = 3000;
const HOTSPOT_DEPTH_PENALTY_SCALE = 40;

let offlineRouterPromise = null;

export async function loadOfflineRouter() {
  if (!offlineRouterPromise) {
    offlineRouterPromise = fetch(ROAD_GRAPH_PATH)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load road graph: ${response.status}`);
        }

        return response.json();
      })
      .then((graph) => new OfflineRouter(graph));
  }

  return offlineRouterPromise;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
}

function normalizeBearing(value) {
  return ((value % 360) + 360) % 360;
}

function bucketKey(point, precision = 0.01) {
  const lngBucket = Math.round(point[0] / precision);
  const latBucket = Math.round(point[1] / precision);
  return `${lngBucket}:${latBucket}`;
}

function projectPointOntoSegment(point, start, end) {
  const lngScale = 109_000;
  const latScale = LAT_SCALE_METERS;
  const px = point[0] * lngScale;
  const py = point[1] * latScale;
  const sx = start[0] * lngScale;
  const sy = start[1] * latScale;
  const ex = end[0] * lngScale;
  const ey = end[1] * latScale;
  const dx = ex - sx;
  const dy = ey - sy;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / lengthSquared));
  const closestX = sx + t * dx;
  const closestY = sy + t * dy;

  return {
    coordinate: [closestX / lngScale, closestY / latScale],
    distanceMeters: Math.hypot(px - closestX, py - closestY),
  };
}

function distanceToMetricSegment(pointX, pointY, startX, startY, endX, endY) {
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared));
  const closestX = startX + t * dx;
  const closestY = startY + t * dy;

  return Math.hypot(pointX - closestX, pointY - closestY);
}

export function metersBetween(pointA, pointB) {
  const latFactor = LAT_SCALE_METERS;
  const averageLatRadians = ((pointA[1] + pointB[1]) / 2) * (Math.PI / 180);
  const lngFactor = Math.cos(averageLatRadians) * latFactor;
  const dx = (pointB[0] - pointA[0]) * lngFactor;
  const dy = (pointB[1] - pointA[1]) * latFactor;

  return Math.hypot(dx, dy);
}

export function bearingBetween(from, to) {
  const [lng1, lat1] = from.map(toRadians);
  const [lng2, lat2] = to.map(toRadians);
  const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);

  return normalizeBearing(toDegrees(Math.atan2(y, x)));
}

class MinHeap {
  constructor() {
    this.ids = [];
    this.scores = [];
  }

  push(id, score) {
    this.ids.push(id);
    this.scores.push(score);
    this.bubbleUp(this.ids.length - 1);
  }

  pop() {
    if (this.ids.length === 0) {
      return null;
    }

    const first = {
      id: this.ids[0],
      score: this.scores[0],
    };
    const lastId = this.ids.pop();
    const lastScore = this.scores.pop();

    if (this.ids.length > 0 && lastId !== undefined && lastScore !== undefined) {
      this.ids[0] = lastId;
      this.scores[0] = lastScore;
      this.bubbleDown(0);
    }

    return first;
  }

  get size() {
    return this.ids.length;
  }

  bubbleUp(index) {
    let currentIndex = index;

    while (currentIndex > 0) {
      const parentIndex = Math.floor((currentIndex - 1) / 2);
      if (this.scores[parentIndex] <= this.scores[currentIndex]) {
        return;
      }

      this.swap(parentIndex, currentIndex);
      currentIndex = parentIndex;
    }
  }

  bubbleDown(index) {
    let currentIndex = index;

    while (true) {
      const leftIndex = currentIndex * 2 + 1;
      const rightIndex = currentIndex * 2 + 2;
      let smallestIndex = currentIndex;

      if (leftIndex < this.ids.length && this.scores[leftIndex] < this.scores[smallestIndex]) {
        smallestIndex = leftIndex;
      }

      if (rightIndex < this.ids.length && this.scores[rightIndex] < this.scores[smallestIndex]) {
        smallestIndex = rightIndex;
      }

      if (smallestIndex === currentIndex) {
        return;
      }

      this.swap(currentIndex, smallestIndex);
      currentIndex = smallestIndex;
    }
  }

  swap(leftIndex, rightIndex) {
    [this.ids[leftIndex], this.ids[rightIndex]] = [this.ids[rightIndex], this.ids[leftIndex]];
    [this.scores[leftIndex], this.scores[rightIndex]] = [this.scores[rightIndex], this.scores[leftIndex]];
  }
}

class OfflineRouter {
  constructor(graph) {
    this.bucketPrecision = graph.bucketPrecision;
    this.nodeLngs = Float64Array.from(graph.nodeLngs);
    this.nodeLats = Float64Array.from(graph.nodeLats);
    this.nodeOffsets = Uint32Array.from(graph.nodeOffsets);
    this.edgeTargets = Uint32Array.from(graph.edgeTargets);
    this.edgeWeights = Float32Array.from(graph.edgeWeights);
    this.edgeGeometryStarts = Uint32Array.from(graph.edgeGeometryStarts);
    this.edgeGeometryLengths = Uint16Array.from(graph.edgeGeometryLengths);
    this.edgeCoordinates = Float64Array.from(graph.edgeCoordinates);
    this.buckets = new Map();
    this.gScoreTokens = new Uint32Array(this.nodeLngs.length);
    this.gScores = new Float64Array(this.nodeLngs.length);
    this.cameFromTokens = new Uint32Array(this.nodeLngs.length);
    this.cameFromPrevious = new Int32Array(this.nodeLngs.length);
    this.cameFromEdgeIndex = new Int32Array(this.nodeLngs.length);
    this.nearestNodeCache = new Map();
    this.cachedNodeRoutes = new Map();
    this.routeSearchToken = 0;
    this.nodeMeterXs = new Float64Array(this.nodeLngs.length);
    this.nodeMeterYs = new Float64Array(this.nodeLngs.length);
    this.edgeMeterXs = new Float64Array(this.edgeCoordinates.length / 2);
    this.edgeMeterYs = new Float64Array(this.edgeCoordinates.length / 2);
    this.lngScale = 1;
    this.hotspotPenaltyCache = new Map();
    this.hotspotPenaltySignature = "";

    const maxLatRadians = (graph.bbox[3] ?? 0) * (Math.PI / 180);
    const lngScale = Math.cos(maxLatRadians) * LAT_SCALE_METERS;
    this.lngScale = lngScale;

    for (let nodeId = 0; nodeId < this.nodeLngs.length; nodeId += 1) {
      this.nodeMeterXs[nodeId] = this.nodeLngs[nodeId] * lngScale;
      this.nodeMeterYs[nodeId] = this.nodeLats[nodeId] * LAT_SCALE_METERS;
    }

    for (let coordinateIndex = 0; coordinateIndex < this.edgeMeterXs.length; coordinateIndex += 1) {
      const sourceIndex = coordinateIndex * 2;
      this.edgeMeterXs[coordinateIndex] = this.edgeCoordinates[sourceIndex] * lngScale;
      this.edgeMeterYs[coordinateIndex] = this.edgeCoordinates[sourceIndex + 1] * LAT_SCALE_METERS;
    }

    Object.entries(graph.buckets).forEach(([key, nodeIds]) => {
      this.buckets.set(key, nodeIds);
    });
  }

  route(startPoint, endPoint, hotspots = []) {
    const startNodeId = this.findNearestNode(startPoint);
    const endNodeId = this.findNearestNode(endPoint);

    if (startNodeId === null || endNodeId === null) {
      return null;
    }

    const hotspotState = this.compileHotspots(hotspots);
    const cacheKey = hotspotState.signature
      ? `${hotspotState.signature}:${startNodeId}:${endNodeId}`
      : `${startNodeId}:${endNodeId}`;
    const cachedNodeRoute = this.cachedNodeRoutes.get(cacheKey);
    if (cachedNodeRoute) {
      return this.materializeRoute(startPoint, endPoint, cachedNodeRoute);
    }

    const searchToken = this.nextSearchToken();
    const openSet = new MinHeap();
    openSet.push(startNodeId, this.heuristic(startNodeId, endNodeId));
    this.gScoreTokens[startNodeId] = searchToken;
    this.gScores[startNodeId] = 0;
    let visitedNodes = 0;

    while (openSet.size > 0) {
      const current = openSet.pop();
      if (!current) {
        break;
      }

      const bestKnownScore =
        this.gScoreTokens[current.id] === searchToken ? this.gScores[current.id] : undefined;

      if (bestKnownScore === undefined || current.score > bestKnownScore + this.heuristic(current.id, endNodeId)) {
        continue;
      }

      visitedNodes += 1;

      if (current.id === endNodeId) {
        const nodeRoute = this.buildNodeRoute(startNodeId, endNodeId, searchToken, visitedNodes);
        this.setCachedNodeRoute(cacheKey, nodeRoute);
        return this.materializeRoute(startPoint, endPoint, nodeRoute);
      }

      const currentGScore = bestKnownScore ?? Number.POSITIVE_INFINITY;
      const edgeStart = this.nodeOffsets[current.id];
      const edgeEnd = this.nodeOffsets[current.id + 1];

      for (let edgeIndex = edgeStart; edgeIndex < edgeEnd; edgeIndex += 1) {
        const edgeTarget = this.edgeTargets[edgeIndex];
        const tentativeGScore =
          currentGScore +
          this.edgeWeights[edgeIndex] +
          this.getHotspotEdgePenalty(edgeIndex, hotspotState);
        const previousTargetScore =
          this.gScoreTokens[edgeTarget] === searchToken
            ? this.gScores[edgeTarget]
            : Number.POSITIVE_INFINITY;

        if (tentativeGScore >= previousTargetScore) {
          continue;
        }

        this.cameFromTokens[edgeTarget] = searchToken;
        this.cameFromPrevious[edgeTarget] = current.id;
        this.cameFromEdgeIndex[edgeTarget] = edgeIndex;
        this.gScoreTokens[edgeTarget] = searchToken;
        this.gScores[edgeTarget] = tentativeGScore;

        const estimatedScore = tentativeGScore + this.heuristic(edgeTarget, endNodeId);
        openSet.push(edgeTarget, estimatedScore);
      }
    }

    return null;
  }

  compileHotspots(hotspots) {
    if (!hotspots || hotspots.length === 0) {
      if (this.hotspotPenaltySignature !== "") {
        this.hotspotPenaltySignature = "";
        this.hotspotPenaltyCache.clear();
      }

      return { signature: "", items: [] };
    }

    const signature = hotspots
      .map(
        (hotspot) =>
          `${hotspot.id}:${hotspot.coordinate[0].toFixed(5)}:${hotspot.coordinate[1].toFixed(5)}:${Math.round(hotspot.radiusMeters)}:${hotspot.blocking ? 1 : 0}`,
      )
      .join("|");

    if (this.hotspotPenaltySignature !== signature) {
      this.hotspotPenaltySignature = signature;
      this.hotspotPenaltyCache.clear();
    }

    return {
      signature,
      items: hotspots.map((hotspot) => ({
        id: hotspot.id,
        x: hotspot.coordinate[0] * this.lngScale,
        y: hotspot.coordinate[1] * LAT_SCALE_METERS,
        radiusMeters: hotspot.radiusMeters,
        blocking: Boolean(hotspot.blocking),
      })),
    };
  }

  getHotspotEdgePenalty(edgeIndex, hotspotState) {
    if (!hotspotState.items.length) {
      return 0;
    }

    const cachedPenalty = this.hotspotPenaltyCache.get(edgeIndex);
    if (cachedPenalty !== undefined) {
      return cachedPenalty;
    }

    const geometryStart = this.edgeGeometryStarts[edgeIndex];
    const geometryLength = this.edgeGeometryLengths[edgeIndex];
    let penalty = 0;

    hotspotState.items.forEach((hotspot) => {
      let bestDistance = Number.POSITIVE_INFINITY;

      for (let pointIndex = 1; pointIndex < geometryLength; pointIndex += 1) {
        const startOffset = geometryStart + pointIndex - 1;
        const endOffset = geometryStart + pointIndex;
        const distance = distanceToMetricSegment(
          hotspot.x,
          hotspot.y,
          this.edgeMeterXs[startOffset],
          this.edgeMeterYs[startOffset],
          this.edgeMeterXs[endOffset],
          this.edgeMeterYs[endOffset],
        );

        if (distance < bestDistance) {
          bestDistance = distance;
        }
      }

      if (bestDistance < hotspot.radiusMeters) {
        if (hotspot.blocking) {
          penalty = Number.POSITIVE_INFINITY;
          return;
        }

        penalty +=
          HOTSPOT_ENTRY_PENALTY_METERS +
          (hotspot.radiusMeters - bestDistance) * HOTSPOT_DEPTH_PENALTY_SCALE;
      }
    });

    this.hotspotPenaltyCache.set(edgeIndex, penalty);
    return penalty;
  }

  nearestRoadCoordinate(point) {
    const snappedCoordinate = this.findNearestRoadPoint(point);

    if (snappedCoordinate) {
      return snappedCoordinate;
    }

    const nodeId = this.findNearestNode(point);
    return nodeId === null ? null : this.getNodeCoordinate(nodeId);
  }

  findNearestNode(point) {
    const cacheKey = `${Math.round(point[0] * 10000)}:${Math.round(point[1] * 10000)}`;
    const cachedNodeId = this.nearestNodeCache.get(cacheKey);

    if (cachedNodeId !== undefined) {
      return cachedNodeId;
    }

    const localCandidates = this.collectCandidates(point);
    let bestId = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    if (localCandidates.length > 0) {
      localCandidates.forEach((nodeId) => {
        const distance = metersBetween(point, this.getNodeCoordinate(nodeId));
        if (distance < bestDistance) {
          bestDistance = distance;
          bestId = nodeId;
        }
      });
    } else {
      for (let nodeId = 0; nodeId < this.nodeLngs.length; nodeId += 1) {
        const distance = metersBetween(point, this.getNodeCoordinate(nodeId));
        if (distance < bestDistance) {
          bestDistance = distance;
          bestId = nodeId;
        }
      }
    }

    if (bestId !== null) {
      this.setNearestNodeCache(cacheKey, bestId);
    }

    return bestId;
  }

  collectCandidates(point) {
    const [lngBucket, latBucket] = bucketKey(point, this.bucketPrecision).split(":").map(Number);
    const candidates = new Set();

    for (let radius = 0; radius <= 3; radius += 1) {
      for (let lngOffset = -radius; lngOffset <= radius; lngOffset += 1) {
        for (let latOffset = -radius; latOffset <= radius; latOffset += 1) {
          const bucket = this.buckets.get(`${lngBucket + lngOffset}:${latBucket + latOffset}`);
          if (bucket) {
            bucket.forEach((nodeId) => candidates.add(nodeId));
          }
        }
      }

      if (candidates.size > 0) {
        return [...candidates];
      }
    }

    return [];
  }

  getNodeCoordinate(nodeId) {
    return [this.nodeLngs[nodeId], this.nodeLats[nodeId]];
  }

  findNearestRoadPoint(point) {
    const localCandidates = this.collectCandidates(point);
    const candidateNodes = localCandidates.length > 0 ? localCandidates : null;
    const visitedEdges = new Set();
    let bestCoordinate = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    const searchNodes = candidateNodes ?? [...this.nodeLngs.keys()];

    searchNodes.forEach((nodeId) => {
      const edgeStart = this.nodeOffsets[nodeId];
      const edgeEnd = this.nodeOffsets[nodeId + 1];

      for (let edgeIndex = edgeStart; edgeIndex < edgeEnd; edgeIndex += 1) {
        if (visitedEdges.has(edgeIndex)) {
          continue;
        }

        visitedEdges.add(edgeIndex);

        const geometryStart = this.edgeGeometryStarts[edgeIndex];
        const geometryLength = this.edgeGeometryLengths[edgeIndex];

        for (let index = 1; index < geometryLength; index += 1) {
          const startOffset = (geometryStart + index - 1) * 2;
          const endOffset = (geometryStart + index) * 2;
          const projectedPoint = projectPointOntoSegment(
            point,
            [this.edgeCoordinates[startOffset], this.edgeCoordinates[startOffset + 1]],
            [this.edgeCoordinates[endOffset], this.edgeCoordinates[endOffset + 1]],
          );

          if (projectedPoint.distanceMeters < bestDistance) {
            bestDistance = projectedPoint.distanceMeters;
            bestCoordinate = projectedPoint.coordinate;
          }
        }
      }
    });

    return bestCoordinate;
  }

  heuristic(fromNodeId, toNodeId) {
    return Math.hypot(
      this.nodeMeterXs[fromNodeId] - this.nodeMeterXs[toNodeId],
      this.nodeMeterYs[fromNodeId] - this.nodeMeterYs[toNodeId],
    );
  }

  nextSearchToken() {
    this.routeSearchToken += 1;

    if (this.routeSearchToken >= 0xffff_fffe) {
      this.routeSearchToken = 1;
      this.gScoreTokens.fill(0);
      this.cameFromTokens.fill(0);
    }

    return this.routeSearchToken;
  }

  buildNodeRoute(startNodeId, endNodeId, searchToken, visitedNodes) {
    const edgeIndexes = [];
    let cursor = endNodeId;

    while (this.cameFromTokens[cursor] === searchToken) {
      edgeIndexes.push(this.cameFromEdgeIndex[cursor]);
      cursor = this.cameFromPrevious[cursor];
    }

    edgeIndexes.reverse();

    const coordinates = edgeIndexes.length === 0 ? [this.getNodeCoordinate(startNodeId)] : [];

    edgeIndexes.forEach((edgeIndex, edgeListIndex) => {
      const startPointIndex = this.edgeGeometryStarts[edgeIndex];
      const pointLength = this.edgeGeometryLengths[edgeIndex];
      const geometryStart = edgeListIndex === 0 ? 0 : 1;

      for (let index = geometryStart; index < pointLength; index += 1) {
        const coordinateIndex = (startPointIndex + index) * 2;
        coordinates.push([
          this.edgeCoordinates[coordinateIndex],
          this.edgeCoordinates[coordinateIndex + 1],
        ]);
      }
    });

    return {
      coordinates,
      distanceMeters: measurePath(coordinates),
      visitedNodes,
    };
  }

  materializeRoute(startPoint, endPoint, nodeRoute) {
    if (nodeRoute.coordinates.length === 0) {
      return {
        coordinates: [startPoint, endPoint],
        distanceMeters: metersBetween(startPoint, endPoint),
        visitedNodes: nodeRoute.visitedNodes,
      };
    }

    const coordinates = [startPoint];
    const firstNode = nodeRoute.coordinates[0];
    const lastNode = nodeRoute.coordinates[nodeRoute.coordinates.length - 1];

    if (!coordinatesEqual(startPoint, firstNode)) {
      coordinates.push(...nodeRoute.coordinates);
    } else {
      coordinates.push(...nodeRoute.coordinates.slice(1));
    }

    if (!coordinatesEqual(coordinates[coordinates.length - 1] ?? startPoint, endPoint)) {
      coordinates.push(endPoint);
    }

    return {
      coordinates,
      distanceMeters:
        nodeRoute.distanceMeters +
        metersBetween(startPoint, firstNode) +
        metersBetween(lastNode, endPoint),
      visitedNodes: nodeRoute.visitedNodes,
    };
  }

  setNearestNodeCache(key, nodeId) {
    this.nearestNodeCache.set(key, nodeId);
    if (this.nearestNodeCache.size <= MAX_NEAREST_NODE_CACHE_ENTRIES) {
      return;
    }

    const oldestKey = this.nearestNodeCache.keys().next().value;
    if (oldestKey !== undefined) {
      this.nearestNodeCache.delete(oldestKey);
    }
  }

  setCachedNodeRoute(key, route) {
    this.cachedNodeRoutes.set(key, route);
    if (this.cachedNodeRoutes.size <= MAX_ROUTE_CACHE_ENTRIES) {
      return;
    }

    const oldestKey = this.cachedNodeRoutes.keys().next().value;
    if (oldestKey !== undefined) {
      this.cachedNodeRoutes.delete(oldestKey);
    }
  }
}

function coordinatesEqual(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

function measurePath(coordinates) {
  let totalDistance = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    totalDistance += metersBetween(coordinates[index - 1], coordinates[index]);
  }

  return totalDistance;
}

export function buildRouteMetrics(path) {
  const cumulativeDistances = [0];
  let totalDistanceMeters = 0;

  for (let index = 1; index < path.length; index += 1) {
    totalDistanceMeters += metersBetween(path[index - 1], path[index]);
    cumulativeDistances.push(totalDistanceMeters);
  }

  return {
    path,
    cumulativeDistances,
    totalDistanceMeters,
  };
}

function findRouteSegmentIndex(cumulativeDistances, distanceMeters, hintIndex = 1) {
  const lastIndex = cumulativeDistances.length - 1;
  if (lastIndex <= 0) {
    return 0;
  }

  const clampedDistance = Math.max(0, distanceMeters);
  const boundedHintIndex = Math.min(Math.max(hintIndex, 1), lastIndex);
  const hintedStart = cumulativeDistances[boundedHintIndex - 1] ?? 0;
  const hintedEnd = cumulativeDistances[boundedHintIndex] ?? hintedStart;

  if (clampedDistance >= hintedStart && clampedDistance <= hintedEnd) {
    return boundedHintIndex;
  }

  let low = 1;
  let high = lastIndex;

  if (clampedDistance > hintedEnd) {
    low = boundedHintIndex + 1;
  } else if (clampedDistance < hintedStart) {
    high = boundedHintIndex - 1;
  }

  while (low <= high) {
    const middle = (low + high) >> 1;
    const segmentStartDistance = cumulativeDistances[middle - 1] ?? 0;
    const segmentEndDistance = cumulativeDistances[middle] ?? segmentStartDistance;

    if (clampedDistance < segmentStartDistance) {
      high = middle - 1;
      continue;
    }

    if (clampedDistance > segmentEndDistance) {
      low = middle + 1;
      continue;
    }

    return middle;
  }

  return Math.min(lastIndex, Math.max(1, low));
}

export function getPointAtDistance(routeMetrics, distanceMeters) {
  if (!routeMetrics || routeMetrics.path.length === 0) {
    return null;
  }

  const { path, cumulativeDistances } = routeMetrics;

  if (distanceMeters <= 0) {
    const nextPoint = path[1] ?? path[0];
    return {
      coordinates: path[0],
      bearing: bearingBetween(path[0], nextPoint),
    };
  }

  const routeLength = cumulativeDistances[cumulativeDistances.length - 1] ?? 0;
  if (distanceMeters >= routeLength) {
    const previousPoint = path[path.length - 2] ?? path[path.length - 1];
    const lastPoint = path[path.length - 1];
    return {
      coordinates: lastPoint,
      bearing: bearingBetween(previousPoint, lastPoint),
    };
  }

  const index = findRouteSegmentIndex(cumulativeDistances, distanceMeters);
  const segmentStartDistance = cumulativeDistances[index - 1] ?? 0;
  const segmentEndDistance = cumulativeDistances[index] ?? segmentStartDistance;
  const start = path[index - 1];
  const end = path[index];
  const segmentLength = segmentEndDistance - segmentStartDistance || 1;
  const t = (distanceMeters - segmentStartDistance) / segmentLength;

  return {
    coordinates: [
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t,
    ],
    bearing: bearingBetween(start, end),
  };
}

export function emptyFeatureCollection() {
  return {
    type: "FeatureCollection",
    features: [],
  };
}

export function buildRouteGeoJSON(route) {
  if (!route) {
    return emptyFeatureCollection();
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: route.coordinates,
        },
        properties: {
          id: route.id,
          distanceMeters: route.distanceMeters,
        },
      },
    ],
  };
}

export function buildPickedEndpointGeoJSON(startSelection, endSelection) {
  const features = [];

  if (startSelection) {
    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: startSelection.coordinate,
      },
      properties: {
        role: "start",
        label: startSelection.label,
      },
    });
  }

  if (endSelection) {
    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: endSelection.coordinate,
      },
      properties: {
        role: "end",
        label: endSelection.label,
      },
    });
  }

  return {
    type: "FeatureCollection",
    features,
  };
}
