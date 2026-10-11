/**
 * 共享数据层
 *
 * 需要两人同步的东西都走这里：
 *   - profile : 每个人的所在地、昵称（各自独立）
 *   - weather : 按城市缓存（双方可共用同城结果）
 *   - anniv   : 恋爱纪念日（**一份数据，两人同步改**）
 *
 * 后端可替换，接口不变：
 *   provider='local'  浏览器 / 预览：localStorage + storage 事件，
 *                     真能跨窗口实时同步，方便本地验证"一人改两人变"
 *   provider='cloud'  小程序：微信云开发数据库（见文件末尾说明）
 *
 * ⚠️⚠️ 整个文件必须包在自己的作用域里（下面的 IIFE），**不能裸写成全局函数**。
 *
 * 为什么（2026-10-11 查到的真实事故，用户报的「对方改了纪念日我这边看不到」）：
 *   index.html 是用一行行 <script> 直接加载的（不是打包器），所有文件的顶层
 *   声明**共用同一个全局作用域**。data/points.js 里也有一组同名函数
 *   safeGet / safeSet / emit / watch，后加载的那个会**覆盖**先加载的那个。
 *   实测结果：本文件里的 `safeSet('anniv', data)` 实际调到了 points.js 的
 *   `safeSet(uid, value)` —— 纪念日被写进积分自己的存储里，
 *   本文件读自己的时候读到 null，于是「怎么改都同步不出去」，
 *   而且**不报错**，查了半天。包一层作用域就彻底不会再互相抢名字。
 */
;(function (root) {
  'use strict'

var CONFIG = {
  provider: 'local',   // 'local' | 'cloud'
  roomId: 'demo-room'  // 情侣房间号；上线时用绑定得到的真实房间号
}

/* ============ 存储适配层 ============
 *
 * ⚠️ 这里必须同时支持两种环境，否则小程序端整个数据层是哑的：
 *   浏览器 / 预览 → localStorage（还能配合 storage 事件做跨窗口同步）
 *   小程序       → wx.getStorageSync / wx.setStorageSync
 *   Node（跑自检脚本）→ 都没有，退化成内存，至少不报错
 *
 * 早期版本只写了 localStorage 分支，结果小程序里所有 set 都是静默失败 ——
 * 表现为「改了没反应」「签到能无限重复加积分」，而且不报错，很难查。
 */
var LS_PREFIX = 'couple_shared_'

var memStore = {}          // Node / 异常环境的兜底

/**
 * ★ 同步真正的来源：AppState（加密同步那一份）。
 *
 * 为什么要有这一段（用户真实报的 bug）：本文件原来的 provider='local' 用的是
 * localStorage + `storage` 事件 —— **那只能在同一台电脑的两个窗口之间同步**
 * （同一台设备共用一个 localStorage）。两台手机各有各的存储，中间没有任何通道，
 * 所以「对方改了纪念日我这边看不到」是必然的，不是偶发。
 *
 * attachApp() 之后，读写一律走 AppState.state（它才跟着私有 Gist 加密同步走），
 * 本文件的其余逻辑（watch / 各字段的读写函数）一行不用改。
 * 没挂 AppState 时仍然退回 localStorage —— 模块单独打开、Node 自测都还能跑。
 */
var APP = null

/** 共享桶在 AppState.state 里的字段名（和本文件的 name 一一对应） */
var BUCKETS = ['profile', 'location', 'anniv', 'weather', 'pet', 'periodLog', 'periodSettings']

function attachApp(app) {
  if (!app || !app.state) return false
  APP = app
  var last = {}
  function snap() {
    var st = appStateRef() || {}
    for (var i = 0; i < BUCKETS.length; i++) {
      var n = BUCKETS[i]
      var s = JSON.stringify(typeof st[n] === 'undefined' ? null : st[n])
      if (last[n] === s) continue
      var isFirst = !(n in last)
      last[n] = s
      if (!isFirst) emit(n, st[n])     /* 对方的数据到了 → 页面自动刷新 */
    }
  }
  /* 云端拉下来的、本地改的都会回调 —— 首页天气/纪念日就是靠这个刷新 */
  if (app.subscribe) app.subscribe(snap)
  snap()
  return true
}

function appStateRef() {
  return (APP && APP.state) ? APP.state : null
}

/** 改 AppState 里的一个桶（走 mutate：会持久化 + 通知 UI + 排队上传） */
function appMutate(fn) {
  if (APP && APP.mutate) {
    APP.mutate(fn)
    return true
  }
  var s = appStateRef()
  if (!s) return false
  fn(s)
  return true
}

function storeGet(key) {
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      var v = wx.getStorageSync(key)
      return (v === '' || v === undefined) ? null : v
    }
    if (typeof localStorage !== 'undefined') {
      var raw = localStorage.getItem(key)
      return raw === null ? null : raw
    }
  } catch (e) { /* 落到内存兜底 */ }
  return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null
}

function storeSet(key, val) {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) {
      wx.setStorageSync(key, val)
      return true
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, val)
      return true
    }
  } catch (e) { /* 落到内存兜底 */ }
  memStore[key] = val
  return true
}

