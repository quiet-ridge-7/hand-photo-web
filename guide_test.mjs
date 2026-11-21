// guide_test.mjs — guide.mjs(手の撮影の、判定とガイド)の、試験。人工の手の点(21個)を、プログラムで作って、確かめる。
//   実行: node guide_test.mjs
//   本物の手では、ありません。手のひら / 甲の判定の向きは、実機で、確かめた(逆に出たので、RAW_FRAME を false にした)。
import assert from "node:assert/strict";
import { T, LM, bbox, insideFrame, handSize, centerOffset, facingOf, flatness, fingerShape, tipSegments, motionScore, pointsOf,
  meanLuma, toGray, sharpness, makeGuide, guideMatch, silhouetteMask, maskIoU, alignHand, patchCenters, combineMeasures, checkList, evaluate, holdProgress } from "./guide.mjs";
import { FRAME, PORTRAIT, makeHand } from "./test_hands.mjs";

const failures = [];
const test = (name, fn) => {
  try { fn(); console.log("OK " + name); } catch (e) { console.log("NG " + name + "  <- " + (e && e.message)); failures.push(name); }
};


const good = { brightness: 140, motion: 0.002, sharp: 120 };
const run = (mode, hand, over = {}, frame = FRAME) => evaluate({ mode, landmarks: hand ? hand.lm : null, label: hand ? hand.label : "Left", frame, ...good, ...over });

// ---- 手のひら / 甲の判定 ----
test("手のひらか、甲か: 右手・左手 × 手のひら・甲の、4通りで、正しく判定する(映像の元の向き)", () => {
  for (const hand of ["right", "left"]) for (const facing of ["palm", "back"]) {
    const h = makeHand({ hand, facing });
    const r = facingOf(h.lm, h.label, FRAME);
    assert.equal(r.facing, facing, hand + " " + facing + " cross=" + r.cross);
    assert.equal(r.hand, hand, "手の左右");
  }
});
test("手のひらか、甲か: 縦長の映像でも、同じ", () => {
  for (const hand of ["right", "left"]) for (const facing of ["palm", "back"]) {
    const h = makeHand({ hand, facing, frame: PORTRAIT });
    assert.equal(facingOf(h.lm, h.label, PORTRAIT).facing, facing);
  }
});
test("RAW_FRAME を true にすると、左右が、入れ替わって、手のひらと甲が、逆になる(実機で、逆に出た時の、直し方)", () => {
  const h = makeHand({ hand: "right", facing: "palm" });
  assert.equal(facingOf(h.lm, h.label, FRAME, true).facing, "back");
});

// ---- 大きさ・位置・形 ----
test("手の大きさ: 適度(0.8)は、範囲の中。小さい(0.3)は、遠い。大きい(1.3)は、近い", () => {
  const ok = handSize(makeHand({ scale: 0.8 }).lm, FRAME);
  assert.ok(ok >= T.sizeMin && ok <= T.sizeMax, String(ok));
  assert.ok(handSize(makeHand({ scale: 0.3 }).lm, FRAME) < T.sizeMin);
  assert.ok(handSize(makeHand({ scale: 1.3 }).lm, FRAME) > T.sizeMax);
});
test("画面からの、はみ出し: 中央は、入っている。右端に寄せると、はみ出す", () => {
  assert.ok(insideFrame(makeHand({ cx: 0.5 }).lm));
  assert.ok(!insideFrame(makeHand({ cx: 0.95 }).lm));
});
test("中央からの、ずれ", () => {
  const c = centerOffset(makeHand({ cx: 0.5, cy: 0.5 }).lm);
  assert.ok(Math.abs(c.dx) < 0.01 && Math.abs(c.dy) < 0.01);
  assert.ok(centerOffset(makeHand({ cx: 0.2 }).lm).dx < -0.25);
});
test("傾き: まっすぐ(1)は、閾値より上。傾けた(0.4)は、下", () => {
  assert.ok(flatness(makeHand({ tilt: 1 }).lm, FRAME) >= T.flatMin);
  assert.ok(flatness(makeHand({ tilt: 0.4 }).lm, FRAME) < T.flatMin);
});
test("指の形: 開いた手は、4本とも伸びて、開きが、足りている。閉じた手(開き 0)は、足りない", () => {
  const open = fingerShape(makeHand({ spread: 12 }).lm, FRAME);
  assert.ok(open.extend.every((v) => v >= T.extendRatio), JSON.stringify(open.extend));
  assert.ok(open.gaps.every((g) => g >= T.openGapMinDeg) && open.total >= T.openTotalMinDeg, JSON.stringify(open));
  const closed = fingerShape(makeHand({ spread: 0 }).lm, FRAME);
  assert.ok(closed.gaps.every((g) => g < T.openGapMinDeg));
  const curled = fingerShape(makeHand({ curl: 1 }).lm, FRAME);
  assert.ok(curled.extend[1] < T.extendRatio && curled.extend[0] >= T.extendRatio, JSON.stringify(curled.extend));
});
test("指の重なり: 大きく開いた手(12度)も、ゆるく開いた手(5度)も、少しだけ、離れた手(2度)も OK。ぴったり閉じた手(0度)は、重なっている", () => {
  for (const spread of [12, 5, 2]) {
    const r = run("palm", makeHand({ spread }));
    assert.ok(r.checks.find((c) => c.id === "open").ok, spread + "度: " + JSON.stringify(r.numbers));
  }
  assert.ok(!run("palm", makeHand({ spread: 0 })).checks.find((c) => c.id === "open").ok);
});
test("指先の大きさ: 手を大きく写すと、大きくなる", () => {
  const a = tipSegments(makeHand({ scale: 0.8 }).lm, FRAME)[1], b = tipSegments(makeHand({ scale: 1.6 }).lm, FRAME)[1];
  assert.ok(b > a * 1.9);
});

