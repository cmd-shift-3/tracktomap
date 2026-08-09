// app.js — состояние приложения, отрисовка на canvas, обработка UI.

const CONTROL_POINT_COLOR = "#facc15"; // жёлтый — хорошо читается почти на любом фоне карты
const CURRENT_POINT_COLOR = "#38bdf8";
const MARKER_OUTLINE_COLOR = "#000000";
const MARKER_OUTLINE_WIDTH = 0.6; // очень тонкая, но заметная чёрная оконтовка

const state = {
  mapImage: null, // HTMLImageElement
  fitScale: 1, // масштаб "по размеру окна" (без учёта зума пользователя)
  zoomLevel: 1, // множитель поверх fitScale — управляется зум-контролами
  canvasScale: 1, // CSS-пиксели канваса = image px * canvasScale (= fitScale * zoomLevel)
  displayW: 0,
  displayH: 0,
  trackRaw: null, // сырые точки из файла
  trackStats: null, // computeTrackStats(...)
  projection: null, // makeProjection(...)
  controlPoints: [], // [{ trackIndex, source:{x,y}m, target:{x,y}imgPx }], всегда отсортирован по trackIndex
  model: null, // buildSegmentedModel(controlPoints): { segments }
  armedForClick: false, // ждём клика по карте для новой опорной точки
  selectedTrackIndex: 0,
  hoverTrackIndex: null, // точка трека под курсором мыши (предпросмотр перед фиксацией кликом)
  paceColorFast: "#22c55e",
  paceColorSlow: "#ef4444",
  routeOpacity: 0.7,
  routeWidth: 4,
  trimStart: 0, // индекс точки трека — начало ПРИМЕНЁННОЙ обрезки (используется в render/статистике/точке отсчёта времени)
  trimEnd: 0, // индекс точки трека — конец ПРИМЕНЁННОЙ обрезки
  trimStartDraft: 0, // черновые значения слайдеров/полей панели обрезки — не влияют ни на что, пока не нажата "Применить"
  trimEndDraft: 0,
};

const el = {
  layoutMain: document.getElementById("layoutMain"),
  mapInput: document.getElementById("mapInput"),
  trackInput: document.getElementById("trackInput"),
  canvas: document.getElementById("canvas"),
  canvasWrap: document.getElementById("canvasWrap"),
  canvasArea: document.getElementById("canvasArea"),
  emptyState: document.getElementById("emptyState"),
  statsPanel: document.getElementById("statsPanel"),
  statDistance: document.getElementById("statDistance"),
  statDuration: document.getElementById("statDuration"),
  statPace: document.getElementById("statPace"),
  calibPanel: document.getElementById("calibPanel"),
  timeInput: document.getElementById("timeInput"),
  trackSlider: document.getElementById("trackSlider"),
  trackSliderLabel: document.getElementById("trackSliderLabel"),
  armButton: document.getElementById("armButton"),
  controlPointList: document.getElementById("controlPointList"),
  exportButton: document.getElementById("exportButton"),
  undoButton: document.getElementById("undoButton"),
  clearCalibButton: document.getElementById("clearCalibButton"),
  statusMsg: document.getElementById("statusMsg"),
  legendGradient: document.getElementById("legendGradient"),
  colorFast: document.getElementById("colorFast"),
  colorSlow: document.getElementById("colorSlow"),
  opacitySlider: document.getElementById("opacitySlider"),
  opacityValue: document.getElementById("opacityValue"),
  widthSlider: document.getElementById("widthSlider"),
  widthValue: document.getElementById("widthValue"),
  zoomPanel: document.getElementById("zoomPanel"),
  zoomSlider: document.getElementById("zoomSlider"),
  zoomValue: document.getElementById("zoomValue"),
  zoomResetButton: document.getElementById("zoomResetButton"),
  trimPanel: document.getElementById("trimPanel"),
  trimToggleButton: document.getElementById("trimToggleButton"),
  trimStartSlider: document.getElementById("trimStartSlider"),
  trimStartValue: document.getElementById("trimStartValue"),
  trimStartInput: document.getElementById("trimStartInput"),
  trimEndSlider: document.getElementById("trimEndSlider"),
  trimEndValue: document.getElementById("trimEndValue"),
  trimEndInput: document.getElementById("trimEndInput"),
  trimApplyButton: document.getElementById("trimApplyButton"),
  trimResetButton: document.getElementById("trimResetButton"),
};

el.themeToggleButton = document.getElementById("themeToggleButton");

const ctx = el.canvas.getContext("2d");

// ---------- Тема (светлая/тёмная) ----------
//
// Светлая тема — дефолт: если в localStorage ничего не сохранено, атрибут
// data-theme на <html> не ставится вовсе, и работают значения из :root
// (светлая палитра). Тёмная тема включается атрибутом data-theme="dark",
// который переопределяет те же CSS-переменные — остальной CSS ничего не
// знает о темах и просто использует var(--...).

const THEME_STORAGE_KEY = "tracktomap-theme";

function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY);
  } catch (e) {
    // localStorage может быть недоступен (приватный режим и т.п.) — просто
    // остаёмся на дефолтной светлой теме без сохранения выбора.
  }
  applyTheme(saved === "dark" ? "dark" : "light");
}

const THEME_TRANSITION_FALLBACK_MS = 500; // должно совпадать с длительностью .theme-transition в style.css

