// app.js — 手の撮影アプリ: カメラ、手の検出、ガイドの表示、撮影、保存。
//   判定は guide.mjs(画面に依存しない)。映像と写真は、この端末の中だけで、扱う(送信しない)。
//   手のひら・手の甲を、左手 → 右手の順に、4つ(STEPS)、自動で撮る。
import { createHandLandmarker } from "./hand_setup.mjs";
import { T, evaluate, facingOf, VERSION, holdProgress, motionScore, pointsOf, meanLuma, toGray, sharpness, patchCenters, combineMeasures, makeGuide, GUIDE_TILT_DEG, guideMatch, fingertipRects, nailCropMatrix, SIL, SIL_BONES, PALM_POLY, silDisks, STEPS, nextStep, stepHelp, stepFileName, nailFileName } from "./guide.mjs";

const APP_VERSION = "v43";   // guide.mjs の VERSION と、同じ値(違えば、古いファイルが、混ざっている)

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const octx = overlay.getContext("2d");
const stage = $("stage");

// 4つの撮影は、いつも、オン。 アドレスの末尾に ?capture=0 を付けて開くと、自動の撮影も、「撮影」ボタンも、オフ(試験用)
const params = new URLSearchParams(window.location.search);
const SEQ_CAPTURE = params.get("capture") !== "0";
const GUIDE_TILT = params.has("tilt") && Number.isFinite(Number(params.get("tilt"))) ? Number(params.get("tilt")) : GUIDE_TILT_DEG;   // ガイドの傾き(度)。 試験用に、?tilt=0 で、傾けない
const COOLDOWN_MS = 2000;   // 1つ撮った後、次を、撮り始めるまでの、間
const SWITCH_FRAMES = 8;    // まだ1枚も撮っていない時に、逆の手が、これだけ続けて映ったら、その手から始める(コマ数。約0.3秒)

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
  step: 0,                 // 4つのうち、次に撮る物の番号(全部、撮れたら -1)
  shots: STEPS.map(() => null),   // 撮れた写真: { blob, url, filename, w, h } | null
  lastLm: null,            // 最後に見つけた、手の点と、映像の大きさ(手の甲を撮った時に、爪を切り出す)
  lastFrame: null,
  resetArmed: false,       // 「最初から、撮り直す」を、1回、押した状態(もう一度、押すと、消える)
  camToken: 0,             // カメラを、始め直した回数(古い、始めの結果を、捨てるため)
  cooldownUntil: 0,        // この時刻までは、次を撮らない(撮った直後の、案内を見せる間)
  userPicked: false,       // 左上の4つを、自分で押して、選んだか(選んだ時は、手の左右で、勝手に、変えない)
  otherCount: 0,           // 次に撮る手と、逆の手が、続けて映ったコマ数
  justMsg: "",
  capturing: false,
  mode: "palm",            // 判定に使う、いまのモード: "palm" | "back"(次に撮る物の、モード)
  facingMode: window.matchMedia && window.matchMedia("(pointer: coarse)").matches ? "environment" : "user",   // スマホは、背面。PC は、前面
  stream: null,
  landmarker: null,
  history: [],             // 動きを見るための、点の記録
  hold: { since: null, progress: 0, ready: false },
  lastVideoTime: -1,
  frameCount: 0,
  bright: null,
  sharp: null,
  sharps: [],              // 場所ごとの、くっきり度(確認用の数字に、出す)
  guide: null,             // 手の形のガイド(撮る手・手のひら / 甲・映像の大きさで、作り直す)
};

const curStep = () => (state.step >= 0 ? STEPS[state.step] : null);
const handName = (h) => (h === "right" ? "右手" : "左手");

// ---- 画面の文字 ----
// 状態の文: カメラと、手の検出、2つの様子を、まとめて出す
const parts = { camera: "カメラを準備しています…", model: "手の検出を準備しています…" };
function setStatus(text, which = "camera") { parts[which] = text; $("status").textContent = parts.camera + " / " + parts.model; }
function setGuide(text, ok) {
  if ($("guide").textContent !== text) $("guide").textContent = text;
  stage.classList.toggle("ok", !!ok);
}

