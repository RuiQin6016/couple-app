/**
 * 例假模块 · 页面渲染（独立文件）
 *
 * 用法（index.html 里只需一行）：
 *   PeriodUI.mount(document.getElementById('period-slot'))
 *
 * 为什么渲染也单独放：index.html 正被另一个会话编辑。
 * 模块自带 DOM 生成后，接入只需插一个容器 + 一行调用。
 *
 * 依赖（顺序）：data/anniversary.js → data/shared-data.js → data/period.js
 *
 * 预览调试参数（和 ?page=period 拼）：
 *   ?seed=regular   预置 4~5 月两次规律经期（平均 28 天）
 *   ?seed=once      只记录过一次（验"记录满 2 次后自动校准"）
 *   ?seed=abnormal  45 天间隔（验周期异常提示，不硬算倒计时）
 *   ?seed=none      清掉预置，看空状态
 *   ?now=2026-06-10 假装今天是某天
 *   ?open=set|rec   折叠态直接展开（预留）
 *
 * 带上 ?now= 或 ?seed= 时，预置数据只放在内存里，不写 localStorage。
 */

/* global Anniversary, SharedData, Period */
;(function (root) {
  'use strict'

  var P = root.Period
  var LS = root.SharedData

  /** 最多允许回看多少天（再早就别让人一路点下去了） */
  var LOOKBACK_DAYS = 90

  /* ============================================================
     顶部图形：兜帽兔（原创 SVG，不复刻任何注册形象）
     直接内联 path，不用 <use href="#...">——那样依赖 index.html 的 defs
     ============================================================ */

  function hoodSvg(size) {
    return '<svg viewBox="0 0 56 56" width="' + size + '" height="' + size + '" ' +
      'aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      // 垂耳（画成 path，不用 transform 变 ellipse）
      '<path d="M18.4 24.6C15.4 31.6 11.6 39.8 9.4 44.6c-1 2.2.9 4.8 3.3 4.6 2.8-.2 4.2-3 5.5-6.2"/>' +
      '<path d="M37.6 24.6c3 7 6.8 15.2 9 20 1 2.2-.9 4.8-3.3 4.6-2.8-.2-4.2-3-5.5-6.2"/>' +
      // 兜帽（盖住头顶，脸留外面）
      '<path d="M28 8c-7.7 0-13 6.4-13 15 0 7.6 5.8 12.6 13 12.6S41 30.6 41 23C41 14.4 35.7 8 28 8Z"/>' +
      // 帽檐
      '<path d="M15 20.2c3.7 2.1 8 3.2 13 3.2s9.3-1.1 13-3.2"/>' +
      // 脸 + 眼睛 + 嘴
      '<path d="M28 35.6C21.4 35.6 17 41 17 47.5c0 3.6 4.9 5.5 11 5.5s11-1.9 11-5.5c0-6.5-4.4-11.9-11-11.9Z"/>' +
      '<path d="M23.5 44.5h.1M32.5 44.5h.1" stroke-width="3.6"/>' +
      '<path d="M26.4 49.2c.9.9 2.3.9 3.2 0"/>' +
      // 帽耳上的爱心（母题）
      '<path d="M35.6 10.3c.7-1.4 2.8-.9 2.7.7-.1 1.2-1.6 2.3-2.7 3.1-1.1-.8-2.6-1.9-2.7-3.1-.1-1.6 2-2.1 2.7-.7Z" ' +
      'fill="currentColor" stroke="none" opacity=".85"/>' +
      '</svg>'
  }

  /* ============================================================
     预置数据（只在带 ?now= / ?seed= 的预览里用，不落盘）
     ============================================================ */

  var SEEDS = {
    regular: ['2026-03-06', '2026-04-03', '2026-05-01', '2026-05-29'],
    once: ['2026-05-29'],
    abnormal: ['2026-03-06', '2026-04-20'],
    none: []
  }

  /** 把一批开始日展开成每日记录（每次 5 天，量递减） */
  function expandSeed(starts) {
    var logs = {}
    if (!starts) return logs
    for (var i = 0; i < starts.length; i++) {
      for (var k = 0; k < 5; k++) {
        var d = P.addDays(starts[i], k)
        if (!d) continue
        var key = d.getFullYear() + '-' +
          String(d.getMonth() + 1).padStart(2, '0') + '-' +
          String(d.getDate()).padStart(2, '0')
        var flow = k === 0 ? 'little' : (k <= 2 ? 'heavy' : (k === 3 ? 'medium' : 'little'))
        logs[key] = {
          dateKey: key,
          flow: flow,
          symptoms: k === 0 ? ['cramp', 'backache'] : ['cramp'],
          moods: k === 0 ? ['irritable', 'tired'] : ['calm'],
          note: k === 0 ? '第一天，肚子有点坠' : '',
          updatedAt: 0,
          updatedBy: ''
        }
      }
    }
    return logs
  }

  /* ============================================================
     小工具
     ============================================================ */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function num(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  /** 相对今天的说法：今天 / 昨天 / 前天 / 3 天前 */
  function relDay(diff) {
    if (diff === 0) return '今天'
    if (diff === -1) return '昨天'
    if (diff === -2) return '前天'
    if (diff > 0) return diff + ' 天后'
    return (-diff) + ' 天前'
  }

  function clampInt(v, lo, hi, fallback) {
    var n = parseInt(v, 10)
    if (isNaN(n)) return fallback
    if (n < lo) return lo
    if (n > hi) return hi
    return n
  }

  function readQuery() {
    var q = {}
    try {
      var s = String((root.location && root.location.search) || '')
      var re = /[?&]([a-z]+)=([^&#]*)/g
      var m
      while ((m = re.exec(s))) q[m[1]] = decodeURIComponent(m[2])
    } catch (e) { /* ignore */ }
    return q
  }

  /* ============================================================
     渲染
     ============================================================ */

  function renderHistory(state) {
    var today = state.prediction.today
    var keys = Object.keys(state.logs).sort().reverse()
    // 只列到当前选中日为止，未来的记录不显示
    keys = keys.filter(function (k) { return k <= state.selected })

    if (!keys.length) {
      return '<div class="pd-empty">还没有任何记录<br>上面选好今天的状态，点「保存今天」就有了</div>'
    }

    var out = []
    for (var i = 0; i < Math.min(keys.length, 10); i++) {
      var k = keys[i]
      var log = state.logs[k]
      // relDay 收"相对今天"的偏移：过去为负。所以是 today → k，不是 k → today。
      var diff = daysBetweenKeys(today, k)
      var tags = []
      if (log.symptoms && log.symptoms.length) {
        tags.push(P.labelsOf(P.SYMPTOM_OPTIONS, log.symptoms).join(' · '))
      }
      if (log.moods && log.moods.length) {
        var mt = []
        for (var mi = 0; mi < log.moods.length; mi++) mt.push(P.moodText(log.moods[mi]))
        tags.push(mt.join(' '))
      }
      out.push(
        '<div class="pd-hist">' +
          '<div class="pd-hd">' + esc(P.formatMD(k)) +
            '<span>' + esc(relDay(diff)) + '</span>' +
          '</div>' +
          '<div class="pd-hc">' +
            '<span class="pd-hflow">' + (log.flow ? '量 ' + esc(P.flowLabel(log.flow)) : '未记量') + '</span>' +
            (tags.length ? '<div class="pd-htags">' + esc(tags.join('　')) + '</div>' : '') +
            (log.note ? '<div class="pd-hnote">“' + esc(log.note) + '”</div>' : '') +
          '</div>' +
        '</div>'
      )
    }
    return '<div class="pd-history">' + out.join('') + '</div>'
  }

  /**
   * 两个日期键之间的整天数差，**返回 b − a**（即"从 a 到 b 过了几天"）。
   *
   * ⚠️ 这个方向很容易读反，写调用点时先看这里：
   *   daysBetweenKeys(oldKey, newKey) > 0   // newKey 更晚
   *   想知道"某天离今天几天"，就传 daysBetweenKeys(today, thatDay) → 过去为负
   *   relDay() 收的就是这个"相对今天"的偏移，过去 = 负，未来 = 正
   *
   * 另外：Anniversary.daysBetween 收的是 Date 对象，
   * 直接喂字符串会抛 TypeError（不是静默返回 0），所以统一先过 parseDate。
   */
  function daysBetweenKeys(a, b) {
    var A = root.Anniversary
    if (A && A.parseDate && A.daysBetween) {
      var da = A.parseDate(a)
      var db = A.parseDate(b)
      if (da && db) return A.daysBetween(da, db)
    }
    var x = P.addDays(a, 0)
    var y = P.addDays(b, 0)
    if (!x || !y) return 0
    return Math.round((y.getTime() - x.getTime()) / 86400000)
  }

  function renderSetCard(state) {
    var st = state.settings
    var avg = state.prediction.averageCycle
    var lead = avg
      ? '按你最近 ' + state.prediction.cycleSampleCount + ' 个周期算出的平均是 ' +
        avg + ' 天，已经自动用它来预测；这两个数字只在记录不足时兜底。'
      : '还没有足够的历史来校准，先按这里的数字估算。记录满 2 次经期后会自动改用你的实际平均。'

    var changed = st.cycleLength !== state.savedSettings.cycleLength ||
      st.periodLength !== state.savedSettings.periodLength

    return '' +
      '<div class="pd-setcard card">' +
        '<div class="pd-sett"><span class="pd-tt-ic">⚙️</span>周期设置</div>' +
        '<div class="pd-setlead">' + esc(lead) + '</div>' +
        '<div class="pd-setgrid">' +
          '<div class="pd-setfield">' +
            '<div class="pd-sl">平均周期天数</div>' +
            '<div class="pd-input">' +
              '<input type="number" id="pd-cycle" inputmode="numeric" ' +
                'min="15" max="60" value="' + esc(st.cycleLength) + '">' +
              '<i>天</i>' +
            '</div>' +
          '</div>' +
          '<div class="pd-setfield">' +
            '<div class="pd-sl">经期天数</div>' +
            '<div class="pd-input">' +
              '<input type="number" id="pd-period" inputmode="numeric" ' +
                'min="1" max="15" value="' + esc(st.periodLength) + '">' +
              '<i>天</i>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pd-setfoot">' +
          '<span>' + (state.prediction.cycleSource === 'history'
            ? '当前预测用的是历史实际平均 ' + esc(state.prediction.cycleDays) + ' 天'
            : '当前预测用的是设置值 ' + esc(state.prediction.cycleDays) + ' 天') + '</span>' +
          '<span class="pd-save ' + (changed ? 'on' : 'off') + '" id="pd-save-set">' +
            (changed ? '保存设置' : '已是当前设置') +
          '</span>' +
        '</div>' +
      '</div>'
  }

  function renderGuide() {
    var out = []
    for (var i = 0; i < P.CARE_GUIDE.length; i++) {
      var g = P.CARE_GUIDE[i]
      var lis = []
      for (var j = 0; j < g.lines.length; j++) lis.push('<li>' + esc(g.lines[j]) + '</li>')
      out.push(
        '<div class="pd-block">' +
          '<span class="pd-bh">' + esc(g.icon) + ' ' + esc(g.title) + '</span>' +
          '<ul>' + lis.join('') + '</ul>' +
        '</div>'
      )
    }
    return '' +
      '<div class="pd-guide card">' +
        '<div class="pd-gt"><span class="pd-tt-ic">🌸</span>经期护理指南</div>' +
        '<div class="pd-glead">日常能做的事，做到就很好，做不到也不用自责。</div>' +
        out.join('') +
        '<div class="pd-disc">' + esc(P.CARE_DISCLAIMER) + '</div>' +
      '</div>'
  }

  function renderHero(state) {
    var s = P.summaryOf(state.prediction)
    var p = state.prediction
    var sub = s.sub

    var track = ''
    if (p.ready) {
      track =
        '<div class="pd-track">' +
          '<div class="pd-pill">' +
            '<div class="pd-pk">上次开始</div>' +
            '<div class="pd-pv">' + esc(P.formatMD(p.lastStart)) + '</div>' +
            '<div class="pd-pd">已记录</div>' +
          '</div>' +
          '<div class="pd-pill predicted">' +
            '<div class="pd-pk">预计下次</div>' +
            '<div class="pd-pv">' + esc(P.formatMD(p.nextStart)) + '</div>' +
            '<div class="pd-pd">共 ' + esc(p.periodLength) + ' 天</div>' +
          '</div>' +
        '</div>' +
        '<div class="pd-track-note">虚线框是推算出来的，不是真实记录。</div>'
    }

    return '' +
      '<div class="pd-hero">' +
        '<div class="pd-hero-top">' +
          '<span class="pd-hero-ic">' + hoodSvg(34) + '</span>' +
          '<div>' +
            '<div class="pd-k">' + (p.ready ? '距离下次经期' : '经期预测') + '</div>' +
            '<div class="pd-big">' + esc(s.text) + '</div>' +
          '</div>' +
        '</div>' +
        (sub ? '<div class="pd-sub">' + esc(sub) + '</div>' : '') +
        track +
        '<div class="pd-note">' + esc(P.PREDICT_NOTE) + '</div>' +
      '</div>'
  }

  function renderForm(state) {
    var log = state.log
    var today = state.prediction.today
    // 同上：relDay 要的是"今天 → 选中日"的偏移
    var diff = daysBetweenKeys(today, state.selected)
    var isToday = state.selected === today
    var isFuture = diff > 0

    // 月经量
    var flows = []
    for (var i = 0; i < P.FLOW_OPTIONS.length; i++) {
      var f = P.FLOW_OPTIONS[i]
      flows.push('<span class="pd-chip' + (log.flow === f.key ? ' on' : '') +
        '" data-flow="' + esc(f.key) + '">' + esc(f.label) + '</span>')
    }

    // 症状
    var syms = []
    for (var j = 0; j < P.SYMPTOM_OPTIONS.length; j++) {
      var s = P.SYMPTOM_OPTIONS[j]
      syms.push('<span class="pd-chip' + (log.symptoms.indexOf(s.key) >= 0 ? ' on' : '') +
        '" data-sym="' + esc(s.key) + '">' + esc(s.label) + '</span>')
    }

    // 情绪
    var moods = []
    for (var k = 0; k < P.MOOD_OPTIONS.length; k++) {
      var m = P.MOOD_OPTIONS[k]
      moods.push('<span class="pd-chip' + (log.moods.indexOf(m.key) >= 0 ? ' on' : '') +
        '" data-mood="' + esc(m.key) + '"><em>' + esc(m.emoji) + '</em>' + esc(m.label) + '</span>')
    }

    var dayLabel = isToday ? '今天' : relDay(diff)
    // 回看下界：到了最早那天，左箭头也置灰（和右箭头同样处理）
    var atOldest = diff <= -LOOKBACK_DAYS

    return '' +
      '<div class="pd-day">' +
        '<span class="pd-arrow' + (atOldest ? ' off' : '') + '" id="pd-prev" ' +
          (atOldest ? 'aria-disabled="true"' : '') + '>‹</span>' +
        '<span class="pd-daynow">' +
          '<b>' + esc(P.formatDateCN(state.selected)) + '</b>' +
          '<em class="' + (isToday ? 'today' : '') + '">' + esc(dayLabel) + '</em>' +
        '</span>' +
        '<span class="pd-arrow' + (isFuture ? ' off' : '') + '" id="pd-next" ' +
          (isFuture ? 'aria-disabled="true"' : '') + '>›</span>' +
      '</div>' +

      '<div class="pd-card card">' +
        '<div class="pd-title">' +
          '<span class="pd-tt-ic">📝</span>今日记录' +
          '<span class="pd-date">' + esc(P.formatDateCN(state.selected)) + '</span>' +
        '</div>' +

        '<div class="pd-field">' +
          '<div class="pd-label">月经量<span class="pd-hint">单选</span></div>' +
          '<div class="pd-chips pd-g4">' + flows.join('') + '</div>' +
        '</div>' +

        '<div class="pd-field">' +
          '<div class="pd-label">症状<span class="pd-hint">可多选</span></div>' +
          '<div class="pd-chips">' + syms.join('') + '</div>' +
        '</div>' +

        '<div class="pd-field">' +
          '<div class="pd-label">情绪<span class="pd-hint">可多选</span></div>' +
          '<div class="pd-chips">' + moods.join('') + '</div>' +
        '</div>' +

        '<div class="pd-note-box">' +
          '<textarea id="pd-note" maxlength="200" ' +
            'placeholder="写点备注…">' + esc(log.note) + '</textarea>' +
          '<div class="pd-count" id="pd-count">' + log.note.length + '/200</div>' +
        '</div>' +

        '<div class="pd-actions">' +
          '<span class="pd-btn primary" id="pd-save">' +
            (isToday ? '保存今天' : '保存 ' + P.formatMD(state.selected)) + '</span>' +
          '<span class="pd-btn plain" id="pd-clear">清空</span>' +
        '</div>' +
      '</div>'
  }

  function render(root_) {
    var state = root_.__pdState
    var p = state.prediction

    root_.innerHTML =
      renderHero(state) +
      renderForm(state) +
      '<div class="pd-card card">' +
        '<div class="pd-title"><span class="pd-tt-ic">📖</span>记录一览' +
          '<span class="pd-date">最近 ' + Math.min(Object.keys(state.logs).length, 10) + ' 条</span>' +
        '</div>' +
        '<div style="margin-top:12px">' + renderHistory(state) + '</div>' +
      '</div>' +
      renderSetCard(state) +
      renderGuide()

    bindEvents(root_, state)
  }

  /* ============================================================
     交互
     ============================================================ */

  function paintChipGroup(container, attr, activeSet) {
    var chips = container.querySelectorAll('.pd-chip[' + attr + ']')
    for (var i = 0; i < chips.length; i++) {
      var key = chips[i].getAttribute(attr)
      chips[i].classList.toggle('on', activeSet.indexOf(key) >= 0)
    }
  }

  function bindEvents(host, state) {
    var form = host.querySelector('.pd-card')
    if (!form) return

    // 月经量：单选，点已选中的可以取消
    var flowBox = host.querySelector('.pd-chips.pd-g4')
    if (flowBox) {
      flowBox.addEventListener('click', function (ev) {
        var el = ev.target.closest ? ev.target.closest('.pd-chip[data-flow]') : null
        if (!el) return
        var key = el.getAttribute('data-flow')
        state.log.flow = (state.log.flow === key) ? '' : key
        paintChipGroup(flowBox, 'data-flow', state.log.flow ? [state.log.flow] : [])
      })
    }

    // 症状：多选
    var fields = host.querySelectorAll('.pd-field')
    var symWrap = fields[1]
    if (symWrap) {
      var box = symWrap.querySelector('.pd-chips')
      box.addEventListener('click', function (ev) {
        var el = ev.target.closest ? ev.target.closest('.pd-chip[data-sym]') : null
        if (!el) return
        toggleKey(state.log.symptoms, el.getAttribute('data-sym'), P.SYMPTOM_OPTIONS)
        paintChipGroup(box, 'data-sym', state.log.symptoms)
      })
    }

    // 情绪：多选
    var moodWrap = fields[2]
    if (moodWrap) {
      var mbox = moodWrap.querySelector('.pd-chips')
      mbox.addEventListener('click', function (ev) {
        var el = ev.target.closest ? ev.target.closest('.pd-chip[data-mood]') : null
        if (!el) return
        toggleKey(state.log.moods, el.getAttribute('data-mood'), P.MOOD_OPTIONS)
        paintChipGroup(mbox, 'data-mood', state.log.moods)
      })
    }

    // 备注计数
    var note = host.querySelector('#pd-note')
    var count = host.querySelector('#pd-count')
    if (note && count) {
      note.addEventListener('input', function () {
        count.textContent = note.value.length + '/200'
      })
    }

    // 保存
    var save = host.querySelector('#pd-save')
    if (save) {
      save.addEventListener('click', function () {
        var dateKey = state.selected
        state.log.note = note ? note.value : ''
        persistLog(state)
        reload(state, dateKey)
        render(host, state)
        toast(dateKey === state.prediction.today ? '今天记录好了' : '记录已保存')
      })
    }

    // 清空当天
    var clear = host.querySelector('#pd-clear')
    if (clear) {
      clear.addEventListener('click', function () {
        var dateKey = state.selected
        clearLog(state, dateKey)
        reload(state, dateKey)
        render(host, state)
        toast('已清空 ' + P.formatMD(dateKey) + ' 的记录')
      })
    }

    // 前一天 / 后一天
    var prev = host.querySelector('#pd-prev')
    var next = host.querySelector('#pd-next')
    if (prev) {
      prev.addEventListener('click', function () {
        var t = P.todayKey(P.addDays(state.selected, -1))
        // 最多回看 90 天，免得一路点到几年前
        if (daysBetweenKeys(t, state.prediction.today) > LOOKBACK_DAYS) return
        reload(state, t)
        render(host, state)
      })
    }
    if (next) {
      next.addEventListener('click', function () {
        var t = P.todayKey(P.addDays(state.selected, 1))
        // ⚠️ 方向：daysBetweenKeys(今天, t) > 0 才代表 t 在未来。
        //    写成 (t, 今天) 会把未来判成过去，直接放行（踩过一次）。
        if (daysBetweenKeys(state.prediction.today, t) > 0) return
        reload(state, t)
        render(host, state)
      })
    }

    // 周期设置
    var cyc = host.querySelector('#pd-cycle')
    var per = host.querySelector('#pd-period')
    var saveSet = host.querySelector('#pd-save-set')
    function onSetInput() {
      state.settings.cycleLength = clampInt(cyc.value, 15, 60, state.savedSettings.cycleLength)
      state.settings.periodLength = clampInt(per.value, 1, 15, state.savedSettings.periodLength)
      state.settingsDirty = true
      var changed = state.settings.cycleLength !== state.savedSettings.cycleLength ||
        state.settings.periodLength !== state.savedSettings.periodLength
      saveSet.className = 'pd-save ' + (changed ? 'on' : 'off')
      saveSet.textContent = changed ? '保存设置' : '已是当前设置'
    }
    if (cyc && per && saveSet) {
      cyc.addEventListener('input', onSetInput)
      per.addEventListener('input', onSetInput)
      saveSet.addEventListener('click', function () {
        if (saveSet.className.indexOf('on') < 0) return
        persistSettings(state)
        reload(state, state.selected)
        render(host, state)
        toast('周期设置已保存')
      })
    }
  }

  function toggleKey(list, key, options) {
    var i = list.indexOf(key)
    if (i >= 0) { list.splice(i, 1); return list }
    list.push(key)
    // 按选项表顺序排，避免点选顺序影响展示
    var order = {}
    for (var j = 0; j < options.length; j++) order[options[j].key] = j
    list.sort(function (a, b) { return order[a] - order[b] })
    return list
  }

  function toast(msg) {
    var doc = root.document
    if (!doc || !doc.getElementById) return
    var el = doc.getElementById('toast')
    if (!el) return
    el.textContent = msg
    if (el.classList) el.classList.add('on')
    setTimeout(function () { if (el.classList) el.classList.remove('on') }, 1600)
  }

  /* ============================================================
     状态与挂载
     ============================================================ */

  /**
   * 重新算预测 + 载入选中日的记录。
   * 真实模式下每次都从共享层重读，所以「保存 → 重渲染」能看到持久化后的结果。
   */
  function reload(state, selectedKey) {
    if (state.mode !== 'sim') {
      state.logs = P.loadLogs()
      var st = P.loadSettings()
      state.savedSettings = { cycleLength: st.cycleLength, periodLength: st.periodLength }
      if (!state.settingsDirty) state.settings = st
    }
    var pred = P.computePrediction(
      state.logs,
      state.settings,
      // 传 null 时用真实系统时间；P.setToday() 可以另设一个"假装今天"
      state.mode === 'sim' ? state.now : null
    )
    state.prediction = pred
    state.selected = selectedKey || state.selected || pred.today

    var raw = state.logs[state.selected]
    var log = P.normalizeLog(state.selected, raw || {})
    // 最近 30 天以内、且不是未来、也没记录的日期，预选「无」（默认值更贴近现实）。
    // 用显式比较而不是 daysBetweenKeys 的正负，免得再被方向坑一次。
    if (!raw && !log.flow && state.selected <= pred.today) {
      var back = daysBetweenKeys(pred.today, state.selected) // 过去为负
      if (back >= -30) log.flow = 'none'
    }
    state.log = log
    return state
  }

  /** 把表单里的值落盘（预览模式下只改内存） */
  function persistLog(state) {
    var log = P.normalizeLog(state.selected, state.log)
    if (!log) return null
    log.updatedAt = Date.now()
    log.updatedBy = state.uid

    if (state.mode === 'sim') {
      if (P.isLogEmpty(log)) delete state.logs[state.selected]
      else state.logs[state.selected] = log
      return log
    }
    if (P.isLogEmpty(log)) {
      if (LS && LS.removePeriodLog) LS.removePeriodLog(state.selected)
      delete state.logs[state.selected]
      return null
    }
    if (LS && LS.setPeriodLog) LS.setPeriodLog(state.uid, state.selected, log)
    state.logs[state.selected] = log
    return log
  }

  /** 清空某天的记录 */
  function clearLog(state, dateKey) {
    if (state.mode !== 'sim' && LS && LS.removePeriodLog) LS.removePeriodLog(dateKey)
    delete state.logs[dateKey]
  }

  function persistSettings(state) {
    var saved = P.saveSettings(state.settings, state.uid)
    state.settingsDirty = false
    state.savedSettings = { cycleLength: saved.cycleLength, periodLength: saved.periodLength }
    state.settings = { cycleLength: saved.cycleLength, periodLength: saved.periodLength }
    return saved
  }

  /**
   * 挂载。
   * @param {HTMLElement} host 容器（#period-slot）
   * @param {object} [opts] { uid, now, seed }
   */
  function mount(host, opts) {
    if (!host || !P) return null
    if (host.__pdState) return host.__pdState // 防止重复挂载

    var o = opts || {}
    var q = readQuery()
    var state = {
      uid: o.uid || q.uid || 'me',
      mode: 'real',
      now: o.now || q.now || null,
      logs: {},
      settings: { cycleLength: 28, periodLength: 7 },
      savedSettings: { cycleLength: 28, periodLength: 7 },
      settingsDirty: false,
      selected: '',
      log: null,
      prediction: null,
      errors: []
    }

    // 预览：?seed= 明确指定，或 ?now= 时默认给一套规律数据
    // ⚠️ q.seed 是 undefined 时必须挡住，否则会写成 `undefined || (false ? ...)` 之外的意外值；
    //    另外 opts 里显式传 seed:'none' 要能压过默认值。
    var seedName = o.seed !== undefined ? o.seed
      : (q.seed !== undefined ? q.seed
        : (state.now ? 'regular' : ''))
    if (seedName) {
      state.mode = 'sim'
      state.logs = expandSeed(SEEDS[seedName] || SEEDS.regular)
      state.settings = P.normalizeSettings({ cycleLength: 28, periodLength: 7 })
    } else {
      state.logs = P.loadLogs()
      state.settings = P.loadSettings()
    }
    state.savedSettings = {
      cycleLength: state.settings.cycleLength,
      periodLength: state.settings.periodLength
    }

    host.__pdState = state

    try {
      reload(state, '')
    } catch (e) {
      state.errors.push(String((e && e.message) || e))
      host.innerHTML = '<div class="pd-empty">例假模块渲染出错：' + esc(state.errors[0]) + '</div>'
      return state
    }

    render(host, state)

    // 真实模式下对方改了记录 / 设置，本页跟着刷新
    if (state.mode === 'real' && LS && LS.watch) {
      LS.watch('periodLog', function () {
        reload(state, state.selected)
        render(host, state)
      })
      LS.watch('periodSettings', function () {
        reload(state, state.selected)
        render(host, state)
      })
    }

    return state
  }

  var api = {
    /** 版本标记：接错文件 / 吃了缓存时，靠它一眼看出来 */
    version: 'period-ui/2026-10-10-a',
    mount: mount,
    render: render,
    reload: reload,
    daysBetweenKeys: daysBetweenKeys,
    relDay: relDay,
    readQuery: readQuery,
    hoodSvg: hoodSvg,
    expandSeed: expandSeed,
    SEEDS: SEEDS
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.PeriodUI = api
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this))
