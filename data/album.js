/**
 * 共同相册 —— 数据层（纯逻辑，无 DOM）
 * ------------------------------------------------------------
 * 为什么单独一个文件：index.html 一直有别的会话在改。模块自带数据 + 渲染 + 样式后，
 * 接进 index.html 只需要插几小段，碰撞窗口从上千行压到几行。做法同 period.js / period-ui.js。
 *
 * 环境兼容：Node（跑测试） / 微信小程序（require） / 浏览器（window.Album）
 *
 * ⚠️ 必须用 IIFE 包起来：index.html 是用 <script> 直接引这个文件的，
 *    顶层 var 会变成全局变量 —— points.js 里已经有个全局 CONFIG 了，
 *    这里再声明一个 CONFIG 会把商城的 provider 覆盖掉。
 *
 * ============================================================
 * 当前 provider = 'local'（纯前端演示版）
 * ------------------------------------------------------------
 * 照片存 localStorage，值是 dataURL。**这不是最终方案**，是故意的：
 * 交接文档-共同相册.md §3 方案 C —— 先把排版和交互做完，云端就绪后只换实现。
 * 和天气的 mock → amap 一个思路，页面代码一行不用动。
 *
 * ⚠️ localStorage 一般只有 5~10MB，压缩后一张约 80~150KB，
 *    所以这个版本大概能放 **30~50 张**，超了会明确报错（不静默丢数据）。
 *    接云开发（wx.cloud.uploadFile）后没有这个限制。
 *
 * ⚠️ 小程序端接云开发时要改的只有这个文件：
 *    1. CONFIG.provider = 'cloud'
 *    2. readAll/writeAll 换成云数据库集合 couple_albums（一条文档一张照片）
 *    3. addMany 里先 wx.compressImage 再 wx.cloud.uploadFile，拿 fileID 存进 fileID 字段
 *    4. srcOf() 改成用云函数发临时链接（**不要在客户端持有长期可读地址**）
 *    5. remove() 要同时删云存储文件和数据库记录，别留孤儿文件
 *    详见 交接文档-共同相册.md §6~§9
 */

