// guide_test.mjs — guide.mjs(手の撮影の、判定とガイド)の、試験。人工の手の点(21個)を、プログラムで作って、確かめる。
//   実行: node guide_test.mjs
//   本物の手では、ありません。手のひら / 甲の判定の向きは、実機で、確かめた(逆に出たので、RAW_FRAME を false にした)。
import assert from "node:assert/strict";
import { T, LM, bbox, insideFrame, handSize, centerOffset, facingOf, flatness, fingerShape, tipSegments, motionScore, pointsOf,
  meanLuma, toGray, sharpness, palmAngles, eigenSym3, handFrame, framePose, smoothFrame, normalArrow, PALM_POINTS, ALL_POINTS, POINTS16, POINTS11, POINTS8, DIP_POINTS, depthRelative, depthColor, depthText, convexHull, outlineShape, handStrokes, maskStats, makeGuide, guideMatch, silhouetteMask, maskIoU, alignHand, patchCenters, combineMeasures, checkList, evaluate, holdProgress } from "./guide.mjs";
import { FRAME, PORTRAIT, makeHand, makeWorld } from "./test_hands.mjs";

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

// ---- 手の面の、角度(pan / tilt) ----
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
test("角度: まっすぐ(0, 0)は、0度。pan 20度は、pan だけ 20度(符号は、逆でも、大きさが合う)。tilt 15度は、tilt だけ", () => {
  const f = palmAngles(makeWorld({ pan: 0, tilt: 0 }));
  assert.ok(near(f.pan, 0) && near(f.tilt, 0) && near(f.angle, 0), JSON.stringify(f));
  const p = palmAngles(makeWorld({ pan: 20 }));
  assert.ok(near(Math.abs(p.pan), 20) && near(p.tilt, 0) && near(p.angle, 20), JSON.stringify(p));
  const t = palmAngles(makeWorld({ tilt: 15 }));
  assert.ok(near(t.pan, 0) && near(Math.abs(t.tilt), 15) && near(t.angle, 15), JSON.stringify(t));
});
test("角度: 左右に、逆向きにひねると、符号が、逆。右手でも左手でも、手のひらでも甲でも、大きさは、同じ", () => {
  assert.ok(near(palmAngles(makeWorld({ pan: 25 })).pan, -palmAngles(makeWorld({ pan: -25 })).pan, 0.01));
  assert.ok(near(palmAngles(makeWorld({ tilt: 25 })).tilt, -palmAngles(makeWorld({ tilt: -25 })).tilt, 0.01));
  for (const hand of ["right", "left"]) for (const facing of ["palm", "back"]) {
    const r = palmAngles(makeWorld({ hand, facing, pan: 18, tilt: 9 }));
    assert.ok(near(r.angle, Math.acos(Math.cos((18 * Math.PI) / 180) * Math.cos((9 * Math.PI) / 180)) * (180 / Math.PI), 0.6), hand + facing + JSON.stringify(r));
  }
});
test("角度: 点が足りない・向きが決まらない時は null", () => {
  assert.equal(palmAngles(null), null);
  assert.equal(palmAngles([]), null);
  const flat = makeWorld({}).map(() => ({ x: 0, y: 0, z: 0 }));
  assert.equal(palmAngles(flat), null);
});
test("角度は、まだ、判定には、使わない: 数字(pan / tilt / angle)に、出るだけ。傾けても、ガイドは、変わらない", () => {
  const hand = makeHand({ facing: "palm" });
  const straight = evaluate({ mode: "palm", landmarks: hand.lm, label: hand.label, frame: FRAME, ...good, world: makeWorld({ pan: 0, tilt: 0 }) });
  const tilted = evaluate({ mode: "palm", landmarks: hand.lm, label: hand.label, frame: FRAME, ...good, world: makeWorld({ pan: 35, tilt: 25 }) });
  assert.equal(straight.allOk, tilted.allOk);
  assert.equal(straight.guide, tilted.guide);
  assert.ok(tilted.numbers.pan !== undefined && tilted.numbers.tilt !== undefined && tilted.numbers.roll !== undefined && tilted.numbers.rms !== undefined && tilted.numbers.angle > 20, JSON.stringify(tilted.numbers));
  assert.ok(tilted.numbers.pan3 !== undefined && tilted.numbers.tilt3 !== undefined && tilted.numbers.angle3 !== undefined, "3点の数字も、比べるために、出る");
  const none = evaluate({ mode: "palm", landmarks: hand.lm, label: hand.label, frame: FRAME, ...good });
  assert.equal(none.numbers.pan, undefined, "3次元の点が、無い時は、数字も、出さない");
});

