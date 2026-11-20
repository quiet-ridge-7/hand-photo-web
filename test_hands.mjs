// test_hands.mjs — 試験用の、人工の手の点(21個)を、作る部品。本物の手では、ありません。
//   guide_test.mjs と、app_smoke_test.mjs が、使う。
export const FRAME = { w: 1280, h: 720 };      // 横長の映像(PC)
export const PORTRAIT = { w: 720, h: 1280 };   // 縦長の映像(スマホ)

// 土台の手の形(手首が原点、指が上向き、手のひらが、カメラに向いた、右手。単位は、手の長さに、近い、相対の値)
function canonicalPts(spread, curl) {
  const dirAngle = [1.5, 0.5, -0.5, -1.5].map((k) => k * spread);   // 縦からの、角度(度)。+ は、画面の右へ傾く
  const mcp = [{ x: 0.16, y: -0.36 }, { x: 0.05, y: -0.40 }, { x: -0.06, y: -0.38 }, { x: -0.17, y: -0.32 }];
  const len = [0.30, 0.34, 0.31, 0.24];
  const pts = new Array(21);
  pts[0] = { x: 0, y: 0 };
  pts[1] = { x: 0.12, y: -0.08 }; pts[2] = { x: 0.22, y: -0.18 }; pts[3] = { x: 0.30, y: -0.27 }; pts[4] = { x: 0.36, y: -0.35 };
  for (let f = 0; f < 4; f++) {
    const a = (dirAngle[f] * Math.PI) / 180, d = { x: Math.sin(a), y: -Math.cos(a) };
    const at = (k) => ({ x: mcp[f].x + d.x * len[f] * k, y: mcp[f].y + d.y * len[f] * k });
    const base = 5 + f * 4;
    pts[base] = { ...mcp[f] };
    if (curl === f) { pts[base + 1] = at(0.45); pts[base + 2] = { x: pts[base + 1].x + 0.02, y: pts[base + 1].y + 0.05 }; pts[base + 3] = { x: pts[base + 1].x + 0.01, y: pts[base + 1].y + 0.09 }; }
    else { pts[base + 1] = at(0.45); pts[base + 2] = at(0.72); pts[base + 3] = at(1.0); }
  }
  return pts;
}

//   hand: "right" | "left"(本当の手)  facing: "palm" | "back"(カメラに向いている側)  指は、上向き。
//   scale: 手の大きさ(画面の短い辺に対する、手首〜中指の先の、長さの、おおよその割合)
//   spread: となり合う指の、開き(度)  tilt: 手の幅の、縮み(1 = まっすぐ。小さいほど、傾いている)  curl: 曲げる指の番号(0〜3)
//   cx, cy: 手の枠の、中心(0〜1)  tipsAt: { x, y } を、指定すると、5本の指先の、中心を、そこに置く
export function makeHand({ hand = "right", facing = "palm", scale = 0.8, spread = 12, tilt = 1, curl = null, cx = 0.5, cy = 0.5, tipsAt = null, frame = FRAME } = {}) {
  const pts = canonicalPts(spread, curl);
  const flipX = (hand === "left") !== (facing === "back");
  const S = scale * Math.min(frame.w, frame.h) / 0.74;
  let px = pts.map((p) => ({ x: (flipX ? -p.x : p.x) * tilt * S, y: p.y * S }));
  let ox, oy;
  if (tipsAt) {
    const tips = [4, 8, 12, 16, 20].map((i) => px[i]);
    ox = tipsAt.x * frame.w - tips.reduce((s, p) => s + p.x, 0) / 5; oy = tipsAt.y * frame.h - tips.reduce((s, p) => s + p.y, 0) / 5;
  } else {
    const xs = px.map((p) => p.x), ys = px.map((p) => p.y);
    ox = cx * frame.w - (Math.min(...xs) + Math.max(...xs)) / 2; oy = cy * frame.h - (Math.min(...ys) + Math.max(...ys)) / 2;
  }
  const lm = px.map((p) => ({ x: (p.x + ox) / frame.w, y: (p.y + oy) / frame.h, z: 0 }));
  const label = hand === "right" ? "Right" : "Left";   // モデルの、手の左右のラベル(RAW_FRAME = false の前提: 本当の手の、左右と、同じ)
  return { lm, label };
}


// 3次元の手(MediaPipe の worldLandmarks の代わり。単位: メートル)。 pan: 左右のひねり(度)、tilt: 前後の倒れ(度)。 0 = カメラに、まっすぐ。
//   向き: x は右、y は下、z は奥(カメラから、遠ざかる向き)。 手のひら(右手)がカメラに向いている時の、法線は、手前(-z)。
export function makeWorld({ hand = "right", facing = "palm", spread = 12, pan = 0, tilt = 0 } = {}) {
  const pts = canonicalPts(spread, null);
  const flipX = (hand === "left") !== (facing === "back");
  const p = (pan * Math.PI) / 180, t = (tilt * Math.PI) / 180;
  return pts.map((q) => {
    let x = (flipX ? -q.x : q.x) * 0.2, y = q.y * 0.2, z = 0;   // 手の長さ 約15cm
    // y 軸まわりに、pan 回す
    let x1 = x * Math.cos(p) + z * Math.sin(p), z1 = -x * Math.sin(p) + z * Math.cos(p);
    // x 軸まわりに、tilt 回す
    const y2 = y * Math.cos(t) - z1 * Math.sin(t), z2 = y * Math.sin(t) + z1 * Math.cos(t);
    return { x: x1, y: y2, z: z2 };
  });
}
