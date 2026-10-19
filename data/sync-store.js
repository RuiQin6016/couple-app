/**
 * 同步层：把「端到端加密」和「存储后端」接起来
 * ============================================================
 * 分层（这样换后端不用动加密，换加密不用动后端）：
 *
 *   业务数据（纪念日/小猪/例假…）
 *        │  明文
 *        ▼
 *   Sync.encrypt + 上传                ← 本文件
 *        │  密文信封 { v, salt, iv, data }
 *        ▼
 *   provider（存储后端）                ← 本文件下面几个 provider
 *        · 'local'  本机 localStorage + storage 事件（**用来在浏览器里真实模拟两台手机**）
 *        · 'github' 私有 Gist（上线用；服务器只看到密文）
 *
 * ⚠️ 核心保证：**provider 只接触密文**。明文从不离开这台设备。
 *    所以即使后端是 GitHub，管理员也看不到内容。
 *
 * ⚠️ 冲突处理：两个设备可能同时写。provider 的 put() 收 `etag`（上次读到的版本标记），
 *    带 etag 写入时如果服务器上已经变了，返回 { conflict:true } —— 调用方要重读再写，
 *    不能盲目覆盖（否则会把对方刚改的数据盖掉）。
 */

;(function (root) {
  'use strict'

  var E2E = (typeof require !== 'undefined')
    ? require('./e2e-crypto.js')
    : root.E2E

  /* ============================================================
     存储适配：本机存储（浏览器 localStorage / Node 内存兜底）
     ============================================================ */

  var memStore = {}

  function lsGet(k) {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.getItem(k)
    } catch (e) { /* 隐私模式可能不让用 */ }
    return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null
  }

  function lsSet(k, v) {
    try {
      if (typeof localStorage !== 'undefined') { localStorage.setItem(k, v); return true }
    } catch (e) { /* 落到内存 */ }
    memStore[k] = v
    return true
  }

  function lsDel(k) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(k)
    } catch (e) { /* ignore */ }
    delete memStore[k]
  }

  /* ============================================================
     provider：'local' —— 用本机存储模拟「服务器」
     用途：在浏览器里开两个窗口（两个独立 storage 命名空间）验证真实同步流程。
     ⚠️ 它模拟的是「一个共享的服务器槽位」，所以测试时两个客户端要指向**同一个 key**。
     ============================================================ */

  function LocalProvider(opts) {
    this.key = (opts && opts.key) || 'couple_sync_slot'
    this._listeners = []
  }

  LocalProvider.prototype.name = 'local'

  LocalProvider.prototype.get = function () {
    var raw = lsGet(this.key)
    if (!raw) return Promise.resolve({ envelope: null, etag: null })
    var parsed = null
    try { parsed = JSON.parse(raw) } catch (e) { parsed = null }
    // 存的是 { etag, envelope } —— etag 用来做冲突检测
    return Promise.resolve({
      envelope: parsed ? parsed.envelope : null,
      etag: parsed ? parsed.etag : null
    })
  }

  LocalProvider.prototype.put = function (envelope, etag) {
    var cur = lsGet(this.key)
    var curEtag = null
    try { curEtag = cur ? JSON.parse(cur).etag : null } catch (e) { curEtag = null }

    // 冲突检测：调用方带了 etag，但服务器上已经不是那个版本了
    if (etag && curEtag && etag !== curEtag) {
      return Promise.resolve({ ok: false, conflict: true, etag: curEtag })
    }

    // etag 用「密文 + 时间戳」算，保证每次写都不同（因为 IV 每次都不同）
    var newEtag = 'e' + Date.now().toString(36) + '_' +
      String((envelope && envelope.data ? envelope.data.length : 0))
    lsSet(this.key, JSON.stringify({ etag: newEtag, envelope: envelope }))

    // 通知「别的窗口」——真实浏览器里 storage 事件会自己触发，这里给测试用
    var that = this
    setTimeout(function () {
      that._listeners.forEach(function (fn) {
        try { fn() } catch (e) { /* 单个回调出错不影响别的 */ }
      })
    }, 0)

    return Promise.resolve({ ok: true, etag: newEtag })
  }

  LocalProvider.prototype.watch = function (onChange) {
    var that = this
    this._listeners.push(onChange)

    var handler = null
    if (typeof window !== 'undefined' && window.addEventListener) {
      handler = function (ev) {
        // storage 事件只在**别的窗口**改同一个 key 时触发（这正是我们要的）
        if (ev && ev.key === that.key) onChange()
      }
      window.addEventListener('storage', handler)
    }

    return function off() {
      var i = that._listeners.indexOf(onChange)
      if (i >= 0) that._listeners.splice(i, 1)
      if (handler && typeof window !== 'undefined') window.removeEventListener('storage', handler)
    }
  }

  /* ============================================================
     provider：'github' —— 私有 Gist
     只存密文；服务器（GitHub）看不到内容。
     ============================================================ */

  /** 把一段文本解析成密文信封；解不开返回 null（调用方靠它区分"空"和"坏"） */
  function parseEnvelope(txt) {
    if (!txt) return null
    try { return JSON.parse(txt) } catch (e) { return null }
  }

  function GithubProvider(opts) {
    opts = opts || {}
    this.token = opts.token || ''
    this.gistId = opts.gistId || ''     // 空 = 还没建，第一次 put 时创建
    this.filename = opts.filename || 'couple-sync.enc.json'
    this.api = 'https://api.github.com'
  }

  GithubProvider.prototype.name = 'github'

  GithubProvider.prototype._headers = function () {
    return {
      'Authorization': 'token ' + this.token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    }
  }

  /** 用 fetch；小程序/老环境没有 fetch 就报明确错误 */
  GithubProvider.prototype._fetch = function (url, init) {
    if (typeof fetch === 'undefined') {
      return Promise.reject(new Error('这个环境没有 fetch，无法访问 GitHub'))
    }
    return fetch(url, init)
  }

  /**
   * 读远端。
   * ⚠️ 返回的 `etag` 用的是 **`updated_at` 时间戳**，不是 HTTP ETag。
   *    原因（实测）：Gist 的 HTTP ETag 带 `W/` 弱校验前缀，
   *    而且**每次 GET 都可能不同**，拿它判断「有没有变」会误判。
   *    `updated_at` 在每次写入后才会变（秒级精度），更适合当版本标记。
   *    注意它是**秒级**的：同一秒内的两次写入会拿到相同值 —— 这个精度
   *    对「两个人聊天式使用」够用，但不适合高频写（我们也不那样用）。
   */
  GithubProvider.prototype.get = function () {
    var that = this
    /* ★ 这台设备**根本没有云端 ID**（本机配置里是空的）。
       绝不能和"云端是空的"混为一谈：调用方要是把那当成"可以写"，
       就会 POST 出一个新 Gist —— 用户每重开一次页面就多一个云端，
       而对方还在老云端里等（真机症状：接上了、体检绿、但什么都看不到）。
       这是 `noGist` 而不是 `gone`：前者是"我们不知道自己家在哪"，后者是"那个门牌不存在"。 */
    if (!this.gistId) return Promise.resolve({ envelope: null, etag: null, noGist: true })

    return this._fetch(this.api + '/gists/' + this.gistId, { headers: this._headers() })
      .then(function (r) {
        if (r.status === 404) return { envelope: null, etag: null, gone: true }
        if (!r.ok) {
          return r.text().then(function (t) {
            throw new Error('读 Gist 失败：HTTP ' + r.status + ' ' + String(t).slice(0, 200))
          })
        }
        return r.json().then(function (j) {
          // 用 updated_at 当版本标记
          var ver = j.updated_at || null
          var f = j.files && j.files[that.filename]
          /* 文件真的不在 → "云端还没有数据"（第一次用，可以写） */
          if (!f) return { envelope: null, etag: ver, gistId: j.id }

          /* ★ 大文件：GitHub 的 Gist API **不返回超过 1MB 的文件内容**
             （`truncated: true`，`content` 是空的）。
             以前这里把它和"文件不存在"混在一起，后果很严重：
               相册（好几 MB 的照片）永远读不回来，而且调用方会把"读不到"
               当成"云端是空的、可以写" → 拿本机这份把对方的照片盖掉。
             现在：truncated / 没给 content → 用 `raw_url` 把全文取回来。 */
          if ((f.truncated || !f.content) && f.raw_url) {
            return that._fetch(f.raw_url, { headers: that._headers() })
              .then(function (rr) { return rr.ok ? rr.text() : '' })
              .catch(function () { return '' })
              .then(function (txt) {
                var env2 = parseEnvelope(txt)
                /* 取回来了 → 正常；取不回来 → 明确告诉调用方"文件在，但读不开" */
                return { envelope: env2, etag: ver, gistId: j.id, unreadable: !env2 }
              })
          }

          var env = parseEnvelope(f.content)
          /* ★ 文件在、内容解不开 → 也要标 unreadable：
             不能让它看起来像"云端还没有数据"（那会打开写入闸门）。 */
          return { envelope: env, etag: ver, gistId: j.id, unreadable: !env }
        })
      })
  }

  GithubProvider.prototype.put = function (envelope, etag) {
    var that = this
    var body = {
      files: {}
    }
    body.files[this.filename] = { content: JSON.stringify(envelope) }

    // 还没有 Gist → 创建（私有）
    if (!this.gistId) {
      body.description = 'couple-app sync (encrypted)'
      body.public = false
      return this._fetch(this.api + '/gists', {
        method: 'POST', headers: this._headers(), body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) throw new Error('创建 Gist 失败：HTTP ' + r.status)
        return r.json().then(function (j) {
          that.gistId = j.id
          return { ok: true, etag: null, gistId: j.id, created: true }
        })
      })
    }

    // 更新。
    //
    // ⚠️⚠️ 这里**绝对不能带 `If-Match`**（实测踩过，2026-10-10）：
    //     GitHub 的 Gist PATCH 拒绝一切条件请求头，返回 400：
    //       "Conditional request headers are not allowed in unsafe requests
    //        unless supported by the endpoint"
    //     两个 API 版本（2022-11-28 / 2026-03-10）都一样。
    //     我第一版按常规 REST 思路加了 `If-Match: <etag>` 做乐观锁，
    //     结果**创建 Gist 成功、每次更新都 400** —— 只有真跑才会暴露。
    //
    // ✅ 正确做法：GitHub **自己**会保护并发 —— 两个人同时写同一个 Gist 时，
    //    后到的那个会拿到 **409 Conflict**。实测：
    //      · 并发写不同文件 → 200 / 409 / 409（只有一个成功）
    //      · 并发写同一个文件 → 409 / 200（先到的被拒）
    //    所以把 409 当作冲突信号就够了，不需要自己搞锁。
    return this._fetch(this.api + '/gists/' + this.gistId, {
      method: 'PATCH', headers: this._headers(), body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 409) return { ok: false, conflict: true }   // GitHub 原生并发保护
      if (r.status === 404) return { ok: false, gone: true }
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error('写 Gist 失败：HTTP ' + r.status + ' ' + String(t).slice(0, 200))
        })
      }
      // PATCH 成功时**不带新 etag 头**（实测为 null），
      // 所以 etag 只能靠「写完之后再 GET 一次」拿 —— 由调用方的 pushWithMerge 负责。
      return r.json().then(function (j) {
        return { ok: true, etag: null, updatedAt: j && j.updated_at }
      })
    })
  }

  /**
   * GitHub 没有推送能力，只能轮询。
   * 间隔别太小 —— 免费 API 有速率限制（未认证 60 次/小时，认证后 5000 次/小时）。
   * 这里默认 20 秒，一天约 4300 次，在 5000 以内但接近上限，所以：
   * **页面隐藏时不要轮询**（调用方负责）。
   */
  GithubProvider.prototype.watch = function (onChange, intervalMs) {
    var ms = intervalMs || 20000
    var timer = setInterval(function () {
      try { onChange() } catch (e) { /* ignore */ }
    }, ms)
    return function off() { clearInterval(timer) }
  }

  /* ============================================================
     高层 API：Sync
     ============================================================ */

  /**
   * @param {object} cfg
   *   provider   'local' | 'github'
   *   passphrase 端到端加密口令（**不写进代码**）
   *   salt       双方共用的盐（第一次由一方生成，另一人手抄/扫码带过去）
   *   providerOptions 传给具体 provider 的参数
   */
  function Sync(cfg) {
    cfg = cfg || {}
    this.passphrase = cfg.passphrase || ''
    this.salt = cfg.salt || ''
    this.etag = null
    this.lastPlain = null
    this.gistId = ''

    if (cfg.provider === 'github') {
      this.provider = new GithubProvider(cfg.providerOptions)
    } else {
      this.provider = new LocalProvider(cfg.providerOptions)
    }
  }

  Sync.prototype.providerName = function () { return this.provider.name }

  Sync.prototype.setPassphrase = function (p) { this.passphrase = p }
  Sync.prototype.setSalt = function (s) { this.salt = s }

  /** 口令指纹，用来让两个人确认输的是同一个口令 */
  Sync.prototype.fingerprint = function () {
    return E2E.fingerprint(this.passphrase)
  }

  /**
   * 读远端并解密。
   * @returns {Promise<{found:boolean, data?:object, reason?:string}>}
   *   found=false 表示远端还没有数据（第一次用），不是错误
   */
  Sync.prototype.pull = function () {
    var that = this
    if (!this.passphrase || !this.salt) {
      return Promise.resolve({ found: false, reason: 'NO_SECRET' })
    }

    return this.provider.get().then(function (r) {
      that.etag = r.etag || null
      if (r.gistId) that.gistId = r.gistId
      /* ★★ 「云端根本不存在」和「云端是空的」必须分开（2026-10-11 真机的第 3 个假绿灯）：
       *
       *   404（GONE）    = 云端 ID 配错了（最常见：只填了界面上那 8 位缩写）
       *                    → 调用方**绝不能**当成"可以写"，也不能静默
       *   UNREADABLE     = 文件在，但内容读不出来（超大 / 坏了）
       *                    → 同样不许写（会覆盖对方数据）
       *   EMPTY          = 远端真的还没有这个文件 → 第一次用，可以安全写
       *   NO_GIST        = 本机压根没记住云端 ID（旧版本的毛病）→ 也不许写！
       *                    写下去会 POST 出一个新云端，对方还在老云端里等
       *                    （真机症状：接上了、体检绿、但纪念日/相册永远看不到）
       *
       *   前三者以前都变成 `found:false, reason:'EMPTY'`，于是配错 ID 的手机
       *   亮假绿灯、写全 404、而且一句话都不报。
       */
      if (r.noGist) return { found: false, reason: 'NO_GIST' }
      if (r.gone) return { found: false, reason: 'GONE' }
      if (r.unreadable) return { found: false, reason: 'UNREADABLE' }
      if (!r.envelope) return { found: false, reason: 'EMPTY' }

      return E2E.decrypt(r.envelope, that.passphrase).then(function (data) {
        that.lastPlain = data
        return { found: true, data: data }
      })
    })
  }

  /**
   * 加密并写远端。
   * @returns {Promise<{ok:boolean, conflict?:boolean, created?:boolean}>}
   *   conflict=true 表示对方刚写过 —— 调用方应重读、合并、再写（不要盲目覆盖）
   */
  Sync.prototype.push = function (data) {
    var that = this
    if (!this.passphrase || !this.salt) {
      return Promise.reject(new Error('还没设置口令和盐，无法加密上传'))
    }

    return E2E.encrypt(data, this.passphrase, E2E.b64ToBytes(this.salt)).then(function (env) {
      return that.provider.put(env, that.etag)
    }).then(function (r) {
      if (r && r.ok) {
        if (r.gistId) that.gistId = r.gistId
        if (r.etag) that.etag = r.etag
        that.lastPlain = data

        // ⚠️ GitHub 的 PATCH 响应**不返回可用的版本标记**（etag 头是 null），
        //    所以写完之后要再读一次，把最新的 updated_at 拿回来当版本标记，
        //    否则下一次写入会拿着过期标记 → 被误判成冲突 → 死循环重试。
        //    只有 github provider 需要这一步（local provider 会直接返回新 etag）。
        if (!r.etag && that.provider.name === 'github') {
          return that.provider.get().then(function (g) {
            if (g && g.etag) that.etag = g.etag
            return r
          })
        }
      }
      return r
    })
  }

  /**
   * 冲突感知的写。**这是推荐的写入入口**（不要直接用 push）。
   *
   * ⚠️ 为什么不能只靠 GitHub 的 409：
   *    实测发现 409 是**偶发**的 —— 同一段并发代码，一次返回 `ok / conflict`，
   *    另一次返回 `ok / ok`（两个都成功，后写的静默覆盖了先写的，**丢数据**）。
   *    所以必须有**自己的**冲突检测，不能把数据安全寄托在服务端的偶发保护上。
   *
   * 做法（写前检查 + 冲突后合并重试）：
   *   1. 先 GET 一次，拿远端的 updated_at
   *   2. 和我上次读到的版本比 —— 不一样说明**这段时间对方写过**
   *      → 先 pull + merge，再写
   *   3. 写完后刷新版本标记
   *   4. 万一还是撞上 409 → 再走一次 2~3（有限次重试）
   */
  Sync.prototype.pushWithMerge = function (data, merge) {
    var that = this
    var tryWrite = function (payload, attempt) {
      return that.push(payload).then(function (r) {
        if (r && r.ok) return r
        if (!r || !r.conflict) return r
        if (attempt >= 3) return r              // 重试上限，避免死循环
        // 被 GitHub 拦下：重读 + 合并 + 再写
        return that.pull().then(function (pulled) {
          var m = merge ? merge(payload, pulled.found ? pulled.data : null) : payload
          return tryWrite(m, attempt + 1)
        })
      })
    }

    // ① 写前检查：远端有没有在我上次读之后被改过
    return this.provider.get().then(function (g) {
      var remoteVer = g && g.etag
      var stale = !!(that.etag && remoteVer && remoteVer !== that.etag)

      if (!stale) return tryWrite(data, 0)

      // 对方写过 → 先回读解密、合并，再写
      return that.pull().then(function (pulled) {
        var merged = merge ? merge(data, pulled.found ? pulled.data : null) : data
        return that.push(merged).then(function (r) {
          if (r && r.ok) r.merged = true
          // 写完仍冲突 → 交给 tryWrite 的重试逻辑
          if (r && r.conflict) return tryWrite(merged, 1)
          return r
        })
      })
    })
  }

  Sync.prototype.watch = function (onChange, intervalMs) {
    return this.provider.watch(onChange, intervalMs)
  }

  /* ============================================================
     配置持久化：口令 / 盐 / token / Gist 只配一次，之后免输
     ============================================================ */

  var CFG_PREFIX = 'couple_sync_cfg_'

  /**
   * 保存同步配置到本机。
   * ⚠️ 口令和 token 都存在**本机**，不上传、不写进代码。
   *    这是「打开就能用、不用每次输密码」的实现方式。
   * ⚠️ 存的是明文（本机存储）。这对「两个人自用」是可接受的；
   *    若要更强，可以用设备 keystore，但那是 APK 阶段的事。
   */
  function saveConfig(profile, cfg) {
    var key = CFG_PREFIX + (profile || 'default')
    var data = {
      passphrase: cfg.passphrase || '',
      salt: cfg.salt || '',
      provider: cfg.provider || 'local',
      gistId: cfg.gistId || '',
      token: cfg.token || '',
      savedAt: Date.now()
    }
    lsSet(key, JSON.stringify(data))
    return data
  }

  function loadConfig(profile) {
    var raw = lsGet(CFG_PREFIX + (profile || 'default'))
    if (!raw) return null
    try { return JSON.parse(raw) } catch (e) { return null }
  }

  function clearConfig(profile) {
    lsDel(CFG_PREFIX + (profile || 'default'))
  }

  /** 配置齐了没（齐了就能自动连，不用问用户） */
  function isConfigured(cfg) {
    if (!cfg || !cfg.passphrase || !cfg.salt) return false
    if (cfg.provider === 'github' && !cfg.token) return false
    return true
  }

  var api = {
    Sync: Sync,
    LocalProvider: LocalProvider,
    GithubProvider: GithubProvider,
    E2E: E2E,
    saveConfig: saveConfig,
    loadConfig: loadConfig,
    clearConfig: clearConfig,
    isConfigured: isConfigured
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.CoupleSync = api
})(typeof self !== 'undefined' ? self : this)
