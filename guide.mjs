// guide.mjs — 手の撮影の、判定とガイドの文(画面に依存しない関数だけ。Node でも、試験できる)。
//   入力: MediaPipe の手の点(21個。x, y は 0〜1。映像の元の向きのまま)、手の左右のラベル、映像の大きさ。
//   出力: 条件ごとの、できた / できていない と、いちばん大事な、ガイドの文1つ。
//   しきい値は、全部、下の T にまとめてある(実際の機種で、試して、調整する)。

// ---- しきい値 ----
export const T = {
  edge: 0.02,          // 手の点が、画面の端から、この割合より、外にあると、「はみ出している」
  sizeMin: 0.50,       // 手の大きさ(手の枠の、長い方 ÷ 画面の短い辺)。これより小さいと「遠い」
  sizeMax: 0.98,       // これより大きいと「近い」
  centerTol: 0.25,     // 手の中心が、画面の中心から、この割合(画面の幅・高さに対して)より外れると、「中央に」
  flatMin: 0.45,       // 手のひらの幅 ÷ 高さ。これより小さいと、「傾いている」(カメラに、まっすぐ向けていない)
  extendRatio: 1.12,   // 指が伸びている: (指先〜手首) ÷ (第2関節〜手首) が、これ以上
  openGapMinDeg: 6,    // となり合う指の、開き(度)の、最小
  openTotalMinDeg: 28, // 人差し指〜小指の、開きの合計(度)の、最小
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
      { id: "extend", label: "指が伸びている" }, { id: "open", label: "指が開いている" },
      { id: "bright", label: "明るさ" }, { id: "still", label: "止まっている" }, { id: "sharp", label: "ピント" }];
  }
  return [...common, { id: "tipinside", label: "指先が画面に入っている" }, { id: "facing", label: "爪の側" }, { id: "tipsize", label: "近さ" },
    { id: "tipcenter", label: "中央" }, { id: "bright", label: "明るさ" }, { id: "still", label: "止まっている" }, { id: "sharp", label: "ピント" }];
}

// 判定。 input: { mode, landmarks(21個 | null), label("Left" | "Right"), frame({w, h}), motion(動き), brightness(0〜255 | null), sharp(くっきり度 | null) }
//   戻り値: { checks: [{ id, label, ok, msg }], allOk, guide, numbers }
//   guide: ok でない、最初の項目の、文。全部、そろったら、「そのまま、止めてください」。
export function evaluate(input) {
  const { mode, landmarks: lm, label, frame, motion, brightness, sharp } = input;
  const list = checkList(mode);
  const numbers = {};
  const msgs = {};   // id → 直す、ガイドの文(ok の時は、無い)
  const ok = {};

  ok.hand = !!lm;
  if (!lm) msgs.hand = "手を、画面に、映してください";

  if (lm) {
    const face = facingOf(lm, label, frame);
    numbers.hand = face.hand; numbers.cross = Math.round(face.cross); numbers.facing = face.facing; numbers.label = label;
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
      if (narrow >= 0) msgs.open = FINGERS[narrow].name + "と" + FINGERS[narrow + 1].name + "を、もう少し、開いてください";
      else if (!ok.open) msgs.open = "指を、もう少し、開いてください";
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