/** Переключает тему с анимацией (см. style.css: theme-reveal / .theme-transition).
 *  clickEvent нужен только для кругового раскрытия — чтобы анимация
 *  расходилась из точки клика по кнопке, а не из центра экрана. */
function switchTheme(next, clickEvent) {
  const applyAndPersist = () => {
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (e) {
      // игнорируем — тема всё равно применится, просто не переживёт перезагрузку
    }
  };

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) {
    applyAndPersist();
    return;
  }

  // Круговое раскрытие через View Transitions API — есть не везде (нет в
  // Firefox на момент написания), поэтому обязательно проверяем поддержку.
  if (typeof document.startViewTransition === "function") {
    if (clickEvent) {
      document.documentElement.style.setProperty("--theme-x", `${clickEvent.clientX}px`);
      document.documentElement.style.setProperty("--theme-y", `${clickEvent.clientY}px`);
    }
    document.startViewTransition(applyAndPersist);
    return;
  }

  // Fallback: короткое окно, где все цветовые свойства плавно
  // интерполируются (см. .theme-transition в style.css), затем класс
  // снимается — постоянно держать его нельзя, иначе он перебьёт hover-
  // transition обычных интерактивных элементов своим !important.
  document.documentElement.classList.add("theme-transition");
  applyAndPersist();
  window.setTimeout(() => {
    document.documentElement.classList.remove("theme-transition");
  }, THEME_TRANSITION_FALLBACK_MS);
}

el.themeToggleButton.addEventListener("click", (e) => {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const next = isDark ? "light" : "dark";
  switchTheme(next, e);
});

initTheme();

function showStatus(msg, isError = false) {
  el.statusMsg.textContent = msg;
  el.statusMsg.classList.toggle("error", isError);
  el.statusMsg.classList.toggle("visible", !!msg);
}

// ---------- Загрузка файлов ----------

async function handleMapFile(file) {
  try {
    const img = await loadImageFile(file);
    state.mapImage = img;
    state.zoomLevel = 1;
    el.layoutMain.classList.remove("no-map");
    document.body.classList.remove("no-map");
    fitCanvasToContainer();
    render();
    el.emptyState.classList.add("hidden");
    el.zoomPanel.classList.remove("hidden");
    syncZoomUI();
    showStatus(`Карта загружена: ${file.name} (${img.naturalWidth}×${img.naturalHeight})`);
  } catch (err) {
    showStatus("Не удалось загрузить изображение карты: " + err.message, true);
  }
}

async function handleTrackFile(file) {
  try {
    const text = await file.text();
    const points = parseTrackFile(text, file.name);
    state.trackRaw = points;
    state.trackStats = computeTrackStats(points);
    state.projection = makeProjection(points[0].lat, points[0].lon);
    state.controlPoints = [];
    state.model = null;
    state.selectedTrackIndex = 0;
    state.trimStart = 0;
    state.trimEnd = points.length - 1;
    state.trimStartDraft = 0;
    state.trimEndDraft = points.length - 1;
    updateStatsPanel();
    updateCalibPanel();
    updateTrimPanel();
    render();
    showStatus(`Трек загружен: ${file.name} (${points.length} точек)`);
  } catch (err) {
    showStatus("Не удалось загрузить трек: " + err.message, true);
  }
}

el.mapInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await handleMapFile(file);
  el.mapInput.value = ""; // позволяет повторно выбрать тот же файл
});

el.trackInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await handleTrackFile(file);
  el.trackInput.value = "";
});

// ---------- Кнопки и drag-and-drop в пустом состоянии ----------
//
// Кнопки внутри дропзоны — это точно такие же <label class="file-btn"> со
// своим скрытым <input type="file">, что и в верхнем меню (просто у них
// свои id, т.к. второй <input> с тем же id в DOM невозможен).

el.emptyMapInput = document.getElementById("emptyMapInput");
el.emptyTrackInput = document.getElementById("emptyTrackInput");

el.emptyMapInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await handleMapFile(file);
  el.emptyMapInput.value = "";
});

el.emptyTrackInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await handleTrackFile(file);
  el.emptyTrackInput.value = "";
});

function isImageFile(file) {
  return file.type.startsWith("image/");
}
function isTrackFile(file) {
  return /\.(gpx|tcx)$/i.test(file.name);
}

// Перетаскивание файла работает над всей областью карты — и до, и после
// её загрузки (например, чтобы сразу докинуть ещё и трек).
["dragenter", "dragover"].forEach((evt) => {
  el.canvasWrap.addEventListener(evt, (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    el.canvasWrap.classList.add("drag-active");
  });
});

el.canvasWrap.addEventListener("dragleave", (e) => {
  if (e.relatedTarget && el.canvasWrap.contains(e.relatedTarget)) return;
  el.canvasWrap.classList.remove("drag-active");
});

el.canvasWrap.addEventListener("drop", async (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  el.canvasWrap.classList.remove("drag-active");

  const files = Array.from(e.dataTransfer.files);
  const mapFile = files.find(isImageFile);
  const trackFile = files.find(isTrackFile);

  if (!mapFile && !trackFile) {
    showStatus("Перетащи файл карты (JPG/PNG) или трека (GPX/TCX)", true);
    return;
  }
  if (mapFile) await handleMapFile(mapFile);
  if (trackFile) await handleTrackFile(trackFile);
});

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("файл повреждён или не является изображением"));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Canvas: масштаб и отрисовка ----------
//
// Канвас имеет два разных размера: CSS-размер (что видит пользователь) и
// "backing store" — реальное число пикселей в буфере отрисовки. На Retina-
// экранах CSS-пиксель — это 2 (иногда 3) физических пикселя; если рисовать
// 1-в-1 без поправки на это, всё выглядит смазанным. Поэтому backing store
// делаем в devicePixelRatio раз больше и один раз ставим трансформацию
// ctx.setTransform(dpr,...) — дальше весь остальной код рисует как обычно,
// в CSS-пикселях, а браузер сам выдаёт чёткую картинку.