// 判定に使う、モードを、きめる(次に撮る物の、モード。全部、撮れたら、最後の物)
function applyMode() {
  const s = curStep();
  state.mode = s ? s.mode : STEPS[STEPS.length - 1].mode;
  state.hold = { since: null, progress: 0, ready: false };
  state.history = [];
}

function renderModeHelp() {
  const s = curStep();
  $("mode-help").textContent = s ? "次は、「" + s.label + "」。" + stepHelp(s) : "4つ、全部、撮れました。下の「全部、保存」で、保存します。";
  $("shoot").hidden = !SEQ_CAPTURE;   // 「撮影」ボタン(手動の撮影)
  const now = $("now-label");   // 映像の左上: いま撮っている項目(例: 左手の甲)。 全部、撮れたら、「全部、撮れました」
  now.textContent = s ? "撮影中: " + s.label : "全部、撮れました";
  now.classList.toggle("done", !s);
}

// 4つの撮影の、一覧(未 / 次 / 済み)を、描く
function renderSteps() {
  // 映像の上の、4つ(横一列: 左手のひら、左手の甲、右手のひら、右手の甲)。 撮れたら、緑。次に撮る物は、青い枠
  $("step-badges").replaceChildren(...STEPS.map((s, i) => {
    const b = document.createElement("span");
    b.className = "badge " + (state.shots[i] ? "done" : i === state.step ? "current" : "todo");
    b.dataset.i = String(i);
    b.textContent = (state.shots[i] ? "✓ " : i === state.step ? "▶ " : "") + s.label;
    return b;
  }));
  // 右の列の一覧: 撮れた物だけ(小さな写真と、『保存』『撮り直す』)
  $("steps").replaceChildren(...STEPS.map((s, i) => {
    const shot = state.shots[i];
    if (!shot) return null;
    const li = document.createElement("li");
    li.dataset.i = String(i);
    li.className = "done";
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = "✓";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = s.label;
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = shot.url;
    img.alt = s.label + "の写真";
    const retake = document.createElement("button");
    retake.type = "button"; retake.dataset.act = "retake"; retake.dataset.i = String(i); retake.textContent = "撮り直す";
    li.append(mark, name, img, retake);
    if (shot.nails && shot.nails.length) {   // 手の甲: 爪(指先)の、切り出した写真(小さく)。 押すと、拡大
      const row = document.createElement("div");
      row.className = "nails";
      shot.nails.forEach((n, k) => {
        const im = document.createElement("img");
        im.className = "nail-thumb";
        im.src = n.url;
        im.alt = s.label + " " + n.name + "の爪";
        im.title = n.name + "(押すと、拡大)";
        im.dataset.i = String(i);
        im.dataset.k = String(k);
        row.append(im);
      });
      li.append(row);
    }
    return li;
  }).filter(Boolean));
  const n = state.shots.filter(Boolean).length;
  const nn = state.shots.reduce((s, x) => s + (x && x.nails ? x.nails.length : 0), 0);   // 爪の写真の、枚数
  $("save-all").textContent = "保存(" + (n + nn) + "枚)";   // 手のひら・手の甲の写真 + 爪の写真
  $("save-all").disabled = n === 0;
  $("reset-all").disabled = n === 0;
}

