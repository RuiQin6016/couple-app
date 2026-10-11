/**
 * 悄悄话 · 数据层（纯逻辑：不碰 DOM、不碰存储、不碰网络）
 * ============================================================
 * 一条消息 = 一条记录，**只增不改**：
 *
 *   whispers = [
 *     { id:'w_1728547200000_A_k3f9a1', by:'A', text:'…', at:1728547200000,
 *       readBy:{ B:1728547300000 } }        // 谁在什么时候读了这条
 *   ]
 *
 * 为什么 id 里带「时间 + 人 + 随机」：
 *   两个人各自在自己手机上发消息，**没有中央服务器分配序号**。
 *   带上随机后缀，两台设备生成同一个 id 的概率可以忽略，合并时按 id 去重就够了。
 *
 * ⚠️ 合并（同步）要点的两条，都写了测试：
 *   1. 按 id **取并集** —— 不能"整份新的覆盖旧的"，否则一定会丢对方刚发的消息。
 *   2. readBy **取各人记录的较晚时间** —— 两边的已读状态合并后不会互相抹掉。
 */

;(function (root) {
  'use strict'

  var Ann = (typeof require !== 'undefined')
    ? require('./anniversary.js')
    : root.Anniversary

  /** 单条上限（字符）。两个人自己用，1000 字足够，主要是防手滑粘一整本书 */
  var MAX_LEN = 1000

  /** 未读摘要显示用的截断长度（首页卡片一行放得下） */
  var SUMMARY_LEN = 40

  function nowMs(v) { return (typeof v === 'number' && isFinite(v)) ? v : Date.now() }

  /** 稳定的排序：先按时间，时间相同再按 id —— 两台设备排出来的顺序一致 */
  function cmp(a, b) {
    var ta = nowMs(a && a.at), tb = nowMs(b && b.at)
    if (ta !== tb) return ta - tb
    var ia = String(a && a.id), ib = String(b && b.id)
    return ia < ib ? -1 : (ia > ib ? 1 : 0)
  }

  function list(state) {
    var arr = (state && state.whispers) || []
    return arr.slice().sort(cmp)
  }

  function makeId(uid, at) {
    return 'w_' + at + '_' + String(uid || '') + '_' +
      Math.random().toString(36).slice(2, 8)
  }

  /** 统一处理：去首尾空白、CRLF → LF（免得两个平台各存一种换行） */
  function normalize(text) {
    return String(text == null ? '' : text).replace(/\r\n/g, '\n').trim()
  }

  /**
   * 发一条。
   * @returns {ok, message} / {ok:false, reason:'EMPTY'|'TOO_LONG'}
   */
  function send(state, uid, text, at) {
    if (!state) return { ok: false, reason: 'NO_STATE' }
    if (!state.whispers) state.whispers = []
    var t = normalize(text)
    if (!t) return { ok: false, reason: 'EMPTY' }
    if (t.length > MAX_LEN) return { ok: false, reason: 'TOO_LONG', max: MAX_LEN }
    var ts = nowMs(at)
    var msg = { id: makeId(uid, ts), by: uid, text: t, at: ts, readBy: {} }
    state.whispers.push(msg)
    return { ok: true, message: msg }
  }

  /** 对方发来、我还没读的 */
  function unread(state, uid) {
    return list(state).filter(function (m) {
      return m.by !== uid && !(m.readBy && m.readBy[uid])
    })
  }

  function unreadCount(state, uid) { return unread(state, uid).length }

  /**
   * 把「对方发来的、我还没读的」全部标记成已读。
   * ⚠️ 已经读过的不改时间 —— 否则每次轮询拉到数据都会把已读时间往前推。
   */
  function markRead(state, uid, at) {
    var ts = nowMs(at)
    var n = 0
    var arr = (state && state.whispers) || []
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i]
      if (!m || m.by === uid) continue
      if (!m.readBy) m.readBy = {}
      if (m.readBy[uid]) continue
      m.readBy[uid] = ts
      n++
    }
    return { ok: true, count: n }
  }

  function last(state) {
    var l = list(state)
    return l.length ? l[l.length - 1] : null
  }

  /** 按 id 找一条 */
  function get(state, id) {
    var arr = (state && state.whispers) || []
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i]
    return null
  }

  /** 首页卡片用：未读数 + 最后一条摘要 */
  function summary(state, uid) {
    var l = last(state)
    var text = l ? l.text : ''
    return {
      total: (state && state.whispers) ? state.whispers.length : 0,
      unread: unreadCount(state, uid),
      lastText: text.length > SUMMARY_LEN ? text.slice(0, SUMMARY_LEN) + '…' : text,
      lastFull: text,
      lastBy: l ? l.by : '',
      lastAt: l ? l.at : 0,
      mine: l ? (l.by === uid) : false
    }
  }

  /**
   * 按天分组（聊天页画「每天的分隔」用）。
   * @returns [{ key:'2026-10-10', items:[…] }] —— 按时间正序
   */
  function byDay(state) {
    var arr = list(state)
    var groups = []
    var cur = null
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i]
      var k = Ann.toKey(new Date(nowMs(m.at)))
      if (!cur || cur.key !== k) {
        cur = { key: k, items: [] }
        groups.push(cur)
      }
      cur.items.push(m)
    }
    return groups
  }

  /**
   * 合并另一份消息进来（**就地改 target**，返回 target）。
   *
   * ⚠️ 必须按 id 取并集：两条消息可能分别来自两台设备，
   *    "用新的整份覆盖旧的" 会直接丢掉对方那条（这是聊天记录最不能接受的 bug）。
   */
  function mergeInto(target, other) {
    if (!other || !other.whispers) return target
    if (!target.whispers) target.whispers = []
    var byId = {}
    for (var i = 0; i < target.whispers.length; i++) {
      var m = target.whispers[i]
      if (m && m.id) byId[m.id] = m
    }
    for (var j = 0; j < other.whispers.length; j++) {
      var o = other.whispers[j]
      if (!o || !o.id) continue
      var cur = byId[o.id]
      if (!cur) {
        target.whispers.push(o)
        byId[o.id] = o
        continue
      }
      mergeReadBy(cur, o)
    }
    target.whispers.sort(cmp)
    return target
  }

  /** 已读状态取两人各自记录的较晚时间（合并后谁都不会把对方抹掉） */
  function mergeReadBy(cur, other) {
    if (!other || !other.readBy) return cur
    if (!cur.readBy) cur.readBy = {}
    for (var uid in other.readBy) {
      if (!Object.prototype.hasOwnProperty.call(other.readBy, uid)) continue
      var t = other.readBy[uid]
      if (!cur.readBy[uid] || t > cur.readBy[uid]) cur.readBy[uid] = t
    }
    return cur
  }

  /** 把桶建出来（空状态 / 老数据兼容用） */
  function ensure(state) {
    if (!state.whispers || !(state.whispers instanceof Array)) state.whispers = []
    return state
  }

  var api = {
    MAX_LEN: MAX_LEN,
    SUMMARY_LEN: SUMMARY_LEN,
    makeId: makeId,
    normalize: normalize,

    send: send,
    list: list,
    get: get,
    last: last,
    summary: summary,
    byDay: byDay,

    unread: unread,
    unreadCount: unreadCount,
    markRead: markRead,

    mergeInto: mergeInto,
    ensure: ensure
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  /* ⚠️ 用 window 判断，不要用 root：Node 里顶层 this 是 module.exports 而不是 global。 */
  if (typeof window !== 'undefined') window.Whisper = api
})(typeof self !== 'undefined' ? self : this)
