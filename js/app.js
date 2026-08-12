// app.js — состояние приложения, отрисовка на canvas, обработка UI.

const CONTROL_POINT_COLOR = "#facc15"; // жёлтый — хорошо читается почти на любом фоне карты
const CURRENT_POINT_COLOR = "#f2b8b5";
const MARKER_OUTLINE_COLOR = "#000000";
const MARKER_OUTLINE_WIDTH = 0.6; // очень тонкая, но заметная чёрная оконтовка
const DEFAULT_PACE_COLOR_STOPS = ["#0cdf59", "#f6fa00", "#fbad28", "#ff1414"]; // зелёный(12,223,89) → жёлтый(246,250,0) → оранжевый(251,173,40) → красный(255,20,20) — дефолт и цель кнопки "Сбросить цвета"

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
  history: [], // стек снимков controlPoints ДО каждого изменяющего действия — для "Отменить" (предыдущий шаг)
  future: [], // стек снимков, снятых через "Отменить" — для "Повторить" (следующий шаг)
  model: null, // buildSegmentedModel(controlPoints): { segments }
  armedForClick: false, // ждём клика по карте для новой опорной точки
  repositionArmedIndex: null, // индекс опорной точки, для которой ждём клика по карте, чтобы переставить её место
  selectedTrackIndex: 0,
  hoverTrackIndex: null, // точка трека под курсором мыши (предпросмотр перед фиксацией кликом)
  currentIndicatorVisible: true, // видимость маркера текущей точки на треке (см. drawCurrentIndicator); прячется сразу после фиксации опорной точки, пока пользователь не выберет новую точку
  pulseAnimation: null, // { index, startTime } — анимация-пульс при активации привязки двойным кликом
  paceColorStops: [...DEFAULT_PACE_COLOR_STOPS], // зелёный → жёлтый → оранжевый → красный, плавный 4-цветный градиент по умолчанию
  paceMinSecPerKm: null, // темп левой границы шкалы (самый быстрый/первый цвет) — авто при загрузке трека, дальше можно двигать вручную (ползунок/поле ввода)
  paceMaxSecPerKm: null, // темп правой границы шкалы (самый медленный/последний цвет)
  routeOpacity: 0.7,
  routeWidth: 4,
  trimStart: 0, // индекс точки трека — начало ПРИМЕНЁННОЙ обрезки (используется в render/статистике/точке отсчёта времени)
  trimEnd: 0, // индекс точки трека — конец ПРИМЕНЁННОЙ обрезки
  trimStartDraft: 0, // черновые значения слайдеров/полей модалки обрезки — не влияют ни на что, пока не нажата "Применить"
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
  editTrimButton: document.getElementById("editTrimButton"),
  calibPanel: document.getElementById("calibPanel"),
  timeInput: document.getElementById("timeInput"),
  trackSlider: document.getElementById("trackSlider"),
  trackSliderLabel: document.getElementById("trackSliderLabel"),
  armButton: document.getElementById("armButton"),
  controlPointList: document.getElementById("controlPointList"),
  exportButton: document.getElementById("exportButton"),
  undoButton: document.getElementById("undoButton"),
  redoButton: document.getElementById("redoButton"),
  clearCalibButton: document.getElementById("clearCalibButton"),
  statusMsg: document.getElementById("statusMsg"),
  legendPanel: document.getElementById("legendPanel"),
  legendGradient: document.getElementById("legendGradient"),
  colorStop0: document.getElementById("colorStop0"),
  colorStop1: document.getElementById("colorStop1"),
  colorStop2: document.getElementById("colorStop2"),
  colorStop3: document.getElementById("colorStop3"),
  resetColorsButton: document.getElementById("resetColorsButton"),
  paceMinSlider: document.getElementById("paceMinSlider"),
  paceMinValue: document.getElementById("paceMinValue"),
  paceMinInput: document.getElementById("paceMinInput"),
  paceMaxSlider: document.getElementById("paceMaxSlider"),
  paceMaxValue: document.getElementById("paceMaxValue"),
  paceMaxInput: document.getElementById("paceMaxInput"),
  opacitySlider: document.getElementById("opacitySlider"),
  opacityValue: document.getElementById("opacityValue"),
  widthSlider: document.getElementById("widthSlider"),
  widthValue: document.getElementById("widthValue"),
  zoomPanel: document.getElementById("zoomPanel"),
  zoomSlider: document.getElementById("zoomSlider"),
  zoomValue: document.getElementById("zoomValue"),
  zoomResetButton: document.getElementById("zoomResetButton"),
  trimModal: document.getElementById("trimModal"),
  trimModalStartSlider: document.getElementById("trimModalStartSlider"),
  trimModalStartValue: document.getElementById("trimModalStartValue"),
  trimModalStartInput: document.getElementById("trimModalStartInput"),
  trimModalEndSlider: document.getElementById("trimModalEndSlider"),
  trimModalEndValue: document.getElementById("trimModalEndValue"),
  trimModalEndInput: document.getElementById("trimModalEndInput"),
  trimModalApplyButton: document.getElementById("trimModalApplyButton"),
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
    updateLegendPanelVisibility();
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
    resetControlPointHistory();
    state.model = null;
    state.selectedTrackIndex = 0;
    state.currentIndicatorVisible = true;
    state.trimStart = 0;
    state.trimEnd = points.length - 1;
    setupPaceSliders(); // границы шкалы темпа по умолчанию — авто по данным трека, дальше можно двигать вручную
    updateStatsPanel();
    updateCalibPanel();
    updateLegendPanelVisibility();
    render();
    showStatus(`Трек загружен: ${file.name} (${points.length} точек)`);
    openTrimModal(); // сразу спрашиваем про обрезку, пока пользователь ещё держит контекст загрузки в голове
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

/** includeMarkers=false рисует только карту и трек, без опорных точек,
 *  текущей точки и пульса привязки — используется при экспорте в PNG,
 *  чтобы служебные маркеры калибровки не попадали в сохранённую картинку. */
function render({ includeMarkers = true } = {}) {
  if (!state.mapImage) return;

  // Очистка должна пройти по всему backing store, а не по CSS-размеру,
  // поэтому временно сбрасываем трансформацию.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  ctx.restore();

  ctx.drawImage(state.mapImage, 0, 0, state.displayW, state.displayH);
  drawRoute();
  if (includeMarkers) {
    drawControlPoints();
    drawCurrentIndicator();
    drawArmPulse();
  }
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

/** Лёгкое сглаживание "дрожания" сырых GPS-точек — взвешенное скользящее
 *  среднее по 3 соседним точкам, уже в canvas-координатах. Не трогает ни
 *  данные трека, ни точки привязки/статистику — влияет ТОЛЬКО на то, как
 *  рисуется линия маршрута. Первая и последняя точка не сдвигаются —
 *  иначе трек визуально "отрывался" бы от индикатора текущей точки/опорных
 *  точек на своих концах. */
function smoothPolylinePass(pts) {
  if (pts.length < 3) return pts.slice();
  const out = new Array(pts.length);
  out[0] = pts[0];
  out[pts.length - 1] = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    out[i] = {
      x: pts[i - 1].x * 0.25 + pts[i].x * 0.5 + pts[i + 1].x * 0.25,
      y: pts[i - 1].y * 0.25 + pts[i].y * 0.5 + pts[i + 1].y * 0.25,
    };
  }
  return out;
}

const ROUTE_SMOOTH_PASSES = 2; // повторов сглаживания — больше = меньше "дрожи", но сильнее срезает резкие повороты