function computeFitScale() {
  const containerPaddingX = 48; // .canvas-area: padding-left/right 24px
  const reservedVertical = 150; // топбар + вертикальные отступы + строка статуса
  const availW = Math.max(240, el.canvasArea.clientWidth - containerPaddingX);
  const availH = Math.max(240, window.innerHeight - reservedVertical);

  const natW = state.mapImage.naturalWidth;
  const natH = state.mapImage.naturalHeight;

  // Разрешаем небольшой апскейл (до 1.4x), если скан меньше доступного места —
  // так карта не остаётся крошечной на большом экране.
  return Math.min(availW / natW, availH / natH, 1.4);
}

/** Пересчитывает реальный размер канваса из fitScale*zoomLevel. Не трогает
 *  fitScale — используется и при смене зума, и при изменении окна. Если
 *  итоговый размер больше видимой области .canvas-area, там появляется
 *  прокрутка (overflow: auto в CSS) — так работает панорамирование при
 *  увеличении карты. */
function applyCanvasSize() {
  if (!state.mapImage) return;
  const natW = state.mapImage.naturalWidth;
  const natH = state.mapImage.naturalHeight;

  const scale = state.fitScale * state.zoomLevel;
  state.canvasScale = scale;
  state.displayW = Math.round(natW * scale);
  state.displayH = Math.round(natH * scale);

  const dpr = window.devicePixelRatio || 1;
  el.canvas.style.width = state.displayW + "px";
  el.canvas.style.height = state.displayH + "px";
  el.canvas.width = Math.round(state.displayW * dpr);
  el.canvas.height = Math.round(state.displayH * dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function fitCanvasToContainer() {
  if (!state.mapImage) return;
  state.fitScale = computeFitScale();
  applyCanvasSize();
}

window.addEventListener("resize", () => {
  if (state.mapImage) {
    fitCanvasToContainer(); // пересчитывает fitScale по новому размеру окна, zoomLevel сохраняется
    render();
  }
});

function render() {
  if (!state.mapImage) return;

  // Очистка должна пройти по всему backing store, а не по CSS-размеру,
  // поэтому временно сбрасываем трансформацию.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  ctx.restore();

  ctx.drawImage(state.mapImage, 0, 0, state.displayW, state.displayH);
  drawRoute();
  drawControlPoints();
  drawCurrentIndicator();
}

function imgToCanvas(pt) {
  return { x: pt.x * state.canvasScale, y: pt.y * state.canvasScale };
}

function canvasToImg(pt) {
  return { x: pt.x / state.canvasScale, y: pt.y / state.canvasScale };
}

function projectTrackPoint(index) {
  const p = state.trackStats.points[index];
  const m = state.projection.toMeters(p.lat, p.lon);
  return projectWithSegmentedModel(state.model, index, m);
}

/** Отдельный канвас для трека — переиспользуем между кадрами, чтобы не
 *  создавать новый элемент на каждый render(). Размер подгоняется под
 *  текущий backing store основного канваса в fitCanvasToContainer(). */
const routeBuffer = document.createElement("canvas");
const routeBufferCtx = routeBuffer.getContext("2d");

function drawRoute() {
  if (!state.model || !state.trackStats) return;
  const { points, minPaceSecPerKm, maxPaceSecPerKm } = state.trackStats;
  const projected = points.map((p, i) => imgToCanvas(projectTrackPoint(i)));

  // Трек рисуется на отдельном канвасе с ПОЛНОЙ непрозрачностью (каждый
  // сегмент поверх предыдущего без прозрачности), а затем весь результат
  // одним изображением накладывается на карту с нужной прозрачностью.
  // Если вместо этого рисовать каждый сегмент сразу с globalAlpha < 1 (как
  // было раньше), скруглённые стыки соседних сегментов накладываются друг
  // на друга и повторно смешиваются с подложкой — на стыках получаются
  // заметно более тёмные кружки, и линия выглядит как цепочка точек, а не
  // как ровная гладкая линия. Отрисовка в один проход это устраняет.
  routeBuffer.width = el.canvas.width;
  routeBuffer.height = el.canvas.height;
  const dpr = window.devicePixelRatio || 1;
  routeBufferCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Толщина линии задаётся в "метрах карты" (пикселях при zoomLevel=1) и
  // масштабируется вместе с зумом — иначе при уменьшении масштаба карты
  // линия остаётся того же экранного размера, а сама карта становится
  // меньше, и трек визуально "толстеет" относительно неё.
  const scaledRouteWidth = state.routeWidth * state.zoomLevel;
  routeBufferCtx.lineWidth = scaledRouteWidth;
  routeBufferCtx.lineJoin = "round";
  // lineCap "round" рисует у каждого короткого сегмента отдельную
  // полукруглую "шапочку" на обоих концах — при частых точках GPS-трека
  // (короткие сегменты) эти шапочки визуально сливаются в цепочку кружков.
  // "butt" обрезает сегмент ровно по длине — соседние сегменты стыкуются
  // краями, и линия читается как одна непрерывная полоса.
  routeBufferCtx.lineCap = "butt";
  // Небольшое перекрытие концов каждого сегмента (на полтолщины линии)
  // устраняет тонкие зазоры/зубцы на поворотах, которые остаются при
  // butt-обрезке двух отдельных stroke()-вызовов, встречающихся под углом.
  const overlap = scaledRouteWidth * 0.5;
  const from = Math.max(1, state.trimStart + 1);
  const to = Math.min(projected.length - 1, state.trimEnd);
  for (let i = from; i <= to; i++) {
    const a = projected[i - 1];
    const b = projected[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let sx = a.x, sy = a.y, ex = b.x, ey = b.y;
    if (len > 0) {
      const ux = dx / len;
      const uy = dy / len;
      sx -= ux * overlap;
      sy -= uy * overlap;
      ex += ux * overlap;
      ey += uy * overlap;
    }
    const pace = points[i].segPaceSecPerKm;
    routeBufferCtx.strokeStyle = paceToColor(pace, minPaceSecPerKm, maxPaceSecPerKm, state.paceColorFast, state.paceColorSlow);
    routeBufferCtx.beginPath();
    routeBufferCtx.moveTo(sx, sy);
    routeBufferCtx.lineTo(ex, ey);
    routeBufferCtx.stroke();
  }

  ctx.save();
  ctx.globalAlpha = state.routeOpacity;
  ctx.setTransform(1, 0, 0, 1, 0, 0); // буфер уже в пикселях backing store — переносим 1:1
  ctx.drawImage(routeBuffer, 0, 0);
  ctx.restore(); // сброс globalAlpha и трансформации — маркеры ниже должны быть непрозрачными
}

/** Первая опорная точка — "S", последняя — "F", остальные пронумерованы с 1. */
function controlPointLabel(i, total) {
  if (total <= 1) return "S";
  if (i === 0) return "S";
  if (i === total - 1) return "F";
  return String(i);
}

function drawControlPoints() {
  const total = state.controlPoints.length;
  const r = 6;
  const colorWidth = 1.25;
  state.controlPoints.forEach((cp, i) => {
    const pt = imgToCanvas(cp.target);

    // Чёрная подложка чуть шире цветного контура: после того как поверх
    // пройдёт более тонкий цветной штрих, по обеим сторонам останется
    // очень тонкая чёрная кайма — кружок читается на любом фоне карты.
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = MARKER_OUTLINE_COLOR;
    ctx.lineWidth = colorWidth + MARKER_OUTLINE_WIDTH * 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = CONTROL_POINT_COLOR; // без заливки — только контур, карта видна сквозь кружок
    ctx.lineWidth = colorWidth;
    ctx.stroke();

    const label = controlPointLabel(i, total);
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = MARKER_OUTLINE_WIDTH * 2;
    ctx.strokeStyle = MARKER_OUTLINE_COLOR;
    ctx.strokeText(label, pt.x, pt.y - 12);
    ctx.fillStyle = CONTROL_POINT_COLOR;
    ctx.fillText(label, pt.x, pt.y - 12);
  });
}

/** Точка трека, отслеживаемая указателем мыши/зафиксированная кликом —
 *  видна прямо на карте. Пока курсор над треком — индикатор следует за
 *  ним (hoverTrackIndex); клик фиксирует эту точку как selectedTrackIndex. */
function drawCurrentIndicator() {
  if (!state.model || !state.trackStats) return;
  const idx = state.hoverTrackIndex !== null ? state.hoverTrackIndex : state.selectedTrackIndex;
  const pt = imgToCanvas(projectTrackPoint(idx));

  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(56, 189, 248, 0.25)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = CURRENT_POINT_COLOR;
  ctx.fill();

  const label = elapsedLabel(idx) ?? `№${idx}`;
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = MARKER_OUTLINE_WIDTH * 2;
  ctx.strokeStyle = MARKER_OUTLINE_COLOR;
  ctx.strokeText(label, pt.x, pt.y - 16);
  ctx.fillStyle = CURRENT_POINT_COLOR;
  ctx.fillText(label, pt.x, pt.y - 16);
}

// ---------- Время: всегда "от старта обрезки" ----------
//
// Точка отсчёта — не первая точка всего трека, а state.trimStart. Значит,
// когда пользователь двигает левый край обрезки, все показываемые времена
// (слайдер, список опорных точек, панель обрезки) автоматически сдвигаются
// относительно нового начала — отдельно ничего пересчитывать не нужно.
// Точки до trimStart получают отрицательное время ("-1:20") — это точки
// разминки, которые ещё не входят в учитываемый участок.

function elapsedSeconds(index) {
  const pts = state.trackStats.points;
  const origin = pts[state.trimStart] || pts[0];
  const p = pts[index];
  if (!origin.time || !p.time) return null;
  return (p.time - origin.time) / 1000;
}

function formatElapsed(sec) {
  if (sec === null || !Number.isFinite(sec)) return "—";
  const neg = sec < 0;
  const s = Math.round(Math.abs(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const body = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
  return neg ? `-${body}` : body;
}

function elapsedLabel(index) {
  const p = state.trackStats.points[index];
  if (!p.time) return null;
  return formatElapsed(elapsedSeconds(index));
}

function findNearestIndexByElapsed(targetSec) {
  const pts = state.trackStats.points;
  const origin = pts[state.trimStart] || pts[0];
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (!pts[i].time || !origin.time) continue;
    const diff = Math.abs((pts[i].time - origin.time) / 1000 - targetSec);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Парсит строку времени ("м:сс" или "ч:мм:сс", можно с "-" впереди для
 *  времени до начала обрезки) в индекс точки трека. null при неверном формате. */
function parseTimeStringToIndex(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const neg = trimmed.startsWith("-");
  const body = neg ? trimmed.slice(1) : trimmed;
  const parts = body.split(":").map((s) => parseInt(s, 10));
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;

  let sec;
  if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else sec = parts[0];
  return findNearestIndexByElapsed(neg ? -sec : sec);
}

/** Текст подписи слайдера для произвольного индекса — без побочных эффектов. */
function sliderLabelText(idx) {
  const p = state.trackStats.points[idx];
  if (!p.time) return `точка №${idx}`;
  return `${formatElapsed(elapsedSeconds(idx))} от старта`;
}

/** Выбрать точку трека. syncInput=false — не перезаписывать поле времени
 *  (используется при вводе с клавиатуры, чтобы не сбивать то, что печатает пользователь). */
function selectTrackIndex(idx, { syncInput = true } = {}) {
  state.selectedTrackIndex = idx;
  el.trackSlider.value = idx;
  el.trackSliderLabel.textContent = sliderLabelText(idx);
  if (syncInput) el.timeInput.value = elapsedLabel(idx) ?? "";
  render();
}

el.trackSlider.addEventListener("input", () => {
  selectTrackIndex(Number(el.trackSlider.value));
});

// Автопереход при вводе времени вручную — без отдельной кнопки. Ошибки
// формата тут молча игнорируются (пользователь мог не дописать число).
el.timeInput.addEventListener("input", () => {
  const idx = parseTimeStringToIndex(el.timeInput.value);
  if (idx !== null) selectTrackIndex(idx, { syncInput: false });
});

function commitTimeInput() {
  const idx = parseTimeStringToIndex(el.timeInput.value);
  if (idx === null) {
    showStatus("Неверный формат, используй ММ:СС или Ч:ММ:СС", true);
    return;
  }
  selectTrackIndex(idx); // переформатирует поле начисто
}

el.timeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") commitTimeInput();
});

// ---------- Калибровка (опорные точки) ----------

el.armButton.addEventListener("click", () => {
  if (state.armedForClick) {
    // Повторный клик по этой же кнопке во время ожидания клика по карте —
    // отменяет добавление опорной точки.
    state.armedForClick = false;
    el.armButton.textContent = "Добавить опорную точку";
    el.armButton.classList.remove("armed");
    updateCanvasCursor();
    return;
  }
  if (!state.mapImage) {
    showStatus("Сначала загрузи изображение карты", true);
    return;
  }
  state.armedForClick = true;
  el.armButton.textContent = "Отмена";
  el.armButton.classList.add("armed");
  updateCanvasCursor();
});

el.canvas.addEventListener("click", (e) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  if (!state.armedForClick) {
    // Обычный клик по карте (не в режиме добавления опорной точки) —
    // фиксирует точку трека, за которой сейчас "следит" индикатор.
    if (state.hoverTrackIndex !== null) {
      selectTrackIndex(state.hoverTrackIndex);
    }
    return;
  }
  const rect = el.canvas.getBoundingClientRect();
  const canvasPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const imgPt = canvasToImg(canvasPt);

  const trackPoint = state.trackStats.points[state.selectedTrackIndex];
  const source = state.projection.toMeters(trackPoint.lat, trackPoint.lon);

  state.controlPoints.push({
    trackIndex: state.selectedTrackIndex,
    source,
    target: imgPt,
  });
  sortControlPoints();

  state.armedForClick = false;
  el.armButton.textContent = "Добавить опорную точку";
  el.armButton.classList.remove("armed");
  updateCanvasCursor();

  recomputeModel();
  updateCalibPanel();
  render();
});

el.undoButton.addEventListener("click", () => {
  state.controlPoints.pop();
  recomputeModel();
  updateCalibPanel();
  render();
});

el.clearCalibButton.addEventListener("click", () => {
  state.controlPoints = [];
  state.model = null;
  updateCalibPanel();
  render();
});

/** Опорные точки всегда идут по возрастанию времени/индекса трека — и для
 *  корректной посегментной модели, и чтобы нумерация в списке была осмысленной. */
function sortControlPoints() {
  state.controlPoints.sort((a, b) => a.trackIndex - b.trackIndex);
}

function recomputeModel() {
  state.model = buildSegmentedModel(state.controlPoints);
}

function removeControlPoint(index) {
  state.controlPoints.splice(index, 1);
  recomputeModel();
  updateCalibPanel();
  render();
}

/** Изменение времени уже добавленной опорной точки — двигает её вдоль трека,
 *  не трогая место клика на карте. */
function retimeControlPoint(index, raw) {
  const newIdx = parseTimeStringToIndex(raw);
  if (newIdx === null) {
    showStatus("Неверный формат, используй ММ:СС или Ч:ММ:СС", true);
    updateCalibPanel(); // откатить текстовое поле к прежнему значению
    return;
  }
  const cp = state.controlPoints[index];
  const newPoint = state.trackStats.points[newIdx];
  cp.trackIndex = newIdx;
  cp.source = state.projection.toMeters(newPoint.lat, newPoint.lon);
  sortControlPoints();
  recomputeModel();
  updateCalibPanel();
  render();
}

// ---------- Оформление трека: цвета, прозрачность, толщина ----------

function updateLegendGradient() {
  el.legendGradient.style.background = paceGradientCss(state.paceColorFast, state.paceColorSlow);
}

el.colorFast.addEventListener("input", () => {
  state.paceColorFast = el.colorFast.value;
  updateLegendGradient();
  render();
});

el.colorSlow.addEventListener("input", () => {
  state.paceColorSlow = el.colorSlow.value;
  updateLegendGradient();
  render();
});

el.colorFast.value = state.paceColorFast;
el.colorSlow.value = state.paceColorSlow;
updateLegendGradient();

el.opacitySlider.addEventListener("input", () => {
  state.routeOpacity = Number(el.opacitySlider.value) / 100;
  el.opacityValue.textContent = `${el.opacitySlider.value}%`;
  render();
});

el.widthSlider.addEventListener("input", () => {
  state.routeWidth = Number(el.widthSlider.value);
  el.widthValue.textContent = `${state.routeWidth} px`;
  render();
});

el.opacitySlider.value = Math.round(state.routeOpacity * 100);
el.opacityValue.textContent = `${el.opacitySlider.value}%`;
el.widthSlider.value = state.routeWidth;
el.widthValue.textContent = `${state.routeWidth} px`;

// ---------- Обрезка трека (начало/конец) ----------
//
// Трек не удаляется из данных — просто trimStart/trimEnd задают ПРИМЕНЁННЫЙ
// диапазон индексов, который учитывается при отрисовке линии (drawRoute),
// подсчёте статистики (updateStatsPanel) и как точка отсчёта времени
// (elapsedSeconds). Пока пользователь двигает слайдеры/вводит время вручную,
// меняется только ЧЕРНОВИК (trimStartDraft/trimEndDraft) — карта, статистика
// и список опорных точек не трогаются. Реальное применение (включая
// удаление опорных точек, оказавшихся за пределами нового диапазона) —
// только по кнопке "Применить".

function trimTimeLabel(idx) {
  const p = state.trackStats.points[idx];
  if (!p.time) return `№${idx}`;
  return formatElapsed(elapsedSeconds(idx));
}

/** Опорные точки, оказавшиеся за пределами [trimStart, trimEnd] после
 *  применения обрезки, больше не имеют смысла (трек в этом месте не рисуется
 *  и не учитывается в статистике) — убираем их и пересчитываем модель. */
function pruneControlPointsOutsideTrim() {
  const before = state.controlPoints.length;
  state.controlPoints = state.controlPoints.filter(
    (cp) => cp.trackIndex >= state.trimStart && cp.trackIndex <= state.trimEnd
  );
  const removed = before - state.controlPoints.length;
  if (removed > 0) {
    recomputeModel();
    showStatus(
      removed === 1
        ? "Опорная точка вне обрезки удалена"
        : `Опорные точки вне обрезки удалены (${removed})`
    );
  }
}

/** Кнопка "Применить" активна только когда черновик отличается от того, что
 *  уже применено — так видно, есть ли несохранённые изменения. */
function refreshTrimApplyState() {
  const dirty = state.trimStartDraft !== state.trimStart || state.trimEndDraft !== state.trimEnd;
  el.trimApplyButton.disabled = !dirty;
  el.trimApplyButton.classList.toggle("armed", dirty);
}

/** Полная пересинхронизация панели с текущим черновиком — слайдеры, подписи
 *  и текстовые поля времени. Не трогает применённую обрезку. */
function syncTrimDraftUI() {
  el.trimStartSlider.value = state.trimStartDraft;
  el.trimEndSlider.value = state.trimEndDraft;
  el.trimStartValue.textContent = trimTimeLabel(state.trimStartDraft);
  el.trimEndValue.textContent = trimTimeLabel(state.trimEndDraft);
  el.trimStartInput.value = trimTimeLabel(state.trimStartDraft);
  el.trimEndInput.value = trimTimeLabel(state.trimEndDraft);
  refreshTrimApplyState();
}

function updateTrimPanel() {
  if (!state.trackStats) {
    el.trimPanel.classList.add("hidden");
    return;
  }
  el.trimPanel.classList.remove("hidden");
  const maxIdx = state.trackStats.points.length - 1;
  el.trimStartSlider.min = 0;
  el.trimStartSlider.max = maxIdx;
  el.trimEndSlider.min = 0;
  el.trimEndSlider.max = maxIdx;
  syncTrimDraftUI();
}

el.trimStartSlider.addEventListener("input", () => {
  let v = Number(el.trimStartSlider.value);
  v = Math.min(v, state.trimEndDraft - 1 >= 0 ? state.trimEndDraft - 1 : 0);
  state.trimStartDraft = Math.max(0, v);
  syncTrimDraftUI();
});

el.trimEndSlider.addEventListener("input", () => {
  const maxIdx = state.trackStats.points.length - 1;
  let v = Number(el.trimEndSlider.value);
  v = Math.max(v, state.trimStartDraft + 1 <= maxIdx ? state.trimStartDraft + 1 : maxIdx);
  state.trimEndDraft = Math.min(maxIdx, v);
  syncTrimDraftUI();
});

/** Ручной ввод времени начала обрезки (черновик). Клон логики timeInput/
 *  cp-time-input: парсим по мере ввода, но само поле не перезаписываем,
 *  чтобы не сбивать то, что печатает пользователь. */
function setTrimStartDraftFromInput() {
  const idx = parseTimeStringToIndex(el.trimStartInput.value);
  if (idx === null) return;
  const maxAllowed = state.trimEndDraft - 1 >= 0 ? state.trimEndDraft - 1 : 0;
  state.trimStartDraft = Math.max(0, Math.min(idx, maxAllowed));
  el.trimStartSlider.value = state.trimStartDraft;
  el.trimStartValue.textContent = trimTimeLabel(state.trimStartDraft);
  refreshTrimApplyState();
}

function setTrimEndDraftFromInput() {
  const idx = parseTimeStringToIndex(el.trimEndInput.value);
  if (idx === null) return;
  const maxIdx = state.trackStats.points.length - 1;
  const minAllowed = state.trimStartDraft + 1 <= maxIdx ? state.trimStartDraft + 1 : maxIdx;
  state.trimEndDraft = Math.min(maxIdx, Math.max(idx, minAllowed));
  el.trimEndSlider.value = state.trimEndDraft;
  el.trimEndValue.textContent = trimTimeLabel(state.trimEndDraft);
  refreshTrimApplyState();
}

el.trimStartInput.addEventListener("input", setTrimStartDraftFromInput);
el.trimStartInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  setTrimStartDraftFromInput();
  el.trimStartInput.value = trimTimeLabel(state.trimStartDraft); // переформатировать начисто
  el.trimStartInput.blur();
});

el.trimEndInput.addEventListener("input", setTrimEndDraftFromInput);
el.trimEndInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  setTrimEndDraftFromInput();
  el.trimEndInput.value = trimTimeLabel(state.trimEndDraft);
  el.trimEndInput.blur();
});