// ---- 動き ----
test("動き: 止まっている手は、小さい。動いている手は、大きい。見ている時間が、短い間は、動いている扱い", () => {
  const h = makeHand().lm;
  const still = []; for (let t = 0; t <= 600; t += 50) still.push({ t, pts: pointsOf(h) });
  assert.ok(motionScore(still, FRAME) <= T.stillMax);
  const moving = []; for (let t = 0; t <= 600; t += 50) moving.push({ t, pts: pointsOf(makeHand({ cx: 0.5 + t / 3000 }).lm) });
  assert.ok(motionScore(moving, FRAME) > T.stillMax * 2, String(motionScore(moving, FRAME)));
  assert.equal(motionScore(still.slice(0, 3), FRAME), 1);
  assert.equal(motionScore([], FRAME), 1);
});

// ---- 画素の数字 ----
test("明るさ・くっきり度: 市松模様は、くっきり。なめらかな濃淡は、ぼやけている。真っ黒は、暗い", () => {
  const w = 32, h = 32;
  const checker = new Uint8ClampedArray(w * h * 4), smooth = new Uint8ClampedArray(w * h * 4), black = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, c = (x + y) % 2 === 0 ? 220 : 40, s = Math.round((x / w) * 200);
    checker.set([c, c, c, 255], i); smooth.set([s, s, s, 255], i); black.set([0, 0, 0, 255], i);
  }
  assert.ok(sharpness(toGray(checker), w, h) > T.sharpMin * 20);
  assert.ok(sharpness(toGray(smooth), w, h) < T.sharpMin);
  assert.ok(meanLuma(black) === 0 && meanLuma(checker) > 100 && meanLuma(checker) < 150);
});

const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

// ---- 測る場所 ----
test("測る場所: 手のひら / 甲は、手の中心と、指の関節のまわり(6か所)。指先は、5本の指先。1本ずつは、中心に近い1本。手が無ければ、画面の中心", () => {
  const h = makeHand({ facing: "palm" }).lm;
  const pc = patchCenters(h, "palm");
  assert.equal(pc.length, 6);
  const b = bbox(h);
  assert.ok(pc.every((p) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY), "手の枠の外に、ある");
  assert.equal(patchCenters(h, "tip5").length, 5);
  assert.equal(patchCenters(h, "tip1").length, 1);
  assert.deepEqual(patchCenters(null, "palm"), [{ x: 0.5, y: 0.5 }]);
});
test("測る数字のまとめ: 明るさは平均。くっきり度は、いちばん高い場所(なめらかな皮膚が、混ざっても、下がらない)", () => {
  const r = combineMeasures([{ bright: 100, sharp: 3 }, { bright: 140, sharp: 260 }, { bright: 120, sharp: 8 }]);
  assert.equal(r.bright, 120);
  assert.equal(r.sharp, 260);
  assert.deepEqual(combineMeasures([]), { bright: null, sharp: null });
});

