// guide.mjs — 手の撮影の、判定とガイドの文(画面に依存しない関数だけ。Node でも、試験できる)。
//   入力: MediaPipe の手の点(21個。x, y は 0〜1。映像の元の向きのまま)、手の左右のラベル、映像の大きさ。
//   出力: 条件ごとの、できた / できていない と、いちばん大事な、ガイドの文1つ。
//   しきい値は、全部、下の T にまとめてある(実際の機種で、試して、調整する)。

// ---- しきい値 ----
// 版(ファイルが、新旧、混ざっていないかを、画面で、確かめるための、印)。 guide.mjs と app.js で、同じ値にする
export const VERSION = "v39";

export const T = {
  edge: 0.02,          // 手の点が、画面の端から、この割合より、外にあると、「はみ出している」
  sizeMin: 0.65,       // 手の大きさ(手の枠の、長い方 ÷ 画面の短い辺)。これより小さいと「遠い」
  sizeMax: 1.10,       // これより大きいと「近い」(縦長の画面では、手が、画面の短い辺より、長くなっても、幅の中に、収まる)
  guideOverlap: 0.50,  // ガイドとの一致した面積(そのまま重ねた時)の、最小。これ以上で、ガイド(うすい形)が緑になり、条件「ガイドに重なっている」が、そろう
  centerTol: 0.25,     // 手の中心が、画面の中心から、この割合(画面の幅・高さに対して)より外れると、「中央に」
  flatMin: 0.45,       // 手のひらの幅 ÷ 高さ。これより小さいと、「傾いている」(カメラに、まっすぐ向けていない)
  extendRatio: 1.12,   // 指が伸びている: (指先〜手首) ÷ (第2関節〜手首) が、これ以上
  openGapMinDeg: 1.5,  // となり合う指の、開き(度)の、最小。「重なっていない」の目安。目的(皮膚・関節・爪)では、大きく開く必要は、ない(6度、3度では、厳しすぎた)
  openTotalMinDeg: 0,  // 人差し指〜小指の、開きの合計(度)の、最小。0 = 見ない
  stillMax: 0.012,     // 動き(画面の対角に対する割合)。これ以下なら「止まっている」
  stillWindowMs: 400,  // 動きを見る、時間の幅
  brightMin: 60,       // 手のあたりの、明るさ(0〜255)。これより暗いと「暗い」
  brightMax: 225,      // これより明るいと「明るすぎる」
  sharpMin: 40,        // くっきり度(縮小した画像の、ラプラシアンの分散)。これより小さいと「ぼやけている」
  holdMs: 1000,        // すべて、そろった状態が、これだけ続いたら、撮る
};

// 左右のラベルについて: 手の左右(Left / Right)は、モデルが、映像の見た目から、出す。
//   当初は、「鏡に映した(自撮りの)映像を、前提に、出る → 元の向きの映像では、左右を、入れ替える」と、考えて、true にしていた(MediaPipe の、古い資料の説明)。
//   実機(2026-11-20)で、手のひらと甲が、逆に出たので、入れ替えない(false)に、直した。
//   true にすると、左右が、入れ替わる(手のひらと甲が、逆になる)。
export const RAW_FRAME = false;

// ---- 手の点の、番号 ----
export const LM = { WRIST: 0, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8, MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12, RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16, PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20 };
// 4本の指(親指は、除く): 付け根、第2関節、第1関節、指先
export const FINGERS = [
  { name: "人差し指", mcp: 5, pip: 6, dip: 7, tip: 8 },
  { name: "中指", mcp: 9, pip: 10, dip: 11, tip: 12 },
  { name: "薬指", mcp: 13, pip: 14, dip: 15, tip: 16 },
  { name: "小指", mcp: 17, pip: 18, dip: 19, tip: 20 },
];

// ---- 小さな、計算の部品 ----
const px = (p, f) => ({ x: p.x * f.w, y: p.y * f.h });   // 0〜1 の点を、画素の点に
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angleBetween = (u, v) => {   // 2つの向きの、角度(度。0〜180)
  const d = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
};
const shortSide = (f) => Math.min(f.w, f.h);

