import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, X } from "lucide-react";
import { BMSCE_MEL_FLOORPLAN } from "../data/bmsceFloorplan.js";

export default function CampusFloorplanModal({
  open,
  campusLabel,
  loading,
  error,
  nodes,
  sensors,
  lastSyncAt,
  onClose,
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const floorplan = BMSCE_MEL_FLOORPLAN;
  const floorplanWidth = floorplan.mapMetadata.totalWidth;
  const floorplanHeight = floorplan.mapMetadata.totalHeight;
  const hallwayNodes = floorplan.hallwayNodes;
  const exitNodes = floorplan.exits;
  const liftNodes = floorplan.lifts;
  const targetNodes = [...exitNodes, ...liftNodes];
  const projectedHallwayNodes = hallwayNodes.map((node) => projectFloorplanNode(node, floorplan.mapMetadata));
  const projectedTargetNodes = targetNodes.map((node) => projectFloorplanNode(node, floorplan.mapMetadata));
  const exitSensorScores = createScoreMap(sensors?.exits);
  const hallwaySensorScores = createScoreMap(sensors?.hallway);
  const sensorAwareNodes = {
    exits: targetNodes,
    hallway: hallwayNodes,
  };
  const floorplanSummary = summarizeLocalFloorplanSensors(sensorAwareNodes, {
    exits: targetNodes.map((node) => ({
      id: node.id,
      score: exitSensorScores.get(node.id) ?? 0,
    })),
    hallway: hallwayNodes.map((node) => ({
      id: node.id,
      score: hallwaySensorScores.get(node.id) ?? 0,
    })),
  });
  const routeAnalysis = computeBestEvacuationRoute({
    floorplan,
    exitSensorScores,
    hallwaySensorScores,
  });
  const recommendedTarget = routeAnalysis.recommendedTarget;
  const projectedPathNodes = routeAnalysis.recommendedPathNodes.map((node) =>
    projectFloorplanNode(node, floorplan.mapMetadata),
  );
  const targetRows = routeAnalysis.targetRows;
  const backendNodeCount =
    (Array.isArray(nodes?.exits) ? nodes.exits.length : 0) +
    (Array.isArray(nodes?.hallway) ? nodes.hallway.length : 0);

  const statusLabel = loading
    ? "Loading live temperature feed"
    : error
      ? "Live temperature feed unavailable. Showing the last known path."
      : lastSyncAt
        ? `Live temperature guidance updated ${formatModalTime(lastSyncAt)}`
        : "Temperature guidance ready";

  return (
    <div className="campus-modal-backdrop" onClick={onClose} aria-hidden="true">
      <section
        className="campus-modal campus-modal-floorplan"
        role="dialog"
        aria-modal="true"
        aria-labelledby="campus-modal-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="campus-modal-header">
          <div className="campus-modal-copy">
            <div className="campus-modal-kicker">Campus Floorplan</div>
            <h2 id="campus-modal-title" className="campus-modal-title">
              {campusLabel}
            </h2>
            <div className="campus-modal-subtitle">{statusLabel}</div>
            {error ? <div className="campus-modal-alert">{error}</div> : null}
          </div>

          <button
            type="button"
            className="campus-modal-close"
            onClick={onClose}
            aria-label="Close campus floorplan"
          >
            <X />
          </button>
        </header>

        <div className="campus-modal-grid campus-modal-grid-floorplan">
          <section className="campus-visual-card campus-floorplan-main-card">
            <div className="campus-visual-header">
              <div className="campus-visual-title">MEL Floor Evacuation Plan</div>
              <div className="campus-visual-caption">
                Path is recomputed continuously from the live sensor feed and follows the lowest-temperature corridor route.
              </div>
            </div>

            <div className="campus-floorplan-frame" aria-label="BMSCE MEL floorplan with node overlay">
              <img
                className="campus-floorplan-image"
                src="/floorplans/floor.jpeg"
                alt="BMSCE MEL floorplan"
              />
              <svg
                className="campus-floorplan-overlay"
                viewBox={`0 0 ${floorplanWidth} ${floorplanHeight}`}
                aria-hidden="true"
              >
                {projectedPathNodes.length > 1 ? (
                  <polyline
                    points={projectedPathNodes.map((node) => `${node.x},${node.y}`).join(" ")}
                    className="campus-floorplan-route"
                  />
                ) : null}

                {projectedHallwayNodes.map((node) => {
                  const isStart = node.id === floorplan.routeStartId;
                  const score = hallwaySensorScores.get(node.id) ?? 0;
                  const isEmergency = score >= 37;
                  return (
                    <g key={node.id}>
                      {isEmergency ? (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={isStart ? 18 : 14}
                          className="campus-floorplan-emergency-halo"
                        />
                      ) : null}
                      {isStart ? (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r="12"
                          className={`campus-floorplan-hallway is-static is-start ${isEmergency ? "is-emergency" : ""}`}
                        />
                      ) : (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r="9"
                          className={`campus-floorplan-hallway is-static ${isEmergency ? "is-emergency" : ""}`}
                        />
                      )}
                      <text
                        x={node.x}
                        y={node.y - (isStart ? 18 : 14)}
                        textAnchor="middle"
                        className={`campus-floorplan-temp ${isEmergency ? "is-emergency" : ""}`}
                      >
                        {Math.round(score)}
                      </text>
                    </g>
                  );
                })}

                {projectedTargetNodes.map((node) => {
                  const recommended = recommendedTarget?.id === node.id;
                  const score = exitSensorScores.get(node.id) ?? 0;
                  const isEmergency = score >= 37;
                  return (
                    <g key={node.id}>
                      {isEmergency ? (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r="16"
                          className="campus-floorplan-emergency-halo"
                        />
                      ) : null}
                      {node.type === "lift" ? (
                        <rect
                          x={node.x - 11}
                          y={node.y - 11}
                          width="22"
                          height="22"
                          className={`campus-floorplan-exit is-static ${recommended ? "is-recommended" : ""} ${isEmergency ? "is-emergency" : ""}`}
                        />
                      ) : (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r="10.5"
                          className={`campus-floorplan-exit is-static ${recommended ? "is-recommended" : ""} ${isEmergency ? "is-emergency" : ""}`}
                        />
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>
          </section>

          <aside className="campus-floorplan-sidebar">
            <div className="campus-metric-grid campus-metric-grid-floorplan">
              <article className="campus-metric-card">
                <div className="campus-metric-label">Recommended Exit</div>
                <div className="campus-metric-value">{recommendedTarget?.label ?? "Unavailable"}</div>
                <div className="campus-metric-detail">
                  {recommendedTarget?.type === "lift" ? "Lift eligible as exit" : "Coolest reachable evacuation target"}
                </div>
              </article>
              <article className="campus-metric-card">
                <div className="campus-metric-label">Accessible Targets</div>
                <div className="campus-metric-value">{floorplanSummary.accessibleExitCount}</div>
                <div className="campus-metric-detail">Exits and lifts currently reachable</div>
              </article>
              <article className="campus-metric-card">
                <div className="campus-metric-label">Hot Targets</div>
                <div className="campus-metric-value">{floorplanSummary.blockedExitCount}</div>
                <div className="campus-metric-detail">Temperature 37 or above</div>
              </article>
              <article className="campus-metric-card">
                <div className="campus-metric-label">Hallway Temperature</div>
                <div className="campus-metric-value">{floorplanSummary.avgHallwayScore}</div>
                <div className="campus-metric-detail">Average live temperature score</div>
              </article>
            </div>

            <section className="campus-exit-card">
              <div className="campus-visual-title">Evacuation Target Priority</div>
              <div className="campus-exit-list">
                {targetRows.map((targetRow, index) => (
                  <div key={targetRow.id} className="campus-exit-row">
                    <div className="campus-exit-copy">
                      <span>
                        {index + 1}. {targetRow.label}
                      </span>
                      <small>
                        {targetRow.kind === "lift" ? "Lift" : "Exit"} · {targetRow.statusLabel} · {targetRow.temperatureLabel}
                      </small>
                    </div>
                    <span className={getExitBadgeClass(targetRow.score)}>{targetRow.score}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="campus-exit-card">
              <div className="campus-visual-title">Route Guidance</div>
              <div className="campus-guidance-card">
                <div className="campus-guidance-row">
                  {recommendedTarget ? <CheckCircle2 /> : <AlertTriangle />}
                  <div>
                    <strong>{recommendedTarget?.label ?? "No recommended target"}</strong>
                    <span>
                      {recommendedTarget
                        ? "Move through the corridor nodes with the lowest live temperature values."
                        : "No valid target could be determined from the current graph."}
                    </span>
                  </div>
                </div>
                <div className="campus-guidance-route">
                  {routeAnalysis.recommendedPathNodes.map((node, index) => (
                    <div key={node.id} className="campus-guidance-step">
                      <span>{node.label}</span>
                      {index < routeAnalysis.recommendedPathNodes.length - 1 ? <ChevronRight /> : null}
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="campus-exit-card">
              <div className="campus-visual-title">Live Feed</div>
              <div className="campus-feed-detail">
                <div>Backend nodes detected: {backendNodeCount}</div>
                <div>Exit sensors: {Array.isArray(sensors?.exits) ? sensors.exits.length : 0}</div>
                <div>Hallway sensors: {Array.isArray(sensors?.hallway) ? sensors.hallway.length : 0}</div>
              </div>
            </section>
          </aside>
        </div>
      </section>
    </div>
  );
}

function summarizeLocalFloorplanSensors(nodes, sensors) {
  const exitNodes = Array.isArray(nodes?.exits) ? nodes.exits : [];
  const hallwayNodes = Array.isArray(nodes?.hallway) ? nodes.hallway : [];
  const exitScores = createScoreMap(sensors?.exits);
  const hallwayScores = createScoreMap(sensors?.hallway);
  const accessibleExitCount = exitNodes.filter((node) => (exitScores.get(node.id) ?? 0) < 37).length;
  const blockedExitCount = Math.max(0, exitNodes.length - accessibleExitCount);
  const hallwayValues = hallwayNodes.map((node) => hallwayScores.get(node.id) ?? 0);
  const avgHallwayScore =
    hallwayValues.length > 0
      ? Math.round(hallwayValues.reduce((sum, value) => sum + value, 0) / hallwayValues.length)
      : 0;

  return {
    accessibleExitCount,
    blockedExitCount,
    avgHallwayScore,
  };
}

function computeBestEvacuationRoute({ floorplan, exitSensorScores, hallwaySensorScores }) {
  const nodeById = new Map(
    [...floorplan.hallwayNodes, ...floorplan.exits, ...floorplan.lifts].map((node) => [node.id, node]),
  );
  const adjacency = new Map();
  const startId = floorplan.routeStartId;
  const nodeScoreById = new Map();

  floorplan.hallwayNodes.forEach((node) => {
    nodeScoreById.set(node.id, hallwaySensorScores.get(node.id) ?? 10);
  });
  floorplan.exits.forEach((node) => {
    nodeScoreById.set(node.id, exitSensorScores.get(node.id) ?? 10);
  });
  floorplan.lifts.forEach((node) => {
    nodeScoreById.set(node.id, exitSensorScores.get(node.id) ?? 10);
  });

  floorplan.edges.forEach(([leftId, rightId]) => {
    const leftNode = nodeById.get(leftId);
    const rightNode = nodeById.get(rightId);

    if (!leftNode || !rightNode) {
      return;
    }

    const edgeCost = getGraphEdgeCost({
      leftNode,
      rightNode,
      startId,
      nodeScoreById,
    });

    if (!Number.isFinite(edgeCost)) {
      return;
    }

    pushGraphEdge(adjacency, leftId, rightId, edgeCost);
    pushGraphEdge(adjacency, rightId, leftId, edgeCost);
  });

  const allTargets = [...floorplan.exits, ...floorplan.lifts];
  const accessibleTargets = allTargets.filter((target) => (exitSensorScores.get(target.id) ?? 0) < 37);
  const targetPool = accessibleTargets.length > 0 ? accessibleTargets : allTargets;
  const targetRows = targetPool
    .map((target) => {
      const pathResult = computeShortestPath(startId, target.id, adjacency);
      const score = exitSensorScores.get(target.id) ?? 0;
      const totalCost = pathResult?.totalCost ?? Number.POSITIVE_INFINITY;
      return {
        ...target,
        score,
        totalCost,
        pathNodeIds: pathResult?.pathNodeIds ?? [],
        statusLabel: score >= 37 ? "Emergency" : score >= 25 ? "Warm" : "Cool",
        temperatureLabel: Number.isFinite(totalCost) ? `${Math.round(totalCost)} temp cost` : "No route",
        kind: target.type,
      };
    })
    .sort((left, right) => {
      if (left.totalCost !== right.totalCost) {
        return left.totalCost - right.totalCost;
      }

      if ((left.score >= 37) !== (right.score >= 37)) {
        return left.score >= 37 ? 1 : -1;
      }

      if (left.score !== right.score) {
        return left.score - right.score;
      }

      return 0;
    });

  const recommendedRow = targetRows[0] ?? null;
  const recommendedPathNodes = (recommendedRow?.pathNodeIds ?? [])
    .map((nodeId) => nodeById.get(nodeId))
    .filter(Boolean);
  const recommendedCoordinates = recommendedPathNodes.map((node) => [node.x, node.y]);

  return {
    recommendedTarget: recommendedRow,
    recommendedPathNodes,
    recommendedCoordinates,
    targetRows,
  };
}

function computeShortestPath(startId, endId, adjacency) {
  const frontier = [{ nodeId: startId, totalCost: 0, pathNodeIds: [startId] }];
  const bestCostByNodeId = new Map([[startId, 0]]);

  while (frontier.length > 0) {
    frontier.sort((left, right) => left.totalCost - right.totalCost);
    const current = frontier.shift();

    if (!current) {
      break;
    }

    if (current.nodeId === endId) {
      return current;
    }

    const edges = adjacency.get(current.nodeId) ?? [];

    edges.forEach((edge) => {
      const nextCost = current.totalCost + edge.cost;
      const bestKnown = bestCostByNodeId.get(edge.toId);

      if (bestKnown !== undefined && nextCost >= bestKnown) {
        return;
      }

      bestCostByNodeId.set(edge.toId, nextCost);
      frontier.push({
        nodeId: edge.toId,
        totalCost: nextCost,
        pathNodeIds: [...current.pathNodeIds, edge.toId],
      });
    });
  }

  return null;
}

function pushGraphEdge(adjacency, fromId, toId, cost) {
  const existing = adjacency.get(fromId) ?? [];
  existing.push({ toId, cost });
  adjacency.set(fromId, existing);
}

function getGraphEdgeCost({ leftNode, rightNode, startId, nodeScoreById }) {
  const leftScore = nodeScoreById.get(leftNode.id) ?? 10;
  const rightScore = nodeScoreById.get(rightNode.id) ?? 10;
  const leftBlocked = leftNode.id !== startId && leftScore >= 37;
  const rightBlocked = rightNode.id !== startId && rightScore >= 37;

  if (leftBlocked || rightBlocked) {
    return Number.POSITIVE_INFINITY;
  }

  const baseDistance = getNodeDistance(leftNode, rightNode);
  const averageTemperature = (leftScore + rightScore) / 2;
  const temperatureFactor = 1 + averageTemperature / 18;
  return baseDistance * temperatureFactor;
}

function createScoreMap(sensorRows) {
  return new Map(
    (Array.isArray(sensorRows) ? sensorRows : []).map((row) => [
      row.id,
      Number(row.score ?? 0),
    ]),
  );
}

function getNodeDistance(left, right) {
  const deltaX = Number(left?.x ?? 0) - Number(right?.x ?? 0);
  const deltaY = Number(left?.y ?? 0) - Number(right?.y ?? 0);
  return Math.hypot(deltaX, deltaY);
}

function getFloorplanNodeClass(score, nodeType) {
  if (nodeType === "exit") {
    if (score >= 100) {
      return "campus-floorplan-exit is-blocked";
    }

    if (score >= 60) {
      return "campus-floorplan-exit is-warning";
    }

    return "campus-floorplan-exit";
  }

  if (score >= 90) {
    return "campus-floorplan-hallway is-critical";
  }

  if (score >= 60) {
    return "campus-floorplan-hallway is-warning";
  }

  return "campus-floorplan-hallway";
}

function getExitBadgeClass(score) {
  if (score >= 37) {
    return "campus-exit-badge is-blocked";
  }

  if (score >= 25) {
    return "campus-exit-badge is-warning";
  }

  return "campus-exit-badge";
}

function formatModalTime(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function projectFloorplanNode(node, metadata) {
  const normalizedWidth = Number(metadata?.normalizedWidth ?? 100);
  const normalizedHeight = Number(metadata?.normalizedHeight ?? 100);
  const totalWidth = Number(metadata?.totalWidth ?? 1280);
  const totalHeight = Number(metadata?.totalHeight ?? 719);

  return {
    ...node,
    x: (Number(node.x ?? 0) / normalizedWidth) * totalWidth,
    y: (Number(node.y ?? 0) / normalizedHeight) * totalHeight,
  };
}
