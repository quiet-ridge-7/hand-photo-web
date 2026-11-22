// sw.js — サービスワーカー(手の撮影アプリ)。 2回目からの読み込みを速くし、ネットが無くても、動くようにする。
//   コード(index.html、app.js など)は、「ネットを先に」(新しい物が、すぐ、反映される)。 ネットが、だめな時だけ、覚えた物を使う。
//   大きな物(lib/ の MediaPipe、models/ の手のモデル。約22MB)は、「覚えた物を先に」。 初めての時だけ、ネットで取る。
//   写真や、映像は、ここには、入らない(この端末の、メモリの中だけ)。 外のサイトとは、通信しない。
const VERSION = "v1";   // コードを変えて、覚えた物を、入れ替えたい時は、ここを上げる
const CACHE_NAME = "hand-photo-web-" + VERSION;
const HEAVY_CACHE = "hand-photo-web-heavy-v1";   // 大きな物を、入れる、別の箱(ふだんは、入れ替えない)

const FILES = ["./", "index.html", "app.js", "guide.mjs", "hand_setup.mjs", "style.css", "manifest.webmanifest", "icon-192.png", "icon-512.png", "licenses.txt"];

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;                       // 箱にあれば、それを返す
  const response = await fetch(request);           // なければ、ネットで取る
  if (response.ok) {                               // 正しく取れた時だけ、箱に入れる(コピーを入れる)
    const cache = await caches.open(HEAVY_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("hand-photo-web") && k !== CACHE_NAME && k !== HEAVY_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;   // 外のサイト、GET 以外は、触らない
  const isHeavy = url.pathname.includes("/lib/") || url.pathname.includes("/models/");   // 大きな物か
  event.respondWith(isHeavy ? cacheFirst(event.request) : fetch(event.request).catch(() => caches.match(event.request)));
});
