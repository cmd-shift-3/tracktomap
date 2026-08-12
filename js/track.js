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
    smoothedPace: smoothSegmentPaces(enriched), // только для раскраски линии — см. комментарий у функции
  };
}

/**
 * Сглаженный по скользящему окну темп для КАЖДОГО сегмента — используется
 * ТОЛЬКО для раскраски линии по темпу, а не для статистики или поиска
 * времени. "Сырой" темп segPaceSecPerKm считается по паре соседних точек —
 * при типичном шаге GPS в 1 секунду и погрешности позиционирования порядка
 * нескольких метров такая "мгновенная скорость" очень шумная: соседние
 * крошечные отрезки могут иметь заметно разный темп просто из-за шума GPS,
 * а не из-за реального изменения скорости. Если красить каждый такой
 * отрезок по его сырому значению, при увеличении карты видна мелкая
 * "штриховка"/полосатость вместо плавного градиента вдоль трека. Усреднение
 * по окну соседних сегментов убирает этот шум — не трогая ни расстояние, ни
 * длительность, ни саму статистику (avg/min/max темп считаются по сырым
 * значениям, как и раньше).
 */
function smoothSegmentPaces(points, windowRadius = 4) {
  const n = points.length;
  const smoothed = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - windowRadius); j <= Math.min(n - 1, i + windowRadius); j++) {
      const v = points[j].segPaceSecPerKm;
      if (v !== null && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    smoothed[i] = count > 0 ? sum / count : null;
  }
  return smoothed;
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
 * Цвет по позиции t в [0,1] на МНОГОЦВЕТНОМ градиенте: stops — массив
 * hex-цветов, равномерно расставленных по t от 0 (первая остановка) до 1
 * (последняя). Например для 4 остановок [зелёный, жёлтый, оранжевый,
 * красный] отрезок t∈[0, 1/3] — это плавный переход зелёный→жёлтый,
 * [1/3, 2/3] — жёлтый→оранжевый, [2/3, 1] — оранжевый→красный: внутри
 * каждого такого отрезка используется обычная линейная интерполяция
 * (lerpColor), поэтому весь переход остаётся плавным на всём диапазоне,
 * без резких скачков цвета на стыках остановок.
 */
function multiStopColor(t, stops) {
  if (!stops || stops.length === 0) return "#3b82f6";
  if (stops.length === 1) return stops[0];
  t = Math.max(0, Math.min(1, t));
  const segCount = stops.length - 1;
  const scaled = t * segCount;
  let idx = Math.floor(scaled);
  if (idx >= segCount) idx = segCount - 1; // t === 1 попадает точно в последнюю остановку
  const localT = scaled - idx;
  return lerpColor(stops[idx], stops[idx + 1], localT);
}

/**
 * Цвет по темпу: minPace/maxPace — границы шкалы (левая/правая, задаются
 * пользователем через ползунки — см. app.js: paceMinSecPerKm/
 * paceMaxSecPerKm), stops — массив цветов градиента (по умолчанию 4:
 * быстро→медленно). Само значение пейса линейно проецируется в t∈[0,1]
 * между границами, а цвет для этого t берётся из multiStopColor.
 */
function paceToColor(pace, minPace, maxPace, stops) {
  if (pace === null || !Number.isFinite(pace) || !minPace || !maxPace || minPace === maxPace) {
    return "#3b82f6"; // нейтральный синий, если темп неизвестен
  }
  const t = (pace - minPace) / (maxPace - minPace);
  return multiStopColor(t, stops);
}

/** CSS linear-gradient с остановками, равномерно расставленными по ширине —
 *  используется для полоски-превью в панели "Темп". */
function paceGradientCss(stops) {
  if (!stops || stops.length === 0) return "none";
  if (stops.length === 1) return stops[0];
  const parts = stops.map((c, i) => `${c} ${(i / (stops.length - 1)) * 100}%`);
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}