el.trimApplyButton.addEventListener("click", () => {
  if (!state.trackStats) return;
  state.trimStart = state.trimStartDraft;
  state.trimEnd = state.trimEndDraft;
  pruneControlPointsOutsideTrim(); // точки вне диапазона пропадают именно здесь, не раньше
  updateStatsPanel();
  updateCalibPanel(); // все времена (слайдер, список опорных точек) теперь отсчитываются от нового trimStart
  updateTrimPanel(); // пересинхронизировать панель — подписи пересчитаются относительно нового начала
  render();
  showStatus("Обрезка применена");
});

el.trimResetButton.addEventListener("click", () => {
  if (!state.trackStats) return;
  const maxIdx = state.trackStats.points.length - 1;
  state.trimStart = 0;
  state.trimEnd = maxIdx;
  state.trimStartDraft = 0;
  state.trimEndDraft = maxIdx;
  updateStatsPanel();
  updateCalibPanel(); // сброс обрезки тоже сдвигает точку отсчёта времени обратно к 0
  updateTrimPanel();
  render();
});

// ---------- Сворачиваемые панели (общая логика для всех .collapsible) ----------

document.querySelectorAll(".collapsible > .panel-toggle").forEach((toggleBtn) => {
  toggleBtn.addEventListener("click", () => {
    const panel = toggleBtn.closest(".collapsible");
    const collapsed = panel.classList.toggle("collapsed");
    toggleBtn.setAttribute("aria-expanded", String(!collapsed));
  });
});