// 手の枠(点を、全部、囲む四角)
export function bbox(lm) {
  const xs = lm.map((p) => p.x), ys = lm.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// ---- 手の形のガイドと、一致した面積 ----
// ガイドの手(正面向きの、指を開いた手)と、いまの手を、「太らせた骨組み」(手のひらの多角形 + 指の太い線)の形にして、重なりの面積を比べる。
//   どちらも、同じ作り方なので、輪郭の細かさの、違いは出ない(粗い形どうしの比べ)。 リアルタイムで動く(分割モデルは、使わない)。
export const SIL = { finger: 0.11, thumb: 0.14, palm: 0.11 };   // 線の半径 = 手のひらの幅(5〜17)× この値
export const GUIDE_FILL = 0.8;                                   // ガイドの手の大きさ(手首〜指先の長さ ÷ 画面の短い辺)。 横長の画面(PC)
export const GUIDE_TILT_DEG = 30;                                // ガイドの、傾き(度)。 腕の角度に合わせる: 左手は、右へ。 右手は、左へ(画面で見て)。 30度
export const GUIDE_FILL_PORTRAIT = 0.95;                         // 縦長の画面(スマホ): 縦に余りがあるので、大きく(幅の中に、収まる範囲)
export const SIL_BONES = [   // [始め, 終わり, 半径の種類]
  [1, 2, "thumb"], [2, 3, "thumb"], [3, 4, "thumb"],
  [5, 6, "finger"], [6, 7, "finger"], [7, 8, "finger"], [9, 10, "finger"], [10, 11, "finger"], [11, 12, "finger"],
  [13, 14, "finger"], [14, 15, "finger"], [15, 16, "finger"], [17, 18, "finger"], [18, 19, "finger"], [19, 20, "finger"],
  [0, 1, "palm"], [1, 5, "palm"], [5, 9, "palm"], [9, 13, "palm"], [13, 17, "palm"], [17, 0, "palm"],
];
export const PALM_POLY = [0, 1, 5, 9, 13, 17];

// 小指の下の、手のひらの、ふくらみ(小指側の、丸み)。 手首(0)と小指の付け根(17)を結ぶ辺を、外へ、ゆるく、ふくらませる。
//   辺の上に、円を、n 個、並べる(辺の真ん中で、いちばん外へ。 外へのずれ = 手のひらの幅 × out × sin)。 円の半径は、小指の付け根の側では、小指の太さ(SIL.finger)、手首の側では、手のひらの辺の太さ(SIL.palm)へ、なめらかに、細くする(段差を作らない)。 円を、細かく、並べて、ギザギザにしない。
export const SIL_BULGE = { n: 25, out: 0.10, pow: 1 };   // pow: ふくらみの形(1 = sin。小さいほど、小指の付け根の側から、早く、ふくらむ)
// P: 手の点(21個。x, y)。 戻り値: [{ x, y, r }](ガイドの絵と、形の地図の、両方で、同じ円を使う)
export function silDisks(P) {
  const palmW = dist(P[5], P[17]);
  const cen = PALM_POLY.reduce((s, i) => ({ x: s.x + P[i].x / PALM_POLY.length, y: s.y + P[i].y / PALM_POLY.length }), { x: 0, y: 0 });
  const a = P[17], b = P[0];
  const e = { x: b.x - a.x, y: b.y - a.y }, L = Math.hypot(e.x, e.y);
  if (L < 1e-9 || palmW < 1e-9 || SIL_BULGE.n < 1) return [];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  let n = { x: -e.y / L, y: e.x / L };
  if ((mid.x - cen.x) * n.x + (mid.y - cen.y) * n.y < 0) n = { x: -n.x, y: -n.y };   // 手のひらの、外へ
  const out = [];
  for (let k = 1; k <= SIL_BULGE.n; k++) {
    const s = k / (SIL_BULGE.n + 1), off = SIL_BULGE.out * palmW * Math.pow(Math.sin(Math.PI * s), SIL_BULGE.pow);
    out.push({ x: a.x + e.x * s + n.x * off, y: a.y + e.y * s + n.y * off, r: (SIL.palm + (SIL.finger - SIL.palm) * (1 - s)) * palmW });
  }
  return out;
}

// 土台の手の形(手首が原点、指が上向き、手のひらが、カメラに向いた、右手。単位は、手の長さに近い、相対の値)
function templatePoints(spread = 12) {
  const dirAngle = [1.5, 0.5, -0.5, -1.5].map((k) => k * spread);
  const mcp = [{ x: 0.16, y: -0.36 }, { x: 0.05, y: -0.40 }, { x: -0.06, y: -0.38 }, { x: -0.17, y: -0.32 }];
  const len = [0.30, 0.34, 0.31, 0.24];
  const pts = new Array(21);
  pts[0] = { x: 0, y: 0 };
  pts[1] = { x: 0.12, y: -0.08 }; pts[2] = { x: 0.22, y: -0.18 }; pts[3] = { x: 0.30, y: -0.27 }; pts[4] = { x: 0.36, y: -0.35 };
  for (let f = 0; f < 4; f++) {
    const a = (dirAngle[f] * Math.PI) / 180, d = { x: Math.sin(a), y: -Math.cos(a) };
    const at = (k) => ({ x: mcp[f].x + d.x * len[f] * k, y: mcp[f].y + d.y * len[f] * k });
    const base = 5 + f * 4;
    pts[base] = { ...mcp[f] }; pts[base + 1] = at(0.45); pts[base + 2] = at(0.72); pts[base + 3] = at(1.0);
  }
  return pts;
}

// 太らせた骨組みの形(0/1 の地図)。 lm: 0〜1 の手の点21個。 gw: 地図の幅(マス)。 戻り値: { mask, gw, gh, area }
export function silhouetteMask(lm, frame, gw = 200) {
  const gh = Math.max(1, Math.round((gw * frame.h) / frame.w));
  const mask = new Uint8Array(gw * gh);
  const P = lm.map((q) => ({ x: q.x * gw, y: q.y * gh }));   // 地図のマスの座標(マスは、正方形)
  const palmW = dist(P[5], P[17]);
  // 手のひらの多角形の中(偶奇)
  const poly = PALM_POLY.map((i) => P[i]);
  for (let j = 0; j < gh; j++) {
    const y = j + 0.5, xs = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let i = Math.max(0, Math.ceil(xs[k] - 0.5)); i <= Math.min(gw - 1, Math.floor(xs[k + 1] - 0.5)); i++) mask[j * gw + i] = 1;
    }
  }
  // 骨組みの線を、半径をつけて、太らせる
  for (const [s, e, kind] of SIL_BONES) {
    const a = P[s], b = P[e], r = SIL[kind] * palmW;
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - r)), x1 = Math.min(gw - 1, Math.ceil(Math.max(a.x, b.x) + r));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - r)), y1 = Math.min(gh - 1, Math.ceil(Math.max(a.y, b.y) + r));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const x = i + 0.5, y = j + 0.5;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2)) : 0;
        if (Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)) <= r) mask[j * gw + i] = 1;
      }
    }
  }
  for (const d of silDisks(P)) {   // 小指の下の、ふくらみ
    const x0 = Math.max(0, Math.floor(d.x - d.r)), x1 = Math.min(gw - 1, Math.ceil(d.x + d.r));
    const y0 = Math.max(0, Math.floor(d.y - d.r)), y1 = Math.min(gh - 1, Math.ceil(d.y + d.r));
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) if (Math.hypot(i + 0.5 - d.x, j + 0.5 - d.y) <= d.r) mask[j * gw + i] = 1;
  }
  let area = 0;
  for (let i = 0; i < mask.length; i++) area += mask[i];
  return { mask, gw, gh, area };
}

