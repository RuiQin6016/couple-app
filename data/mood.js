/**
 * 情绪日记 · 数据层（纯逻辑：不碰 DOM、不碰存储、不碰网络）
 * ============================================================
 * 两部分数据，都按「日期 → 人 → 记录」存：
 *
 *   moods   = { '2026-10-10': { A: {mood:'happy', at, updatedAt}, B: {...} } }
 *   diaries = { '2026-10-10': { A: {text:'今天…', at, updatedAt}, B: {...} } }
 *
 * 为什么按「日期 + 人」逐槽位存，而不是两人各存一整天的记录：
 *   合并时才能逐槽位比版本 —— A 写日记不会把 B 同一天的日记盖掉。
 *
 * ⚠️ 两条容易写错、已刻意处理的地方（都写成了注释 + 测试）：
 *   1. **取消心情不删 key，而是写「墓碑」**（{mood:null}）。删 key 的话，
 *      同步合并时对方的旧记录会因为"这边没有"而被合并回来 —— 删除被复活。
 *   2. **合并是逐槽位比 updatedAt**，不是整天胜、也不是整份胜。
 *
 * 同时兼容 Node（自测脚本）与浏览器（原型页），避免两处逻辑走偏。
 */

;(function (root) {
  'use strict'

  /* 浏览器里 Anniversary 由 <script> 先加载成全局；Node 里 require 同一份实现 */
  var Ann = (typeof require !== 'undefined')
    ? require('./anniversary.js')
    : root.Anniversary

  /* ============================================================
     8 种心情预设
     用户已拍板这一套（开心/偷乐/平静/想你/累/难过/生气/兴奋），
     并且明确说「预设可以自己改」—— 所以集中成一个数组，改只改这里，
     不散落在 CSS / HTML 里。
     颜色跟着预设走（不是写进 design-tokens.css）：因为预设是可改的，
     颜色必须和 key 绑在一起，改预设时一起改。
     ============================================================ */
  var PRESETS = [
    { key: 'happy',   name: '开心', emoji: '😊', color: '#FFD86B' },
    { key: 'giggle',  name: '偷乐', emoji: '😆', color: '#FFB07C' },
    { key: 'calm',    name: '平静', emoji: '🙂', color: '#A8D8A0' },
    { key: 'miss',    name: '想你', emoji: '🥰', color: '#FFA8C4' },
    { key: 'tired',   name: '累',   emoji: '😪', color: '#C4B0A8' },
    { key: 'sad',     name: '难过', emoji: '😢', color: '#9BC4E2' },
    { key: 'angry',   name: '生气', emoji: '😠', color: '#F08A7A' },
    { key: 'excited', name: '兴奋', emoji: '🤩', color: '#C4A8E8' }
  ]

  var BY_KEY = {}
  for (var i = 0; i < PRESETS.length; i++) BY_KEY[PRESETS[i].key] = PRESETS[i]

  /** 只显示最近 N 个月。用户已定：**老数据不删**，只是日历不显示 */
  var DISPLAY_MONTHS = 3

  /** 日记上限（字符）。两个人自己写，2000 字足够，主要是防手滑粘贴一整本书 */
  var DIARY_MAX = 2000

  function preset(key) { return BY_KEY[key] || null }
  function isPreset(key) { return !!BY_KEY[key] }
  function presets() { return PRESETS.slice() }

  /* ============================================================
     日期工具
     ⚠️ 一律复用 anniversary.js（parseDate / toKey / daysBetween），
        例假模块的经验：日期加减自己写一份，方向很容易搞反。
     ============================================================ */

  function nowMs(v) { return (typeof v === 'number' && isFinite(v)) ? v : Date.now() }
  /** 比较版本用：缺失算 0，绝不能用 Date.now() —— 那会让合并结果不确定（两边算不出同一份） */
  function stamp(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0 }

  function todayKey(nowInput) {
    var d = Ann.parseDate(nowInput) || Ann.parseDate(new Date())
    return Ann.toKey(d)
  }

  /**
   * 加天数（用 Date 自动进位，跨月跨年跨闰日都对）。
   * 直接喂 'YYYY-MM-DD' 字符串会抛错的地方都在这里挡住了。
   */
  function addDays(dateKey, n) {
    var d = Ann.parseDate(dateKey)
    if (!d) return null
    return Ann.toKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n))
  }

  /**
   * a → b 相差几天（**b − a**，照例假模块的约定）。
   * 想知道「某天离今天几天」就传 relDays(today, thatDay)，过去为负。
   */
  function relDays(a, b) {
    var da = Ann.parseDate(a), db = Ann.parseDate(b)
    if (!da || !db) return null
    return Ann.daysBetween(da, db)
  }

  /** 能不能写：**不能写未来**（可以补记任意过去日期，用户已定） */
  function canWrite(dateKey, nowInput) {
    if (!Ann.parseDate(dateKey)) return false
    return dateKey <= todayKey(nowInput)
  }

  /* ============================================================
     槽位读写（moods / diaries 同构，一份代码两用）
     ============================================================ */

  function readSlot(state, bucket, dateKey, uid) {
    var b = state && state[bucket]
    var day = b && b[dateKey]
    var rec = day && day[uid]
    return rec || null
  }

  function writeSlot(state, bucket, dateKey, uid, rec) {
    if (!state[bucket]) state[bucket] = {}
    if (!state[bucket][dateKey]) state[bucket][dateKey] = {}
    state[bucket][dateKey][uid] = rec
    return rec
  }

  /* ============================================================
     心情
     ============================================================ */

  /** 读某天某人的心情；没记过、或记过又取消了 → null */
  function getMood(state, dateKey, uid) {
    var r = readSlot(state, 'moods', dateKey, uid)
    return (r && r.mood) ? r.mood : null
  }

  /** 写心情。at 可传（测试/补偿用），默认当前时间 */
  function setMood(state, dateKey, uid, moodKey, at) {
    if (!Ann.parseDate(dateKey)) return { ok: false, reason: 'BAD_DATE' }
    if (!isPreset(moodKey)) return { ok: false, reason: 'BAD_MOOD' }
    var t = nowMs(at)
    var prev = readSlot(state, 'moods', dateKey, uid)
    var rec = { mood: moodKey, at: (prev && prev.at) || t, updatedAt: t }
    writeSlot(state, 'moods', dateKey, uid, rec)
    return { ok: true, mood: moodKey, at: rec.at, updatedAt: t }
  }

  /**
   * 取消心情 —— **写墓碑，不删 key**。
   * 删 key 的话，同步合并时对方的旧记录会被合并回来（删除被复活）。
   */
  function clearMood(state, dateKey, uid, at) {
    if (!Ann.parseDate(dateKey)) return { ok: false, reason: 'BAD_DATE' }
    var t = nowMs(at)
    var prev = readSlot(state, 'moods', dateKey, uid)
    writeSlot(state, 'moods', dateKey, uid, { mood: null, at: (prev && prev.at) || t, updatedAt: t })
    return { ok: true, mood: null, updatedAt: t }
  }

  /** 用户要的交互：同一个心情再点一次 = 取消 */
  function toggleMood(state, dateKey, uid, moodKey, at) {
    if (getMood(state, dateKey, uid) === moodKey) return clearMood(state, dateKey, uid, at)
    return setMood(state, dateKey, uid, moodKey, at)
  }

  /** 某天两人的心情：{ A: 'happy', B: null } */
  function dayMoods(state, dateKey, uids) {
    var out = {}
    var list = uids || []
    for (var i = 0; i < list.length; i++) out[list[i]] = getMood(state, dateKey, list[i])
    return out
  }

  /** 这天有没有人记录过（决定格子里画不画「空圈」占位） */
  function dayHasAny(state, dateKey, uids) {
    var list = uids || []
    for (var i = 0; i < list.length; i++) {
      if (getMood(state, dateKey, list[i])) return true
    }
    return false
  }

  /* ============================================================
     日记（两人各自独立，同一天互不影响）
     ============================================================ */

  /** 读日记，没写过返回 '' */
  function getDiary(state, dateKey, uid) {
    var r = readSlot(state, 'diaries', dateKey, uid)
    return (r && r.text) ? r.text : ''
  }

  function hasDiary(state, dateKey, uid) {
    return getDiary(state, dateKey, uid).length > 0
  }

  /** 写日记。**空字符串 = 清空**（同样靠 updatedAt 合并，不需要单独删 key） */
  function setDiary(state, dateKey, uid, text, at) {
    if (!Ann.parseDate(dateKey)) return { ok: false, reason: 'BAD_DATE' }
    var s = String(text == null ? '' : text).replace(/\r\n/g, '\n')
    if (s.length > DIARY_MAX) return { ok: false, reason: 'TOO_LONG', max: DIARY_MAX }
    var t = nowMs(at)
    var prev = readSlot(state, 'diaries', dateKey, uid)
    var rec = { text: s, at: (prev && prev.at) || t, updatedAt: t }
    writeSlot(state, 'diaries', dateKey, uid, rec)
    return { ok: true, text: s, updatedAt: t }
  }

  /* ============================================================
     月历
     ============================================================ */

  /**
   * 一个月的格子，**固定 42 格（6 行 × 7 列）**。
   * ⚠️ 固定 42 格是刻意的：月历有 4/5/6 行三种情况，渲染格数跟着变的话
   *    首页卡片高度会跳（每日一言卡已经因为这个毛病被压缩过一次）。
   *    上下月那几天 inMonth=false，UI 只画淡日期、不画心情。
   * @returns [{ key, day, inMonth }]
   */
  function monthCells(year, month) {
    var firstDow = new Date(year, month - 1, 1).getDay()   /* 0 = 周日 */
    var daysInMonth = new Date(year, month, 0).getDate()
    var cells = []
    for (var i = 0; i < 42; i++) {
      /* d 可以是 0 / 负数 / 超过本月天数 —— Date 会自动进退位，不用自己算 */
      var d = i - firstDow + 1
      var date = new Date(year, month - 1, d)
      cells.push({
        key: Ann.toKey(date),
        day: date.getDate(),
        inMonth: (d >= 1 && d <= daysInMonth)
      })
    }
    return cells
  }

  /**
   * 可显示范围：今天所在月往前数 (months−1) 个月的 1 号，到今天所在月最后一天。
   * 用户已定：**只显示最近三个月，更早的数据一直留着不删**。
   */
  function visibleRange(nowInput, months) {
    var n = months || DISPLAY_MONTHS
    var t = Ann.parseDate(todayKey(nowInput))
    var from = new Date(t.getFullYear(), t.getMonth() - (n - 1), 1)
    var to = new Date(t.getFullYear(), t.getMonth() + 1, 0)
    return { from: Ann.toKey(from), to: Ann.toKey(to), months: n }
  }

  function isVisible(dateKey, nowInput, months) {
    var r = visibleRange(nowInput, months)
    return dateKey >= r.from && dateKey <= r.to
  }

  /**
   * 给 UI 用的一整月视图：格子 + 两人心情 + 今天标记 + 能不能写。
   * 首页月历和点日期面板都用它，免得两处各算一遍。
   */
  function monthView(state, year, month, uids, nowInput) {
    var today = todayKey(nowInput)
    var cells = monthCells(year, month)
    var out = []
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i]
      out.push({
        key: c.key,
        day: c.day,
        inMonth: c.inMonth,
        moods: dayMoods(state, c.key, uids),
        hasAny: dayHasAny(state, c.key, uids),
        isToday: c.key === today,
        canWrite: c.inMonth && canWrite(c.key, nowInput)
      })
    }
    return out
  }

  /* ============================================================
     同步合并
     ============================================================ */

  /** 谁更新：先比 updatedAt；**完全相同**（同一毫秒的并发写）再按序列化字符串定序 ——
      这样两台设备各算一次也能得到同一个结果（收敛），不会各留各的。 */
  function newer(a, b) {
    var ta = stamp(a && a.updatedAt)
    var tb = stamp(b && b.updatedAt)
    if (ta !== tb) return ta > tb
    return JSON.stringify(a) > JSON.stringify(b)
  }

  function mergeBucket(target, other, bucket) {
    if (!other || !other[bucket]) return target
    if (!target[bucket]) target[bucket] = {}
    var src = other[bucket]
    for (var dk in src) {
      if (!Object.prototype.hasOwnProperty.call(src, dk)) continue
      var day = src[dk]
      if (!day) continue
      if (!target[bucket][dk]) target[bucket][dk] = {}
      for (var uid in day) {
        if (!Object.prototype.hasOwnProperty.call(day, uid)) continue
        var incoming = day[uid]
        var cur = target[bucket][dk][uid]
        if (!cur || newer(incoming, cur)) target[bucket][dk][uid] = incoming
      }
    }
    return target
  }

  /**
   * 合并另一份数据进来（**就地改 target**，返回 target）。
   *
   * ⚠️ 逐「日期 + 人」槽位比 updatedAt，新的胜 —— 不是整天胜，也不是整份胜。
   *    只有这样才能保证：A 在自己手机上写日记，不会把 B 同一天的日记盖掉。
   * ⚠️ 墓碑（取消心情 / 清空日记）也带 updatedAt，所以「取消」能压过对方的旧记录。
   */
  function mergeInto(target, other) {
    mergeBucket(target, other, 'moods')
    mergeBucket(target, other, 'diaries')
    return target
  }

  /** 把两个桶建出来（空状态 / 老数据兼容用） */
  function ensure(state) {
    if (!state.moods || typeof state.moods !== 'object') state.moods = {}
    if (!state.diaries || typeof state.diaries !== 'object') state.diaries = {}
    return state
  }

  var api = {
    PRESETS: PRESETS,
    DISPLAY_MONTHS: DISPLAY_MONTHS,
    DIARY_MAX: DIARY_MAX,
    preset: preset,
    isPreset: isPreset,
    presets: presets,

    todayKey: todayKey,
    addDays: addDays,
    relDays: relDays,
    canWrite: canWrite,

    getMood: getMood,
    setMood: setMood,
    clearMood: clearMood,
    toggleMood: toggleMood,
    dayMoods: dayMoods,
    dayHasAny: dayHasAny,

    getDiary: getDiary,
    hasDiary: hasDiary,
    setDiary: setDiary,

    monthCells: monthCells,
    monthView: monthView,
    visibleRange: visibleRange,
    isVisible: isVisible,

    mergeInto: mergeInto,
    ensure: ensure
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  /* ⚠️ 用 window 判断，不要用 root：Node 里顶层 this 是 module.exports 而不是 global，
     写成 root.Mood 会把接口挂到 module.exports 上（浏览器端反而是哑的）。 */
  if (typeof window !== 'undefined') window.Mood = api
})(typeof self !== 'undefined' ? self : this)