// ---- 手の向き(pan / tilt / roll): 手の点すべてから ----
test("固有値: 対角行列と、回した行列で、固有値が、合う。ベクトルは、長さ 1 で、直交", () => {
  const e = eigenSym3([[4, 0, 0], [0, 1, 0], [0, 0, 2]]);
  assert.deepEqual([...e.values].sort((a, b) => a - b), [1, 2, 4]);
  const r = eigenSym3([[2, 1, 0], [1, 2, 0], [0, 0, 5]]);   // 固有値 1, 3, 5
  assert.ok([...r.values].sort((a, b) => a - b).every((v, i) => near(v, [1, 3, 5][i], 1e-9)));
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  assert.ok(r.vectors.every((v) => near(dot(v, v), 1, 1e-9)) && near(dot(r.vectors[0], r.vectors[1]), 0, 1e-9) && near(dot(r.vectors[0], r.vectors[2]), 0, 1e-9));
});
const poseOf = (w) => framePose(handFrame(w));
test("向き: まっすぐ(0, 0, 0)は、全部 0度。右手・左手、手のひら・甲、どれでも", () => {
  for (const hand of ["right", "left"]) for (const facing of ["palm", "back"]) {
    const p = poseOf(makeWorld({ hand, facing }));
    assert.ok(near(p.pan, 0) && near(p.tilt, 0) && Math.abs(p.roll) < 10 && near(p.angle, 0) && p.rms < 0.5, hand + facing + JSON.stringify(p));   // roll は、人工の手の形(中指の付け根が、手首の真上から、少し、ずれている)の、元のずれを、含む
  }
});
test("向き: pan・tilt・roll を、1つずつ、回すと、その角度だけが、出る(符号つき)", () => {
  const r0 = poseOf(makeWorld({})).roll;   // 人工の手の形の、元の roll(わずかな、ずれ)
  for (const v of [30, -30]) {
    const p = poseOf(makeWorld({ pan: v })); assert.ok(near(p.pan, v) && near(p.tilt, 0) && near(p.roll, r0), "pan " + v + JSON.stringify(p));
    const q = poseOf(makeWorld({ tilt: v })); assert.ok(near(q.pan, 0) && near(q.tilt, v) && near(q.roll, r0), "tilt " + v + JSON.stringify(q));
    const r = poseOf(makeWorld({ roll: v })); assert.ok(near(r.pan, 0) && near(r.tilt, 0) && near(r.roll, v + r0) && near(r.angle, 0), "roll " + v + JSON.stringify(r));
  }
});
test("向き: 3つを、同時に、回しても、それぞれの角度が、戻ってくる(右手・左手、手のひら・甲)", () => {
  for (const hand of ["right", "left"]) for (const facing of ["palm", "back"]) {
    const r0 = poseOf(makeWorld({ hand, facing })).roll;   // その手の形の、元の roll
    const p = poseOf(makeWorld({ hand, facing, pan: 20, tilt: -15, roll: 35 }));
    assert.ok(near(p.pan, 20, 0.6) && near(p.tilt, -15, 0.6) && near(p.roll, 35 + r0, 0.6), hand + facing + JSON.stringify(p));
  }
});
test("向き: roll(画面の中で回す)は、angle(カメラからの、ずれ)を、変えない", () => {
  assert.ok(near(poseOf(makeWorld({ pan: 20, roll: 0 })).angle, poseOf(makeWorld({ pan: 20, roll: 50 })).angle, 0.3));
});
test("向き: 1点の偏りに強い。小指の付け根だけ、奥に 2cm ずれていても、3点の面より、16点の向きの方が、ずれが小さい", () => {
  const w = makeWorld({});
  w[17] = { ...w[17], z: w[17].z + 0.02 };
  const three = palmAngles(w), all = poseOf(w);
  assert.ok(Math.abs(three.pan) > Math.abs(all.pan) * 1.2, JSON.stringify({ three, all }));   // 16点は、3点より、ずれが小さい
});
test("ゆれをならす: ノイズのある向きを、5コマ平均すると、平均の誤差が、小さくなる。軸は、直交で、長さ 1", () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const truth = { pan: 15, tilt: 10, roll: -20 + poseOf(makeWorld({})).roll };   // 元の、わずかな roll を、含む
  const base = makeWorld(truth);
  const noisy = () => base.map((q) => ({ x: q.x + rnd() * 0.012, y: q.y + rnd() * 0.012, z: q.z + rnd() * 0.03 }));
  let rawErr = 0, smoothErr = 0, n = 0;
  for (let trial = 0; trial < 40; trial++) {
    const frames = Array.from({ length: 5 }, () => handFrame(noisy()));
    const raw = framePose(frames[4]), sm = framePose(smoothFrame(frames));
    const e = (p) => Math.abs(p.pan - truth.pan) + Math.abs(p.tilt - truth.tilt) + Math.abs(p.roll - truth.roll);
    rawErr += e(raw); smoothErr += e(sm); n++;
  }
  assert.ok(smoothErr / n < rawErr / n, "ならした方が、誤差が、大きい: " + smoothErr / n + " / " + rawErr / n);
  const f = smoothFrame([handFrame(base), handFrame(makeWorld({ pan: 17, tilt: 8, roll: -18 }))]);
  const d = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  assert.ok(near(d(f.ex, f.ex), 1, 1e-9) && near(d(f.ey, f.ey), 1, 1e-9) && near(d(f.ez, f.ez), 1, 1e-9) && near(d(f.ex, f.ey), 0, 1e-9) && near(d(f.ey, f.ez), 0, 1e-9));
  assert.equal(smoothFrame([]), null);
  assert.equal(smoothFrame([null]), null);
});
test("向き: 点が足りない・全部同じ位置なら null", () => {
  assert.equal(handFrame(null), null);
  assert.equal(handFrame([]), null);
  assert.equal(handFrame(makeWorld({}).map(() => ({ x: 0, y: 0, z: 0 }))), null);
  assert.equal(framePose(null), null);
});

