// guide.mjs — 手の撮影の、判定とガイドの文(画面に依存しない関数だけ。Node でも、試験できる)。
//   入力: MediaPipe の手の点(21個。x, y は 0〜1。映像の元の向きのまま)、手の左右のラベル、映像の大きさ。
//   出力: 条件ごとの、できた / できていない と、いちばん大事な、ガイドの文1つ。
//   しきい値は、全部、下の T にまとめてある(実際の機種で、試して、調整する)。

// ---- しきい値 ----
export const T = {
  edge: 0.02,          // 手の点が、画面の端から、この割合より、外にあると、「はみ出している」
  sizeMin: 0.50,       // 手の大きさ(手の枠の、長い方 ÷ 画面の短い辺)。これより小さいと「遠い」
  sizeMax: 0.98,       // これより大きいと「近い」
  guideOverlap: 0.55,  // ガイドとの一致した面積(そのまま重ねた時)が、これ以上なら、ガイドを緑にする
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
  tipSegMin: 0.075,    // 指先モード: 指先の大きさ((指先〜第一関節) ÷ 画面の短い辺)の、最小
  tipSegMax: 0.30,     // 最大
  tipCenterTol: 0.30,  // 指先モード: 指先の中心が、画面の中心から、外れてよい割合
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
export const TIPS = [4, 8, 12, 16, 20];

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
export const SIL = { finger: 0.11, thumb: 0.14, palm: 0.08 };   // 線の半径 = 手のひらの幅(5〜17)× この値
export const GUIDE_FILL = 0.8;                                   // ガイドの手の大きさ(手首〜指先の長さ ÷ 画面の短い辺)
export const SIL_BONES = [   // [始め, 終わり, 半径の種類]
  [1, 2, "thumb"], [2, 3, "thumb"], [3, 4, "thumb"],
  [5, 6, "finger"], [6, 7, "finger"], [7, 8, "finger"], [9, 10, "finger"], [10, 11, "finger"], [11, 12, "finger"],
  [13, 14, "finger"], [14, 15, "finger"], [15, 16, "finger"], [17, 18, "finger"], [18, 19, "finger"], [19, 20, "finger"],
  [0, 1, "palm"], [1, 5, "palm"], [5, 9, "palm"], [9, 13, "palm"], [13, 17, "palm"], [17, 0, "palm"],
];
export const PALM_POLY = [0, 1, 5, 9, 13, 17];

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
export function makeGuide(frame, { hand = "right", facing = "palm", spread = 12 } = {}) {
  const flipX = (hand === "left") !== (facing === "back");
  const S = (GUIDE_FILL * Math.min(frame.w, frame.h)) / 0.74;
  const pts = templatePoints(spread).map((p) => ({ x: (flipX ? -p.x : p.x) * S, y: p.y * S }));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const ox = frame.w / 2 - (Math.min(...xs) + Math.max(...xs)) / 2, oy = frame.h / 2 - (Math.min(...ys) + Math.max(...ys)) / 2;
  const lm = pts.map((p) => ({ x: (p.x + ox) / frame.w, y: (p.y + oy) / frame.h, z: 0 }));
  return { lm, sil: silhouetteMask(lm, frame), hand, facing };
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
export function guideMatch(lm, guide, frame) {
  if (!lm || lm.length < 21 || !guide) return null;
  const live = silhouetteMask(lm, frame, guide.sil.gw);
  const overlap = maskIoU(live, guide.sil);
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

// 手のひらの面の、向き(カメラに対する、角度)。 3次元の手の点(worldLandmarks。メートル。x は右、y は下、z は奥)から、出す。
//   面の法線 = (人差し指の付け根 - 手首) × (小指の付け根 - 手首)。 カメラの向き(z 軸)との、ずれを、2つの角度に分ける。
//   pan: 左右のひねり(度)  tilt: 前後の倒れ(度)  angle: 合わせた、ずれ(度)。 0 = 手のひら(甲)が、カメラに、まっすぐ向いている。
//   符号は、法線を、カメラ側(手前)に、向けて、決める。 点が、足りない・向きが、決まらない時は、null。
//   注意: 奥行きの推定には、誤差がある(十数度、ずれることがある)。しきい値は、実機の数字を見て、決める。
export function palmAngles(world) {
  if (!world || world.length < 21) return null;
  const w = world[LM.WRIST], i = world[LM.INDEX_MCP], p = world[LM.PINKY_MCP];
  if (![w, i, p].every((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z))) return null;
  const v1 = { x: i.x - w.x, y: i.y - w.y, z: i.z - w.z }, v2 = { x: p.x - w.x, y: p.y - w.y, z: p.z - w.z };
  let n = { x: v1.y * v2.z - v1.z * v2.y, y: v1.z * v2.x - v1.x * v2.z, z: v1.x * v2.y - v1.y * v2.x };
  const len = Math.hypot(n.x, n.y, n.z);
  if (len < 1e-9) return null;
  n = { x: n.x / len, y: n.y / len, z: n.z / len };
  if (n.z > 0) n = { x: -n.x, y: -n.y, z: -n.z };   // 手前(カメラ側 = -z)に、向ける
  const deg = (r) => (r * 180) / Math.PI;
  return { pan: deg(Math.atan2(n.x, -n.z)), tilt: deg(Math.atan2(n.y, -n.z)), angle: deg(Math.acos(Math.min(1, -n.z))) };
}

// 3x3 の対称行列の、固有値と固有ベクトル(ヤコビ法)。 戻り値: { values: [3つ], vectors: [3つの、長さ 1 のベクトル(同じ順番)] }
export function eigenSym3(m) {
  const A = m.map((r) => r.slice());
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    if (Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]) < 1e-20) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-30) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const x = A[k][p], y = A[k][q]; A[k][p] = c * x - s * y; A[k][q] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = A[p][k], y = A[q][k]; A[p][k] = c * x - s * y; A[q][k] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - s * y; V[k][q] = s * x + c * y; }
    }
  }
  return { values: [A[0][0], A[1][1], A[2][2]], vectors: [0, 1, 2].map((j) => ({ x: V[0][j], y: V[1][j], z: V[2][j] })) };
}

