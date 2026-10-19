/* ============================================================
   恋爱小管家 · 「装到桌面」提示条
   ------------------------------------------------------------
   在浏览器标签里打开 ≠ 装成 App：
     标签页永远带网址栏和加载进度条，用户会觉得"这就是个网页"。
   装到桌面之后是独立窗口（没有网址栏、打开更快、能离线看）。
   所以这里在首页顶部提示一次；用户点 ✕ 就永久不再出现。

   用法（index.html 里）：
     window.InstallTip.init({ slot: document.getElementById('home-slot'), toast: toast })
   ============================================================ */
;(function (root) {
  'use strict'

  var LS_OFF = 'couple_install_tip_off'
  var el = null

  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true
    } catch (e) { /* 老浏览器 */ }
    if (window.navigator.standalone === true) return true      /* iOS Safari 专有 */
    if (/[?&]pwa=1/.test(location.search)) return true         /* 出图/预览用 */
    return false
  }

  function isIOS() {
    var ua = navigator.userAgent || ''
    if (/iPad|iPhone|iPod/.test(ua)) return true
    /* 新 iPad 的 UA 伪装成 Mac，靠触点数判断 */
    return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  }

  function dismissed() {
    try { return localStorage.getItem(LS_OFF) === '1' } catch (e) { return false }
  }

  function manualSteps() {
    if (isIOS()) {
      return 'iPhone / iPad（必须用 Safari 打开，微信里打开不行）：\n' +
        '① 点屏幕底部中间的「分享」按钮（方框+向上箭头）\n' +
        '② 往下滑，选「添加到主屏幕」\n' +
        '③ 右上角「添加」'
    }
    return '安卓（Chrome）：\n' +
      '① 点右上角「⋮」\n' +
      '② 选「添加到主屏幕」或「安装应用」\n' +
      '③ 确认\n\n' +
      '如果菜单里没有这两项，说明这个浏览器不支持，换成 Chrome 再打开一次。'
  }

  function init(opts) {
    opts = opts || {}
    var slot = opts.slot
    if (!slot || !slot.insertBefore) return false

    var old = document.querySelector('.it-card')
    if (old && old.parentNode) old.parentNode.removeChild(old)
    el = null
    if (isStandalone() || dismissed()) return false

    el = document.createElement('div')
    el.className = 'it-card'
    el.innerHTML =
      '<span class="it-ic">🎀</span>' +
      '<div class="it-tx">' +
        '<div class="it-t">装到桌面，就像 App 一样<span class="tag">推荐</span></div>' +
        '<div class="it-d">现在这个页面带着<b>网址栏</b>，还会显示加载进度条。' +
        '装到桌面后：没有网址栏、打开更快、断网也能看。</div>' +
        '<div class="it-body"></div>' +
      '</div>' +
      '<button class="it-go" type="button">装到桌面</button>' +
      '<button class="it-x" type="button" aria-label="不再提示">✕</button>'

    slot.insertBefore(el, slot.firstChild)

    var body = el.querySelector('.it-body')
    var go = el.querySelector('.it-go')
    var x = el.querySelector('.it-x')

    function showSteps() {
      if (body.querySelector('.it-steps')) return
      var d = document.createElement('div')
      d.className = 'it-steps'
      d.textContent = manualSteps()
      body.appendChild(d)
    }

    go.addEventListener('click', function () {
      var ev = window.__installEvent
      if (ev && ev.prompt) {
        /* 必须在用户手势里调，否则浏览器会忽略 */
        try { ev.prompt() } catch (e) { showSteps(); return }
        if (ev.userChoice && ev.userChoice.then) {
          ev.userChoice.then(function (c) {
            window.__installEvent = null
            if (c && c.outcome === 'accepted') {
              if (opts.toast) opts.toast('开始安装…')
              hide()
            } else {
              showSteps()      /* 用户拒绝了自动安装 → 给手动步骤 */
            }
          })
        } else {
          window.__installEvent = null
          hide()
        }
        return
      }
      /* 没有自动安装能力（iOS / 微信 / 已经装过）→ 直接给手动步骤 */
      showSteps()
    })

    x.addEventListener('click', function () {
      try { localStorage.setItem(LS_OFF, '1') } catch (e) { /* ignore */ }
      hide()
    })

    /* 浏览器稍后才抛出可安装事件 → 到时候自动把卡片准备好 */
    document.addEventListener('couple-installable', function () {
      if (el) hide()          /* 已经能装了，卡片留着反而碍事，用户点过一次就够了 */
    })

    return true
  }

  function hide() {
    if (el) el.classList.add('gone')
    el = null
  }

  root.InstallTip = {
    init: init,
    hide: hide,
    isStandalone: isStandalone,
    manualSteps: manualSteps,
    dismissed: dismissed
  }
})(typeof self !== 'undefined' ? self : this)
