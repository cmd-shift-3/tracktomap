// transform.js — подгонка преобразования "метры трека" -> "пиксели карты"
// по опорным точкам (control points), которые расставляет пользователь.
//
// Модель: подобие (similarity transform) — поворот + масштаб + сдвиг,
// без перекоса. Это ровно то, что нужно для компенсации ошибки GPS-привязки
// (трек может быть повёрнут/смещён/иметь другой масштаб относительно карты,
// но не "перекошен").
//
// Считаем через комплексные числа: ищем комплексные a (=scale*rotation) и b
// (=translation), минимизирующие sum |target_i - a*source_i - b|^2.
// Решение в замкнутой форме (см. README для вывода).

class Complex {
  constructor(re, im) {
    this.re = re;
    this.im = im;
  }
  static from(x, y) {
    return new Complex(x, y);
  }
  add(o) {
    return new Complex(this.re + o.re, this.im + o.im);
  }
  sub(o) {
    return new Complex(this.re - o.re, this.im - o.im);
  }
  mul(o) {
    return new Complex(
      this.re * o.re - this.im * o.im,
      this.re * o.im + this.im * o.re
    );
  }
  conj() {
    return new Complex(this.re, -this.im);
  }
  scale(k) {
    return new Complex(this.re * k, this.im * k);
  }
  div(o) {
    const denom = o.re * o.re + o.im * o.im;
    if (denom === 0) return new Complex(0, 0);
    const n = this.mul(o.conj());
    return new Complex(n.re / denom, n.im / denom);
  }
}

/**
 * controlPoints: [{ source: {x, y}, target: {x, y} }, ...]
 * Возвращает { transform(pt) -> {x,y}, a, b, rmse } либо null если точек < 2.
 */
function fitSimilarityTransform(controlPoints) {
  if (!controlPoints || controlPoints.length < 2) return null;

  const n = controlPoints.length;
  const src = controlPoints.map((p) => Complex.from(p.source.x, p.source.y));
  const tgt = controlPoints.map((p) => Complex.from(p.target.x, p.target.y));

  const meanS = src
    .reduce((acc, c) => acc.add(c), new Complex(0, 0))
    .scale(1 / n);
  const meanT = tgt
    .reduce((acc, c) => acc.add(c), new Complex(0, 0))
    .scale(1 / n);

  let num = new Complex(0, 0);
  let den = new Complex(0, 0);
  for (let i = 0; i < n; i++) {
    const u = src[i].sub(meanS);
    const v = tgt[i].sub(meanT);
    num = num.add(u.mul(v.conj()));
    den = den.add(u.mul(u.conj()));
  }
  const a = num.div(den).conj(); // solves sum u*conj(v) = a* sum u*conj(u) → a
  const b = meanT.sub(a.mul(meanS));

  const transform = (pt) => {
    const p = Complex.from(pt.x, pt.y).mul(a).add(b);
    return { x: p.re, y: p.im };
  };

  // RMSE в пикселях — насколько хорошо преобразование объясняет опорные точки
  let sqErr = 0;
  for (const cp of controlPoints) {
    const proj = transform(cp.source);
    const dx = proj.x - cp.target.x;
    const dy = proj.y - cp.target.y;
    sqErr += dx * dx + dy * dy;
  }
  const rmse = Math.sqrt(sqErr / n);

  const scale = Math.sqrt(a.re * a.re + a.im * a.im);
  const rotationDeg = (Math.atan2(a.im, a.re) * 180) / Math.PI;

  return { transform, a, b, rmse, scale, rotationDeg };
}

// ---------- Локальная (посегментная) коррекция ----------
//
// Раньше здесь была одна глобальная similarity-transform на весь трек плюс
// интерполяция невязки (buildPiecewiseModel). Проблема: при добавлении новой
// опорной точки глобальный least-squares пересчитывался по ВСЕМ точкам —
// и трек "перескакивал" даже там, где ничего не менялось.
//
// Вместо этого каждый сегмент трека между двумя соседними опорными точками
// получает СВОЁ преобразование, построенное только по этим двум точкам
// (similarity-transform по 2 точкам решается точно, без невязки). Значит,
// добавление/перемещение одной опорной точки задевает только её соседние
// сегменты — остальной трек не шевелится.