// Раньше линия трека рисовалась вручную полигонами: для каждого сегмента
// считалась нормаль к направлению движения, а на стыках соседних сегментов
// нормали двух рёбер усреднялись, чтобы получить "митр"-смещение вершины.
// На резком развороте (частый случай в ориентировании — КП с "крюком")
// направление между соседними точками почти разворачивается на 180°, и
// такое усреднение вырождалось: вместо ровного стыка поперёк линии
// получался перекошенный клин — та самая диагональная полоса чужого цвета
// поперёк трека на разворотах.
//
// Раскраска по кускам (один stroke() на кусок с одним цветом, вариант,
// испробованный до этого) тоже не подошла: даже со скруглёнными углами
// внутри куска, ГРАНИЦЫ между кусками — это концы отдельных stroke()-вызовов
// со своим капом. round-cap давал растущий с толщиной линии кружок на
// каждой границе цвета ("бусины"), а butt-cap — "ёлочку": соседние сегменты
// после сглаживания всё равно чуть отличаются по направлению (GPS не
// идеально прямой), и плоский срез под этим небольшим углом не совпадает
// с соседним куском, давая зубчатый шов вдоль всей линии.
//
// Решение — не пытаться подогнать форму КАЖДОГО куска руками, а развести
// геометрию и раскраску на два прохода:
//   1) форма — ОДИН сплошной stroke() через ВСЕ точки трека целиком (без
//      единого разрыва), с lineJoin="round" — стыки на любом угле, включая
//      развороты, считает браузер, вырождения нормали нет вообще, т.к.
//      нормаль нигде не считается вручную;
//   2) раскраска — рисуется ПОВЕРХ этой формы с
//      ctx.globalCompositeOperation = "source-atop": в этом режиме новая
//      отрисовка проявляется только там, где на канвасе уже есть
//      непрозрачные пиксели (то есть точно внутри контура формы из шага 1),
//      и обрезается точно по этому контуру. Значит, каждый цветной сегмент
//      можно красить отдельным stroke() с обычными круглыми капами — любые
//      "вылезающие" за пределы истинной формы кусочки (те самые бусины и
//      зубцы) автоматически обрезаются, и артефакт физически не может
//      появиться независимо от толщины линии.
function drawRoute() {
  if (!state.model || !state.trackStats) return;
  const { points } = state.trackStats;
  const projected = points.map((p, i) => imgToCanvas(projectTrackPoint(i)));

  // Трек рисуется на отдельном канвасе с ПОЛНОЙ непрозрачностью, а затем
  // весь результат одним изображением накладывается на карту с нужной
  // прозрачностью (см. ctx.globalAlpha ниже) — иначе полупрозрачные слои
  // раскраски накладывались бы друг на друга и на подложку многократно.
  routeBuffer.width = el.canvas.width;
  routeBuffer.height = el.canvas.height;
  const dpr = window.devicePixelRatio || 1;
  routeBufferCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Толщина линии задаётся в "метрах карты" (пикселях при zoomLevel=1) и
  // масштабируется вместе с зумом — иначе при уменьшении масштаба карты
  // линия остаётся того же экранного размера, а сама карта становится
  // меньше, и трек визуально "толстеет" относительно неё.
  const scaledRouteWidth = state.routeWidth * state.zoomLevel;

  const from = Math.max(1, state.trimStart + 1);
  const to = Math.min(projected.length - 1, state.trimEnd);
  if (to < from) return;

  let smoothed = projected;
  for (let pass = 0; pass < ROUTE_SMOOTH_PASSES; pass++) smoothed = smoothPolylinePass(smoothed);

  // ---- Шаг 1: форма — один сплошной путь через все точки диапазона ----
  routeBufferCtx.lineWidth = scaledRouteWidth;
  routeBufferCtx.lineJoin = "round";
  routeBufferCtx.lineCap = "round"; // скруглённые самые первый/последний концы всего трека — единственные настоящие "концы" во всей отрисовке
  routeBufferCtx.strokeStyle = "#000"; // цвет неважен — этот проход задаёт только форму (альфа-маску) для шага 2
  routeBufferCtx.beginPath();
  routeBufferCtx.moveTo(smoothed[from - 1].x, smoothed[from - 1].y);
  for (let i = from; i <= to; i++) routeBufferCtx.lineTo(smoothed[i].x, smoothed[i].y);
  routeBufferCtx.stroke();

  // ---- Шаг 2: раскраска поверх формы, обрезанная по её контуру ----
  // Раскраска — по СГЛАЖЕННОМУ темпу (state.trackStats.smoothedPace), а не
  // по сырому points[i].segPaceSecPerKm: точка-к-точке темп слишком шумный
  // из-за погрешности GPS.
  routeBufferCtx.save();
  routeBufferCtx.globalCompositeOperation = "source-atop";
  routeBufferCtx.lineJoin = "round";
  routeBufferCtx.lineCap = "round";
  for (let i = from; i <= to; i++) {
    const color = paceToColor(
      state.trackStats.smoothedPace[i],
      state.paceMinSecPerKm,
      state.paceMaxSecPerKm,
      state.paceColorStops
    );
    routeBufferCtx.strokeStyle = color;
    routeBufferCtx.beginPath();
    routeBufferCtx.moveTo(smoothed[i - 1].x, smoothed[i - 1].y);
    routeBufferCtx.lineTo(smoothed[i].x, smoothed[i].y);
    routeBufferCtx.stroke();
  }
  routeBufferCtx.restore(); // возвращает globalCompositeOperation к обычному "source-over"

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
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = MARKER_OUTLINE_WIDTH * 4.5;
    ctx.strokeStyle = MARKER_OUTLINE_COLOR;
    ctx.strokeText(label, pt.x, pt.y - 16);
    ctx.fillStyle = CONTROL_POINT_COLOR;
    ctx.fillText(label, pt.x, pt.y - 16);
  });
}

/** Точка трека, отслеживаемая указателем мыши/зафиксированная кликом —
 *  видна прямо на карте. Пока курсор над треком — индикатор следует за
 *  ним (hoverTrackIndex); клик фиксирует эту точку как selectedTrackIndex.
 *  currentIndicatorVisible=false прячет маркер selectedTrackIndex (но не
 *  живой предпросмотр под курсором) — используется сразу после добавления
 *  опорной точки, чтобы старая "текущая точка" не оставалась висеть на
 *  треке поверх/рядом со свежедобавленной опорной точкой. */
function drawCurrentIndicator() {
  if (!state.model || !state.trackStats) return;
  if (state.hoverTrackIndex === null && !state.currentIndicatorVisible) return;
  const idx = state.hoverTrackIndex !== null ? state.hoverTrackIndex : state.selectedTrackIndex;
  const pt = imgToCanvas(projectTrackPoint(idx));

  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(242, 184, 181, 0.22)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = CURRENT_POINT_COLOR;
  ctx.fill();
  // Тонкая чёрная обводка вокруг самой точки — без неё светлый оттенок
  // теряется на светлых участках карты.
  ctx.lineWidth = MARKER_OUTLINE_WIDTH * 1.25;
  ctx.strokeStyle = MARKER_OUTLINE_COLOR;
  ctx.stroke();

  const label = elapsedLabel(idx) ?? `№${idx}`;
  ctx.font = "bold 16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Обводка подписи заметно толще, чем у опорных точек — иначе цифры на
  // светлом фоне карты сливаются со светлым цветом текущей точки.
  ctx.lineWidth = MARKER_OUTLINE_WIDTH * 4.5;
  ctx.strokeStyle = MARKER_OUTLINE_COLOR;
  ctx.strokeText(label, pt.x, pt.y - 16);
  ctx.fillStyle = CURRENT_POINT_COLOR;
  ctx.fillText(label, pt.x, pt.y - 16);
}

const ARM_PULSE_COLOR = CURRENT_POINT_COLOR; // красный — тот же, что у индикатора текущей точки
const ARM_PULSE_DURATION_MS = 900;
const ARM_PULSE_RING_DELAYS = [0, 160]; // мс — вторая волна догоняет первую, эффект "ряби"

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Короткая анимация-пульс на точке трека, которую только что "привязали"
 *  двойным кликом (см. обработчик dblclick ниже) — подтверждает, какая
 *  именно точка включила режим добавления опорной точки. Две красных волны
 *  с небольшим сдвигом по времени ("рябь") расходятся с ease-out
 *  затуханием, а в центре на миг вспыхивает мягкое свечение — вместо
 *  прежнего одного линейно затухающего жёлтого кольца.
 */