// ---- まとめの判定(手のひら・甲) ----
test("手のひらモード: 条件が、全部、そろった手 → ok。ガイドは、「そのまま、止めてください」", () => {
  const r = run("palm", makeHand({ facing: "palm" }));
  assert.ok(r.allOk, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.guide, "そのまま、止めてください");
  assert.equal(r.checks.length, checkList("palm").length);
});
test("手の甲モード: 甲を向けた手 → ok。手のひらを向けた手 → 「手の甲を、カメラに、向けてください」", () => {
  assert.ok(run("back", makeHand({ facing: "back" })).allOk);
  assert.equal(run("back", makeHand({ facing: "palm" })).guide, "手の甲を、カメラに、向けてください");
  assert.equal(run("palm", makeHand({ facing: "back" })).guide, "手のひらを、カメラに、向けてください");
});
test("左手でも、同じように、判定できる", () => {
  assert.ok(run("palm", makeHand({ hand: "left", facing: "palm" })).allOk);
  assert.ok(run("back", makeHand({ hand: "left", facing: "back" })).allOk);
});
test("縦長の映像(スマホ)でも、ok", () => {
  assert.ok(run("palm", makeHand({ facing: "palm", scale: 0.78, frame: PORTRAIT }), {}, PORTRAIT).allOk);
});
test("ガイド: 手が無い → 「手を、画面に、映してください」。ほかの項目は、後回し", () => {
  const r = run("palm", null);
  assert.equal(r.guide, "手を、画面に、映してください");
  assert.ok(!r.allOk && !r.checks[0].ok);
});
test("ガイド: 遠い / 近い / はみ出し / 中央から外れ / 傾き", () => {
  assert.equal(run("palm", makeHand({ scale: 0.3 })).guide, "もう少し、近づけてください");
  assert.equal(run("palm", makeHand({ scale: 1.3 })).guide, "手が、はみ出しています。画面の中に、入れてください");   // 大きすぎて、はみ出す(はみ出しが、先)
  assert.equal(run("palm", makeHand({ cx: 0.96, scale: 0.7 })).guide, "手が、はみ出しています。画面の中に、入れてください");
  assert.equal(run("palm", makeHand({ cx: 0.22, scale: 0.6 })).guide, "手を、画面の中央に、動かしてください");
  assert.equal(run("palm", makeHand({ tilt: 0.4 })).guide, "手を、カメラに、まっすぐ向けてください(傾いています)");
});
test("ガイド: 指が曲がっている → 指の名前つき。指が閉じている → となり合う指の名前つき", () => {
  assert.equal(run("palm", makeHand({ curl: 1 })).guide, "中指を、まっすぐ、伸ばしてください");
  assert.equal(run("palm", makeHand({ spread: 0 })).guide, "人差し指と中指が、重なっています。少し、離してください");
});
test("ガイド: 暗い / 明るすぎる / 動いている / ぼやけている", () => {
  const h = makeHand();
  assert.equal(run("palm", h, { brightness: 30 }).guide, "暗いです。明るい場所で、撮ってください");
  assert.equal(run("palm", h, { brightness: 250 }).guide, "明るすぎます。光が、強すぎない所で、撮ってください");
  assert.equal(run("palm", h, { motion: 0.05 }).guide, "手を、止めてください");
  assert.equal(run("palm", h, { sharp: 5 }).guide, "ピントが合うまで、止めてください");
  assert.equal(run("palm", h, { brightness: null }).guide, "明るさを、確かめています");
});
test("ガイドの順番: 先に、近さ、次に、向き、…。複数、ダメな時は、いちばん上の、1つだけ", () => {
  const h = makeHand({ scale: 0.3, facing: "back" });   // 遠い + 向きが逆
  assert.equal(run("palm", h, { brightness: 10, motion: 0.1 }).guide, "もう少し、近づけてください");
});

