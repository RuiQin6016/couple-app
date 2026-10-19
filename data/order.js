/**
 * 下单提醒 —— 数据层（纯逻辑：不碰 DOM、不碰存储）
 * ============================================================
 * 需求（用户 2026-10-19 原话）：「商城买完东西对方会收到提醒」
 * 且明确要求：**不打开软件也要收到，像微信一样**。
 *
 * ⚠️ 为什么不用浏览器 Web Push（这条路实测走不通，别重试）：
 *   网页弹系统通知必须由服务端向 FCM / APNs 发推送，而本机实测
 *   `fcm.googleapis.com` **连续 3 次超时**（Chrome/Android 推送必经），
 *   `updates.push.services.mozilla.com` 返回 406。也就是说那个"最后一环"
 *   在这里是堵死的 —— VAPID + Cloudflare Worker 的方案做不出来。
 *
 * ✅ 走 ntfy（实测可行）：
 *   把消息 POST 到 ntfy.sh 的专属 topic；手机上装 ntfy App 订阅同一个 topic，
 *   由那个 App 弹通知 —— **App 不用开着**，也就真正做到了"不打开也收到"。
 *   实测：发布约 1 秒、**可见延迟约 1.9 秒**、支持 Title/Priority/Tags
 *   （priority 4 = 高，手机弹横幅）。
 *
 * 三条设计要点（错了会出事，都有测试）：
 *   ① **提醒是"记录"，不是"消息"** —— 只增不改，按 id 取并集合并。
 *      绝不能用"整份新的覆盖旧的"（那会丢对方没读过的提醒）。
 *   ② **已读状态归读的人** —— 和悄悄话同款：一人一个文件之后，读的人没法改
 *      对方文件里的记录，所以读的人把自己读过的写进**自己那份**的 reads，
 *      对方拉到时再贴回那条提醒上。不这么做，对方永远显示"未读"。
 *   ③ **ntfy 只是加急通道，不是数据源** —— 通知发失败/漏收都不影响数据，
 *      真正的事实永远在同步层（拉回来照样能看到）。所以 ntfy 失败**不报错**。
 *
 * ⚠️ ntfy header 只能放 ASCII（实测：中文标题直接抛 TypeError）——
 *    标题一律 encodeURIComponent 后再放 header。
 */