// ---------- Масштаб карты (зум + панорамирование прокруткой) ----------
//
// Реальный размер канваса = fitScale (подгонка под окно) * zoomLevel
// (управляется тут). Когда итоговый размер больше видимой области,
// .canvas-area (overflow: auto в CSS) сама показывает полосы прокрутки —
// отдельная логика панорамирования не нужна, прокрутка мышью/тачпадом/
// скроллбарами работает "из коробки" в обе стороны.

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function syncZoomUI() {
  el.zoomSlider.value = Math.round(state.zoomLevel * 100);
  el.zoomValue.textContent = `${Math.round(state.zoomLevel * 100)}%`;
}

function setZoom(z) {
  state.zoomLevel = clampZoom(z);
  applyCanvasSize();
  syncZoomUI();
  render();
}

el.zoomSlider.addEventListener("input", () => {
  setZoom(Number(el.zoomSlider.value) / 100);
});

el.zoomResetButton.addEventListener("click", () => {
  setZoom(1);
});

// Ctrl/Cmd + колесо мыши — зум по карте (как в большинстве картографических
// сервисов); обычная прокрутка колесом/тачпадом при этом не перехватывается
// и продолжает штатно прокручивать .canvas-area по вертикали/горизонтали.
el.canvas.addEventListener(
  "wheel",
  (e) => {
    if (!state.mapImage || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(state.zoomLevel * factor);
  },
  { passive: false }
);

// ---------- Текущая точка трека под курсором ----------
//
// Пока курсор над картой рядом с треком, синий индикатор "едет" по треку
// вслед за мышью (предпросмотр); обычный клик по карте (не в режиме
// добавления опорной точки) фиксирует эту точку как выбранную.

function findNearestTrackIndexByCanvasPoint(canvasPt) {
  const pts = state.trackStats.points;
  let bestIdx = null;
  let bestDist2 = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const proj = imgToCanvas(projectTrackPoint(i));
    const dx = proj.x - canvasPt.x;
    const dy = proj.y - canvasPt.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestIdx = i;
    }
  }
  const maxDist = Math.max(28, state.routeWidth * 3);
  if (bestIdx === null || bestDist2 > maxDist * maxDist) return null;
  return bestIdx;
}