// ---- 指先モード ----
test("指先(5本まとめて): 爪の側(甲)で、指先が、大きく、中央にある手 → ok", () => {
  const h = makeHand({ facing: "back", scale: 1.5, tipsAt: { x: 0.5, y: 0.35 } });
  const r = run("tip5", h);
  assert.ok(r.allOk, JSON.stringify(r.checks.filter((c) => !c.ok)) + JSON.stringify(r.numbers));
});
test("指先: 手のひら側なら「爪が見える側」。遠ければ「近づけて」。中央から外れていれば、「中央に」", () => {
  assert.equal(run("tip5", makeHand({ facing: "palm", scale: 1.5, tipsAt: { x: 0.5, y: 0.35 } })).guide, "爪が見える側(手の甲)を、カメラに、向けてください");
  assert.equal(run("tip5", makeHand({ facing: "back", scale: 0.45, tipsAt: { x: 0.5, y: 0.35 } })).guide, "もう少し、近づけてください");
  const savedTol = T.tipCenterTol;   // 指先は、広がっていて、画面の端まで、はみ出さずに、大きくずらすのが、難しいので、許す幅を、一時的に、せまくして、確かめる
  T.tipCenterTol = 0.12;
  try { assert.equal(run("tip5", makeHand({ facing: "back", scale: 1.0, tipsAt: { x: 0.68, y: 0.35 } })).guide, "指先を、画面の中央に、動かしてください"); } finally { T.tipCenterTol = savedTol; }
  assert.equal(run("tip5", makeHand({ facing: "back", scale: 1.5, tipsAt: { x: 0.5, y: 0.35 } }), { sharp: 3 }).guide, "ピントが合うまで、止めてください");
});
test("指先(1本ずつ): 中央に近い指先が、撮る相手。その指が、大きく、中央にあれば ok。指の名前が、数字に出る", () => {
  const h = makeHand({ facing: "back", scale: 1.5, tipsAt: { x: 0.5, y: 0.35 } });
  const r = run("tip1", h);
  assert.ok(r.numbers.finger && typeof r.numbers.finger === "string");
  assert.ok(Number.isFinite(r.numbers.segMed));
});
test("指先モードの、チェック項目は、手のひら / 甲と、違う(爪の側、指先の大きさ)", () => {
  const ids = checkList("tip5").map((c) => c.id);
  assert.ok(ids.includes("tipsize") && ids.includes("facing") && !ids.includes("open"));
});

// ---- 手の形のガイドと、一致した面積 ----
test("ガイド: 右手の手のひらと、左手の手のひらは、左右が逆。手のひらと甲も、左右が逆。画面の真ん中に、ほぼ収まる", () => {
  const gr = makeGuide(FRAME, { hand: "right", facing: "palm" }), gl = makeGuide(FRAME, { hand: "left", facing: "palm" }), rb = makeGuide(FRAME, { hand: "right", facing: "back" });
  assert.ok(gr.lm[4].x > gr.lm[0].x && gl.lm[4].x < gl.lm[0].x && rb.lm[4].x < rb.lm[0].x, "親指の側");
  const b = bbox(gr.lm);
  assert.ok(near(b.cx, 0.5, 0.01) && near(b.cy, 0.5, 0.01) && b.minY > 0 && b.maxY < 1 && b.minX > 0 && b.maxX < 1);
  assert.ok(gr.sil.area > 500 && gr.sil.gh === Math.round(200 * 720 / 1280));
});
test("ガイドとの一致: ガイドと同じ手は 100%。同じ形の手(makeHand の初期値)も、ほぼ 100%", () => {
  const g = makeGuide(FRAME, { hand: "right", facing: "palm" });
  const m = guideMatch(g.lm, g, FRAME);
  assert.ok(near(m.overlap, 1, 1e-9) && near(m.shape, 1, 1e-9));
  const h = makeHand({ hand: "right", facing: "palm" });
  const m2 = guideMatch(h.lm, g, FRAME);
  assert.ok(m2.overlap > 0.97 && m2.shape > 0.97, JSON.stringify(m2));
});
test("ガイドとの一致: ずらすと『そのまま』は下がり、『形だけ』は変わらない。小さくしても、回しても、『形だけ』は変わらない", () => {
  const g = makeGuide(FRAME, { hand: "right", facing: "palm" });
  const at = (o) => guideMatch(makeHand({ hand: "right", facing: "palm", ...o }).lm, g, FRAME);
  const base = at({}), moved = at({ cx: 0.62 }), moved2 = at({ cx: 0.75 }), small = at({ scale: 0.55 });
  assert.ok(moved.overlap < base.overlap - 0.15 && moved2.overlap < moved.overlap, JSON.stringify([base, moved, moved2]));
  assert.ok(moved.shape > 0.95 && small.shape > 0.95 && small.overlap < 0.6, JSON.stringify([moved, small]));
  // 画面の中で回す(roll): 点を、真ん中のまわりで、30度回す
  const h = makeHand({ hand: "right", facing: "palm" }), c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const rot = h.lm.map((q) => { const x = (q.x - 0.5) * FRAME.w, y = (q.y - 0.5) * FRAME.h; return { x: 0.5 + (c * x - s * y) / FRAME.w, y: 0.5 + (s * x + c * y) / FRAME.h, z: 0 }; });
  const mr = guideMatch(rot, g, FRAME);
  assert.ok(mr.shape > 0.95 && mr.overlap < 0.8, JSON.stringify(mr));
});
test("ガイドとの一致: 手を傾ける(幅が縮む)ほど『形だけ』が下がる。指を閉じる(開きが小さい)と、下がる", () => {
  const g = makeGuide(FRAME, { hand: "right", facing: "palm" });
  const sh = (o) => guideMatch(makeHand({ hand: "right", facing: "palm", ...o }).lm, g, FRAME).shape;
  assert.ok(sh({ tilt: 1 }) > sh({ tilt: 0.85 }) && sh({ tilt: 0.85 }) > sh({ tilt: 0.6 }), [sh({ tilt: 1 }), sh({ tilt: 0.85 }), sh({ tilt: 0.6 })].join());
  assert.ok(sh({ spread: 12 }) > sh({ spread: 2 }), [sh({ spread: 12 }), sh({ spread: 2 })].join());
});
test("ガイドとの一致: 手の甲のガイドに、手のひらの手を重ねると、親指の側が逆で、下がる。点が足りない時は null", () => {
  const gb = makeGuide(FRAME, { hand: "right", facing: "back" });
  const same = guideMatch(makeHand({ hand: "right", facing: "back" }).lm, gb, FRAME), other = guideMatch(makeHand({ hand: "right", facing: "palm" }).lm, gb, FRAME);
  assert.ok(same.shape > 0.97 && other.overlap < same.overlap - 0.1, JSON.stringify([same, other]));
  assert.equal(guideMatch(null, gb, FRAME), null);
  assert.equal(maskIoU(null, gb.sil), null);
});