function renderChecks(checks) {
  const ul = $("checks");
  const key = checks.map((c) => c.id + c.label + (c.ok ? "1" : "0")).join();
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
  const token = ++state.camToken;
  setStatus("カメラを準備しています…");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("このブラウザでは、カメラが使えません(https で開いているかを、確かめてください)。");
    return;
  }
  // 許可の確認の窓が、出たまま、答えが来ない時(6秒)に、案内を出す
  const hint = setTimeout(() => {
    if (token === state.camToken && !state.stream) setStatus("カメラの許可の確認が、出ていませんか?「許可」を選んでください。出ない時は、ページを、閉じて、開き直してください(iPhone は、設定 → Safari → カメラ も、確かめてください)。");
  }, 6000);
  // 画質の指定が、通らない時は、指定を、ゆるめて、やり直す(向きだけ → 何も、指定しない)
  const tries = [
    { video: { facingMode: state.facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
    { video: { facingMode: state.facingMode }, audio: false },
    { video: true, audio: false },
  ];
  let stream = null, lastErr = null;
  for (const c of tries) {
    try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { lastErr = e; if (e && e.name === "NotAllowedError") break; }
  }
  clearTimeout(hint);
  if (token !== state.camToken) { if (stream) for (const t of stream.getTracks()) t.stop(); return; }   // 待っている間に、始め直した
  if (!stream) {
    const e = lastErr;
    setStatus(e && e.name === "NotAllowedError" ? "カメラの使用が、許可されていません(ブラウザの設定で、許可してください)" : e && e.name === "NotFoundError" ? "カメラが、見つかりません" : "カメラを使えませんでした(" + (e && e.name) + ")");
    return;
  }
  state.stream = stream;
  video.srcObject = stream;
  const mirror = state.facingMode === "user";   // 前面カメラは、鏡のように、映す
  video.classList.toggle("mirror", mirror);
  overlay.classList.toggle("mirror", mirror);
  video.play().catch(() => {});   // 再生の答えを、待たない(iPhone で、答えが、来ない時にも、状態が、進むように)
  setStatus("カメラが映っています");
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

// 手の形のガイドを、うすく描く(ガイドに、手を重ねてもらう)。 形は、骨組みを太らせた形(guide.mjs の silhouetteMask と、同じ作り方)。 絵は、とっておいて、使い回す
const guideCache = { key: "", canvas: null };
function drawGuide(guide, matched) {
  const w = overlay.width, h = overlay.height;
  const key = [w, h, guide.hand, guide.facing, guide.tilt, matched].join();
  if (guideCache.key !== key) {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const c = cv.getContext("2d");
    const P = guide.lm.map((p) => ({ x: p.x * w, y: p.y * h }));
    const palmW = Math.hypot(P[5].x - P[17].x, P[5].y - P[17].y);
    c.fillStyle = c.strokeStyle = matched ? "#4cc38a" : "#ffffff";
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    PALM_POLY.forEach((i, k) => (k ? c.lineTo(P[i].x, P[i].y) : c.moveTo(P[i].x, P[i].y)));
    c.closePath();
    c.fill();
    for (const [s, e, kind] of SIL_BONES) {
      c.lineWidth = 2 * SIL[kind] * palmW;
      c.beginPath();
      c.moveTo(P[s].x, P[s].y);
      c.lineTo(P[e].x, P[e].y);
      c.stroke();
    }
    for (const d of silDisks(P)) {   // 小指の下の、ふくらみ(丸み)
      c.beginPath();
      c.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      c.fill();
    }
    guideCache.key = key;
    guideCache.canvas = cv;
  }
  octx.save();
  octx.globalAlpha = 0.34;   // 白を、少し、強く
  octx.drawImage(guideCache.canvas, 0, 0);
  octx.restore();
}

// ---- 手の点を、重ねて描く ----
function drawHand(lm, ok, guide = null, matched = false, nails = null) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (guide) drawGuide(guide, matched);
  if (!lm) return;
  const w = overlay.width, h = overlay.height;
  if (nails) {   // 爪(指先)の四角(手の甲を撮る時)。 水色。 指の向きに合わせて、傾く
    octx.save();
    octx.strokeStyle = "#35c9ff";
    octx.lineWidth = Math.max(3, w / 300);
    octx.lineJoin = "round";
    for (const n of nails) {
      octx.beginPath();
      n.corners.forEach((p, i) => (i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y)));
      octx.closePath();
      octx.stroke();
    }
    octx.restore();
  }
  octx.lineWidth = Math.max(2, w / 400);
  octx.strokeStyle = "rgba(255,255,255,0.85)";
  octx.beginPath();
  for (const [a, b] of CONNECTIONS) { octx.moveTo(lm[a].x * w, lm[a].y * h); octx.lineTo(lm[b].x * w, lm[b].y * h); }
  octx.stroke();
  octx.fillStyle = ok ? "#4cc38a" : "#f0b429";
  const r = Math.max(3, w / 200);
  for (const p of lm) { octx.beginPath(); octx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2); octx.fill(); }
}

