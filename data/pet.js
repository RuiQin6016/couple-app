// 小猪「糯米」· 状态与数值
//
// 设计要点：**状态不存死值**。
//   存的是「快照 + 上次结算时间」，谁打开谁按时间差补算 —— 所以
//   两个人算出来的结果永远一致，不需要服务端定时任务，离线也在掉。
//
// 三个环境共用（Node / 小程序 / 浏览器），末尾同时判断 module.exports 和 window，
// 和 data/ 下其他模块一个规矩。

var HOUR = 3600 * 1000
var SLEEP_FROM = 23          // 23:00 ~ 08:00 自动睡
var SLEEP_TO = 8

/** 每小时衰减。刻意做慢：两人各自上班，一天照顾两三次就够 */
var DECAY = { food: 3.6, mood: 2.4, clean: 1.6 }
var ENERGY_UP = 12           // 睡觉时体力回升/小时
var ENERGY_DOWN = 1.2        // 醒着时体力掉/小时
var MAX_OFFLINE_H = 72       // 超过 3 天没管，按 3 天算（免得一回来全 0）

var DEFAULT = { food: 76, mood: 82, clean: 68, energy: 88 }

/** 动作表：界面和数值都从这里取，改数值只动这一处 */
var ACTIONS = {
  feed:  { img: 'pig_eat',   cls: 'eating',  label: '喂食',   msg: '吃饱啦 🍚',
           d: { food: 28, mood: 4, clean: -4 } },
  drink: { img: 'pig_drink', cls: 'eating',  label: '喝水',   msg: '喝饱水啦 💧',
           d: { food: 8, mood: 3, clean: 2 } },
  play:  { img: 'pig_happy', cls: 'petting', label: '逗它玩', msg: '好开心 💗',
           d: { mood: 26, energy: -8, food: -2 } },
  bath:  { img: 'pig_bath',  cls: 'washing', label: '洗澡',   msg: '香香的 🛁',
           d: { clean: 40, mood: -4 } }
}

var STAGES = [
  { min: 60, n: 3, name: '成年', cls: 'stage3', scale: 1.15 },
  { min: 25, n: 2, name: '半大', cls: 'stage2', scale: 1 },
  { min: 0,  n: 1, name: '幼崽', cls: 'stage1', scale: .82 }
]

function clamp(v) {
  v = Number(v)
  if (!isFinite(v)) v = 0
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10))
}

function isSleepHour(h) { return h >= SLEEP_FROM || h < SLEEP_TO }

function blank(now) {
  return {
    v: DEFAULT.food,
    mood: DEFAULT.mood,
    clean: DEFAULT.clean,
    energy: DEFAULT.energy,
    care: 0,                       // 累计互动次数 = 亲密度
    at: now || Date.now(),
    last: {},                      // uid -> { act, t }
    pos: null                      // 挂件位置 { rx, ry }（0~1，两人同步）
  }
}

/** 兼容各种半成品状态（字段名历史上变过），并补默认值 */
function normalize(s, now) {
  if (!s || typeof s !== 'object') return blank(now)
  if (typeof s.v !== 'number') s.v = (typeof s.food === 'number') ? s.food : DEFAULT.food
  if (typeof s.mood !== 'number') s.mood = DEFAULT.mood
  if (typeof s.clean !== 'number') s.clean = DEFAULT.clean
  if (typeof s.energy !== 'number') s.energy = DEFAULT.energy
  if (typeof s.care !== 'number') s.care = 0
  if (!s.at) s.at = now || Date.now()
  if (!s.last) s.last = {}
  return s
}

/** 按「上次结算时间」补算衰减。返回新对象，不改原对象 */
function settle(s, now) {
  now = now || Date.now()
  s = normalize(JSON.parse(JSON.stringify(s || {})), now)

  var hours = (now - s.at) / HOUR
  if (hours <= 0) { s.at = now; return s }

  var step = Math.min(hours, MAX_OFFLINE_H)
  s.v = clamp(s.v - DECAY.food * step)
  s.mood = clamp(s.mood - DECAY.mood * step)
  s.clean = clamp(s.clean - DECAY.clean * step)
  if (isSleepHour(new Date(now).getHours())) {
    s.energy = clamp(s.energy + ENERGY_UP * step)
  } else {
    s.energy = clamp(s.energy - ENERGY_DOWN * step)
  }
  s.at = now
  return s
}

function stageOf(care) {
  care = care || 0
  for (var i = 0; i < STAGES.length; i++) {
    if (care >= STAGES[i].min) return STAGES[i]
  }
  return STAGES[STAGES.length - 1]
}

/** 待机该用哪张图 */
function idleImg(s, now) {
  if (isSleepHour(new Date(now || Date.now()).getHours())) return 'pig_sleep'
  if (s.clean < 35) return 'pig_dirty'
  if (s.mood < 30) return 'pig_sad'
  return 'pig_stand'
}

/**
 * 做一次动作。返回 { state, action } —— 不改原对象。
 * @param {object} s      当前状态（会先被 settle）
 * @param {string} kind   feed / drink / play / bath
 * @param {string} uid    谁做的（用于「TA 刚喂过」）
 */
function act(s, kind, uid, now) {
  var a = ACTIONS[kind]
  if (!a) return { state: normalize(s, now), action: null }

  now = now || Date.now()
  s = settle(s, now)

  s.v = clamp(s.v + (a.d.food || 0))
  s.mood = clamp(s.mood + (a.d.mood || 0))
  s.clean = clamp(s.clean + (a.d.clean || 0))
  s.energy = clamp(s.energy + (a.d.energy || 0))
  s.care = (s.care || 0) + 1
  s.at = now
  s.last = s.last || {}
  s.last[uid || 'A'] = { act: a.label, t: now, uid: uid || 'A' }

  return { state: s, action: a }
}

/** 「TA 刚做过什么」文案。在 JS 里拼好，模板只绑定 */
function peerText(s, myUid, peerUid, now) {
  now = now || Date.now()
  var mine = s.last && s.last[myUid]
  var peer = s.last && s.last[peerUid]

  if (!peer) {
    return {
      none: true,
      text: mine ? ('你先' + mine.act + '了，等 TA 来 ~') : '还没有互动记录，先喂它一口吧'
    }
  }
  var mins = Math.round((now - peer.t) / 60000)
  var when = mins < 1 ? '刚刚'
    : (mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前')
  return { none: false, text: 'TA ' + when + peer.act + '了 · 亲密度 ' + (s.care || 0) }
}

var api = {
  HOUR: HOUR,
  DECAY: DECAY,
  DEFAULT: DEFAULT,
  ACTIONS: ACTIONS,
  STAGES: STAGES,
  blank: blank,
  normalize: normalize,
  settle: settle,
  stageOf: stageOf,
  idleImg: idleImg,
  act: act,
  peerText: peerText,
  clamp: clamp,
  isSleepHour: isSleepHour
}

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.Pet = api
