/**
 * 情绪日记 —— 「点日期」面板（渲染与交互，独立文件）
 * ============================================================
 * 用法（index.html 里只需要几行）：
 *   MoodUI.init({ app: APP, onDataChanged: function(){ paintHome() } })
 *   MoodUI.mount(document.body)            // 浮层挂在 <body> 上，别放进 .content
 *   window.openMoodPanel = function (dateKey) { MoodUI.open(dateKey) }
 *
 * 依赖：data/mood.js（数据层，104 项测试）+ data/anniversary.js（日期工具）
 *      可选：window.SharedData（读昵称，没加载就退回「我 / TA」）
 *
 * 用户定的规矩（2026-10-10，别自作主张改）：
 *   1. **各点各的**：我只能点自己的心情，TA 的心情是只读的（能看到 TA 选了啥）
 *   2. **日记互相能看**：我写完，对方点同一天就能看到
 *   3. **能补记任意过去日期**；未来的日子不给写
 *   4. 显示窗口只 3 个月，但**老数据永不删**（数据层保证，这里也不删任何东西）
 *   5. 心情同一个再点一次 = 取消（数据层 toggleMood 写的是墓碑，不是删 key）
 *
 * 三条工程上的硬要求（都踩过坑，见交接文档-网页版 §8）：
 *   1. 浮层挂 <body>：`.content{z-index:1}` 是层叠上下文，装里面翻不过 .tabbar(99)
 *   2. 色值全部来自 design-tokens.css 的 --mood-*（本文件里一个色值都不写死）
 *   3. 底部让位一律走 CSS 变量 --tab-h，别写死 84px
 *
 * 预览调试参数（都能和 ?now= ?uid= 拼）：
 *   ?mood=1                 直接打开面板（默认今天）
 *   ?mood=2026-10-05        直接打开某一天
 *   ?mood=demo              带一份演示数据打开（**只在内存里，不落盘**）
 *   ?now=2026-10-10         假装今天是某天（首页月历也认这个参数）
 */

