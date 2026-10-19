/**
 * 共同相册 —— 页面渲染与交互（独立文件）
 * ------------------------------------------------------------
 * 用法（index.html 里只需要两行）：
 *   var st = AlbumUI.mount(document.getElementById('album-slot'))
 *
 * 依赖（顺序不能变）：data/album.js
 * （刻意**不依赖** shared-data.js：相册自己一套存储，免得和别的会话改同一个文件撞车。
 *   接云开发时把 data/album.js 的 provider 换成 cloud 即可，本文件一行不用动。）
 *
 * 需求原文（用户 2026-10-10 定，别自作主张改）：
 *   - 双方都能上传
 *   - 上方「图片库」入口 → 点进去 = 全部上传好的照片
 *   - 下方 = 展示的照片（默认全部展示）
 *   - 通过**右下角小设置**选择「哪些不展示」（多选网格，勾选 = 不展示）
 *   - 删除：**双方都能删任意一张**，UI 要有二次确认
 *
 * 视图：
 *   home 相册主页（图片库入口 + 展示区网格 + 右下角小设置）
 *   lib  图片库（全部照片，含已隐藏；上传按钮在这里）
 *
 * 预览调试参数（和 ?page=album 拼）：
 *   ?seed=demo     9 张演示照片（其中 2 张已隐藏）
 *   ?seed=demo-all 12 张全展示
 *   ?seed=empty    空相册（看空态）
 *   ?view=lib      直接进图片库
 *   ?set=1         直接打开「选择哪些不展示」面板
 *   ?open=0        直接打开第 N 张的大图（0 起数）
 * 带 ?seed= 时数据只在内存里，**不落盘**。
 */