;(function (root) {
  'use strict'

  /** 一条提醒最多留这么多（两个人自己用，200 条足够，主要防止无限增长） */
  var MAX_ITEMS = 200
  /** 超过这个条数就把最老的丢掉（按时间） */
  var KEEP = 200

  /** 通知标题（ntfy 的 Title header，必须是 ASCII 安全） */
  var PUSH_TITLE = '宝宝下单啦 🎁'

  function nowMs(v) { return (typeof v === 'number' && isFinite(v)) ? v : Date.now() }

  /** 稳定排序：先按时间，时间相同再按 id —— 两台设备排出来一致 */
  function cmp(a, b) {
    var ta = nowMs(a && a.at), tb = nowMs(b && b.at)
    if (ta !== tb) return ta - tb
    var ia = String(a && a.id), ib = String(b && b.id)
    return ia < ib ? -1 : (ia > ib ? 1 : 0)
  }

  /** id 里带「时间 + 人 + 随机」：两台设备各自生成，不会有中央序号，靠随机后缀避免撞 */
  function makeId(uid, at) {
    return 'o_' + at + '_' + String(uid || '') + '_' +
      Math.random().toString(36).slice(2, 8)
  }

  function ensure(state) {
    if (!state.orders || !(state.orders instanceof Array)) state.orders = []
    return state
  }

  function list(state) {
    var arr = (state && state.orders) || []
    return arr.slice().sort(cmp)
  }

  /**
   * 下一单。
   * @param {object} state
   * @param {string} uid          谁买的
   * @param {Array}  goods        [{ id, name, count, price }]
   * @param {number} total        合计积分
   * @param {string} [note]       留言（用户 2026-10-19 选了"连备注一起带上"）
   * @param {number} [at]
   * @returns {{ok:boolean, order?:object, reason?:string}}
   */
  function add(state, uid, goods, total, note, at) {
    if (!state) return { ok: false, reason: 'NO_STATE' }
    ensure(state)
    var items = (goods || []).map(function (g) {
      return {
        id: String((g && g.id) || ''),
        name: String((g && g.name) || ''),
        count: Number((g && g.count) || 1),
        price: Number((g && g.price) || 0)
      }
    }).filter(function (g) { return g.id && g.name })
    if (!items.length) return { ok: false, reason: 'EMPTY' }

    var ts = nowMs(at)
    var order = {
      id: makeId(uid, ts),
      by: uid,
      items: items,
      total: Number(total) || 0,
      note: String(note == null ? '' : note).replace(/\r\n/g, '\n').trim().slice(0, 200),
      at: ts,
      /** 谁什么时候读了（读的人写，见文件头说明 ②） */
      readBy: {},
      /** 对方有没有兑现（买的人标记；'done' | ''） */
      done: '',
      doneAt: 0
    }
    state.orders.push(order)
    /* 太长就按时间丢掉最老的（提醒是流水，不是账本；账在积分里） */
    if (state.orders.length > MAX_ITEMS) {
      state.orders = list(state).slice(-KEEP)
    }
    return { ok: true, order: order }
  }

  /** 对方下的单（我看得到、要我去做的事） */
  function fromPeer(state, uid) {
    return list(state).filter(function (o) { return o && o.by !== uid })
  }

  /** 我下的单 */
  function mine(state, uid) {
    return list(state).filter(function (o) { return o && o.by === uid })
  }

  /** 对方下的、我还没看的 */
  function unread(state, uid) {
    return fromPeer(state, uid).filter(function (o) {
      return !(o.readBy && o.readBy[uid])
    })
  }

  function unreadCount(state, uid) { return unread(state, uid).length }

  /**
   * 把「对方下的、我还没看的」全标成已读。
   * ⚠️ 已经读过的不改时间（否则每次轮询拉到数据都会把已读时间往前推）。
   */
  function markRead(state, uid, at) {
    var ts = nowMs(at)
    var n = 0
    var arr = (state && state.orders) || []
    for (var i = 0; i < arr.length; i++) {
      var o = arr[i]
      if (!o || o.by === uid) continue
      if (!o.readBy) o.readBy = {}
      if (o.readBy[uid]) continue
      o.readBy[uid] = ts
      n++
    }
    return { ok: true, count: n }
  }

  /**
   * 标记「这一单兑现了」。
   * ⚠️ 只有**下单的人**能标记（那是他说的"我收到了/我满足了"）；
   *    对方乱点会把状态改坏。
   */
  function markDone(state, uid, orderId, at) {
    var arr = (state && state.orders) || []
    for (var i = 0; i < arr.length; i++) {
      var o = arr[i]
      if (!o || o.id !== orderId) continue
      if (o.by !== uid) return { ok: false, reason: 'NOT_OWNER' }
      o.done = 'done'
      o.doneAt = nowMs(at)
      return { ok: true, order: o }
    }
    return { ok: false, reason: 'NOT_FOUND' }
  }

  /**
   * 合并另一份提醒进来（**就地改 target**，返回 target）。
   * ⚠️ 按 id 取并集：不能整份覆盖，否则会丢对方没读过的提醒。
   */
  function mergeInto(target, other) {
    if (!other || !other.orders) return target
    ensure(target)
    var byId = {}
    var i
    for (i = 0; i < target.orders.length; i++) {
      var m = target.orders[i]
      if (m && m.id) byId[m.id] = m
    }
    for (i = 0; i < other.orders.length; i++) {
      var o = other.orders[i]
      if (!o || !o.id) continue
      var cur = byId[o.id]
      if (!cur) {
        target.orders.push(o)
        byId[o.id] = o
        continue
      }
      /* 两边都有同一条：readBy 取各人较晚的时间（互相不抹）；
         done 是单调事实，谁标过就保留。 */
      if (o.readBy) {
        if (!cur.readBy) cur.readBy = {}
        for (var uid in o.readBy) {
          if (!Object.prototype.hasOwnProperty.call(o.readBy, uid)) continue
          var t = o.readBy[uid]
          if (!cur.readBy[uid] || t > cur.readBy[uid]) cur.readBy[uid] = t
        }
      }
      if (o.done && !cur.done) { cur.done = o.done; cur.doneAt = o.doneAt || 0 }
    }
    target.orders.sort(cmp)
    if (target.orders.length > MAX_ITEMS) {
      target.orders = target.orders.slice(-KEEP)
    }
    return target
  }

  /* ============================================================
     ntfy 加急通道（**不是**数据源，失败不报错）
     ============================================================ */

  var NTFY = 'https://ntfy.sh'

  /** topic 由随机 32 位十六进制组成 —— 它本身就是"密码"（谁知道谁知道） */
  function newTopic() {
    var s = ''
    for (var i = 0; i < 32; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)]
    return 'couple-' + s
  }

  function validTopic(t) {
    return /^[A-Za-z0-9_-]{8,64}$/.test(String(t || ''))
  }

  /**
   * 把「谁买了什么」拼成一句人话（通知正文）。
   * 纯函数，便于测试。
   */
  function describe(order) {
    if (!order) return ''
    var who = order.by === 'A' ? '宝宝' : 'TA'
    var names = (order.items || []).map(function (g) {
      return g.count > 1 ? (g.name + ' ×' + g.count) : g.name
    })
    var body = who + '买了「' + names.join('、') + '」'
    if (order.total > 0) body += '，花了 ' + order.total + ' 积分'
    if (order.note) body += '\n留言：' + order.note
    return body
  }

  /**
   * 发一条 ntfy 通知。**失败不抛错、不报错** —— 它只是加急通道，
   * 数据本身已经进了同步层，拉回来照样能看到。
   *
   * @param {object} opts { topic, title, body, tags, priority, fetch }
   * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
   */
  function push(opts) {
    opts = opts || {}
    var topic = String(opts.topic || '')
    if (!validTopic(topic)) return Promise.resolve({ ok: false, error: 'BAD_TOPIC' })
    var f = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null)
    if (!f) return Promise.resolve({ ok: false, error: 'NO_FETCH' })

    /* ⚠️ header 只能放 ASCII：中文必须编码，否则 fetch 直接抛
       TypeError: character 23453 > 255（实测踩到） */
    var headers = {
      'Title': encodeURIComponent(opts.title || PUSH_TITLE),
      'Priority': String(opts.priority || 4),
      'Tags': opts.tags || 'gift'
    }
    var body = String(opts.body == null ? '' : opts.body)

    return Promise.resolve()
      .then(function () {
        return f(NTFY + '/' + topic, { method: 'POST', body: body, headers: headers })
      })
      .then(function (r) {
        return { ok: !!(r && r.ok), status: r ? r.status : 0 }
      })
      .catch(function (e) {
        return { ok: false, error: String((e && e.message) || e) }
      })
  }

  var api = {
    MAX_ITEMS: MAX_ITEMS,
    PUSH_TITLE: PUSH_TITLE,
    NTFY: NTFY,
    makeId: makeId,
    ensure: ensure,
    list: list,
    add: add,
    fromPeer: fromPeer,
    mine: mine,
    unread: unread,
    unreadCount: unreadCount,
    markRead: markRead,
    markDone: markDone,
    mergeInto: mergeInto,
    newTopic: newTopic,
    validTopic: validTopic,
    describe: describe,
    push: push
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  /* ⚠️ 用 window 判断，不要用 root：Node 里顶层 this 是 module.exports 而不是 global。 */
  if (typeof window !== 'undefined') window.Order = api
})(typeof self !== 'undefined' ? self : this)