// ---- 映像と、描画の絵(オーバーレイ)の、大きさ・位置を、こちらで、計算して、決める ----
//   ブラウザの、自動の計算(高さ auto と object-fit)に、頼らない。 iPhone で、ときどき、映像の絵だけが、小さく出て、ガイドと、ずれる不具合の対策。
//   見た目は、これまでと、同じ: 幅は、枠いっぱい。 高さは、画面の 70%(PC の 2列表示は 80%)まで。 それを、超える時は、縦に、合わせて、左右に、黒い余白。
//   映像が来る前は、CSS の、元の指定のまま。 毎コマ(6コマに、1回)、期待の大きさと、実際の大きさを、比べて、ずれていたら、指定し直す(自己修復)。
const layoutState = { key: "", tick: 0 };
function clearLayout() {
  layoutState.key = "";
  stage.style.removeProperty("height");
  for (const el of [video, overlay]) for (const p of ["position", "left", "top", "width", "height", "max-height"]) el.style.removeProperty(p);
}
function layoutVideo() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) { if (layoutState.key) clearLayout(); return; }
  const availW = stage.clientWidth;   // 枠の、中の幅(枠線を除く)
  if (!availW) return;
  const maxH = window.innerHeight * (window.matchMedia("(min-width: 900px)").matches ? 0.8 : 0.7);
  const ar = vw / vh;
  const H = Math.max(40, Math.min(availW / ar, maxH)), W = H * ar;
  const key = [availW, Math.round(H), Math.round(W)].join();
  const r = video.getBoundingClientRect();
  const actualOk = Math.abs(r.width - W) < 1.5 && Math.abs(r.height - H) < 1.5;   // 実際の大きさが、期待どおりか(ずれていたら、指定し直す)
  if (key === layoutState.key && actualOk) return;
  layoutState.key = key;
  stage.style.height = H + 6 + "px";   // 枠線(上下 3px ずつ)の分を足す
  for (const el of [video, overlay]) {
    el.style.position = "absolute";
    el.style.left = (availW - W) / 2 + "px";
    el.style.top = "0px";
    el.style.width = W + "px";
    el.style.height = H + "px";
    el.style.maxHeight = "none";
  }
}
for (const evName of ["loadedmetadata", "resize", "playing"]) video.addEventListener(evName, layoutVideo);
window.addEventListener("resize", layoutVideo);
window.addEventListener("orientationchange", () => { setTimeout(layoutVideo, 300); setTimeout(layoutVideo, 1000); });