// 2つの形の、一致した面積 = 重なり ÷ 合わせた面積(0〜1)
export function maskIoU(a, b) {
  if (!a || !b || a.mask.length !== b.mask.length) return null;
  let inter = 0, uni = 0;
  for (let i = 0; i < a.mask.length; i++) { const x = a.mask[i], y = b.mask[i]; if (x & y) inter++; if (x | y) uni++; }
  return uni === 0 ? null : inter / uni;
}

// ガイドの手(正面向き・指を開いた手)の点と形。 hand: 本当の手 "right" | "left"、facing: カメラに向く側 "palm" | "back"。 画面の真ん中に、大きさ GUIDE_FILL で置く。
export function makeGuide(frame, { hand = "right", facing = "palm", spread = 12, tilt = 0, mirror = false } = {}) {
  const flipX = (hand === "left") !== (facing === "back");
  const fill = frame.h > frame.w ? GUIDE_FILL_PORTRAIT : GUIDE_FILL;   // 縦長の画面は、大きく
  const S = (fill * Math.min(frame.w, frame.h)) / 0.74;
  const flat = templatePoints(spread).map((p) => ({ x: (flipX ? -p.x : p.x) * S, y: p.y * S }));
  // 腕の角度に合わせた、傾き。 手首(原点)を、中心に、回す。 時計回りが、プラス(指先が、画面の右へ)。
  //   左手は、右へ(+)、右手は、左へ(-)。 前面カメラ(鏡のように映す)の時は、画面で見た向きを、合わせるため、元の映像では、逆向き。
  const signed = tilt * (hand === "left" ? 1 : -1) * (mirror ? -1 : 1);
  const co = Math.cos((signed * Math.PI) / 180), si = Math.sin((signed * Math.PI) / 180);
  let pts = flat.map((p) => ({ x: p.x * co - p.y * si, y: p.x * si + p.y * co }));
  // 傾けて、はみ出さないように、必要なら、小さくする(手の点の枠が、画面の 9割まで)
  let xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const k = Math.min(1, (0.9 * frame.w) / (Math.max(...xs) - Math.min(...xs)), (0.9 * frame.h) / (Math.max(...ys) - Math.min(...ys)));
  pts = pts.map((p) => ({ x: p.x * k, y: p.y * k }));
  xs = pts.map((p) => p.x);
  ys = pts.map((p) => p.y);
  const ox = frame.w / 2 - (Math.min(...xs) + Math.max(...xs)) / 2, oy = frame.h / 2 - (Math.min(...ys) + Math.max(...ys)) / 2;
  const lm = pts.map((p) => ({ x: (p.x + ox) / frame.w, y: (p.y + oy) / frame.h, z: 0 }));
  return { lm, sil: silhouetteMask(lm, frame), hand, facing, tilt: signed };
}

