/**
 * 积分账本 —— 签到攒积分、兑换扣积分
 *
 * 与 quotes.js / shared-data.js 一样，同一份文件同时兼容三种环境：
 *   Node（测试） / 微信小程序（require） / 浏览器（window.Points）
 * 所以以后接云开发时**只改这个文件**，预览页和小程序一起生效。
 *
 * ⚠️ 积分是「各人各自的」：我签到攒我的，TA 签到攒 TA 的。
 *    如果你想改成两人共用一个积分池，把 CONFIG.shared 改成 true 即可
 *    （共用时 key 里不带 uid，两人读写同一份）。
 *
 * 目前后端 provider='local' → localStorage。
 * 小程序端接云开发时：本文件的方法体换成 wx.cloud.callFunction，
 * 函数签名不变，页面代码一行不用动。
 */

var CONFIG = {
  provider: 'local',   // 'local' | 'cloud'
  shared: false,       // 两人是否共用一个积分池
  roomId: 'demo-room'
}

/**
 * 每次签到发多少积分。
 * 520 = 我爱你；配合商品价（52.0 / 5.2 / 13.14 / 520 / 5200）刚好：
 *   签一次 ≈ 10 次视频通话、100 次陪陪我、1 次"一起弄"，见面要攒 10 天。
 */
var SIGNIN_AMOUNT = 520

/** 内存兜底：既没有 wx 也没有 localStorage 时（比如 Node 跑自检）用它，至少不报错 */
var memStore = {}

/**
 * 积分保留两位小数。
 * 商品价里有 52.0 / 5.2 / 13.14 这种（52=我爱你、1314=一生一世），
 * 不取整；每次写账都过一遍 round2，免得浮点数攒出 5186.860000001 这种尾巴。
 */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

var LS_PREFIX = 'couple_points_'

/* ============ 存储适配层 ============ */
function storeKey(uid) {
  return CONFIG.shared
    ? LS_PREFIX + CONFIG.roomId + '_both'
    : LS_PREFIX + CONFIG.roomId + '_' + (uid || 'A')
}

function safeGet(uid) {
  try {
    var key = storeKey(uid)
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      var v = wx.getStorageSync(key)
      if (v === '' || v === undefined || v === null) return null
      return (typeof v === 'string') ? JSON.parse(v) : v
    }
    if (typeof localStorage !== 'undefined') {
      var raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    }
  } catch (e) { /* 落到内存兜底 */ }
  return Object.prototype.hasOwnProperty.call(memStore, storeKey(uid)) ? memStore[storeKey(uid)] : null
}

function safeSet(uid, value) {
  try {
    var key = storeKey(uid)
    if (typeof wx !== 'undefined' && wx.setStorageSync) {
      wx.setStorageSync(key, value)
      return true
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value))
      return true
    }
  } catch (e) { /* 落到内存兜底 */ }
  memStore[storeKey(uid)] = value
  return true
}

/* ============ 订阅（浏览器里跨窗口同步，方便两个窗口验效果） ============ */
var listeners = []

function emit(data) {
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](data) } catch (e) { /* 单个回调出错不影响其他 */ }
  }
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', function (ev) {
    if (!ev.key || ev.key.indexOf(LS_PREFIX) !== 0) return
    var v = null
    try { v = ev.newValue ? JSON.parse(ev.newValue) : null } catch (e) { /* ignore */ }
    emit(v)
  })
}

function watch(cb) {
  listeners.push(cb)
  return function () {
    var i = listeners.indexOf(cb)
    if (i >= 0) listeners.splice(i, 1)
  }
}

/* ============ 日期 ============ */
function dateKey(d) {
  if (typeof d === 'string') return d.slice(0, 10)
  var t = d || new Date()
  var m = t.getMonth() + 1
  var day = t.getDate()
  return t.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day)
}

/** 今天是否已签到 */
function signedToday(uid, now) {
  var d = safeGet(uid)
  return !!(d && d.lastSign && d.lastSign === dateKey(now))
}