// ---- 毎コマの処理 ----
function loop() {
  requestAnimationFrame(loop);
  if (++layoutState.tick % 6 === 0) layoutVideo();   // 映像の大きさを、確かめる(ずれていたら、直す)
  if (!state.landmarker || video.readyState < 2 || !video.videoWidth) return;
  if (video.currentTime === state.lastVideoTime) return;   // 新しいコマが、まだ
  state.lastVideoTime = video.currentTime;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (overlay.width !== vw || overlay.height !== vh) { overlay.width = vw; overlay.height = vh; }

  let result;
  try { result = state.landmarker.detectForVideo(video, performance.now()); } catch (e) { setStatus("手の検出で、エラーが出ました(" + e.message + ")", "model"); return; }
  const lm = result.landmarks && result.landmarks[0] ? result.landmarks[0] : null;
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
  state.lastLm = lm;   // 撮る時(爪の切り出し)に、使う
  state.lastFrame = frame;

  // まだ1枚も撮っていない時に、逆の手が、先に映ったら、その手から始める(手のひらから)。 自分で選んだ時は、変えない
  const seenHand = lm ? facingOf(lm, label, frame) : null;
  const first = curStep();
  if (seenHand && first && !state.userPicked && !state.shots.some(Boolean) && seenHand.hand !== first.hand) {
    state.otherCount++;
    if (state.otherCount >= SWITCH_FRAMES) {
      state.otherCount = 0;
      state.step = STEPS.findIndex((s) => s.hand === seenHand.hand && s.mode === "palm");
      applyMode();
      renderModeHelp();
      renderSteps();
      $("seq-note").textContent = handName(seenHand.hand) + "が、先に映ったので、" + handName(seenHand.hand) + "から始めます。";
    }
  } else {
    state.otherCount = 0;
  }
  const step = curStep();   // 次に撮る物(全部、撮れたら null)
  let guide = null;
  if (step) {   // 手の形のガイド: 次に撮る物(手の左右・手のひら / 甲)の形
    const mirror = state.facingMode === "user";   // 前面カメラは、鏡のように映す(傾きの向きを、画面で見た向きに、合わせる)
    const gk = [vw, vh, step.hand, step.mode, GUIDE_TILT, mirror].join();
    if (!state.guide || state.guide.key !== gk) state.guide = { key: gk, g: makeGuide(frame, { hand: step.hand, facing: step.mode, tilt: GUIDE_TILT, mirror }) };
    guide = state.guide.g;
  }
  const gm = guide && lm ? guideMatch(lm, guide, frame, false) : null;   // 一致(そのまま)だけ。ガイドの色(緑 / 白)に使う
  const r = evaluate({ mode: state.mode, landmarks: lm, label, frame, motion, brightness: state.bright, sharp: state.sharp, wantHand: step ? step.hand : undefined, guideOverlap: gm ? gm.overlap : null });   // ガイドとの一致(そのまま)も、条件に入る
  const nails = lm && step && step.mode === "back" ? fingertipRects(lm, frame) : null;   // 手の甲を撮る時だけ、爪の四角を出す
  drawHand(lm, r.allOk, guide, !!(gm && gm.overlap != null && gm.overlap >= T.guideOverlap), nails);
  renderChecks(r.checks);

  const cooling = now < state.cooldownUntil;   // 撮った直後(次の案内を、見せる間)
  if (cooling || !step) {
    state.hold = { since: null, progress: 0, ready: false };
    $("hold").value = 0;
    setGuide(cooling ? state.justMsg : "4つ、全部、撮れました。「全部、保存」を、押してください", true);
  } else {
    state.hold = holdProgress(state.hold, r.allOk, now);
    $("hold").value = state.hold.progress;
    setGuide(r.allOk && state.hold.progress < 1 ? "そのまま、止めてください" : r.allOk ? (SEQ_CAPTURE ? r.guide : "そろいました(撮影は、オフです)") : r.guide, r.allOk);
  }
  if (state.frameCount % 2 === 0) {   // いま見えている手(左右の判定が、合っているかを、確かめるため)
    if (seenHand) { const f = seenHand; $("seen").textContent = "いま見えている手: " + handName(f.hand) + "の" + (f.facing === "palm" ? "手のひら側" : "手の甲側"); }
    else $("seen").textContent = "いま見えている手: (なし)";
  }
  if (state.frameCount % 5 === 0) $("numbers-text").textContent = lm ? JSON.stringify({ ...r.numbers, sharpPatches: state.sharps }, null, 1) : "(手が、映っていません) 明るさ: " + (r.numbers.bright ?? "-");
  if (state.hold.ready && step && SEQ_CAPTURE) captureStep("auto");
}

// ---- 「撮れました」の、大きな表示(映像の、真ん中) ----
let bannerTimer = null;
function showShotBanner(step, next) {
  // 「撮れました。次は、左手の甲」だけ(2行)。 4つ全部、撮れた時は、「4つ、全部、撮れました。」
  $("shot-banner-title").textContent = next ? "撮れました。" : "4つ、全部、撮れました。";
  $("shot-banner-next").textContent = next ? "次は、" + next.label : "";
  $("shot-banner-next").hidden = !next;
  $("shot-banner").hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { $("shot-banner").hidden = true; }, COOLDOWN_MS + 600);
}

// ---- 4つの撮影: 撮る・保存・撮り直す ----
const canvasBlob = async () => {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(video, 0, 0, w, h);   // 鏡に映さず、カメラの、そのままの向きで、保存する
  const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.92));
  return blob ? { blob, w, h, canvas: c } : null;
};

// 手の甲の写真から、5本の爪(指先)の四角を、切り出す。 指の向きが、真上になるように、回して、切り出す(拡大はしない)
async function cropNails(canvas, lm, frame) {
  const rects = lm ? fingertipRects(lm, frame) : null;
  if (!rects) return [];
  const out = [];
  for (const r of rects) {
    const m = nailCropMatrix(r);
    const c = document.createElement("canvas");
    c.width = m.W;
    c.height = m.H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, m.W, m.H);
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(canvas, 0, 0);
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.95));
    if (blob) out.push({ name: r.name, key: r.key, blob, url: URL.createObjectURL(blob), w: m.W, h: m.H });
  }
  return out;
}

