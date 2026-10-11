/**
 * 悄悄话 —— 对话页（渲染与交互，独立文件）
 * ============================================================
 * 用法（index.html 里只需要几行）：
 *   WhisperUI.init({ app: APP, onDataChanged: function(){ paintHome() } })
 *   WhisperUI.mount(document.body)
 *   window.openWhisperPage = function () { WhisperUI.open() }
 *
 * 依赖：data/whisper.js（数据层，57 项测试）+ data/mood.js（日期工具，借它做「按天分组」）
 *      可选：window.SharedData（读昵称）
 *
 * 用户定的规矩（2026-10-10，别自作主张改）：
 *   - 气泡左右分：我右 TA 左
 *   - 日期分隔
 *   - 能回复（输入条在底部，回车/Ctrl+回车发送）
 *   - 已读（对方看过我的消息 → 显示「已读」）
 *   - 发送中 / 失败状态
 *   - **这一轮不做删除、不做表情**（用户明确说了先做最简的）
 *
 * ⚠️ 关于「发送中」的诚实说明：这是客户端轮询架构，**没有服务端回执**。
 *    所以「发送中」= 这条是我发的、而且还没成功传上云；「已送达」= 上传成功过。
 *    真正确认对方看到了，是「已读」（对方设备 markRead 后同步回来）。
 *    别把它写成「秒级送达」——交接文档 §9 明确禁止承诺这个。
 *
 * 预览调试参数（都能和 ?now= ?uid= 拼）：
 *   ?whisper=1        直接打开对话页
 *   ?whisper=demo     带一份演示对话打开（**只在内存里，不落盘**）
 *   ?now=2026-10-10   假装今天是某天
 */