function lsKey(name) {
  return LS_PREFIX + CONFIG.roomId + '_' + name
}

function safeGet(name) {
  /* ★ 优先读 AppState（会同步的那一份）；它没有这个字段再退回本机存储 */
  var st = appStateRef()
  if (st && typeof st[name] !== 'undefined' && st[name] !== null) {
    return st[name]
  }
  // wx 的 storage 直接存对象，浏览器的 localStorage 只存字符串 —— 这里统一成「存对象」
  var v = storeGet(lsKey(name))
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch (e) { return null }
  }
  return v
}

function safeSet(name, value) {
  /* ★ 写进 AppState（会持久化 + 排队上传）；同时留一份本机旧的键，
     这样没配对 / 刚打开还没拉到云端时也有东西可显示（退路，不是主路径）。 */
  var st = appStateRef()
  if (st) {
    appMutate(function (s) { s[name] = value })
    try { storeSet(lsKey(name), value) } catch (e) { /* 退路失败不影响主路径 */ }
    return true
  }
  return storeSet(lsKey(name), value)
}

/* ============ 订阅（浏览器用 storage 事件，实现跨窗口同步） ============ */
var listeners = {}
var WATCHED = ['profile', 'weather', 'anniv', 'location', 'periodLog', 'periodSettings', 'pet']

function emit(name, value) {
  var list = listeners[name] || []
  for (var i = 0; i < list.length; i++) {
    try { list[i](value) } catch (e) { /* 单个回调出错不影响其他 */ }
  }
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', function (ev) {
    // ev.key 形如 couple_shared_<room>_<name>
    if (!ev.key) return
    for (var i = 0; i < WATCHED.length; i++) {
      var n = WATCHED[i]
      if (ev.key === lsKey(n)) {
        var v = null
        try { v = ev.newValue ? JSON.parse(ev.newValue) : null } catch (e) { /* ignore */ }
        emit(n, v)
        break
      }
    }
  })
}

/**
 * 监听某个共享字段的变化。
 * @param {string} name 'profile' | 'weather' | 'anniv'
 * @param {function} cb 回调，收到新值
 * @returns {function} 取消监听
 */
function watch(name, cb) {
  if (!listeners[name]) listeners[name] = []
  listeners[name].push(cb)
  return function () {
    var l = listeners[name] || []
    var idx = l.indexOf(cb)
    if (idx >= 0) l.splice(idx, 1)
  }
}

/* ============ profile：每个人的所在地 ============ */
/**
 * @param {string} uid 用户标识（小程序里用 openid）
 * @param {{name:string, city:string}} data
 */
function setProfile(uid, data) {
  var all = safeGet('profile') || {}
  all[uid] = Object.assign({}, all[uid], data, { updatedAt: Date.now() })
  safeSet('profile', all)
  emit('profile', all)
  return all
}

function getProfile(uid) {
  var all = safeGet('profile') || {}
  return uid ? (all[uid] || null) : all
}

/* ============ location：各自的经纬度（由设备定位后上报） ============ */
/**
 * 存自己的坐标。存进共享层后，对方也能读到，
 * 从而显示"你在哪、那边什么天气"。
 * @param {string} uid
 * @param {{lat:number, lon:number}} coord
 */
function setLocation(uid, coord) {
  if (!coord || typeof coord.lat !== 'number' || typeof coord.lon !== 'number') return null
  var all = safeGet('location') || {}
  all[uid] = {
    lat: Math.round(coord.lat * 10000) / 10000,
    lon: Math.round(coord.lon * 10000) / 10000,
    updatedAt: Date.now()
  }
  safeSet('location', all)
  emit('location', all)
  return all
}

function getLocation(uid) {
  var all = safeGet('location') || {}
  return uid ? (all[uid] || null) : all
}

/* ============ anniv：一份数据，两人同步 ============ */
function setAnnivStart(startKey, byUid) {
  var data = {
    startKey: startKey,
    updatedAt: Date.now(),
    updatedBy: byUid || ''
  }
  safeSet('anniv', data)
  emit('anniv', data)
  return data
}

function getAnnivStart() {
  var d = safeGet('anniv')
  return d && d.startKey ? d.startKey : null
}

/* ============ weather：按城市缓存 ============ */
function setWeather(city, data) {
  var all = safeGet('weather') || {}
  all[city] = data
  safeSet('weather', all)
  emit('weather', all)
  return all
}

function getWeather(city) {
  var all = safeGet('weather') || {}
  return city ? (all[city] || null) : all
}

/* ============ pet：小猪「糯米」的状态（两人共享同一只） ============
 *
 * 存的是「快照 + 上次结算时间」，不是死值 —— 谁打开谁按时间差补算，
 * 所以两人算出来一致，不需要服务端定时任务。
 * 数值公式全在 data/pet.js 里，这里只负责存取。
 *
 * 结构：{ v, mood, clean, energy, care, at, last:{uid:{act,t}}, pos:{rx,ry} }
 *   v     饱食度（历史字段名叫过 food，pet.js 里做了兼容）
 *   care  累计互动次数 = 亲密度，决定幼崽/半大/成年
 *   last  谁最后做了什么，用来显示「TA 15 分钟前喂食了」
 *   pos   挂件在屏幕上的相对位置，所以对方那边挂件也会挪到同一处
 */