test("ガイドに重なっている: 一致(そのまま)が 55% 未満だと、条件が、そろわない。ガイドの文が、出る。55% 以上で、そろう。渡さない時(試験など)は、判定しない。指先モードには、無い", () => {
  const hand = makeHand({ hand: "right", facing: "palm" });
  const at = (o) => run("palm", hand, o);
  const low = at({ guideOverlap: 0.21 });
  assert.ok(!low.allOk && low.checks.find((c) => c.id === "guide").ok === false && low.guide === "手を、ガイドの形に、重ねてください" && low.numbers.guideOverlap === 21, low.guide);
  const edge = at({ guideOverlap: T.guideOverlap }), high = at({ guideOverlap: 0.9 }), none = at({});
  assert.ok(edge.allOk && high.allOk && none.allOk && none.numbers.guideOverlap === undefined);
  assert.ok(checkList("palm").some((c) => c.id === "guide") && checkList("back").some((c) => c.id === "guide") && !checkList("tip5").some((c) => c.id === "guide") && !checkList("tip1").some((c) => c.id === "guide"));
  assert.ok(!run("tip5", makeHand({ hand: "right", facing: "back", scale: 0.8 }), { guideOverlap: 0.1 }).checks.some((c) => c.id === "guide"));
});
test("ガイドに重なっている: ほかの条件が先。近さが、足りなければ、近さの文が、出る(ガイドの文は、その後)", () => {
  const far = run("palm", makeHand({ hand: "right", facing: "palm", scale: 0.3 }), { guideOverlap: 0.1 });
  assert.equal(far.guide, "もう少し、近づけてください");
});

// ---- 続ける時間 ----
test("止まっている時間: 崩れたら、数え直し。holdMs 続けば、撮る", () => {
  let s = { since: null };
  let r = holdProgress(s, true, 1000); assert.equal(r.progress, 0); assert.ok(!r.ready);
  r = holdProgress(r, true, 1500); assert.ok(r.progress > 0.49 && r.progress < 0.51 && !r.ready);
  r = holdProgress(r, false, 1600); assert.equal(r.since, null); assert.equal(r.progress, 0);
  r = holdProgress(r, true, 2000);
  r = holdProgress(r, true, 2000 + T.holdMs); assert.ok(r.ready && r.progress === 1);
});

console.log(failures.length === 0 ? "\nguide_test: すべて通りました" : "\nguide_test: 失敗 " + failures.length + " 件: " + failures.join(" / "));
process.exit(failures.length === 0 ? 0 : 1);