/* global Mood, Anniversary */
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

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  /** 'YYYY-MM-DD' → '10月5日' / '2025年10月5日'（跨年才带年份） */
  function mdLabel(dateKey) {
    var d = Anniversary.parseDate(dateKey)
    if (!d) return String(dateKey || '')
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
  }

  /**
   * 面板标题：'10月5日 · 周日' + 相对今天的一句话。
   * @param dateKey 要显示的那天
   * @param todayKey 今天（传进来而不是在这里读时钟 —— 方便测，也方便 ?now=）
   * @returns { main, dow, rel }
   */
  function dateLabel(dateKey, todayKey) {
    var d = Anniversary.parseDate(dateKey)
    if (!d) return { main: String(dateKey || ''), dow: '', rel: '' }
    var main = (d.getMonth() + 1) + '月' + d.getDate() + '日'
    var dow = WEEK[d.getDay()]
    var diff = Mood.relDays(todayKey, dateKey)   /* b − a：今天→那天，过去为负 */
    var rel = ''
    if (diff === 0) rel = '今天'
    else if (diff === -1) rel = '昨天'
    else if (diff === 1) rel = '明天'
    else if (diff < 0) rel = (-diff) + ' 天前'
    else rel = diff + ' 天后'
    if (d.getFullYear() !== Anniversary.parseDate(todayKey).getFullYear()) {
      main = d.getFullYear() + '年' + main
    }
    return { main: main, dow: dow, rel: rel }
  }

  /** 这个月两个人都记了哪些心情 → [{ key, name, emoji, color, n }]，按次数从多到少 */
  function monthSummary(state, year, month, uids) {
    var cells = Mood.monthView(state, year, month, uids, null)
    var count = {}
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i]
      if (!c.inMonth) continue
      for (var u = 0; u < uids.length; u++) {
        var k = c.moods[uids[u]]
        if (k) count[k] = (count[k] || 0) + 1
      }
    }
    var out = []
    var presets = Mood.presets()
    for (var j = 0; j < presets.length; j++) {
      var p = presets[j]
      if (count[p.key]) out.push({ key: p.key, name: p.name, emoji: p.emoji, color: p.color, n: count[p.key] })
    }
    out.sort(function (a, b) { return b.n - a.n })
    return out
  }

  var api = {
    dateLabel: dateLabel,
    mdLabel: mdLabel,
    monthSummary: monthSummary,
    WEEK: WEEK
  }

  /* ============================================================
     二、Node 环境（自测脚本 require 本文件时）到这就够了
     ============================================================ */
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = api
    return
  }

  /* ============================================================
     三、浏览器：面板本体
     ============================================================ */

  var APP = null          /* AppState 实例（由 init 传进来） */
  var OPTS = {}
  var ov = null           /* 浮层容器（挂在 body 上） */
  var sheet = null
  var els = {}
  var draft = {}          /* 未保存的日记草稿：{'A': '...', 'B': '...'} */
  var cur = ''            /* 面板当前显示哪一天 */
  var saveTimer = null

  /* ---- 演示数据（只在内存里，绝不落盘） ---- */

  function nowKey() {
    var n = qs('now')
    if (n && Anniversary.parseDate(n)) return n
    return Mood.todayKey()
  }

  /** ?now=YYYY-MM-DD 时把「现在」定在那天中午，消息时间看起来才正常 */
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
    var plan = [
      [0, mine, 'happy', '今天想到你就笑了，没什么理由。'],
      [0, peer, 'miss', ''],
      [-1, mine, 'tired', '忙了一整天，晚上才想起来吃饭。\n下次一定记得。'],
      [-1, peer, 'calm', ''],
      [-3, peer, 'sad', ''],
      [-4, mine, 'excited', ''],
      [-6, peer, 'happy', ''],
      [-9, mine, 'calm', ''],
      [-12, peer, 'giggle', ''],
      [-15, mine, 'miss', '']
    ]
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i]
      var key = Mood.addDays(today, p[0])
      if (p[2]) Mood.setMood(s, key, p[1], p[2], nowMs())
      if (p[3]) Mood.setDiary(s, key, p[1], p[3], nowMs())
    }
    /* 演示数据里补一条上个月的，好看出底部「这个月」统计只算当月 */
    var cur0 = Anniversary.parseDate(today)
    var pm = cur0.getFullYear() + '-' + pad2(cur0.getMonth() === 0 ? 12 : cur0.getMonth()) + '-03'
    if (cur0.getMonth() === 0) pm = (cur0.getFullYear() - 1) + '-12-03'
    Mood.setMood(s, pm, peer, 'tired', nowMs())
    Mood.setDiary(s, pm, peer, '那边降温了，你记得加衣服。', nowMs())
    return s
  }

  /* ---- 状态代理：有 app 就用 app，只有演示数据时才用内存版 ---- */
  /* 演示模式（?mood=demo）下**不能**碰真实的 AppState：
     出图、验收都不该往用户真实数据里写东西。 */
  var DEMO = (function () {
    var v = qs('mood')
    return v === 'demo' ? { state: null, uid: null } : null
  })()

  function currentState() {
    if (DEMO) return DEMO.state
    return (APP && APP.state) || null
  }

  function myUid() {
    if (DEMO) return DEMO.uid
    return (APP && APP.uid) || 'A'
  }
  function peerUid() { return myUid() === 'A' ? 'B' : 'A' }

  function applyChange(fn) {
    var st = currentState()
    if (!st) return
    if (DEMO) {
      fn(st)
      render()
      if (OPTS.onDataChanged) OPTS.onDataChanged()
      return
    }
    if (APP && APP.mutate) {
      APP.mutate(fn)
    } else {
      fn(st)
      render()
      if (OPTS.onDataChanged) OPTS.onDataChanged()
    }
  }

  /* ---- 小工具 ---- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function toast(msg) {
    if (typeof OPTS.toast === 'function') { try { OPTS.toast(msg); return } catch (e) { /* 落到自带提示 */ } }
    var t = document.getElementById('md-toast')
    if (!t) return
    t.textContent = msg
    t.classList.add('on')
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(function () { t.classList.remove('on') }, 2000)
  }

  /** 昵称：优先共享层里填过的名字，没填就「我 / TA」 */
  function nameOf(uid) {
    var fallback = uid === myUid() ? '我' : 'TA'
    try {
      var SD = root.SharedData
      if (SD && SD.getProfile) {
        var p = SD.getProfile(uid)
        if (p && p.name) return p.name + (uid === myUid() ? '（我）' : '（TA）')
      }
    } catch (e) { /* ignore */ }
    return fallback
  }

  /* ============================================================
     四、骨架
     ============================================================ */

  function buildSkeleton() {
    ov = document.createElement('div')
    ov.className = 'md-overlays'

    var sides = ''
    var list = [{ uid: 'me', tag: '我' }, { uid: 'ta', tag: 'TA' }]
    for (var i = 0; i < 2; i++) {
      sides +=
        '<div class="md-side ' + list[i].uid + '" data-side="' + list[i].uid + '">' +
          '<div class="md-side-hd">' +
            '<span class="who" data-r="who">' + list[i].tag + '</span>' +
            '<span class="tag" data-r="tag"></span>' +
          '</div>' +
          '<div class="md-moods" data-r="moods"></div>' +
          '<textarea class="md-ta" data-r="diary" maxlength="2000" rows="4"></textarea>' +
          '<div class="md-foot">' +
            '<span class="md-count" data-r="count">0 / 2000</span>' +
            '<span class="md-saved" data-r="saved">已保存</span>' +
            '<span class="md-save off" data-act="save">保存</span>' +
          '</div>' +
        '</div>'
    }

    ov.innerHTML =
      '<div class="md-mask" data-act="close"></div>' +
      '<div class="md-sheet">' +
        '<div class="md-grab" data-act="drag"><div class="md-handle"></div></div>' +
        '<div class="md-top">' +
          '<span class="md-x" data-act="close">✕</span>' +
          '<span class="md-nav" data-act="prev">‹</span>' +
          '<span class="md-date"><span data-r="date">—</span>' +
            '<span class="md-dow" data-r="dow"></span>' +
            '<span class="md-todaypill" data-r="rel" style="display:none"></span>' +
          '</span>' +
          '<span class="md-nav" data-act="next">›</span>' +
          '<span class="md-x" data-act="today" title="回到今天">今</span>' +
        '</div>' +
        '<div class="md-body">' +
          '<div class="md-tip" data-r="tip" style="display:none"></div>' +
          sides +
        '</div>' +
        '<div class="md-sum" data-r="sum"></div>' +
      '</div>' +
      '<div class="md-toast" id="md-toast"></div>'

    document.body.appendChild(ov)
    sheet = ov.querySelector('.md-sheet')

    /* 引用缓存：两个 data-side 里的 data-r 同名，所以分开查 */
    els.mask = ov.querySelector('.md-mask')
    els.date = ov.querySelector('[data-r="date"]')
    els.dow = ov.querySelector('[data-r="dow"]')
    els.rel = ov.querySelector('[data-r="rel"]')
    els.tip = ov.querySelector('[data-r="tip"]')
    els.sum = ov.querySelector('[data-r="sum"]')
    els.prev = ov.querySelector('[data-act="prev"]')
    els.next = ov.querySelector('[data-act="next"]')
    els.sides = {}
    var sideEls = ov.querySelectorAll('.md-side')
    for (var s = 0; s < sideEls.length; s++) {
      var se = sideEls[s]
      els.sides[se.getAttribute('data-side')] = {
        el: se,
        who: se.querySelector('[data-r="who"]'),
        tag: se.querySelector('[data-r="tag"]'),
        moods: se.querySelector('[data-r="moods"]'),
        diary: se.querySelector('[data-r="diary"]'),
        count: se.querySelector('[data-r="count"]'),
        saved: se.querySelector('[data-r="saved"]'),
        save: se.querySelector('[data-act="save"]')
      }
      /* TA 那半的日记是「一张纸」而不是输入框（只读）。
         插在心情胶囊和按钮行之间，位置和「我的」那边的输入框对齐。 */
      var paper = document.createElement('div')
      paper.className = 'md-paper'
      paper.style.display = 'none'
      se.insertBefore(paper, se.querySelector('.md-foot'))
      els.sides[se.getAttribute('data-side')].paper = paper
    }

    /* 事件：全部委托在浮层容器上 —— 一次绑定，重渲染不用重绑 */
    ov.addEventListener('click', onClick)
    ov.addEventListener('input', onInput)
    ov.addEventListener('keydown', onKey)
    /* 手机上下滑动抽屉把手不关；点遮罩关 */
    window.addEventListener('beforeunload', warnDraft)
  }

  /** 有没保存的日记草稿时离开页面给个提醒（只在真的写过字时才拦） */
  function warnDraft(ev) {
    if (!isDirty()) return
    ev.preventDefault()
    ev.returnValue = ''
    return ''
  }

  function isDirty() {
    var st = currentState()
    if (!st || !cur) return false
    var uids = [myUid(), peerUid()]
    for (var i = 0; i < uids.length; i++) {
      var u = uids[i]
      if (draft[u] === undefined) continue
      if (draft[u] !== Mood.getDiary(st, cur, u)) return true
    }
    return false
  }

  /* ============================================================
     五、渲染
     ============================================================ */

  function render() {
    if (!ov) return
    var st = currentState()
    if (!st || !cur) return
    var today = nowKey()
    var mine = myUid(), peer = peerUid()

    /* ---- 顶栏日期 ---- */
    var lb = dateLabel(cur, today)
    els.date.textContent = lb.main
    els.dow.textContent = lb.dow
    /* 「今天」不额外打标（周几已经说明了）；过去的日子标一句「3 天前」 */
    if (lb.rel === '今天') {
      els.rel.style.display = 'none'
    } else {
      els.rel.textContent = lb.rel
      els.rel.style.display = ''
    }
    /* 前后一天：不允许走到未来 */
    els.next.classList.toggle('off', cur >= today)
    els.prev.classList.toggle('off', false)

    /* ---- 提示条 ---- */
    var writable = Mood.canWrite(cur, today)
    if (!writable) {
      els.tip.className = 'md-tip err'
      els.tip.innerHTML = '还没到的日子写不了 —— 到了那天再记吧 🙂'
      els.tip.style.display = ''
    } else {
      els.tip.className = 'md-tip'
      els.tip.innerHTML = '点一个心情记下今天的心情（再点一次 = 取消）· ' +
        '<b>日记可以随时补写</b>，老记录一直留着'
      els.tip.style.display = ''
    }

    /* ---- 两半 ---- */
    paintSide('me', mine, mine, writable, '我')
    paintSide('ta', peer, mine, writable, 'TA')

    /* ---- 底部统计 ---- */
    var d = Anniversary.parseDate(cur)
    var sum = monthSummary(st, d.getFullYear(), d.getMonth() + 1, [mine, peer])
    var h = '<span class="k">' + (d.getMonth() + 1) + '月两人一共记了</span>'
    if (!sum.length) {
      h += '<span class="empty it">还没有记录</span>'
    } else {
      for (var i = 0; i < sum.length; i++) {
        h += '<span class="it">' + sum[i].emoji + ' ' + esc(sum[i].name) + ' <b>' + sum[i].n + '</b></span>'
      }
    }
    els.sum.innerHTML = h
  }

  /**
   * 画一半（我 / TA）。
   * @param side   'me' | 'ta'（只决定 CSS 那一套暖色）
   * @param uid    这一半是谁
   * @param mine   我是谁（决定能不能点）
   * @param writable 这一天能不能写（未来的日子不能）
   */
  function paintSide(side, uid, mine, writable, fallbackTag) {
    var st = currentState()
    var el = els.sides[side]
    if (!st || !el) return

    var isMine = (uid === mine)
    var editable = writable && isMine          /* ← 用户定的：只能点自己的 */

    el.who.textContent = nameOf(uid) || fallbackTag
    el.tag.className = 'tag' + (isMine ? ' on' : '')
    el.tag.textContent = isMine ? '我' : '只读'

    /* 8 个心情 */
    var on = Mood.getMood(st, cur, uid)
    var presets = Mood.presets()
    var h = ''
    for (var i = 0; i < presets.length; i++) {
      var p = presets[i]
      var sel = (p.key === on)
      /* 选中的那颗用「它自己的颜色」当底（透明度 .4 ≈ 66）：
         心情颜色是跟着预设走的（见 data/mood.js 的说明），所以 inline 传进来，
         而不是在 CSS 里再列 8 条 —— 用户改预设时只改一处。 */
      h += '<span class="md-mood' + (sel ? ' on' : '') + '"' +
        ' data-act="mood" data-side="' + side + '" data-key="' + p.key + '"' +
        ' style="--mc:' + p.color + (sel ? ';background:' + p.color + '66' : '') + '"' +
        ' title="' + esc(p.name) + '">' +
        '<span class="em">' + p.emoji + '</span>' +
        '<span class="nm">' + esc(p.name) + '</span>' +
        '<span class="tick">✓</span>' +
      '</span>'
    }
    el.moods.innerHTML = h
    el.moods.className = 'md-moods' + (editable ? '' : ' readonly')

    /* 日记：我的可写，TA 的只读（一张纸） */
    if (isMine) {
      var draftText = (draft[uid] !== undefined) ? draft[uid] : Mood.getDiary(st, cur, uid)
      if (el.diary.value !== draftText) el.diary.value = draftText
      el.diary.readOnly = !writable
      el.diary.placeholder = writable
        ? '今天想写点什么？（两边各写各的，都能看到对方写的）'
        : '还没到的日子写不了'
      el.diary.style.display = ''
      el.paper.style.display = 'none'
      el.count.style.display = ''
      el.saved.style.display = ''
      el.save.style.display = writable ? '' : 'none'
      updateCount(side, draftText)
      /* 保存按钮：草稿和已存的一样就置灰（清空也允许保存） */
      el.save.classList.toggle('off', el.diary.value === Mood.getDiary(st, cur, uid))
      return
    }

    var txt = Mood.getDiary(st, cur, uid)
    el.paper.className = 'md-paper' + (txt ? '' : ' empty')
    el.paper.textContent = txt || 'TA 这天还没写日记'
    el.paper.style.display = ''
    el.diary.style.display = 'none'
    el.count.style.display = 'none'
    el.saved.style.display = 'none'
    el.save.style.display = 'none'
  }

  function updateCount(side, text) {
    var el = els.sides[side]
    if (!el || !el.count) return
    var n = String(text == null ? '' : text).length
    el.count.textContent = n + ' / ' + Mood.DIARY_MAX
    el.count.classList.toggle('over', n > Mood.DIARY_MAX)
  }

  /* ============================================================
     六、交互
     ============================================================ */

  function onClick(ev) {
    var t = ev.target
    if (!t || !t.closest) return
    var hit = t.closest('[data-act]')
    if (!hit || !ov.contains(hit)) return
    var act = hit.getAttribute('data-act')

    if (act === 'close' || act === 'drag') { close(); return }
    if (act === 'prev') { step(-1); return }
    if (act === 'next') { step(1); return }
    if (act === 'today') { open(nowKey()); return }
    if (act === 'mood') { pickMood(hit.getAttribute('data-side'), hit.getAttribute('data-key')); return }
    if (act === 'save') { saveDiary(hit.getAttribute('data-side') || 'me'); return }
  }

  function onInput(ev) {
    var t = ev.target
    if (!t || !t.getAttribute) return
    if (t.getAttribute('data-r') !== 'diary') return
    var sideEl = t.closest ? t.closest('.md-side') : null
    if (!sideEl) return
    var side = sideEl.getAttribute('data-side')
    if (side !== 'me') return                 /* TA 那半没有输入框，兜一层 */
    var uid = myUid()
    draft[uid] = t.value
    updateCount(side, t.value)
    var st = currentState()
    if (st) els.sides[side].save.classList.toggle('off', t.value === Mood.getDiary(st, cur, uid))
  }

  function onKey(ev) {
    if (ev.key === 'Escape') { close(); return }
    /* Ctrl/⌘ + Enter = 保存（手机上直接点按钮） */
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault()
      saveDiary('me')
    }
  }

  function step(n) {
    var next = Mood.addDays(cur, n)
    if (!next) return
    if (next > nowKey()) return               /* 不许看未来 */
    open(next)
  }

  function pickMood(side, key) {
    var st = currentState()
    if (!st) return
    if (side !== 'me') return                 /* 只读那半在 CSS 里已经不可点，这里再兜一层 */
    var today = nowKey()
    if (!Mood.canWrite(cur, today)) { toast('还没到的日子写不了'); return }
    var uid = myUid()
    applyChange(function (s) { Mood.toggleMood(s, cur, uid, key) })
    showSaved('me')
  }

  function saveDiary(side) {
    var st = currentState()
    if (!st) return
    if (side !== 'me') return
    var uid = myUid()
    var today = nowKey()
    if (!Mood.canWrite(cur, today)) { toast('还没到的日子写不了'); return }

    var el = els.sides.me
    var text = el.diary.value
    if (text.length > Mood.DIARY_MAX) {
      toast('太长了，最多 ' + Mood.DIARY_MAX + ' 字')
      return
    }
    var before = Mood.getDiary(st, cur, uid)
    if (text === before) { toast('这一天的日记没改动'); return }
    /* 写好的日记清空 = 删掉，给一次确认（删了只能重打） */
    if (!text.trim() && before) {
      if (!root.confirm || !root.confirm('清空这一天的日记？清空后对方也看不到了。')) return
    }

    var res = null
    applyChange(function (s) { res = Mood.setDiary(s, cur, uid, text) })
    if (res && !res.ok) {
      toast(res.reason === 'TOO_LONG' ? ('太长了，最多 ' + Mood.DIARY_MAX + ' 字') : '存不下，再试一次')
      return
    }
    draft[uid] = text
    showSaved('me')
    render()
  }

  function showSaved(side) {
    var el = els.sides[side]
    if (!el) return
    el.saved.classList.add('on')
    setTimeout(function () { el.saved.classList.remove('on') }, 1600)
  }

  /* ============================================================
     七、开关
     ============================================================ */

  function isOpen() {
    return !!(sheet && sheet.classList.contains('on'))
  }

  /**
   * 打开面板。
   * @param dateKey 'YYYY-MM-DD'；空/非法 → 今天
   */
  function open(dateKey) {
    if (!ov) return
    var today = nowKey()
    var key = (dateKey && Anniversary.parseDate(dateKey)) ? dateKey : today
    if (key > today) key = today              /* 未来的日子不给进（首页也点不到） */
    /* 换天之前把这一天没保存的草稿丢掉：留着会让下一天显示串味 */
    cur = key
    draft = {}
    render()
    els.mask.classList.add('on')
    sheet.classList.add('on')
    if (OPTS.onOpen) { try { OPTS.onOpen(key) } catch (e) { /* ignore */ } }
  }

  function close() {
    if (!ov) return
    els.mask.classList.remove('on')
    sheet.classList.remove('on')
    draft = {}
    if (OPTS.onClose) { try { OPTS.onClose() } catch (e) { /* ignore */ } }
  }

  /* ============================================================
     八、对外接口
     ============================================================ */

  function init(opts) {
    OPTS = opts || {}
    APP = OPTS.app || null
    if (root.AppState && root.AppState.AppState && !APP) {
      /* 没传就用 index.html 已经建好的那个（window.CoupleApp） */
      APP = root.CoupleApp || null
    }
    if (DEMO) {
      DEMO.state = demoState()
      DEMO.uid = (APP && APP.uid) || 'A'
    }
    /* 远端拉下来的数据也要重画（对方今天记了心情，我打开面板就能看到） */
    if (APP && APP.subscribe) {
      APP.subscribe(function () { if (isOpen()) render() })
    }
    return api
  }

  function mount() {
    if (ov) return api
    buildSkeleton()
    /* ?mood=1 / ?mood=2026-10-05 / ?mood=demo：出图和自测直接打开 */
    var v = qs('mood')
    if (v) open(v === '1' || v === 'demo' ? '' : v)
    return api
  }

  api.init = init
  api.mount = mount
  api.open = open
  api.close = close
  api.isOpen = isOpen
  api.render = render
  api._state = {
    get cur() { return cur },
    get demo() { return DEMO ? DEMO.state : null },
    draft: function () { return draft }
  }

  root.MoodUI = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof self !== 'undefined' ? self : this)