let hoverRAFPending = false;

el.canvas.addEventListener("mousemove", (e) => {
  if (!state.model || !state.trackStats || state.armedForClick) return;
  if (hoverRAFPending) return;
  hoverRAFPending = true;
  requestAnimationFrame(() => {
    hoverRAFPending = false;
    const rect = el.canvas.getBoundingClientRect();
    const canvasPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const idx = findNearestTrackIndexByCanvasPoint(canvasPt);
    if (state.hoverTrackIndex !== idx) {
      state.hoverTrackIndex = idx;
      updateCanvasCursor();
      render();
    }
  });
});

el.canvas.addEventListener("mouseleave", () => {
  if (state.hoverTrackIndex !== null) {
    state.hoverTrackIndex = null;
    updateCanvasCursor();
    render();
  }
});

// ---------- Панорамирование карты зажатой мышью ----------
//
// Работает только там, где под курсором сейчас нет точки трека и мы не
// ждём клика для новой опорной точки — иначе то же самое нажатие уже занято
// (выбор точки трека / простановка опорной точки). Реализовано через
// обычный scroll .canvas-area — так это работает одинаково с зумом,
// колесом мыши и прокруткой сайдбара.

let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panDragged = false;
let suppressNextClick = false;

function updateCanvasCursor() {
  if (isPanning) {
    el.canvas.style.cursor = "grabbing";
  } else if (state.armedForClick || state.hoverTrackIndex !== null) {
    el.canvas.style.cursor = "crosshair";
  } else {
    el.canvas.style.cursor = "grab";
  }
}