// ---- 奥行き(平均を 0 に)と、色 ----
test("奥行き: 8点の、平均を引くので、8点の合計が 0。ほかの13点は null。向きを変えても、平均が 0。点が足りなければ null", () => {
  for (const o of [{}, { pan: 25 }, { tilt: -20 }, { pan: 15, tilt: 10, roll: 30 }]) {
    const d = depthRelative(makeWorld(o));
    assert.equal(d.length, 21);
    assert.ok([3, 4, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20].every((i) => d[i] === null), "8点以外は、null");
    assert.equal(d.filter((v) => v !== null).length, 8);
    assert.ok(Math.abs(d.filter((v) => v !== null).reduce((s, v) => s + v, 0)) < 1e-12, JSON.stringify(o));
  }
  const biased = makeWorld({}).map((q, i) => ([3, 4, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20].includes(i) ? { ...q, z: q.z - 0.05 } : q));
  assert.ok(depthRelative(biased).every((v) => v === null || Math.abs(v) < 1e-12), "8点以外が、どんなに、ずれても、8点の平均や、色は、変わらない");
  assert.equal(depthRelative(null), null);
  assert.equal(depthRelative([]), null);
  assert.equal(depthRelative(makeWorld({}).map((q, i) => (i === 2 ? { x: 0, y: 0, z: NaN } : q))), null);   // 8点の中の点(2番)が、壊れていれば、null
  assert.ok(depthRelative(makeWorld({}).map((q, i) => (i === 4 || i === 7 || i === 17 ? { x: 0, y: 0, z: NaN } : q))) !== null, "指先(4番)・第1関節(7番)・小指の付け根(17番)が、壊れていても、8点には、関係ない");
});
test("奥行き: 平らな手を、まっすぐ向けると、全部 0。pan で、ひねると、片側が近く、反対側が遠い", () => {
  assert.ok(depthRelative(makeWorld({})).every((v) => Math.abs(v) < 1e-12));
  const w = makeWorld({ pan: 30 }), d = depthRelative(w);
  const xs = POINTS8.map((i) => w[i].x);   // 色を付ける 8点の中で、いちばん左と、いちばん右の点
  const left = POINTS8[xs.indexOf(Math.min(...xs))], right = POINTS8[xs.indexOf(Math.max(...xs))];
  assert.ok(d[left] * d[right] < 0 && Math.abs(d[left]) > 0.01 && Math.abs(d[right]) > 0.01, JSON.stringify({ l: d[left], r: d[right] }));
});
test("奥行きの色: 平均(0)は、白っぽい灰色。近い(-3cm)は、赤。遠い(+3cm)は、青。±3cm を超えても、それ以上は、濃くならない。真ん中は、中間", () => {
  assert.deepEqual(depthColor(0), [235, 235, 235]);
  assert.deepEqual(depthColor(-0.03), [255, 50, 50]);
  assert.deepEqual(depthColor(0.03), [50, 110, 255]);
  assert.deepEqual(depthColor(-0.2), depthColor(-0.03));
  assert.deepEqual(depthColor(0.2), depthColor(0.03));
  const half = depthColor(-0.015);
  assert.ok(half[0] > 235 - 1 && half[1] > 50 && half[1] < 235 && half[2] > 50 && half[2] < 235, JSON.stringify(half));
});
test("奥行きの文字: 21個を、手首 | 親指 | 人差し指 | 中指 | 薬指 | 小指 の順に、mm で出す。確認用の数字に、depthMm として、出る", () => {
  const txt = depthText(makeWorld({ pan: 30 }));
  assert.equal(txt.split("|").length, 6);
  const tokens = txt.replace(/\|/g, " ").trim().split(/\s+/);
  assert.equal(tokens.length, 21);
  assert.equal(tokens.filter((v) => v === "x").length, 13, "色を付けない13点は、x");
  assert.equal(depthText(null), null);
  const hand = makeHand({ facing: "palm" });
  const r = evaluate({ mode: "palm", landmarks: hand.lm, label: hand.label, frame: FRAME, ...good, world: makeWorld({ pan: 30 }) });
  assert.equal(r.numbers.depthMm, txt);
  assert.equal(evaluate({ mode: "palm", landmarks: hand.lm, label: hand.label, frame: FRAME, ...good }).numbers.depthMm, undefined);
});

