// dy-running Service Worker · v3
// 修复：Safari 26 PWA fetch schedule.json 被 SW 兜底成空 {}，导致页面永远"载入中"
//
// 变更点（v2 → v3）：
//   1. 缓存版本号 v2 → v3（触发 activate 自动清理 v2 旧缓存）
//   2. schedule.json 失败时不再兜底成 '{}'，而是返回 '{"__error__":true,"reason":"sw-network-fail"}'
//   3. schedule.json 带 ?t= 时间戳的请求直接放行（不拦截）→ 避免 SW 拦截导致缓存污染
//   4. index.html 检测到 __error__ 会显示「重试」按钮，UI 不再永远卡"载入中"
//
// 保留 v2 的修复：
//   - 只缓存 res.ok === true 的响应（避免缓存 null）
//   - fetch 出错时 fallback 到 index.html 而不是直接返回 null
//   - 跳过非 http(s) 协议

const CACHE = 'dy-running-v4';
const STATIC_ASSETS = [
  './',
  './index.html',
  './export.html',
  './schedule.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .catch(err => console.warn('[SW] install cache addAll 失败（不致命）：', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => {
        console.log('[SW] 删除旧缓存：', k);
        return caches.delete(k);
      }))
    )
  );
  self.clients.claim();
});

function isCacheable(res) {
  // 只缓存有效响应：状态 200-299 且是 basic/cors 类型
  if (!res || !res.ok) return false;
  if (res.status === 206) return false; // partial content
  if (res.type === 'opaque' || res.type === 'opaqueredirect') return false;
  return true;
}

function safePut(cache, req, res) {
  if (!isCacheable(res)) return Promise.resolve();
  return cache.put(req, res).catch(err => {
    console.warn('[SW] put 失败（不致命）：', err);
  });
}

self.addEventListener('fetch', event => {
  const req = event.request;

  // 只处理 GET
  if (req.method !== 'GET') return;

  // 跳过非 http(s) 协议（chrome-extension, data, blob 等）
  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol)) return;

  // 跳过浏览器内部请求
  if (url.pathname.startsWith('/__')) return;

  // —— 课表 JSON：network-first，失败时返回 __error__ 而非 '{}' —— //
  if (url.pathname.endsWith('/schedule.json') || url.pathname.endsWith('schedule.json')) {
    // 带 ?t= 时间戳的请求 → 直接放行（绕过 SW，根治缓存污染）
    if (url.search.includes('t=')) {
      return; // 不调用 event.respondWith，让浏览器正常 fetch
    }

    event.respondWith(
      fetch(req)
        .then(res => { safePut(caches.open(CACHE), req, res.clone()); return res; })
        .catch(() => {
          // 失败时尝试缓存，缓存也没有就返回带 __error__ 的 JSON
          return caches.match(req).then(r => {
            if (r) return r;
            return new Response(
              JSON.stringify({ __error__: true, reason: 'sw-network-fail', ts: Date.now() }),
              { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
            );
          });
        })
    );
    return;
  }

  // —— HTML 导航请求：network-first，回退到缓存的 index.html —— //
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then(res => { safePut(caches.open(CACHE), req, res.clone()); return res; })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
        .catch(() => new Response('<!doctype html><meta charset=utf-8><title>dy 跑步 · 离线</title><body style="font-family:-apple-system,sans-serif;padding:40px;text-align:center"><h2>📴 离线 + 无缓存</h2><p>请联网后打开 <a href="./">首页</a></p></body>', {
          status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }
        }))
    );
    return;
  }

  // —— 其他静态资源：cache-first，回退网络 —— //
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (url.origin === location.origin) safePut(caches.open(CACHE), req, res.clone());
        return res;
      }).catch(err => {
        console.warn('[SW] fetch 失败：', req.url, err);
        return new Response('', { status: 504 });
      });
    })
  );
});

// —— 接收页面消息：清缓存 / 强制刷新 —— //
self.addEventListener('message', event => {
  if (event.data === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => event.source.postMessage('CACHE_CLEARED'));
  }
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