// いまの手を、手首(0)と中指の付け根(9)が、ガイドと同じ位置・向き・大きさになるように、動かして・回して・拡大縮小する(形だけを、比べるため)
export function alignHand(lm, target, frame) {
  const L = lm.map((q) => px(q, frame)), T0 = px(target[LM.WRIST], frame), T9 = px(target[LM.MIDDLE_MCP], frame);
  const l0 = L[LM.WRIST], l9 = L[LM.MIDDLE_MCP];
  const lv = { x: l9.x - l0.x, y: l9.y - l0.y }, tv = { x: T9.x - T0.x, y: T9.y - T0.y };
  const ll = Math.hypot(lv.x, lv.y), tl = Math.hypot(tv.x, tv.y);
  if (ll < 1e-6 || tl < 1e-6) return null;
  const s = tl / ll, ang = Math.atan2(tv.y, tv.x) - Math.atan2(lv.y, lv.x), c = Math.cos(ang), n = Math.sin(ang);
  return L.map((q) => {
    const x = q.x - l0.x, y = q.y - l0.y;
    return { x: (T0.x + s * (c * x - n * y)) / frame.w, y: (T0.y + s * (n * x + c * y)) / frame.h, z: 0 };
  });
}

// いまの手(lm)と、ガイド(makeGuide の結果)の、一致した面積。
//   overlap = 画面の上で、そのまま重ねた時。 shape = 位置・向き・大きさをそろえた後の、形だけ(手を傾けたり、指を閉じたりすると、下がる)。
export function guideMatch(lm, guide, frame, withShape = true) {
  if (!lm || lm.length < 21 || !guide) return null;
  const live = silhouetteMask(lm, frame, guide.sil.gw);
  const overlap = maskIoU(live, guide.sil);
  if (!withShape) return { overlap, shape: null };
  const al = alignHand(lm, guide.lm, frame);
  const shape = al ? maskIoU(silhouetteMask(al, frame, guide.sil.gw), guide.sil) : null;
  return { overlap, shape };
}

// 手が、画面の中に、全部、入っているか
export function insideFrame(lm, edge = T.edge) {
  return lm.every((p) => p.x >= edge && p.x <= 1 - edge && p.y >= edge && p.y <= 1 - edge);
}

// 手の大きさ: 手の枠の、長い方(画素) ÷ 画面の短い辺
export function handSize(lm, frame) {
  const b = bbox(lm);
  return Math.max(b.w * frame.w, b.h * frame.h) / shortSide(frame);
}

// 手の中心の、画面の中心からの、ずれ(画面の幅・高さに対する割合)
export function centerOffset(lm) {
  const b = bbox(lm);
  return { dx: b.cx - 0.5, dy: b.cy - 0.5 };
}