// ---- 指先の奥行きの偏りに強い(手のひらの点だけで、面を出す) ----
test("指先の5点が、いつも手前(-3cm)に推定されても、指先を除いた 16点の面は、ずれない。21点すべての面は、前に倒れて見える", () => {
  const w = makeWorld({});
  const biased = w.map((q, i) => ([4, 8, 12, 16, 20].includes(i) ? { ...q, z: q.z - 0.03 } : q));   // 指先だけ、手前に、3cm
  const p16 = framePose(handFrame(biased)), palm = framePose(handFrame(biased, PALM_POINTS)), all = framePose(handFrame(biased, ALL_POINTS));
  assert.ok(Math.abs(p16.tilt) < 0.5 && Math.abs(p16.pan) < 0.5, JSON.stringify(p16));
  const p11 = framePose(handFrame(biased, POINTS11));
  assert.ok(Math.abs(p11.tilt) < 0.5 && Math.abs(p11.pan) < 0.5, JSON.stringify(p11));
  assert.ok(Math.abs(palm.tilt) < 0.5 && Math.abs(palm.pan) < 0.5, JSON.stringify(palm));
  assert.ok(Math.abs(all.tilt) > 5, "21点の面は、偏りに、引きずられる: " + JSON.stringify(all));
  assert.deepEqual(PALM_POINTS, [0, 1, 5, 9, 13, 17]);
  assert.equal(ALL_POINTS.length, 21);
  assert.equal(POINTS16.length, 16);
  assert.deepEqual(POINTS11, [0, 1, 2, 5, 6, 9, 10, 13, 14, 17, 18]);
  assert.deepEqual(DIP_POINTS, [3, 7, 11, 15, 19]);
  assert.ok(POINTS11.every((i) => POINTS16.includes(i)) && DIP_POINTS.every((i) => !POINTS11.includes(i)));
  assert.deepEqual(POINTS8, [0, 1, 2, 5, 6, 9, 10, 13]);
  assert.ok(POINTS8.every((i) => POINTS11.includes(i)) && ![14, 17, 18].some((i) => POINTS8.includes(i)));
  assert.ok([4, 8, 12, 16, 20].every((i) => !POINTS16.includes(i)) && POINTS16.includes(0) && POINTS16.includes(19));
});
test("指の関節・指先も、全部、手前に偏っていても(指を、反らせた時のように)、手のひらの6点の面は、そのまま。roll は、変わらない", () => {
  const w = makeWorld({ pan: 20, tilt: -10, roll: 15 });
  const fingers = [3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20];
  const biased = w.map((q, i) => (fingers.includes(i) ? { ...q, z: q.z - 0.02 } : q));
  const a = framePose(handFrame(w, PALM_POINTS)), b = framePose(handFrame(biased, PALM_POINTS));   // 手のひらの6点なら、指の偏りは、無関係
  assert.ok(Math.abs(a.pan - b.pan) < 0.5 && Math.abs(a.tilt - b.tilt) < 0.5 && Math.abs(a.roll - b.roll) < 0.5, JSON.stringify({ a, b }));
});