el.canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || state.armedForClick || state.hoverTrackIndex !== null) return;
  isPanning = true;
  panDragged = false;
  panStartX = e.clientX;
  panStartY = e.clientY;
  updateCanvasCursor();
  e.preventDefault(); // не тащим картинку карты и не выделяем текст вокруг
});

window.addEventListener("mousemove", (e) => {
  if (!isPanning) return;
  if (Math.abs(e.clientX - panStartX) > 3 || Math.abs(e.clientY - panStartY) > 3) {
    panDragged = true;
  }
  el.canvasArea.scrollLeft -= e.movementX;
  el.canvasArea.scrollTop -= e.movementY;
});

window.addEventListener("mouseup", () => {
  if (!isPanning) return;
  isPanning = false;
  // Если это было настоящее перетаскивание — гасим следующий click по
  // канвасу, чтобы он не воспринялся как выбор точки трека (курсор мог
  // проехать над треком в процессе панорамирования).
  suppressNextClick = panDragged;
  updateCanvasCursor();
});

// ---------- UI обновление ----------

function updateStatsPanel() {
  if (!state.trackStats) {
    el.statsPanel.classList.add("hidden");
    return;
  }
  el.statsPanel.classList.remove("hidden");
  const range = computeRangeStats(state.trackStats.points, state.trimStart, state.trimEnd);
  el.statDistance.textContent = formatDistance(range.distM);
  el.statDuration.textContent = formatDuration(range.timeSec);
  el.statPace.textContent = formatPace(range.paceSecPerKm);
}