// 手のひらか、甲か。 外積の符号(人差し指の付け根と、小指の付け根の、向き)と、左右のラベルで、決める。
//   戻り値: { facing: "palm" | "back", cross, hand: "right" | "left" }
export function facingOf(lm, label, frame, rawFrame = RAW_FRAME) {
  const w = px(lm[LM.WRIST], frame), i = px(lm[LM.INDEX_MCP], frame), p = px(lm[LM.PINKY_MCP], frame);
  const v1 = { x: i.x - w.x, y: i.y - w.y }, v2 = { x: p.x - w.x, y: p.y - w.y };
  const cross = v1.x * v2.y - v1.y * v2.x;   // 画面は、下向きが +y
  const modelSaysRight = label === "Right";
  const isRight = rawFrame ? !modelSaysRight : modelSaysRight;   // 鏡に映していない映像では、左右が、逆
  const palm = isRight ? cross < 0 : cross > 0;
  return { facing: palm ? "palm" : "back", cross, hand: isRight ? "right" : "left" };
}

// 手のひらの、傾き: 幅(人差し指と小指の付け根) ÷ 高さ(手首と中指の付け根)。傾くと、小さくなる
export function flatness(lm, frame) {
  const width = dist(px(lm[LM.INDEX_MCP], frame), px(lm[LM.PINKY_MCP], frame));
  const height = dist(px(lm[LM.WRIST], frame), px(lm[LM.MIDDLE_MCP], frame));
  return height === 0 ? 0 : width / height;
}

// 指が、伸びているか、開いているか。
//   extend: 4本の指の、(指先〜手首) ÷ (第2関節〜手首)
//   gaps: となり合う指の、向きの、角度(度)[人差し指-中指, 中指-薬指, 薬指-小指]
//   total: 人差し指と小指の、向きの、角度(度)
export function fingerShape(lm, frame) {
  const wrist = px(lm[LM.WRIST], frame);
  const extend = FINGERS.map((f) => dist(px(lm[f.tip], frame), wrist) / (dist(px(lm[f.pip], frame), wrist) || 1));
  const dirs = FINGERS.map((f) => { const m = px(lm[f.mcp], frame), t = px(lm[f.tip], frame); return { x: t.x - m.x, y: t.y - m.y }; });
  const gaps = [0, 1, 2].map((i) => angleBetween(dirs[i], dirs[i + 1]));
  return { extend, gaps, total: angleBetween(dirs[0], dirs[3]) };
}

// ---- 爪(指先)の四角 ----
// 手の甲を撮る時に、5本の指先の、爪のあたりを、指の向きに合わせた、四角で示す(後で、切り出す範囲)。
//   指の向き = 第1関節(dip)から指先(tip)へ。 四角は、その向きに沿って、第1関節から、指先の少し先まで。 幅は、指に直角。
//   基準の長さ L0 = 第1関節〜指先。 縦 = L0 × lengthK、横 = L0 × widthK(あなたの手で試して、調整する)。 下の辺(第1関節の側)は、動かさず、上(指先の側)と、横を、広げる
export const NAIL_BOX = { lengthK: 1.875, widthK: 1.25 };   // 縦 = 1.25 × 1.25 × 1.2(上を、さらに 1.2倍にした)。 横 = 1.25。 第1関節の側の辺は、そのまま
export const NAIL_FINGERS = [
  { name: "親指", key: "thumb", dip: 3, tip: 4 }, { name: "人差し指", key: "index", dip: 7, tip: 8 }, { name: "中指", key: "middle", dip: 11, tip: 12 },
  { name: "薬指", key: "ring", dip: 15, tip: 16 }, { name: "小指", key: "pinky", dip: 19, tip: 20 },
];
// 戻り値: 5本分の { name, corners(画素の4点。第1関節側の左・右、指先側の右・左 の順), center, w, h, u(指の向き), v(指に直角), upAngle(指が、真上から、右へ傾いた角度。度) } | null
export function fingertipRects(lm, frame, box = NAIL_BOX) {
  if (!lm || lm.length < 21) return null;
  const out = [];
  for (const f of NAIL_FINGERS) {
    const a = px(lm[f.dip], frame), b = px(lm[f.tip], frame);
    const L0 = dist(a, b);
    if (L0 < 1e-6) return null;
    const u = { x: (b.x - a.x) / L0, y: (b.y - a.y) / L0 };   // 指の向き
    const v = { x: -u.y, y: u.x };                              // 指に直角
    const len = L0 * box.lengthK, wid = L0 * box.widthK;
    const at = (s, t) => ({ x: a.x + u.x * s + v.x * t, y: a.y + u.y * s + v.y * t });
    out.push({
      name: f.name, key: f.key,
      corners: [at(0, -wid / 2), at(0, wid / 2), at(len, wid / 2), at(len, -wid / 2)],
      center: at(len / 2, 0), w: wid, h: len, u, v,
      upAngle: (Math.atan2(u.x, -u.y) * 180) / Math.PI,
    });
  }
  return out;
}