// ---- 手の向き(pan / tilt / roll)----
// 小さな、ベクトルの部品
const vAdd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vSub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vDot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const vCross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const vScale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const vNorm = (a) => { const l = Math.hypot(a.x, a.y, a.z); return l < 1e-12 ? null : vScale(a, 1 / l); };

// 手の、座標軸(3方向)を、手の点21個(worldLandmarks。メートル)すべてから、作る。
//   座標は、カメラ基準に、直す: X = 右、Y = 上、Z = 手前(見ている人の側)。 (MediaPipe は、x = 右、y = 下、z = 奥)
//   ez(手のひら / 甲の、向き)= points(既定は、8点)に、いちばんよく合う面の、法線。 手前向き(+Z)に、そろえる。
//   ey(指の、向き)= 手首から、中指の付け根(9。points に無ければ、points の中の、ほかの指の付け根の平均、それも無ければ 4本の平均)への向き。 面の中に、直す。
//   ex(手の、幅の向き)= ey × ez(右手系)。
//   戻り値: { ex, ey, ez, rms(あてはまりの悪さ。ミリメートル) } | null
//   手が、カメラに、まっすぐ向いていて、指が、上向きなら、ex = X、ey = Y、ez = Z(= 0度)になる。左右・手のひら / 甲に、よらない。
// 比べるための、点の選び方: PALM_POINTS = 手のひらの、かたい部分(手首、親指の付け根、4本の指の付け根)の6点。 ALL_POINTS = 21点すべて。
//   実機で、指先の5点が、いつも、手前(赤)に、推定されて、21点の面が、前に倒れて見えた(MediaPipe の奥行き z は、指先が、手前に、偏る)。 そこで、指先を除いた 16点(POINTS16)、さらに、指先に近い関節も除いた 11点(POINTS11)が、基本。
export const PALM_POINTS = [0, 1, 5, 9, 13, 17];
export const ALL_POINTS = Array.from({ length: 21 }, (_, i) => i);
// 指先の5点(親指・人差し指・中指・薬指・小指の先)を除いた、16点。 面のあてはめ・奥行きの色の、基本の点。(指先は、奥行きが、いつも、手前に偏るため)
export const POINTS16 = ALL_POINTS.filter((i) => !TIPS.includes(i));
// さらに、指先に近い関節(親指の指先の、1つ手前の関節と、4本の指の第1関節。3、7、11、15、19)を除いた、11点。 基本の点(面のあてはめ・奥行きの色)。
//   11点 = 手首、親指の付け根(CMC、MCP)、4本の指の付け根(MCP)と、第2関節(PIP)。
export const DIP_POINTS = [3, 7, 11, 15, 19];
export const POINTS11 = POINTS16.filter((i) => !DIP_POINTS.includes(i));
// さらに、小指の2点(付け根 17、第2関節 18)と、薬指の第2関節(14)を除いた、8点。 基本の点(面のあてはめ・奥行きの色・指の向き・矢印の始点)。
//   8点 = 手首(0)、親指の付け根(1、2)、人差し指の付け根と第2関節(5、6)、中指の付け根と第2関節(9、10)、薬指の付け根(13)。
export const POINTS8 = [0, 1, 2, 5, 6, 9, 10, 13];

