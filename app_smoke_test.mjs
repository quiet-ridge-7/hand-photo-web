// app_smoke_test.mjs — 画面の試験(ヘッドレス Edge + 偽のカメラ)。本物の手の映像は、使わない。
//   A. 本物の MediaPipe(手のモデル)が、読み込めて、動くか(偽のカメラの映像には、手が無いので、「手が無い」と、判定される)。
//   B. 人工の手の点を、渡して、ガイド・自動撮影・保存の流れを確かめる(?fake=1 の時だけ、入り口が、使われる)。
//   実行: node app_smoke_test.mjs        ポート: 8786(静的サーバ)、9345(Edge の遠隔操作)
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeHand, makeWorld } from "./test_hands.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 8786, CDP_PORT = 9345;
const BASE = "http://127.0.0.1:" + HTTP_PORT + "/";
const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".task": "application/octet-stream" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, cond, detail = "") => { console.log((cond ? "OK " : "NG ") + name + (cond ? "" : "  <- " + detail)); if (!cond) failures.push(name); };

const requested = [];
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname);
  requested.push(name);
  const file = path.join(ROOT, name === "/" ? "index.html" : name);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hand_smoke_"));
// 偽のカメラの映像: 模様のある、明るさが、中くらいの、動かない映像(くっきり度が、いつも、十分になる)。640 x 480、10コマ(y4m)
const Y4M = path.join(profile, "fake_camera.y4m");
{
  const W = 640, H = 480, frames = 10, parts = [Buffer.from("YUV4MPEG2 W" + W + " H" + H + " F30:1 Ip A1:1 C420jpeg\n")];
  const y = Buffer.alloc(W * H), u = Buffer.alloc((W / 2) * (H / 2), 128), v = Buffer.alloc((W / 2) * (H / 2), 128);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) y[j * W + i] = ((i >> 2) + (j >> 2)) % 2 === 0 ? 170 : 90;
  for (let f = 0; f < frames; f++) parts.push(Buffer.from("FRAME\n"), y, u, v);
  fs.writeFileSync(Y4M, Buffer.concat(parts));
}
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-file-for-fake-video-capture=" + Y4M,
  "--remote-debugging-port=" + CDP_PORT, "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