test("指先と、指先に近い関節(第1関節)の10点が、手前に偏っていても、11点・8点の面は、ずれない。16点の面は、少し、ずれる", () => {
  const w = makeWorld({});
  const bad = [3, 4, 7, 8, 11, 12, 15, 16, 19, 20];
  const biased = w.map((q, i) => (bad.includes(i) ? { ...q, z: q.z - 0.03 } : q));
  const p11 = framePose(handFrame(biased, POINTS11)), p8 = framePose(handFrame(biased)), p16 = framePose(handFrame(biased, POINTS16));
  assert.ok(Math.abs(p11.tilt) < 0.5 && Math.abs(p11.pan) < 0.5, JSON.stringify(p11));
  assert.ok(Math.abs(p8.tilt) < 0.5 && Math.abs(p8.pan) < 0.5, JSON.stringify(p8));
  assert.ok(Math.abs(p16.tilt) > 2, "16点の面は、第1関節の偏りに、引きずられる: " + JSON.stringify(p16));
});

test("小指の2点(17、18)と、薬指の第2関節(14)が、大きく、ずれていても、8点の面と、指の向き(roll)は、ずれない", () => {
  const w = makeWorld({ pan: 10, tilt: 5, roll: 20 });
  const bad = [14, 17, 18];
  const biased = w.map((q, i) => (bad.includes(i) ? { x: q.x + 0.03, y: q.y - 0.02, z: q.z - 0.05 } : q));
  const a = framePose(handFrame(w)), b = framePose(handFrame(biased));
  assert.ok(Math.abs(a.pan - b.pan) < 0.5 && Math.abs(a.tilt - b.tilt) < 0.5 && Math.abs(a.roll - b.roll) < 0.5, JSON.stringify({ a, b }));
  const c = framePose(handFrame(biased, POINTS11));
  assert.ok(Math.abs(a.tilt - c.tilt) > 1 || Math.abs(a.pan - c.pan) > 1 || Math.abs(a.roll - c.roll) > 1, "11点の面は、ずれた点に、引きずられる: " + JSON.stringify(c));
});

// ---- 法線の矢印 ----
test("法線の矢印: まっすぐは、ほぼ点(長さ 0)。pan +30度は、右へ。pan -30度は、左へ。tilt +30度(指先が、手前)は、下へ。長さは、短い辺 × 0.5 × sin(30度)", () => {
  const hand = makeHand({ facing: "palm" });
  const arrowOf = (opts) => normalArrow(hand.lm, handFrame(makeWorld({ facing: "palm", ...opts })), FRAME);
  const straight = arrowOf({});
  assert.ok(straight.length < 0.5, String(straight.length));
  const right = arrowOf({ pan: 30 }), left = arrowOf({ pan: -30 });
  const L = Math.min(FRAME.w, FRAME.h) * 0.5;
  assert.ok(right.to.x > right.from.x && near(right.to.y, right.from.y, 0.5) && near(right.length, L * Math.sin((30 * Math.PI) / 180), 0.5), JSON.stringify(right));
  assert.ok(left.to.x < left.from.x && near(left.length, right.length, 0.5));
  const down = arrowOf({ tilt: 30 }), up = arrowOf({ tilt: -30 });
  assert.ok(down.to.y > down.from.y && near(down.to.x, down.from.x, 0.5) && up.to.y < up.from.y, JSON.stringify(down));
  assert.ok(near(arrowOf({ roll: 40 }).length, 0, 0.5), "roll(画面の中で回す)では、矢印は、伸びない");
});
test("法線の矢印: 始点は、面の計算に使う 8点の中心。手や軸が、無ければ null", () => {
  const hand = makeHand({});
  const a = normalArrow(hand.lm, handFrame(makeWorld({})), FRAME);
  const idx = POINTS8;
  assert.ok(near(a.from.x, (idx.reduce((s, i) => s + hand.lm[i].x, 0) / idx.length) * FRAME.w, 0.01) && near(a.from.y, (idx.reduce((s, i) => s + hand.lm[i].y, 0) / idx.length) * FRAME.h, 0.01));
  assert.equal(normalArrow(null, handFrame(makeWorld({})), FRAME), null);
  assert.equal(normalArrow(hand.lm, null, FRAME), null);
});

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