export function handFrame(world, points = POINTS8) {
  if (!world || world.length < 21) return null;
  if (!world.every((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z))) return null;
  const Pall = world.map((q) => ({ x: q.x, y: -q.y, z: -q.z }));
  const P = points.map((i) => Pall[i]);   // 面をあてはめる点
  const n = P.length;
  const m = vScale(P.reduce((s, q) => vAdd(s, q), { x: 0, y: 0, z: 0 }), 1 / n);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const q of P) {
    const d = [q.x - m.x, q.y - m.y, q.z - m.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += (d[i] * d[j]) / n;
  }
  const { values, vectors } = eigenSym3(C);
  if (values[0] + values[1] + values[2] < 1e-18) return null;
  let k = 0;
  for (let i = 1; i < 3; i++) if (values[i] < values[k]) k = i;
  let ez = vNorm(vectors[k]);
  if (!ez) return null;
  if (ez.z < 0) ez = vScale(ez, -1);
  // 指の向き: 手首から、中指の付け根(9)への向き(手の軸として、標準的)。 使う点に、9が無ければ、使う点の中の指の付け根の平均。それも無ければ、4本の平均
  const mcpIdx = points.includes(9) ? [9] : [5, 13, 17].filter((i) => points.includes(i));
  const useMcp = mcpIdx.length > 0 ? mcpIdx : [5, 9, 13, 17];
  const mcp = vScale(useMcp.map((i) => Pall[i]).reduce((s, q) => vAdd(s, q), { x: 0, y: 0, z: 0 }), 1 / useMcp.length);
  let d = vSub(mcp, Pall[0]);
  d = vSub(d, vScale(ez, vDot(d, ez)));
  const ey = vNorm(d);
  if (!ey) return null;
  const ex = vCross(ey, ez);
  return { ex, ey, ez, rms: Math.sqrt(Math.max(0, values[k])) * 1000 };
}

