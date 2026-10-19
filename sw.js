/* ============================================================
   恋爱小管家 · Service Worker
   ------------------------------------------------------------
   作用只有一个：让「添加到主屏幕」之后能装成 App（安卓 Chrome 会生成
   一个真的 WebAPK，桌面有图标、独立窗口）。顺带让断网时还能打开骨架。

   ⚠️ 三条硬规矩（写错会把 App 卡在旧版本，很难查）：
     1. **只碰同源请求**。GitHub API（同步）和高德（天气）都是跨域的，
        一律直接放行 —— 缓存它们会造成「明明联网却显示旧数据」。
     2. **代码类资源（.js/.css/.html）用网络优先**：改了代码刷新就能拿到，
        拿不到才退回缓存。用「缓存优先」的话更新会延迟一整个版本。
     3. **图片用缓存优先**：小猪素材不常变，省流量又快。
        换图片时把下面的 VERSION 改一下即可（旧缓存会被清掉）。

   改完这个文件记得同步改 VERSION，否则老缓存不会清。

   ★★ 2026-10-19 的教训（很严重，别再犯）：
      VERSION 从 `2026-10-11-5` 之后**连续多个版本都没升过**，
      而 index.html 的 APP_BUILD 一路升到 -15。
      结果：手机上的 Service Worker 认为"我的缓存还是最新的"，
      于是**一直跑 10-11 那一版的 js**。用户看到的就是
      「明明刷新了、版本号也变了，行为还是老样子」—— 甚至更迷惑：
      index.html 是新的、data/*.js 是旧的，两边对不上。

      现在起：**VERSION 必须和 index.html 的 APP_BUILD 保持一致**。
      `tools/check-syntax.js` 会检查这一条，不一致直接红。
   ============================================================ */

var VERSION = '2026-10-19-21'
var CACHE = 'couple-app-' + VERSION

/* 网络慢的时候最多等这么久（毫秒），超过就先把缓存拿出来用，
   网络那边继续跑，下次打开就是新的了。
   没有它的话每次打开都要把整个 App（约 2.6MB 的 js/css）从网上拉完才能显示，
   用户看到的就是"一进软件先转圈/加载框"（2026-10-11 用户报的）。 */
var NET_TIMEOUT = 1200

/* 预缓存：只放「没它 App 打不开」的最少几个。
   不预缓存全部素材 —— 清单容易和 index.html 走偏，运行时按需缓存更稳。 */
var SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
]

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) {
        /* 逐个 add：某个文件 404 也不会让整个安装失败 */
        return Promise.all(SHELL.map(function (u) {
          return c.add(new Request(u, { cache: 'reload' })).catch(function () { /* 缺了就跳过 */ })
        }))
      })
      .then(function () { return self.skipWaiting() })
  )
})

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k)
      }))
    }).then(function () { return self.clients.claim() })
  )
})

function isDoc(req, url) {
  if (req.mode === 'navigate') return true
  return /\/index\.html$/.test(url.pathname) || url.pathname.slice(-1) === '/'
}

function isCode(url) {
  return /\.(js|css|webmanifest)$/i.test(url.pathname) || /\/index\.html$/.test(url.pathname)
}

function isImage(url) {
  return /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(url.pathname)
}

/** 网络优先（带超时兜底）：拿得到就用新的（并写回缓存）；
 *  网络太慢就先用缓存把界面撑起来，网络那边继续更新缓存。
 *
 *  ⚠️ 纯"网络优先"的坑：手机上信号一般的时候，每次打开都要等整包
 *     js/css 下载完，界面一直空着（像浏览器在加载）。加这个超时之后，
 *     1.2 秒还没回来就先显示缓存版本 —— 快得多，代价是极端情况下
 *     这一次打开可能是上一版代码，下次打开就是新的。
 */
function networkFirst(req) {
  var net = fetch(req).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone()
      caches.open(CACHE).then(function (c) { c.put(req, copy) }).catch(function () {})
    }
    return res
  })

  return new Promise(function (resolve) {
    var settled = false
    var timer = setTimeout(function () {
      caches.match(req).then(function (hit) {
        if (!settled && hit) { settled = true; resolve(hit) }
      }).catch(function () { /* 缓存读不了就继续等网络 */ })
    }, NET_TIMEOUT)

    net.then(function (res) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(res)
    }).catch(function () {
      if (settled) return
      clearTimeout(timer)
      caches.match(req).then(function (hit) {
        settled = true
        /* 导航请求还没缓存过 → 退回缓存的 index.html，至少能开 */
        resolve(hit || caches.match('./index.html'))
      })
    })
  })
}

/** 缓存优先：命中就先用，同时在后台悄悄更新 */
function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    var net = fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone()
        caches.open(CACHE).then(function (c) { c.put(req, copy) }).catch(function () {})
      }
      return res
    }).catch(function () { return hit })
    return hit || net
  })
}

self.addEventListener('fetch', function (e) {
  var req = e.request
  if (req.method !== 'GET') return

  var url
  try { url = new URL(req.url) } catch (err) { return }

  /* ① 跨域一律不碰：GitHub Gist（同步）、高德（天气）都要实时 */
  if (url.origin !== self.location.origin) return

  if (isDoc(req, url) || isCode(url)) {
    e.respondWith(networkFirst(req))
    return
  }
  if (isImage(url)) {
    e.respondWith(cacheFirst(req))
    return
  }
  /* 其它同源资源：网络优先，失败就算了 */
  e.respondWith(networkFirst(req))
})