/** 读账本：{ points, lastSign, signDays } */
function get(uid) {
  var d = safeGet(uid) || {}
  return {
    points: typeof d.points === 'number' ? round2(d.points) : 0,
    lastSign: d.lastSign || '',
    signDays: typeof d.signDays === 'number' ? d.signDays : 0
  }
}

/** 只读积分数字 */
function getPoints(uid) {
  return get(uid).points
}

/** 直接设积分（调试 / 预览用，不累加） */
function setPoints(uid, n) {
  var d = get(uid)
  d.points = Math.max(0, round2(n))
  safeSet(uid, d)
  emit(d)
  return d
}

/**
 * 签到：一天只能签一次，签了发 SIGNIN_AMOUNT。
 * @param {string} uid
 * @param {Date|string} [now] 可传入指定"今天"，便于测试
 * @returns {{ok:boolean, already:boolean, gained:number, points:number, signDays:number, lastSign:string}}
 */
function signIn(uid, now) {
  var d = get(uid)
  var today = dateKey(now)

  if (d.lastSign === today) {
    return {
      ok: false, already: true, gained: 0,
      points: d.points, signDays: d.signDays, lastSign: d.lastSign
    }
  }

  // 昨天签过 → 连续天数 +1；断了 → 重新从 1 开始
  var y = new Date((typeof now === 'string' ? new Date(now) : (now || new Date())).getTime())
  y.setDate(y.getDate() - 1)
  var cont = d.lastSign === dateKey(y)

  d.points = round2(d.points + SIGNIN_AMOUNT)
  d.lastSign = today
  d.signDays = cont ? d.signDays + 1 : 1
  safeSet(uid, d)
  emit(d)

  return {
    ok: true, already: false, gained: SIGNIN_AMOUNT,
    points: d.points, signDays: d.signDays, lastSign: d.lastSign
  }
}

/**
 * 扣积分（兑换用）。不够就不扣，返回 ok:false。
 * @returns {{ok:boolean, points:number, short:number}}
 */
function spend(uid, amount) {
  var d = get(uid)
  var n = Math.max(0, round2(amount))
  if (d.points < n) {
    return { ok: false, points: d.points, short: round2(n - d.points) }
  }
  d.points = round2(d.points - n)
  safeSet(uid, d)
  emit(d)
  return { ok: true, points: d.points, short: 0 }
}

/** 加积分（送分 / 补偿用） */
function add(uid, amount) {
  var d = get(uid)
  d.points = round2(d.points + Math.max(0, round2(amount)))
  safeSet(uid, d)
  emit(d)
  return { ok: true, points: d.points }
}

/** 清空账本（调试用） */
function reset(uid) {
  var empty = { points: 0, lastSign: '', signDays: 0 }
  safeSet(uid, empty)
  emit(empty)
  return empty
}

var api = {
  CONFIG: CONFIG,
  SIGNIN_AMOUNT: SIGNIN_AMOUNT,
  dateKey: dateKey,
  get: get,
  getPoints: getPoints,
  setPoints: setPoints,
  signedToday: signedToday,
  signIn: signIn,
  spend: spend,
  add: add,
  reset: reset,
  watch: watch
}

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.Points = api

/* ============================================================
   小程序端接云开发（现在没生效）

   1) 集合 couple_rooms，每条房间文档里加一个字段：
      points: { "<openidA>": 520, "<openidB>": 0 }     // 双方各自从 0 开始
      （如果两人共用积分池，就只留一个 pointsPool: 520）
   2) 云函数 signIn()
      - 服务端取「今天」的日期（不要信客户端的日期，否则改手机时间就能刷积分）
      - 查 pointsLog 集合里今天有没有该 openid 的记录 → 有就返回 already
      - 没有就 _.inc(520) 并写一条流水
   3) 云函数 exchange(goodsId)
      - 校验 goodsId 存在、积分够 → 扣分 + 写兑换记录（等对方履约）
   4) 积分流水建议单独一个集合 points_log：
      { roomId, uid, type: 'signin'|'exchange', amount, goodsId, createdAt }
      这样以后能出「积分明细」页面，也不用怕账对不上。
   ============================================================ */