// 手の軸から、3つの角度(度)を、出す。 回転の順番: pan(縦の軸)→ tilt(横の軸)→ roll(視線の軸)。 0 = 手のひらが、カメラに、まっすぐ向いて、指が、真上。
//   pan: 手のひらの向きが、画面の右へ、ひねられると、プラス(カメラの映像の、右。前面カメラの鏡のような、表示では、逆に見える)
//   tilt: 指先が、カメラに、近づく方に、倒れると、プラス
//   roll: 手が、画面の中で、反時計回りに、回ると、プラス(カメラの映像で、見て)
//   angle: 手のひらの面の、カメラの視線からの、ずれ(pan と tilt を、合わせた大きさ)
export function framePose(f) {
  if (!f) return null;
  const deg = (r) => (r * 180) / Math.PI;
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  return { pan: deg(Math.atan2(f.ez.x, f.ez.z)), tilt: deg(Math.asin(clamp(-f.ez.y))), roll: deg(Math.atan2(f.ex.y, f.ey.y)), angle: deg(Math.acos(clamp(f.ez.z))), rms: f.rms };
}

// 画面に重ねる、法線(手のひら / 甲の、向き)の矢印。 面の計算に使う点(既定は、8点)の中心から、法線の、画面の向きへ。
//   手前(カメラ側)を、向いているほど、短い(点に近い)。 30度で、画面の短い辺 × k × 0.5 の長さ。
//   lm: 画面の中の位置(0〜1)。 f: handFrame / smoothFrame の戻り値。 frame: { w, h }(画素)。 戻り値(画素): { from, to, length } | null
export function normalArrow(lm, f, frame, k = 0.5, idx = POINTS8) {
  if (!lm || !f) return null;
  const cx = (idx.reduce((s, i) => s + lm[i].x, 0) / idx.length) * frame.w, cy = (idx.reduce((s, i) => s + lm[i].y, 0) / idx.length) * frame.h;
  const L = Math.min(frame.w, frame.h) * k;
  return { from: { x: cx, y: cy }, to: { x: cx + f.ez.x * L, y: cy - f.ez.y * L }, length: Math.hypot(f.ez.x, f.ez.y) * L };   // 画面は、下向きが +y。 ez は Y が上向き
}