// 1枚の写真(と、爪の写真)の、メモリを、解放する
function freeShot(s) {
  if (!s) return;
  URL.revokeObjectURL(s.url);
  for (const n of s.nails || []) URL.revokeObjectURL(n.url);
}

async function captureStep(how) {
  if (state.capturing || state.step < 0) return;
  const i = state.step, step = STEPS[i];
  state.capturing = true;
  const lmAtShot = state.lastLm, frameAtShot = state.lastFrame;   // 撮った瞬間の、手の点
  const shot = await canvasBlob();
  const nails = shot && step.mode === "back" ? await cropNails(shot.canvas, lmAtShot, frameAtShot) : [];   // 手の甲だけ、爪を切り出す
  state.capturing = false;
  if (!shot) { setStatus("写真を、作れませんでした(映像が、まだ、準備できていません)"); return; }
  if (state.step !== i) { for (const n of nails) URL.revokeObjectURL(n.url); return; }   // 撮っている間に、次の物に、切り替わった
  freeShot(state.shots[i]);
  const at = new Date();
  for (const n of nails) n.filename = nailFileName(step, n.key, at);   // 爪の写真の、ファイル名(手の甲の写真と、同じ日付・時刻)
  state.shots[i] = { blob: shot.blob, url: URL.createObjectURL(shot.blob), filename: stepFileName(step, at), w: shot.w, h: shot.h, nails };
  state.step = nextStep(state.shots.map(Boolean), i);
  const next = curStep();
  state.justMsg = "撮れました: " + step.label + (next ? "。次は、" + next.label + "です" : "。4つ、全部、撮れました");
  state.cooldownUntil = performance.now() + COOLDOWN_MS;
  showShotBanner(step, next);   // 「撮れました」を、大きく、出す
  applyMode();
  renderModeHelp();
  renderSteps();
  $("seq-note").textContent = step.label + "を、撮りました(" + shot.w + " × " + shot.h + ")。" + (nails.length ? "爪(指先)の写真を、" + nails.length + "枚、切り出しました。" : "") + "写真は、まだ、保存していません。";
}

function retake(i) {
  if (!state.shots[i]) return;
  freeShot(state.shots[i]);
  state.shots[i] = null;
  state.step = i;
  state.cooldownUntil = 0;
  applyMode();
  renderModeHelp();
  renderSteps();
  $("seq-note").textContent = STEPS[i].label + "を、撮り直します。";
}

// 最初から、撮り直す: 確認は、ブラウザの確認の窓(confirm)ではなく、ボタンの、2回押し(iPhone で、確認の窓の後に、映像が、止まるため)
let resetArmTimer = null;
function disarmReset() {
  state.resetArmed = false;
  clearTimeout(resetArmTimer);
  $("reset-all").textContent = "最初から、撮り直す";
  $("reset-all").classList.remove("danger");
}
function resetAll() {
  if (!state.shots.some(Boolean)) { disarmReset(); return; }
  if (!state.resetArmed) {   // 1回目: ボタンの文字を変えて、もう一度、押すと、消えると、知らせる(4秒で、元に戻る)
    state.resetArmed = true;
    $("reset-all").textContent = "もう一度、押すと、全部、消えます";
    $("reset-all").classList.add("danger");
    clearTimeout(resetArmTimer);
    resetArmTimer = setTimeout(disarmReset, 4000);
    return;
  }
  disarmReset();
  for (const s of state.shots) freeShot(s);
  state.shots = STEPS.map(() => null);
  state.step = 0;
  state.userPicked = false;
  state.otherCount = 0;
  state.cooldownUntil = 0;
  $("shot-banner").hidden = true;
  applyMode();
  renderModeHelp();
  renderSteps();
  $("seq-note").textContent = "最初から、撮り直します。";
  video.play().catch(() => {});   // 映像が、止まっていたら、動かす
}

