// app.js — 手の撮影アプリ: カメラ、手の検出、ガイドの表示、撮影、保存。
//   判定は guide.mjs(画面に依存しない)。映像と写真は、この端末の中だけで、扱う(送信しない)。
import { createHandLandmarker, createHandSegmenter } from "./hand_setup.mjs";
import { T, MODES, evaluate, holdProgress, motionScore, pointsOf, meanLuma, toGray, sharpness, patchCenters, combineMeasures, handFrame, framePose, smoothFrame, normalArrow, depthRelative, depthColor, outlineShape, handStrokes, maskStats } from "./guide.mjs";

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const octx = overlay.getContext("2d");
const stage = $("stage");

// 撮影(自動の撮影と、「撮影」ボタン)は、いまは、オフ(判定の調整のため。撮ると、画面が、撮影後の画面に、切り替わって、検出が、止まるので)。
//   アドレスの末尾に ?capture=1 を付けて開くと、オンに戻る。
const CAPTURE_ENABLED = new URLSearchParams(window.location.search).get("capture") === "1";

const SMOOTH_FRAMES = 5;   // 手の向きを、ならす、コマ数
const PATCH = 96;   // くっきり度と、明るさを、調べる、四角の大きさ(映像の画素)。場所は、数か所(patchCenters)
const sample = document.createElement("canvas");
sample.width = PATCH;
sample.height = PATCH;
const sctx = sample.getContext("2d", { willReadFrequently: true });

// 手の点の、つなぎ方(線で結ぶ)
const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

const state = {
  mode: "palm",            // "palm" | "back" | "tip5" | "tip1"
  tipSub: "tip5",
  facingMode: window.matchMedia && window.matchMedia("(pointer: coarse)").matches ? "environment" : "user",   // スマホは、背面。PC は、前面
  stream: null,
  landmarker: null,
  history: [],             // 動きを見るための、点の記録
  frames: [],              // 手の向き(軸)の、直近の記録(ゆれを、ならすため)
  hold: { since: null, progress: 0, ready: false },
  lastVideoTime: -1,
  frameCount: 0,
  bright: null,
  sharp: null,
  sharps: [],              // 場所ごとの、くっきり度(確認用の数字に、出す)
  captured: false,
  blob: null,
  filename: "",
  resultUrl: null,
  seg: null,                // 輪郭の分割モデル(チェックを入れた時に、読み込む)
  segLoading: false,
  segBusy: false,
  segLast: 0,               // 最後に分割した時刻
  segCanvas: null,          // 分割の結果を、描いた絵(重ねて表示)
  segStats: null,           // 分割の結果の数字
  segMs: null,
};
const SEG_WIDTH = 640;      // 分割に渡す絵の幅(縦は、映像の比に合わせる)
const SEG_EVERY_MS = 150;   // 分割の間隔(最低)
const segSrc = document.createElement("canvas");

// ---- 画面の文字 ----
// 状態の文: カメラと、手の検出、2つの様子を、まとめて出す
const parts = { camera: "カメラを準備しています…", model: "手の検出を準備しています…" };
function setStatus(text, which = "camera") { parts[which] = text; $("status").textContent = parts.camera + " / " + parts.model; }
function setGuide(text, ok) {
  if ($("guide").textContent !== text) $("guide").textContent = text;
  stage.classList.toggle("ok", !!ok);
}

function renderModeHelp() {
  $("mode-help").textContent = MODES[state.mode].help;
  for (const b of document.querySelectorAll("#modes button")) {
    const m = b.dataset.mode;
    b.classList.toggle("on", m === "tip" ? state.mode.startsWith("tip") : m === state.mode);
  }
  $("tip-sub").hidden = !state.mode.startsWith("tip");
  for (const b of document.querySelectorAll("#tip-sub button")) b.classList.toggle("on", b.dataset.sub === state.mode);
}

function setMode(mode) {
  state.mode = mode;
  state.hold = { since: null, progress: 0, ready: false };
  state.history = [];
  state.frames = [];
  renderModeHelp();
  renderChecks([]);
}

function renderChecks(checks) {
  const ul = $("checks");
  const key = checks.map((c) => c.id + (c.ok ? "1" : "0")).join();
  if (ul.dataset.key === key) return;
  ul.dataset.key = key;
  ul.replaceChildren(...checks.map((c) => {
    const li = document.createElement("li");
    li.className = c.ok ? "ok" : "ng";
    li.textContent = (c.ok ? "✓ " : "・ ") + c.label;
    return li;
  }));
}