;(function (root) {
  'use strict'

  var CONFIG = {
    provider: 'local',        // 'local' | 'cloud'
    roomId: 'demo-room',
    /** 压缩参数：长边像素 + JPEG 质量。手机原图 5~10MB，不压会撑爆存储 */
    maxEdge: 1000,
    quality: 0.72
  }

  var KEY_PREFIX = 'couple_album_'
  var MAX_EDGE_HARD = 1600     // 再大就别往本地存了

  /** 预览数据（?seed=demo）。非 null 时读走它、写只改内存，绝不落盘 */
  var PREVIEW = null

  /* ============ 存储（localStorage，Node 下退化成内存） ============ */

  var MEM = null               // 没有 localStorage 时的兜底（Node 测试用）

  /**
   * ★ 外部存储钩子（接加密同步用）。
   *
   * setStore({ readAll, writeAll }) 之后，相册的读写全部交给它 ——
   * 手机上是 AppState 提供的那两个函数（见 data/app-shared.js 与 app-state.js
   * 的 albumPhotos / setAlbumPhotos），所以照片会跟着私有 Gist 加密同步，
   * **两台手机才真能互相看到**。
   *
   * 不设置时行为完全不变（localStorage），所以小程序端和自测脚本都不受影响。
   */
  var STORE = null

  function setStore(store) {
    if (!store || typeof store.readAll !== 'function' || typeof store.writeAll !== 'function') return false
    STORE = store
    emit(readAll())
    return true
  }

  /** 当前是不是接了加密同步（UI 用它决定要不要提示"只在手机里"） */
  function synced() { return !!STORE }

  /**
   * 外部（同步层）拿到新数据之后叫一下 → 相册页面重画。
   * 没有它的话，对方的照片其实已经拉回来了，但页面不会自己更新，
   * 用户会以为"没同步"（要退出重进才看得到）。
   */
  function refresh() {
    emit(readAll())
    return true
  }

  function hasLS() {
    try {
      return typeof localStorage !== 'undefined' && !!localStorage
    } catch (e) { return false }
  }

  function key() {
    return KEY_PREFIX + CONFIG.roomId
  }

  function readAll() {
    if (STORE) {
      try {
        var a = STORE.readAll()
        return Object.prototype.toString.call(a) === '[object Array]' ? a : []
      } catch (e) { /* 出错退回本机存储 */ }
    }
    if (!hasLS()) return MEM ? MEM.slice() : []
    try {
      var raw = localStorage.getItem(key())
      var arr = raw ? JSON.parse(raw) : []
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : []
    } catch (e) {
      console.warn('[album] 读本地相册失败，当成空相册', e)
      return []
    }
  }

  /**
   * 写回。**失败必须让调用方知道** —— 相册最怕的就是"以为存上了，其实没存"。
   * @returns {{ok:boolean, quota:boolean, error?:Error}}
   */
  function writeAll(arr) {
    if (STORE) {
      try {
        var r0 = STORE.writeAll(arr)
        return { ok: !(r0 && r0.ok === false), quota: false }
      } catch (e) {
        return { ok: false, quota: false, error: e }
      }
    }
    if (!hasLS()) { MEM = arr.slice(); return { ok: true, quota: false } }
    try {
      localStorage.setItem(key(), JSON.stringify(arr))
      return { ok: true, quota: false }
    } catch (e) {
      var quota = !!(e && (
        e.name === 'QuotaExceededError' ||
        e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        e.code === 22 || e.code === 1014
      ))
      return { ok: false, quota: quota, error: e }
    }
  }

  /* ============ 订阅：本地改动 + 跨窗口 storage 事件 ============ */

  var listeners = []

  function emit(photos) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](photos) } catch (e) { /* 单个回调出错不影响其他 */ }
    }
  }

  function watch(cb) {
    listeners.push(cb)
    return function () {
      var i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    }
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', function (ev) {
      // 只关心相册自己的键（别的模块的键也走这个事件）
      if (!ev.key || ev.key.indexOf(KEY_PREFIX) !== 0) return
      emit(readAll())
    })
  }

  /* ============ 基础工具 ============ */

  function now() { return Date.now() }

  function rand4() {
    return Math.random().toString(36).slice(2, 6)
  }

  function makeId() {
    return 'p_' + now() + '_' + rand4()
  }

  /** 本地演示版：fileID 字段直接放 dataURL；云版放 cloud:// 的 fileID */
  function srcOf(p) {
    if (!p) return ''
    if (CONFIG.provider === 'cloud') return TEMP_URL[p.fileID] || PLACEHOLDER
    return p.fileID || ''
  }

  var TEMP_URL = {}            // fileID → 临时链接（云版用）
  var PLACEHOLDER = ''         // 云版拿不到链接时的占位图，见 placeholder()

  /** 读照片列表，**按时间倒序**（新的在前） */
  function list() {
    var arr = readAll().slice()
    arr.sort(function (a, b) { return (b.uploadedAt || 0) - (a.uploadedAt || 0) })
    return arr
  }

  /** 展示区用的：只要没被隐藏的 */
  function visible() {
    return list().filter(function (p) { return !p.hidden })
  }

  function hiddenList() {
    return list().filter(function (p) { return !!p.hidden })
  }

  function get(id) {
    var arr = PREVIEW || readAll()
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]
    return null
  }

  /**
   * 预览模式（?seed=demo）下所有写操作只改内存，**绝不落盘**。
   * 否则演示数据的 id 会混进真实相册，用户下次打开会看到一堆假照片。
   */
  function previewMutate(fn) {
    var arr = (PREVIEW || []).slice()
    var res = fn(arr)
    PREVIEW = arr
    emit(arr)
    return res
  }

  function counts() {
    var arr = readAll()
    var h = 0
    for (var i = 0; i < arr.length; i++) if (arr[i].hidden) h++
    return { total: arr.length, visible: arr.length - h, hidden: h }
  }

  /* ============ 写操作 ============ */

  /**
   * 批量加照片（上传完调用）。
   * @param {Array} photos 至少要有 fileID / width / height，其余自动补
   * @param {string} uid 上传者
   * @returns {{ok:boolean, added:number, photos:Array, quota:boolean, error?:Error}}
   */
  function addMany(photos, uid) {
    var arr = readAll()
    var added = []

    /* 时间戳必须**严格大于已存在的所有照片**：
       只写 now() 的话，同一毫秒内的两批上传会排错序
       （上一批的第 2 张带 +1 偏移，会盖过这一批的第 1 张）。
       所以基准取 max(现在, 已存在的最大时间戳 + 1)。 */
    var maxAt = 0
    for (var m = 0; m < arr.length; m++) {
      if ((arr[m].uploadedAt || 0) > maxAt) maxAt = arr[m].uploadedAt || 0
    }
    var t = Math.max(now(), maxAt + 1)

    for (var i = 0; i < photos.length; i++) {
      var p = photos[i]
      if (!p || !p.fileID) continue
      added.push({
        id: p.id || makeId(),
        fileID: p.fileID,
        uploaderUid: uid || p.uploaderUid || 'A',
        uploadedAt: p.uploadedAt || (t + i),   // +i 保证同一批内的顺序稳定
        width: p.width || 0,
        height: p.height || 0,
        size: p.size || 0,
        hidden: !!p.hidden,                    // 新上传默认「展示」
        hiddenBy: p.hiddenBy || '',
        hiddenAt: p.hiddenAt || 0,
        caption: p.caption || ''
      })
    }
    if (!added.length) return { ok: false, added: 0, photos: [], quota: false }

    if (PREVIEW) {
      return previewMutate(function (arr) {
        for (var k = 0; k < added.length; k++) arr.push(added[k])
        return { ok: true, added: added.length, photos: added, quota: false }
      })
    }

    var next = arr.concat(added)
    var r = writeAll(next)
    if (!r.ok) return { ok: false, added: 0, photos: [], quota: r.quota, error: r.error }

    emit(next)
    return { ok: true, added: added.length, photos: added, quota: false }
  }

  /** 单张：隐藏 / 取消隐藏 */
  function setHidden(id, hidden, uid) {
    return setHiddenMany([id], hidden, uid)
  }

  /**
   * 批量隐藏 / 取消隐藏。
   * 用户要的是「选择哪些不展示」，默认全部展示 —— 所以这里是 hidden=true 的入口。
   */
  function setHiddenMany(ids, hidden, uid) {
    var want = {}
    for (var i = 0; i < ids.length; i++) want[ids[i]] = true

    if (PREVIEW) {
      return previewMutate(function (arr) {
        var n0 = 0
        for (var a = 0; a < arr.length; a++) {
          if (!want[arr[a].id]) continue
          var before0 = !!arr[a].hidden
          arr[a].hidden = !!hidden
          arr[a].hiddenBy = arr[a].hidden ? (uid || 'A') : ''
          arr[a].hiddenAt = arr[a].hidden ? now() : 0
          if (before0 !== arr[a].hidden) n0++
        }
        return { ok: true, changed: n0, quota: false }
      })
    }

    var arr = readAll()
    var n = 0
    for (var j = 0; j < arr.length; j++) {
      if (!want[arr[j].id]) continue
      var before = !!arr[j].hidden
      arr[j].hidden = !!hidden
      if (arr[j].hidden) {
        arr[j].hiddenBy = uid || arr[j].hiddenBy || ''
        arr[j].hiddenAt = now()
      } else {
        arr[j].hiddenBy = ''
        arr[j].hiddenAt = 0
      }
      if (before !== arr[j].hidden) n++
    }

    var r = writeAll(arr)
    if (!r.ok) return { ok: false, changed: 0, quota: r.quota, error: r.error }
    emit(arr)
    return { ok: true, changed: n, quota: false }
  }

  /** 配文 */
  function setCaption(id, caption) {
    if (PREVIEW) {
      return previewMutate(function (arr) {
        for (var a = 0; a < arr.length; a++) {
          if (arr[a].id === id) arr[a].caption = String(caption || '').slice(0, 60)
        }
        return { ok: true, quota: false }
      })
    }
    var arr = readAll()
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id) arr[i].caption = String(caption || '').slice(0, 60)
    }
    var r = writeAll(arr)
    if (r.ok) emit(arr)
    return r
  }

  /**
   * 删除照片。双方都能删（用户 2026-10-10 定的），UI 侧要自己加二次确认。
   * ⚠️ 云版必须同时删云存储文件，否则留下孤儿文件白占额度。
   */
  function remove(ids) {
    var want = {}
    for (var i = 0; i < ids.length; i++) want[ids[i]] = true

    if (PREVIEW) {
      return previewMutate(function (arr) {
        var kept0 = []
        var n0 = 0
        for (var a = 0; a < arr.length; a++) {
          if (want[arr[a].id]) n0++
          else kept0.push(arr[a])
        }
        arr.length = 0
        for (var b = 0; b < kept0.length; b++) arr.push(kept0[b])
        return { ok: true, removed: n0, quota: false }
      })
    }

    var arr = readAll()
    var kept = []
    var removed = []
    for (var j = 0; j < arr.length; j++) {
      if (want[arr[j].id]) removed.push(arr[j])
      else kept.push(arr[j])
    }

    var r = writeAll(kept)
    if (!r.ok) return { ok: false, removed: 0, quota: r.quota, error: r.error }

    // 云版在这里补：wx.cloud.deleteFile({ fileList: removed.map(p => p.fileID) })
    emit(kept)
    return { ok: true, removed: removed.length, quota: false }
  }

  /** 清空（调试用） */
  function clear() {
    if (PREVIEW) { PREVIEW = []; emit([]); return { ok: true } }
    writeAll([])
    emit([])
    return { ok: true }
  }

  /* ============ 压缩（浏览器 / 小程序都可用） ============ */

  /**
   * 把 File / Blob 压成 dataURL。
   * 手机原图 5~10MB，直接上传会：慢、卡、烧额度 —— 所以这一步不能省。
   * @returns {Promise<{fileID:string, width:number, height:number, size:number}>}
   */
  function compress(file, opts) {
    var maxEdge = (opts && opts.maxEdge) || CONFIG.maxEdge
    var quality = (opts && opts.quality) || CONFIG.quality

    return new Promise(function (resolve, reject) {
      if (typeof document === 'undefined' || typeof Image === 'undefined') {
        reject(new Error('当前环境不支持压缩（没有 DOM）'))
        return
      }
      var url = URL.createObjectURL(file)
      var img = new Image()
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width
          var h = img.naturalHeight || img.height
          var scale = Math.min(1, maxEdge / Math.max(w, h))
          var cw = Math.max(1, Math.round(w * scale))
          var ch = Math.max(1, Math.round(h * scale))

          var cv = document.createElement('canvas')
          cv.width = cw
          cv.height = ch
          var ctx = cv.getContext('2d')
          // 白底：手机里的 PNG 透明区压成 JPEG 会变黑
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, cw, ch)
          ctx.drawImage(img, 0, 0, cw, ch)

          var dataUrl = cv.toDataURL('image/jpeg', quality)
          URL.revokeObjectURL(url)
          resolve({
            fileID: dataUrl,
            width: cw,
            height: ch,
            size: Math.round(dataUrl.length * 0.75)   // base64 → 字节数，约值
          })
        } catch (e) {
          try { URL.revokeObjectURL(url) } catch (e2) { /* ignore */ }
          reject(e)
        }
      }
      img.onerror = function () {
        try { URL.revokeObjectURL(url) } catch (e) { /* ignore */ }
        reject(new Error('这张图读不出来（可能不是图片格式）'))
      }
      img.src = url
    })
  }

  /* ============ 占位图 / 演示数据 ============ */

  /** 一张柔粉渐变的占位图（云版拿不到临时链接时用，保证网格不出现裂图） */
  function placeholder() {
    if (PLACEHOLDER) return PLACEHOLDER
    PLACEHOLDER = svgPhoto('#FFE7F1', '#FFD3E6', '📷', '')
    return PLACEHOLDER
  }

  /**
   * 生成一张 SVG 占位照片（dataURL）。
   * 演示数据和云版占位都用它 —— 不依赖任何外部图片文件，
   * 所以 ?seed=demo 出图时不用先准备素材。
   */
  function svgPhoto(c1, c2, emoji, label) {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">' +
        '<defs>' +
          '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="0" stop-color="' + c1 + '"/>' +
            '<stop offset="1" stop-color="' + c2 + '"/>' +
          '</linearGradient>' +
        '</defs>' +
        '<rect width="600" height="600" fill="url(#g)"/>' +
        // 柔光用径向渐变，不用负偏移的装饰元素（会把 scrollWidth 撑满）
        '<circle cx="430" cy="150" r="150" fill="#FFFFFF" opacity=".35"/>' +
        '<circle cx="120" cy="500" r="120" fill="#FFFFFF" opacity=".22"/>' +
        '<text x="300" y="325" font-size="150" text-anchor="middle" ' +
          'dominant-baseline="middle">' + emoji + '</text>' +
        (label
          ? '<text x="300" y="450" font-size="34" text-anchor="middle" ' +
            'fill="#FFFFFF" font-family="sans-serif" font-weight="700">' + label + '</text>'
          : '') +
      '</svg>'
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  }

  /** 演示用的配色 + emoji（和设计令牌同一批色系） */
  var DEMO_KIT = [
    ['#FFE7F1', '#FFC8DE', '🌸', '一起看的花'],
    ['#EAF3FB', '#CFE4F5', '🌊', '海边那天'],
    ['#FDF0E2', '#F6DCC0', '🍰', '你做的蛋糕'],
    ['#F1EDFB', '#DDD4F3', '🌙', '晚安'],
    ['#FFEFF4', '#FBD5DC', '💗', '第一次牵手'],
    ['#FFF3F8', '#FFDCEA', '🐷', '糯米'],
    ['#FDF0E2', '#F3D9BE', '☕', '楼下那家'],
    ['#EAF3FB', '#D3E6F7', '⛅', '阴天散步'],
    ['#F1EDFB', '#D9CFF2', '🎬', '电影'],
    ['#FFE7F1', '#FCC9DF', '🎂', '生日'],
    ['#FFF3F8', '#F8DCEA', '🧋', '奶茶'],
    ['#FDF0E2', '#F0D4B6', '🚗', '接你下班']
  ]

  /**
   * 生成演示照片（**只在内存里，不落盘**）。
   * 出图 / 给别人看效果用，照 period.js 的 ?seed= 一个思路。
   * @param {number} n 张数
   * @param {number} hiddenCount 其中几张标成「已隐藏」（看隐藏态的样子）
   */
  function demoPhotos(n, hiddenCount) {
    n = Math.max(1, Math.min(DEMO_KIT.length, n || 9))
    hiddenCount = hiddenCount || 0
    var out = []
    var t = now()
    for (var i = 0; i < n; i++) {
      var k = DEMO_KIT[i % DEMO_KIT.length]
      // 倒着排时间：i 越大越早，这样 list() 倒序后顺序和 DEMO_KIT 一致
      var at = t - i * 26 * 3600 * 1000 - i * 60000
      out.push({
        id: 'demo_' + i,
        fileID: svgPhoto(k[0], k[1], k[2], ''),
        uploaderUid: (i % 3 === 2) ? 'B' : 'A',
        uploadedAt: at,
        width: 600,
        height: 600,
        size: 120000,
        // 前 hiddenCount 张（= 最新的几张）标成隐藏，方便看隐藏态
        hidden: i < hiddenCount,
        hiddenBy: i < hiddenCount ? 'A' : '',
        hiddenAt: i < hiddenCount ? at + 3600000 : 0,
        caption: k[3]
      })
    }
    return out
  }

  /**
   * 临时预览模式：读盘 → 改成演示数据，**不写回**。
   * 这样出图脚本能看到有内容的样子，又不会污染真实账本。
   */
  function listWithPreview() {
    return PREVIEW ? PREVIEW.slice().sort(function (a, b) {
      return (b.uploadedAt || 0) - (a.uploadedAt || 0)
    }) : list()
  }

  function setPreview(photos) {
    PREVIEW = photos ? photos.slice() : null
    emit(listWithPreview())
  }

  function isPreview() { return !!PREVIEW }

  /* ============ 日期（复用项目里统一的键格式 YYYY-MM-DD） ============ */

  function dateKey(d) {
    if (typeof d === 'string') return d.slice(0, 10)
    var t = d ? new Date(d) : new Date()
    var m = t.getMonth() + 1
    var day = t.getDate()
    return t.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day)
  }

  /** 2026-10-10 12:30 → 「10月10日 12:30」；今天/昨天说人话 */
  function friendlyTime(ts, nowTs) {
    if (!ts) return ''
    var d = new Date(ts)
    var base = nowTs ? new Date(nowTs) : new Date()
    var hh = d.getHours()
    var mm = d.getMinutes()
    var hm = (hh < 10 ? '0' + hh : hh) + ':' + (mm < 10 ? '0' + mm : mm)

    var day0 = dateKey(base)
    var day1 = dateKey(new Date(base.getTime() - 86400000))
    var day = dateKey(d)
    if (day === day0) return '今天 ' + hm
    if (day === day1) return '昨天 ' + hm
    if (d.getFullYear() === base.getFullYear()) {
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm
    }
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
  }

  /** 谁传的 → 显示名（两人自用，A/B 就叫「我 / TA」） */
  function whoLabel(uid, myUid) {
    if (!uid) return ''
    return uid === (myUid || 'A') ? '我' : 'TA'
  }

  /** 字节数 → 人话 */
  function fmtSize(bytes) {
    var n = Number(bytes) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }

  var api = {
    CONFIG: CONFIG,
    setStore: setStore,
    synced: synced,
    refresh: refresh,
    MAX_EDGE_HARD: MAX_EDGE_HARD,

    list: listWithPreview,
    visible: function () { return listWithPreview().filter(function (p) { return !p.hidden }) },
    hiddenList: function () { return listWithPreview().filter(function (p) { return !!p.hidden }) },
    get: get,
    counts: function () {
      if (!PREVIEW) return counts()
      var arr = PREVIEW, h = 0
      for (var i = 0; i < arr.length; i++) if (arr[i].hidden) h++
      return { total: arr.length, visible: arr.length - h, hidden: h }
    },
    srcOf: srcOf,

    addMany: addMany,
    setHidden: setHidden,
    setHiddenMany: setHiddenMany,
    setCaption: setCaption,
    remove: remove,
    clear: clear,
    watch: watch,

    compress: compress,
    svgPhoto: svgPhoto,
    demoPhotos: demoPhotos,
    setPreview: setPreview,
    isPreview: isPreview,

    dateKey: dateKey,
    friendlyTime: friendlyTime,
    whoLabel: whoLabel,
    fmtSize: fmtSize,
    makeId: makeId
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.Album = api
})(typeof window !== 'undefined' ? window : null)
