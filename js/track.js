// track.js — вычисление статистики трека: дистанция, темп по сегментам,
// используется и для панели статистики, и для раскраски линии по темпу.

/**
 * points: результат parseTrackFile
 * Возвращает обогащённый массив: каждая точка + distFromStart (м),
 * segPaceSecPerKm (темп сегмента до этой точки, null для первой точки).
 */
function computeTrackStats(points) {
  let distFromStart = 0;
  const enriched = points.map((p, i) => ({ ...p, distFromStart: 0, segPaceSecPerKm: null }));

  for (let i = 1; i < enriched.length; i++) {
    const prev = enriched[i - 1];
    const cur = enriched[i];
    const segDist = haversineDistance(prev.lat, prev.lon, cur.lat, cur.lon);
    distFromStart += segDist;
    cur.distFromStart = distFromStart;

    if (prev.time && cur.time) {
      const segSec = (cur.time - prev.time) / 1000;
      if (segDist > 0.5 && segSec > 0) {
        cur.segPaceSecPerKm = (segSec / segDist) * 1000;
      }
    }
  }

  const totalDist = distFromStart;
  const first = enriched[0];
  const last = enriched[enriched.length - 1];
  const totalTimeSec =
    first.time && last.time ? (last.time - first.time) / 1000 : null;

  const paces = enriched
    .map((p) => p.segPaceSecPerKm)
    .filter((v) => v !== null && Number.isFinite(v));
  const avgPaceSecPerKm =
    totalTimeSec && totalDist > 0 ? (totalTimeSec / totalDist) * 1000 : null;

  return {
    points: enriched,
    totalDistM: totalDist,
    totalTimeSec,
    avgPaceSecPerKm,
    minPaceSecPerKm: paces.length ? Math.min(...paces) : null,
    maxPaceSecPerKm: paces.length ? percentile(paces, 0.95) : null, // 95й перцентиль, чтобы выбросы (остановки) не убивали цветовую шкалу
  };
}

/**
 * Дистанция/время/темп для участка трека [startIdx, endIdx] (по точкам,
 * обогащённым computeTrackStats — важно, чтобы distFromStart уже был
 * посчитан). Используется для панели статистики при обрезке трека.
 */
function computeRangeStats(points, startIdx, endIdx) {
  const a = points[startIdx];
  const b = points[endIdx];
  const distM = Math.max(0, b.distFromStart - a.distFromStart);
  const timeSec = a.time && b.time ? (b.time - a.time) / 1000 : null;
  const paceSecPerKm = timeSec && distM > 0 ? (timeSec / distM) * 1000 : null;
  return { distM, timeSec, paceSecPerKm };
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
}

function formatDuration(totalSec) {
  if (totalSec === null || !Number.isFinite(totalSec)) return "—";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatPace(secPerKm) {
  if (secPerKm === null || !Number.isFinite(secPerKm)) return "—";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")} /км`;
}

function formatDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} км`;
  return `${Math.round(meters)} м`;
}

/** "#rrggbb" -> {r,g,b} (0-255) */
function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

/** Линейная интерполяция между двумя hex-цветами в RGB, t в [0,1]. */
function lerpColor(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bch = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r}, ${g}, ${bch})`;
}

/**
 * Цвет по темпу: прямая линейная интерполяция colorFast (быстро) -> colorSlow
 * (медленно) в RGB. Никаких зашитых промежуточных цветов — пользователь сам
 * выбирает оба конца, и градиент должен строго им соответствовать.
 */
function paceToColor(pace, minPace, maxPace, colorFast, colorSlow) {
  if (pace === null || !Number.isFinite(pace) || !minPace || !maxPace || minPace === maxPace) {
    return "#3b82f6"; // нейтральный синий, если темп неизвестен
  }
  let t = (pace - minPace) / (maxPace - minPace);
  t = Math.max(0, Math.min(1, t));
  return lerpColor(colorFast, colorSlow, t);
}

function paceGradientCss(colorFast, colorSlow) {
  return `linear-gradient(90deg, ${colorFast}, ${colorSlow})`;
}
