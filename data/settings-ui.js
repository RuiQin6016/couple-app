/**
 * 设置面板：同步配对 / 天气 key / 我的身份
 * ============================================================
 * 为什么单独一个文件（而不是写进 index.html）：
 *   沿用月历、相册、例假模块的做法 —— 自带样式与 DOM，
 *   接入 index.html 只需要一个 <link>、一个 <script>、一句 mount()，
 *   改动窗口从上千行压到几行，不会和别的改动撞车。
 *
 * ⚠️ 浮层挂在 <body> 上，不放 .content 里（层叠上下文，见 settings.css 注释）。
 *
 * 配对的三条路径（和实际使用一一对应）：
 *   ① 我是第一个  → 填 GitHub token（只有 gists 权限）→ 生成链接码 → 发给对方
 *   ② 对方配好了  → 粘贴链接码 → 完成
 *   ③ 本机双窗口  → 不连 GitHub，只在本机两个浏览器窗口之间验证同步（调试用）
 *
 * ⚠️ 身份（A / B）必须两边不同：
 *     心情和日记是按「日期 + 人」存的，两台都是 A 会互相覆盖。
 *     所以「我是第一个」自动设 A，「粘贴链接码」自动设 B，另外也允许手动改。
 */

;(function (root) {
  'use strict'

  var app = null
  var hooks = {}
  var view = 'main'
  var overlay = null
  var pending = {}          /* { token, link, fp, err, confirmClear } */
  var unsub = null

  function q(id) { return document.getElementById(id) }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n }

  /** 云端 ID 前 8 位 —— 两台手机必须一样，这是"是不是连的同一个云端"的唯一判据 */
  function gistShort() {
    try {
      if (!app.gistIdOf) return ''
      var g = app.gistIdOf()
      return g ? g.slice(0, 8) : ''
    } catch (e) { return '' }
  }

  /** 相册一句话：几张 + 有没有卡住 */
  function albumLine() {
    try {
      var s = app.status || {}
      var a = s.album || {}
      if (!s.configured) return '未配对'
      var n = (app.albumPhotos ? app.albumPhotos().length : (a.photos || 0))
      return n + ' 张' + (a.error ? ' · 卡住了' : '')
    } catch (e) { return '—' }
  }

  function fmtTime(ts) {
    if (!ts) return '还没同步过'
    var d = new Date(ts)
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  }

  function tip(msg, kind) {
    if (hooks.toast) hooks.toast(msg)
  }

  /* ============================================================
     复制（老浏览器 / 非 https 下 navigator.clipboard 不可用，要有兜底）
     ============================================================ */
  function legacyCopy(text) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', 'readonly')
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    var ok = false
    try { ok = document.execCommand('copy') } catch (e) { ok = false }
    document.body.removeChild(ta)
    return ok
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(function () { return true })
        .catch(function () { return legacyCopy(text) })
    }
    return Promise.resolve(legacyCopy(text))
  }

  /* ============================================================
     渲染
     ============================================================ */

  function statusTag(s) {
    if (s.error) return '<span class="tag err">同步出错</span>'
    if (!s.configured || s.mode === 'local-only') return '<span class="tag warn">只存在本机</span>'
    return '<span class="tag ok">已同步</span>'
  }

  function weatherKey() {
    try { return (window.Weather && window.Weather.AMAP) ? window.Weather.AMAP.key : '' } catch (e) { return '' }
  }

  /** 现在是不是「已经从桌面图标打开」（而不是浏览器标签页） */
  function isInstalled() {
    try { if (window.matchMedia('(display-mode: standalone)').matches) return true } catch (e) { /* 老浏览器 */ }
    if (window.navigator.standalone === true) return true          /* iOS */
    return !!(document.body && document.body.classList.contains('pwa'))
  }

  /**
   * 「装到桌面」卡片。
   * 为什么要这张卡：手机浏览器**不会自动**弹安装提示，入口藏在菜单里，
   * 很多人都找不到（实测反馈就是"没看到有安装应用的地方"）。
   * 如果浏览器给了 beforeinstallprompt，就直接给一键安装按钮；
   * 没给（比如关了 Google Play 服务的国产安卓、或微信内置浏览器）就只能给步骤说明。
   */
  function viewInstall() {
    if (isInstalled()) {
      return '<div class="st-card"><div class="h">装到桌面<span class="tag ok">已装好</span></div>' +
        '<div class="st-d">现在就是从桌面图标打开的 ✓</div></div>'
    }
    var h = '<div class="st-card"><div class="h">装到桌面<span class="tag warn">还没装</span></div>'
    if (window.__installEvent) {
      h += '<div class="st-d">点下面的按钮就能装。装完桌面会出现图标，打开时没有浏览器地址栏。</div>'
      h += '<div class="st-btns"><button class="st-btn primary" id="st-install">装到桌面</button></div>'
    } else {
      h += '<div class="st-d">手机浏览器不会自动弹出安装，要手动点一下：</div>'
      h += '<div class="st-d"><b>安卓 · Chrome</b>：右上角 <b>⋮</b> 菜单 → 「<b>安装应用</b>」；' +
        '这个手机如果没有这一项，就点「<b>添加到主屏幕</b>」，效果类似。<br>' +
        '<b>iPhone · 必须用 Safari</b>：底部中间的<b>分享</b>按钮 → 往下翻到「<b>添加到主屏幕</b>」。</div>'
      h += '<div class="st-note">⚠️ 在<b>微信里点开链接是装不了</b>的（那是微信内置浏览器，没有安装功能）。' +
        '要把网址复制出来，用 Chrome / Safari 打开。</div>'
    }
    h += '</div>'
    return h
  }

  function viewMain() {
    var s = app.status
    var cfgd = !!s.configured
    var h = ''

    /* ---- 装到桌面（放最上面：这是最常卡住的一步） ---- */
    h += viewInstall()

    /* ---- 同步 ---- */
    h += '<div class="st-card">'
    h += '<div class="h">同步' + statusTag(s) + '</div>'
    h += '<div class="st-row"><span class="lbl">方式</span><span class="val">' +
      (cfgd ? (s.provider === 'github' ? 'GitHub 私有 Gist' : '本机两个窗口（调试）') : '未配对') +
      '</span></div>'
    h += '<div class="st-row"><span class="lbl">我的身份</span><span class="val">' + esc(app.uid) + '</span></div>'
    h += '<div class="st-row"><span class="lbl">版本</span><span class="val sel-ok">' +
      esc(window.APP_BUILD || '未知') + '</span></div>' +
      '<div class="st-d">两台手机的「版本」要一样。不一样的那台：完全关掉页面再打开（或下拉刷新），' +
      '让它拿到新代码 —— 旧版本会有同步 bug。</div>'
    h += '<div class="st-row"><span class="lbl">云端 ID</span><span class="val">' +
      (gistShort() ? esc(gistShort()) + '…' : '—') + '</span></div>' +
      (gistShort() ? '<div class="st-d">上面只是<b>前 8 位</b>（显示用）。两台手机的「云端 ID」必须<b>一样</b>。' +
        '不一样 = 各连了各自的云端，就算口令指纹一样也互相看不到 —— ' +
        '这时在这台点「清除这台手机的配对」，再用对方那台的链接码配一次。<br>' +
        '⚠️ 要把 ID 发给别人 / 填到另一台时，<b>不能只发这 8 位</b>：' +
        '真 ID 是 32 位。<button class="st-btn plain sm" id="st-copy-gist">复制完整云端 ID</button></div>' : '')
    h += '<div class="st-row"><span class="lbl">相册</span><span class="val">' + albumLine() + '</span></div>'
    h += '<div class="st-row"><span class="lbl">上次上传</span><span class="val">' + fmtTime(s.lastPush) + '</span></div>'
    h += '<div class="st-row"><span class="lbl">上次拉取</span><span class="val">' + fmtTime(s.lastPull) + '</span></div>'
    if (cfgd) {
      h += '<div class="st-row"><span class="lbl">相册上传</span><span class="val">' +
        fmtTime((s.album || {}).lastPush) + '</span></div>'
      h += '<div class="st-row"><span class="lbl">相册拉取</span><span class="val">' +
        fmtTime((s.album || {}).lastPull) + '</span></div>'
    }
    if (s.error) h += '<div class="st-note err">' + esc(s.error) + '</div>'
    if (cfgd && (s.album || {}).error) h += '<div class="st-note err">相册：' + esc(s.album.error) + '</div>'
    if (cfgd && (s.album || {}).pending > 0) {
      h += '<div class="st-note">还有 ' + (s.album.pending) + ' 批照片没传上去，正在自动重试…</div>'
    }

    if (cfgd) {
      h += '<div class="st-fp"><div class="k">口令指纹（两台手机要一模一样）</div>' +
        '<div class="v" id="st-fpv">计算中…</div></div>'
      h += '<div class="st-d">两台手机的这 12 位必须<b>完全一样</b>，一样才说明能互相读懂。<br>' +
        '<b>不一样</b> = 两台各自生成了自己的口令（最常见的原因：两台都点了「我是第一个」）——' +
        '这时两台互相看不到对方的数据。<br>修法：这台点下面的「清除这台手机的配对」，' +
        '再用另一台的「重新配对」链接码配一次。</div>'
      h += '<div class="st-btns">' +
        '<button class="st-btn plain" id="st-check">🔍 同步体检</button>' +
        '<button class="st-btn plain" id="st-force">⬆️ 强制上传</button>' +
        '<button class="st-btn plain" id="st-sync">立即同步</button>' +
        '<button class="st-btn plain" id="st-repair">重新配对</button>' +
        '</div>'
      if (pending.checkText) {
        h += '<div class="st-note' + (pending.checkErr ? ' err' : '') +
          '" style="white-space:pre-line">' + esc(pending.checkText) + '</div>'
      } else {
        h += '<div class="st-d">「🔍 同步体检」= 去云端看一眼，<b>对方的数据到底有没有传上去</b>。<br>' +
          '「⬆️ 强制上传」= 把<b>这台手机</b>现在的东西硬传一次，成不成功、为什么失败都会写出来 —— ' +
          '对方收不到东西时，让对方在自己手机上点这个，截图发你。</div>'
      }
      h += '<div class="st-btns"><button class="st-btn danger" id="st-clear">' +
        (pending.confirmClear ? '确认清除？' : '清除这台手机的配对') + '</button></div>'
      if (pending.confirmClear) {
        h += '<div class="st-note">清除只是**这台手机**忘掉配对（本机已有的记录不会删）。' +
          '要重新同步，再配一次即可。</div>'
      }
      /* ★ 换云端：万一配成了「本机双窗口（调试）」、或者接错了云端，这里能直接接进
         已有的那个云端。**身份保持 A / B 不变** —— 不走「粘贴链接码」（那条路会把
         设备固定成 B，A 就变成 B 了）。2026-10-11 用户真机上就这么踩过。 */
      h += '<div class="st-btns"><button class="st-btn plain" id="st-join-cloud">' +
        '换个云端（接入已有的）</button></div>'
    } else {
      h += '<div class="st-d">配对之后，两台手机上记的心情、日记、悄悄话会自动同步。' +
        '<b>内容在离开手机前就加密了</b> —— GitHub 上只有密文，连它自己也看不到。</div>'
      h += '<div class="st-btns stack">' +
        '<button class="st-btn primary" id="st-first">我是第一个（生成链接码给对方）</button>' +
        '<button class="st-btn plain" id="st-join">对方已经配好了（粘贴链接码）</button>' +
        '<button class="st-btn plain" id="st-join-cloud">接入已有的云端（换设备 / 配错了）</button>' +
        '</div>'
      h += '<div class="st-btns"><button class="st-btn plain sm" id="st-local" ' +
        'style="margin:0 auto">只是在本机两个窗口试一下</button></div>'
    }
    /* 「同步体检」不管有没有配对都给（没配对时它会直接说"还没配对"）——
       出问题时用户第一个能想到的动作应该是点它，而不是翻各种设置。 */
    if (!cfgd) {
      h += '<div class="st-btns"><button class="st-btn plain" id="st-check">🔍 同步体检</button></div>'
      if (pending.checkText) {
        h += '<div class="st-note' + (pending.checkErr ? ' err' : '') +
          '" style="white-space:pre-line">' + esc(pending.checkText) + '</div>'
      }
    }
    h += '</div>'

    /* ---- 天气 ---- */
    h += '<div class="st-card"><div class="h">天气' +
      (weatherKey() ? '<span class="tag ok">已填</span>' : '<span class="tag warn">示例数据</span>') + '</div>'
    h += '<div class="st-d">填一个高德「<b>Web服务</b>」Key，天气就变成真实的。' +
      '不填也能用，只是显示示例数据。</div>'
    h += '<input class="st-in mono" id="st-amap" type="text" spellcheck="false" ' +
      'placeholder="高德 Web服务 Key" value="' + esc(weatherKey()) + '">'
    h += '<div class="st-btns"><button class="st-btn plain" id="st-amap-save">保存</button></div>'
    h += '<div class="st-d">申请：console.amap.com → 创建应用 → 添加 Key → 服务平台选「Web服务」。' +
      '免费额度 5000 次/月，两个人用不到千分之一。<br>' +
      '<b>Key 只存在这台手机上</b>，不写进代码（代码是公开的）。</div>'
    h += '</div>'

    /* ---- 身份 ---- */
    h += '<div class="st-card"><div class="h">我的身份</div>'
    h += '<div class="st-seg">' +
      '<div class="o' + (app.uid === 'A' ? ' on' : '') + '" id="st-uid-a">我是 A</div>' +
      '<div class="o' + (app.uid === 'B' ? ' on' : '') + '" id="st-uid-b">我是 B</div>' +
      '</div>'
    h += '<div class="st-d">心情和日记是按「<b>日期 + 人</b>」分开存的，' +
      '所以两台手机必须是<b>一个 A、一个 B</b>，否则会互相覆盖。' +
      '配对时会自动设好（先配的那台是 A，粘贴链接码的那台是 B）。</div>'
    h += '</div>'

    /* ---- 关于 ---- */
    h += '<div class="st-card"><div class="h">关于</div>'
    h += '<div class="st-d">纯网页 App，零依赖零构建。数据端到端加密（AES-256-GCM）后' +
      '存在你们自己的私有 Gist 里 —— <b>服务器只能看到密文</b>。<br>' +
      '同步是客户端每 20 秒问一次（打开对话页时 5 秒），' +
      '<b>所以 App 关着的时候收不到提醒</b>。</div>'
    h += '</div>'
    return h
  }

  function viewFirst() {
    var h = ''
    h += '<div class="st-card"><div class="h">我是第一个</div>'
    if (!pending.link) {
      /* ⚠️ 这句话必须显眼：两台都点这里 → 两边口令不同 → 互相看不到数据。
         真机上就这么踩过，而且用户只会看到"两个人口令码不一样"，不知道该改哪。 */
      h += '<div class="st-note">⚠️ <b>只有先配的那一台</b>点这里。<br>' +
        '另一台请用「<b>对方已经配好了</b>」粘贴链接码 —— ' +
        '<b>两台都点这里的话，两边口令会不一样，谁也看不到谁的数据</b>。</div>'
    }
    if (pending.link) {
      h += '<div class="st-d">链接码生成好了。把它发给对方（微信发一行字就行）。</div>'
      h += '<div class="st-fp"><div class="k">口令指纹（对方配完要一致）</div>' +
        '<div class="v">' + esc(pending.fp || '——') + '</div></div>'
      h += '<textarea class="st-link" id="st-link" readonly>' + esc(pending.link) + '</textarea>'
      h += '<div class="st-btns"><button class="st-btn primary" id="st-copy">复制链接码</button></div>'
      h += '<div class="st-note">⚠️ 链接码等于<b>邀请函</b>：拿到它的人就能解出口令。' +
        '发给对方之后别公开发。<br>' +
        '对方在设置里点「对方已经配好了」→ 粘贴 → 完成，之后两边都免输。</div>'
    } else {
      h += '<div class="st-d">需要一个 GitHub token，<b>只勾 Gists 权限</b>，别的都不要给：<br>' +
        'GitHub → 右上头像 → Settings → Developer settings → ' +
        'Personal access tokens → <b>Fine-grained tokens</b> → Generate new token → ' +
        '权限里找 <b>Gists: Read and write</b> → 生成后复制（<code>github_pat_</code> 开头）。</div>'
      h += '<input class="st-in mono" id="st-token" type="password" spellcheck="false" ' +
        'autocomplete="off" placeholder="github_pat_…" value="' + esc(pending.token || '') + '">'
      h += '<div class="st-btns"><button class="st-btn plain sm" id="st-eye">显示</button></div>'
      h += '<div class="st-btns"><button class="st-btn primary" id="st-gen">生成链接码</button></div>'
      h += '<div class="st-d">Token 和口令都只存在<b>这台手机</b>上，不上传、不写进代码。</div>'
      if (pending.err) h += '<div class="st-note err">' + esc(pending.err) + '</div>'
    }
    h += '<div class="st-btns"><button class="st-btn plain" id="st-back">返回</button></div>'
    h += '</div>'
    return h
  }

  function viewJoin() {
    var h = ''
    h += '<div class="st-card"><div class="h">粘贴链接码</div>'
    h += '<div class="st-d">把对方发来的那一行（以 <b>CPL1.</b> 开头）整段粘进来，' +
      '点完成就行 —— 不用输密码。</div>'
    h += '<textarea class="st-ta" id="st-paste" spellcheck="false" ' +
      'placeholder="CPL1.…">' + esc(pending.paste || '') + '</textarea>'
    h += '<div class="st-btns"><button class="st-btn primary" id="st-apply">完成配对</button></div>'
    if (pending.err) h += '<div class="st-note err">' + esc(pending.err) + '</div>'
    h += '<div class="st-btns"><button class="st-btn plain" id="st-back">返回</button></div>'
    h += '</div>'
    return h
  }

  /**
   * 「🔎 自动找出我的云端」：用 token 列出这个账号名下的 Gist，
   * 只留下**像是我们自己的**（里面有 .enc.json 文件的那种）。
   *
   * 为什么要做这个（2026-10-11 真机踩的坑，第 3 个假绿灯）：
   *   界面上「云端 ID」显示的只是前 8 位（gistShort 截断），我在这个页面还写了
   *   一句"前 8 位够用" —— **那句话是错的**。用户照着填了 8 位，
   *   GitHub 一律 404，于是：
   *     · 「接入」打了 ✓（因为 404 被当成"云端是空的"）
   *     · 写入闸门亮绿灯（同上）
   *     · 纪念日永远传不上去、照片永远"正在自动重试"，而且**一句错都不报**
   *   两台手机都这么填 → 两台一起坏，谁也看不到谁。
   *   （复现脚本 prototype/tools/repro-bad-gist-id.js，11 项断言逐字对上真机现象。）
   *
   * 让用户去地址栏里数 32 位十六进制太难了，所以直接问 GitHub 要清单。
   */
  function findMyClouds(token) {
    if (!/^(github_pat_|ghp_)/.test(token || '')) {
      pending.cloudMsgErr = true
      pending.cloudMsg = '先把 token 填进去（要以 github_pat_ 或 ghp_ 开头），再点这个按钮。'
      render()
      return
    }
    pending.cloudMsg = '正在问 GitHub：这个 token 名下有哪些云端…'
    pending.cloudMsgErr = false
    render()
    fetch('https://api.github.com/gists?per_page=100', {
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' }
    }).then(function (r) {
      if (r.status === 401) throw new Error('token 不对（401）：抄错了、或者已经失效了，重新生成一个')
      if (r.status === 403) throw new Error('这个 token 没有读 gists 的权限（403）：生成时只勾了别的？要勾 gist')
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }).then(function (arr) {
      var out = []
      /* 对方那一份叫什么：我是 A 时对方是 couple-b（见 app-state 的 coreFileFor） */
      var peerFile = (app && app.uid === 'B') ? 'couple-a.enc.json' : 'couple-b.enc.json'
      for (var i = 0; i < (arr || []).length; i++) {
        var g = arr[i]
        var names = Object.keys(g.files || {})
        var ours = []
        for (var j = 0; j < names.length; j++) if (/\.enc\.json$/.test(names[j])) ours.push(names[j])
        if (!ours.length) continue
        out.push({
          id: g.id,
          files: ours.join(' + '),
          when: String(g.updated_at || '').slice(0, 10),
          n: ours.length,
          /* ★ 这个云端里有**对方那份**文件（我 A 时对方是 couple-b）→
             说明对方一直在往这里写东西，就是我们要回去的那个云端。
             没有这个标记的话，用户会看到一串"长得差不多"的候选
             （每被旧版本新建过一次云端就多一个），根本没法选。 */
          hasPeer: ours.indexOf(peerFile) >= 0
        })
      }
      /* 有对方东西的排最前面，其次文件多的（我们那个云端里应该有 couple-a / couple-b / 相册） */
      out.sort(function (a, b) {
        if (a.hasPeer !== b.hasPeer) return a.hasPeer ? -1 : 1
        return (b.n - a.n)
      })
      pending.cloudList = out
      var peerOne = null
      for (var k = 0; k < out.length; k++) if (out[k].hasPeer) { peerOne = out[k]; break }
      pending.cloudMsg = out.length
        ? (peerOne
          ? '找到 ' + out.length + ' 个"像是你们的"云端。**选带 ★ 的那个**（' +
            peerOne.id.slice(0, 8) + '…）—— 它里面有对方写的东西，点它就把 ID 填好了。'
          : '找到 ' + out.length + ' 个"像是你们的"云端。**选文件最多的那个**' +
            '（里面写着 couple-a / couple-b / 相册），点它就把 ID 填好了。')
        : '这个 token 名下没有找到任何带 .enc.json 的云端。\n' +
          '· token 是不是**建那个云端的账号**的？\n' +
          '· 生成 token 时勾了 gist 吗？\n' +
          '· 都不确定的话：让对方在她手机上点 🎀 → 同步 →「重新配对」，把链接码发你，' +
          '你这台点「对方已经配好了（粘贴链接码）」，粘完再点回「我是 A / B」。'
      pending.cloudMsgErr = !out.length
      render()
    }).catch(function (e) {
      pending.cloudMsgErr = true
      pending.cloudMsg = '找不出来：' + ((e && e.message) || e)
      render()
    })
  }

  function cloudListHtml(list) {
    var h = ''
    for (var i = 0; i < list.length; i++) {
      var g = list[i]
      h += '<div class="st-btns"><button class="st-btn ' + (g.hasPeer ? 'primary sm' : 'plain sm') +
        '" data-gist="' + esc(g.id) + '">' +
        (g.hasPeer ? '★ ' : '') +
        esc(g.id.slice(0, 8)) + '… · ' + esc(g.when) + ' · ' + esc(g.files) + '</button></div>'
      if (g.hasPeer) {
        h += '<div class="st-d">↑ 这个云端里有<b>对方写的东西</b> —— 就是它，点它。</div>'
      }
    }
    return h
  }

  /**
   * 用户粘进来的可能是：整条 Gist 网址 / 完整 32 位 ID / 界面上那 8 位缩写。
   * 统一成「完整 ID」或者一句人话报错 —— **绝不接受缩写**（那就是这次坏掉的原因）。
   */
  function normalizeGistId(raw) {
    var s = String(raw == null ? '' : raw).trim()
    if (!s) return { err: '先填「云端 ID」（不知道就点「🔎 自动找出我的云端」）' }
    /* 整条网址里最后那一段就是 ID */
    var m = s.match(/([0-9a-f]{20,})\s*$/i)
    if (m) return { id: m[1].toLowerCase() }
    m = s.match(/gist\.github\.com\/[^\/\s]+\/([0-9a-f]+)/i)
    if (m) s = m[1]
    s = s.replace(/[^0-9a-f]/gi, '').toLowerCase()
    if (/^[0-9a-f]{20,}$/.test(s)) return { id: s }
    if (/^[0-9a-f]{6,19}$/.test(s)) {
      return {
        err: '「' + s + '」太短了 —— 这像是界面上显示的**缩写**（前 8 位），不是真 ID。' +
          '真 ID 是 32 位。点上面的「🔎 自动找出我的云端」最省事；' +
          '或者让已经连上的那台手机点「重新配对」，把链接码发你。'
      }
    }
    return { err: '「云端 ID」看起来不对：应该是一串 32 位的字母数字（0-9 / a-f）。' }
  }

  /**
   * 「能连上」≠「能读懂」。
   *
   * 接入时必须再验一件事：**这台手机现在这把口令，能不能解开云端那份数据**。
   * 只验"token 能不能读这个 Gist"是不够的（上一版就只验了那个 → 打假绿灯）。
   *
   * @returns {Promise<{ok:boolean, note?:string}>} ok=false 表示"文件在、内容也在，但解不开"
   */
  function verifyCloudPassphrase(token, gist, pass) {
    if (!window.E2E || !window.E2E.decrypt) return Promise.resolve({ ok: true })
    return fetch('https://api.github.com/gists/' + gist, {
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' }
    }).then(function (r) { return r.ok ? r.json() : null }).then(function (j) {
      var names = []
      var all = Object.keys((j && j.files) || {})
      for (var i = 0; i < all.length; i++) if (/\.enc\.json$/.test(all[i])) names.push(all[i])
      if (!names.length) return { ok: true, note: '这个云端还是空的（那就由你这台先建）' }

      var tested = 0
      var tryOne = function (i) {
        if (i >= names.length || i >= 5) {
          if (!tested) return { ok: true, note: '云端有文件，但这次读不出内容（同步时会再试）' }
          return { ok: false }
        }
        var f = j.files[names[i]] || {}
        var getTxt = function () {
          if (f.content && !f.truncated) return Promise.resolve(f.content)
          if (f.raw_url) {
            return fetch(f.raw_url, { headers: { 'Authorization': 'token ' + token } })
              .then(function (rr) { return rr.ok ? rr.text() : '' })
              .catch(function () { return '' })
          }
          return Promise.resolve(f.content || '')
        }
        return getTxt().then(function (txt) {
          var env = null
          try { env = JSON.parse(txt) } catch (e) { env = null }
          if (!env) return tryOne(i + 1)          /* 读不到内容 → 不作为判据 */
          tested++
          return window.E2E.decrypt(env, pass).then(function () {
            return { ok: true, note: '云端那份数据解得开 ✓' }
          }).catch(function () { return tryOne(i + 1) })
        })
      }
      return tryOne(0)
    }).catch(function () { return { ok: true } })   /* 网络抽风不拦用户 */
  }

  /**
   * ④ 接入已有的云端（token + 云端 ID）—— 这台手机自己接上那个已存在的 Gist。
   *
   * 为什么要有这个（2026-10-11 真机踩的坑）：
   *   用户手机被配成了「本机双窗口（调试）」（provider=local），于是它**永远
   *   不往 GitHub 写**：云端 ID 是空的、体检里"云端：还没有数据"、写入闸门却
   *   亮着绿灯（local 读自己的空槽位也算成功，这个绿灯是假的）。
   *   而「粘贴链接码」那条路会把设备**写死成 B**（settings-ui.js 里的 applyJoin），
   *   于是"我一直是 A"的用户没法用它修 —— 一粘就变 B，两人的记录会互相顶。
   *
   * 这里走的是「接入」而不是「配对」：
   *   · 身份沿用这台手机现在的 A / B，**一个字段都不改**
   *   · 口令沿用本机已有的（没有就新生成一个）
   *   · 先确认这个 token + 云端 ID 真的**读得开**，才写进配置（不写坏配置）
   *
   * ⚠️ 2026-10-11 补的两条教训（这一版就是为它们改的）：
   *   ① 只验"token 能读这个 Gist"**不够** —— 云端 ID 填成 8 位缩写时，
   *      GitHub 返回 404，而当时 404 被当成"云端是空的"，于是这里打了 ✓、
   *      写入闸门也亮了绿灯，其实一个字都写不上去。
   *      现在：GONE（找不到云端）直接报错不写配置，并且还要验"口令解得开云端那份数据"。
   *   ② 口令**不会**被"云端那份覆盖" —— 云端只有密文，没有口令。
   *      所以本机口令是错的就永远是错的 → 那种情况下必须拦下来（让用户走链接码），
   *      不能配出一台"绿灯但什么都同步不了"的手机。
   */
  function viewJoinCloud() {
    var cfgd = !!(app.status && app.status.configured)
    var h = ''
    h += '<div class="st-card"><div class="h">接入已有的云端</div>'
    h += '<div class="st-d">这台手机<b>改成连那个已经存在的云端</b>，' +
      '你在两台手机上就能看到同一份数据。<br>' +
      '和「粘贴链接码」的区别：<b>你的身份（A / B）不会变</b> —— ' +
      '两台手机必须一个是 A、一个是 B，变了会互相覆盖。</div>'
    h += '<div class="st-note">⚠️ 只有<b>本机已经存过 token</b> 时才不用重新填。' +
      '否则请到 GitHub 生成一个新的（只勾 <b>gists</b>）：<br>' +
      '头像 → Settings → Developer settings → Personal access tokens → ' +
      '<b>Tokens (classic)</b> → Generate new token (classic) → 只勾 <b>gist</b> → 复制。</div>'
    h += '<input class="st-in mono" id="st-join-token" type="password" spellcheck="false" ' +
      'autocomplete="off" placeholder="ghp_… / github_pat_…（github_pat_ 需要能读写文件）" ' +
      'value="' + esc(pending.cloudToken || '') + '">'
    h += '<div class="st-btns"><button class="st-btn plain sm" id="st-join-eye">显示</button></div>'
    h += '<input class="st-in mono" id="st-join-gist" type="text" spellcheck="false" ' +
      'autocomplete="off" placeholder="云端 ID：32 位（整段粘贴，或点下面的按钮自动找）" ' +
      'value="' + esc(pending.cloudGist || '') + '">'
    h += '<div class="st-btns"><button class="st-btn plain" id="st-join-find">' +
      '🔎 自动找出我的云端</button></div>'
    h += '<div class="st-d">云端 ID = Gist 网址最后那一整段，<b>32 位</b>' +
      '（例如 485c662a1b2c3d…）。<br>' +
      '⚠️ 界面上那个 8 位的 <code>485c662a</code> 只是<b>显示用的缩写</b>，' +
      '填缩写会连不上（GitHub 会说"找不到"）—— 这台手机就会变成' +
      '"绿灯但不传数据"。不知道完整的就点上面那个按钮，用 token 自动找出来。</div>'
    if (pending.cloudList) h += cloudListHtml(pending.cloudList)
    h += '<div class="st-fp"><div class="k">接入后的身份（不会变）</div>' +
      '<div class="v">' + esc(app.uid || 'A') + '</div></div>'
    h += '<div class="st-btns"><button class="st-btn primary" id="st-join-confirm">' +
      '接入这个云端</button></div>'
    if (pending.err) h += '<div class="st-note err">' + esc(pending.err) + '</div>'
    if (pending.cloudMsg) {
      h += '<div class="st-note' + (pending.cloudMsgErr ? ' err' : '') +
        '" style="white-space:pre-line">' + esc(pending.cloudMsg) + '</div>'
    }
    if (!cfgd) {
      h += '<div class="st-d">接好之后，回上一页点「🔍 同步体检」确认一下：' +
        '「云端 ID」应该和对那台一样，而且能看到对方的数据了。</div>'
    }
    h += '<div class="st-btns"><button class="st-btn plain" id="st-back">返回</button></div>'
    h += '</div>'
    return h
  }

  function render() {
    var body = q('st-body')
    if (!body) return
    if (!app) { body.innerHTML = '<div class="st-card"><div class="st-d">状态没接上</div></div>'; return }
    body.innerHTML = view === 'first' ? viewFirst()
      : (view === 'join' ? viewJoin()
      : (view === 'joincloud' ? viewJoinCloud() : viewMain()))
    bind()
    if (view === 'main' && app.status.configured) showFingerprint()
  }

  /** 指纹是异步算的（PBKDF2 一万次），单独填，别卡住渲染 */
  function showFingerprint() {
    var el = q('st-fpv')
    if (!el || !app.fingerprint) return
    var p = app.fingerprint()
    if (!p || !p.then) { el.textContent = p || '——'; return }
    p.then(function (fp) {
      var cur = q('st-fpv')
      if (cur) cur.textContent = fp || '——'
    }).catch(function () {
      var cur = q('st-fpv')
      if (cur) cur.textContent = '——'
    })
  }

  /* ============================================================
     事件绑定（每次重渲染后重新绑，因为 innerHTML 被换掉了）
     ============================================================ */

  function bind() {
    var x = q('st-close')
    if (x) x.addEventListener('click', close)

    var back = q('st-back')
    if (back) back.addEventListener('click', function () {
      view = 'main'; pending.err = ''; render()
    })

    /* ---- 主界面 ---- */
    var first = q('st-first')
    if (first) first.addEventListener('click', function () {
      view = 'first'; pending = { token: pending.token || '', err: '' }; render()
    })

    var join = q('st-join')
    if (join) join.addEventListener('click', function () {
      view = 'join'; pending = { paste: '', err: '' }; render()
    })

    /* ---- 接入已有的云端（换云端 / 配错了） ---- */
    var joinCloud = q('st-join-cloud')
    if (joinCloud) joinCloud.addEventListener('click', function () {
      view = 'joincloud'
      /* ⚠️ 就地把字段清干净，**不要整个替换 pending 对象** ——
         体检结果 / 已生成的链接码都挂在上面，整换会丢。 */
      pending.err = ''
      pending.cloudMsg = ''
      pending.cloudMsgErr = false
      pending.cloudList = null
      if (pending.cloudToken === undefined) pending.cloudToken = ''
      if (pending.cloudGist === undefined) pending.cloudGist = ''
      render()
    })

    var joinEye = q('st-join-eye')
    if (joinEye) joinEye.addEventListener('click', function () {
      var input = q('st-join-token')
      if (!input) return
      var shown = input.type === 'text'
      input.type = shown ? 'password' : 'text'
      joinEye.textContent = shown ? '显示' : '隐藏'
    })

    var joinConfirm = q('st-join-confirm')
    if (joinConfirm) joinConfirm.addEventListener('click', function () {
      var token = ((q('st-join-token') || {}).value || '').trim()
      var gist = ((q('st-join-gist') || {}).value || '').trim()
      pending.cloudToken = token
      pending.cloudGist = gist
      joinExistingCloud(token, gist)
    })

    /* 复制完整云端 ID（32 位）—— 上一版只显示 8 位，用户把 8 位填到另一台就坏了 */
    var copyGist = q('st-copy-gist')
    if (copyGist) copyGist.addEventListener('click', function () {
      var full = ''
      try { full = (app.gistIdOf && app.gistIdOf()) || '' } catch (e) { full = '' }
      if (!full) { tip('这台还没配云端'); return }
      copyText(full).then(function (ok) {
        tip(ok ? '完整云端 ID 已复制（共 ' + full.length + ' 位）' : '复制没成功，长按下面这行手动复制')
        if (!ok) { pending.err = '完整云端 ID：' + full; render() }
      })
    })

    /* 🔎 自动找出我的云端：不用用户去数那 32 位 */
    var joinFind = q('st-join-find')
    if (joinFind) joinFind.addEventListener('click', function () {
      var token = ((q('st-join-token') || {}).value || '').trim()
      pending.cloudToken = token
      findMyClouds(token)
    })

    /* 候选云端：点一个就把完整 ID 填进输入框 */
    var picks = document.querySelectorAll('[data-gist]')
    for (var pi = 0; pi < picks.length; pi++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-gist') || ''
          pending.cloudGist = id
          pending.cloudList = null
          pending.cloudMsgErr = false
          pending.cloudMsg = '已经填好完整云端 ID（' + id.slice(0, 8) + '…，共 ' + id.length +
            ' 位）。确认 token 也填好了，再点下面的「接入这个云端」。'
          render()
        })
      })(picks[pi])
    }

    var localTest = q('st-local')
    if (localTest) localTest.addEventListener('click', function () { startLocalTest() })

    var install = q('st-install')
    if (install) install.addEventListener('click', function () {
      var ev = window.__installEvent
      if (!ev) { render(); return }
      ev.prompt()                       /* 必须在用户手势里调，否则会被忽略 */
      if (ev.userChoice && ev.userChoice.then) {
        ev.userChoice.then(function (c) {
          window.__installEvent = null
          tip(c && c.outcome === 'accepted' ? '开始安装…' : '没关系，随时可以在这里再装')
          render()
        })
      } else {
        render()
      }
    })

    var syncNow = q('st-sync')
    if (syncNow) syncNow.addEventListener('click', function () {
      tip('正在同步…')
      /* 一次把两个都同步（core + 相册），然后把**具体数字**报给用户 ——
         "同步完成"这种话看不出问题在哪，数字才看得出来。 */
      var beforeW = (app.state.whispers || []).length
      var beforeA = (app.albumPhotos ? app.albumPhotos().length : 0)
      app.ready(true).then(function (r) {
        return app.pullAlbumNow().then(function (ar) {
          app._albumRepaint && app._albumRepaint()
          var afterW = (app.state.whispers || []).length
          var afterA = (app.albumPhotos ? app.albumPhotos().length : 0)
          if (r && r.ok === false) {
            tip('核心同步失败：' + (r.error || app.status.error || '未知原因'))
          } else if (ar && ar.ok === false && ar.reason !== 'NOT_CONFIGURED') {
            tip('悄悄话/日记已同步；相册没拉下来：' + (ar.error || ar.reason || '未知原因'))
          } else {
            tip('同步完成：悄悄话 ' + afterW + ' 条（' + (afterW - beforeW >= 0 ? '+' : '') + (afterW - beforeW) +
              '）、相册 ' + afterA + ' 张（' + (afterA - beforeA >= 0 ? '+' : '') + (afterA - beforeA) + '）')
          }
          render()
        })
      }).catch(function (e) {
        tip('同步出错：' + (e && e.message ? e.message : e))
        render()
      })
    })

    /* ★ 强制上传：把"这台手机到底为什么传不上去"原样问出来。
       给"对方什么都收不到"用 —— 让对方在自己手机上点一下，截图给我就行。 */
    var forceBtn = q('st-force')
    if (forceBtn) forceBtn.addEventListener('click', function () {
      pending.checkText = '正在强制上传…（最多十几秒）'
      pending.checkErr = false
      render()
      app.forcePush().then(function (txt) {
        pending.checkText = txt
        pending.checkErr = /✗/.test(String(txt))
        render()
        if (typeof hooks.onChanged === 'function') hooks.onChanged()
      }).catch(function (e) {
        pending.checkText = '强制上传出错：' + (e && e.message ? e.message : e)
        pending.checkErr = true
        render()
      })
    })

    var checkBtn = q('st-check')
    if (checkBtn) checkBtn.addEventListener('click', function () {
      pending.checking = true
      pending.checkText = '正在检查云端…（最多十几秒）'
      pending.checkErr = false
      render()
      app.diagnose().then(function (txt) {
        pending.checking = false
        pending.checkText = txt
        pending.checkErr = /⚠️|出错|看不到|没有对方/.test(String(txt))
        render()
      }).catch(function (e) {
        pending.checking = false
        pending.checkText = '检查失败：' + (e && e.message ? e.message : e)
        pending.checkErr = true
        render()
      })
    })

    var repair = q('st-repair')
    if (repair) repair.addEventListener('click', function () { repairLink() })

    var clear = q('st-clear')
    if (clear) clear.addEventListener('click', function () {
      if (!pending.confirmClear) {
        pending.confirmClear = true
        render()
        return
      }
      pending.confirmClear = false
      app.clearConfig()
      if (hooks.onChanged) hooks.onChanged()
      tip('已清除本机配对')
      render()
    })

    var amapSave = q('st-amap-save')
    if (amapSave) amapSave.addEventListener('click', function () {
      var v = (q('st-amap') || {}).value || ''
      if (window.Weather) window.Weather.setAmapKey(v)
      if (hooks.onWeatherSaved) hooks.onWeatherSaved()
      tip(v ? '已保存，天气马上更新' : '已清空，天气回到示例数据')
      render()
    })

    var uidA = q('st-uid-a')
    if (uidA) uidA.addEventListener('click', function () { setUid('A') })
    var uidB = q('st-uid-b')
    if (uidB) uidB.addEventListener('click', function () { setUid('B') })

    /* ---- 我是第一个 ---- */
    var eye = q('st-eye')
    if (eye) eye.addEventListener('click', function () {
      var input = q('st-token')
      if (!input) return
      var shown = input.type === 'text'
      input.type = shown ? 'password' : 'text'
      eye.textContent = shown ? '显示' : '隐藏'
    })

    var gen = q('st-gen')
    if (gen) gen.addEventListener('click', function () {
      var token = ((q('st-token') || {}).value || '').trim()
      pending.token = token
      startFirst({ provider: 'github', token: token })
    })

    var copy = q('st-copy')
    if (copy) copy.addEventListener('click', function () {
      copyText(pending.link).then(function (ok) {
        tip(ok ? '链接码已复制，发给对方吧' : '复制没成功，长按上面那段手动复制')
      })
    })

    /* ---- 粘贴链接码 ---- */
    var apply = q('st-apply')
    if (apply) apply.addEventListener('click', function () {
      var raw = ((q('st-paste') || {}).value || '').trim()
      pending.paste = raw
      applyJoin(raw)
    })
  }

  /* ============================================================
     动作
     ============================================================ */

  function setUid(uid) {
    app.setUid(uid)
    if (hooks.onChanged) hooks.onChanged()
    tip('这台手机现在是「' + uid + '」')
    render()
  }

  /** ① 我是第一个：生成口令 → 建 Gist → 出链接码 */
  function startFirst(cfg) {
    if (cfg.provider === 'github' && !/^(github_pat_|ghp_)/.test(cfg.token || '')) {
      pending.err = 'Token 看起来不对（应该以 github_pat_ 或 ghp_ 开头）'
      render()
      return
    }
    if (!window.CoupleLink || !window.E2E) {
      pending.err = '加密模块没加载上（刷新一下页面）'
      render()
      return
    }
    pending.err = ''
    var passphrase = window.CoupleLink.randomToken(24)   /* 24 字节随机口令，用户不用记 */
    var salt = window.E2E.newSalt()

    tip('正在创建…')
    app.configure({
      provider: cfg.provider,
      passphrase: passphrase,
      salt: salt,
      token: cfg.token || '',
      myUid: 'A'                                        /* 先配的这台是 A */
    }).then(function (r) {
      if (!r || r.ok === false) {
        pending.err = (r && r.error) || app.status.error || '创建失败（检查 token 权限是不是只有 Gists）'
        render()
        return null
      }
      var gistId = (app.sync && app.sync.gistId) || ''
      return window.CoupleLink.createLink({
        passphrase: passphrase, salt: salt,
        provider: cfg.provider, gistId: gistId, token: cfg.token || ''
      }).then(function (res) {
        pending.link = res.link
        pending.passphrase = passphrase
        return window.E2E.fingerprint(passphrase)
      }).then(function (fp) {
        pending.fp = fp
        if (hooks.onChanged) hooks.onChanged()
        tip('配对完成，把链接码发给对方')
        render()
      })
    }).catch(function (e) {
      pending.err = String((e && e.message) || e)
      render()
    })
  }

  /** ③ 本机双窗口调试：不连 GitHub，用来在一台电脑上验证同步 */
  function startLocalTest() {
    if (!window.CoupleLink || !window.E2E) { tip('加密模块没加载上'); return }
    var passphrase = window.CoupleLink.randomToken(24)
    var salt = window.E2E.newSalt()
    tip('正在本机配对…')
    app.configure({
      provider: 'local',
      passphrase: passphrase, salt: salt,
      slotKey: 'couple_sync_slot',
      myUid: 'A'
    }).then(function (r) {
      if (!r || r.ok === false) { tip('本机配对失败：' + ((r && r.error) || '')); return }
      return window.CoupleLink.createLink({
        passphrase: passphrase, salt: salt, provider: 'local', token: ''
      }).then(function (res) {
        view = 'first'
        pending = { link: res.link, passphrase: passphrase }
        return window.E2E.fingerprint(passphrase)
      }).then(function (fp) {
        pending.fp = fp
        if (hooks.onChanged) hooks.onChanged()
        tip('本机配对好了：这个链接码粘到另一个窗口就是「对方」')
        render()
      })
    }).catch(function (e) { tip('本机配对失败：' + ((e && e.message) || e)) })
  }

  /** 已配对时「重新配对」：拿现有配置重新生成一个链接码（给第二台手机用） */
  function repairLink() {
    var cfg = app.cfg || {}
    if (!window.CoupleLink) { tip('配对模块没加载上'); return }
    if (cfg.provider === 'github' && !cfg.token) {
      tip('本机没存 token，请用「我是第一个」重新配')
      return
    }
    window.CoupleLink.createLink({
      passphrase: cfg.passphrase, salt: cfg.salt,
      provider: cfg.provider, gistId: cfg.gistId || '', token: cfg.token || ''
    }).then(function (res) {
      view = 'first'
      pending = { link: res.link, passphrase: cfg.passphrase }
      return window.E2E.fingerprint(cfg.passphrase)
    }).then(function (fp) {
      pending.fp = fp
      render()
    }).catch(function (e) { tip('生成失败：' + ((e && e.message) || e)) })
  }

  /** ② 对方已经配好了：粘贴链接码 → 完成 */
  function applyJoin(raw) {
    if (!window.CoupleLink) { pending.err = '配对模块没加载上'; render(); return }
    if (!raw) { pending.err = '先把链接码粘进来'; render(); return }
    if (!window.CoupleLink.looksLikeLink(raw)) {
      pending.err = '这段看起来不是链接码（应该以 CPL1. 开头）'
      render()
      return
    }
    pending.err = ''
    tip('正在配对…')
    window.CoupleLink.parseLink(raw).then(function (payload) {
      return app.configure({
        provider: payload.provider || 'github',
        passphrase: payload.passphrase,
        salt: payload.salt,
        token: payload.token || '',
        gistId: payload.gistId || '',
        myUid: 'B'                                      /* 粘贴链接码的这台是 B */
      }).then(function (r) {
        if (!r || r.ok === false) {
          /* 配置已存下，但拉取/解密失败 —— 多半是口令对不上 */
          pending.err = '配对信息存下了，但拉取失败：' +
            ((r && r.error) || app.status.error || '口令可能不一致')
          render()
          return
        }
        if (payload.gistId) app.sync.gistId = payload.gistId
        if (hooks.onChanged) hooks.onChanged()
        view = 'main'
        pending = {}
        tip('配对完成！')
        render()
        return window.E2E.fingerprint(payload.passphrase).then(function (fp) {
          tip('配对完成，口令指纹 ' + fp)
        })
      })
    }).catch(function (e) {
      pending.err = (e && e.message) || '链接码解析失败'
      render()
    })
  }

  /**
   * ④ 接入已有的云端：**先验证再写入**。
   *
   * 为什么不直接 app.configure()：
   *   configure 会立刻把这个 token / gistId **存进本机配置**。如果拼错了
   *   （最典型：Fine-grained token 只有 read 权限、或者云端 ID 打错一位），
   *   配置就被改坏了 —— 用户看到的是一台"配好了但什么都同步不了"的手机，
   *   比现在更难查。所以先用一个**临时 provider 空读一次**，读通了才写。
   */
  function joinExistingCloud(token, gist) {
    pending.err = ''
    pending.cloudMsg = ''
    pending.cloudMsgErr = false
    pending.cloudList = null
    token = String(token == null ? '' : token).trim()
    if (!/^(github_pat_|ghp_)/.test(token)) {
      pending.err = 'Token 看起来不对（应该以 github_pat_ 或 ghp_ 开头）。' +
        '注意别把它两头的空格也复制进来。'
      render()
      return
    }
    /* ★ 云端 ID 必须是完整的那一串：整条网址也行，8 位缩写一律拦下（那是这次坏掉的原因） */
    var norm = normalizeGistId(gist)
    if (norm.err) {
      pending.err = norm.err
      render()
      return
    }
    gist = norm.id
    var CS = window.CoupleSync
    if (!CS || !CS.GithubProvider) {
      pending.err = '同步模块没加载上（刷新一下页面再试）'
      render()
      return
    }

    var me = app.uid || 'A'
    /* 口令：本机没配过就临时生成一个。
       ⚠️ 云端**不会**告诉我们口令（那边只有密文），所以本机这把如果不对，
          就只能靠"对方的链接码"来换 —— 下面会验，验不过就拦住，不写配置。 */
    var pass = (app.cfg && app.cfg.passphrase) ||
      ((window.CoupleLink && window.CoupleLink.randomToken)
        ? window.CoupleLink.randomToken(24) : '')
    var salt = (app.cfg && app.cfg.salt) ||
      ((window.E2E && window.E2E.newSalt) ? window.E2E.newSalt() : '')
    if (!pass || !salt) {
      pending.err = '加密模块没加载上（刷新一下页面再试）'
      render()
      return
    }

    pending.cloudMsg = '正在连云端…'
    render()

    /* 第一步：这个 token 能不能读到这个 Gist（空读一个探针文件） */
    var probe = new CS.GithubProvider({
      token: token, gistId: gist, filename: 'couple-join-probe.json'
    })
    Promise.resolve()
      .then(function () { return probe.get() })
      .catch(function (e) { return { error: (e && e.message) || String(e) } })
      .then(function (r) {
        /* ★ 404 必须当错误：以前它被当成"云端是空的"，于是这儿打了 ✓、
           闸门亮绿灯，其实一个字都写不上去。 */
        if (r && r.gone) {
          pending.cloudMsgErr = true
          pending.cloudMsg = '接不上，**配置没有被改动**。\n' +
            '原因：GitHub 说找不到这个云端 → 云端 ID 不对。\n' +
            '· 只填了 8 位的缩写？真 ID 是 32 位，点上面的「🔎 自动找出我的云端」最快\n' +
            '· 或者这个 token 不是建那个云端的账号的'
          render()
          return null
        }
        if (r && r.error) {
          pending.cloudMsgErr = true
          pending.cloudMsg = '连不上这个云端，**配置没有被改动**。\n' +
            '原因：' + r.error + '\n' +
            '· 401 / Bad credentials → token 抄错了或已失效，重新生成一个\n' +
            '· 404 / Not Found → 云端 ID 打错了，或这个 token 看不到那个云端'
          render()
          return null
        }
        /* 第二步：口令能不能**解开**云端那份数据（只验"能读"是不够的） */
        return verifyCloudPassphrase(token, gist, pass).then(function (v) {
          if (v && v.ok === false) {
            pending.cloudMsgErr = true
            pending.cloudMsg = '云端能连上，但**这台手机的口令解不开里面的数据**，配置没有被改动。\n' +
              '（云端那些文件是另一把口令加密的，云端自己也不知道口令）\n' +
              '修法：让对方在她的手机上点 🎀 → 同步 →「重新配对」，把那段链接码发你；' +
              '你在这台点「对方已经配好了（粘贴链接码）」，粘完再点回你的「我是 A / B」。'
            render()
            return null
          }
          tip('正在接入云端…')
          return app.configure({
            provider: 'github',
            passphrase: pass,
            salt: salt,
            token: token,
            gistId: gist,
            myUid: me            /* ★ 身份保持这台手机现在的 A / B，绝不改成 B */
          }).then(function (res) {
            if (!res || res.ok === false) {
              pending.cloudMsgErr = true
              pending.cloudMsg = '云端能连上，但拉取/解密失败：' +
                ((res && res.error) || app.status.error || '未知原因')
            } else {
              pending.cloudMsgErr = false
              pending.cloudMsg = '✓ 接上了（完整云端 ID ' + gist.slice(0, 8) + '…，共 ' + gist.length +
                ' 位），身份保持 ' + me + '。\n' +
                ((v && v.note) ? v.note + '\n' : '') +
                '接着点「🔍 同步体检」确认能看到对方的数据。'
            }
            if (hooks.onChanged) hooks.onChanged()
            render()
          })
        })
      })
      .catch(function (e) {
        pending.cloudMsgErr = true
        pending.cloudMsg = '接入出错：' + ((e && e.message) || String(e))
        render()
      })
  }

  /* ============================================================
     开关与挂载
     ============================================================ */

  function open(v) {
    view = v || 'main'
    pending = pending || {}
    if (view === 'main') { pending.err = ''; pending.confirmClear = false }
    render()
    if (overlay) overlay.classList.add('on')
    if (app && app.startPolling) app.startPolling()
  }

  function close() {
    if (overlay) overlay.classList.remove('on')
    pending.confirmClear = false
  }

  function mount(container, options) {
    options = options || {}
    app = options.app
    hooks = options

    overlay = document.createElement('div')
    overlay.className = 'st-overlay'
    overlay.id = 'st-overlay'
    overlay.innerHTML = '<div class="st-sheet">' +
      '<div class="st-head"><span class="t">设置</span>' +
      '<span class="x" id="st-close">✕</span></div>' +
      '<div id="st-body"></div></div>'
    /* ⚠️ 挂 body 上：放 .content 里会被 .tabbar 压住（层叠上下文） */
    document.body.appendChild(overlay)

    /* 点遮罩空白处关闭（点面板内部不关） */
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) close()
    })

    if (app && app.subscribe) {
      unsub = app.subscribe(function () {
        if (overlay && overlay.classList.contains('on')) render()
      })
    }

    /* 浏览器刚给出「可安装」事件时，如果面板正开着，立刻换成一键安装按钮 */
    document.addEventListener('couple-installable', function () {
      if (overlay && overlay.classList.contains('on')) render()
    })
  }

  root.SettingsUI = {
    mount: mount,
    open: open,
    close: close,
    isOpen: function () { return !!(overlay && overlay.classList.contains('on')) }
  }
})(typeof self !== 'undefined' ? self : this)