// 直近の、何コマかの、手の軸を、平均して、ゆれを、ならす(奥行きの推定の、ゆれ対策)。 frames: handFrame の戻り値の、配列(古い順)
export function smoothFrame(frames) {
  const list = frames.filter(Boolean);
  if (list.length === 0) return null;
  const avg = (key) => vScale(list.reduce((s, f) => vAdd(s, f[key]), { x: 0, y: 0, z: 0 }), 1 / list.length);
  const ez = vNorm(avg("ez"));
  if (!ez) return null;
  const e = avg("ey");
  const ey = vNorm(vSub(e, vScale(ez, vDot(e, ez))));
  if (!ey) return null;
  return { ex: vCross(ey, ez), ey, ez, rms: list[list.length - 1].rms };
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

// 指先の大きさ: (指先〜第1関節) ÷ 画面の短い辺。5本の指先(親指も)
export function tipSegments(lm, frame) {
  const pairs = [[4, 3], [8, 7], [12, 11], [16, 15], [20, 19]];
  return pairs.map(([tip, dip]) => dist(px(lm[tip], frame), px(lm[dip], frame)) / shortSide(frame));
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
//   手のひら / 甲: 手の中心、4本の指の第2関節、親指の第1関節。 指先(5本): 5本の指先。 指先(1本): 画面の中心に、いちばん近い指先。
export function patchCenters(lm, mode) {
  if (!lm) return [{ x: 0.5, y: 0.5 }];   // 手が無い時は、画面の中心(明るさだけ、見る)
  const at = (i) => ({ x: lm[i].x, y: lm[i].y });
  if (mode === "tip5") return TIPS.map(at);
  if (mode === "tip1") {
    let best = TIPS[0], bd = Infinity;
    for (const i of TIPS) { const d = Math.hypot(lm[i].x - 0.5, lm[i].y - 0.5); if (d < bd) { bd = d; best = i; } }
    return [at(best)];
  }
  const palm = [0, 5, 9, 13, 17];
  const center = { x: palm.reduce((s, i) => s + lm[i].x, 0) / palm.length, y: palm.reduce((s, i) => s + lm[i].y, 0) / palm.length };
  return [center, at(6), at(10), at(14), at(18), at(3)];
}

// 複数の場所の数字から、使う数字を決める: 明るさは、平均。くっきり度は、いちばん高い場所
export function combineMeasures(list) {
  if (list.length === 0) return { bright: null, sharp: null };
  return { bright: list.reduce((s, m) => s + m.bright, 0) / list.length, sharp: Math.max(...list.map((m) => m.sharp)) };
}

// ---- 撮り方(モード)ごとの、チェック項目と、ガイドの文 ----
export const MODES = {
  palm: { label: "手のひら", help: "指を開いて、手のひら側を、カメラに向けます。" },
  back: { label: "手の甲", help: "指を開いて、手の甲側を、カメラに向けます。" },
  tip5: { label: "指先(5本まとめて)", help: "爪が見える側(手の甲側)を向けて、指先を、カメラに近づけます。" },
  tip1: { label: "指先(1本ずつ)", help: "撮りたい指の、指先を、画面の中央に、近づけます。" },
};

// チェック項目の、一覧(画面に出す、順番)。 id と、短い名前
export function checkList(mode) {
  const common = [{ id: "hand", label: "手が見えている" }];
  if (mode === "palm" || mode === "back") {
    return [...common, { id: "inside", label: "画面に入っている" }, { id: "size", label: "近さ" }, { id: "center", label: "中央" },
      { id: "facing", label: mode === "palm" ? "手のひら側" : "手の甲側" }, { id: "flat", label: "まっすぐ" },
      { id: "extend", label: "指が伸びている" }, { id: "open", label: "指が重なっていない" },
      { id: "bright", label: "明るさ" }, { id: "still", label: "止まっている" }, { id: "sharp", label: "ピント" }];
  }
  return [...common, { id: "tipinside", label: "指先が画面に入っている" }, { id: "facing", label: "爪の側" }, { id: "tipsize", label: "近さ" },
    { id: "tipcenter", label: "中央" }, { id: "bright", label: "明るさ" }, { id: "still", label: "止まっている" }, { id: "sharp", label: "ピント" }];
}

// 判定。 input: { mode, landmarks(21個 | null), label("Left" | "Right"), frame({w, h}), motion(動き), brightness(0〜255 | null), sharp(くっきり度 | null) }
//   戻り値: { checks: [{ id, label, ok, msg }], allOk, guide, numbers }
//   guide: ok でない、最初の項目の、文。全部、そろったら、「そのまま、止めてください」。
export function evaluate(input) {
  const { mode, landmarks: lm, label, frame, motion, brightness, sharp, world } = input;
  const pose = input.pose ?? (world ? framePose(handFrame(world)) : null);   // 手の向き(pan / tilt / roll)。アプリは、直近の数コマを、ならした物を、渡す
  const list = checkList(mode);
  const numbers = {};
  const msgs = {};   // id → 直す、ガイドの文(ok の時は、無い)
  const ok = {};

  ok.hand = !!lm;
  if (!lm) msgs.hand = "手を、画面に、映してください";

  if (lm) {
    const face = facingOf(lm, label, frame);
    numbers.hand = face.hand; numbers.cross = Math.round(face.cross); numbers.facing = face.facing; numbers.label = label;
    // 手の向き(確認用の数字だけ。まだ、判定には、使わない)
    //   pan / tilt / roll / angle / rms: 8点から、作った、手の軸(直近の数コマを、ならした物)。 pan3 / tilt3 / angle3: 3点(手首と、人差し指・小指の付け根)だけの面(比べるため)
    const three = palmAngles(world);
    const r1 = (v) => Math.round(v * 10) / 10;
    if (pose) { numbers.pan = r1(pose.pan); numbers.tilt = r1(pose.tilt); numbers.roll = r1(pose.roll); numbers.angle = r1(pose.angle); numbers.rms = r1(pose.rms); }
    if (three) { numbers.pan3 = r1(three.pan); numbers.tilt3 = r1(three.tilt); numbers.angle3 = r1(three.angle); }
    const allFrame = world ? handFrame(world, ALL_POINTS) : null;   // 21点すべてで、あてはめた面(比べるため。指先が、手前に偏るので、前に倒れて見える)
    if (allFrame) { const pa = framePose(allFrame); numbers.panAll = r1(pa.pan); numbers.tiltAll = r1(pa.tilt); }
    const f11 = world ? handFrame(world, POINTS11) : null;   // 11点(指先と第1関節を除いた面。比べるため)
    if (f11) { const p11 = framePose(f11); numbers.pan11 = r1(p11.pan); numbers.tilt11 = r1(p11.tilt); }
    const f16 = world ? handFrame(world, POINTS16) : null;   // 16点(指先だけを除いた面。比べるため)
    if (f16) { const p16 = framePose(f16); numbers.pan16 = r1(p16.pan); numbers.tilt16 = r1(p16.tilt); }
    const palmFrame = world ? handFrame(world, PALM_POINTS) : null;   // 手のひらの6点の面(比べるため)
    if (palmFrame) { const pp = framePose(palmFrame); numbers.panPalm = r1(pp.pan); numbers.tiltPalm = r1(pp.tilt); }
    const wantPalm = mode === "palm";
    const facingOk = mode === "tip5" || mode === "tip1" ? face.facing === "back" : face.facing === (wantPalm ? "palm" : "back");
    ok.facing = facingOk;
    if (!facingOk) msgs.facing = mode === "palm" ? "手のひらを、カメラに、向けてください" : mode === "back" ? "手の甲を、カメラに、向けてください" : "爪が見える側(手の甲)を、カメラに、向けてください";

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
    } else {
      // 指先モード
      const segs = tipSegments(lm, frame);
      numbers.seg = segs.map((v) => Math.round(v * 100) / 100);
      const tips = TIPS.map((i) => lm[i]);
      const inside = (p) => p.x >= T.edge && p.x <= 1 - T.edge && p.y >= T.edge && p.y <= 1 - T.edge;
      let target = tips, targetSegs = segs;
      if (mode === "tip1") {   // 画面の中心に、いちばん近い指先を、撮る相手にする
        let best = 0, bd = Infinity;
        tips.forEach((p, i) => { const d = Math.hypot(p.x - 0.5, p.y - 0.5); if (d < bd) { bd = d; best = i; } });
        target = [tips[best]]; targetSegs = [segs[best]];
        numbers.finger = ["親指", "人差し指", "中指", "薬指", "小指"][best];
      }
      ok.tipinside = target.every(inside);
      if (!ok.tipinside) msgs.tipinside = "指先が、はみ出しています。画面の中に、入れてください";
      const segMed = [...targetSegs].sort((a, b) => a - b)[Math.floor(targetSegs.length / 2)];
      numbers.segMed = Math.round(segMed * 100) / 100;
      ok.tipsize = segMed >= T.tipSegMin && segMed <= T.tipSegMax;
      if (segMed < T.tipSegMin) msgs.tipsize = "もう少し、近づけてください";
      else if (segMed > T.tipSegMax) msgs.tipsize = "少し、離してください";
      const cx = target.reduce((s, p) => s + p.x, 0) / target.length - 0.5, cy = target.reduce((s, p) => s + p.y, 0) / target.length - 0.5;
      numbers.center = [Math.round(cx * 100) / 100, Math.round(cy * 100) / 100];
      ok.tipcenter = Math.abs(cx) <= T.tipCenterTol && Math.abs(cy) <= T.tipCenterTol;
      if (!ok.tipcenter) msgs.tipcenter = mode === "tip1" ? "撮りたい指先を、画面の中央に、動かしてください" : "指先を、画面の中央に、動かしてください";
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
