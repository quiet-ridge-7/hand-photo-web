// guide_test.mjs — guide.mjs(手の撮影の、判定とガイド)の、試験。人工の手の点(21個)を、プログラムで作って、確かめる。
//   実行: node guide_test.mjs
//   本物の手では、ありません。手のひら / 甲の判定の向きは、実機で、確かめた(逆に出たので、RAW_FRAME を false にした)。
import assert from "node:assert/strict";
import { T, LM, bbox, insideFrame, handSize, centerOffset, facingOf, flatness, fingerShape, motionScore, pointsOf,
  meanLuma, toGray, sharpness, makeGuide, guideMatch, silhouetteMask, maskIoU, alignHand, patchCenters, combineMeasures, fingertipRects, nailCropMatrix, NAIL_BOX, checkList, evaluate, holdProgress, STEPS, nextStep, stepHelp, stepFileName } from "./guide.mjs";
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
test("測る場所: 手の中心と、指の関節のまわり(6か所)。手が無ければ、画面の中心", () => {
  const h = makeHand({ facing: "palm" }).lm;
  const pc = patchCenters(h, "palm");
  assert.equal(pc.length, 6);
  const b = bbox(h);
  assert.ok(pc.every((p) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY), "手の枠の外に、ある");
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
  assert.equal(run("palm", makeHand({ cx: 0.22, scale: 0.75 })).guide, "手を、画面の中央に、動かしてください");
  assert.equal(run("palm", makeHand({ scale: 0.6 })).guide, "もう少し、近づけてください");   // 手の大きさ 0.60 は、下限 0.65 より、小さい
  assert.equal(run("palm", makeHand({ scale: 0.68 })).guide, "そのまま、止めてください");   // 0.68 は、通る
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

test("ガイドに重なっている: 一致(そのまま)が 50% 未満だと、条件が、そろわない。ガイドの文が、出る。50% 以上で、そろう。渡さない時(試験など)は、判定しない", () => {
  const hand = makeHand({ hand: "right", facing: "palm" });
  const at = (o) => run("palm", hand, o);
  const low = at({ guideOverlap: 0.21 });
  assert.ok(!low.allOk && low.checks.find((c) => c.id === "guide").ok === false && low.guide === "手を、ガイドの形に、重ねてください" && low.numbers.guideOverlap === 21, low.guide);
  const edge = at({ guideOverlap: T.guideOverlap }), high = at({ guideOverlap: 0.9 }), none = at({});
  assert.ok(edge.allOk && high.allOk && none.allOk && none.numbers.guideOverlap === undefined);
  assert.ok(checkList("palm").some((c) => c.id === "guide") && checkList("back").some((c) => c.id === "guide"));
  assert.equal(checkList("palm", "right").length, checkList("palm").length + 1);
});
test("ガイドに重なっている: 順番は、指の重なりの後、明るさの前。近さが先(近さの文が、先に出る)。撮る手の確認は、もっと先", () => {
  const ids = checkList("palm", "right").map((c) => c.id);
  assert.ok(ids.indexOf("guide") === ids.indexOf("open") + 1 && ids.indexOf("guide") < ids.indexOf("bright") && ids.indexOf("side") < ids.indexOf("size") && ids.indexOf("size") < ids.indexOf("guide"));
  const far = run("palm", makeHand({ hand: "right", facing: "palm", scale: 0.3 }), { guideOverlap: 0.1 });
  assert.equal(far.guide, "もう少し、近づけてください");
  const side = run("palm", makeHand({ hand: "left", facing: "palm" }), { guideOverlap: 0.1, wantHand: "right" });
  assert.equal(side.guide, "右手を、映してください(いまは、左手です)");
});
test("ガイドとの一致: withShape を false にすると、形だけ(shape)は、計算しない。そのまま(overlap)は、同じ", () => {
  const g = makeGuide(FRAME, { hand: "right", facing: "palm" }), h = makeHand({ hand: "right", facing: "palm", cx: 0.6 });
  const full = guideMatch(h.lm, g, FRAME), light = guideMatch(h.lm, g, FRAME, false);
  assert.equal(light.shape, null);
  assert.equal(light.overlap, full.overlap);
  assert.ok(full.shape != null);
});

// ---- 右手・左手に分けた、撮る順番 ----
test("撮る順番: 左手のひら → 左手の甲 → 右手のひら → 右手の甲。手の左右・モードが、合っている", () => {
  assert.deepEqual(STEPS.map((s) => s.id), ["left-palm", "left-back", "right-palm", "right-back"]);
  assert.deepEqual(STEPS.map((s) => s.hand + "/" + s.mode), ["left/palm", "left/back", "right/palm", "right/back"]);
});
test("次に撮る物: 先頭から。撮れた物は、飛ばす。一周して、戻る。全部、撮れたら -1", () => {
  assert.equal(nextStep([false, false, false, false], -1), 0);
  assert.equal(nextStep([true, false, false, false], 0), 1);
  assert.equal(nextStep([true, true, true, false], 2), 3);
  assert.equal(nextStep([false, true, true, true], 3), 0);   // 一周して、戻る
  assert.equal(nextStep([true, false, true, true], 3), 1);
  assert.equal(nextStep([true, true, true, true], 3), -1);
  assert.equal(nextStep([true, false, false, false], 3), 1);
  assert.equal(nextStep([false, true, false, false], 1), 2);
});
test("説明の文と、ファイル名", () => {
  assert.equal(stepHelp(STEPS[2]), "右手の、手のひら側を、カメラに向けて、指を開きます。");
  assert.equal(stepHelp(STEPS[1]), "左手の、手の甲側を、カメラに向けて、指を開きます。");
  assert.equal(stepFileName(STEPS[3], new Date(2026, 10, 21, 9, 5, 7)), "hand_right_back_20261121_090507.jpg");
  assert.equal(stepFileName(STEPS[0], new Date(2026, 10, 21, 15, 0, 0)), "hand_left_palm_20261121_150000.jpg");
});
test("撮る手の確認: 右手を撮る時に、左手が映ると『右手を、映してください(いまは、左手です)』。手のひらか甲かの文より、先", () => {
  const left = makeHand({ hand: "left", facing: "back" });   // 左手の甲 を、右手のひらの番で
  const r = run("palm", left, { wantHand: "right" });
  assert.ok(!r.allOk && r.checks.find((c) => c.id === "side").ok === false && r.guide === "右手を、映してください(いまは、左手です)", r.guide);
  const l2 = run("palm", makeHand({ hand: "left", facing: "palm" }), { wantHand: "left" });
  assert.ok(l2.allOk && l2.checks.find((c) => c.id === "side").label === "左手");
  assert.ok(run("back", makeHand({ hand: "right", facing: "back" }), { wantHand: "right" }).allOk);
  assert.ok(run("back", makeHand({ hand: "left", facing: "back" }), { wantHand: "right" }).guide.startsWith("右手を"));
});
test("撮る手の確認: 指定しなければ、チェック項目は、増えない。指定すると、1つ増える", () => {
  assert.ok(!checkList("palm").some((c) => c.id === "side") && checkList("palm", "right").some((c) => c.id === "side") && checkList("back", "left").some((c) => c.id === "side"));
  assert.equal(checkList("palm", "right").length, checkList("palm").length + 1);
});

// ---- 爪(指先)の四角 ----
test("爪の四角: 5本分。縦は、第1関節〜指先の 1.5625 倍、横は、1.25 倍(上と横を、1.25倍にした)。四角は、長方形(直角)。指先の少し先まで。下の辺は、第1関節", () => {
  const h = makeHand({ hand: "right", facing: "back" }), r = fingertipRects(h.lm, FRAME);
  assert.equal(r.length, 5);
  assert.ok(near(NAIL_BOX.lengthK, 1.25 * 1.25, 1e-9) && near(NAIL_BOX.widthK, 1.25, 1e-9));
  assert.deepEqual(r.map((n) => n.name), ["親指", "人差し指", "中指", "薬指", "小指"]);
  const P = (i) => ({ x: h.lm[i].x * FRAME.w, y: h.lm[i].y * FRAME.h });
  const dips = [3, 7, 11, 15, 19], tips = [4, 8, 12, 16, 20];
  r.forEach((n, k) => {
    const L0 = Math.hypot(P(tips[k]).x - P(dips[k]).x, P(tips[k]).y - P(dips[k]).y);
    assert.ok(near(n.h, L0 * NAIL_BOX.lengthK, 1e-6) && near(n.w, L0 * NAIL_BOX.widthK, 1e-6), n.name);
    const [a, b, c, d] = n.corners, ab = { x: b.x - a.x, y: b.y - a.y }, ad = { x: d.x - a.x, y: d.y - a.y };
    assert.ok(near(Math.hypot(ab.x, ab.y), n.w, 1e-6) && near(Math.hypot(ad.x, ad.y), n.h, 1e-6) && near(ab.x * ad.x + ab.y * ad.y, 0, 1e-6), "長方形");
    // 指先(tip)は、四角の中。 第1関節(dip)は、四角の、手前の辺の、真ん中
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    assert.ok(near(mid.x, P(dips[k]).x, 1e-6) && near(mid.y, P(dips[k]).y, 1e-6));
    const along = ((P(tips[k]).x - a.x) * ad.x + (P(tips[k]).y - a.y) * ad.y) / (n.h * n.h);
    assert.ok(near(along, 1 / NAIL_BOX.lengthK, 1e-6), "指先は、縦の 0.64 の所");
  });
});
test("爪の四角: 指の向きに合わせて、回る(upAngle)。手を、画面の中で回すと、upAngle が、同じだけ、変わる。大きさは、変わらない", () => {
  const h = makeHand({ hand: "right", facing: "back" });
  const rot = (lm, deg) => { const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180); return lm.map((q) => { const x = (q.x - 0.5) * FRAME.w, y = (q.y - 0.5) * FRAME.h; return { x: 0.5 + (c * x - s * y) / FRAME.w, y: 0.5 + (s * x + c * y) / FRAME.h, z: 0 }; }); };
  const a = fingertipRects(h.lm, FRAME), b = fingertipRects(rot(h.lm, 30), FRAME);
  a.forEach((n, k) => {
    let d = b[k].upAngle - n.upAngle; d = ((d + 540) % 360) - 180;
    assert.ok(near(d, 30, 0.01), n.name + " " + d);
    assert.ok(near(b[k].w, n.w, 1e-6) && near(b[k].h, n.h, 1e-6));
  });
  // 指が、真上を向く手: 中指の upAngle は、ほぼ 0(わずかな傾きは、ある)
  assert.ok(Math.abs(a[2].upAngle) < 10, String(a[2].upAngle));
  // 右手の甲(親指が、画面の左): 人差し指は、中指より、左へ傾き(小さい角度)、小指は、右へ傾く(大きい角度)。 指が、扇のように、開いている
  assert.ok(a[1].upAngle < a[2].upAngle && a[2].upAngle < a[3].upAngle && a[3].upAngle < a[4].upAngle, a.map((n) => Math.round(n.upAngle)).join());
  assert.equal(fingertipRects(null, FRAME), null);
  assert.equal(fingertipRects(h.lm.slice(0, 10), FRAME), null);
});

test("爪の切り出し: 変換の行列で、四角の4つの角が、切り出した写真の4つの角になる。指先の側が、上。指の向きが、どれだけ傾いていても、同じ", () => {
  const apply = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
  const h = makeHand({ hand: "right", facing: "back" });
  const rot = (lm, deg) => { const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180); return lm.map((q) => { const x = (q.x - 0.5) * FRAME.w, y = (q.y - 0.5) * FRAME.h; return { x: 0.5 + (c * x - s * y) / FRAME.w, y: 0.5 + (s * x + c * y) / FRAME.h, z: 0 }; }); };
  for (const deg of [0, 25, 90, 160, -70]) {
    const rects = fingertipRects(rot(h.lm, deg), FRAME);
    rects.forEach((r) => {
      const m = nailCropMatrix(r), [c0, c1, c2, c3] = r.corners.map((p) => apply(m, p));
      const tol = 1.0;   // 大きさは、画素に、丸める
      assert.ok(near(c0.x, 0, tol) && near(c0.y, m.H, tol) && near(c1.x, m.W, tol) && near(c1.y, m.H, tol) && near(c2.x, m.W, tol) && near(c2.y, 0, tol) && near(c3.x, 0, tol) && near(c3.y, 0, tol), r.name + " " + deg + " " + JSON.stringify([c0, c1, c2, c3]));
      const mid = apply(m, r.center);
      assert.ok(near(mid.x, m.W / 2, 1e-6) && near(mid.y, m.H / 2, 1e-6));
      const tip = apply(m, { x: r.center.x + r.u.x * r.h / 2, y: r.center.y + r.u.y * r.h / 2 });   // 指の向きの、先
      assert.ok(near(tip.x, m.W / 2, 1e-6) && tip.y <= 0.6 && tip.y < mid.y, "指先の側が、上(丸めの差は、半画素まで)");
    });
  }
  assert.ok(nailCropMatrix({ w: 1, h: 1, u: { x: 0, y: -1 }, v: { x: 1, y: 0 }, center: { x: 5, y: 5 } }).W >= 8, "小さすぎる四角は、8画素に");
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