// ---- カメラ ----
async function startCamera() {
  stopCamera();
  setStatus("カメラを準備しています…");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("このブラウザでは、カメラが使えません(https で開いているかを、確かめてください)。");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    state.stream = stream;
    video.srcObject = stream;
    const mirror = state.facingMode === "user";   // 前面カメラは、鏡のように、映す
    video.classList.toggle("mirror", mirror);
    overlay.classList.toggle("mirror", mirror);
    await video.play().catch(() => {});
    setStatus("カメラが映っています");
  } catch (e) {
    const why = e && e.name === "NotAllowedError" ? "カメラの使用が、許可されていません(ブラウザの設定で、許可してください)" : e && e.name === "NotFoundError" ? "カメラが、見つかりません" : "カメラを使えませんでした(" + (e && e.name) + ")";
    setStatus(why);
  }
}

function stopCamera() {
  if (state.stream) for (const t of state.stream.getTracks()) t.stop();
  state.stream = null;
  video.srcObject = null;
}

// ---- 画素の数字(手のあたりの、明るさと、くっきり度) ----
function measureImage(lm, vw, vh) {
  const list = patchCenters(lm, state.mode).map((c) => {
    const sx = Math.max(0, Math.min(vw - PATCH, Math.round(c.x * vw - PATCH / 2)));
    const sy = Math.max(0, Math.min(vh - PATCH, Math.round(c.y * vh - PATCH / 2)));
    sctx.drawImage(video, sx, sy, PATCH, PATCH, 0, 0, PATCH, PATCH);
    const rgba = sctx.getImageData(0, 0, PATCH, PATCH).data;
    return { bright: meanLuma(rgba), sharp: sharpness(toGray(rgba), PATCH, PATCH) };
  });
  return { ...combineMeasures(list), sharps: list.map((m) => Math.round(m.sharp)) };
}

// ---- 実際の輪郭(分割モデル) ----
async function ensureSegmenter() {
  if (state.seg || state.segLoading) return;
  state.segLoading = true;
  $("seg-note").textContent = "輪郭のモデルを読み込んでいます…";
  try {
    state.seg = await createHandSegmenter();
    $("seg-note").textContent = "輪郭のモデルの準備ができました(橙の線 = 実際の輪郭)";
  } catch (e) {
    $("seg-note").textContent = "輪郭のモデルを、準備できませんでした(" + e.message + ")";
    $("seg-outline").checked = false;
  }
  state.segLoading = false;
}

// 手の点を目印に、手の形を切り出し、輪郭(橙の線)と、うすい塗りを、絵にして、とっておく
function runSegment(lm, frame, now) {
  if (!state.seg || state.segBusy || now - state.segLast < SEG_EVERY_MS || !lm) return;
  state.segBusy = true;
  try {
    const sw = SEG_WIDTH, sh = Math.round((SEG_WIDTH * frame.h) / frame.w);
    if (segSrc.width !== sw || segSrc.height !== sh) { segSrc.width = sw; segSrc.height = sh; }
    segSrc.getContext("2d").drawImage(video, 0, 0, sw, sh);
    const t0 = performance.now();
    state.seg.setImage(segSrc);
    const res = state.seg.segment(handStrokes(lm));
    const mask = res.getAsFloat32Array(), mw = res.width, mh = res.height;
    state.segMs = Math.round(performance.now() - t0);
    state.segStats = maskStats(mask, mw, mh, lm, frame);
    if (!state.segCanvas) state.segCanvas = document.createElement("canvas");
    const cv = state.segCanvas;
    cv.width = mw;
    cv.height = mh;
    const img = new ImageData(mw, mh), d = img.data;
    const on = (i, j) => i >= 0 && j >= 0 && i < mw && j < mh && mask[j * mw + i] >= 0.5;
    for (let j = 0; j < mh; j++) {
      for (let i = 0; i < mw; i++) {
        if (!on(i, j)) continue;
        const k = (j * mw + i) * 4, edge = !on(i - 1, j) || !on(i + 1, j) || !on(i, j - 1) || !on(i, j + 1);
        d[k] = 255; d[k + 1] = edge ? 140 : 170; d[k + 2] = edge ? 0 : 60; d[k + 3] = edge ? 255 : 55;
      }
    }
    cv.getContext("2d").putImageData(img, 0, 0);
    res.close();
  } catch (e) {
    $("seg-note").textContent = "輪郭の分割で、エラーが出ました(" + e.message + ")";
    state.segCanvas = null;
    state.segStats = null;
  }
  state.segLast = now;
  state.segBusy = false;
}