/* global Whisper, Mood, Anniversary */
;(function (root) {
  'use strict'

  /* ============================================================
     一、纯工具（不碰 DOM，可单独测）
     ============================================================ */

  function qs(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search)
      return m ? decodeURIComponent(m[1]) : ''
    } catch (e) { return '' }
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n }

  /**
   * 对话页里的日期分隔标签。
   * @param dateKey 那一天
   * @param todayKey 「今天」是哪天（传进来而不是读时钟：方便测，也认 ?now=）
   * @returns '今天' / '昨天' / '10月5日 周日'（跨年补年份）
   */
  function dayLabel(dateKey, todayKey) {
    var d = Anniversary.parseDate(dateKey)
    if (!d) return String(dateKey || '')
    if (dateKey === todayKey) return '今天'
    var diff = Mood.relDays(todayKey, dateKey)      /* b − a：过去为负 */
    if (diff === -1) return '昨天'
    var s = (d.getMonth() + 1) + '月' + d.getDate() + '日'
    var t = Anniversary.parseDate(todayKey)
    if (t && d.getFullYear() !== t.getFullYear()) s = d.getFullYear() + '年' + s
    var wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
    return s + ' ' + wk
  }

  /**
   * 一条消息的送达状态 —— **纯函数，好测也好讲清楚**。
   * @param msg      那条消息（{by, at, readBy}）
   * @param ctx      { myUid, syncing, lastPush, lastPushFail, pending, failed, readByPeer }
   * @returns { code, text, cls }
   *   code: 'ta'      对方发的（不显示送达状态，时间就够）
   *         'local'   我在本机，但没配对（数据只在这台手机上）
   *         'sending' 还没传上云
   *         'failed'  传失败了（点一下重试）
   *         'sent'    传上云了
   */
  function deliveryOf(msg, ctx) {
    ctx = ctx || {}
    if (!msg || msg.by !== ctx.myUid) return { code: 'ta', text: '', cls: '' }
    if (!ctx.syncing) return { code: 'local', text: '仅本机', cls: '' }
    var at = Number(msg.at) || 0
    var fail = ctx.failed || {}
    if (fail[msg.id]) return { code: 'failed', text: '发送失败 · 点这里重试', cls: 'bad' }
    if (ctx.pending && ctx.pending[msg.id]) return { code: 'sending', text: '发送中…', cls: '' }
    /* 上传失败的时间比这条新 → 这条还在队列里等着 */
    if (ctx.lastPushFail && ctx.lastPushFail >= at) {
      return { code: 'sending', text: '发送中…', cls: '' }
    }
    if (ctx.lastPush && ctx.lastPush >= at) return { code: 'sent', text: '已送达', cls: 'ok' }
    return { code: 'sending', text: '发送中…', cls: '' }
  }

  /**
   * 最后一次「我说的话」的已读情况 —— 气泡底下只写一行，不逐条重复。
   * @returns '' | '已读' | '还没看过'
   */
  function receiptOf(list, ctx) {
    for (var i = list.length - 1; i >= 0; i--) {
      var m = list[i]
      if (!m || m.by !== ctx.myUid) continue
      var rb = m.readBy || {}
      return rb[ctx.peerUid] ? '已读' : '还没看过'
    }
    return ''
  }

  var api = {
    dayLabel: dayLabel,
    deliveryOf: deliveryOf,
    receiptOf: receiptOf,
    /* 顶层提示语 */
    topSub: function (n) {
      if (!n) return '还没有消息 · 说第一句吧'
      return '一共 ' + n + ' 句悄悄话'
    }
  }

  /* ============================================================
     二、Node 环境（自测脚本 require 本文件时）到这就够了
     ============================================================ */
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = api
    return
  }

  /* ============================================================
     三、浏览器：对话页本体
     ============================================================ */

  var APP = null
  var OPTS = {}
  var page = null            /* 浮层根（挂在 body 上） */
  var els = {}
  var seen = {}              /* 已经渲染过的消息 id：只有新消息才放动画，老的不重放 */
  var firstPaint = true
  var pending = {}           /* 我刚发出、还没成功上传的：{id:true} */
  var failed = {}            /* 上传失败、还没重试成功的：{id:true} */
  var taReadUpTo = 0         /* 打开时「对方已读」的时间线，用来画「以下是新消息」 */
  var forceBottom = false
  var toastTimer = null

  var DEMO = (function () { return qs('whisper') === 'demo' ? { state: null, uid: null } : null })()

  function nowKey() {
    var n = qs('now')
    if (n && Anniversary.parseDate(n)) return n
    return Mood.todayKey()
  }

  function nowMs() {
    var n = qs('now')
    var d = n ? Anniversary.parseDate(n) : null
    if (d) { d.setHours(12, 0, 0, 0); return d.getTime() }
    return Date.now()
  }

  function demoState() {
    var today = nowKey()
    var s = { v: 1, moods: {}, diaries: {}, whispers: [] }
    var mine = (APP && APP.uid) || 'A'
    var peer = mine === 'A' ? 'B' : 'A'
    var t0 = nowMs()
    /* [天数偏移, 分钟偏移, 谁, 内容, 对方是否已读] */
    var plan = [
      [-2, -180, peer, '刚刚路过那家店，还是你上次点的那杯', true],
      [-2, -176, mine, '哈哈那杯太甜了，你居然记得', true],
      [-2, -173, peer, '当然记得呀 🥰', true],
      [-1, -300, mine, '今天有点累，晚上早点睡', true],
      [-1, -296, peer, '好，那我也早点睡，抱抱', true],
      [0, -35, peer, '在干嘛', false],
      [0, -34, mine, '刚洗完澡，正要跟你说话', false],
      [0, -2, peer, '那你现在看到啦', false]
    ]
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i]
      var day = Mood.addDays(today, p[0])
      var dd = Anniversary.parseDate(day)
      dd.setHours(12, 0, 0, 0)
      var at = dd.getTime() + p[1] * 60000
      var r = Whisper.send(s, p[2], p[3], at)
      if (r.ok && p[4]) r.message.readBy[peer] = at + 60000
    }
    return s
  }

  /* ---- 状态代理 ---- */
  function currentState() {
    if (DEMO) return DEMO.state
    return (APP && APP.state) || null
  }
  function myUid() {
    if (DEMO) return DEMO.uid
    return (APP && APP.uid) || 'A'
  }
  function peerUid() { return myUid() === 'A' ? 'B' : 'A' }

  function syncing() {
    if (DEMO) return true                        /* 演示数据当它已同步，好看清状态样式 */
    return !!(APP && APP.sync && APP.status && APP.status.mode !== 'local-only')
  }

  function applyChange(fn) {
    var st = currentState()
    if (!st) return
    if (DEMO) {
      fn(st)
      render()
      if (OPTS.onDataChanged) OPTS.onDataChanged()
      return
    }
    if (APP && APP.mutate) APP.mutate(fn)
    else { fn(st); render(); if (OPTS.onDataChanged) OPTS.onDataChanged() }
  }

  /* ---- 小工具 ---- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function hhmm(ts) {
    var d = new Date(Number(ts) || 0)
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  }

  function toast(msg) {
    if (typeof OPTS.toast === 'function') { try { OPTS.toast(msg); return } catch (e) { /* 落到自己的 */ } }
    if (!els.toast) return
    els.toast.textContent = msg
    els.toast.classList.add('on')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { els.toast.classList.remove('on') }, 2000)
  }

  function nameOf(uid) {
    try {
      var SD = root.SharedData
      if (SD && SD.getProfile) {
        var p = SD.getProfile(uid)
        if (p && p.name) return p.name
      }
    } catch (e) { /* ignore */ }
    return uid === myUid() ? '我' : 'TA'
  }

  var PLANE_SVG =
    '<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M35.5 5 4.5 17.8l10.9 4.1L35.5 5Z"/>' +
    '<path d="M35.5 5 15.4 21.9 16.9 33l5.5-7.4L35.5 5Z"/></svg>'

  /* ============================================================
     四、骨架
     ============================================================ */

  function buildSkeleton() {
    page = document.createElement('div')
    page.className = 'wsp-page'
    page.innerHTML =
      '<div class="wsp-top">' +
        '<span class="bk" data-act="close">‹</span>' +
        '<span class="ttl"><b>悄悄话</b><i data-r="sub"></i></span>' +
        '<span class="plane">' + PLANE_SVG + '</span>' +
      '</div>' +
      '<div class="wsp-warn" data-r="warn" style="display:none">' +
        '<span data-r="warntx"></span>' +
        '<span class="go" data-act="settings">去配对</span>' +
      '</div>' +
      '<div class="wsp-wrap">' +
        '<div class="wsp-list" data-r="list"></div>' +
        '<span class="wsp-jump" data-act="bottom">↓ 回到最新</span>' +
      '</div>' +
      '<div class="wsp-composer">' +
        '<textarea class="wsp-in" data-r="in" rows="1" maxlength="1000" ' +
          'placeholder="说点什么…（Ctrl+回车 或点发送）"></textarea>' +
        '<span class="wsp-send off" data-act="send">发送</span>' +
      '</div>' +
      '<div class="wsp-len" data-r="len"></div>' +
      '<div class="wsp-toast"></div>'

    document.body.appendChild(page)

    els.top = page.querySelector('.wsp-top')
    els.sub = page.querySelector('[data-r="sub"]')
    els.warn = page.querySelector('[data-r="warn"]')
    els.warntx = page.querySelector('[data-r="warntx"]')
    els.list = page.querySelector('[data-r="list"]')
    els.jump = page.querySelector('.wsp-jump')
    els.input = page.querySelector('[data-r="in"]')
    els.send = page.querySelector('.wsp-send')
    els.len = page.querySelector('[data-r="len"]')
    els.toast = page.querySelector('.wsp-toast')

    page.addEventListener('click', onClick)
    page.addEventListener('input', onInput)
    page.addEventListener('keydown', onKey)
    els.list.addEventListener('scroll', onScroll)
  }

  /* ============================================================
     五、渲染
     ============================================================ */

  /** 距离底部还有多少 —— 判断「用户是不是正在看最新」 */
  function nearBottom() {
    if (!els.list) return true
    return els.list.scrollHeight - els.list.scrollTop - els.list.clientHeight < 90
  }

  function scrollBottom(smooth) {
    if (!els.list) return
    var top = els.list.scrollHeight
    try {
      if (smooth && els.list.scrollTo) els.list.scrollTo({ top: top, behavior: 'smooth' })
      else els.list.scrollTop = top
    } catch (e) { els.list.scrollTop = top }
  }

  function render() {
    if (!page) return
    var st = currentState()
    if (!st || !root.Whisper) return

    var mine = myUid(), peer = peerUid()
    var all = Whisper.list(st)
    var ctx = {
      myUid: mine,
      peerUid: peer,
      syncing: syncing(),
      pending: pending,
      failed: failed,
      lastPush: (APP && APP.status && APP.status.lastPush) || 0,
      lastPushFail: 0
    }

    /* ---- 顶栏 ---- */
    els.sub.textContent = api.topSub(all.length)

    /* ---- 提醒条：没配对就别假装能收到 ---- */
    if (!syncing()) {
      els.warn.style.display = ''
      els.warn.className = 'wsp-warn'
      els.warntx.textContent = '这台手机还没配对：消息只存在本机，对方看不到。配对一次就能互通。'
    } else if (APP && APP.status && APP.status.mode === 'error') {
      els.warn.style.display = ''
      els.warn.className = 'wsp-warn err'
      els.warntx.textContent = APP.status.error || '同步出了点问题'
    } else {
      els.warn.style.display = 'none'
    }

    /* ---- 空态 ---- */
    if (!all.length) {
      els.list.innerHTML =
        '<div class="wsp-empty">' +
          '<span class="big">' + PLANE_SVG + '</span>' +
          '<b>还没有悄悄话</b>' +
          '<span>在下面说第一句吧 —— 对方打开就能看到</span>' +
        '</div>'
      els.jump.classList.remove('on')
      updateSendBtn()
      return
    }

    /* ---- 分组画气泡 ---- */
    var groups = Whisper.byDay(st)
    var today = nowKey()
    var html = ''
    var unreadLineDone = false
    var newIds = []

    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g]
      html += '<div class="wsp-day"><i class="ln"></i>' +
        '<span class="dd">' + esc(dayLabel(grp.key, today)) + '</span>' +
        '<i class="ln"></i></div>'

      for (var i = 0; i < grp.items.length; i++) {
        var m = grp.items[i]
        /* 「以下是新消息」：这次打开时对方已读线之后、TA 发的第一条 */
        if (!unreadLineDone && taReadUpTo && m.by === peer && Number(m.at) > taReadUpTo) {
          html += '<div class="wsp-unreadline"><i class="ln"></i>以下是新消息<i class="ln"></i></div>'
          unreadLineDone = true
        }
        html += bubbleHtml(m, ctx, newIds)
      }
    }

    /* ---- 底下那一行：我说的话对方看了没 ---- */
    var rc = receiptOf(all, ctx)
    if (rc) {
      html += '<div class="wsp-receipt' + (rc === '已读' ? ' ok' : '') + '">' + rc + '</div>'
    }

    var wasBottom = forceBottom || nearBottom()
    els.list.innerHTML = html

    /* 只有**这一轮新到的**才放动画（老消息重放会一直闪） */
    for (var n = 0; n < newIds.length; n++) {
      var el = els.list.querySelector('[data-id="' + newIds[n] + '"]')
      if (el && !el.classList.contains('new')) el.classList.add('new')
    }
    for (var k = 0; k < all.length; k++) seen[all[k].id] = true

    if (wasBottom || firstPaint) scrollBottom(false)
    firstPaint = false
    forceBottom = false
    els.jump.classList.toggle('on', !nearBottom())
    updateSendBtn()
  }

  function bubbleHtml(m, ctx, newIds) {
    var isMine = (m.by === ctx.myUid)
    var d = deliveryOf(m, ctx)
    var cls = 'wsp-row ' + (isMine ? 'me' : 'ta')
    if (d.code === 'sending') cls += ' pending'
    if (d.code === 'failed') cls += ' failed'
    var txt = esc(m.text)
    /* 新消息清单（只用来决定放不放动画） */
    if (!seen[m.id] && !firstPaint) newIds.push(m.id)
    var status = d.text
      ? ' · <span class="stat ' + d.cls + '"' + (d.code === 'failed' ? ' data-act="retry" data-id="' + esc(m.id) + '"' : '') + '>' + d.text + '</span>'
      : ''
    return '<div class="' + cls + '" data-id="' + esc(m.id) + '">' +
      '<div class="wsp-b">' +
        '<div class="tx">' + txt + '</div>' +
        '<div class="mt"><span>' + hhmm(m.at) + '</span>' + status + '</div>' +
      '</div></div>'
  }

  function updateSendBtn() {
    if (!els.send) return
    var v = els.input ? els.input.value.replace(/\s+/g, '') : ''
    els.send.classList.toggle('off', !v)
    if (els.len) {
      var n = els.input ? els.input.value.length : 0
      els.len.classList.toggle('on', n >= 800)
      els.len.textContent = n + ' / ' + Whisper.MAX_LEN
    }
  }

  /* ============================================================
     六、交互
     ============================================================ */

  function onClick(ev) {
    var t = ev.target
    if (!t || !t.closest) return
    var hit = t.closest('[data-act]')
    if (!hit || !page.contains(hit)) return
    var act = hit.getAttribute('data-act')

    if (act === 'close') { close(); return }
    if (act === 'bottom') { forceBottom = true; scrollBottom(true); return }
    if (act === 'settings') {
      close()
      try { if (root.SettingsUI) root.SettingsUI.open('main') } catch (e) { /* ignore */ }
      return
    }
    if (act === 'retry') { retry(hit.getAttribute('data-id')); return }
    if (act === 'send') { send(); return }
  }

  function onInput() {
    var t = els.input
    if (!t) return
    /* 输入框自己长高（最多 4 行左右，再多就内部滚动） */
    try {
      t.style.height = 'auto'
      t.style.height = Math.min(t.scrollHeight, 104) + 'px'
    } catch (e) { /* ignore */ }
    updateSendBtn()
  }

  function onKey(ev) {
    if (ev.key === 'Escape') { close(); return }
    /* 回车发送：手机上回车本来就是换行，所以要求 Ctrl/⌘；桌面上都行 */
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault()
      send()
      return
    }
    if (ev.key === 'Enter' && !ev.shiftKey && isDesktop()) {
      ev.preventDefault()
      send()
    }
  }

  function isDesktop() {
    try { return root.matchMedia && root.matchMedia('(hover:hover) and (pointer:fine)').matches } catch (e) { return false }
  }

  function onScroll() {
    els.jump.classList.toggle('on', !nearBottom())
  }

  /** 发一条 */
  function send() {
    var st = currentState()
    if (!st) return
    var text = els.input.value
    if (!text.replace(/\s+/g, '')) { toast('先写一句再发吧'); return }
    if (text.length > Whisper.MAX_LEN) { toast('太长了，最多 ' + Whisper.MAX_LEN + ' 字'); return }

    var uid = myUid()
    var res = null
    var at = nowMs()
    applyChange(function (s) { res = Whisper.send(s, uid, text, at) })
    if (!res || !res.ok) {
      toast(res && res.reason === 'TOO_LONG' ? ('太长了，最多 ' + Whisper.MAX_LEN + ' 字') : '没发出去，再试一次')
      return
    }
    var id = res.message.id
    if (!DEMO) { pending[id] = true; delete failed[id] }
    els.input.value = ''
    onInput()
    forceBottom = true
    render()
    try { els.input.focus() } catch (e) { /* ignore */ }
  }

  /** 失败的那条：点一下重试（消息本来就在本地，重试 = 再推一次） */
  function retry(id) {
    delete failed[id]
    pending[id] = true
    render()
    if (APP && APP.pushNow) {
      APP.pushNow().then(function (r) {
        if (!r || !r.ok) { delete pending[id]; failed[id] = true } else { delete pending[id] }
        render()
      })
    } else {
      toast('这台手机还没配对，先配对吧')
    }
  }

  /* ============================================================
     七、同步状态 → 气泡状态
     ============================================================ */

  function hookApp() {
    if (!APP || !APP.subscribe) return
    var prevPush = (APP.status && APP.status.lastPush) || 0
    APP.subscribe(function () {
      var st = APP.status || {}
      /* 上传成功：把所有排队中的标记成「已送达」 */
      if (st.lastPush && st.lastPush > prevPush) {
        prevPush = st.lastPush
        pending = {}
        failed = {}
      }
      /* 上传失败（还是没连上云端）：把这些标成「发送失败」，点一下能重试 */
      if (st.mode === 'error' && st.error) {
        for (var id in pending) { if (pending[id]) failed[id] = true }
        pending = {}
      }
      render()
    })
  }

  /* ============================================================
     八、开关
     ============================================================ */

  function isOpen() { return !!(page && page.classList.contains('on')) }

  function open() {
    if (!page) return
    var st = currentState()
    /* 「以下是新消息」的分界线：打开时对方已经读到哪里 */
    taReadUpTo = 0
    if (st && root.Whisper) {
      var all = Whisper.list(st)
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].by !== myUid()) { taReadUpTo = Number(all[i].at) || 0; break }
      }
    }
    firstPaint = true
    forceBottom = true
    page.classList.add('on')
    render()
    /* 打开就标记已读（对方就能看到「已读」了） */
    markAllRead()
    /* 在对话页里拉得勤一点（5 秒），关掉恢复 20 秒 */
    if (APP && APP.setFastPoll) { try { APP.setFastPoll(true) } catch (e) { /* ignore */ } }
    if (APP && APP.pullNow) { try { APP.pullNow() } catch (e) { /* ignore */ } }
    try { if (isDesktop()) els.input.focus() } catch (e) { /* ignore */ }
    if (OPTS.onOpen) { try { OPTS.onOpen() } catch (e) { /* ignore */ } }
  }

  function close() {
    if (!page) return
    page.classList.remove('on')
    if (APP && APP.setFastPoll) { try { APP.setFastPoll(false) } catch (e) { /* ignore */ } }
    if (OPTS.onClose) { try { OPTS.onClose() } catch (e) { /* ignore */ } }
  }

  /** 把「对方发来的、我还没读的」标成已读（对方那边就会显示「已读」） */
  function markAllRead() {
    var st = currentState()
    if (!st || !root.Whisper) return
    var uid = myUid()
    if (!Whisper.unreadCount(st, uid)) return
    applyChange(function (s) { Whisper.markRead(s, uid, nowMs()) })
  }

  /* ============================================================
     九、对外接口
     ============================================================ */

  function init(opts) {
    OPTS = opts || {}
    APP = OPTS.app || null
    if (!APP && root.AppState && root.AppState.AppState) APP = root.CoupleApp || null
    if (DEMO) {
      DEMO.state = demoState()
      DEMO.uid = (APP && APP.uid) || 'A'
    }
    hookApp()
    return api
  }

  function mount() {
    if (page) return api
    buildSkeleton()
    var v = qs('whisper')
    if (v) open()
    return api
  }

  api.init = init
  api.mount = mount
  api.open = open
  api.close = close
  api.isOpen = isOpen
  api.render = render
  api._state = {
    get demo() { return DEMO ? DEMO.state : null },
    get seen() { return seen },
    get pending() { return pending }
  }

  root.WhisperUI = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof self !== 'undefined' ? self : this)