/**
 * controlPoints: [{ trackIndex, source:{x,y}, target:{x,y} }, ...]
 * Возвращает { segments } либо null если точек < 2. Каждый segment:
 * { startIndex, endIndex, transform, scale, rotationDeg }.
 */
function buildSegmentedModel(controlPoints) {
  if (!controlPoints || controlPoints.length < 2) return null;
  const sorted = [...controlPoints].sort((a, b) => a.trackIndex - b.trackIndex);

  const segments = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const fit = fitSimilarityTransform([sorted[i], sorted[i + 1]]);
    segments.push({
      startIndex: sorted[i].trackIndex,
      endIndex: sorted[i + 1].trackIndex,
      transform: fit.transform,
      scale: fit.scale,
      rotationDeg: fit.rotationDeg,
    });
  }
  return { segments };
}

/** Проецирует точку трека (по индексу и координатам в метрах) в пиксели карты. */
function projectWithSegmentedModel(model, trackIndex, sourceMeters) {
  const { segments } = model;
  if (trackIndex <= segments[0].startIndex) return segments[0].transform(sourceMeters);
  const lastSeg = segments[segments.length - 1];
  if (trackIndex >= lastSeg.endIndex) return lastSeg.transform(sourceMeters);

  for (const seg of segments) {
    if (trackIndex >= seg.startIndex && trackIndex <= seg.endIndex) {
      return seg.transform(sourceMeters);
    }
  }
  return lastSeg.transform(sourceMeters);
}

/**
 * Кусочно-линейная коррекция поверх глобального подобия.
 *
 * Глобальное преобразование (fitSimilarityTransform) — это ОДИН поворот+
 * масштаб+сдвиг на весь трек, поэтому методом наименьших квадратов он в
 * среднем близок к опорным точкам, но почти никогда не проходит ровно через
 * каждую из них (если точек больше двух). Из-за этого трек на карте "рядом",
 * а не "точно на" контрольных точках.
 *
 * Чтобы трек проходил ровно через каждую расставленную опорную точку (как в
 * оригинальном QuickRoute), считаем на опорных точках невязку — разницу
 * между тем, что предсказало глобальное преобразование, и тем, куда
 * реально кликнул пользователь — а затем линейно "распределяем" эту
 * невязку по треку между соседними опорными точками. У самих опорных точек
 * невязка становится равна нулю (то есть трек проходит точно через них), а
 * между ними — плавно интерполируется.
 *
 * controlPoints должны быть отсортированы по trackIndex по возрастанию.
 */
function buildPiecewiseCorrector(controlPoints, baselineTransform) {
  if (!controlPoints || controlPoints.length === 0) return null;

  const anchors = controlPoints.map((cp) => {
    const predicted = baselineTransform(cp.source);
    return {
      trackIndex: cp.trackIndex,
      dx: cp.target.x - predicted.x,
      dy: cp.target.y - predicted.y,
    };
  });

  return function correct(trackIndex, baselinePt) {
    if (anchors.length === 1) {
      return { x: baselinePt.x + anchors[0].dx, y: baselinePt.y + anchors[0].dy };
    }
    if (trackIndex <= anchors[0].trackIndex) {
      return { x: baselinePt.x + anchors[0].dx, y: baselinePt.y + anchors[0].dy };
    }
    const lastA = anchors[anchors.length - 1];
    if (trackIndex >= lastA.trackIndex) {
      return { x: baselinePt.x + lastA.dx, y: baselinePt.y + lastA.dy };
    }
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      if (trackIndex >= a.trackIndex && trackIndex <= b.trackIndex) {
        const span = b.trackIndex - a.trackIndex || 1;
        const t = (trackIndex - a.trackIndex) / span;
        return {
          x: baselinePt.x + a.dx + (b.dx - a.dx) * t,
          y: baselinePt.y + a.dy + (b.dy - a.dy) * t,
        };
      }
    }
    return baselinePt;
  };
}