// ---- 手の点を、重ねて描く ----
function drawHand(lm, ok, arrow = null, depth = null, outline = null) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!lm) return;
  const w = overlay.width, h = overlay.height;
  if (state.segCanvas && $("seg-outline").checked) octx.drawImage(state.segCanvas, 0, 0, w, h);   // 実際の輪郭(分割モデル)
  octx.lineWidth = Math.max(2, w / 400);
  octx.strokeStyle = "rgba(255,255,255,0.85)";
  if (outline && outline.hull.length > 2) {   // 輪郭(21点の、外側を結んだ形)を、水色で
    octx.save();
    octx.strokeStyle = "#35c9ff";
    octx.lineWidth = Math.max(3, w / 300);
    octx.beginPath();
    outline.hull.forEach((q, i) => (i ? octx.lineTo(q.x, q.y) : octx.moveTo(q.x, q.y)));
    octx.closePath();
    octx.stroke();
    octx.restore();
  }
  octx.beginPath();
  for (const [a, b] of CONNECTIONS) { octx.moveTo(lm[a].x * w, lm[a].y * h); octx.lineTo(lm[b].x * w, lm[b].y * h); }
  octx.stroke();
  octx.fillStyle = ok ? "#4cc38a" : "#f0b429";
  const r = Math.max(3, w / 200);
  if (depth) {   // 奥行きを、色で表す(近い = 赤、平均 = 白、遠い = 青)。点を、少し大きくして、白い縁を、付ける
    octx.strokeStyle = "rgba(0,0,0,0.6)";
    octx.lineWidth = Math.max(1, w / 500);
    lm.forEach((p, i) => {
      if (depth[i] == null) {   // 8点以外の13点: 色を付けない(奥行きの平均にも、面の計算にも、使わない)。小さな、灰色の点
        octx.fillStyle = "rgba(170,170,170,0.85)";
        octx.beginPath(); octx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2); octx.fill();
        return;
      }
      const [cr, cg, cb] = depthColor(depth[i]);
      octx.fillStyle = "rgb(" + cr + "," + cg + "," + cb + ")";
      octx.beginPath(); octx.arc(p.x * w, p.y * h, r * 1.7, 0, Math.PI * 2); octx.fill(); octx.stroke();
    });
  } else {
    for (const p of lm) { octx.beginPath(); octx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2); octx.fill(); }
  }
  if (arrow) drawNormal(arrow, w);
}

// 手のひら(甲)の、向き(法線)を、緑の矢印で、描く。 まっすぐ、カメラに向いていると、短く(中心の、丸だけ)、傾くと、傾いた向きへ、伸びる
const NORMAL_GREEN = "#00ff55";
function drawNormal(a, w) {
  octx.save();
  octx.strokeStyle = NORMAL_GREEN;
  octx.fillStyle = NORMAL_GREEN;
  octx.lineWidth = Math.max(3, w / 220);
  octx.lineCap = "round";
  const dot = Math.max(5, w / 110);
  octx.beginPath();
  octx.arc(a.from.x, a.from.y, dot, 0, Math.PI * 2);   // 手のひらの中心
  octx.fill();
  if (a.length > dot * 1.5) {
    octx.beginPath();
    octx.moveTo(a.from.x, a.from.y);
    octx.lineTo(a.to.x, a.to.y);
    octx.stroke();
    const ang = Math.atan2(a.to.y - a.from.y, a.to.x - a.from.x), head = Math.max(10, w / 70);   // 矢じり
    octx.beginPath();
    octx.moveTo(a.to.x, a.to.y);
    octx.lineTo(a.to.x - head * Math.cos(ang - 0.45), a.to.y - head * Math.sin(ang - 0.45));
    octx.moveTo(a.to.x, a.to.y);
    octx.lineTo(a.to.x - head * Math.cos(ang + 0.45), a.to.y - head * Math.sin(ang + 0.45));
    octx.stroke();
  } else {
    octx.beginPath();
    octx.arc(a.from.x, a.from.y, dot * 2.2, 0, Math.PI * 2);   // ほぼ、まっすぐ(手前向き)の時は、外側に、輪を描く
    octx.stroke();
  }
  octx.restore();
}