function drawArmPulse() {
  if (!state.pulseAnimation || !state.model || !state.trackStats) return;
  const { index, startTime } = state.pulseAnimation;
  const elapsed = performance.now() - startTime;
  if (elapsed > ARM_PULSE_DURATION_MS) return;
  const pt = imgToCanvas(projectTrackPoint(index));
  const rgb = hexToRgb(ARM_PULSE_COLOR);

  ARM_PULSE_RING_DELAYS.forEach((delay) => {
    const span = ARM_PULSE_DURATION_MS - delay;
    const t = (elapsed - delay) / span;
    if (t < 0 || t > 1) return;
    const eased = easeOutCubic(t);
    const radius = 7 + eased * 30;
    const alpha = (1 - eased) * 0.85;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
    ctx.lineWidth = 2.5 * (1 - eased * 0.6); // кольцо слегка утончается по мере расширения
    ctx.stroke();
  });

  // Мягкая вспышка в центре, гаснущая быстрее колец — подчёркивает момент
  // активации, а не просто дублирует расширяющиеся кольца.
  const glowT = Math.min(1, elapsed / (ARM_PULSE_DURATION_MS * 0.4));
  const glowAlpha = (1 - easeOutCubic(glowT)) * 0.4;
  if (glowAlpha > 0.01) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${glowAlpha})`;
    ctx.fill();
  }
}

/** Запускает пульс и перерисовывает канвас на каждом кадре, пока анимация
 *  не закончится. */
function startArmPulse(index) {
  state.pulseAnimation = { index, startTime: performance.now() };
  const step = () => {
    if (!state.pulseAnimation || state.pulseAnimation.index !== index) return;
    const elapsed = performance.now() - state.pulseAnimation.startTime;
    if (elapsed > ARM_PULSE_DURATION_MS) {
      state.pulseAnimation = null;
      render();
      return;
    }
    render();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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
  let bestIdx = state.trimStart;
  let bestDiff = Infinity;
  for (let i = state.trimStart; i <= state.trimEnd; i++) {
    if (!pts[i].time || !origin.time) continue;
    const diff = Math.abs((pts[i].time - origin.time) / 1000 - targetSec);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Парсит строку времени ("м:сс" или "ч:мм:сс") в индекс точки трека,
 *  используя переданную функцию поиска ближайшей точки по секундам.
 *  resolveIndex получает и отрицательные значения (см. вызовы ниже) —
 *  разные контексты (привязка / обрезка) считают время от разных точек
 *  отсчёта, поэтому сама функция сюда не зашита. */
function parseTimeStringWith(raw, resolveIndex) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const neg = trimmed.startsWith("-");
  const body = neg ? trimmed.slice(1) : trimmed;
  if (!body || body.startsWith(":") || body.endsWith(":") || body.includes("::")) return null;
  const parts = body.split(":").map((s) => parseInt(s, 10));
  if (!parts.length || parts.length > 3 || parts.some((n) => Number.isNaN(n))) return null;
  // Минуты и секунды (все части, кроме самой первой) должны быть 0-59 —
  // иначе "3:75" молча превращалось бы в странное время вместо ошибки.
  if (parts.slice(1).some((n) => n < 0 || n > 59)) return null;
  if (parts[0] < 0) return null;

  let sec;
  if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else sec = parts[0];
  return resolveIndex(neg ? -sec : sec);
}

/** Время для полей привязки (слайдер точки трека, список опорных точек) —
 *  всегда отсчитывается от ПРИМЕНЁННОГО trimStart и ищется только внутри
 *  применённой обрезки (точки за её пределами всё равно не используются). */
function parseTimeStringToIndex(raw) {
  const sec = maskedInputToSeconds(raw, calibMaxAbsSeconds());
  return sec === null ? null : findNearestIndexByElapsed(sec);
}

/** Наибольшая по модулю длительность, которую могут показывать поля
 *  привязки — длительность уже применённой обрезки. Используется маской
 *  ввода, чтобы понять, сколько цифр нужно под "минуты" до автопереноса
 *  курсора за двоеточие. */
function calibMaxAbsSeconds() {
  if (!state.trackStats) return 0;
  const range = computeRangeStats(state.trackStats.points, state.trimStart, state.trimEnd);
  return range.timeSec || 0;
}

// ---------- Маска ввода времени (мм:сс / ч:мм:сс) ----------
//
// Раньше здесь была только защита от стирания ":" при одиночном Backspace —
// но при выделении ВСЕГО содержимого поля и удалении/перезаписи это
// выделение включало и сам разделитель, и защита не срабатывала. Вместо
// точечных патчей — обычная маска фиксированной ширины (как в полях даты):
// пользователь всегда редактирует только ЦИФРЫ, разделитель ":" рисуется
// автоматически по мере заполнения сегментов и никогда не является частью
// того, что можно ввести/стереть напрямую. Ширина сегмента "минуты" (или
// "часы", если трек длиннее часа) подбирается под длительность конкретного
// трека — например, при 12:11 это 2 цифры, и после них курсор сам
// перескакивает за ":" на секунды.

/** [ширина_первого_сегмента, 2, (2)] — например [2,2] для "мм:сс" или
 *  [1,2,2] для "ч:мм:сс", в зависимости от того, сколько цифр нужно, чтобы
 *  выразить максимальную длительность этого поля. */
function timeMaskSegments(maxAbsSec) {
  const total = Math.max(0, Math.floor(maxAbsSec || 0));
  const h = Math.floor(total / 3600);
  if (h > 0) return [String(h).length, 2, 2];
  const m = Math.floor(total / 60);
  return [Math.max(1, String(m).length), 2];
}

/** Переводит "голые" цифры маски (без ":") в секунды по тем же сегментам,
 *  что и formatTimeDigits: первый сегмент — минуты (или часы, если сегментов
 *  три), последний — всегда секунды. Недописанный ПОСЛЕДНИЙ сегмент читается
 *  как обычное число ("1" в сегменте секунд — это 1 секунда, не 10) — но, в
 *  отличие от разбора уже готовой строки по количеству введённых ":", здесь
 *  недописанный ПЕРВЫЙ сегмент (минуты/часы) не путается с секундами: "11"
 *  при ширине сегмента минут 2 — это 11 МИНУТ (ещё не дописанные секунды),
 *  а не 11 секунд. Раньше именно эта путаница приводила к тому, что "11"
 *  показывались как 11 секунд, а следующая цифра резко превращала это в
 *  "11:01" вместо ожидаемого продолжения ввода минут. */
function maskDigitsToSeconds(digits, segments) {
  let idx = 0;
  const values = segments.map((len) => {
    const chunk = digits.slice(idx, idx + len);
    idx += len;
    return chunk === "" ? 0 : parseInt(chunk, 10);
  });
  if (values.length === 3) return values[0] * 3600 + values[1] * 60 + values[2];
  if (values.length === 2) return values[0] * 60 + values[1];
  return values[0];
}

/** rawValue — текущее содержимое замаскированного поля времени (с ":" или
 *  ещё без него — не имеет значения). maxAbsSec — та же длительность, что
 *  передаётся маске этого поля (см. attachTimeInputMask), нужна, чтобы знать
 *  ширину сегмента минут/часов. null, если цифр в поле вообще нет. */
/** true, если пользователь вручную поставил ":" (см. attachTimeInputMask) —
 *  в этом случае поле больше не подчиняется фиксированной ширине сегментов,
 *  а разбирается напрямую как "минуты:секунды" по месту, которое выбрал
 *  сам пользователь. */
function hasManualColon(value) {
  return /^[0-9]+:[0-9]*$/.test(value || "");
}

function maskedInputToSeconds(rawValue, maxAbsSec) {
  const value = rawValue || "";
  if (hasManualColon(value)) {
    const [minPart, secPart] = value.split(":");
    const min = parseInt(minPart, 10) || 0;
    const sec = secPart === "" ? 0 : parseInt(secPart, 10) || 0;
    return min * 60 + sec;
  }
  const digits = value.replace(/[^0-9]/g, "");
  if (!digits) return null;
  return maskDigitsToSeconds(digits, timeMaskSegments(maxAbsSec));
}

/** Собирает отформатированную строку "12:11" из чистых цифр по сегментам.
 *  Останавливается, как только очередной сегмент не полностью заполнен —
 *  значит, дальше по треку пользователь ещё не допечатал, и рисовать
 *  следующее ":" рано. */
function formatTimeDigits(digits, segments) {
  let out = "";
  let idx = 0;
  for (let si = 0; si < segments.length; si++) {
    const len = segments[si];
    const chunk = digits.slice(idx, idx + len);
    if (!chunk) break;
    if (si > 0) out += ":";
    out += chunk;
    idx += len;
    if (chunk.length < len) break;
  }
  return out;
}

/** Сколько цифр (без учёта ":") находится в строке до позиции курсора. */
function digitIndexAtCaret(value, pos) {
  let count = 0;
  for (let i = 0; i < pos && i < value.length; i++) {
    if (/[0-9]/.test(value[i])) count++;
  }
  return count;
}

/** true, если строка времени состоит только из нулей ("0:00", "0:00:00" и
 *  т.п., в том числе недописанные вроде "00"). */
function isAllZeroTimeValue(value) {
  const digits = (value || "").replace(/[^0-9]/g, "");
  return digits.length > 0 && /^0+$/.test(digits);
}

/** То, что реально должно попасть в input.value для отформатированной метки
 *  времени: если метка нулевая ("0:00"), поле остаётся ПУСТЫМ, и вместо неё
 *  виден нативный placeholder (нули "на заднем фоне" поля — см. style.css).
 *  Само нулевое значение при этом никуда не девается: оно продолжает жить в
 *  состоянии (trimStart/trimEnd/selectedTrackIndex и т.п.) и учитывается как
 *  обычно при "Применить"/фиксации — меняется только то, что показывается
 *  пользователю. */
function timeInputDisplayValue(label) {
  if (label === null || label === undefined) return "";
  return isAllZeroTimeValue(label) ? "" : label;
}

/** Плейсхолдер-текст для замаскированного поля времени, подобранный под
 *  текущую ширину сегментов (например "0:00" или "0:00:00") — чтобы нули
 *  на фоне визуально совпадали по формату с реальным вводом. */
function zeroTimeMaskLabel(maxAbsSec) {
  const segs = timeMaskSegments(maxAbsSec);
  return segs.map((len, i) => (i === 0 ? "0" : "0".repeat(len))).join(":");
}

/** Вешает на текстовое поле маску времени: редактируются только цифры,
 *  ":" всегда генерируется автоматически и никогда не может быть стёрт или
 *  перезаписан напрямую — при заполнении сегмента курсор сам переходит
 *  за разделитель. getMaxAbsSeconds — функция без аргументов, возвращающая
 *  актуальную длительность (для конкретного поля она может меняться, если
 *  трек/обрезка ещё не загружены на момент вызова attachTimeInputMask). */
function attachTimeInputMask(inputEl, getMaxAbsSeconds) {
  function segments() {
    return timeMaskSegments(getMaxAbsSeconds ? getMaxAbsSeconds() : 3599);
  }
  function digitsOf(value) {
    return value.replace(/[^0-9]/g, "");
  }
  function caretForDigitCount(digits, segs, count) {
    return formatTimeDigits(digits.slice(0, count), segs).length;
  }
  function apply(digits, caretDigitCount) {
    const segs = segments();
    const cap = segs.reduce((a, b) => a + b, 0);
    digits = digits.slice(0, cap);
    caretDigitCount = Math.min(caretDigitCount, digits.length);
    inputEl.value = formatTimeDigits(digits, segs);
    const pos = caretForDigitCount(digits, segs, caretDigitCount);
    inputEl.setSelectionRange(pos, pos);
    // Программное присвоение .value не порождает событие "input" само по
    // себе — а на него завязаны остальные обработчики (автопереход к точке
    // трека и т.п.), поэтому рассылаем его вручную.
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  inputEl.addEventListener("beforeinput", (e) => {
    const value = inputEl.value;
    const selStart = inputEl.selectionStart;
    const selEnd = inputEl.selectionEnd;

    // Ручной ввод ":" — пользователь сам решает, где поставить разделитель,
    // вместо того чтобы ждать автоматическую расстановку по фиксированной
    // ширине сегмента. Разрешено только если: перед курсором уже есть хотя
    // бы одна цифра (":" не может стоять первым символом), и в поле ещё нет
    // другого ":" (двоеточие может быть только одно, как и раньше).
    const pastedText = e.dataTransfer && e.dataTransfer.getData("text");
    const isColonKey =
      (e.inputType === "insertText" && e.data === ":") ||
      (e.inputType === "insertFromPaste" && pastedText === ":");
    if (isColonKey) {
      e.preventDefault();
      if (value.includes(":")) return; // уже есть — второе не ставим
      if (digitIndexAtCaret(value, selStart) === 0) return; // должно стоять после цифр
      const newValue = value.slice(0, selStart) + ":" + value.slice(selEnd);
      inputEl.value = newValue;
      inputEl.setSelectionRange(selStart + 1, selStart + 1);
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // Двоеточие уже стоит там, где его поставил пользователь — дальше просто
    // редактируем цифры по обе стороны от него напрямую в строке, не трогая
    // его позицию и не переформатируя по фиксированным сегментам.
    if (hasManualColon(value)) {
      if (
        e.inputType === "insertText" ||
        e.inputType === "insertFromPaste" ||
        e.inputType === "insertFromDrop" ||
        e.inputType === "insertCompositionText"
      ) {
        e.preventDefault();
        const raw = e.data != null ? e.data : pastedText || "";
        const insertDigits = raw.replace(/[^0-9]/g, "");
        if (!insertDigits) return;
        let newValue = value.slice(0, selStart) + insertDigits + value.slice(selEnd);
        let pos = selStart + insertDigits.length;
        // После ":" — не больше двух цифр (секунды 0-59): лишние обрезаем,
        // а не просто запрещаем весь ввод, чтобы вставка длинной строки
        // тоже корректно укорачивалась, а не отклонялась целиком.
        const colonIdx = newValue.indexOf(":");
        if (colonIdx !== -1) {
          const minPart = newValue.slice(0, colonIdx);
          const secPart = newValue.slice(colonIdx + 1);
          if (secPart.length > 2) {
            newValue = minPart + ":" + secPart.slice(0, 2);
            pos = Math.min(pos, newValue.length);
          }
        }
        inputEl.value = newValue;
        inputEl.setSelectionRange(pos, pos);
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      if (e.inputType === "deleteContentBackward" || e.inputType === "deleteContentForward") {
        e.preventDefault();
        let newValue, pos;
        if (selStart !== selEnd) {
          newValue = value.slice(0, selStart) + value.slice(selEnd);
          pos = selStart;
        } else if (e.inputType === "deleteContentBackward" && selStart > 0) {
          newValue = value.slice(0, selStart - 1) + value.slice(selStart);
          pos = selStart - 1;
        } else if (e.inputType === "deleteContentForward" && selStart < value.length) {
          newValue = value.slice(0, selStart) + value.slice(selStart + 1);
          pos = selStart;
        } else {
          return;
        }
        inputEl.value = newValue;
        inputEl.setSelectionRange(pos, pos);
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      return;
    }

    // Обычный автоматический режим (двоеточия ещё нет) — как раньше:
    // редактируем только цифры, разделитель расставляется сам по фиксированной
    // ширине сегментов.
    const segs = segments();
    const cap = segs.reduce((a, b) => a + b, 0);
    const digits = digitsOf(value);
    const startDigitIdx = digitIndexAtCaret(value, selStart);
    const endDigitIdx = digitIndexAtCaret(value, selEnd);

    if (
      e.inputType === "insertText" ||
      e.inputType === "insertFromPaste" ||
      e.inputType === "insertFromDrop" ||
      e.inputType === "insertCompositionText"
    ) {
      e.preventDefault();
      const raw = e.data != null ? e.data : pastedText || "";
      const insertDigits = raw.replace(/[^0-9]/g, "");
      if (!insertDigits) return;
      const before = digits.slice(0, startDigitIdx);
      const after = digits.slice(endDigitIdx);
      const merged = (before + insertDigits + after).slice(0, cap);
      apply(merged, Math.min(before.length + insertDigits.length, cap));
      return;
    }

    if (e.inputType === "deleteContentBackward") {
      e.preventDefault();
      if (selStart !== selEnd) {
        apply(digits.slice(0, startDigitIdx) + digits.slice(endDigitIdx), startDigitIdx);
      } else if (startDigitIdx > 0) {
        apply(digits.slice(0, startDigitIdx - 1) + digits.slice(startDigitIdx), startDigitIdx - 1);
      }
      return;
    }

    if (e.inputType === "deleteContentForward") {
      e.preventDefault();
      if (selStart !== selEnd) {
        apply(digits.slice(0, startDigitIdx) + digits.slice(endDigitIdx), startDigitIdx);
      } else if (startDigitIdx < digits.length) {
        apply(digits.slice(0, startDigitIdx) + digits.slice(startDigitIdx + 1), startDigitIdx);
      }
      return;
    }
    // Прочие inputType (например, недоступный e.data при вставке через
    // системное меню на некоторых мобильных клавиатурах) подчищает
    // fallback ниже, по итоговому value.
  });

  // Fallback на случай, если beforeinput недоступен/не даёт нужных данных —
  // просто пересобираем маску из того, что реально оказалось в поле. Ручное
  // двоеточие (hasManualColon) не трогаем — оно стоит там, где его поставил
  // пользователь, а не по фиксированной ширине сегмента.
  inputEl.addEventListener("input", () => {
    if (hasManualColon(inputEl.value)) return;
    const segs = segments();
    const cap = segs.reduce((a, b) => a + b, 0);
    const digits = digitsOf(inputEl.value).slice(0, cap);
    const expected = formatTimeDigits(digits, segs);
    if (expected !== inputEl.value) {
      inputEl.value = expected;
      const pos = expected.length;
      inputEl.setSelectionRange(pos, pos);
    }
  });

  // Выделяем всё содержимое при получении фокуса — тогда первая же введённая
  // цифра сразу заменяет дефолтные нули, стирать их вручную не нужно.
  // mouseup от того же клика, которым поле получило фокус, иначе браузер
  // сам снимает это выделение и ставит курсор в точку клика; последующие
  // клики внутри уже сфокусированного поля работают как обычно.
  let justFocused = false;
  inputEl.addEventListener("focus", () => {
    justFocused = true;
    inputEl.select();
  });
  inputEl.addEventListener("mouseup", (e) => {
    if (justFocused) {
      e.preventDefault();
      justFocused = false;
    }
  });
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
  state.currentIndicatorVisible = true; // пользователь снова явно выбрал точку — маркер должен быть виден
  el.trackSlider.value = idx;
  el.trackSliderLabel.textContent = sliderLabelText(idx);
  if (syncInput) {
    el.timeInput.value = timeInputDisplayValue(elapsedLabel(idx));
  }
  render();
}

el.trackSlider.addEventListener("input", () => {
  selectTrackIndex(Number(el.trackSlider.value));
});

attachTimeInputMask(el.timeInput, calibMaxAbsSeconds);

// Автопереход при вводе времени вручную — без отдельной кнопки. Ошибки
// формата тут молча игнорируются (пользователь мог не дописать число).
el.timeInput.addEventListener("input", () => {
  const idx = parseTimeStringToIndex(el.timeInput.value);
  if (idx !== null) selectTrackIndex(idx, { syncInput: false });
});

function commitTimeInput() {
  if (el.timeInput.value.trim() === "") {
    // Пустое поле — это плейсхолдер уже действующего (нулевого) значения,
    // а не ошибка: просто возвращаем поле к текущему выбору как есть.
    selectTrackIndex(state.selectedTrackIndex);
    return true;
  }
  const idx = parseTimeStringToIndex(el.timeInput.value);
  if (idx === null) {
    showStatus("Неверный формат, используй ММ:СС или Ч:ММ:СС", true);
    return false;
  }
  selectTrackIndex(idx); // переформатирует поле начисто
  return true;
}

// Enter в поле времени — это не только выбор точки трека, но и сразу же
// запуск добавления опорной точки (эквивалент клика по "Добавить опорную
// точку"): типичный сценарий — вписал время, нажал Enter, кликнул по карте.
el.timeInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (commitTimeInput()) el.armButton.click();
});

// ---------- История опорных точек (отменить/повторить) ----------
//
// Раньше "Отменить" делал state.controlPoints.pop() — но массив всегда
// отсортирован по trackIndex (см. sortControlPoints), поэтому pop()
// удалял точку с наибольшим trackIndex, а не ту, что пользователь
// действительно поставил последней по времени действия. Например: точки
// поставлены в порядке 5:00, 1:00, 3:00 — pop() удалял бы 5:00 (последнюю
// в отсортированном массиве), хотя последним действием пользователя было
// добавление 3:00.
//
// Вместо точечного трекинга "какая точка была последней" — обычный стек
// снимков ВСЕГО массива controlPoints, как в любом редакторе с Ctrl+Z/
// Ctrl+Y: перед каждым изменяющим действием (добавление, удаление,
// перестановка на карте, ретайм, очистка) кладём в history снимок
// состояния ДО изменения. "Отменить"/"Повторить" — это просто шаг назад/
// вперёд по этому стеку, и он всегда соответствует РЕАЛЬНОЙ хронологии
// действий, а не порядку сортировки.

function snapshotControlPoints() {
  return state.controlPoints.map((cp) => ({
    trackIndex: cp.trackIndex,
    source: { ...cp.source },
    target: { ...cp.target },
  }));
}

/** Вызывать ПЕРЕД любым изменением state.controlPoints — сохраняет снимок
 *  ещё не изменённого состояния. Новое действие всегда обнуляет "future":
 *  как только пользователь пошёл по новой ветке изменений, старое
 *  "повторить" перестаёт быть валидным (как в любом обычном undo/redo). */
function pushControlPointHistory() {
  state.history.push(snapshotControlPoints());
  state.future = [];
}

/** Полный сброс истории — при загрузке нового трека и после применения
 *  обрезки (обрезка может сделать старые снимки не соответствующими новому
 *  допустимому диапазону индексов, поэтому не пытаемся их сохранить). */
function resetControlPointHistory() {
  state.history = [];
  state.future = [];
}

function undoControlPoints() {
  if (state.history.length === 0) return;
  state.future.push(snapshotControlPoints());
  state.controlPoints = state.history.pop();
  state.repositionArmedIndex = null;
  recomputeModel();
  updateCalibPanel();
  render();
}

function redoControlPoints() {
  if (state.future.length === 0) return;
  state.history.push(snapshotControlPoints());
  state.controlPoints = state.future.pop();
  state.repositionArmedIndex = null;
  recomputeModel();
  updateCalibPanel();
  render();
}

/** Есть ли уже опорная точка на этой точке трека (excludeIndex — позиция в
 *  controlPoints, которую нужно игнорировать при проверке, например саму
 *  перемещаемую точку при ретайме). Двух опорных точек с одинаковым временем
 *  быть не должно — для segmented-модели это означает нулевую длину сегмента
 *  между ними, что ломает подобие (деление на ноль/вырожденное преобразование). */
function hasControlPointAtTrackIndex(trackIndex, excludeIndex = -1) {
  return state.controlPoints.some((cp, i) => i !== excludeIndex && cp.trackIndex === trackIndex);
}

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
  if (hasControlPointAtTrackIndex(state.selectedTrackIndex)) {
    showStatus("На этой точке трека уже есть опорная точка — выбери другое время", true);
    return;
  }
  // Одновременно может быть только один режим ожидания клика по карте —
  // если была активна перестановка существующей точки, снимаем её.
  if (state.repositionArmedIndex !== null) {
    state.repositionArmedIndex = null;
    renderControlPointList();
  }
  state.armedForClick = true;
  el.armButton.textContent = "Отмена";
  el.armButton.classList.add("armed");
  updateCanvasCursor();
});

/** Переключает режим "жду клика по карте, чтобы переставить существующую
 *  опорную точку №i" — сама точка (время/trackIndex) не меняется, меняется
 *  только место на карте (target). */
function toggleRepositionArm(i) {
  if (!state.mapImage) {
    showStatus("Сначала загрузи изображение карты", true);
    return;
  }
  if (state.repositionArmedIndex === i) {
    state.repositionArmedIndex = null;
  } else {
    // Отменяем режим добавления новой точки, если он был активен — как и
    // выше, ждать клика одновременно для двух разных целей нельзя.
    if (state.armedForClick) {
      state.armedForClick = false;
      el.armButton.textContent = "Добавить опорную точку";
      el.armButton.classList.remove("armed");
    }
    state.repositionArmedIndex = i;
  }
  updateCanvasCursor();
  renderControlPointList();
}

el.canvas.addEventListener("click", (e) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  if (state.repositionArmedIndex !== null) {
    const rect = el.canvas.getBoundingClientRect();
    const canvasPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const cp = state.controlPoints[state.repositionArmedIndex];
    if (cp) {
      pushControlPointHistory();
      cp.target = canvasToImg(canvasPt);
    }
    state.repositionArmedIndex = null;
    updateCanvasCursor();
    recomputeModel();
    updateCalibPanel();
    render();
    showStatus("Опорная точка переставлена");
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

  // Проверяем ещё раз прямо перед созданием точки: пока курсор был в
  // режиме ожидания клика по карте, пользователь мог успеть подвинуть
  // слайдер/поле времени и выбрать другую точку трека, для которой уже
  // есть опорная точка (проверка при нажатии "Добавить" этого не ловит).
  if (hasControlPointAtTrackIndex(state.selectedTrackIndex)) {
    showStatus("На этой точке трека уже есть опорная точка — выбери другое время", true);
    state.armedForClick = false;
    el.armButton.textContent = "Добавить опорную точку";
    el.armButton.classList.remove("armed");
    updateCanvasCursor();
    return;
  }

  const trackPoint = state.trackStats.points[state.selectedTrackIndex];
  const source = state.projection.toMeters(trackPoint.lat, trackPoint.lon);

  pushControlPointHistory();
  state.controlPoints.push({
    trackIndex: state.selectedTrackIndex,
    source,
    target: imgPt,
  });
  sortControlPoints();
  state.currentIndicatorVisible = false; // опорная точка зафиксирована — маркер текущей точки на треке больше не нужен

  state.armedForClick = false;
  el.armButton.textContent = "Добавить опорную точку";
  el.armButton.classList.remove("armed");
  updateCanvasCursor();

  recomputeModel();
  updateCalibPanel();
  render();
});

/** Двойной клик по точке трека на карте — быстрый способ сразу и выбрать
 *  эту точку, и включить режим "жду клика по карте" для добавления опорной
 *  точки (эквивалент клика по точке + кнопке "Добавить опорную точку"), с
 *  коротким пульсом на месте точки как подтверждением. */
el.canvas.addEventListener("dblclick", (e) => {
  if (!state.model || !state.trackStats) return;
  if (state.repositionArmedIndex !== null) return; // не мешаем активной перестановке существующей точки
  const rect = el.canvas.getBoundingClientRect();
  const canvasPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const idx = findNearestTrackIndexByCanvasPoint(canvasPt);
  if (idx === null) return;

  selectTrackIndex(idx);

  if (hasControlPointAtTrackIndex(idx)) {
    showStatus("На этой точке трека уже есть опорная точка", true);
    return;
  }

  if (!state.armedForClick) {
    state.armedForClick = true;
    el.armButton.textContent = "Отмена";
    el.armButton.classList.add("armed");
    updateCanvasCursor();
  }

  startArmPulse(idx);
});

el.undoButton.addEventListener("click", undoControlPoints);
el.redoButton.addEventListener("click", redoControlPoints);

// Горячие клавиши: Ctrl/Cmd+Z — отменить, Ctrl/Cmd+Shift+Z и Ctrl/Cmd+Y —
// повторить (поддерживаем оба варианта, т.к. привычки разнятся между
// редакторами). Не перехватываем их, пока фокус в текстовом поле (там это
// должен обрабатывать нативный undo самого поля ввода) и пока открыта
// модалка обрезки — там свой контекст.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key !== "z" && key !== "y") return;

  const target = e.target;
  const isTextInput =
    target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  if (isTextInput) return;
  if (!el.trimModal.classList.contains("hidden")) return;

  if (key === "y" || (key === "z" && e.shiftKey)) {
    e.preventDefault();
    redoControlPoints();
  } else {
    e.preventDefault();
    undoControlPoints();
  }
});

el.clearCalibButton.addEventListener("click", () => {
  if (state.controlPoints.length > 0) pushControlPointHistory();
  state.controlPoints = [];
  state.model = null;
  state.repositionArmedIndex = null;
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
  pushControlPointHistory();
  state.controlPoints.splice(index, 1);
  state.repositionArmedIndex = null; // индексы сдвинулись — снимаем режим перестановки, если был активен
  recomputeModel();
  updateCalibPanel();
  render();
}

/** Изменение времени уже добавленной опорной точки — двигает её вдоль трека,
 *  не трогая место клика на карте. */
function retimeControlPoint(index, raw) {
  if (raw.trim() === "") {
    // Пустое поле — плейсхолдер уже действующего времени этой точки,
    // менять нечего: просто возвращаем поле к текущему значению.
    updateCalibPanel();
    return;
  }
  const newIdx = parseTimeStringToIndex(raw);
  if (newIdx === null) {
    showStatus("Неверный формат, используй ММ:СС или Ч:ММ:СС", true);
    updateCalibPanel(); // откатить текстовое поле к прежнему значению
    return;
  }
  if (hasControlPointAtTrackIndex(newIdx, index)) {
    showStatus("На этой точке трека уже есть опорная точка — выбери другое время", true);
    updateCalibPanel(); // откатить текстовое поле к прежнему значению
    return;
  }
  const cp = state.controlPoints[index];
  const newPoint = state.trackStats.points[newIdx];
  pushControlPointHistory();
  cp.trackIndex = newIdx;
  cp.source = state.projection.toMeters(newPoint.lat, newPoint.lon);
  sortControlPoints(); // порядок в массиве может измениться — снимаем режим перестановки, если был активен
  state.repositionArmedIndex = null;
  recomputeModel();
  updateCalibPanel();
  render();
}

// ---------- Оформление трека: цвета, прозрачность, толщина ----------

function updateLegendGradient() {
  el.legendGradient.style.background = paceGradientCss(state.paceColorStops);
}

const paceColorInputs = [el.colorStop0, el.colorStop1, el.colorStop2, el.colorStop3];
paceColorInputs.forEach((inputEl, i) => {
  inputEl.value = state.paceColorStops[i];
  inputEl.addEventListener("input", () => {
    state.paceColorStops[i] = inputEl.value;
    updateLegendGradient();
    render();
  });
});
updateLegendGradient();

el.resetColorsButton.addEventListener("click", () => {
  state.paceColorStops = [...DEFAULT_PACE_COLOR_STOPS];
  paceColorInputs.forEach((inputEl, i) => {
    inputEl.value = state.paceColorStops[i];
  });
  updateLegendGradient();
  render();
});

// ---------- Границы шкалы темпа (быстро/медленно) ----------
//
// Раньше вся шкала растягивалась АВТОМАТИЧЕСКИ между минимальным и
// максимальным (95й перцентиль) темпом трека — подстроить границы вручную
// было нельзя. Теперь, как в QuickRoute, можно самому задать темп,
// соответствующий самому быстрому (левая граница — первый цвет градиента)
// и самому медленному (правая граница — последний цвет) участку: ползунком
// или прямым вводом "мм:сс". Раскраска линии (см. drawRoute) использует
// именно эти значения, а не сырые min/max из трека — авто-значения из
// трека остаются лишь стартовой точкой при загрузке нового файла.

/** Диапазон [min,max] секунд/км, в котором имеет смысл двигать ползунки —
 *  вычисляется из реальных сегментных темпов трека с небольшим запасом по
 *  краям (иначе крайние значения данных упирались бы в самый край шкалы
 *  ползунка). */
function paceSliderRange() {
  const fallback = { min: 120, max: 900 };
  if (!state.trackStats) return fallback;
  const paces = state.trackStats.points
    .map((p) => p.segPaceSecPerKm)
    .filter((v) => v !== null && Number.isFinite(v));
  if (!paces.length) return fallback;
  const dataMin = Math.min(...paces);
  const dataMax = Math.max(...paces);
  const pad = Math.max(15, (dataMax - dataMin) * 0.15);
  return {
    min: Math.max(30, Math.floor(dataMin - pad)),
    max: Math.ceil(dataMax + pad),
  };
}

/** Настраивает диапазон ползунков под текущий трек и выставляет исходные
 *  значения границ шкалы — по умолчанию тот же авто-диапазон, что раньше
 *  использовался неявно (минимальный темп и 95й перцентиль). Вызывается
 *  один раз при загрузке нового трека (см. handleTrackFile) — при
 *  повторной обрезке уже выбранные пользователем границы не сбрасываются. */
function setupPaceSliders() {
  const range = paceSliderRange();
  [el.paceMinSlider, el.paceMaxSlider].forEach((slider) => {
    slider.min = range.min;
    slider.max = range.max;
    slider.step = 5;
  });
  state.paceMinSecPerKm = state.trackStats.minPaceSecPerKm ?? range.min;
  state.paceMaxSecPerKm = state.trackStats.maxPaceSecPerKm ?? range.max;
  syncPaceBoundsUI();
}

/** Раздвигает атрибуты min/max самих ползунков, если пользователь вручную
 *  ввёл через текстовое поле значение за пределами текущего диапазона —
 *  иначе бегунок визуально "прилипал" бы к краю шкалы, хотя
 *  state.pace*SecPerKm уже содержит другое, более крайнее значение. */
function extendPaceSliderBounds(sec) {
  const lo = Math.min(Number(el.paceMinSlider.min), sec);
  const hi = Math.max(Number(el.paceMaxSlider.max), sec);
  el.paceMinSlider.min = lo;
  el.paceMaxSlider.min = lo;
  el.paceMinSlider.max = hi;
  el.paceMaxSlider.max = hi;
}

/** секунды/км -> "м:сс", без суффикса " /км" (тот, что в formatPace) —
 *  формат для содержимого текстовых полей ввода границ (тот же стиль, что
 *  formatElapsed/trimTimeLabel: минуты без ведущего нуля, секунды с ним). */
function paceToMSS(sec) {
  if (sec === null || !Number.isFinite(sec)) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Длительность, под которую подбирается ширина маски ввода (мм:сс / ч:мм:сс)
 *  для полей темпа — берём текущий верхний предел ползунков, как
 *  trimModalMaxAbsSeconds() берёт длительность всего трека для полей
 *  обрезки. Именно от неё зависит, после скольких цифр минут маска сама
 *  проставляет ":" и переходит к секундам. */
function paceMaskMaxAbsSeconds() {
  return Number(el.paceMaxSlider.max) || 900;
}

function syncPaceBoundsUI() {
  if (state.paceMinSecPerKm === null || state.paceMaxSecPerKm === null) return;
  el.paceMinSlider.value = Math.round(state.paceMinSecPerKm);
  el.paceMaxSlider.value = Math.round(state.paceMaxSecPerKm);
  el.paceMinValue.textContent = formatPace(state.paceMinSecPerKm);
  el.paceMaxValue.textContent = formatPace(state.paceMaxSecPerKm);
  const placeholder = zeroTimeMaskLabel(paceMaskMaxAbsSeconds());
  el.paceMinInput.placeholder = placeholder;
  el.paceMaxInput.placeholder = placeholder;
  el.paceMinInput.value = timeInputDisplayValue(paceToMSS(state.paceMinSecPerKm));
  el.paceMaxInput.value = timeInputDisplayValue(paceToMSS(state.paceMaxSecPerKm));
}

const PACE_BOUNDS_MIN_GAP = 5; // секунд/км — границы не могут схлопнуться в одну точку

el.paceMinSlider.addEventListener("input", () => {
  if (state.paceMaxSecPerKm === null) return;
  const v = Math.min(Number(el.paceMinSlider.value), state.paceMaxSecPerKm - PACE_BOUNDS_MIN_GAP);
  state.paceMinSecPerKm = Math.max(Number(el.paceMinSlider.min), v);
  syncPaceBoundsUI();
  render();
});

el.paceMaxSlider.addEventListener("input", () => {
  if (state.paceMinSecPerKm === null) return;
  const v = Math.max(Number(el.paceMaxSlider.value), state.paceMinSecPerKm + PACE_BOUNDS_MIN_GAP);
  state.paceMaxSecPerKm = Math.min(Number(el.paceMaxSlider.max), v);
  syncPaceBoundsUI();
  render();
});

/** Ручной ввод левой границы (черновой, при каждой введённой цифре) — как и
 *  в полях обрезки, обновляет состояние сразу по мере набора через ту же
 *  маскированную маску мм:сс/ч:мм:сс (attachTimeInputMask ниже), не
 *  дожидаясь Enter. Само поле при этом не перезаписывается (это сделала бы
 *  маска сама, если нужно) — ошибки формата тут молча игнорируются,
 *  reportError включается только из обработчика Enter. */
function setPaceMinFromInput({ reportError = false } = {}) {
  if (el.paceMinInput.value.trim() === "") return; // пусто — плейсхолдер уже нулевого значения, менять нечего
  const sec = maskedInputToSeconds(el.paceMinInput.value, paceMaskMaxAbsSeconds());
  if (sec === null || sec <= 0) {
    if (reportError) showStatus("Неверный формат темпа, используй ММ:СС", true);
    return;
  }
  extendPaceSliderBounds(sec);
  state.paceMinSecPerKm = Math.min(sec, state.paceMaxSecPerKm - PACE_BOUNDS_MIN_GAP);
  el.paceMinSlider.value = Math.round(state.paceMinSecPerKm);
  el.paceMinValue.textContent = formatPace(state.paceMinSecPerKm);
  render();
}

function setPaceMaxFromInput({ reportError = false } = {}) {
  if (el.paceMaxInput.value.trim() === "") return;
  const sec = maskedInputToSeconds(el.paceMaxInput.value, paceMaskMaxAbsSeconds());
  if (sec === null || sec <= 0) {
    if (reportError) showStatus("Неверный формат темпа, используй ММ:СС", true);
    return;
  }
  extendPaceSliderBounds(sec);
  state.paceMaxSecPerKm = Math.max(sec, state.paceMinSecPerKm + PACE_BOUNDS_MIN_GAP);
  el.paceMaxSlider.value = Math.round(state.paceMaxSecPerKm);
  el.paceMaxValue.textContent = formatPace(state.paceMaxSecPerKm);
  render();
}

attachTimeInputMask(el.paceMinInput, paceMaskMaxAbsSeconds);
attachTimeInputMask(el.paceMaxInput, paceMaskMaxAbsSeconds);

el.paceMinInput.addEventListener("input", () => setPaceMinFromInput());
el.paceMinInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  setPaceMinFromInput({ reportError: true });
  el.paceMinInput.value = timeInputDisplayValue(paceToMSS(state.paceMinSecPerKm)); // переформатировать начисто
  el.paceMinInput.blur();
});

el.paceMaxInput.addEventListener("input", () => setPaceMaxFromInput());
el.paceMaxInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  setPaceMaxFromInput({ reportError: true });
  el.paceMaxInput.value = timeInputDisplayValue(paceToMSS(state.paceMaxSecPerKm));
  el.paceMaxInput.blur();
});

el.opacitySlider.addEventListener("input", () => {
  // Слайдер показывает "прозрачность": 0% — полностью непрозрачная линия,
  // максимум — самая прозрачная (но не до нуля, чтобы линия не пропадала
  // совсем). routeOpacity — это фактическая непрозрачность (globalAlpha),
  // поэтому она обратна значению слайдера.
  state.routeOpacity = 1 - Number(el.opacitySlider.value) / 100;
  el.opacityValue.textContent = `${el.opacitySlider.value}%`;
  render();
});

el.widthSlider.addEventListener("input", () => {
  state.routeWidth = Number(el.widthSlider.value);
  el.widthValue.textContent = `${state.routeWidth} px`;
  render();
});

el.opacitySlider.value = Math.round((1 - state.routeOpacity) * 100);
el.opacityValue.textContent = `${el.opacitySlider.value}%`;
el.widthSlider.value = state.routeWidth;
el.widthValue.textContent = `${state.routeWidth} px`;

// ---------- Обрезка трека (начало/конец) ----------
//
// Трек не удаляется из данных — просто trimStart/trimEnd задают ПРИМЕНЁННЫЙ
// диапазон индексов, который учитывается при отрисовке линии (drawRoute),
// подсчёте статистики (updateStatsPanel) и как точка отсчёта времени
// (elapsedSeconds). Раньше это была постоянная панель в сайдбаре; теперь —
// модалка, которая сама открывается сразу после загрузки файла трека
// (см. handleTrackFile), плюс кнопка "Изменить обрезку" в панели "Трек"
// (el.editTrimButton), чтобы вернуться к этому позже. Пока модалка открыта,
// изменения слайдеров/полей живут только в ЧЕРНОВИКЕ (trimStartDraft/
// trimEndDraft) — карта, статистика и список опорных точек не трогаются,
// пока не нажата "Применить".

/** Время в модалке обрезки всегда считается от самого начала ЗАПИСИ трека
 *  (индекс 0), а НЕ от уже применённого trimStart. Если считать от
 *  trimStart (как в панели "Привязка"), то при повторном открытии "Изменить
 *  обрезку" всё, что раньше прежнего начала, показывалось бы со знаком
 *  минус — хотя пользователь просто выбирает новую обрезку заново, как в
 *  первый раз, и минус тут не при чём. */
function trimElapsedSeconds(index) {
  const pts = state.trackStats.points;
  const origin = pts[0];
  const p = pts[index];
  if (!origin.time || !p.time) return null;
  return (p.time - origin.time) / 1000;
}

function trimTimeLabel(idx) {
  const p = state.trackStats.points[idx];
  if (!p.time) return `№${idx}`;
  return formatElapsed(trimElapsedSeconds(idx));
}

function findNearestIndexByTrimElapsed(targetSec) {
  const pts = state.trackStats.points;
  const origin = pts[0];
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

/** Парсинг времени для полей модалки обрезки — ищет по ВСЕМУ треку (не
 *  только внутри текущей применённой обрезки), т.к. слайдеры обрезки и так
 *  позволяют выбрать любую точку от начала до конца записи. */
function parseTrimTimeStringToIndex(raw) {
  const sec = maskedInputToSeconds(raw, trimModalMaxAbsSeconds());
  return sec === null ? null : findNearestIndexByTrimElapsed(sec);
}

/** Длительность всего трека — по ней подбирается ширина маски ввода для
 *  полей модалки обрезки (она работает по всей записи, а не по применённой
 *  обрезке). */
function trimModalMaxAbsSeconds() {
  return (state.trackStats && state.trackStats.totalTimeSec) || 0;
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
    state.repositionArmedIndex = null; // индексы точек могли сдвинуться
    recomputeModel();
    showStatus(
      removed === 1
        ? "Опорная точка вне обрезки удалена"
        : `Опорные точки вне обрезки удалены (${removed})`
    );
  }
}

/** Пересинхронизация модалки с текущим черновиком — слайдеры, подписи
 *  и текстовые поля времени. Не трогает применённую обрезку. */
function syncTrimModalUI() {
  el.trimModalStartSlider.value = state.trimStartDraft;
  el.trimModalEndSlider.value = state.trimEndDraft;
  el.trimModalStartValue.textContent = trimTimeLabel(state.trimStartDraft);
  el.trimModalEndValue.textContent = trimTimeLabel(state.trimEndDraft);
  const placeholder = zeroTimeMaskLabel(trimModalMaxAbsSeconds());
  el.trimModalStartInput.placeholder = placeholder;
  el.trimModalEndInput.placeholder = placeholder;
  el.trimModalStartInput.value = timeInputDisplayValue(trimTimeLabel(state.trimStartDraft));
  el.trimModalEndInput.value = timeInputDisplayValue(trimTimeLabel(state.trimEndDraft));
}

/** Открывает модалку обрезки: черновик стартует от уже ПРИМЕНЁННОЙ обрезки
 *  (при первой загрузке трека это весь трек целиком, при повторном вызове
 *  через "Изменить обрезку" — то, что применили в прошлый раз). */
function openTrimModal() {
  if (!state.trackStats) return;
  const maxIdx = state.trackStats.points.length - 1;
  state.trimStartDraft = state.trimStart;
  state.trimEndDraft = state.trimEnd;
  el.trimModalStartSlider.min = 0;
  el.trimModalStartSlider.max = maxIdx;
  el.trimModalEndSlider.min = 0;
  el.trimModalEndSlider.max = maxIdx;
  syncTrimModalUI();
  el.trimModal.classList.remove("hidden");
}

function closeTrimModal() {
  el.trimModal.classList.add("hidden");
}

/** Применяет текущий черновик как новую обрезку и закрывает модалку. */
function applyTrimFromModal() {
  state.trimStart = state.trimStartDraft;
  state.trimEnd = state.trimEndDraft;
  pruneControlPointsOutsideTrim(); // точки вне диапазона пропадают именно здесь, не раньше
  // Новая обрезка меняет допустимый диапазон индексов — старые снимки
  // undo/redo могли содержать точки за его пределами, поэтому история
  // сбрасывается, а не пытается "дожить" до нового состояния.
  resetControlPointHistory();
  // Выбранная точка трека (индикатор/слайдер привязки) должна оставаться
  // внутри применённого диапазона — иначе она может оказаться ДО нового
  // trimStart и показывать отрицательное время (например "-1:00"), хотя
  // пользователь только что специально сдвинул начало отсчёта на эту точку.
  state.selectedTrackIndex = Math.min(
    Math.max(state.selectedTrackIndex, state.trimStart),
    state.trimEnd
  );
  if (state.hoverTrackIndex !== null) {
    state.hoverTrackIndex = Math.min(
      Math.max(state.hoverTrackIndex, state.trimStart),
      state.trimEnd
    );
  }
  updateStatsPanel();
  updateCalibPanel(); // все времена (слайдер, список опорных точек) теперь отсчитываются от нового trimStart
  render();
  showStatus("Обрезка применена");
  closeTrimModal();
}

el.trimModalStartSlider.addEventListener("input", () => {
  let v = Number(el.trimModalStartSlider.value);
  v = Math.min(v, state.trimEndDraft - 1 >= 0 ? state.trimEndDraft - 1 : 0);
  state.trimStartDraft = Math.max(0, v);
  syncTrimModalUI();
});

el.trimModalEndSlider.addEventListener("input", () => {
  const maxIdx = state.trackStats.points.length - 1;
  let v = Number(el.trimModalEndSlider.value);
  v = Math.max(v, state.trimStartDraft + 1 <= maxIdx ? state.trimStartDraft + 1 : maxIdx);
  state.trimEndDraft = Math.min(maxIdx, v);
  syncTrimModalUI();
});

/** Ручной ввод времени начала обрезки (черновик). Клон логики timeInput/
 *  cp-time-input: парсим по мере ввода, но само поле не перезаписываем,
 *  чтобы не сбивать то, что печатает пользователь. */
function setTrimStartDraftFromInput({ reportError = false } = {}) {
  if (el.trimModalStartInput.value.trim() === "") {
    // Пустое поле — плейсхолдер уже действующего черновика, менять нечего.
    return;
  }
  const idx = parseTrimTimeStringToIndex(el.trimModalStartInput.value);
  if (idx === null) {
    if (reportError) showStatus("Неверный формат, используй ММ:СС или Ч:ММ:СС", true);
    return;
  }
  const maxAllowed = state.trimEndDraft - 1 >= 0 ? state.trimEndDraft - 1 : 0;
  state.trimStartDraft = Math.max(0, Math.min(idx, maxAllowed));
  el.trimModalStartSlider.value = state.trimStartDraft;
  el.trimModalStartValue.textContent = trimTimeLabel(state.trimStartDraft);
}

function setTrimEndDraftFromInput({ reportError = false } = {}) {
  if (el.trimModalEndInput.value.trim() === "") {
    // Пустое поле — плейсхолдер уже действующего черновика, менять нечего.
    return;
  }
  const idx = parseTrimTimeStringToIndex(el.trimModalEndInput.value);
  if (idx === null) {
    if (reportError) showStatus("Неверный формат, используй ММ:СС или Ч:ММ:СС", true);
    return;
  }
  const maxIdx = state.trackStats.points.length - 1;
  const minAllowed = state.trimStartDraft + 1 <= maxIdx ? state.trimStartDraft + 1 : maxIdx;
  state.trimEndDraft = Math.min(maxIdx, Math.max(idx, minAllowed));
  el.trimModalEndSlider.value = state.trimEndDraft;
  el.trimModalEndValue.textContent = trimTimeLabel(state.trimEndDraft);
}

attachTimeInputMask(el.trimModalStartInput, trimModalMaxAbsSeconds);
attachTimeInputMask(el.trimModalEndInput, trimModalMaxAbsSeconds);

el.trimModalStartInput.addEventListener("input", () => setTrimStartDraftFromInput());
el.trimModalStartInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  setTrimStartDraftFromInput({ reportError: true });
  el.trimModalStartInput.value = timeInputDisplayValue(trimTimeLabel(state.trimStartDraft)); // переформатировать начисто
  el.trimModalStartInput.blur();
});

el.trimModalEndInput.addEventListener("input", () => setTrimEndDraftFromInput());
el.trimModalEndInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  setTrimEndDraftFromInput({ reportError: true });
  el.trimModalEndInput.value = timeInputDisplayValue(trimTimeLabel(state.trimEndDraft));
  el.trimModalEndInput.blur();
});

el.trimModalApplyButton.addEventListener("click", applyTrimFromModal);

// Клик по затемнённому фону или Escape — просто закрывают модалку, ничего
// не применяя (при первой загрузке трек и так уже показан целиком).
el.trimModal.addEventListener("click", (e) => {
  if (e.target === el.trimModal) closeTrimModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el.trimModal.classList.contains("hidden")) {
    closeTrimModal();
  }
});

el.editTrimButton.addEventListener("click", openTrimModal);


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
  for (let i = state.trimStart; i <= state.trimEnd; i++) {
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
  if (!state.model || !state.trackStats || state.armedForClick || state.repositionArmedIndex !== null) return;
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
  } else if (state.armedForClick || state.repositionArmedIndex !== null || state.hoverTrackIndex !== null) {
    el.canvas.style.cursor = "crosshair";
  } else {
    el.canvas.style.cursor = "grab";
  }
}

el.canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || state.armedForClick || state.repositionArmedIndex !== null || state.hoverTrackIndex !== null) return;
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

/** Панель "Темп" осмысленна только когда трек уже спроецирован на карту —
 *  то есть загружены и карта, и трек. До этого её показывать нечего. */
function updateLegendPanelVisibility() {
  const ready = !!(state.mapImage && state.trackStats);
  el.legendPanel.classList.toggle("hidden", !ready);
}

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
  // Точки вне [trimStart, trimEnd] не рисуются и не участвуют в статистике,
  // поэтому и выбор точки трека для привязки должен быть ограничен этим же
  // диапазоном — иначе слайдер позволяет выбрать точку "до старта" и время
  // показывается отрицательным относительно нового trimStart.
  el.trackSlider.min = state.trimStart;
  el.trackSlider.max = state.trimEnd;
  el.trackSlider.value = state.selectedTrackIndex;

  const hasTime = !!state.trackStats.points[0].time;
  el.timeInput.disabled = !hasTime;

  el.trackSliderLabel.textContent = sliderLabelText(state.selectedTrackIndex);
  el.timeInput.placeholder = zeroTimeMaskLabel(calibMaxAbsSeconds());
  el.timeInput.value = timeInputDisplayValue(elapsedLabel(state.selectedTrackIndex));
  renderControlPointList();

  el.undoButton.disabled = state.history.length === 0;
  el.redoButton.disabled = state.future.length === 0;
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
    timeInput.placeholder = zeroTimeMaskLabel(calibMaxAbsSeconds());
    const cpLabel = elapsedLabel(cp.trackIndex);
    timeInput.value = cpLabel === null ? `#${cp.trackIndex}` : timeInputDisplayValue(cpLabel);
    timeInput.disabled = !state.trackStats.points[0].time;
    attachTimeInputMask(timeInput, calibMaxAbsSeconds);
    const commit = () => retimeControlPoint(i, timeInput.value);
    timeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") timeInput.blur();
    });
    timeInput.addEventListener("blur", commit);
    li.appendChild(timeInput);

    const moveBtn = document.createElement("button");
    moveBtn.type = "button";
    moveBtn.className = "cp-move-btn";
    moveBtn.title = "Переставить точку на карте";
    moveBtn.setAttribute("aria-label", "Переставить точку на карте");
    moveBtn.classList.toggle("armed", state.repositionArmedIndex === i);
    moveBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="5 9 2 12 5 15"></polyline>' +
      '<polyline points="9 5 12 2 15 5"></polyline>' +
      '<polyline points="15 19 12 22 9 19"></polyline>' +
      '<polyline points="19 9 22 12 19 15"></polyline>' +
      '<line x1="2" y1="12" x2="22" y2="12"></line>' +
      '<line x1="12" y1="2" x2="12" y2="22"></line>' +
      "</svg>";
    moveBtn.addEventListener("click", () => toggleRepositionArm(i));
    li.appendChild(moveBtn);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cp-delete-btn";
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
  // Опорные точки, текущая точка и пульс привязки — служебные маркеры
  // калибровки, в сохранённой картинке им делать нечего: рисуем чистый
  // кадр только для экспорта, а затем возвращаем обычный вид на канвасе.
  render({ includeMarkers: false });
  const link = document.createElement("a");
  link.download = "track.png";
  link.href = el.canvas.toDataURL("image/png");
  link.click();
  render();
});