// 切り出し用の、変換の行列。 元の写真の点 p を、切り出した写真の点 (X, Y) にする(指先が、真上になる)。
//   X = (p - 中心)・v + W/2、 Y = H/2 - (p - 中心)・u。 canvas の setTransform(a, b, c, d, e, f) に、そのまま、渡せる。 W × H = 四角の、画素の大きさ(拡大しない。丸めた値)
export function nailCropMatrix(rect) {
  const W = Math.max(8, Math.round(rect.w)), H = Math.max(8, Math.round(rect.h));
  const { u, v, center: c } = rect;
  return { a: v.x, b: -u.x, c: v.y, d: -u.y, e: W / 2 - (v.x * c.x + v.y * c.y), f: H / 2 + (u.x * c.x + u.y * c.y), W, H };
}

// 動き: 直近の、時間の幅の中で、いまの点と、いちばん違う点までの、ずれ(画面の対角に対する割合)
//   history: [{ t(ミリ秒), pts: [{x, y}...](いくつかの点) }]  新しい物が、後ろ
export function motionScore(history, frame, windowMs = T.stillWindowMs) {
  if (history.length < 2) return 1;   // まだ、わからない(動いている扱い)
  const latest = history[history.length - 1];
  const diag = Math.hypot(frame.w, frame.h);
  let worst = 0;
  for (const h of history) {
    if (latest.t - h.t > windowMs || h === latest) continue;
    const mean = h.pts.reduce((s, p, i) => s + Math.hypot((p.x - latest.pts[i].x) * frame.w, (p.y - latest.pts[i].y) * frame.h), 0) / h.pts.length;
    worst = Math.max(worst, mean / diag);
  }
  if (latest.t - history[0].t < windowMs * 0.6) return 1;   // 見ている時間が、足りない
  return worst;
}
// 動きを見る、点の番号(手首、付け根、指先)
export const MOTION_POINTS = [0, 5, 9, 13, 17, 4, 8, 12, 16, 20];
export const pointsOf = (lm, idx = MOTION_POINTS) => idx.map((i) => ({ x: lm[i].x, y: lm[i].y }));

// ---- 映像の、画素の数字(明るさと、くっきり度)。縮小した、小さな画像で、調べる ----
// rgba: Uint8ClampedArray(canvas の getImageData)。戻り値: 明るさ(0〜255)の平均
export function meanLuma(rgba) {
  let sum = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4) { sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]; n++; }
  return n === 0 ? 0 : sum / n;
}
export function toGray(rgba) {
  const g = new Float32Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) g[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  return g;
}
// くっきり度: ラプラシアン(まわりとの差)の、分散。ぼやけると、小さくなる
export function sharpness(gray, w, h) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap; sum2 += lap * lap; n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

// 明るさと、くっきり度を、測る場所(中心の点。0〜1)。 なめらかな皮膚だけだと、ピントが合っていても、数字が、低く出る。
//   そこで、模様や、輪郭が出やすい場所(指の関節のまわり、指先)を、いくつか選んで、いちばんくっきりした場所の、数字を、使う。
//   手の中心、4本の指の第2関節、親指の第1関節。
export function patchCenters(lm, mode) {
  if (!lm) return [{ x: 0.5, y: 0.5 }];   // 手が無い時は、画面の中心(明るさだけ、見る)
  const at = (i) => ({ x: lm[i].x, y: lm[i].y });
  const palm = [0, 5, 9, 13, 17];
  const center = { x: palm.reduce((s, i) => s + lm[i].x, 0) / palm.length, y: palm.reduce((s, i) => s + lm[i].y, 0) / palm.length };
  return [center, at(6), at(10), at(14), at(18), at(3)];
}

// 複数の場所の数字から、使う数字を決める: 明るさは、平均。くっきり度は、いちばん高い場所
export function combineMeasures(list) {
  if (list.length === 0) return { bright: null, sharp: null };
  return { bright: list.reduce((s, m) => s + m.bright, 0) / list.length, sharp: Math.max(...list.map((m) => m.sharp)) };
}