async function cleanup() {
  try { execSync("taskkill /PID " + edge.pid + " /T /F", { stdio: "ignore" }); } catch {}
  server.closeAllConnections?.(); server.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

try {
  let targets = null;
  for (let i = 0; i < 60 && !targets; i++) { try { targets = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json")).json(); } catch { await sleep(250); } }
  if (!targets) throw new Error("Edge に、つながりません");
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const pageErrors = []; const hosts = new Set();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (d.method === "Network.requestWillBeSent") { try { const u = new URL(d.params.request.url); if (u.protocol === "http:" || u.protocol === "https:") hosts.add(u.host); } catch {} }
    if (d.method === "Runtime.exceptionThrown") pageErrors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).split("\n")[0]);
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error" && !(d.params.args[0] && String(d.params.args[0].value ?? "").startsWith("INFO:"))) pageErrors.push(   /* INFO: は、MediaPipe の、情報メッセージ(エラーでは、ない) */ "console.error: " + d.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 160));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error("評価エラー: " + expression + " → " + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)); return r.result.result.value; };
  const waitFor = async (expression, what, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expression)) return true; } catch {} await sleep(100); } throw new Error("時間切れ: " + what); };
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");

  // 人工の手を、渡す入り口(?fake=1 の時だけ)と、保存・共有の記録
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__downloads = []; window.__shared = [];
    HTMLAnchorElement.prototype.click = function () { window.__downloads.push({ download: this.download, href: this.href.slice(0, 5) }); };
    window.__handNow = null;
    if (location.search.includes("fake=1")) {
      window.__HAND_FAKE__ = { detectForVideo() { const h = window.__handNow; return h ? { landmarks: [h.landmarks], worldLandmarks: h.world ? [h.world] : [], handedness: [[{ categoryName: h.label }]] } : { landmarks: [], worldLandmarks: [], handedness: [] }; } };
    }` });

  const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
  const load = async (query = "") => { await send("Page.navigate", { url: BASE + query }); await waitFor(`document.readyState === "complete"`, "読み込み"); };

  // ---- A. 本物の MediaPipe ----
  await load();
  await waitFor(`document.getElementById("video").videoWidth > 0`, "偽のカメラの映像", 20000);
  check("A1 偽のカメラの映像が、出る。状態の文に、「カメラが映っています」", /カメラが映っています/.test(await text("#status")), await text("#status"));
  await waitFor(`/手の検出の、準備ができました/.test(document.getElementById("status").textContent)`, "手のモデルの読み込み(WASM)", 40000);
  check("A2 本物の手のモデル(MediaPipe)が、読み込めた", true);
  await waitFor(`document.getElementById("guide").textContent.includes("手を、画面に、映してください")`, "手が無い時の、ガイド", 15000);
  check("A3 偽のカメラには、手が無いので、「手を、画面に、映してください」と、出る。チェック項目は、手のひらモードの数(11)", (await ev(`document.querySelectorAll("#checks li").length`)) === 11, await text("#guide"));
  check("A4 手が無い時、枠は、緑にならない。撮影は、自動では、始まらない", !(await ev(`document.getElementById("stage").classList.contains("ok")`)) && (await ev(`document.getElementById("result").hidden`)));
  const sizeAfterA = await ev(`({ w: document.getElementById("video").videoWidth, h: document.getElementById("video").videoHeight })`);

  // ---- B. 人工の手 ----
  await load("?fake=1&capture=1");   // 撮影は、既定では、オフ。この試験は、撮影の流れも、確かめるので、オンにして開く
  await waitFor(`document.getElementById("video").videoWidth > 0 && /手の検出の、準備ができました/.test(document.getElementById("status").textContent)`, "準備", 20000);
  const V = await ev(`({ w: document.getElementById("video").videoWidth, h: document.getElementById("video").videoHeight })`);
  const setHand = (opts) => { const { world, ...o } = opts; const hnd = makeHand({ ...o, frame: V }); return ev(`window.__handNow = ${JSON.stringify({ landmarks: hnd.lm, label: hnd.label, world: world ? makeWorld({ hand: o.hand, facing: o.facing, ...world }) : null })}; true`); };
  const guide = () => text("#guide");
  const waitGuide = (needle, what = needle) => waitFor(`document.getElementById("guide").textContent.includes(${JSON.stringify(needle)})`, "ガイド: " + what, 8000);

  await waitGuide("手を、画面に、映してください");
  check("B1 人工の手を渡す前は、「手を、画面に、映してください」", true);

  await setHand({ hand: "right", facing: "back", scale: 0.8 });
  await waitGuide("手のひらを、カメラに、向けてください");
  check("B2 手の甲を向けた手(手のひらモード)→ 「手のひらを、カメラに、向けてください」", true);
  check("B2b 点は、黄色(まだ、そろっていない)。枠も、緑ではない", !(await ev(`document.getElementById("stage").classList.contains("ok")`)));

  await setHand({ hand: "right", facing: "palm", scale: 0.3 });
  await waitGuide("もう少し、近づけてください");
  await setHand({ hand: "right", facing: "palm", scale: 0.8, curl: 1 });
  await waitGuide("中指を、まっすぐ、伸ばしてください");
  await setHand({ hand: "right", facing: "palm", scale: 0.8, spread: 0 });
  await waitGuide("人差し指と中指が、重なっています。少し、離してください");
  check("B3 遠い・指が曲がっている・指が閉じている、のガイドが、順に、出る", true);

  await setHand({ hand: "right", facing: "palm", scale: 0.8, curl: 1, world: { pan: 20, tilt: -10 } });
  await waitFor(`/"pan"/.test(document.getElementById("numbers-text").textContent)`, "角度の数字", 8000);
  const nums = JSON.parse(await text("#numbers-text"));
  check("B3b 3次元の点を渡すと、「確認用の数字」に、手の点すべてからの pan・tilt・roll・angle・rms と、3点の面の pan3・tilt3・angle3 が、出る(pan 20、tilt -10、roll 0)", Math.abs(nums.pan - 20) < 1.5 && Math.abs(nums.tilt + 10) < 1.5 && Math.abs(nums.roll) < 1.5 && Math.abs(nums.angle - 22.3) < 1.5 && Math.abs(Math.abs(nums.pan3) - 20) < 1.5 && nums.rms !== undefined, JSON.stringify(nums));
  await setHand({ hand: "right", facing: "palm", scale: 0.8, curl: 1, world: { pan: 0, tilt: 0, roll: 35 } });
  await waitFor(`Math.abs(JSON.parse(document.getElementById("numbers-text").textContent).roll - 35) < 2`, "roll の数字", 8000);
  const nums2 = JSON.parse(await text("#numbers-text"));
  check("B3c roll(画面の中で回す)35度を渡すと、roll が 35、pan と tilt は 0、angle も 0 のまま", Math.abs(nums2.roll - 35) < 1.5 && Math.abs(nums2.pan) < 1.5 && Math.abs(nums2.tilt) < 1.5 && nums2.angle < 1.5, JSON.stringify(nums2));

  // 法線の矢印(緑): pan 30度で、手のひらの中心から、右へ伸びる。まっすぐなら、中心の丸だけ
  await setHand({ hand: "right", facing: "palm", scale: 0.8, curl: 1, world: { pan: 30, tilt: 0, roll: 0 } });
  await sleep(600);
  const greenAt = (xFrac) => ev(`(() => { const c = document.getElementById("overlay"); const x = Math.round(c.width * ${xFrac}), y = Math.round(c.height * 0.5); const d = c.getContext("2d").getImageData(Math.max(0, x - 40), Math.max(0, y - 60), 80, 120).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 80 && d[i + 1] > 200 && d[i + 2] < 120 && d[i + 3] > 200) n++; return n; })()`);
  const tipGreen = await greenAt(0.62);
  check("B3d pan 30度のとき、手のひらの中心から、右へ、緑の矢印が、伸びる(中心の右側に、緑の画素)", tipGreen > 20, String(tipGreen));
  await setHand({ hand: "right", facing: "palm", scale: 0.8, curl: 1, world: { pan: 0, tilt: 0, roll: 0 } });
  await sleep(700);
  check("B3e まっすぐ(0度)のときは、矢印は、伸びない(右側に、緑が、ほとんど無い)", (await greenAt(0.62)) < 5, String(await greenAt(0.62)));

  await waitFor(`/pan\\s+[+-]\\s*\\d/.test(document.getElementById("pose-line").textContent)`, "向きの1行", 10000);
  check("B3i 向きの数字が、1行(pose-line)で、いつも見える所に出る(pan / tilt / roll と、21点の pan / tilt)。右の列の、凡例や、確認用の数字より、上にある", /pan\s+[+-]\s*\d+\.\d°\s+tilt\s+[+-]\s*\d+\.\d°\s+roll\s+[+-]\s*\d+\.\d°\s*\[16点: pan.*\[21点: pan/s.test(await text("#pose-line")) && (await ev(`document.getElementById("pose-line").getBoundingClientRect().top < document.getElementById("depth-color").getBoundingClientRect().top`)), await text("#pose-line"));

  // 奥行きの色: pan 30度で、いちばん近い点は、赤っぽく、いちばん遠い点は、青っぽい。チェックを外すと、色は、ふつうの色(黄色)に戻る
  const wd = makeWorld({ hand: "right", facing: "palm", pan: 30 });
  const idx11 = [0, 1, 2, 5, 6, 9, 10, 13, 14, 17, 18];   // 指先と、第1関節(3、4、7、8、11、12、15、16、19、20)を除いた 11点
  const zs = idx11.map((i) => wd[i].z), iNear = idx11[zs.indexOf(Math.min(...zs))], iFar = idx11[zs.indexOf(Math.max(...zs))];
  await setHand({ hand: "right", facing: "palm", scale: 0.8, curl: 1, world: { pan: 30, tilt: 0, roll: 0 } });
  await waitFor(`(() => { try { return Math.abs(JSON.parse(document.getElementById("numbers-text").textContent).pan) > 25; } catch { return false; } })()`, "pan 30度の数字(奥行きの色の確認)", 10000);
  const lmNow = await ev(`window.__handNow.landmarks`);
  const rgbAt = (i) => ev(`(() => { const c = document.getElementById("overlay"); const p = ${JSON.stringify(lmNow[i])}; const d = c.getContext("2d").getImageData(Math.round(p.x * c.width) - 1, Math.round(p.y * c.height) - 1, 3, 3).data; let r = 0, g = 0, b = 0, n = 0; for (let k = 0; k < d.length; k += 4) { r += d[k]; g += d[k + 1]; b += d[k + 2]; n++; } return [r / n, g / n, b / n]; })()`);
  let cNear = await rgbAt(iNear), cFar = await rgbAt(iFar);
  for (let k = 0; k < 100 && !(cNear[0] > cNear[2] + 40 && cFar[2] > cFar[0] + 40); k++) { await sleep(100); cNear = await rgbAt(iNear); cFar = await rgbAt(iFar); }
  check("B3f 奥行きの色: いちばん近い点は、赤っぽい(R が、B より大きい)。いちばん遠い点は、青っぽい(B が、R より大きい)", cNear[0] > cNear[2] + 40 && cFar[2] > cFar[0] + 40, JSON.stringify({ near: cNear.map(Math.round), far: cFar.map(Math.round), iNear, iFar }));
  const cTip = await rgbAt(8), cDip = await rgbAt(7);
  check("B3f2 指先(8番)と、第1関節(7番)の点には、奥行きの色を付けない(灰色: R・G・B が、近い値)", [cTip, cDip].every((c) => Math.max(...c) - Math.min(...c) < 25 && c[0] > 120), JSON.stringify({ tip: cTip.map(Math.round), dip: cDip.map(Math.round) }));
  check("B3g 確認用の数字に、奥行き(depthMm。色を付けない10点は x)が出る。チェックは、はじめから、オン。凡例がある", (((await text("#numbers-text")).match(/"depthMm": "([^"]*)"/) || [])[1] || "").split(/[\s|]+/).filter((v) => v === "x").length === 10 && (await ev(`document.getElementById("depth-color").checked`)) && (await ev(`!!document.querySelector("#depth-legend .bar")`)));
  await ev(`document.getElementById("depth-color").click(); true`);
  let cOff = await rgbAt(iNear);
  for (let k = 0; k < 100 && !(cOff[0] > 180 && cOff[1] > 140 && cOff[2] < 100); k++) { await sleep(100); cOff = await rgbAt(iNear); }
  check("B3h チェックを外すと、点は、ふつうの色(黄色: R と G が高く、B が低い)に、戻る", cOff[0] > 180 && cOff[1] > 140 && cOff[2] < 100, JSON.stringify(cOff.map(Math.round)));
  await ev(`document.getElementById("depth-color").click(); true`);

  // 全部そろった手 → 自動撮影(偽のカメラの、明るさ・くっきり度が、足りない時は、数字を、出して、知らせる)
  await setHand({ hand: "right", facing: "palm", scale: 0.8 });
  let gotResult = true;
  try { await waitFor(`!document.getElementById("result").hidden`, "自動撮影", 12000); } catch { gotResult = false; }
  if (!gotResult) {
    console.log("   hold=" + (await ev(`document.getElementById("hold").value`)) + " checks=" + (await ev(`[...document.querySelectorAll("#checks li")].map((l) => l.className + ":" + l.textContent).join(" | ")`)));
    console.log("   (自動撮影に、ならなかった。ガイド: " + (await guide()) + " / 数字: " + (await text("#numbers-text")).replace(/\s+/g, " ").slice(0, 300) + ")");
  }
  check("B4 条件が、全部そろった手を、約1秒、保つと、自動で撮れる(結果の画面が、出る)", gotResult);
  if (gotResult) {
    check("B5 撮れた写真が、出る(blob)。「撮れました(自動)」。カメラの画面は、隠れる", /^blob:/.test(await ev(`document.getElementById("shot").src`)) && /撮れました\(自動\)/.test(await text("#saved-note")) && (await ev(`document.getElementById("camera-view").hidden`)), await text("#saved-note"));
    // 保存: 共有が、使えない時は、ダウンロード
    await ev(`document.getElementById("save").click(); true`);
    await sleep(300);
    const dl = await ev(`window.__downloads`);
    check("B6 共有が使えない端末では、ダウンロード(hand_palm_日付_時刻.jpg)", dl.length === 1 && /^hand_palm_\d{8}_\d{6}\.jpg$/.test(dl[0].download) && dl[0].href === "blob:", JSON.stringify(dl));
    // 共有が使える端末(iPhone など): 共有の画面を、開く
    await ev(`navigator.canShare = () => true; navigator.share = async (d) => { window.__shared.push(d.files.map((f) => [f.name, f.type, f.size > 1000])); }; true`);
    await ev(`document.getElementById("save").click(); true`);
    await sleep(300);
    const shared = await ev(`window.__shared`);
    check("B7 共有が使える端末では、共有の画面に、写真(jpeg)を、渡す。ダウンロードは、増えない", shared.length === 1 && shared[0][0][1] === "image/jpeg" && shared[0][0][2] === true && (await ev(`window.__downloads.length`)) === 1, JSON.stringify(shared));
    await ev(`delete navigator.share; delete navigator.canShare; true`);
    // もう一度撮る
    await ev(`document.getElementById("again").click(); true`);
    check("B8 「もう一度撮る」で、カメラの画面に、戻る(結果は、隠れる)", (await ev(`document.getElementById("result").hidden`)) && !(await ev(`document.getElementById("camera-view").hidden`)));
    await setHand({ hand: "right", facing: "back", scale: 0.8 });
    await waitGuide("手のひらを、カメラに、向けてください");
    check("B9 戻った後も、検出が、続いている", true);
  }

  // モードの切り替え
  await ev(`document.querySelector('#modes button[data-mode="back"]').click(); true`);
  await waitFor(`[...document.querySelectorAll("#checks li")].some((li) => li.textContent.includes("手の甲側"))`, "手の甲モードの項目", 5000);
  check("B10 「手の甲」を選ぶと、説明が変わり、チェック項目は、「手の甲側」になる", /手の甲側を/.test(await text("#mode-help")) && (await ev(`[...document.querySelectorAll("#checks li")].some((li) => li.textContent.includes("手の甲側"))`)), await text("#mode-help"));
  await waitFor(`!document.getElementById("guide").textContent.includes("手のひらを")`, "甲モードのガイド", 5000);
  await ev(`document.querySelector('#modes button[data-mode="tip"]').click(); true`);
  await waitFor(`document.querySelectorAll("#checks li").length > 0`, "指先モードの項目", 5000);
  check("B11 「指先」を選ぶと、「5本まとめて / 1本ずつ」が、出る。チェック項目は、指先用(8項目)", !(await ev(`document.getElementById("tip-sub").hidden`)) && (await ev(`document.querySelectorAll("#checks li").length`)) === 8, String(await ev(`document.querySelectorAll("#checks li").length`)));
  await ev(`document.querySelector('#tip-sub button[data-sub="tip1"]').click(); true`);
  check("B12 「1本ずつ」に切り替わる(説明が、変わる)", /撮りたい指/.test(await text("#mode-help")), await text("#mode-help"));
  await ev(`document.querySelector('#modes button[data-mode="palm"]').click(); true`);
  check("B13 「手のひら」に戻すと、指先の選択は、隠れる", await ev(`document.getElementById("tip-sub").hidden`));

  // 撮影が、オフの時(既定): 条件がそろっても、撮らない。検出は、続く。「撮影」ボタンも、無い
  await load("?fake=1");
  await waitFor(`document.getElementById("video").videoWidth > 0 && /手の検出の、準備ができました/.test(document.getElementById("status").textContent)`, "準備(撮影オフ)", 20000);
  check("B21 撮影がオフの時は、「撮影」ボタンが、隠れている", await ev(`document.getElementById("shoot").hidden`));
  await setHand({ hand: "right", facing: "palm", scale: 0.8 });
  await waitGuide("そろいました(撮影は、いまは、オフです)");
  await sleep(2500);
  check("B22 条件が、全部そろっても、撮らない(結果の画面は、出ない)。枠は、緑のまま、検出が、続く(手を変えると、ガイドが、変わる)", (await ev(`document.getElementById("result").hidden`)) && (await ev(`document.getElementById("stage").classList.contains("ok")`)));
  await setHand({ hand: "right", facing: "back", scale: 0.8 });
  await waitGuide("手のひらを、カメラに、向けてください");
  check("B23 そのあとも、検出が、続いている(手の甲に変えると、ガイドが、変わる)", true);
  await setHand({ hand: "right", facing: "palm", scale: 0.8 });
  await load("?fake=1&capture=1");
  await waitFor(`document.getElementById("video").videoWidth > 0 && /手の検出の、準備ができました/.test(document.getElementById("status").textContent)`, "準備(撮影オン)", 20000);

  // 画面の並び: 広い画面(PC)は、映像の右に、チェックと数字。狭い画面(スマホ)は、1列
  const place = () => ev(`(() => { const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }; return { stage: r("stage"), checks: r("checks"), numbers: r("numbers-text"), open: document.getElementById("numbers").open, vw: window.innerWidth }; })()`);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  let pl = await place();
  const pl19 = await ev(`(() => { const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; }; return { pose: r("pose-line"), num: r("numbers-text"), h: window.innerHeight }; })()`);
  check("B19 広い画面(1280 × 800)では、確認用の数字が、はじめから開いていて、映像の、右に、並ぶ。向きの1行は、映像と、同じ高さの範囲に、ある。確認用の数字の枠も、画面の中(下に、スクロールしなくても、見える)に、収まる", pl.numbers.left >= pl.stage.right - 1 && pl.checks.left >= pl.stage.right - 1 && pl19.pose.top >= pl.stage.top - 1 && pl19.pose.bottom <= pl.stage.bottom && pl19.num.top < pl19.h, JSON.stringify({ stage: [pl.stage.top, pl.stage.bottom], pose: pl19.pose, numTop: pl19.num.top, h: pl19.h }));
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  pl = await place();
  check("B20 狭い画面(390)では、1列(チェックが、映像の、下)。横に、はみ出さない", pl.checks.top >= pl.stage.bottom - 1 && (await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`)), JSON.stringify({ stageBottom: pl.stage.bottom, checksTop: pl.checks.top }));
  await send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });

  // 手動の撮影
  await ev(`document.getElementById("shoot").click(); true`);
  await waitFor(`!document.getElementById("result").hidden`, "手動の撮影", 5000);
  check("B14 「撮影」ボタンで、いつでも、手動で撮れる", /撮りました/.test(await text("#saved-note")), await text("#saved-note"));
  await ev(`document.getElementById("again").click(); true`);

  // カメラの切り替え
  await ev(`document.getElementById("flip").click(); true`);
  await waitFor(`document.getElementById("video").videoWidth > 0`, "切り替え後の映像", 10000);
  check("B15 「カメラを切り替える」で、映像が、続く", true);
  check("B16 ページのエラーは、出ていない", pageErrors.length === 0, pageErrors.join(" | "));
  const external = [...hosts].filter((h) => h !== "127.0.0.1:" + HTTP_PORT);
  check("B17 通信した先は、この画面の置き場所だけ(外のサイトへの、通信は、無い)", external.length === 0, JSON.stringify(external));
  check("B18 読み込んだのは、手のモデル(models/hand_landmarker.task)と、MediaPipe の部品だけ(顔のモデルなどは、無い)", requested.includes("/models/hand_landmarker.task") && !requested.some((n) => /face_/.test(n)), JSON.stringify(requested.filter((n) => /models|wasm/.test(n))));
  void sizeAfterA;
} catch (e) {
  console.log("試験が、途中で止まりました: " + e.message);
  failures.push("途中停止");
} finally {
  await cleanup();
}
console.log(failures.length === 0 ? "\napp_smoke_test: すべて通りました" : "\napp_smoke_test: 失敗 " + failures.length + " 件: " + failures.join(" / "));
process.exit(failures.length === 0 ? 0 : 1);