function setPet(state) {
  if (!state || typeof state !== 'object') return null
  var v = Object.assign({}, state, { updatedAt: Date.now() })
  safeSet('pet', v)
  emit('pet', v)
  return v
}

function getPet() {
  return safeGet('pet') || null
}

/* ============ periodLog / periodSettings：例假记录（默认两人共享） ============ */
/**
 * 每日一条，键是 'YYYY-MM-DD'：
 *   { dateKey, flow, symptoms, moods, note, updatedAt, updatedBy }
 * 存进共享层后对方也能读到（这是本模块的设计目的：他能提前照顾她）。
 * 敏感数据 —— 详情与预测逻辑见 data/period.js。
 */
function setPeriodLog(uid, dateKey, data) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{1,2}-\d{1,2}$/.test(dateKey)) return null
  var all = safeGet('periodLog') || {}
  all[dateKey] = Object.assign({}, all[dateKey], data, {
    dateKey: dateKey,
    updatedAt: Date.now(),
    updatedBy: uid || (data && data.updatedBy) || ''
  })
  safeSet('periodLog', all)
  emit('periodLog', all)
  return all
}

function getPeriodLog(dateKey) {
  var all = safeGet('periodLog') || {}
  return dateKey ? (all[dateKey] || null) : all
}

/** 取全部记录（period.js 里再规范化 / 过滤空记录） */
function getPeriodLogs() {
  return safeGet('periodLog') || {}
}

function removePeriodLog(dateKey) {
  var all = safeGet('periodLog') || {}
  if (!all[dateKey]) return all
  delete all[dateKey]
  safeSet('periodLog', all)
  emit('periodLog', all)
  return all
}

/**
 * 周期设置：{ cycleLength, periodLength, updatedBy, updatedAt }
 * 只有一份，两人同步改（和纪念日同理）。
 */
function setPeriodSettings(data) {
  var prev = safeGet('periodSettings') || {}
  var next = Object.assign({}, prev, data, { updatedAt: Date.now() })
  safeSet('periodSettings', next)
  emit('periodSettings', next)
  return next
}

function getPeriodSettings() {
  return safeGet('periodSettings') || null
}

var api = {
  CONFIG: CONFIG,
  attachApp: attachApp,
  watch: watch,
  setProfile: setProfile,
  getProfile: getProfile,
  setLocation: setLocation,
  getLocation: getLocation,
  setAnnivStart: setAnnivStart,
  getAnnivStart: getAnnivStart,
  setWeather: setWeather,
  getWeather: getWeather,
  setPet: setPet,
  getPet: getPet,
  setPeriodLog: setPeriodLog,
  getPeriodLog: getPeriodLog,
  getPeriodLogs: getPeriodLogs,
  removePeriodLog: removePeriodLog,
  setPeriodSettings: setPeriodSettings,
  getPeriodSettings: getPeriodSettings
}

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.SharedData = api

})(typeof self !== 'undefined' ? self : this)

/* ============================================================
   小程序端接云开发时要建的东西（现在还没生效）

   1) 数据库集合 couple_rooms，一条文档代表一个情侣房间：
      {
        _id: "<roomId>",
        members: ["<openidA>", "<openidB>"],
        profiles: {
          "<openidA>": { name: "我", city: "杭州", updatedAt: 0 },
          "<openidB>": { name: "TA", city: "北京", updatedAt: 0 }
        },
        annivStart: "2026-05-20",      // ← 纪念日只存这一份，两人读同一字段
        annivUpdatedBy: "<openid>",
        annivUpdatedAt: 0
      }
      权限：仅创建者可读写 → 改成「所有用户可读，仅创建者可写」不行，
      因为两人都要写。正确做法是设为「仅管理端可写」，
      所有读写都走云函数（云函数带管理员权限），顺便做校验。

   2) 云函数 updateAnniv(startKey)
      - 校验 startKey 是合法日期、且不晚于今天
      - 用 _.set 更新 couple_rooms/<roomId>.annivStart
      - 返回最新值，让调用方立刻回显

   3) 同步方式（二选一）
      a. 实时推送：db.collection('couple_rooms').doc(roomId).watch({
           onChange: snapshot => 更新本地状态
         })
         优点：对方一改，自己页面立刻变，无需刷新
         注意：watch 需要小程序基础库 2.8.1+，且要在页面的 onUnload 里 close()
      b. 拉取式：页面 onShow 时 re-fetch 一次
         优点：简单、省连接；缺点：要切页面才看到对方的改动
      建议：纪念日用 a（改动少、即时可见），天气用 b（本来就每天变一次）

   4) 本地缓存策略
      云数据拿到后同样写一份到本地（共用本文件的 setAnnivStart 即可），
      断网时先显示缓存值并标记 stale，联网后再对齐。
   ============================================================ */