// 爪の写真を、拡大して、見る(どこかを押すと、閉じる。Esc でも、閉じる。左右の矢印キーと、「前へ / 次へ」で、5本を、順に)
const lightbox = { i: -1, k: 0 };
function openLightbox(i, k) {
  const s = state.shots[i];
  if (!s || !s.nails || !s.nails[k]) return;
  const n = s.nails[k];
  lightbox.i = i;
  lightbox.k = k;
  $("lightbox-img").src = n.url;
  $("lightbox-cap").textContent = STEPS[i].label + " — " + n.name + "(" + (k + 1) + " / " + s.nails.length + "。" + n.w + " × " + n.h + " 画素)";
  $("lightbox").hidden = false;
}
function closeLightbox() {
  $("lightbox").hidden = true;
  $("lightbox-img").removeAttribute("src");
  lightbox.i = -1;
}
function stepLightbox(d) {
  const s = lightbox.i >= 0 ? state.shots[lightbox.i] : null;
  if (!s || !s.nails || s.nails.length === 0) return;
  openLightbox(lightbox.i, (lightbox.k + d + s.nails.length) % s.nails.length);
}

// 保存: iPhone など → 共有の画面(「画像を保存」)。 PC など → ダウンロード。 items: [{ blob, url, filename }]
async function saveItems(items, what) {
  if (items.length === 0) return;
  const files = items.map((it) => new File([it.blob], it.filename, { type: "image/jpeg" }));
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      $("seq-note").textContent = "共有の画面を開きました。「画像を保存」を選ぶと、写真に入ります(" + what + "、" + files.length + "枚)。";
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;   // 取り消した
    }
  }
  for (const it of items) {   // ダウンロード(ブラウザが、続けての、ダウンロードの許可を、聞くことがある)
    const a = document.createElement("a");
    a.href = it.url;
    a.download = it.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  $("seq-note").textContent = "ダウンロードしました(" + what + "、" + items.length + "枚): " + items.map((it) => it.filename).join("、");
}

// 手のひら・手の甲の、全体の写真と、爪(指先)の写真を、まとめて、保存する(保存ボタンは、これ1つ)
function saveAll() {
  const items = [];
  for (const s of state.shots) if (s) items.push(s);
  for (const s of state.shots) if (s && s.nails) items.push(...s.nails);
  return saveItems(items, "手と爪の写真");
}

// ---- 操作 ----
$("steps").addEventListener("click", (e) => {
  const th = e.target.closest("img.nail-thumb");
  if (th) { openLightbox(Number(th.dataset.i), Number(th.dataset.k)); return; }
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "retake") retake(Number(btn.dataset.i));
});
$("step-badges").addEventListener("click", (e) => {   // 映像の上の、まだ撮っていない物を、押すと、それを、次に撮る物にする
  const b = e.target.closest(".badge");
  if (!b || b.classList.contains("done")) return;   // 撮れた物は、押しても、何もしない(撮り直しは、右の列の「撮り直す」)
  state.step = Number(b.dataset.i);
  state.userPicked = true;
  state.cooldownUntil = 0;
  applyMode();
  renderModeHelp();
  renderSteps();
});
$("lightbox").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-lb]");
  if (b) { stepLightbox(b.dataset.lb === "next" ? 1 : -1); return; }
  closeLightbox();
});
document.addEventListener("keydown", (e) => {
  if ($("lightbox").hidden) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowRight") stepLightbox(1);
  else if (e.key === "ArrowLeft") stepLightbox(-1);
});
$("save-all").addEventListener("click", saveAll);
$("reset-all").addEventListener("click", resetAll);
$("shoot").addEventListener("click", () => captureStep("manual"));
$("flip").addEventListener("click", () => { state.facingMode = state.facingMode === "user" ? "environment" : "user"; startCamera(); });

// ---- 起動 ----
if (window.matchMedia && window.matchMedia("(min-width: 900px)").matches) $("numbers").open = true;   // 広い画面(PC)では、確認用の数字を、手と一緒に見られるよう、はじめから、開いておく
applyMode();
renderModeHelp();
renderSteps();
$("version").textContent = "版: app " + APP_VERSION + " / guide " + VERSION + (APP_VERSION === VERSION ? "" : "  ← 違います。古いファイルが、混ざっています。Ctrl+F5 を、押してください");
// サービスワーカー(2回目からの、読み込みを、速くする。ネットが無くても、動く)。 この PC(localhost)では、古い物が、残って、開発の邪魔になるので、登録しない(?sw=1 で、試験の時だけ、登録する)
const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
if ("serviceWorker" in navigator && (!isLocal || params.get("sw") === "1")) navigator.serviceWorker.register("sw.js").catch(() => {});
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