// ---- 毎コマの処理 ----
function loop() {
  requestAnimationFrame(loop);
  if (state.captured || !state.landmarker || video.readyState < 2 || !video.videoWidth) return;
  if (video.currentTime === state.lastVideoTime) return;   // 新しいコマが、まだ
  state.lastVideoTime = video.currentTime;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (overlay.width !== vw || overlay.height !== vh) { overlay.width = vw; overlay.height = vh; }

  let result;
  try { result = state.landmarker.detectForVideo(video, performance.now()); } catch (e) { setStatus("手の検出で、エラーが出ました(" + e.message + ")", "model"); return; }
  const lm = result.landmarks && result.landmarks[0] ? result.landmarks[0] : null;
  const world = result.worldLandmarks && result.worldLandmarks[0] ? result.worldLandmarks[0] : null;   // 3次元の位置(メートル)
  const label = result.handedness && result.handedness[0] && result.handedness[0][0] ? result.handedness[0][0].categoryName : "Left";
  const now = performance.now();
  const frame = { w: vw, h: vh };

  state.frameCount++;
  if (state.frameCount % 3 === 0 || state.bright == null) {
    const m = measureImage(lm, vw, vh);
    state.bright = m.bright;
    state.sharp = m.sharp;
    state.sharps = m.sharps;
  }

  if (lm) {
    state.history.push({ t: now, pts: pointsOf(lm) });
    while (state.history.length > 0 && now - state.history[0].t > 1000) state.history.shift();
  } else {
    state.history = [];
  }
  const motion = lm ? motionScore(state.history, frame) : null;

  // 手の向き(pan / tilt / roll): 3次元の点21個から、手の軸を作り、直近の数コマを、ならして、出す
  let pose = null, smoothed = null;
  const f3 = world ? handFrame(world) : null;
  if (f3) {
    state.frames.push(f3);
    while (state.frames.length > SMOOTH_FRAMES) state.frames.shift();
    smoothed = smoothFrame(state.frames);
    pose = framePose(smoothed);
  } else {
    state.frames = [];
  }
  const r = evaluate({ mode: state.mode, landmarks: lm, label, frame, motion, brightness: state.bright, sharp: state.sharp, world, pose });
  const segOn = $("seg-outline").checked;
  if (segOn && !state.seg) ensureSegmenter();
  if (segOn && lm) runSegment(lm, frame, now);
  if (!lm || !segOn) { state.segCanvas = null; state.segStats = null; }
  const outline = lm ? outlineShape(lm, frame) : null;
  drawHand(lm, r.allOk, normalArrow(lm, smoothed, frame), $("depth-color").checked ? depthRelative(world) : null, outline);   // 奥行き(平均を 0)を、点の色で   // 法線(手のひら / 甲の向き)を、緑の矢印で
  renderChecks(r.checks);
  state.hold = holdProgress(state.hold, r.allOk, now);
  $("hold").value = state.hold.progress;
  const readyText = CAPTURE_ENABLED ? r.guide : "そろいました(撮影は、いまは、オフです)";
  setGuide(r.allOk && state.hold.progress < 1 ? "そのまま、止めてください" : r.allOk ? readyText : r.guide, r.allOk);
  if (state.frameCount % 2 === 0) $("pose-line").textContent = poseLine(r.numbers) + outlineLine(outline) + segLine();   // 向きの数字を、1行で、いつも見える所に
  if (state.frameCount % 5 === 0) $("numbers-text").textContent = lm ? JSON.stringify({ ...r.numbers, sharpPatches: state.sharps }, null, 1) : "(手が、映っていません) 明るさ: " + (r.numbers.bright ?? "-");
  if (state.hold.ready && CAPTURE_ENABLED) capture("auto");
}

// 向きの数字(pan / tilt / roll)を、文字にする。(8点の面) 11点・16点・21点の面も、比べるために、並べる
const sgn = (v) => (v == null ? "  -  " : (v >= 0 ? "+" : "-") + Math.abs(v).toFixed(1).padStart(4, " "));
function poseLine(n) {
  if (n.pan === undefined) return "向き: (手が映ると、数字が出ます)";
  const pair = (p, t) => "(" + sgn(p).trim() + "," + sgn(t).trim() + ")";
  return "pan " + sgn(n.pan) + "°  tilt " + sgn(n.tilt) + "°  roll " + sgn(n.roll) + "°\n比較(pan,tilt): 11点 " + pair(n.pan11, n.tilt11) + " 16点 " + pair(n.pan16, n.tilt16) + " 21点 " + pair(n.panAll, n.tiltAll);
}