function updateCalibPanel() {
  if (!state.trackStats) {
    el.calibPanel.classList.add("hidden");
    return;
  }
  el.calibPanel.classList.remove("hidden");
  el.trackSlider.max = state.trackStats.points.length - 1;
  el.trackSlider.value = state.selectedTrackIndex;

  const hasTime = !!state.trackStats.points[0].time;
  el.timeInput.disabled = !hasTime;

  el.trackSliderLabel.textContent = sliderLabelText(state.selectedTrackIndex);
  el.timeInput.value = elapsedLabel(state.selectedTrackIndex) ?? "";
  renderControlPointList();

  el.undoButton.disabled = state.controlPoints.length === 0;
  el.clearCalibButton.disabled = state.controlPoints.length === 0;
}

function renderControlPointList() {
  const total = state.controlPoints.length;
  el.controlPointList.innerHTML = "";
  state.controlPoints.forEach((cp, i) => {
    const li = document.createElement("li");

    const numSpan = document.createElement("span");
    numSpan.className = "cp-num";
    numSpan.textContent = `${controlPointLabel(i, total)}.`;
    li.appendChild(numSpan);

    const timeInput = document.createElement("input");
    timeInput.type = "text";
    timeInput.className = "cp-time-input";
    timeInput.value = elapsedLabel(cp.trackIndex) ?? `#${cp.trackIndex}`;
    timeInput.disabled = !state.trackStats.points[0].time;
    const commit = () => retimeControlPoint(i, timeInput.value);
    timeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") timeInput.blur();
    });
    timeInput.addEventListener("blur", commit);
    li.appendChild(timeInput);

    const btn = document.createElement("button");
    btn.textContent = "✕";
    btn.title = "Удалить точку";
    btn.addEventListener("click", () => removeControlPoint(i));
    li.appendChild(btn);

    el.controlPointList.appendChild(li);
  });
}

// ---------- Экспорт ----------

el.exportButton.addEventListener("click", () => {
  if (!state.mapImage) {
    showStatus("Нечего экспортировать — загрузи карту и трек", true);
    return;
  }
  const link = document.createElement("a");
  link.download = "tracktomap.png";
  link.href = el.canvas.toDataURL("image/png");
  link.click();
});
