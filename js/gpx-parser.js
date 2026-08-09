// gpx-parser.js — разбор GPX (и базовый TCX) в единый формат точек трека.

/**
 * Возвращает массив точек: { lat, lon, ele, time (Date|null), hr (number|null) }
 */
function parseGpx(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("Не удалось разобрать GPX-файл: неверный XML");

  const trkpts = Array.from(doc.getElementsByTagName("trkpt"));
  if (trkpts.length === 0) {
    throw new Error("В файле не найдено точек трека (<trkpt>)");
  }

  return trkpts.map((pt) => {
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    const eleEl = pt.getElementsByTagName("ele")[0];
    const timeEl = pt.getElementsByTagName("time")[0];
    // Пульс может быть в расширениях Garmin: gpxtpx:hr
    let hr = null;
    const hrEl =
      pt.getElementsByTagName("gpxtpx:hr")[0] ||
      pt.getElementsByTagName("hr")[0];
    if (hrEl) hr = parseFloat(hrEl.textContent);

    return {
      lat,
      lon,
      ele: eleEl ? parseFloat(eleEl.textContent) : null,
      time: timeEl ? new Date(timeEl.textContent) : null,
      hr,
    };
  });
}

/**
 * Очень базовый парсер TCX (Trackpoint-и по структуре похожи на GPX).
 */
function parseTcx(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("Не удалось разобрать TCX-файл: неверный XML");

  const trkpts = Array.from(doc.getElementsByTagName("Trackpoint"));
  if (trkpts.length === 0) {
    throw new Error("В файле не найдено точек трека (<Trackpoint>)");
  }

  return trkpts
    .map((pt) => {
      const posEl = pt.getElementsByTagName("Position")[0];
      if (!posEl) return null;
      const lat = parseFloat(
        posEl.getElementsByTagName("LatitudeDegrees")[0]?.textContent
      );
      const lon = parseFloat(
        posEl.getElementsByTagName("LongitudeDegrees")[0]?.textContent
      );
      const timeEl = pt.getElementsByTagName("Time")[0];
      const eleEl = pt.getElementsByTagName("AltitudeMeters")[0];
      const hrEl = pt.getElementsByTagName("Value")[0]; // внутри HeartRateBpm

      return {
        lat,
        lon,
        ele: eleEl ? parseFloat(eleEl.textContent) : null,
        time: timeEl ? new Date(timeEl.textContent) : null,
        hr: hrEl ? parseFloat(hrEl.textContent) : null,
      };
    })
    .filter((p) => p && !Number.isNaN(p.lat) && !Number.isNaN(p.lon));
}

/** Определяет формат по содержимому и парсит. */
function parseTrackFile(text, filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tcx")) return parseTcx(text);
  return parseGpx(text); // по умолчанию GPX
}