// 輪郭の形の数字(画面の中の、2次元)。 幅 ÷ 長さ(輪郭)、手のひらの 幅 ÷ 長さ、面積(手首〜中指の付け根の2乗に対する倍率)
function outlineLine(o) {
  if (!o) return "";
  return "\n輪郭: 幅/長さ " + o.ratio.toFixed(2) + "  手のひら 幅/長さ " + o.palmRatio.toFixed(2) + "  面積 " + o.areaNorm.toFixed(2);
}

// 分割(実際の輪郭)の数字: 幅/長さ、面積(手首〜中指の付け根の2乗に対する倍率)、かかった時間
function segLine() {
  const s = state.segStats;
  if (!$("seg-outline").checked || !s) return "";
  return "\n実際の輪郭: 幅/長さ " + s.ratio.toFixed(2) + "  面積 " + s.areaNorm.toFixed(2) + "  (" + state.segMs + "ms)";
}

// ---- 撮影と保存 ----
async function capture(how) {
  if (state.captured) return;
  state.captured = true;
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) { state.captured = false; setStatus("映像が、まだ、準備できていません"); return; }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(video, 0, 0, w, h);   // 鏡に映さず、カメラの、そのままの向きで、保存する
  const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) { state.captured = false; setStatus("写真を、作れませんでした"); return; }
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  state.filename = "hand_" + state.mode + "_" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "_" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + ".jpg";
  state.blob = blob;
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = URL.createObjectURL(blob);
  $("shot").src = state.resultUrl;
  $("saved-note").textContent = (how === "auto" ? "撮れました(自動)。" : "撮りました。") + " " + w + " × " + h + "。写真は、まだ、保存していません。";
  $("result").hidden = false;
  $("camera-view").hidden = true;
}

async function savePhoto() {
  if (!state.blob) return;
  const file = new File([state.blob], state.filename, { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {   // iPhone など: 共有の画面(「画像を保存」を選べる)
    try {
      await navigator.share({ files: [file] });
      $("saved-note").textContent = "共有の画面を開きました。「画像を保存」を選ぶと、写真に入ります。";
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;   // 取り消した
    }
  }
  const a = document.createElement("a");   // PC など: ダウンロード
  a.href = state.resultUrl;
  a.download = state.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  $("saved-note").textContent = "ダウンロードしました(" + state.filename + ")。";
}

function again() {
  $("result").hidden = true;
  $("camera-view").hidden = false;
  state.captured = false;
  state.hold = { since: null, progress: 0, ready: false };
  state.history = [];
  state.lastVideoTime = -1;
  $("hold").value = 0;
}

// ---- 操作 ----
for (const b of document.querySelectorAll("#modes button")) {
  b.addEventListener("click", () => setMode(b.dataset.mode === "tip" ? state.tipSub : b.dataset.mode));
}
for (const b of document.querySelectorAll("#tip-sub button")) {
  b.addEventListener("click", () => { state.tipSub = b.dataset.sub; setMode(b.dataset.sub); });
}
$("shoot").addEventListener("click", () => capture("manual"));
$("flip").addEventListener("click", () => { state.facingMode = state.facingMode === "user" ? "environment" : "user"; startCamera(); });
$("save").addEventListener("click", savePhoto);
$("again").addEventListener("click", again);

// ---- 起動 ----
if (!CAPTURE_ENABLED) $("shoot").hidden = true;   // 撮影が、オフの間は、「撮影」ボタンも、隠す
if (window.matchMedia && window.matchMedia("(min-width: 900px)").matches) $("numbers").open = true;   // 広い画面(PC)では、確認用の数字を、手と一緒に見られるよう、はじめから、開いておく
renderModeHelp();
startCamera();
(async function boot() {
  try {
    state.landmarker = window.__HAND_FAKE__ || (await createHandLandmarker());   // __HAND_FAKE__: 画面の試験が、人工の手を、渡すための、入り口(ふだんは、使わない)
    setStatus("手の検出の、準備ができました", "model");
  } catch (e) {
    setStatus("手の検出を、準備できませんでした(" + e.message + ")", "model");
  }
})();
requestAnimationFrame(loop);