// ---- チェック項目と、ガイドの文 ----
// チェック項目の、一覧(画面に出す、順番)。 id と、短い名前
export function checkList(mode, wantHand = null) {
  const common = [{ id: "hand", label: "手が見えている" }];
  if (mode === "palm" || mode === "back") {
    const side = wantHand ? [{ id: "side", label: wantHand === "right" ? "右手" : "左手" }] : [];   // 撮る手(右 / 左)が、合っているか
    return [...common, ...side, { id: "inside", label: "画面に入っている" }, { id: "size", label: "近さ" }, { id: "center", label: "中央" },
      { id: "facing", label: mode === "palm" ? "手のひら側" : "手の甲側" }, { id: "flat", label: "まっすぐ" },
      { id: "extend", label: "指が伸びている" }, { id: "open", label: "指が重なっていない" }, { id: "guide", label: "ガイドに重なっている" },
      { id: "bright", label: "明るさ" }, { id: "still", label: "止まっている" }, { id: "sharp", label: "ピント" }];
  }
  return common;
}

// ---- 撮る順番(左手 → 右手。それぞれ、手のひら → 手の甲) ----
export const STEPS = [
  { id: "left-palm", hand: "left", mode: "palm", label: "左手のひら" },
  { id: "left-back", hand: "left", mode: "back", label: "左手の甲" },
  { id: "right-palm", hand: "right", mode: "palm", label: "右手のひら" },
  { id: "right-back", hand: "right", mode: "back", label: "右手の甲" },
];

// 次に撮る物の番号。 current の次から、一周して、まだ撮っていない物を探す。 全部、撮れていれば -1。 current が -1 なら、先頭から。
export function nextStep(doneFlags, current = -1) {
  const n = STEPS.length;
  for (let k = 1; k <= n; k++) {
    const i = (((current + k) % n) + n) % n;
    if (!doneFlags[i]) return i;
  }
  return -1;
}

// 撮り方の説明(1つ分)
export function stepHelp(step) {
  const hand = step.hand === "right" ? "右手" : "左手";
  return step.mode === "palm" ? hand + "の、手のひら側を、カメラに向けて、指を開きます。" : hand + "の、手の甲側を、カメラに向けて、指を開きます。";
}

// 爪(指先)の写真の、ファイル名。 例: hand_left_back_nail_index_20261121_150000.jpg(手の甲の写真と、同じ日付・時刻)
export function nailFileName(step, fingerKey, date) {
  return stepFileName(step, date).replace(".jpg", "").replace(step.hand + "_" + step.mode + "_", step.hand + "_" + step.mode + "_nail_" + fingerKey + "_") + ".jpg";
}

// 保存する時の、ファイル名。 例: hand_right_palm_20261121_150000.jpg
export function stepFileName(step, date) {
  const p2 = (n) => String(n).padStart(2, "0");
  return "hand_" + step.hand + "_" + step.mode + "_" + date.getFullYear() + p2(date.getMonth() + 1) + p2(date.getDate()) + "_" + p2(date.getHours()) + p2(date.getMinutes()) + p2(date.getSeconds()) + ".jpg";
}