// ---- 輪郭 ----
// 3次元の手を、真正面から見た、2次元の点にする(わかりやすく、x, y だけ。単位は 画面の短い辺 = 0.35m)
const flat2d = (w) => w.map((q) => ({ x: 0.5 + q.x / 0.35 * (FRAME.h / FRAME.w), y: 0.5 + q.y / 0.35, z: 0 }));
test("輪郭: 凸包は、四角の点だけ残し、中の点は、捨てる", () => {
  const h = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }, { x: 5, y: 0 }]);
  assert.equal(h.length, 4);
});
test("輪郭: 手を、画面の中で回しても(roll)、幅/長さ と 面積 は、変わらない", () => {
  const a = outlineShape(flat2d(makeWorld({ roll: 0 })), FRAME), b = outlineShape(flat2d(makeWorld({ roll: 40 })), FRAME);
  assert.ok(near(a.ratio, b.ratio, 0.02) && near(a.areaNorm, b.areaNorm, 0.02) && near(a.palmRatio, b.palmRatio, 0.02), JSON.stringify([a.ratio, b.ratio]));
});
test("輪郭: 左右にひねる(pan)と、幅/長さ が、縮む。大きく、ひねるほど、縮む。符号が、逆でも、同じ", () => {
  const r = (p) => outlineShape(flat2d(makeWorld({ pan: p })), FRAME);
  assert.ok(r(0).ratio > r(30).ratio && r(30).ratio > r(55).ratio);
  assert.ok(near(r(30).ratio, r(-30).ratio, 0.01));
  assert.ok(r(0).palmRatio > r(30).palmRatio);
});
test("輪郭: 前後に倒す(tilt)と、長さ が、縮む(幅/長さ は、増える)。 点が足りない時は null", () => {
  const r = (t) => outlineShape(flat2d(makeWorld({ tilt: t })), FRAME);
  assert.ok(r(0).ratio < r(30).ratio);
  assert.equal(outlineShape(null, FRAME), null);
});

test("分割: 手の点から、正の筆跡が6本(手のひら、親指、4本の指)。点は 0〜1 の中。点が足りない時は空", () => {
  const h = makeHand({});
  const s = handStrokes(h.lm);
  assert.equal(s.length, 6);
  assert.ok(s.every((k) => k.brushMode === 1 && k.isCompleted === true && k.point.length >= 2 && k.point.every((q) => q.x > 0 && q.x < 1 && q.y > 0 && q.y < 1)));
  assert.deepEqual(handStrokes(null), []);
  const edge = h.lm.map((q) => ({ ...q, x: 1.2, y: -0.1 }));
  assert.ok(handStrokes(edge).every((k) => k.point.every((q) => q.x <= 0.999 && q.y >= 0.001)), "画面の外の点は、中に、おさめる");
});
test("分割: 地図の、面積・長さ・幅。四角い地図で、数字が合う。空の地図は null", () => {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y: 0.8, z: 0 };   // 手首。 中指の付け根(9)は、真上
  const h = { lm };
  const mw = 160, mh = 90, mask = new Float32Array(mw * mh);
  for (let j = 20; j < 60; j++) for (let i = 50; i < 80; i++) mask[j * mw + i] = 1;   // 30 × 40 マス(画面では 240 × 320 画素)
  const s = maskStats(mask, mw, mh, h.lm, FRAME);
  assert.ok(near(s.area, 30 * 40 * 64, 1) && near(s.width, 240, 1) && near(s.length, 320, 1), JSON.stringify(s));
  assert.ok(near(s.ratio, 0.75, 0.01) && s.areaNorm > 0);
  assert.equal(maskStats(new Float32Array(mw * mh), mw, mh, h.lm, FRAME), null);
  assert.equal(maskStats(mask, mw, mh, null, FRAME), null);
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
