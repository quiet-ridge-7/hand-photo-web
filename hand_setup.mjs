// hand_setup.mjs — MediaPipe(手の点を見つける部品)を、準備する。app.js からは、createHandLandmarker() を呼ぶだけ。
import { HandLandmarker, FilesetResolver } from "./lib/mediapipe/vision_bundle.mjs";

const WASM_DIR = "./lib/mediapipe/wasm";                  // MediaPipe の計算部分(WASM)の場所
const MODEL_PATH = "./models/hand_landmarker.task";       // 手のモデルの場所

// 手の点(21個)を見つける「HandLandmarker」を作って、返す(時間がかかるので async)
export async function createHandLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
  // モデルは、場所ではなく、中身(バイト列)で渡す(MediaPipe が、日本語を含む場所を、開けないことがあるため)
  const modelBuffer = await fetch(MODEL_PATH).then((r) => {
    if (!r.ok) throw new Error("手のモデルを、読み込めませんでした(" + r.status + ")");
    return r.arrayBuffer();
  });
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: new Uint8Array(modelBuffer) },
    runningMode: "VIDEO",                 // 動画(1コマずつ、続けて調べる)
    numHands: 1,                          // 手は、1つだけ
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}