// 判定。 input: { mode, landmarks(21個 | null), label("Left" | "Right"), frame({w, h}), motion(動き), brightness(0〜255 | null), sharp(くっきり度 | null), guideOverlap(ガイドとの一致 0〜1 | 省略), wantHand(撮る手 "right" | "left" | 省略) }
//   戻り値: { checks: [{ id, label, ok, msg }], allOk, guide, numbers }
//   guide: ok でない、最初の項目の、文。全部、そろったら、「そのまま、止めてください」。
export function evaluate(input) {
  const { mode, landmarks: lm, label, frame, motion, brightness, sharp } = input;
  const list = checkList(mode, input.wantHand);
  const numbers = {};
  const msgs = {};   // id → 直す、ガイドの文(ok の時は、無い)
  const ok = {};

  ok.hand = !!lm;
  if (!lm) msgs.hand = "手を、画面に、映してください";

  if (lm) {
    const face = facingOf(lm, label, frame);
    numbers.hand = face.hand; numbers.cross = Math.round(face.cross); numbers.facing = face.facing; numbers.label = label;
    if ((mode === "palm" || mode === "back") && input.wantHand) {   // 撮る手(右 / 左)が、合っているか
      ok.side = face.hand === input.wantHand;
      if (!ok.side) msgs.side = (input.wantHand === "right" ? "右手" : "左手") + "を、映してください(いまは、" + (face.hand === "right" ? "右手" : "左手") + "です)";
    }
    const wantPalm = mode === "palm";
    const facingOk = face.facing === (wantPalm ? "palm" : "back");
    ok.facing = facingOk;
    if (!facingOk) msgs.facing = mode === "palm" ? "手のひらを、カメラに、向けてください" : "手の甲を、カメラに、向けてください";

    if (mode === "palm" || mode === "back") {
      ok.inside = insideFrame(lm);
      if (!ok.inside) msgs.inside = "手が、はみ出しています。画面の中に、入れてください";
      const size = handSize(lm, frame);
      numbers.size = Math.round(size * 100) / 100;
      ok.size = size >= T.sizeMin && size <= T.sizeMax;
      if (size < T.sizeMin) msgs.size = "もう少し、近づけてください";
      else if (size > T.sizeMax) msgs.size = "少し、離してください";
      const c = centerOffset(lm);
      numbers.center = [Math.round(c.dx * 100) / 100, Math.round(c.dy * 100) / 100];
      ok.center = Math.abs(c.dx) <= T.centerTol && Math.abs(c.dy) <= T.centerTol;
      if (!ok.center) msgs.center = "手を、画面の中央に、動かしてください";
      const flat = flatness(lm, frame);
      numbers.flat = Math.round(flat * 100) / 100;
      ok.flat = flat >= T.flatMin;
      if (!ok.flat) msgs.flat = "手を、カメラに、まっすぐ向けてください(傾いています)";
      const shape = fingerShape(lm, frame);
      numbers.extend = shape.extend.map((v) => Math.round(v * 100) / 100);
      numbers.gaps = shape.gaps.map((v) => Math.round(v)); numbers.total = Math.round(shape.total);
      const bent = shape.extend.findIndex((v) => v < T.extendRatio);
      ok.extend = bent < 0;
      if (!ok.extend) msgs.extend = FINGERS[bent].name + "を、まっすぐ、伸ばしてください";
      const narrow = shape.gaps.findIndex((g) => g < T.openGapMinDeg);
      ok.open = narrow < 0 && shape.total >= T.openTotalMinDeg;
      if (narrow >= 0) msgs.open = FINGERS[narrow].name + "と" + FINGERS[narrow + 1].name + "が、重なっています。少し、離してください";
      else if (!ok.open) msgs.open = "指を、少し、離してください";
      // ガイドとの一致(「そのまま」。0〜1)。 渡されない時(試験など)は、判定しない
      if (input.guideOverlap != null) {
        numbers.guideOverlap = Math.round(input.guideOverlap * 100);
        ok.guide = input.guideOverlap >= T.guideOverlap;
        if (!ok.guide) msgs.guide = "手を、ガイドの形に、重ねてください";
      } else {
        ok.guide = true;
      }

    }
  }

  // 画素の数字(手が見えていなくても、明るさは、見られる)
  numbers.bright = brightness == null ? null : Math.round(brightness);
  ok.bright = brightness != null && brightness >= T.brightMin && brightness <= T.brightMax;
  if (brightness != null && brightness < T.brightMin) msgs.bright = "暗いです。明るい場所で、撮ってください";
  else if (brightness != null && brightness > T.brightMax) msgs.bright = "明るすぎます。光が、強すぎない所で、撮ってください";
  else if (brightness == null) msgs.bright = "明るさを、確かめています";

  numbers.motion = motion == null ? null : Math.round(motion * 1000) / 1000;
  ok.still = motion != null && motion <= T.stillMax;
  if (!ok.still) msgs.still = "手を、止めてください";

  numbers.sharp = sharp == null ? null : Math.round(sharp);
  ok.sharp = sharp != null && sharp >= T.sharpMin;
  if (!ok.sharp) msgs.sharp = "ピントが合うまで、止めてください";

  const checks = list.map((c) => ({ id: c.id, label: c.label, ok: !!ok[c.id], msg: msgs[c.id] || "" }));
  const firstBad = checks.find((c) => !c.ok);
  return { checks, allOk: !firstBad, guide: firstBad ? firstBad.msg || "条件を、確かめています" : "そのまま、止めてください", numbers };
}

// そろった状態が、続いた時間を、数える(途中で、1回でも崩れたら、数え直す)
export function holdProgress(state, allOk, now) {
  if (!allOk) return { since: null, progress: 0, ready: false };
  const since = state.since ?? now;
  const progress = Math.min(1, (now - since) / T.holdMs);
  return { since, progress, ready: progress >= 1 };
}