/* global Album */
;(function (root) {
  'use strict'

  var A = root.Album

  var MY_UID = (function () {
    try {
      var m = /[?&]uid=([AB])/.exec(location.search)
      return m ? m[1] : 'A'
    } catch (e) { return 'A' }
  })()

  function qs(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search)
      return m ? decodeURIComponent(m[1]) : ''
    } catch (e) { return '' }
  }

  /* ============================================================
     图标：全部内联 SVG path（原创线条，不复刻任何注册形象）
     不用 <use href="#g-...">，因为那依赖 index.html 的 defs，
     模块单独打开时会是空白。
     ============================================================ */

  function ico(paths, size, sw) {
    return '<svg viewBox="0 0 32 32" width="' + size + '" height="' + size + '" ' +
      'fill="none" stroke="currentColor" stroke-width="' + (sw || 2.6) + '" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      paths + '</svg>'
  }

  var ICO = {
    cam: function (s) {
      return ico('<rect x="3" y="9" width="26" height="19" rx="6"/>' +
        '<path d="M11 9l2.4-3.4h5.2L21 9"/>' +
        '<circle cx="16" cy="18" r="5"/>', s)
    },
    gear: function (s) {
      // 三条滑杆 + 两个旋钮（通用「设置/调整」语义）。
      // 一开始画的是齿轮，20px 下看着像太阳，换掉。
      return ico('<path d="M6 11h8M20 11h6M6 21h4M16 21h10"/>' +
        '<circle cx="17" cy="11" r="2.8"/><circle cx="13" cy="21" r="2.8"/>', s, 2.4)
    },
    plus: function (s) {
      return ico('<path d="M16 7v18M7 16h18"/>', s, 3)
    },
    back: function (s) {
      return ico('<path d="M19 6l-10 10 10 10"/>', s, 3)
    },
    trash: function (s) {
      return ico('<path d="M6.5 9h19M13 9V6h6v3M9.5 9l1.2 17h10.6L22.5 9"/>' +
        '<path d="M13.6 14v7M18.4 14v7"/>', s, 2.4)
    },
    close: function (s) {
      return ico('<path d="M8 8l16 16M24 8L8 24"/>', s, 3)
    },
    eyeoff: function (s) {
      return ico('<path d="M4 16s5-7 12-7c2.2 0 4.1.6 5.7 1.5M28 16s-5 7-12 7c-2.2 0-4.1-.6-5.7-1.5"/>' +
        '<path d="M6 6l20 20"/>', s, 2.4)
    },
    check: function (s) {
      return ico('<path d="M7 17l6 6L25 9"/>', s, 3.2)
    }
  }

  /* ============================================================
     挂载
     ============================================================ */

  function mount(el) {
    if (!el) return null
    if (!A) {
      el.innerHTML = '<div class="card al-card al-err">相册数据层（data/album.js）没加载</div>'
      return { errors: ['no Album'] }
    }

    var errors = []
    var state = {
      view: qs('view') === 'lib' ? 'lib' : 'home',
      sheetOpen: false,       // 「选择哪些不展示」面板
      picked: {},             // 面板里被勾选的 id（= 不展示）
      viewerId: '',           // 大图查看中的照片 id
      confirming: false,      // 删除的二次确认
      uploading: false,
      uploadText: '',
      demo: false,
      logs: {}
    }

    /* ---------- 骨架（只建一次，之后只改内容） ---------- */

    /* 页面内部分：留在 #album-slot 里 */
    var MAIN_HTML =
        /* ===== 视图 1：主页 ===== */
        '<div class="al-home">' +
          '<div class="card al-libcard" data-act="lib">' +
            '<span class="al-lib-ic">' + ICO.cam(24) + '</span>' +
            '<span class="al-lib-tx">' +
              '<b>图片库</b>' +
              '<i class="al-lib-sub"></i>' +
            '</span>' +
            '<span class="al-lib-n"></span>' +
            '<span class="al-lib-go">›</span>' +
          '</div>' +

          '<div class="al-sec">' +
            '<span class="al-sec-t">展示的照片</span>' +
            '<span class="al-sec-n"></span>' +
            '<i class="al-rule"></i>' +
          '</div>' +

          '<div class="al-grid al-grid-home"></div>' +
          '<div class="al-empty al-empty-home"></div>' +
        '</div>' +

        /* ===== 视图 2：图片库 ===== */
        '<div class="al-lib">' +
          '<div class="al-libbar">' +
            '<span class="al-back" data-act="back">' + ICO.back(18) + '</span>' +
            '<span class="al-libbar-t">图片库<i class="al-libbar-n"></i></span>' +
            '<span class="al-up" data-act="upload">' + ICO.plus(18) + '上传</span>' +
          '</div>' +
          '<div class="al-tip">点开图片可以删除 · 用右下角小设置选择哪些不展示</div>' +
          '<div class="al-grid al-grid-lib"></div>' +
          '<div class="al-empty al-empty-lib"></div>' +
        '</div>'

    /* 浮层部分：必须挂在 <body> 上，不能留在页面容器里。
       ------------------------------------------------------------
       index.html 的 .content{position:relative;z-index:1} 是一个**层叠上下文**，
       装在它里面的元素 z-index 调多高都翻不过 body 层的 .tabbar(z-index:99)：
       实测表现就是面板底部的「取消 / 保存」被 tabBar 整条吃掉。
       （小猪挂件当初放在 .screen 外面，也是同一个原因。） */
    var OVERLAY_HTML =
        /* ===== 右下角小设置（浮动） ===== */
        '<div class="al-fab" data-act="sheet">' + ICO.gear(20) + '</div>' +

        /* ===== 「选择哪些不展示」面板 ===== */
        '<div class="al-mask" data-act="sheet-close"></div>' +
        '<div class="al-sheet">' +
          '<div class="al-sheet-hd">' +
            '<b>选择哪些不展示</b>' +
            '<span>勾上的照片不会出现在「展示的照片」里，<em>不会被删掉</em></span>' +
          '</div>' +
          '<div class="al-grid al-grid-pick"></div>' +
          '<div class="al-sheet-ft">' +
            '<span class="al-btn plain" data-act="sheet-cancel">取消</span>' +
            '<span class="al-btn primary" data-act="sheet-save">保存</span>' +
          '</div>' +
        '</div>' +

        /* ===== 大图查看 ===== */
        '<div class="al-viewer">' +
          '<div class="al-viewer-mask" data-act="viewer-close"></div>' +
          '<div class="al-viewer-card">' +
            '<img class="al-viewer-img" alt="">' +
            '<div class="al-viewer-info">' +
              '<div class="al-viewer-meta"></div>' +
              '<div class="al-viewer-cap"></div>' +
            '</div>' +
            '<div class="al-viewer-act">' +
              '<span class="al-btn plain" data-act="viewer-close">关闭</span>' +
              '<span class="al-btn danger" data-act="viewer-del">删除</span>' +
            '</div>' +
          '</div>' +
        '</div>' +

        /* ===== 隐藏的文件选择框 + 轻提示 ===== */
        '<input class="al-file" type="file" accept="image/*" multiple>' +
        '<div class="al-toast"></div>'

    /* ---------- 建 DOM ---------- */
    el.innerHTML = '<div class="al-root">' + MAIN_HTML + '</div>'

    // 浮层容器挂在 body 上（跟 .tabbar / 小猪挂件同一层）
    var ov = document.createElement('div')
    ov.className = 'al-overlays'
    ov.innerHTML = OVERLAY_HTML
    document.body.appendChild(ov)

    /* ---------- 引用缓存 ---------- */
    /** 页面内的元素和浮层分两个容器，所以查询要两处都找 */
    var $ = function (sel) { return el.querySelector(sel) || ov.querySelector(sel) }
    var rootEl = $('.al-root')
    var homeEl = $('.al-home')
    var libEl = $('.al-lib')
    var gridHome = $('.al-grid-home')
    var gridLib = $('.al-grid-lib')
    var gridPick = $('.al-grid-pick')
    var emptyHome = $('.al-empty-home')
    var emptyLib = $('.al-empty-lib')
    var sheetEl = $('.al-sheet')
    var maskEl = $('.al-mask')
    var viewerEl = $('.al-viewer')
    var fileEl = $('.al-file')
    var toastEl = $('.al-toast')

    /* ---------- 轻提示 ---------- */
    var toastTimer = null
    function toast(msg) {
      toastEl.textContent = msg
      toastEl.classList.add('on')
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(function () { toastEl.classList.remove('on') }, 2200)
    }

    /* ============================================================
       渲染
       ============================================================ */

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    /** 一张照片的格子。mode: 'home' | 'lib' | 'pick' */
    function tileHtml(p, mode) {
      // pick 模式：格子表达的是「将会怎样」，不是「现在是怎样」，
      // 所以不套 .off（否则取消勾选后还是暗的，看着像没生效）
      var cls = 'al-tile'
      if (mode !== 'pick' && p.hidden) cls += ' off'
      if (mode === 'pick' && state.picked[p.id]) cls += ' picked'
      var badge = ''
      if (mode === 'pick') {
        badge = '<span class="al-pickmark">' + ICO.check(13) + '</span>'
      } else if (p.hidden) {
        badge = '<span class="al-badge">' + ICO.eyeoff(11) + '已隐藏</span>'
      }
      var who = mode === 'pick'
        ? ''
        : '<span class="al-who">' + esc(A.whoLabel(p.uploaderUid, MY_UID)) + '</span>'
      return '<div class="' + cls + '" data-id="' + esc(p.id) + '" data-mode="' + mode + '">' +
        '<img src="' + esc(A.srcOf(p)) + '" alt="" loading="lazy" draggable="false">' +
        who + badge +
      '</div>'
    }

    function gridHtml(list, mode) {
      var h = ''
      for (var i = 0; i < list.length; i++) h += tileHtml(list[i], mode)
      return h
    }

    /** 主渲染：把数据画到两个视图 + 面板上 */
    function render() {
      var all = A.list()
      var vis = A.visible()
      var hid = A.hiddenList()
      var c = A.counts()

      // ---- 图片库入口卡 ----
      $('.al-lib-n').textContent = c.total + ' 张'
      var sub = c.total
        ? (c.hidden ? ('共 ' + c.total + ' 张 · 展示 ' + c.visible + ' 张 · 不展示 ' + c.hidden + ' 张')
                    : ('共 ' + c.total + ' 张 · 全部在展示'))
        : '还没有照片，点这里上传第一张'
      $('.al-lib-sub').textContent = sub

      // ---- 展示区 ----
      $('.al-sec-n').textContent = c.hidden
        ? (c.visible + ' 张 · 另有 ' + c.hidden + ' 张不展示')
        : (c.visible + ' 张')
      gridHome.innerHTML = gridHtml(vis, 'home')
      gridHome.style.display = vis.length ? '' : 'none'
      if (vis.length) {
        emptyHome.className = 'al-empty al-empty-home'
        emptyHome.innerHTML = ''
      } else {
        emptyHome.innerHTML =
          '<div class="al-empty-ic">' + ICO.cam(36) + '</div>' +
          '<div class="al-empty-t">' + (c.total ? '所有照片都被设为「不展示」了' : '还没有照片') + '</div>' +
          '<div class="al-empty-d">' +
            (c.total
              ? '点右下角的小设置，把想看的照片取消勾选'
              : '点上面的「图片库」上传第一张，双方都能传') +
          '</div>' +
          '<span class="al-empty-btn" data-act="lib">去图片库上传</span>'
      }

      // ---- 图片库 ----
      $('.al-libbar-n').textContent = c.total ? ('（' + c.total + '）') : ''
      gridLib.innerHTML = gridHtml(all, 'lib')
      gridLib.style.display = all.length ? '' : 'none'
      if (all.length) {
        emptyLib.innerHTML = ''
      } else {
        emptyLib.innerHTML =
          '<div class="al-empty-ic">' + ICO.cam(36) + '</div>' +
          '<div class="al-empty-t">图片库是空的</div>' +
          '<div class="al-empty-d">点右上角「+ 上传」选照片（可一次选多张）</div>'
      }

      // ---- 面板里的多选网格 ----
      gridPick.innerHTML = gridHtml(all, 'pick')
      paintSheetCount()

      // ---- 视图切换 ----
      homeEl.style.display = state.view === 'home' ? '' : 'none'
      libEl.style.display = state.view === 'lib' ? '' : 'none'

      // ---- 面板 / 大图 ----
      sheetEl.classList.toggle('on', state.sheetOpen)
      maskEl.classList.toggle('on', state.sheetOpen)
      document.body.classList.toggle('al-lock', state.sheetOpen || !!state.viewerId)
      paintViewer()

      // 出图脚本靠这个判断渲染完成 / 有没有报错（挂在 window 上）
      root.__alReady = {
        view: state.view,
        total: c.total,
        visible: c.visible,
        hidden: c.hidden,
        sheetOpen: state.sheetOpen,
        picked: Object.keys(state.picked).length,
        viewer: state.viewerId,
        demo: state.demo,
        errors: errors
      }
    }

    function paintSheetCount() {
      var n = Object.keys(state.picked).length
      var save = $('.al-sheet-ft .primary')
      if (save) save.textContent = n ? ('保存（不展示 ' + n + ' 张）') : '保存（全部展示）'
    }

    /* ---------- 大图查看 ---------- */
    function paintViewer() {
      var p = state.viewerId ? A.get(state.viewerId) : null
      if (!p) {
        viewerEl.classList.remove('on')
        return
      }
      viewerEl.classList.add('on')
      $('.al-viewer-img').src = A.srcOf(p)

      var bits = []
      bits.push(esc(A.whoLabel(p.uploaderUid, MY_UID)) + ' 上传')
      bits.push(esc(A.friendlyTime(p.uploadedAt)))
      if (p.width && p.height) bits.push(p.width + '×' + p.height)
      if (p.size) bits.push(esc(A.fmtSize(p.size)))
      if (p.hidden) bits.push('已隐藏')
      $('.al-viewer-meta').textContent = bits.join(' · ')

      var capEl = $('.al-viewer-cap')
      capEl.textContent = p.caption || ''
      capEl.style.display = p.caption ? '' : 'none'

      // 删除的二次确认：**不用 window.confirm** —— 出图的无头浏览器会卡死在弹窗上
      var del = $('.al-viewer-act .danger')
      del.textContent = state.confirming ? '确认删除？' : '删除'
      del.classList.toggle('sure', state.confirming)
    }

    /* ============================================================
       交互
       ============================================================ */

    function openLib() { state.view = 'lib'; render(); scrollTop() }
    function openHome() { state.view = 'home'; render(); scrollTop() }
    function scrollTop() { try { window.scrollTo(0, 0) } catch (e) { /* ignore */ } }

    /** 打开「选择哪些不展示」：勾选状态从当前真实状态初始化 */
    function openSheet() {
      var all = A.list()
      if (!all.length) { toast('还没有照片，先去图片库上传 ~'); return }
      state.picked = {}
      for (var i = 0; i < all.length; i++) {
        if (all[i].hidden) state.picked[all[i].id] = true   // 已隐藏的默认勾上
      }
      state.sheetOpen = true
      render()
    }

    function closeSheet() {
      state.sheetOpen = false
      state.picked = {}
      render()
    }

    /** 保存：勾选的 → 不展示，没勾的 → 展示。只提交真正变化的那些 */
    function saveSheet() {
      var all = A.list()
      var toHide = [], toShow = []
      for (var i = 0; i < all.length; i++) {
        var want = !!state.picked[all[i].id]
        if (want && !all[i].hidden) toHide.push(all[i].id)
        if (!want && all[i].hidden) toShow.push(all[i].id)
      }

      var changed = 0
      if (toHide.length) {
        var r1 = A.setHiddenMany(toHide, true, MY_UID)
        if (!r1.ok) { toastSave(r1); return }
        changed += r1.changed
      }
      if (toShow.length) {
        var r2 = A.setHiddenMany(toShow, false, MY_UID)
        if (!r2.ok) { toastSave(r2); return }
        changed += r2.changed
      }

      state.sheetOpen = false
      state.picked = {}
      render()
      toast(changed ? ('改好了，展示区现在 ' + A.counts().visible + ' 张') : '没有变化')
    }

    function toastSave(r) {
      toast(r && r.quota
        ? '本地演示版存不下了（约 5MB 上限）。接云开发后没有这个限制'
        : '保存失败，看控制台')
      if (r && r.error) console.error('[album] 保存失败', r.error)
    }

    /* ---------- 上传 ---------- */
    function pickFiles() {
      fileEl.value = ''          // 同一个文件连选两次也能触发 change
      fileEl.click()
    }

    function onFiles(ev) {
      var files = ev.target.files
      if (!files || !files.length) return
      var list = []
      for (var i = 0; i < files.length; i++) list.push(files[i])

      state.uploading = true
      var done = 0
      var failed = 0
      var addedTotal = 0
      var quotaHit = false

      toast('正在处理 ' + list.length + ' 张…')

      /** 串行处理：并行压大图容易把内存打满，而且进度也没法显示 */
      function next() {
        if (done + failed >= list.length) {
          state.uploading = false
          render()
          if (quotaHit) {
            toast('本地演示版存不下了：已存 ' + A.counts().total + ' 张，接云后无上限')
          } else if (addedTotal) {
            toast('上传成功 ' + addedTotal + ' 张' + (failed ? ('，' + failed + ' 张读不出来') : ''))
          } else {
            toast('上传失败，换张图试试')
          }
          return
        }

        var f = list[done + failed]
        A.compress(f).then(function (res) {
          var r = A.addMany([res], MY_UID)
          if (r.ok) addedTotal += r.added
          else { if (r.quota) quotaHit = true; failed++ }
          done++
          render()
          next()
        })['catch'](function (e) {
          console.warn('[album] 压缩失败', e)
          failed++
          next()
        })
      }
      next()
    }

    /* ---------- 删除（双方都能删，但要二次确认） ---------- */
    function onDelete() {
      if (!state.viewerId) return
      if (!state.confirming) {
        state.confirming = true
        paintViewer()
        return
      }
      var id = state.viewerId
      var r = A.remove([id])
      state.confirming = false
      if (!r.ok) { toastSave(r); return }
      state.viewerId = ''
      render()
      toast('删掉了')
    }

    /* ---------- 事件委托 ----------
       浮层挂在 body 上，所以只能绑在 document 上。
       但必须判断命中的是不是相册自己的元素 —— 别去动别的模块（例假/商城/小猪）的东西。 */
    function belongsToAlbum(node) {
      return !!(rootEl && rootEl.contains(node)) || ov.contains(node)
    }

    document.addEventListener('click', function (ev) {
      var t = ev.target
      // 找到最近的一个带 data-act 或 data-id 的节点
      var actEl = t
      while (actEl && actEl !== document.body && !actEl.getAttribute('data-act') &&
             !actEl.getAttribute('data-id')) {
        actEl = actEl.parentNode
      }
      if (!actEl || actEl === document.body) return
      if (!belongsToAlbum(actEl)) return

      var act = actEl.getAttribute('data-act')
      if (act) {
        if (act === 'lib') openLib()
        else if (act === 'back') openHome()
        else if (act === 'upload') pickFiles()
        else if (act === 'sheet') openSheet()
        else if (act === 'sheet-close' || act === 'sheet-cancel') closeSheet()
        else if (act === 'sheet-save') saveSheet()
        else if (act === 'viewer-close') { state.viewerId = ''; state.confirming = false; render() }
        else if (act === 'viewer-del') onDelete()
        return
      }

      // 点的是照片格子
      var id = actEl.getAttribute('data-id')
      var mode = actEl.getAttribute('data-mode')
      if (!id) return

      if (mode === 'pick') {
        // 面板里：只切换勾选，**不重渲染整个面板**（否则滚动位置会跳）
        if (state.picked[id]) delete state.picked[id]
        else state.picked[id] = true
        actEl.classList.toggle('picked', !!state.picked[id])
        paintSheetCount()
        // 诊断对象也要跟着更新，否则出图脚本读到的是过期数字（踩过）
        if (root.__alReady) root.__alReady.picked = Object.keys(state.picked).length
        return
      }

      // 展示区 / 图片库：打开大图
      state.viewerId = id
      state.confirming = false
      render()
    })

    fileEl.addEventListener('change', onFiles)

    /* Esc 关面板/大图（电脑上顺手） */
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return
      if (state.viewerId) { state.viewerId = ''; state.confirming = false; render() }
      else if (state.sheetOpen) closeSheet()
    })

    /* ============================================================
       预览参数（只在内存里，不落盘）
       ============================================================ */
    var seed = qs('seed')
    if (seed) {
      state.demo = true
      if (seed === 'empty') A.setPreview([])
      else if (seed === 'demo-all') A.setPreview(A.demoPhotos(12, 0))
      else A.setPreview(A.demoPhotos(9, 2))     // 默认 demo：9 张，其中 2 张已隐藏
    }

    // 数据变了（另一窗口改了 / 自己改完）→ 重画
    A.watch(function () {
      try { render() } catch (e) { errors.push(String(e && e.message || e)) }
    })

    render()

    // 打开面板 / 大图（截图用）
    if (qs('set') === '1') openSheet()
    var openIdx = qs('open')
    if (openIdx !== '') {
      var arr = A.list()
      var p = arr[parseInt(openIdx, 10) || 0]
      if (p) { state.viewerId = p.id; render() }
    }
    if (state.view === 'lib') render()

    return {
      get view() { return state.view },
      errors: errors,
      counts: A.counts(),
      state: state
    }
  }

  root.AlbumUI = {
    mount: mount,
    ICO: ICO
  }
})(typeof window !== 'undefined' ? window : this)
