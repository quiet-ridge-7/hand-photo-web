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
import { makeHand } from "./test_hands.mjs";
import { fingertipRects, makeGuide, GUIDE_TILT_DEG } from "./guide.mjs";


const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 8786, CDP_PORT = 9345;
const BASE = "http://127.0.0.1:" + HTTP_PORT + "/";
const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".task": "application/octet-stream", ".webmanifest": "application/manifest+json", ".png": "image/png", ".txt": "text/plain; charset=utf-8" };
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
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error" && !(d.params.args[0] && /^(INFO:|[IW]\d{4} \d\d:\d\d:)/.test(String(d.params.args[0].value ?? "")))) pageErrors.push(   /* INFO: と I・W で始まる記録(例 I1121 01:45:03)は、MediaPipe の、情報・警告のメッセージ(エラーでは、ない) */ "console.error: " + d.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 160));
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
      window.__HAND_FAKE__ = { detectForVideo() { const h = window.__handNow; return h ? { landmarks: [h.landmarks], handedness: [[{ categoryName: h.label }]] } : { landmarks: [], handedness: [] }; } };
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
  check("A3 偽のカメラには、手が無いので、「手を、画面に、映してください」と、出る。チェック項目は、手のひらモードの数(13。撮る手の確認と、ガイドの確認が、入る)", (await ev(`document.querySelectorAll("#checks li").length`)) === 13, await text("#guide"));
  check("A3v 画面に、ファイルの版が出る(app と guide が、同じ。古いファイルが、混ざっていない)", /^版: app (v\d+) \/ guide \1$/.test(await text("#version")), await text("#version"));
  check("A4 手が無い時、枠は、緑にならない。撮影は、自動では、始まらない(撮れた物が、0)", !(await ev(`document.getElementById("stage").classList.contains("ok")`)) && (await ev(`document.querySelectorAll("#steps li.done").length`)) === 0);
  const sizeAfterA = await ev(`({ w: document.getElementById("video").videoWidth, h: document.getElementById("video").videoHeight })`);

  // ---- B. 人工の手 ----
  await load("?fake=1&tilt=0");   // (傾き 0 で、開く: ガイドの傾きは、別に、確かめる)4つの撮影は、いつも、オン(自動の撮影の流れも、この画面で、確かめる)
  await waitFor(`document.getElementById("video").videoWidth > 0 && /手の検出の、準備ができました/.test(document.getElementById("status").textContent)`, "準備", 20000);
  const V = await ev(`({ w: document.getElementById("video").videoWidth, h: document.getElementById("video").videoHeight })`);
  const setHand = (opts) => { const hnd = makeHand({ ...opts, frame: V }); return ev(`window.__handNow = ${JSON.stringify({ landmarks: hnd.lm, label: hnd.label })}; true`); };
  const guide = () => text("#guide");
  const waitGuide = (needle, what = needle) => waitFor(`document.getElementById("guide").textContent.includes(${JSON.stringify(needle)})`, "ガイド: " + what, 8000);

  await waitGuide("手を、画面に、映してください");
  check("B1 人工の手を渡す前は、「手を、画面に、映してください」", true);

  await setHand({ hand: "left", facing: "back", scale: 0.8 });
  await waitGuide("手のひらを、カメラに、向けてください");
  check("B2 手の甲を向けた手(手のひらモード)→ 「手のひらを、カメラに、向けてください」", true);
  check("B2b 点は、黄色(まだ、そろっていない)。枠も、緑ではない", !(await ev(`document.getElementById("stage").classList.contains("ok")`)));

  await setHand({ hand: "left", facing: "palm", scale: 0.3 });
  await waitGuide("もう少し、近づけてください");
  await setHand({ hand: "left", facing: "palm", scale: 0.8, curl: 1 });
  await waitGuide("中指を、まっすぐ、伸ばしてください");
  await setHand({ hand: "left", facing: "palm", scale: 0.8, spread: 0 });
  await waitGuide("人差し指と中指が、重なっています。少し、離してください");
  check("B3 遠い・指が曲がっている・指が閉じている、のガイドが、順に、出る", true);

  // 手の形のガイド(うすい形): 手のひらモードで、画面の真ん中に出る。いまの手と重なっていれば(一致 50%以上)緑、そうでなければ白
  //   ガイドだけの画素(透明度 40〜75)の、平均の色で見る
  const guidePix = () => ev(`(() => { const c = document.getElementById("overlay"); const x0 = Math.round(c.width * 0.42), y0 = Math.round(c.height * 0.55); const d = c.getContext("2d").getImageData(x0, y0, Math.round(c.width * 0.16), Math.round(c.height * 0.2)).data; let n = 0, r = 0, g = 0, b = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] >= 65 && d[i + 3] <= 110) { n++; r += d[i]; g += d[i + 1]; b += d[i + 2]; } } return n ? { n, r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) } : { n: 0 }; })()`);
  await setHand({ hand: "left", facing: "palm", scale: 0.8, curl: 1 });
  let gp = { n: 0 };
  for (let k = 0; k < 80; k++) { gp = await guidePix(); if (gp.n > 50 && gp.g - gp.r > 50) break; await sleep(100); }
  check("G1 手のひらモード: ガイド(うすい形)が出ている。ガイドと同じ位置の手(一致 50%以上)では、ガイドは緑", gp.n > 50 && gp.g - gp.r > 50, JSON.stringify(gp));
  await setHand({ hand: "left", facing: "palm", scale: 0.8, curl: 1, cx: 0.8 });
  for (let k = 0; k < 80; k++) { gp = await guidePix(); if (gp.n > 50 && Math.abs(gp.g - gp.r) < 20) break; await sleep(100); }
  check("G2 手を右にずらして、一致が下がると、ガイドは、白に戻る", gp.n > 50 && Math.abs(gp.g - gp.r) < 20, JSON.stringify(gp));
  const guideLi = () => ev(`(() => { const li = [...document.querySelectorAll("#checks li")].find((l) => l.textContent.includes("ガイドに重なっている")); return li ? li.className : null; })()`);
  check("G5 チェック一覧に『ガイドに重なっている』がある。手をずらして(一致が下がる)と、そろっていない(ng)。案内の文も、出る", (await guideLi()) === "ng", String(await guideLi()));
  await setHand({ hand: "left", facing: "palm", scale: 0.8, curl: 1, cx: 0.62 });   // 中央の許容の中で、ガイドから、ずらす
  await sleep(600);
  check("G5b 中央の許容の中でも、ガイドから、ずれていれば(一致が 50% 未満)、案内は『手を、ガイドの形に、重ねてください』(指が曲がっているので、指の案内が、先に出る場合は、ng のまま)", (await guideLi()) === "ng", String(await guideLi()));
  await setHand({ hand: "left", facing: "palm", scale: 0.8, curl: 1 });
  let gl = null;
  for (let k = 0; k < 60; k++) { gl = await guideLi(); if (gl === "ok") break; await sleep(100); }
  check("G6 ガイドに重ねると(一致 50%以上)、『ガイドに重なっている』が、そろう(ok)", gl === "ok", String(gl));
  await ev(`window.__handNow = null; true`);
  await sleep(500);
  gp = await guidePix();
  check("G3 手が映っていなくても、ガイド(うすい形)は、画面に出ている(白)", gp.n > 50 && Math.abs(gp.g - gp.r) < 20, JSON.stringify(gp));

  // ---- 4つの撮影(左手のひら → 左手の甲 → 右手のひら → 右手の甲): 撮れたら、緑。次に撮る物を、案内する ----
  const stepClass = (i) => ev(`document.querySelectorAll("#step-badges .badge")[${i}].classList[1]`);   // "done" | "current" | "todo"
  const waitDone = (i, what) => waitFor(`document.querySelectorAll("#step-badges .badge")[${i}].classList.contains("done")`, what + "が、撮れる", 20000);
  const diag = async () => console.log("   hold=" + (await ev(`document.getElementById("hold").value`)) + " ガイド=" + (await guide()) + " checks=" + (await ev(`[...document.querySelectorAll("#checks li")].map((l) => l.className + ":" + l.textContent).join(" | ")`)));
  check("S0 先頭が『次(current)』。説明は『次は、「左手のひら」』。右の一覧は、まだ空(撮れた物だけが、並ぶ)", (await ev(`document.querySelectorAll("#steps li").length`)) === 0 && (await stepClass(0)) === "current" && /次は、「左手のひら」/.test(await text("#mode-help")), await text("#mode-help"));
  // 爪の四角(水色): 人差し指の、指先の側の辺の、真ん中の画素(手の点や線は、そこには、無い)
  const nailPix = async (opts) => {
    const hnd = makeHand({ ...opts, frame: V }), r = fingertipRects(hnd.lm, V)[1];
    const mx = (r.corners[2].x + r.corners[3].x) / 2, my = (r.corners[2].y + r.corners[3].y) / 2;
    return ev(`(() => { const c = document.getElementById("overlay"); const d = c.getContext("2d").getImageData(Math.round(${mx}) - 1, Math.round(${my}) - 1, 3, 3).data; let r = 0, g = 0, b = 0, a = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; } const n = d.length / 4; return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), a: Math.round(a / n) }; })()`);
  };
  check("S0a 映像の左上に、いま撮っている項目が、大きく出る(『撮影中: 左手のひら』)。映像の枠の、左上にある", /^撮影中: 左手のひら$/.test(await text("#now-label")) && (await ev(`(() => { const n = document.getElementById("now-label").getBoundingClientRect(), st = document.getElementById("stage").getBoundingClientRect(); return n.left - st.left < 20 && n.top - st.top < 20 && n.width > 80; })()`)), await text("#now-label"));
  check("S0b 映像の上に、4つ(左手のひら・左手の甲・右手のひら・右手の甲)が、出る。先頭が、『次』(current)", (await ev(`[...document.querySelectorAll("#step-badges .badge")].map((e) => e.textContent.replace(/^[✓▶] /, "")).join(",")`)) === "左手のひら,左手の甲,右手のひら,右手の甲" && (await ev(`document.querySelector("#step-badges .badge").classList.contains("current")`)) && !(await ev(`document.getElementById("step-badges").hidden`)));
  await setHand({ hand: "right", facing: "palm", scale: 0.8, curl: 1 });   // 左手の番に、右手(まだ1枚も撮っていない)
  await waitFor(`document.querySelectorAll("#step-badges .badge")[2].classList.contains("current")`, "右手から始める", 8000).catch(() => {});
  check("S1 まだ1枚も撮っていない時に、逆の手(右手)が、先に映ったら、右手から始める(右手のひらが『次』。『右手が、先に映ったので、右手から始めます』)", (await stepClass(2)) === "current" && (await stepClass(0)) === "todo" && /次は、「右手のひら」/.test(await text("#mode-help")) && /右手が、先に映ったので、右手から始めます/.test(await text("#seq-note")), await text("#seq-note"));
  check("S1a 右手から始まった時は、左上の表示も、『撮影中: 右手のひら』", /^撮影中: 右手のひら$/.test(await text("#now-label")), await text("#now-label"));
  check("S1b 『いま見えている手』に、『右手の手のひら側』が、出る", /右手の手のひら側/.test(await text("#seen")), await text("#seen"));
  await setHand({ hand: "left", facing: "palm", scale: 0.8, curl: 1 });   // また、左手が映ったら、左手から
  await waitFor(`document.querySelectorAll("#step-badges .badge")[0].classList.contains("current")`, "左手から始める", 8000).catch(() => {});
  check("S1c また左手が映ると、左手のひらが『次』に戻る(まだ1枚も撮っていない間は、映った手から、始める)", (await stepClass(0)) === "current" && /左手が、先に映ったので、左手から始めます/.test(await text("#seq-note")), await text("#seq-note"));
  const np0 = await nailPix({ hand: "left", facing: "palm", scale: 0.8, curl: 1 });
  check("S1d 手のひらを撮る番では、爪の四角(水色)は、出ない", np0.a < 30, JSON.stringify(np0));
  await setHand({ hand: "left", facing: "palm", scale: 0.8 });
  let got = true;
  try { await waitDone(0, "左手のひら"); } catch { got = false; await diag(); }
  check("S2 左手のひらを、約1秒、保つと、自動で撮れて、項目が、緑(done)になる", got);
  if (got) {
    check("S3 撮れた項目に、写真(blob)の小さな絵と、『撮り直す』が出る。次は『左手の甲』。カメラの画面は、止まらない(隠れない)", /^blob:/.test(await ev(`document.querySelector("#steps li.done img.thumb").src`)) && (await ev(`document.querySelectorAll("#steps li.done button").length`)) === 1 && (await stepClass(1)) === "current" && /次は、「左手の甲」/.test(await text("#mode-help")) && !(await ev(`document.getElementById("camera-view").hidden`)), await text("#mode-help"));
    check("S3b 撮れて、次の項目に移ると、左上の表示も、変わる(『撮影中: 左手の甲』)", /^撮影中: 左手の甲$/.test(await text("#now-label")), await text("#now-label"));
    check("S3s 撮れた直後に、「撮れました」が、映像の真ん中に、大きく出る(撮れました / 左手のひら / 次は、左手の甲)。文字は、大きい(30px 以上)", (await ev(`!document.getElementById("shot-banner").hidden`)) && (await text("#shot-banner-title")) === "撮れました" && (await text("#shot-banner-item")) === "左手のひら" && (await text("#shot-banner-next")) === "次は、左手の甲" && (await ev(`parseFloat(getComputedStyle(document.getElementById("shot-banner-title")).fontSize) >= 30`)), await text("#shot-banner"));
    check("S4 撮った直後の案内: 『撮れました: 左手のひら。次は、左手の甲です』。『左手のひらを、撮りました』と、出る。『保存(1枚)』が、押せる", /撮れました: 左手のひら。次は、左手の甲です/.test(await guide()) && /左手のひらを、撮りました/.test(await text("#seq-note")) && (await text("#save-all")) === "保存(1枚)" && !(await ev(`document.getElementById("save-all").disabled`)), (await guide()) + " / " + (await text("#seq-note")));
    await waitFor(`document.getElementById("shot-banner").hidden`, "大きな表示が、消える", 8000).catch(() => {});
    check("S3t 「撮れました」の大きな表示は、約3秒で、消える(そのあと、撮影の邪魔にならない)", await ev(`document.getElementById("shot-banner").hidden`));
    check("S5 次は左手の甲なので、手のひらの手では、案内が『手の甲を、カメラに、向けてください』(チェックの項目名は、『手の甲側』)", await (async () => { await waitGuide("手の甲を、カメラに、向けてください"); return (await ev(`[...document.querySelectorAll("#checks li")].some((li) => li.textContent.includes("手の甲側"))`)); })());
    await setHand({ hand: "right", facing: "back", scale: 0.8, curl: 1 });   // 1枚撮った後は、逆の手が映っても、始める手は、変えない
    await waitGuide("左手を、映してください(いまは、右手です)");
    await sleep(800);
    check("S5b 1枚撮った後は、逆の手が映っても、手は、切り替えない(『左手を、映してください(いまは、右手です)』。次は、左手の甲のまま)", (await stepClass(1)) === "current" && (await stepClass(2)) === "todo", await stepClass(1));
    await setHand({ hand: "left", facing: "back", scale: 0.8, curl: 1 });
    await sleep(800);
    const np1 = await nailPix({ hand: "left", facing: "back", scale: 0.8, curl: 1 });
    check("S5c 手の甲を撮る番では、爪の四角(水色)が、指先の先まで、出る(人差し指の、指先の側の辺の、真ん中の画素が、水色)", np1.a > 150 && np1.b - np1.r > 100 && np1.g - np1.r > 80, JSON.stringify(np1));
    check("S6 保存ボタンは、1つだけ(「保存(○枚)」)。項目ごとの『保存』『爪を保存』と、『爪を全部、保存』は、無い。項目ごとには、『撮り直す』だけ", (await ev(`[...document.querySelectorAll("#seq-panel button")].filter((b) => b.textContent.includes("保存")).length`)) === 1 && (await ev(`document.querySelectorAll('#steps button[data-act="save"], #steps button[data-act="save-nails"], #save-nails-all').length`)) === 0 && (await ev(`document.querySelectorAll('#steps li.done button[data-act="retake"]').length`)) === 1, await text("#save-all"));
    // 残りの3つ
    await setHand({ hand: "left", facing: "back", scale: 0.8 });
    let g2 = true; try { await waitDone(1, "左手の甲"); } catch { g2 = false; await diag(); }
    check("S7 左手の甲が、撮れて、緑になる。次は『右手のひら』", g2 && (await stepClass(2)) === "current" && /次は、「右手のひら」/.test(await text("#mode-help")), await text("#mode-help"));
    // 爪(指先)の写真: 手の甲だけ。5枚。大きさは、四角の大きさ(画素)。 押すと、拡大
    const nailRects = fingertipRects(makeHand({ hand: "left", facing: "back", scale: 0.8, frame: V }).lm, V);
    const expectSizes = nailRects.map((r) => [Math.max(8, Math.round(r.w)), Math.max(8, Math.round(r.h))]);
    await waitFor(`document.querySelectorAll('#steps li[data-i="1"] img.nail-thumb').length === 5`, "爪の写真(5枚)", 8000).catch(() => {});
    await sleep(300);
    const nailInfo = await ev(`[...document.querySelectorAll('#steps li[data-i="1"] img.nail-thumb')].map((e) => [e.naturalWidth, e.naturalHeight, e.src.slice(0, 5)])`);
    check("S7b 手の甲を撮ると、爪(指先)の写真が、5枚、切り出される(blob)。大きさは、四角の大きさ(画素)と、同じ。手のひらには、無い", nailInfo.length === 5 && nailInfo.every((n, k) => n[2] === "blob:" && Math.abs(n[0] - expectSizes[k][0]) <= 1 && Math.abs(n[1] - expectSizes[k][1]) <= 1) && (await ev(`document.querySelectorAll('#steps li[data-i="0"] img.nail-thumb').length`)) === 0 && /爪\(指先\)の写真を、5枚、切り出しました/.test(await text("#seq-note")), JSON.stringify([nailInfo, expectSizes]));
    await ev(`document.querySelector('#steps li[data-i="1"] img.nail-thumb').click(); true`);
    check("S7c 爪の写真(小さい絵)を押すと、拡大して、表示される(左手の甲 — 親指。1 / 5。押した写真と、同じ絵)", !(await ev(`document.getElementById("lightbox").hidden`)) && /左手の甲 — 親指\(1 \/ 5。/.test(await text("#lightbox-cap")) && (await ev(`document.getElementById("lightbox-img").src === document.querySelector('#steps li[data-i="1"] img.nail-thumb').src`)), await text("#lightbox-cap"));
    await ev(`document.querySelector('#lightbox button[data-lb="next"]').click(); true`);
    check("S7d 「次へ」で、人差し指に、替わる(2 / 5)。拡大の画面は、閉じない", !(await ev(`document.getElementById("lightbox").hidden`)) && /左手の甲 — 人差し指\(2 \/ 5。/.test(await text("#lightbox-cap")), await text("#lightbox-cap"));
    await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); true`);
    check("S7e Esc で、拡大の画面が、閉じる。もう一度、開いて、どこかを押すと、閉じる", (await ev(`document.getElementById("lightbox").hidden`)) && await (async () => { await ev(`document.querySelector('#steps li[data-i="1"] img.nail-thumb').click(); true`); const opened = !(await ev(`document.getElementById("lightbox").hidden`)); await ev(`document.getElementById("lightbox-cap").click(); true`); return opened && (await ev(`document.getElementById("lightbox").hidden`)); })());
    await setHand({ hand: "right", facing: "palm", scale: 0.8 });
    let g3 = true; try { await waitDone(2, "右手のひら"); } catch { g3 = false; await diag(); }
    check("S8 右手のひらが、撮れて、緑になる。次は『右手の甲』", g3 && (await stepClass(3)) === "current" && /次は、「右手の甲」/.test(await text("#mode-help")), await text("#mode-help"));
    await setHand({ hand: "right", facing: "back", scale: 0.8 });
    let g4 = true; try { await waitDone(3, "右手の甲"); } catch { g4 = false; await diag(); }
    check("S9 右手の甲が、撮れて、4つ全部、緑になる。『4つ、全部、撮れました』と、案内する。『保存(14枚。全体の写真 4 + 爪 10)』", g4 && (await ev(`document.querySelectorAll("#steps li.done").length`)) === 4 && /4つ、全部、撮れました/.test(await guide()) && /4つ、全部、撮れました/.test(await text("#mode-help")) && (await text("#save-all")) === "保存(14枚)", await guide());
    check("S9s 4つ目が撮れた直後は、大きな表示の、3行目が『4つ、全部、撮れました』(右手の甲)", (await ev(`!document.getElementById("shot-banner").hidden`)) && (await text("#shot-banner-item")) === "右手の甲" && (await text("#shot-banner-next")) === "4つ、全部、撮れました", await text("#shot-banner"));
    await ev(`window.__handNow = null; true`);
    await sleep(500);
    check("S9a 全部、撮れたら、左上の表示は、『全部、撮れました』(緑)", (await text("#now-label")) === "全部、撮れました" && (await ev(`document.getElementById("now-label").classList.contains("done")`)), await text("#now-label"));
    check("S9b 全部、撮れたら、枠は緑。ガイド(うすい形)は、出さない(手が無い画面で、ガイドの画素が、0)", (await ev(`document.getElementById("stage").classList.contains("ok")`)) && (await guidePix()).n === 0, JSON.stringify(await guidePix()));
    check("S9c 映像の上の4つ(横一列)が、全部、緑(done)。左から、左手のひら・左手の甲・右手のひら・右手の甲。映像の、上にある", (await ev(`[...document.querySelectorAll("#step-badges .badge.done")].length`)) === 4 && (await ev(`(() => { const b = [...document.querySelectorAll("#step-badges .badge")].map((e) => e.getBoundingClientRect()); const st = document.getElementById("stage").getBoundingClientRect(); return b.every((r) => Math.abs(r.top - b[0].top) < 1) && b[0].left < b[1].left && b[1].left < b[2].left && b[2].left < b[3].left && b.every((r) => r.bottom <= st.top + 1); })()`)), await ev(`[...document.querySelectorAll("#step-badges .badge")].map((e) => e.className + ":" + e.textContent).join(" | ")`));
    // 保存: 共有が使えない端末は、14個のダウンロード。使える端末は、共有の画面に、14枚を、渡す
    await ev(`document.getElementById("save-all").click(); true`);
    await sleep(5200);
    const dl4 = await ev(`window.__downloads`);
    check("S10 「保存」で、14枚(全体の写真 4枚 + 爪の写真 10枚)が、ダウンロードされる(ファイル名は、日付・時刻つき。爪には、指の名前)", dl4.length === 14 && ["left_palm", "left_back", "right_palm", "right_back"].every((k) => dl4.some((d) => new RegExp("^hand_" + k + "_" + String.fromCharCode(92) + "d{8}_" + String.fromCharCode(92) + "d{6}" + String.fromCharCode(92) + ".jpg$").test(d.download))) && ["left", "right"].every((h) => ["thumb", "index", "middle", "ring", "pinky"].every((k) => dl4.some((d) => d.download.startsWith("hand_" + h + "_back_nail_" + k + "_")))) && dl4.every((d) => d.href === "blob:"), JSON.stringify(dl4.map((d) => d.download)));
    await ev(`navigator.canShare = () => true; navigator.share = async (d) => { window.__shared.push(d.files.map((f) => [f.name, f.type, f.size > 100])); }; true`);
    await ev(`document.getElementById("save-all").click(); true`);
    await sleep(500);
    const sh = await ev(`window.__shared`);
    check("S11 共有が使える端末(iPhone など)では、14枚(jpeg。全体の写真 4 + 爪 10)を、まとめて、共有の画面に、渡す。ダウンロードは、増えない", sh.length === 1 && sh[0].length === 14 && sh[0].every((f) => f[1] === "image/jpeg" && f[2] === true) && (await ev(`window.__downloads.length`)) === 14, JSON.stringify(sh));
    await ev(`delete navigator.share; delete navigator.canShare; true`);
    // 撮り直す
    await ev(`document.querySelector('#steps li.done button[data-act="retake"]').click(); true`);
    check("S12 「撮り直す」で、その項目が、『次(current)』に戻り、案内が、変わる。『保存(13枚)』", (await stepClass(0)) === "current" && /次は、「左手のひら」/.test(await text("#mode-help")) && (await text("#save-all")) === "保存(13枚)", await text("#mode-help"));
    // 最初から(確認の窓は、「はい」にして)。 そのあと、右手が先に映れば、右手から始める。 左上を、自分で押して、選べば、手が違っても、変えない
    // 最初から、撮り直す: 1回目では、消えない(ボタンの文字が、変わる。4秒で、元に戻る)。 2回目で、消える。 確認の窓(confirm)は、使わない
    await ev(`window.__handNow = null; window.__confirmCalled = false; window.confirm = () => { window.__confirmCalled = true; return true; }; document.getElementById("reset-all").click(); true`);
    check("S12b 「最初から、撮り直す」を、1回押しても、消えない。ボタンが『もう一度、押すと、全部、消えます』(赤)に変わる。確認の窓(confirm)は、出さない", (await text("#reset-all")) === "もう一度、押すと、全部、消えます" && (await ev(`document.getElementById("reset-all").classList.contains("danger")`)) && (await ev(`document.querySelectorAll("#steps li.done").length`)) > 0 && !(await ev(`window.__confirmCalled`)), await text("#reset-all"));
    await sleep(4500);
    check("S12c 押さずに、4秒たつと、ボタンは、元(『最初から、撮り直す』)に戻る。写真は、消えていない", (await text("#reset-all")) === "最初から、撮り直す" && !(await ev(`document.getElementById("reset-all").classList.contains("danger")`)) && (await ev(`document.querySelectorAll("#steps li.done").length`)) > 0);
    await ev(`document.getElementById("reset-all").click(); document.getElementById("reset-all").click(); true`);
    check("S13 「最初から、撮り直す」で、全部、未(todo)に戻り、先頭が『次』。『保存(0枚)』は、押せない", (await ev(`document.querySelectorAll("#steps li.done").length`)) === 0 && (await stepClass(0)) === "current" && (await ev(`document.getElementById("save-all").disabled`)), await text("#save-all"));
    await setHand({ hand: "right", facing: "palm", scale: 0.8, curl: 1 });
    await waitFor(`document.querySelectorAll("#step-badges .badge")[2].classList.contains("current")`, "やり直した後の、右手から始める", 8000).catch(() => {});
    check("S13b やり直した後も、右手が先に映れば、右手から始める(右手のひらが『次』)。その後の順番は、右手のひら → 右手の甲 → 左手のひら → 左手の甲", (await stepClass(2)) === "current", await stepClass(2));
    await setHand({ hand: "left", facing: "palm", scale: 0.8, curl: 1 });
    await waitFor(`document.querySelectorAll("#step-badges .badge")[0].classList.contains("current")`, "左手が映って、左手へ戻る", 8000).catch(() => {});
    await ev(`document.querySelectorAll("#step-badges .badge")[2].click(); true`);   // 自分で、右手のひらを、選ぶ(左手が映っているのに)
    await sleep(1200);
    check("S14 左上の、まだ撮っていない項目(右手のひら)を、自分で押すと、それが『次』になる。左手が映っていても、勝手に、左手へは、変わらない。案内は『右手を、映してください(いまは、左手です)』", (await stepClass(2)) === "current" && (await stepClass(0)) === "todo" && /次は、「右手のひら」/.test(await text("#mode-help")) && /右手を、映してください\(いまは、左手です\)/.test(await guide()), (await text("#mode-help")) + " / " + (await guide()));
    // 手動の「撮影」ボタン: 条件が、そろっていなくても、いまの項目を、撮る
    await setHand({ hand: "right", facing: "palm", scale: 0.8, curl: 1 });
    check("S15 「撮影」ボタンは、4つの撮影では、見えている", !(await ev(`document.getElementById("shoot").hidden`)));
    await ev(`document.getElementById("shoot").click(); true`);
    let gm = true; try { await waitDone(2, "手動の撮影"); } catch { gm = false; }
    check("S16 「撮影」ボタンで、いつでも、手動で撮れる(いまの項目が、緑になる。次は、右手の甲)", gm && /右手のひらを、撮りました/.test(await text("#seq-note")) && (await stepClass(3)) === "current", await text("#seq-note"));
  }

  // 撮影を切る(?capture=0): 条件がそろっても、撮らない。検出は、続く。「撮影」ボタンも、無い
  await load("?fake=1&capture=0&tilt=0");
  await waitFor(`document.getElementById("video").videoWidth > 0 && /手の検出の、準備ができました/.test(document.getElementById("status").textContent)`, "準備(撮影オフ)", 20000);
  check("B22a ?capture=0 では、「撮影」ボタンが、隠れている", await ev(`document.getElementById("shoot").hidden`));
  await setHand({ hand: "left", facing: "palm", scale: 0.8 });
  await waitGuide("そのまま、止めてください");
  await sleep(2500);
  check("B22 条件が、全部そろっても、撮らない(項目は、緑にならない)。枠は、緑のまま、検出が、続く", (await stepClass(0)) === "current" && (await ev(`document.getElementById("stage").classList.contains("ok")`)), await stepClass(0));
  await setHand({ hand: "left", facing: "back", scale: 0.8 });
  await waitGuide("手のひらを、カメラに、向けてください");
  check("B23 そのあとも、検出が、続いている(手の甲に変えると、ガイドが、変わる)", true);
  await setHand({ hand: "left", facing: "palm", scale: 0.8, curl: 1 });
  await load("?fake=1");
  await waitFor(`document.getElementById("video").videoWidth > 0 && /手の検出の、準備ができました/.test(document.getElementById("status").textContent)`, "準備(撮影オン)", 20000);

  // ガイドの傾き(腕の角度): 標準で、傾く(左手は、画面で見て、右へ。 前面カメラ=鏡の、元の映像では、左へ)。 傾けた手(同じ傾き)なら、緑。 逆に傾けた手は、白
  const gTilt = makeGuide(V, { hand: "left", facing: "palm", tilt: GUIDE_TILT_DEG, mirror: true });   // この試験の画面は、前面カメラ(鏡)
  await setHand({ hand: "left", facing: "palm", scale: 0.8, curl: 1, rot: gTilt.tilt });
  let gtp = { n: 0 };
  for (let k = 0; k < 80; k++) { gtp = await guidePix(); if (gtp.n > 50 && gtp.g - gtp.r > 50) break; await sleep(100); }
  check("T1 ガイドは、標準で、腕の角度に合わせて、傾く(前面カメラ=鏡で、元の映像では、左手は、左へ 15度)。同じ傾きの手を重ねると、ガイドは、緑", gTilt.tilt === -GUIDE_TILT_DEG && gtp.n > 50 && gtp.g - gtp.r > 50, JSON.stringify([gTilt.tilt, gtp]));
  await setHand({ hand: "left", facing: "palm", scale: 0.8, curl: 1, rot: -gTilt.tilt });
  for (let k = 0; k < 80; k++) { gtp = await guidePix(); if (gtp.n > 50 && Math.abs(gtp.g - gtp.r) < 20) break; await sleep(100); }
  check("T2 逆に傾けた手(30度ずれ)では、ガイドは、白(重なっていない)", gtp.n > 50 && Math.abs(gtp.g - gtp.r) < 20, JSON.stringify(gtp));

  // 画面の並び: 広い画面(PC)は、映像の右に、チェックと数字。狭い画面(スマホ)は、1列
  const place = () => ev(`(() => { const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }; return { stage: r("stage"), checks: r("checks"), numbers: r("numbers-text"), open: document.getElementById("numbers").open, vw: window.innerWidth }; })()`);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  let pl = await place();
  const pl19 = await ev(`(() => { const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; }; return { num: r("numbers-text"), h: window.innerHeight }; })()`);
  check("B19 広い画面(1280 × 800)では、確認用の数字が、はじめから開いていて、映像の、右に、並ぶ。確認用の数字の枠も、画面の中(下に、スクロールしなくても、見える)に、収まる", pl.numbers.left >= pl.stage.right - 1 && pl.checks.left >= pl.stage.right - 1 && pl19.num.top < pl19.h, JSON.stringify({ stage: [pl.stage.top, pl.stage.bottom], numTop: pl19.num.top, h: pl19.h }));
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  pl = await place();
  check("B20 狭い画面(390)では、1列(チェックが、映像の、下)。横に、はみ出さない", pl.checks.top >= pl.stage.bottom - 1 && (await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`)), JSON.stringify({ stageBottom: pl.stage.bottom, checksTop: pl.checks.top }));
  await send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });

  // カメラの切り替え
  await ev(`document.getElementById("flip").click(); true`);
  await waitFor(`document.getElementById("video").videoWidth > 0`, "切り替え後の映像", 10000);
  check("B15 「カメラを切り替える」で、映像が、続く", true);
  check("B16 ページのエラーは、出ていない", pageErrors.length === 0, pageErrors.join(" | "));
  const external = [...hosts].filter((h) => h !== "127.0.0.1:" + HTTP_PORT);
  check("B17 通信した先は、この画面の置き場所だけ(外のサイトへの、通信は、無い)", external.length === 0, JSON.stringify(external));
  check("B18 読み込んだのは、手のモデル(models/hand_landmarker.task)と、MediaPipe の部品だけ(顔のモデルなどは、無い)", requested.includes("/models/hand_landmarker.task") && !requested.some((n) => /face_/.test(n)), JSON.stringify(requested.filter((n) => /models|wasm/.test(n))));
  // ---- C. PWA(manifest、アイコン、サービスワーカー、オフライン) ----
  await load("");
  await waitFor(`document.readyState === "complete" && /手の検出の、準備ができました/.test(document.getElementById("status").textContent)`, "準備(PWA の確認)", 30000);
  const pwa = await ev(`(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    const m = link ? await (await fetch(link.href)).json() : null;
    const icon = async (src) => { const b = await (await fetch(src)).blob(); const bm = await createImageBitmap(b); return [bm.width, bm.height, b.type]; };
    return {
      manifest: m,
      icons: m ? await Promise.all(m.icons.map((i) => icon(i.src))) : [],
      touch: !!document.querySelector('link[rel="apple-touch-icon"]'),
      theme: (document.querySelector('meta[name="theme-color"]') || {}).content || null,
      regs: (await navigator.serviceWorker.getRegistrations()).length,
      licenses: (await fetch("licenses.txt")).ok,
    };
  })()`);
  check("C1 manifest.webmanifest が、読める(名前『手の撮影』、全画面 standalone、色、アイコン 192 と 512)", !!pwa.manifest && pwa.manifest.short_name === "手の撮影" && pwa.manifest.display === "standalone" && pwa.manifest.start_url === "./" && pwa.manifest.theme_color === "#0f172a" && pwa.manifest.icons.length === 2, JSON.stringify(pwa.manifest));
  check("C2 アイコン(192 × 192 と 512 × 512 の、PNG)が、読める。apple-touch-icon と、theme-color もある", pwa.icons.length === 2 && pwa.icons[0][0] === 192 && pwa.icons[0][1] === 192 && pwa.icons[1][0] === 512 && pwa.icons[1][1] === 512 && pwa.icons.every((i) => i[2] === "image/png") && pwa.touch && pwa.theme === "#0f172a", JSON.stringify([pwa.icons, pwa.touch, pwa.theme]));
  check("C3 この PC(127.0.0.1)では、ふつうに開いても、サービスワーカーは、登録しない(古い物が、残らない)。ライセンスの表示(licenses.txt)が、読める", pwa.regs === 0 && pwa.licenses, JSON.stringify([pwa.regs, pwa.licenses]));

  // ?sw=1 の時だけ、登録する(試験用)。 初めの読み込みで、登録 → 覚える。 もう一度、読み込むと、大きな物(MediaPipe、手のモデル)も、覚える
  await load("?sw=1");
  await waitFor(`navigator.serviceWorker.ready.then(() => true)`, "サービスワーカーの準備", 20000);
  await sleep(1500);
  const sw1 = await ev(`(async () => { const keys = await caches.keys(); const c = await caches.open("hand-photo-web-v1"); const names = (await c.keys()).map((r) => new URL(r.url).pathname); return { keys, names, active: !!(await navigator.serviceWorker.getRegistration()).active }; })()`);
  check("C4 ?sw=1 では、サービスワーカーが、登録され、動き出す。コード(index.html、app.js、guide.mjs、hand_setup.mjs、style.css、manifest、アイコン、licenses.txt)を、覚える", sw1.active && sw1.keys.includes("hand-photo-web-v1") && ["/", "/index.html", "/app.js", "/guide.mjs", "/hand_setup.mjs", "/style.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/licenses.txt"].every((n) => sw1.names.includes(n)), JSON.stringify(sw1));
  await load("?sw=1");
  await waitFor(`/手の検出の、準備ができました/.test(document.getElementById("status").textContent)`, "2回目の読み込み(SW あり)", 30000);
  await sleep(800);
  const heavy = await ev(`(async () => { const c = await caches.open("hand-photo-web-heavy-v1"); return (await c.keys()).map((r) => new URL(r.url).pathname); })()`);
  check("C5 2回目の読み込みで、大きな物(手のモデル、MediaPipe の部品)も、覚える(別の箱)", heavy.includes("/models/hand_landmarker.task") && heavy.includes("/lib/mediapipe/vision_bundle.mjs") && heavy.some((n) => n.endsWith(".wasm")), JSON.stringify(heavy));
  // ネットを切って(オフライン)、開く: 覚えた物だけで、動く
  await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await load("");
  await waitFor(`/手の検出の、準備ができました/.test(document.getElementById("status").textContent)`, "オフラインでの起動", 30000).catch(() => {});
  const off = await ev(`({ status: document.getElementById("status").textContent, version: document.getElementById("version").textContent, steps: document.querySelectorAll("#step-badges .badge").length })`);
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check("C6 ネットを切っても(オフライン)、開ける。手のモデルも、読み込める(覚えた物だけで、動く)", /手の検出の、準備ができました/.test(off.status) && /^版: app v\d+ \/ guide v\d+$/.test(off.version) && off.steps === 4, JSON.stringify(off));
  await ev(`navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).then(() => caches.keys()).then((ks) => ks.forEach((k) => caches.delete(k))); true`);
  check("C7 ページのエラーは、出ていない(PWA の確認の間も)", pageErrors.length === 0, pageErrors.join(" | "));
  void sizeAfterA;
} catch (e) {
  console.log("試験が、途中で止まりました: " + e.message);
  failures.push("途中停止");
} finally {
  await cleanup();
}
console.log(failures.length === 0 ? "\napp_smoke_test: すべて通りました" : "\napp_smoke_test: 失敗 " + failures.length + " 件: " + failures.join(" / "));
process.exit(failures.length === 0 ? 0 : 1);
