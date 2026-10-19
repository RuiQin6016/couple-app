/**
 * App 共享状态 + 同步接线（把「业务数据」和「同步层」接起来）
 * ============================================================
 * 这是 prototype/index.html 的**唯一一份两人共享状态**：
 *
 *   app.state = { v, moods, diaries, whispers }      // 明文，只在设备上
 *        │
 *        │  AppState.mutate(fn)   ← 业务代码只改这一份
 *        ▼
 *   localStorage 本机副本（离线也能用）
 *        │
 *        │  pushWithMerge（加密 → Gist / 本机槽位）
 *        ▼
 *   provider 只看得到密文
 *
 * ⚠️ 三条设计要点（错了会丢数据，都有测试）：
 *   1. **拉取和上传都走 merge**，绝不整份覆盖。两个人可能同时写：
 *      上传前先比远端版本，发现对方写过就先合并再写（复用 Sync.pushWithMerge）。
 *   2. merge 是**就地合并进本地 state 并返回它** —— pushWithMerge 之后
 *      本地 state 里也已经含有对方的数据，不会"写上去了但本地还是旧的"。
 *   3. **没配置同步时也能用**：数据存本机，状态标 'local-only'。
 *      不假装在同步（那才是自娱自乐）。
 *
 * 以后 anniv / pet / period 也要搬进这个 state（现在它们还各存各的
 * localStorage）。搬的时候只要加一个 bucket + 一个 merge 分支。
 */

;(function (root) {
  'use strict'

  var isNode = (typeof require !== 'undefined')
  var CoupleSync = isNode ? require('./sync-store.js') : root.CoupleSync
  var Mood = isNode ? require('./mood.js') : root.Mood
  var Whisper = isNode ? require('./whisper.js') : root.Whisper
  var Order = isNode ? require('./order.js') : root.Order

  var LS_STATE = 'couple_app_state_v1'
  var LS_UID = 'couple_app_uid'
  /**
   * 扩展配置（sync-store 的 saveConfig 只认它自己那几个字段，
   * slotKey / filename / myUid 会被丢掉）。
   * ⚠️ 不去改 sync-store.js：它是被 36 项测试守着的，能不动就不动。
   */
  var LS_EXTRA = 'couple_app_sync_extra'

  /**
   * 相册单独一个同步文件（用**同一个 Gist、不同的文件名**）。
   *
   * 为什么不能塞进同一份 state：
   *   1. 照片是 dataURL，一张 80~150KB。state 每写一次都要整份加密上传 ——
   *      喂一次小猪（700ms 防抖）就会把几 MB 的相册重新加密上传一遍，流量和 API 额度都受不了。
   *   2. 本机那份 state 是整个存进 localStorage 的，几百 KB 的自拍塞进去很容易
   *      把 5MB 配额撑爆 —— 而 _persist 一旦抛 QuotaExceeded，**全部数据**都存不下。
   *   所以：core（心情/日记/悄悄话/纪念日/小猪/例假）一个文件，album 一个文件。
   */
  var ALBUM_FILENAME = 'couple-album.enc.json'
  /* ============================================================
     ★ 「一人一个文件」：核心数据按设备拆成两份
     ------------------------------------------------------------
     以前两个人**同时往同一个文件里写**（couple-sync.enc.json），
     Gist 不支持并发写，于是"撞车"要我们自己兜 —— 我反复出 bug 全在这一类
     （上传被轮询挡住就不补传、撞车就丢消息、锁卡死之后就什么都传不上去）。

     改成：couple-a.enc.json 只有 A 写，couple-b.enc.json 只有 B 写。
     「撞车」这个动作从物理上消失：她永远碰不到我的文件，我也碰不到她的。

     还要留着老的那个单文件（LEGACY）：
       · 一直**读**它 —— 还没升级的那台手机写进去的东西我照样看得到，
         而且万一新方案有问题，老文件里还有一份完整数据，不会丢；
       · 过渡期继续**写**它（best-effort，失败就算了）——
         这样还没升级的那台手机也照样看得到我的新东西，不会出现
         "我升级了她就看不到我了"的空窗期。
     ============================================================ */
  var LEGACY_CORE = 'couple-sync.enc.json'

  /** A/O → a；其它身份（自定义）返回空串 = 不拆分，退回老的单文件（稳） */
  function splitUid(uid) {
    var u = String(uid || '').toUpperCase()
    return (u === 'A' || u === 'B') ? u : ''
  }
  function coreFileFor(uid) { return 'couple-' + String(uid).toLowerCase() + '.enc.json' }
  function peerOf(uid) { return splitUid(uid) === 'A' ? 'B' : 'A' }

  /** 从 {日期: {uid: 记录}} 里只取某个 uid 的记录（心情、日记用这个结构） */
  function pickUidMap(map, uid) {
    var out = {}
    var src = map || {}
    for (var d in src) {
      if (!Object.prototype.hasOwnProperty.call(src, d)) continue
      var byUid = src[d] || {}
      if (Object.prototype.hasOwnProperty.call(byUid, uid) && byUid[uid]) {
        out[d] = {}
        out[d][uid] = byUid[uid]
      }
    }
    return out
  }
  /* 纪念日的默认值（首页显示的那个）。它会作为真数据播种进 state，见 seedAnniv */
  var ANNIV_SEED = '2026-05-20'
  /** 相册本机那一份的键（只有上传成功后才会写，避免"以为存上了其实没有"） */
  var LS_ALBUM = 'couple_app_album_local_v1'
  /** 轮询间隔：默认 20 秒（GitHub 认证后 5000 次/小时，20 秒约 4300 次/天，在额度内） */
  var DEFAULT_POLL_MS = 20000
  /** 打开对话页时的高频轮询（离开就恢复，否则会超额度） */
  var FAST_POLL_MS = 5000
  /** 本地改完到上传的合并延迟：连打几个字只传一次 */
  var PUSH_DEBOUNCE_MS = 700

  /**
   * ★「云端根本不存在」这句人话（2026-10-11 真机踩出来的第 3 个假绿灯）。
   *
   * 真机现场：两台手机在「接入已有的云端」里，云端 ID 填的是**界面上显示的 8 位缩写**
   * （界面还写着"前 8 位够用" —— 那句话是错的）。Gist 的真 ID 是 32 位，
   * 8 位去问 GitHub 一律 404。
   *
   * 而 404 以前被当成"这个文件还没有" → `_remoteOk = true` → **假绿灯**，
   * 然后每一次写都 404 失败、而且**一句话都不报**（status.error 是空字符串）。
   * 用户看到的就是：「接入了、体检也绿、可纪念日不同步、照片一直"正在自动重试"」。
   *
   * 现在：404 → 闸门保持关闭 + 这句人话，用户照着点就能自己修好。
   * （复现脚本：tools/repro-bad-gist-id.js，11 项断言逐字对上真机现象。）
   */
  var REMOTE_GONE_MSG = '云端 ID 不对：GitHub 找不到你们那个云端（不能只填 8 位缩写，真 ID 是 32 位）。' +
    '修法：🎀 → 同步 →「换个云端（接入已有的）」→ 点「🔎 自动找出我的云端」重新接一次'

  /**
   * "本机配置里没有云端 ID"（旧版本的毛病：我是第一个建好 Gist 之后没写回配置）。
   * 这个状态下**绝不能**拿"读不到"当"云端是空的"就去写 —— 那会 POST 出一个新云端，
   * 而对方还在老云端里等，两个人从此各写各的（真机踩了整整一天）。
   */
  var NO_GIST_MSG = '这台手机没记住云端 ID（旧版本留下的毛病）。' +
    '修法：🎀 → 同步 →「清除这台手机的配对」→ 再重新配一次（本机记录不会丢）'

  /* ---------- 本机存储（浏览器 localStorage / Node 内存） ---------- */

  var mem = {}

  function lsGet(k) {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.getItem(k)
    } catch (e) { /* 隐私模式 */ }
    return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null
  }

  function lsSet(k, v) {
    try {
      if (typeof localStorage !== 'undefined') { localStorage.setItem(k, v); return true }
    } catch (e) { /* 额度满或隐私模式 → 落到内存 */ }
    mem[k] = v
    return true
  }

  function emptyState() {
    return {
      v: 1,
      moods: {}, diaries: {}, whispers: [],
      /* 下单提醒：**只增不改的流水** + readBy（读的人写，见 applyReads 的说明） */
      orders: [],
      /* ntfy 推送的专属 topic（32 位随机，它本身就是"密码"）。空 = 没开推送 */
      pushTopic: '',
      /* 纪念日：**一份**，两人同步改（{startKey, updatedAt, updatedBy}） */
      anniv: null,
      /* 小猪：快照 + 时间戳，谁打开谁补算（data/pet.js 的 settle） */
      pet: null,
      /* 相册：照片数组（含 dataURL），走**单独的同步文件**，见 ALBUM_FILENAME 的注释 */
      album: null,
      /* 例假：按日期存 + 一份设置 */
      periodLog: {}, periodSettings: null
    }
  }

  function loadLocal(key) {
    var raw = lsGet(key || LS_STATE)
    var s = null
    if (raw) {
      try { s = JSON.parse(raw) } catch (e) { s = null }
    }
    if (!s || typeof s !== 'object') s = emptyState()
    Mood.ensure(s)
    Whisper.ensure(s)
    Order.ensure(s)
    absorbLegacy(ensureShared(s))
    seedAnniv(s)
    /* ★ 相册的本机缓存要**每次都读**（不能只在"老数据迁移"那一步读一次）：
       core 那份本机副本里没有相册（怕撑爆配额），相册单独一个 key。
       漏了这一步的后果就是用户报的「传完照片一刷新就没了」——实测踩到过。 */
    if (!s.album) {
      var cached = albumCacheLoad()
      if (cached) s.album = cached
    }
    return s
  }

  /** 把新搬进来的几个桶建出来（老数据 / 空状态兼容） */
  function ensureShared(s) {
    if (!s.periodLog || typeof s.periodLog !== 'object') s.periodLog = {}
    if (typeof s.anniv === 'undefined') s.anniv = null
    if (typeof s.pet === 'undefined') s.pet = null
    if (typeof s.album === 'undefined') s.album = null
    if (typeof s.periodSettings === 'undefined') s.periodSettings = null
    return s
  }

  /* ============================================================
     相册的**本机缓存**（单独一个 key）
     ------------------------------------------------------------
     为什么要有：相册不能放进 core 那个 key（几百 KB 的 dataURL 会把
     5MB 配额撑爆，一撑爆连心情/日记都存不下）。但没有本机缓存的话，
     用户「传完照片一刷新就没了」—— 得等云端拉回来才显示，
     云端稍慢/失败就看起来像丢了照片（用户 2026-10-11 就是这么报的）。
     所以给它单独一个 key，**撑爆了也只影响相册自己**。
     超过 MAX_CACHE 就不缓存（照片仍在云端，下次打开拉回来）。
     ============================================================ */
  var ALBUM_CACHE_MAX = 2600000      /* ≈2.6MB，给 core 留足空间 */

  function albumCacheSave(album) {
    try {
      if (!album || !album.photos || !album.photos.length) { lsSet(LS_ALBUM, ''); return false }
      var txt = JSON.stringify(album)
      if (txt.length > ALBUM_CACHE_MAX) {
        /* 太大了：宁可不缓存，也不能把 core 的配额挤掉 */
        lsSet(LS_ALBUM, '')
        return false
      }
      return lsSet(LS_ALBUM, txt)
    } catch (e) { return false }
  }

  function albumCacheLoad() {
    try {
      var raw = lsGet(LS_ALBUM)
      if (!raw) return null
      var a = JSON.parse(raw)
      return (a && a.photos && a.photos.length) ? a : null
    } catch (e) { return null }
  }

  /* ============================================================
     共享桶的合并规则
     ------------------------------------------------------------
     这几个东西以前走 data/shared-data.js（localStorage + storage 事件）——
     那只在**同一台电脑的两个窗口**之间同步，两台手机之间根本到不了。
     现在搬进这份 state，走加密同步，两台手机才真能互相看到。

     合并规则各不相同，逐条写清楚（错了会丢数据）：
       anniv / pet / periodSettings：**一份数据**，比 updatedAt，新的胜
       album：按 id 取并集 + **墓碑**（删掉的照片记 id，否则会被对方"复活"）
       periodLog：逐「日期」比 updatedAt
     ============================================================ */

  function newerBy(a, b) {
    var ta = (a && a.updatedAt) || 0
    var tb = (b && b.updatedAt) || 0
    if (ta !== tb) return ta > tb
    /* 时间戳完全一样（同一毫秒的并发写）→ 按序列化字符串定序，
       保证两台设备各算一次也得到同一个结果（收敛） */
    return JSON.stringify(a) > JSON.stringify(b)
  }

  function mergeOne(target, incoming) {
    if (!incoming || typeof incoming !== 'object') return target
    if (!target) return incoming
    return newerBy(incoming, target) ? incoming : target
  }

  function mergeMapByDay(target, incoming) {
    if (!incoming || typeof incoming !== 'object') return target
    var out = target || {}
    for (var k in incoming) {
      if (!Object.prototype.hasOwnProperty.call(incoming, k)) continue
      var cur = out[k], inc = incoming[k]
      if (!cur) { out[k] = inc; continue }
      if (newerBy(inc, cur)) out[k] = inc
    }
    return out
  }

  /**
   * ★★ 小猪合并：**不能整份比 updatedAt**（2026-10-19 真机「猪猪状态不同步」的真凶）。
   *
   * 为什么不能用 mergeOne（原来的写法）：
   *   `index.html` 里有个每 30 秒的心跳：
   *     `setInterval(function(){ S = settle(read()||S); write(S); render() }, 30000)`
   *   而 `setPet()` 每次都把 `updatedAt` 刷成"现在"。于是：
   *
   *     ① B 喂猪一次（care 0→1）并上传          → B.care = 1
   *     ② A 的心跳触发（A 期间没拉过，care 还是 0）→ updatedAt 被顶到最新
   *     ③ B 拉一次 → **B.care = 0，last 变成 {}** ← 喂食被彻底抹掉
   *
   *   实测复现过（见 tools/test-pet-sync.js）：一分钟发生两次，所以两台手机上的猪
   *   永远对不上，而且用户喂的那一下会**真的丢掉**。这是数据丢失级别的 bug。
   *
   * 正确做法：把「小猪」拆成两类字段，分开合。
   *   · **单调事实**（care 累计互动次数、last 谁什么时候做过什么）
   *     —— 只会增加，永不减少 → 取**较大值/并集**，任何过期心跳都撼动不了它。
   *   · **会衰减的数值**（v 饱食 / mood 心情 / clean 清洁 / energy 体力）
   *     —— 两边各按自己的时间差补算过，取**时间戳较新**的那一份（它结算得更近）。
   *   · pos（挂件位置）—— 谁最后拖的算谁的。
   *
   * 这样"心跳"最多把数值刷新到更近的一次结算结果，**不会**再把对方的投喂抹掉。
   */
  function mergePet(target, incoming) {
    if (!incoming || typeof incoming !== 'object') return target
    if (!target) return incoming

    var out = {}
    var k
    /* 先复制一份，保持字段齐全（含将来新增的字段） */
    for (k in target) if (Object.prototype.hasOwnProperty.call(target, k)) out[k] = target[k]

    /* ① 单调事实：care 取较大 */
    out.care = Math.max(Number(target.care) || 0, Number(incoming.care) || 0)

    /* ② 单调事实：last 按 uid 并集，同一个 uid 取较晚的 */
    var lastA = target.last || {}, lastB = incoming.last || {}
    var last = {}
    var u
    for (u in lastA) if (Object.prototype.hasOwnProperty.call(lastA, u)) last[u] = lastA[u]
    for (u in lastB) {
      if (!Object.prototype.hasOwnProperty.call(lastB, u)) continue
      var pa = last[u], pb = lastB[u]
      if (!pa) { last[u] = pb; continue }
      var ta = (pa && pa.t) || 0, tb = (pb && pb.t) || 0
      last[u] = (tb >= ta) ? pb : pa
    }
    out.last = last

    /* ③ 会衰减的数值：整份取 updatedAt 较新的那份（它结算得更近）。
       ⚠️ 只覆盖这几个数值字段 —— 不整份替换，否则又会把上面的单调事实带跑。 */
    var aNewer = !newerBy(incoming, target)
    var fresher = aNewer ? target : incoming
    out.v = typeof fresher.v === 'number' ? fresher.v : ((typeof fresher.food === 'number') ? fresher.food : target.v)
    out.mood = typeof fresher.mood === 'number' ? fresher.mood : target.mood
    out.clean = typeof fresher.clean === 'number' ? fresher.clean : target.clean
    out.energy = typeof fresher.energy === 'number' ? fresher.energy : target.energy
    out.at = Math.max(Number(target.at) || 0, Number(incoming.at) || 0)

    /* ④ 位置：谁最后拖的算谁的（updatedAt 新的那份） */
    if (aNewer) { if (target.pos) out.pos = target.pos }
    else if (incoming.pos) out.pos = incoming.pos

    /* ⑤ updatedAt 取两者较新 —— 但要防"心跳把时间戳顶新"反过来影响别的判断 */
    out.updatedAt = Math.max(Number(target.updatedAt) || 0, Number(incoming.updatedAt) || 0)

    return out
  }

  /**
   * 相册合并：按 id 并集；隐藏状态按 updatedAt 取新的；
   * **删除用墓碑**（deleted: { id: 时间 }）—— 直接删 key 的话，
   * 对方那份里还有这张照片，下次合并就被"复活"了。
   */
  function mergeAlbum(target, incoming) {
    if (!incoming || typeof incoming !== 'object') return target
    if (!target) return incoming
    var del = {}
    var i
    var ta = target.deleted || {}, ia = incoming.deleted || {}
    for (i in ta) if (Object.prototype.hasOwnProperty.call(ta, i)) del[i] = ta[i]
    for (i in ia) {
      if (!Object.prototype.hasOwnProperty.call(ia, i)) continue
      if (!del[i] || ia[i] > del[i]) del[i] = ia[i]
    }

    var byId = {}
    var out = []
    var push = function (p) {
      if (!p || !p.id) return
      if (byId[p.id]) return
      byId[p.id] = true
      out.push(p)
    }
    var listA = target.photos || [], listB = incoming.photos || []
    var mapA = {}, mapB = {}
    for (i = 0; i < listA.length; i++) if (listA[i] && listA[i].id) mapA[listA[i].id] = listA[i]
    for (i = 0; i < listB.length; i++) if (listB[i] && listB[i].id) mapB[listB[i].id] = listB[i]

    /* 先两边的全部 id，再处理 */
    var ids = {}
    for (i in mapA) ids[i] = 1
    for (i in mapB) ids[i] = 1
    for (var id in ids) {
      if (!Object.prototype.hasOwnProperty.call(ids, id)) continue
      var a = mapA[id], b = mapB[id]
      var keep = null
      if (a && b) {
        /* 两边都有：隐藏/配文这类字段按 updatedAt 取新的 */
        keep = newerBy(b, a) ? b : a
      } else {
        keep = a || b
      }
      /* 墓碑比照片新 → 这张是真被删了，别复活 */
      if (del[id] && (!keep.updatedAt || del[id] >= keep.updatedAt)) continue
      push(keep)
    }
    out.sort(function (x, y) { return (y.uploadedAt || 0) - (x.uploadedAt || 0) })

    return {
      v: 1,
      photos: out,
      deleted: del,
      updatedAt: Math.max(target.updatedAt || 0, incoming.updatedAt || 0)
    }
  }

  /**
   * 把远端数据合并进本地（**就地改并返回本地对象**）。
   * pushWithMerge 的 merge 回调也是用它 —— 所以上传完之后
   * 本地 state 里已经含有对方的数据，不会出现"传上去了本地还是旧"。
   *
   * ⚠️ 只合并**认得出来的字段**：同一个 Gist 里还有一个相册文件，
   *    两边各自的写入都会碰到对方，互不认识的字段一律跳过（别覆盖别人的）。
   */
  function mergeIntoLocal(local, remote, opts) {
    if (!remote || typeof remote !== 'object') return local
    opts = opts || {}
    ensureShared(local)
    Mood.mergeInto(local, remote)
    Whisper.mergeInto(local, remote)
    applyReads(local, remote)
    applyOrderReads(local, remote)
    local.anniv = mergeOne(local.anniv, remote.anniv)
    /* ★ ntfy topic：两人共用一个才能都收到通知。
       ⚠️ 但要尊重"本机**主动关掉**了推送"（opts.pushOff）：否则 pull 一跑就把
       对方那份的 topic 又合并回来 —— 用户点了"关闭推送"却还在发通知。
       ⚠️ 不能在这里用 `this` / `that`：本函数是**模块级普通函数**不是方法，
          写 `that._pushOff` 会抛 ReferenceError，把整段合并静默打断
          （踩过：B 拿不到 topic + 2 条订单变 1 条，全是它引起的）。
          （test-order-notify.js 第五节抓到 disablePush 之后照样发通知。） */
    if (remote.pushTopic && !local.pushTopic && !opts.pushOff) {
      local.pushTopic = remote.pushTopic
    }
    /* ★ 小猪**不能**用 mergeOne（整份比 updatedAt）——
       每 30 秒的心跳会刷新 updatedAt，把对方真实的投喂抹掉。
       见 mergePet 的注释（真机「猪猪状态不同步」+ 喂食丢失）。 */
    local.pet = mergePet(local.pet, remote.pet)
    local.periodSettings = mergeOne(local.periodSettings, remote.periodSettings)
    local.periodLog = mergeMapByDay(local.periodLog, remote.periodLog)
    if (remote.album && remote.album.photos) local.album = mergeAlbum(local.album, remote.album)
    return local
  }

  /**
   * ★ "已读"是**读的人**写的，但那条消息是**发的人**的 —— 一人一个文件之后，
   *   读的人没法去改对方文件里的记录（那正是我们要避免的"动别人的数据"）。
   *   所以读的人把自己读过的消息写进**自己那份**的 reads: { 消息id: 读的时间 }，
   *   对方拉到我这份时再贴回那条消息上。
   *   不这么做的话，B 读了 A 的消息，A 那边永远显示"未读"（实测就是这样）。
   */
  function applyReads(local, remote) {
    var reads = remote && remote.reads
    if (!reads || typeof reads !== 'object') return
    var reader = remote.uid || ''
    if (!reader) return
    var list = local.whispers || []
    var byId = {}
    var i
    for (i = 0; i < list.length; i++) if (list[i] && list[i].id) byId[list[i].id] = list[i]
    for (var id in reads) {
      if (!Object.prototype.hasOwnProperty.call(reads, id)) continue
      var m = byId[id]
      if (!m) continue
      var at = Number(reads[id]) || 0
      if (!at) continue
      if (!m.readBy) m.readBy = {}
      if (!m.readBy[reader] || m.readBy[reader] < at) m.readBy[reader] = at
    }
  }

  /**
   * ★ 「下单提醒」的已读状态，和悄悄话同一套道理（见上面 applyReads）。
   *
   * 读的人是我、但那条提醒在**对方名下**（谁买的归谁）——一人一个文件之后
   * 我没法去改对方文件里的记录。所以我把"看过了"写进**自己那份**，
   * 对方拉到我这份时再贴回那条提醒上。不这么做，对方永远显示"未读"。
   *
   * ⚠️ 兑现状态（done）**不走这里** —— 那个只有下单的人自己能标（markDone 会校验），
   *    而且它跟着 order.by 那份文件自然同步过去。
   */
  function applyOrderReads(local, remote) {
    /* ★★ 先合并对方的 orders —— 这一步**绝不能**放在下面的 early return 之后。
       踩过：原来写成「先看 orderReads 有没有，没有就直接 return」，
       于是对方**一条都没读过**的时候（orderReads 是空 {}）这段整个跳过，
       对方的订单根本并进不来 —— 表现就是「TA 买的东西我这边看不到」。
       （test-order-notify.js 第三节抓到：期望 2 条，实际 1 条。） */
    Order.mergeInto(local, remote)

    var reads = remote && remote.orderReads
    if (!reads || typeof reads !== 'object') return
    var reader = remote.uid || ''
    if (!reader) return
    var list = local.orders || []
    var byId = {}
    var i
    for (i = 0; i < list.length; i++) if (list[i] && list[i].id) byId[list[i].id] = list[i]
    for (var id in reads) {
      if (!Object.prototype.hasOwnProperty.call(reads, id)) continue
      var o = byId[id]
      if (!o) continue
      var at = Number(reads[id]) || 0
      if (!at) continue
      if (!o.readBy) o.readBy = {}
      if (!o.readBy[reader] || o.readBy[reader] < at) o.readBy[reader] = at
    }
  }



  /**
   * @param {object} opts
   *   uid        我的身份（'A' / 'B'）—— 状态里按这个 key 存各自的心情和日记
   *   profile    同步配置档位（默认 'default'）
   *   pollMs     轮询间隔（默认 20 秒）
   *   storageKey 本机副本的键（默认 LS_STATE）。**只在测试里用**：
   *              同一个 Node 进程里模拟"两台设备"时，两台必须用不同的键，
   *              否则读写的本机副本是同一份，就不是两台设备了。
   *   autoPush   本地改完是否自动排队上传（默认 true）。测试里关掉，
   *              用手动 pushNow() 精确控制时序。
   */
  function AppState(opts) {
    opts = opts || {}
    this.uid = opts.uid || 'A'
    this.profile = opts.profile || 'default'
    this.pollMs = opts.pollMs || DEFAULT_POLL_MS
    this.storageKey = opts.storageKey || LS_STATE
    this.autoPush = opts.autoPush !== false
    this.state = loadLocal(this.storageKey)
    this.sync = null
    this.cfg = null
    this.listeners = []
    this.status = {
      mode: 'local-only',      /* 'local-only' | 'synced' | 'error' */
      provider: '',
      configured: false,
      lastPull: 0,
      lastPush: 0,
      pending: 0,              /* 还有几次本地改动没上传 */
      error: '',
      myUid: this.uid
    }
    this._timer = null
    this._pushTimer = null
    this._busy = false
    this._busySince = 0          /* 这次上传是什么时候开始的（卡死看门狗用，见 pushNow） */
    this._drityAgain = false
    this._dirty = false          /* 本机有改动还没成功上传（BUSY 被跳过时靠它补传） */
    /* ★ 拉取用**自己**的锁。绝对不能用 _busy：
       轮询每 20 秒拉一次，拉的时候 pushNow 会撞上 _busy 直接返回 BUSY，
       用户刚发的悄悄话就被"跳过"且永不重传 —— 对方什么都收不到。
       这是"她发的我看不到 / 我发的她收不到"最隐蔽的一个成因。 */
    this._pulling = false
    this._pullingSince = 0
    this._visHandler = null
    this._fast = false
    /* 相册（单独一个同步文件，见 ALBUM_FILENAME 的注释） */
    this.albumSync = null
    this._albumBusy = false
    this._albumPushTimer = null
    this._albumRemoteOk = false
    this._albumDirty = false
    this.status.album = {
      mode: 'local-only',
      /* ★ 两个不同的东西，别混用（混用的后果见 _scheduleAlbumPush 的注释）：
         inflight = 正在/排队中要上传的次数，**正常现象**，不该报警；
         pending  = 真·卡住了（失败/被挡下，正等自动重试），这才是要让用户看到的。 */
      inflight: 0,
      pending: 0,
      lastPull: 0, lastPush: 0, error: '', photos: 0
    }
    /** 有没有读到过对方的新格式文件（= 对方也升级了）。见 _peerSources */
    this._peerSeen = false
    this._albumApi = null
    this._coreRetryTimer = null
    /**
     * ★ 安全闸：有没有「确认过云端」？
     *   - 远端是空的（第一次用）→ 可以写
     *   - 成功解开过远端数据 → 可以写（说明口令是对的）
     *   - **解不开 / 还没拉过 → 一律不写**
     * 不加这道闸的后果（实测踩到）：口令配错的那台设备 pull 解密失败，
     * 但 push 照旧执行 —— 它用错口令加密后**把云端覆盖掉**，
     * 对方从此再也解不开自己的数据（永久丢失，不可恢复）。
     */
    this._remoteOk = false
    /* 上一次拉取失败的真实原因（'GONE' / 'UNREADABLE' / 'EMPTY' / 'NO_SECRET'）——
       决定"传不上去"时给用户报哪句话，见 REMOTE_GONE_MSG */
    this._lastPullReason = ''
    /* 相册那条通道单独记一份（两个文件的失败原因可能不一样） */
    this._lastAlbumPullReason = ''
    /* ★ 这一次 configure 是不是"我就是要新建一个云端"（「我是第一个」）。
       只有它是 true 的时候，"读不到云端"才允许当成"空白云端"然后去建；
       普通重开页面（配置里 gistId 是空的）**绝不允许** —— 见 NO_GIST_MSG。 */
    this._creatingCloud = false
    /* 身份：URL 参数（预览）> 本机存的身份 > 默认 A */
    var savedUid = lsGet(LS_UID)
    if (!opts.uid && savedUid) this.uid = savedUid
    this.status.myUid = this.uid

    this._loadConfig()
  }

  /* ---------- 订阅 ---------- */

  /** 状态变了（本地改 / 远端拉下来）都会回调；返回取消订阅的函数 */
  AppState.prototype.subscribe = function (fn) {
    this.listeners.push(fn)
    var that = this
    return function off() {
      var i = that.listeners.indexOf(fn)
      if (i >= 0) that.listeners.splice(i, 1)
    }
  }

  AppState.prototype._notify = function (reason) {
    for (var i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](this.state, reason || 'change') } catch (e) { /* 单个回调出错不影响别人 */ }
    }
  }

  AppState.prototype.statusText = function () {
    var s = this.status
    if (s.error) return '同步出错：' + s.error
    if (s.mode === 'local-only') return '只存在本机（还没配对）'
    var extra = s.pending > 0 ? '（' + s.pending + ' 项待上传）' : ''
    return '已同步 · ' + (s.provider === 'github' ? 'GitHub Gist' : '本机双窗口') + extra
  }

  /* ---------- 配置 ---------- */

  /**
   * 把旧的共享层数据搬进 state（**只搬一次**）。
   *
   * 为什么要搬：纪念日/小猪/例假以前走 data/shared-data.js 的 localStorage，
   * 那只在同一台电脑的两个窗口之间同步（storage 事件），**两台手机之间根本到不了**。
   * 搬进 state 之后就跟着加密同步走了。旧键留着不删（万一要回退）。
   */
  function absorbLegacy(s) {
    if (s.__legacyDone) return s
    var room = 'demo-room'      /* shared-data.js 的 CONFIG.roomId 默认值 */
    var shared = function (name) {
      var raw = null
      try { raw = lsGet('couple_shared_' + room + '_' + name) } catch (e) { return null }
      if (raw === null || raw === undefined || raw === '') return null
      try { return JSON.parse(raw) } catch (e) { return null }
    }
    var anniv = shared('anniv')
    if (anniv && anniv.startKey && !s.anniv) s.anniv = anniv
    var pet = shared('pet')
    if (pet && !s.pet) s.pet = pet
    var plog = shared('periodLog')
    if (plog && (!s.periodLog || !Object.keys(s.periodLog).length)) s.periodLog = plog
    var pset = shared('periodSettings')
    if (pset && !s.periodSettings) s.periodSettings = pset

    /* 纪念日还有一份更老的键（首页那个改日期面板写的） */
    if (!s.anniv) {
      var legacyStart = null
      try { legacyStart = lsGet('couple_anniv_start') } catch (e) { legacyStart = null }
      if (legacyStart) s.anniv = { startKey: legacyStart, updatedAt: 0, updatedBy: '', legacy: true }
    }
    /* 反过来：state 里已经有纪念日、但那个老键是空的 → 补一份，
       让「没配对 / 还没拉到云端」时也有东西可显示（shared-data.js 的退路要用） */
    if (s.anniv && s.anniv.startKey) {
      try { if (!lsGet('couple_anniv_start')) lsSet('couple_anniv_start', s.anniv.startKey) } catch (e) { /* ignore */ }
    }
    /* ⚠️ 相册的本机缓存**不在这里读**：这个函数只会跑一次（迁移标记一写就返回），
       而缓存必须每次打开都读。见 loadLocal。 */
    s.__legacyDone = true
    return s
  }

  /**
   * ★ 把「首页显示的那个默认纪念日」落成真数据。
   *
   * 为什么必须做：首页原来显示的是代码里写死的 2026-05-20（DEFAULT_START），
   * 它**从来没进过 state** —— 所以两台手机各显示各的、云端里也没有，
   * 谁改日期都同步不了（用户 2026-10-11 报"纪念日也不同步"，
   * 体检报告里"云端纪念日：无"就是这个原因）。
   *
   * updatedAt 故意只给 1：
   *   · 以后谁真去改过日期（updatedAt = 现在），一定赢过它，不会被这个默认值顶掉；
   *   · 两台手机各自播种也都是 1，按 newerBy 的平局规则能收敛到同一个值。
   */
  function seedAnniv(s) {
    if (s.anniv && s.anniv.startKey) {
      if (s.anniv.updatedAt === undefined) s.anniv.updatedAt = 0
      return s
    }
    var legacy = null
    try { legacy = lsGet('couple_anniv_start') } catch (e) { legacy = null }
    s.anniv = { startKey: legacy || ANNIV_SEED, updatedAt: 1, updatedBy: '' }
    try { if (!legacy) lsSet('couple_anniv_start', ANNIV_SEED) } catch (e) { /* ignore */ }
    return s
  }

  AppState.prototype._loadConfig = function () {
    var cfg = null
    try { cfg = CoupleSync.loadConfig(this.profile) } catch (e) { cfg = null }
    var extra = null
    try { extra = JSON.parse(lsGet(LS_EXTRA) || 'null') } catch (e) { extra = null }
    if (cfg && extra) {
      /* 扩展字段回填（slotKey / filename / myUid 不在 saveConfig 的字段里） */
      if (extra.slotKey) cfg.slotKey = extra.slotKey
      if (extra.filename) cfg.filename = extra.filename
      if (extra.myUid) cfg.myUid = extra.myUid
    }
    if (!cfg) { this._buildSync(null); this._buildAlbum(null); return }
    this.cfg = cfg
    if (cfg.myUid) { this.uid = cfg.myUid; this.status.myUid = cfg.myUid }
    if (!CoupleSync.isConfigured(cfg)) { this._buildSync(null); this._buildAlbum(null); return }
    this._buildSync(cfg)
    this._buildAlbum(cfg)
  }

  AppState.prototype._buildSync = function (cfg) {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    if (!cfg) {
      this.sync = null
      this.peerSync = null
      this.legacySync = null
      this.status.mode = 'local-only'
      this.status.configured = false
      this.status.provider = ''
      return
    }
    var that = this
    var mk = function (filename) {
      var opts = cfg.provider === 'github'
        ? { token: cfg.token || '', gistId: cfg.gistId || '', filename: filename }
        : { key: filename }
      var s = new CoupleSync.Sync({
        provider: cfg.provider || 'local',
        passphrase: cfg.passphrase,
        salt: cfg.salt,
        providerOptions: opts
      })
      if (cfg.gistId) s.gistId = cfg.gistId
      return s
    }
    var me = splitUid(this.uid)
    if (cfg.provider === 'github') {
      /* Gist：同一个 Gist 里的不同文件名 */
      this.sync = mk(me ? coreFileFor(me) : (cfg.filename || LEGACY_CORE))
      this.peerSync = me ? mk(coreFileFor(peerOf(me))) : null
      this.legacySync = me ? mk(LEGACY_CORE) : null
    } else {
      /* 本机/测试用 local provider：用不同的 key 当不同的文件 */
      var base = cfg.slotKey || 'couple_sync_slot'
      this.sync = mk(me ? base + '_' + me.toLowerCase() : base)
      this.peerSync = me ? mk(base + '_' + peerOf(me).toLowerCase()) : null
      this.legacySync = me ? mk(base) : null
    }
    this.status.mode = 'synced'
    this.status.configured = true
    this.status.provider = this.sync.providerName()
  }

  /** 除了"我这份"之外还要读的来源（对方的 + 过渡期的老文件）；读不到不算错
   *  ⚠️ 老的单文件只在**对方还没升级**时才需要读。一旦读到过对方的
   *     「couple-x.enc.json」，就说明对面已经是新版本了，那个老文件就是多余的 ——
   *     继续读它纯粹是浪费 GitHub 额度（免费额度 5000 次/小时，两台手机共用）。
   */
  AppState.prototype._peerSources = function () {
    var out = []
    if (this.peerSync) out.push({ name: '对方的文件', sync: this.peerSync, isPeer: true })
    if (this.legacySync && !this._peerSeen) out.push({ name: '老的单文件', sync: this.legacySync })
    return out
  }

  /**
   * 只拉"对方的"那几份并合并进来（不含我自己的）。
   * 用在两处：正常拉取时、以及**我推完一次之后** ——
   * 刚发完消息的人应该马上看到对方的东西，而不是等下一次轮询（最多 20 秒）。
   * @returns {Promise<boolean>} 本地是否因此变了
   */
  AppState.prototype._pullPeers = function () {
    var that = this
    var srcs = this._peerSources()
    if (!srcs.length) return Promise.resolve(false)
    var changed = false
    return Promise.all(srcs.map(function (src) {
      return src.sync.pull().then(function (r) {
        if (!r || !r.found) return false
        /* ★ 读到了对方的新格式文件 → 对面已经升级了，老的单文件不用再读（省额度） */
        if (src.isPeer) that._peerSeen = true
        var before = JSON.stringify(that.state)
        mergeIntoLocal(that.state, r.data, { pushOff: that._pushOff })
        if (JSON.stringify(that.state) !== before) { changed = true; return true }
        return false
      }).catch(function (e) {
        /* 读不到不算错（对方还没升级 / 那个文件还没有），只记一笔备查 */
        that.status.peerError = src.name + '读不到：' + String(e && e.message ? e.message : e)
        return false
      })
    })).then(function () {
      if (changed) {
        that._persist()
        that._notify('remote')
      }
      return changed
    })
  }

  /**
   * 相册：**同一个 Gist、另一个文件名**（或者 local provider 下另一个槽位 key）。
   * 为什么要独立一份：照片是老大的 dataURL，跟 core 混在一起的话
   * 喂一次小猪就要把几 MB 重新加密上传一遍（见 ALBUM_FILENAME 的注释）。
   */
  AppState.prototype._buildAlbum = function (cfg) {
    if (!cfg) {
      this.albumSync = null
      this.status.album.mode = 'local-only'
      return
    }
    var opts = cfg.provider === 'github'
      ? { token: cfg.token || '', gistId: cfg.gistId || '', filename: ALBUM_FILENAME }
      : { key: (cfg.slotKey || 'couple_sync_slot') + '_album' }
    this.albumSync = new CoupleSync.Sync({
      provider: cfg.provider || 'local',
      passphrase: cfg.passphrase,
      salt: cfg.salt,
      providerOptions: opts
    })
    if (cfg.gistId) this.albumSync.gistId = cfg.gistId
    this._albumRemoteOk = false
    this.status.album.mode = 'synced'
  }

  /**
   * 配置（或重配）同步。配对流程拿到的东西直接传进来。
   * @param {object} cfg { provider, passphrase, salt, token, gistId, slotKey, myUid }
   */
  AppState.prototype.configure = function (cfg) {
    cfg = cfg || {}
    if (cfg.myUid) this.uid = cfg.myUid
    var saved = CoupleSync.saveConfig(this.profile, {
      provider: cfg.provider || 'local',
      passphrase: cfg.passphrase || '',
      salt: cfg.salt || '',
      token: cfg.token || '',
      gistId: cfg.gistId || ''
    })
    /* 扩展字段自己存一份（见 LS_EXTRA 的注释），并带上我的身份：
       不然重启后两台设备又都变回 A，两人的日记会互相覆盖。 */
    saved.slotKey = cfg.slotKey || ''
    saved.filename = cfg.filename || ''
    saved.myUid = this.uid
    try { lsSet(LS_EXTRA, JSON.stringify({ slotKey: saved.slotKey, filename: saved.filename, myUid: this.uid })) } catch (e) { /* ignore */ }
    lsSet(LS_UID, this.uid)
    this.cfg = saved
    this.status.myUid = this.uid
    this._remoteOk = false      /* 换了配置就要重新确认云端（口令可能换了） */
    this._albumRemoteOk = false
    /* ★ 只有"这次就是要新建云端"（我是第一个：没带 gistId）才允许把
       "读不到云端"当成空白云端去写。普通重开页面走的是 _loadConfig，不经过这里。 */
    this._creatingCloud = !!(saved.provider === 'github' && !saved.gistId)
    this._buildSync(saved)
    this._buildAlbum(saved)
    this.startPolling()
    return this.ready(true)
  }

  AppState.prototype.clearConfig = function () {
    CoupleSync.clearConfig(this.profile)
    try { lsSet(LS_EXTRA, '') } catch (e) { /* ignore */ }
    this.cfg = null
    this._buildSync(null)
    this._buildAlbum(null)
    this.stopPolling()
    this._notify('config')
  }

  AppState.prototype.fingerprint = function () {
    if (!this.sync) return ''
    try { return this.sync.fingerprint() } catch (e) { return '' }
  }

  /**
   * 改「我是谁」（'A' / 'B'）。
   * ⚠️ 两台设备必须一个是 A 一个是 B：心情/日记按「日期 + 人」存，
   *    两台都是 A 会互相覆盖。配对时会自动设好，这里只是允许手动纠正。
   */
  AppState.prototype.setUid = function (uid) {
    uid = String(uid || '').trim()
    if (!uid) return this.uid
    if (uid === this.uid) return this.uid
    this.uid = uid
    this.status.myUid = uid
    lsSet(LS_UID, uid)
    /* 同步配置里也存一份：不然重启后又变回默认的 A */
    if (this.cfg) {
      this.cfg.myUid = uid
      try {
        var extra = null
        try { extra = JSON.parse(lsGet(LS_EXTRA) || 'null') } catch (e) { extra = null }
        /* ⚠️ 整体重写，别只改 myUid 字段：extra 为空时会把 slotKey/filename 一起抹掉
           （内存里还有，但重启后 _loadConfig 就恢复不出来了） */
        extra = {
          slotKey: (extra && extra.slotKey) || this.cfg.slotKey || '',
          filename: (extra && extra.filename) || this.cfg.filename || '',
          myUid: uid
        }
        lsSet(LS_EXTRA, JSON.stringify(extra))
      } catch (e) { /* ignore */ }
    }
    this._persist()
    this._notify('uid')
    return this.uid
  }

  /* ---------- 读写 ---------- */

  AppState.prototype.getState = function () { return this.state }

  /**
   * 改状态：**所有业务写入都走这里**。
   * 自动做三件本地事（持久化 / 通知 UI / 排队上传），调用方不用管同步。
   */
  AppState.prototype.mutate = function (fn) {
    var ret = fn ? fn(this.state) : undefined
    this._persist()
    this._notify('local')
    if (this.autoPush) { this._dirty = true; this._schedulePush() }
    return ret
  }

  /**
   * core 那份要上传的内容：**一切照旧，但相册那一段换成 null**。
   *
   * ⚠️⚠️ 这里踩过一个很严重的坑（2026-10-11，用户报"照片传上去刷新就没了、
   *     悄悄话显示已送达但对方看不到、情绪日记双方都看不到"）：
   *     原来 pushNow 直接把 this.state 整个传上去，而 state 里**含着相册照片**
   *     （几百 KB ~ 几 MB 的 dataURL）。于是每改一次心情、每发一条悄悄话，
   *     都要把整本相册重新加密上传一遍 —— 体积瞬间涨到几 MB，
   *     GitHub 那边写入失败/超时，结果**连 core 都发不出去了**：
   *     心情、日记、悄悄话全都不通，两台手机互相看不到。
   *     相册本来就有属于它自己的另一个同步文件（ALBUM_FILENAME），
   *     所以 core 里必须把它摘掉。
   */
  AppState.prototype._corePayload = function () {
    var out = {}
    for (var k in this.state) {
      if (!Object.prototype.hasOwnProperty.call(this.state, k)) continue
      out[k] = (k === 'album') ? null : this.state[k]
    }
    return out
  }
  /**
   * ★ 我这一份要传上去的内容（**只有我自己写的**）。
   *
   * 这是「一人一个文件」的关键：我只写我自己的东西，所以：
   *   · 我的文件只有我在写 → 不可能撞车、不可能被对方覆盖
   *   · 文件更小（不含对方的数据，也不含相册）
   * 对方那份由对方的手机自己传，我这边只读。
   *
   * 属于"两人共用一份"的设置（纪念日 / 小猪 / 例假设置）两边都会带一份，
   * 读的时候按 updatedAt 取新的 —— 这类值改动极少，而且即使用户真的同时改，
   * 最坏也只是丢一次"设置"，绝不会丢消息。
   */
  AppState.prototype._mySlice = function () {
    var s = this.state
    var me = this.uid
    var out = { v: s.v || 1, uid: me, at: Date.now() }
    var w = []
    var reads = {}
    var all = s.whispers || []
    for (var i = 0; i < all.length; i++) {
      var m = all[i]
      if (!m) continue
      if (m.by === me) { w.push(m); continue }
      /* 对方发的消息：我读过的部分单独放进 reads（见 applyReads 的注释） */
      if (m.id && m.readBy && m.readBy[me]) reads[m.id] = m.readBy[me]
    }
    out.whispers = w
    out.reads = reads
    /* ★ 下单提醒：和悄悄话同构 —— **我下的单**放自己这份，
       对方下的单我把"看过了"放进 orderReads（见 applyOrderReads 的注释）。 */
    var myOrders = []
    var orderReads = {}
    var ords = s.orders || []
    for (var oi = 0; oi < ords.length; oi++) {
      var o = ords[oi]
      if (!o) continue
      if (o.by === me) { myOrders.push(o); continue }
      if (o.id && o.readBy && o.readBy[me]) orderReads[o.id] = o.readBy[me]
    }
    out.orders = myOrders
    out.orderReads = orderReads
    /* ⚠️ ntfy topic 也要同步过去 —— 它得放在**两人都会带的**公共字段里
       （和 anniv 一样两边各带一份），不然对方那台收不到通知。 */
    out.pushTopic = s.pushTopic || ''
    out.moods = pickUidMap(s.moods, me)
    out.diaries = pickUidMap(s.diaries, me)
    out.anniv = s.anniv || null
    out.pet = s.pet || null
    out.periodSettings = s.periodSettings || null
    /* 例假是逐日记录、按天比时间合并，放自己这份里就行 */
    out.periodLog = s.periodLog || {}
    out.album = null        /* 相册有它自己的文件（照片大，不值得塞进这条通道） */
    return out
  }

  /**
   * 过渡期兼容：老的那个单文件也照旧写一份（**尽力而为**）。
   * 目的：还没升级的那台手机照样看得到我的新消息，不出现空窗期。
   * 失败不重试、不报错、不影响主流程 —— 主通道已经写成功了。
   */
  AppState.prototype._legacyPush = function () {
    var that = this
    if (!this.legacySync) return Promise.resolve({ ok: false, reason: 'NO_LEGACY' })
    /* 对方已经用上新格式了 → 不用再往老文件里写（省一次请求和一次加密） */
    if (this._peerSeen) return Promise.resolve({ ok: true, reason: 'PEER_UPGRADED' })
    return this.legacySync.pushWithMerge(this._corePayload(), function (p, remote) {
      if (remote) mergeIntoLocal(that.state, remote, { pushOff: that._pushOff })
      return that._corePayload()
    }).then(function (r) {
      that.status.legacyError = (r && r.ok) ? '' : '兼容通道没写成功（不影响使用）'
      if (r && r.ok) that.status.legacyPush = Date.now()
      return r
    }).catch(function (e) {
      that.status.legacyError = '兼容通道出错（不影响使用）'
      return { ok: false, error: String(e && e.message ? e.message : e) }
    })
  }

  /**
   * 本机存一份（**不含相册**，相册自己一个 key，见 albumCacheSave）。
   * 相册塞进这个 key 的话，几百 KB 的 dataURL 很容易把 5MB 配额撑爆 ——
   * 一旦撑爆，`_persist` 写失败，连心情/日记都一起存不下了。
   */
  /* ---------- 下单提醒（商城买完 → 对方收到） ---------- */

  /**
   * 下一单，并**顺手给对方发一条加急通知**。
   *
   * ⚠️ 顺序很重要：**先记录 + 上传，再发通知**。
   *    理由是通知里要带 order.id，而那个 id 要先落进同步层；
   *    反过来（先通知后记录）会出现"通知到了但订单不存在"的空指。
   *
   * ⚠️ 通知失败绝不报错 —— ntfy 只是加急通道，事实永远在同步层，
   *    对方下次拉取照样能看到这条提醒。只把真实结果写进 status.pushMsg 备查。
   *
   * @param {Array} goods  [{ id, name, count, price }]
   * @param {number} total 合计积分
   * @param {string} [note] 留言
   * @returns {Promise<{ok:boolean, order?:object, push?:object, reason?:string}>}
   */
  AppState.prototype.placeOrder = function (goods, total, note) {
    var that = this
    var r = Order.add(this.state, this.uid, goods, total, note)
    if (!r.ok) return Promise.resolve(r)
    this._persist()
    this._notify('order')
    if (this.autoPush) this._schedulePush()

    var order = r.order
    var topic = this.state.pushTopic || ''
    /* 没开推送（没 topic）→ 记录照样进了同步层，只是不发加急通知 */
    if (!topic) {
      this.status.pushMsg = '没开推送（设置里可以开）—— 提醒会在他/她下次打开时出现'
      return this.pushNow().then(function () {
        return { ok: true, order: order, push: { ok: false, error: 'NO_TOPIC' } }
      })
    }

    var body = Order.describe(order)
    return this.pushNow().then(function () {
      return Order.push({
        topic: topic,
        body: body,
        title: Order.PUSH_TITLE,
        priority: 4
      })
    }).then(function (pr) {
      that.status.pushMsg = pr.ok
        ? '已通知对方 📣'
        : ('通知没发出去（' + (pr.error || ('HTTP ' + pr.status)) + '）—— 数据已经同步，他/她打开就能看到')
      that._notify('order-push')
      return { ok: true, order: order, push: pr }
    })
  }

  /** 对方下的单（我要去做的事）；最近的排前面 */
  AppState.prototype.peerOrders = function () {
    return Order.fromPeer(this.state, this.uid).slice().reverse()
  }

  /** 我下的单 */
  AppState.prototype.myOrders = function () {
    return Order.mine(this.state, this.uid).slice().reverse()
  }

  /** 对方下的、我还没看的条数（首页红点用） */
  AppState.prototype.orderUnreadCount = function () {
    return Order.unreadCount(this.state, this.uid)
  }

  /** 把对方下的那些标成已读（打开首页/订单页时调） */
  AppState.prototype.markOrdersRead = function () {
    var r = Order.markRead(this.state, this.uid)
    if (r.count > 0) {
      this._persist()
      this._notify('order-read')
      if (this.autoPush) this._schedulePush()
    }
    return r
  }

  /** 兑现一单（**只有下单的人能标**） */
  AppState.prototype.markOrderDone = function (orderId) {
    var r = Order.markDone(this.state, this.uid, orderId)
    if (r.ok) {
      this._persist()
      this._notify('order-done')
      if (this.autoPush) this._schedulePush()
    }
    return r
  }

  /** 开/关推送：生成或使用一个专属 topic（32 位随机 = 密码） */
  AppState.prototype.enablePush = function (topic) {
    var t = String(topic || '').trim()
    if (!t) t = Order.newTopic()
    if (!Order.validTopic(t)) return { ok: false, error: 'BAD_TOPIC' }
    this.state.pushTopic = t
    this._pushOff = false          /* 主动开了 → 允许再次从对方那份合并回来 */
    this._persist()
    this._notify('push-topic')
    if (this.autoPush) this._schedulePush()
    return { ok: true, topic: t }
  }

  AppState.prototype.disablePush = function () {
    this.state.pushTopic = ''
    /* ★ 记住"是我主动关的"：否则下一次 pull 会把对方的 topic 合并回来，
       用户点了关闭却还在发通知（test-order-notify.js 第五节抓到的 bug）。 */
    this._pushOff = true
    this._persist()
    this._notify('push-topic')
    if (this.autoPush) this._schedulePush()
    return { ok: true }
  }

  AppState.prototype.pushTopic = function () { return this.state.pushTopic || '' }

  /**
   * 发一条测试通知 —— 给用户点「试一下」用。
   * 光看设置里有没有 topic 是不够的：他手机上的 ntfy App 到底订阅了没有、
   * 能不能弹出来，只有真发一条才知道。
   */
  AppState.prototype.testPush = function () {
    var topic = this.state.pushTopic || ''
    if (!topic) return Promise.resolve({ ok: false, error: 'NO_TOPIC' })
    return Order.push({
      topic: topic,
      title: Order.PUSH_TITLE,
      body: '这是一条测试通知。你在手机上看到它，就说明推送通了 🎉',
      priority: 4,
      tags: 'test_tube'
    })
  }

  AppState.prototype._persist = function () {
    try {
      lsSet(this.storageKey, JSON.stringify(this._corePayload()))
      if (this.status.error === '本机存不下（额度满）') this.status.error = ''
    } catch (e) {
      this.status.error = '本机存不下（额度满）'
    }
  }

  /* ---------- 相册专用 API（给 data/album.js 当读写钩子用） ---------- */

  /** 读整份相册（+ 删除墓碑）。给 album.js 的 readAll 用 */
  AppState.prototype.albumBlob = function () {
    if (!this.state.album) this.state.album = { v: 1, photos: [], deleted: {}, updatedAt: 0 }
    return this.state.album
  }

  /** 当前照片数组（按上传时间倒序，和 album.js 的 list() 一致） */
  AppState.prototype.albumPhotos = function () {
    var b = this.albumBlob()
    var arr = (b.photos || []).slice()
    arr.sort(function (a, c) { return (c.uploadedAt || 0) - (a.uploadedAt || 0) })
    return arr
  }

  /**
   * 整份写回（album.js 的 writeAll 走这里）。
   * 自动算出**新加的墓碑**：上一份里有、这一份里没有的 id = 被删掉的。
   * @returns {{ok:boolean}}
   */
  AppState.prototype.setAlbumPhotos = function (arr, at) {
    arr = (arr instanceof Array) ? arr : []
    var t = at || Date.now()
    var b = this.albumBlob()
    var prev = {}
    var i
    for (i = 0; i < (b.photos || []).length; i++) if (b.photos[i] && b.photos[i].id) prev[b.photos[i].id] = 1
    var nowIds = {}
    for (i = 0; i < arr.length; i++) if (arr[i] && arr[i].id) nowIds[arr[i].id] = 1

    var del = {}
    for (var k in (b.deleted || {})) {
      if (Object.prototype.hasOwnProperty.call(b.deleted, k)) del[k] = b.deleted[k]
    }
    for (var id in prev) {
      if (!Object.prototype.hasOwnProperty.call(prev, id)) continue
      if (!nowIds[id]) del[id] = t
    }
    /* 墓碑别无限长大：超过 400 条就把最老的清掉（那时候对方早就同步过了） */
    var keys = Object.keys(del)
    if (keys.length > 400) {
      keys.sort(function (x, y) { return del[x] - del[y] })
      for (i = 0; i < keys.length - 400; i++) delete del[keys[i]]
    }

    this.state.album = { v: 1, photos: arr, deleted: del, updatedAt: t }
    this._persist()          /* 只写 core（轻），相册自己走下面这个缓存 */
    albumCacheSave(this.state.album)
    this._notify('local')
    if (this.autoPush) {
      /* 万一刚打开还没来得及和云端对上（_albumRemoteOk=false），
         先拉一次 —— 不然这次上传会被闸门挡掉，照片就等于丢了 */
      if (!this._albumRemoteOk && this.albumSync) this.pullAlbumNow()
      this._scheduleAlbumPush()
    }
    return { ok: true, photos: arr.length }
  }

  /**
   * 相册同步用的信封。相册是**独立的一份**，core 里那一段永远是 null，
   * 所以这里只需要 plain 形态（参数保留是为了别处调用方便）。
   */
  AppState.prototype._albumEnvelope = function (plain) {
    var b = this.albumBlob()
    if (plain) {
      return { v: 1, album: { v: 1, photos: b.photos || [], deleted: b.deleted || {}, updatedAt: b.updatedAt || 0 } }
    }
    return this._corePayload()
  }

  /**
   * ★ 被锁挡下的那次相册上传（`_albumDirty`）必须有人接住 —— 否则照片**永久卡在本机**。
   *
   * 真机症状（2026-10-11，用户报的「共同相册看不到」的残留原因之一）：
   *   `pullAlbumNow()` 和 `pushAlbumNow()` **共用 `_albumBusy` 这一把锁**。
   *   配对/接入刚完成时 `ready()` 会去拉相册（几 MB，GitHub 上要好几秒），
   *   而用户这时拍了张照片 → 700ms 防抖 → `pushAlbumNow()` 撞上锁 → 返回 BUSY。
   *
   *   当时 BUSY 分支只写了一句 `this._albumDirty = true` 就 return 了，
   *   而**消化这个标记的代码只写在 push 自己的成功/失败分支末尾**（见下面 `.then` 里那句），
   *   BUSY 那条路直接 return，根本走不到那里；`pullAlbumNow()` 收尾时也没人看这个标记。
   *   于是：`_albumBusy=false`、`_albumDirty=true`、`status.album.pending=0`、
   *   云端一张照片都没有 —— 而且**一句错都不报**，用户只看到「我传了她看不到」。
   *   （用假 GitHub 复现：配对后第一次 push 返回 BUSY，云端 0 张，1.2 秒后仍是 0 张。）
   *
   * 这里是唯一的收尾入口：每次相册锁被释放后都调一次，把攒着的上传补上。
   */
  AppState.prototype._flushAlbumDirty = function () {
    if (!this._albumDirty) return false
    if (this._albumBusy) return false        /* 锁还被占着 → 占着的那个人收尾时会再调一次 */
    if (!this._albumRemoteOk) {
      /* 闸门关着（云端读不开 / 云端 ID 不对）→ 不能硬写，交给重试链：
         pull 一次（顺便把闸门重新判定）再 push。_retryAlbumLater 自己会去重。 */
      this._retryAlbumLater()
      return false
    }
    this._albumDirty = false
    this._scheduleAlbumPush()
    return true
  }

  /** 拉相册（只动 state.album，不碰别的字段） */
  AppState.prototype.pullAlbumNow = function () {
    var that = this
    if (!this.albumSync) return Promise.resolve({ ok: false, reason: 'NOT_CONFIGURED' })
    /* 卡死看门狗：和 core 的 25 秒同理。相册文件有好几 MB，手机上 fetch 卡住不返回
       很常见；一旦卡住 `_albumBusy` 永远是 true，之后**每一次**上传都返回 BUSY，
       照片再也上不去。这里超时就放锁重来。 */
    if (this._albumBusy && this._albumBusySince && Date.now() - this._albumBusySince > 25000) {
      this._albumBusy = false
      this._albumDirty = true
    }
    if (this._albumBusy) return Promise.resolve({ ok: false, reason: 'BUSY' })
    this._albumBusy = true
    this._albumBusySince = Date.now()
    return this.albumSync.pull().then(function (r) {
      that._albumBusy = false
      that._albumBusySince = 0
      that.status.album.lastPull = Date.now()
      if (!r.found) {
        that._lastAlbumPullReason = r.reason || ''
        /* ★ 和 core 一个道理：只有"云端真的还没有这个文件"才允许写。
           "找不到云端"(GONE) / "读不开"(UNREADABLE) 都必须保持闸门关闭 ——
           相册两台共用同一个文件，读不到就写 = 把对方的照片盖掉。 */
        if (r.reason === 'GONE' || r.reason === 'UNREADABLE' ||
          (r.reason === 'NO_GIST' && !that._creatingCloud)) {
          that._albumRemoteOk = false
          that.status.album.error = (r.reason === 'GONE')
            ? '云端 ID 不对（找不到这个云端），照片先不传'
            : (r.reason === 'NO_GIST'
              ? '这台手机没记住云端 ID，照片先不传（重新配一次就好）'
              : '云端相册那个文件打不开（太大或坏了），照片先不传')
          return { ok: false, found: false, reason: r.reason, error: that.status.album.error }
        }
        if (r.reason !== 'NO_SECRET') that._albumRemoteOk = true   /* 远端本来就空 → 可以写 */
        that.status.album.error = ''
        return { ok: true, found: false, reason: r.reason }
      }
      that._albumRemoteOk = true
      that._lastAlbumPullReason = ''
      var before = JSON.stringify(that.state.album)
      var remoteAlbum = (r.data && r.data.album) ? r.data.album : null
      if (remoteAlbum) that.state.album = mergeAlbum(that.state.album, remoteAlbum)
      that.status.album.photos = (that.state.album && that.state.album.photos || []).length
      that.status.album.error = ''
      var changed = JSON.stringify(that.state.album) !== before
      if (changed) {
        albumCacheSave(that.state.album)     /* 拉到就先存本机，下次打开立刻有 */
        that._notify('remote-album')
        that._albumRepaint()                 /* 相册页面立刻重画（不然像没同步） */
      }
      /* 之前因为"还没和云端对上"被挡下的上传，现在补上 */
      if (that.status.album.pending > 0 && that._albumRemoteOk) that._scheduleAlbumPush()
      return { ok: true, found: true, changed: changed }
    }).catch(function (e) {
      that._albumBusy = false
      that._albumBusySince = 0
      that._albumRemoteOk = false     /* ★ 解不开 → 不许写（和 core 一个道理） */
      that.status.album.error = String(e && e.message ? e.message : e)
      return { ok: false, error: that.status.album.error }
    }).then(function (r) {
      /* ★ 收尾：这把锁放开之后，把"被锁挡下的那次上传"补上（见 _flushAlbumDirty 的注释）。
         放在这里而不是每个 return 前面，是为了**任何一条返回路径**都不会漏掉 ——
         BUSY 那条路以前就是漏在这里，照片永久卡在本机且一句错都不报。 */
      that._flushAlbumDirty()
      return r
    })
  }

  /** 上传相册（单独一个文件；核心状态不在里面，不会被这次上传影响） */
  AppState.prototype.pushAlbumNow = function () {
    var that = this
    if (!this.albumSync) return Promise.resolve({ ok: false, reason: 'NOT_CONFIGURED' })
    if (!this._albumRemoteOk) {
      /* ★ 还没确认云端（刚打开那几秒 / 上次拉取失败）→ **必须重试**。
         以前这里直接放弃，照片就永远上不去了（用户报"对面看不到照片"）。
         ⚠️ 报哪句话要看上一次失败的真实原因：云端 ID 配错的时候，
            用户需要看到"ID 不对"，而不是一句让他干等重试的话。 */
      this.status.album.error = (this._lastAlbumPullReason || this._lastPullReason) === 'GONE'
        ? '云端 ID 不对（找不到这个云端），照片先不传'
        : ((this._lastAlbumPullReason || this._lastPullReason) === 'NO_GIST'
          ? '这台手机没记住云端 ID，照片先不传（重新配一次就好）'
          : ((this._lastAlbumPullReason || this._lastPullReason) === 'UNREADABLE'
            ? '云端相册那个文件打不开（太大或坏了），照片先不传'
            : '相册还没和云端对上，稍后自动重试'))
      /* ★ 用赋值、不用 `++`：这是个 0/1 的"报警"标志，累加会在每次重试时越滚越大
         （真机/探针都见过 pending 变成 2、3 —— 界面就说"还有 3 批照片没传上去"）。 */
      this.status.album.pending = 1
      this.status.album.inflight = 0
      if (!this._albumRetryTimer) {
        this._albumRetryTimer = setTimeout(function () {
          that._albumRetryTimer = null
          that.pullAlbumNow().then(function () {
            if (that.status.album.pending > 0) that.pushAlbumNow()
          })
        }, 5000)
      }
      return Promise.resolve({ ok: false, reason: 'REMOTE_UNREADABLE' })
    }
    if (this._albumBusy) {
      this._albumDirty = true
      /* ★ 这条是**提前返回**：不经过下面的收尾，所以 inflight 必须在这里自己清掉，
         否则界面上会永远显示"正在上传照片…"（假进度）。
         真正那次上传由 `_flushAlbumDirty()` 在锁放开后补上。 */
      this.status.album.inflight = 0
      return Promise.resolve({ ok: false, reason: 'BUSY' })
    }
    /* ★ 万一 core 刚建好云端，先把 id 接到相册这条通道上再写 ——
       不接的话相册会 POST 出**另一个** Gist（链接码里带的是 core 那个），
       于是两台手机的相册天生就在两个云端里，永远看不到对方的照片。 */
    this._adoptGistId()
    /* ⚠️ 只对 GitHub 模式生效：local（本机调试）本来就没有云端 ID，
       拿它当条件会把本机模式的相册一起挡死。 */
    if (this.cfg && this.cfg.provider === 'github' &&
      !this.albumSync.gistId && !this._creatingCloud) {
      this.status.album.error = '这台手机没记住云端 ID，照片先不传（重新配一次就好）'
      this.status.album.pending = 1         /* 真·传不上去（该报警） */
      this._retryAlbumLater()
      return Promise.resolve({ ok: false, reason: 'REMOTE_UNREADABLE' })
    }
    this._albumBusy = true
    this._albumBusySince = Date.now()
    this.status.album.inflight = 1
    var env = this._albumEnvelope(true)
    return this.albumSync.pushWithMerge(env, function (payload, remote) {
      if (remote && remote.album) {
        payload.album = mergeAlbum(payload.album, remote.album)
        that.state.album = mergeAlbum(that.state.album, remote.album)
      }
      return payload
    }).then(function (r) {
      that._albumBusy = false
      that._albumBusySince = 0
      that.status.album.inflight = 0
      if (r && r.ok) {
        that.status.album.pending = 0      /* 这次真传上去了 → 报警解除 */
        that.status.album.lastPush = Date.now()
        that.status.album.error = ''
        that.status.album.photos = (that.state.album && that.state.album.photos || []).length
        albumCacheSave(that.state.album)
        that._notify('push-album')
      } else if (r && r.conflict) {
        that.status.album.error = '对方也在传照片，稍后重试'
        that.status.album.pending = 1
        that._retryAlbumLater()
      } else if (r && r.gone) {
        /* ★ 写的时候 GitHub 说"没这个 Gist" → 云端 ID 配错了。
           以前它和"还没和云端对上"共用一句话，用户照着那句话怎么点都好不了。 */
        that.status.album.error = '云端 ID 不对（GitHub 找不到这个云端），照片先不传'
        that.status.album.pending = 1
        that._retryAlbumLater()
      } else if (r && r.reason === 'REMOTE_UNREADABLE') {
        that.status.album.error = '相册还没和云端对上，稍后自动重试'
        that.status.album.pending = 1
        that._retryAlbumLater()
      }
      if (that._albumDirty) { that._albumDirty = false; that._scheduleAlbumPush() }
      return r
    }).catch(function (e) {
      that._albumBusy = false
      that._albumBusySince = 0
      that.status.album.inflight = 0
      that.status.album.error = String(e && e.message ? e.message : e)
      that.status.album.pending = 1
      that._retryAlbumLater()
      return { ok: false, error: that.status.album.error }
    }).then(function (r) {
      /* ★ 兜底收尾：连 BUSY 之外的路也走这里，保证"被挡下的那次上传"一定有人接住 */
      that._flushAlbumDirty()
      return r
    })
  }

  /** 失败后隔一会儿再试一次（照片这种东西不能"试一次就算了"） */
  AppState.prototype._retryAlbumLater = function () {
    var that = this
    if (this._albumRetryTimer) return
    this._albumRetryTimer = setTimeout(function () {
      that._albumRetryTimer = null
      that.pullAlbumNow().then(function () { that.pushAlbumNow() })
    }, 8000)
  }

  /**
   * 安排一次相册上传（防抖：连拍几张只传一次）。
   *
   * ★ `pending` 以前被当成"排队的次数"在这里 `pending++`，于是**每一次正常上传**
   *   都会让设置页显示那句「还有 1 批照片没传上去，正在自动重试…」——
   *   照片其实传得好好的。用户 2026-10-11 报的「设置里永远挂着这句话」就是它。
   *   现在：排队/在传算 `inflight`（正常），只有**失败且等重试**才算 `pending`（该报警）。
   */
  AppState.prototype._scheduleAlbumPush = function () {
    var that = this
    /* 已经有排队中的上传了 → 只是把防抖时间往后挪，不重复计数（否则计数会漏） */
    if (this._albumPushTimer) clearTimeout(this._albumPushTimer)
    else this.status.album.inflight = 1
    this._albumPushTimer = setTimeout(function () {
      that._albumPushTimer = null
      that.status.album.inflight = 0
      that.pushAlbumNow()
    }, PUSH_DEBOUNCE_MS)
  }

  /** 挂在 data/album.js 上的两个钩子（见 album.js 的 setStore） */
  AppState.prototype.attachAlbum = function (A) {
    if (!A || !A.setStore) return false
    var that = this
    this._albumApi = A
    return A.setStore({
      readAll: function () { return that.albumPhotos() },
      writeAll: function (arr) { return that.setAlbumPhotos(arr) }
    })
  }

  /** 让相册页面重画（对方的照片拉回来之后必须调，否则页面看着像没同步） */
  AppState.prototype._albumRepaint = function () {
    try { if (this._albumApi && this._albumApi.refresh) this._albumApi.refresh() } catch (e) { /* ignore */ }
  }

  /* ---------- 同步 ---------- */

  /**
   * 连上以后先拉一次（可选再推一次）。
   *
   * ⚠️ 加了「同一时刻只跑一次」的闸：configure() 内部就会调一次 ready()，
   *    调用方（页面/测试）通常还会再 await 一次 —— 两次叠加时，第二次会在
   *    第一次还没收尾时进来，pullNow 的 BUSY 分支会让 _busy 永久卡在 true，
   *    之后所有上传都返回 BUSY（数据再也上不去）。实测踩到过，必须去重。
   */
  AppState.prototype.ready = function (alsoPush) {
    var that = this
    this._notify('ready')
    if (!this.sync) return Promise.resolve({ ok: true, mode: 'local-only' })
    if (this._readyPromise) return this._readyPromise
    this._readyPromise = this.pullNow().then(function (r) {
      /* ⚠️ 拉失败（多半是口令不一致）就**不要**再写：见 _remoteOk 的注释 */
      if (!r || !r.ok) return r
      /* 相册是另一个文件，单独拉一次（失败不影响 core；它自己会重试）。
         ★ 必须 **await** 这次拉取，不能像以前那样"发出去就不管"：
            相册和 core 共用 `_albumBusy` 这把锁，而下面 pushAlbumNow() 紧跟着就来。
            不 await 的话它**每次**都撞在锁上 → 返回 BUSY →（修复前）照片永久卡在本机。
            真机复现：配对后第一次 push 返回 BUSY、云端 0 张、过一会儿还是 0 张，
            用户看到的就是「我传了照片，她那边一张都没有」。 */
      return that.pullAlbumNow().catch(function () { /* 拉不到也继续，别挡后面的上传 */ })
        .then(function () {
          if (!alsoPush) return r
          return that.pushNow().then(function () {
            return that.pushAlbumNow().then(function () { return r })
          })
        })
    }).catch(function (e) {
      that._busy = false          /* 别把锁留在原地：卡住的话后面全传不上去 */
      that.status.error = String(e && e.message ? e.message : e)
      that.status.mode = 'error'
      that._notify('error')
      return { ok: false, error: that.status.error }
    }).then(function (r) {
      that._readyPromise = null
      return r
    })
    return this._readyPromise
  }

  /** 拉远端并合并进本地。用**自己的**锁（_pulling），不能占上传的锁 —— 见构造函数注释 */
  AppState.prototype.pullNow = function () {
    var that = this
    if (!this.sync) return Promise.resolve({ ok: false, reason: 'NOT_CONFIGURED' })
    /* 卡死看门狗：上一次拉取如果 25 秒还没回来（网络请求卡住不返回），就放锁重试 */
    if (this._pulling && this._pullingSince && Date.now() - this._pullingSince > 25000) {
      this._pulling = false
    }
    if (this._pulling) return Promise.resolve({ ok: false, reason: 'BUSY' })
    this._pulling = true
    this._pullingSince = Date.now()
    return this.sync.pull().then(function (r) {
      that._pulling = false
      that.status.lastPull = Date.now()
      if (!r.found) {
        that._lastPullReason = r.reason || ''
        if (r.reason === 'NO_SECRET') {
          that.status.mode = 'local-only'
          that.status.configured = false
        } else if (r.reason === 'GONE') {
          /* ★ 云端**不存在**（不是"空的"）→ 绝不当作"可以写"。
             这一条以前缺失，于是配错云端 ID 的机器会亮假绿灯、然后每一次写都静默失败。 */
          that._remoteOk = false
          that.status.mode = 'error'
          that.status.error = REMOTE_GONE_MSG
          that._notify('error')
          return { ok: false, error: that.status.error, reason: 'GONE' }
        } else if (r.reason === 'NO_GIST' && !that._creatingCloud) {
          /* ★ 配置里没有云端 ID，而且**这一次不是**"我是第一个" → 绝不新建云端。
             旧版本在这里 POST 出一个新 Gist，用户每重开一次页面就多一个云端，
             而对方还在老云端里等（真机症状：接上了、体检绿、但什么都看不到）。 */
          that._remoteOk = false
          that.status.mode = 'error'
          that.status.error = NO_GIST_MSG
          that._notify('error')
          return { ok: false, error: that.status.error, reason: 'NO_GIST' }
        } else if (r.reason === 'UNREADABLE') {
          /* 文件在、但内容读不出来（超大被 GitHub 截断之类）→ 也不能写，
             否则会拿本机这份把对方的数据盖掉。 */
          that._remoteOk = false
          that.status.mode = 'error'
          that.status.error = '云端那个文件打不开（太大或坏了）→ 先不上传，免得把对方的数据覆盖掉'
          that._notify('error')
          return { ok: false, error: that.status.error, reason: 'UNREADABLE' }
        } else {
          /* 远端本来就是空的（第一次用）→ 可以安全写 */
          that._remoteOk = true
        }
        that.status.error = ''
        that._notify('pull')
        return { ok: true, found: false, reason: r.reason }
      }
      /* ★ 解开了 → 说明口令是对的，这才允许写 */
      that._remoteOk = true
      that._lastPullReason = ''
      var before = JSON.stringify(that.state)
      mergeIntoLocal(that.state, r.data, { pushOff: that._pushOff })
      var changed = JSON.stringify(that.state) !== before
      if (changed) {
        that._persist()
        that._notify('remote')
      }
      that.status.error = ''
      if (that.status.mode === 'error') that.status.mode = 'synced'
      /* 拉之前如果因为"还没确认云端"或被跳过而压着没上传，现在补上 */
      if (that._dirty || that.status.pending > 0) that._pushSoon()
      return { ok: true, found: true, changed: changed }
    }).then(function (mine) {
      /* ★ 「一人一个文件」：我这份读完了，再读对方的 + 过渡期的老文件。
         读不到**不算错**（对方还没升级时那两个文件本来就没有 / 是空的），
         所以这里的失败只记一笔，绝不影响上面那份的结果。 */
      return that._pullPeers().then(function (peerChanged) {
        /* changed 要算上对方那份 —— 否则调用方（和测试）会以为"什么都没拉到" */
        if (mine && peerChanged) mine.changed = true
        return mine
      })
    }).catch(function (e) {
      that._pulling = false
      /* ★ 解不开 → 关掉写入闸门，否则会拿错口令把对方的数据覆盖成谁也读不了 */
      that._remoteOk = false
      var raw = String(e && e.message ? e.message : e)
      /* 解不开云端数据，最常见的原因就是「两台都点了我是第一个」：
         各自生成了自己的口令和自己的 Gist，谁也读不懂谁。
         只丢一句技术错误用户不知道点哪里，所以这里直接给出修法。 */
      that.status.error = /解不开|decrypt|口令|passphrase|OperationError|operation/i.test(raw)
        ? '云端口令和这台手机不一样（多半是两台都点了「我是第一个」）。修法：这台点「清除这台手机的配对」，再用对方那台的链接码配一次'
        : raw
      that.status.mode = 'error'
      that._notify('error')
      return { ok: false, error: that.status.error }
    })
  }

  /**
   * 上传本地状态。
   * ⚠️ 走 pushWithMerge：写之前先比远端版本，发现对方写过就先 pull + merge 再写。
   *    只靠 GitHub 的 409 不行 —— 它是偶发的（实测过，见 sync-store.js）。
   *
   * ⚠️⚠️ 上传的是 `_corePayload()`（**相册那一段是 null**），不是 this.state 本身。
   *    以前直接传 this.state，里面含着相册照片，于是每改一次心情/发一条悄悄话
   *    都要把整本相册重新上传一遍，几 MB 直接写不进去 —— 连 core 都发不出去，
   *    表现就是"心情、日记、悄悄话两台手机互相看不到"（2026-10-11 用户报的）。
   */
  /**
   * ★★ 把"新建 Gist 拿到的 id"落下来：写回本机配置 + 同步给另外三个 Sync 实例。
   *
   * 不这么做的后果（真机踩了整整一天，2026-10-11）：
   *   「我是第一个」建 Gist 走的是 `GithubProvider.put()` 里 `!this.gistId` → POST /gists，
   *   `Sync.push()` 只把新 id 记在**它自己这个实例**上。AppState 从来没写回配置。
   *   于是**一重开页面**（配置里 gistId 还是空）：
   *     读云端 = "还没数据" → 闸门又打开 → 下一次写入**又 POST 一个新 Gist**。
   *   用户手机上就这样攒了一串云端；而他发给对方的链接码指的是**最早那个、早已不再写入**的云端
   *   → 两个人从此各写各的，永远看不到对方（纪念日、相册全断）。
   *   相册更惨：`albumSync` 的 gistId 也是空 → 它 POST 出**另一个** Gist，
   *   而链接码里带的是 core 那个 → **两台手机的相册天生就在两个不同的云端里**。
   *
   * @returns {string} 落下来的 gistId（没有就返回空串）
   */
  AppState.prototype._adoptGistId = function () {
    var g = (this.sync && this.sync.gistId) || ''
    if (!g) return ''
    if (this.cfg) this.cfg.gistId = g
    /* ⚠️ 每个 Sync 实例身上有**两份** gistId：Sync 自己一份（给界面看），
       provider 一份（真正发请求用的是它）。少改一份，那条通道就会 POST 出另一个 Gist。 */
    function pointTo(s) {
      if (!s) return
      s.gistId = g
      if (s.provider) s.provider.gistId = g
    }
    pointTo(this.albumSync)
    pointTo(this.legacySync)
    pointTo(this.peerSync)
    try {
      CoupleSync.saveConfig(this.profile, {
        provider: (this.cfg && this.cfg.provider) || 'github',
        passphrase: (this.cfg && this.cfg.passphrase) || '',
        salt: (this.cfg && this.cfg.salt) || '',
        token: (this.cfg && this.cfg.token) || '',
        gistId: g
      })
    } catch (e) { /* 存不下也不影响这一次（内存里已经是对的） */ }
    this._creatingCloud = false
    return g
  }

  AppState.prototype.pushNow = function () {
    var that = this
    if (!this.sync) return Promise.resolve({ ok: false, reason: 'NOT_CONFIGURED' })
    if (!this._remoteOk) {
      /* ★ 没见过 / 解不开云端数据，绝不写（见 _remoteOk 的注释）。
         报哪句话要看**上一次拉取失败的真实原因**：
         "找不到云端"（配错 ID）和"口令不对"是两种完全不同的病，
         以前一律说"口令还没对上"，用户照着修永远修不好。 */
      this.status.error = (this._lastPullReason === 'GONE')
        ? REMOTE_GONE_MSG
        : (this._lastPullReason === 'NO_GIST'
          ? NO_GIST_MSG
          : (this._lastPullReason === 'UNREADABLE'
            ? '云端那个文件打不开（太大或坏了）→ 已暂停上传，免得把对方的数据覆盖掉'
            : '云端口令还没对上一台（多半是两台都点了「我是第一个」），已暂停上传以免覆盖对方的数据'))
      this.status.mode = 'error'
      this._notify('error')
      return Promise.resolve({ ok: false, reason: 'REMOTE_UNREADABLE', lastReason: this._lastPullReason })
    }
    if (this._busy) {
      /* ⚠️ 卡死看门狗：上一次上传如果 25 秒还没回来（fetch 卡住不返回、
         手机上很常见），_busy 会永远停在 true —— 之后**每一次**上传都直接
         返回 BUSY，数据再也上不去（对方永远收不到）。这里放锁重来。 */
      if (this._busySince && Date.now() - this._busySince > 25000) {
        this._busy = false
        this.status.error = '上一次上传卡住了（网络没回应），已自动重试'
      } else {
        this._drityAgain = true
        this._dirty = true
        this._retryCoreLater()      /* ★ 被跳过就一定要补传，不能就这样丢了 */
        return Promise.resolve({ ok: false, reason: 'BUSY' })
      }
    }
    this._busy = true
    this._busySince = Date.now()
    this.status.pending = 0
    /* ★ 只传"我自己写的"那一份（couple-a / couple-b），见 _mySlice 的注释。
       我这个文件只有我在写 → 撞车从设计上就不存在了。 */
    var payload = this._mySlice()
    return this.sync.pushWithMerge(payload, function (p, remote) {
      /* 极端情况（这台重装过 / 同一身份有多台设备）：远端我这个文件里还有东西，
         先并进本地再重生成一份 —— 也不会碰到对方的数据。 */
      if (remote) mergeIntoLocal(that.state, remote, { pushOff: that._pushOff })
      return that._mySlice()
    }).then(function (r) {
      that._busy = false
      if (r && r.ok) {
        that._dirty = false
        /* ★★ 先把它落下来，再做后面的事：老的单文件的 `_legacyPush()`、
           相册的 `pushAlbumNow()` 都要用这个 id —— 不落下来它们会各自 POST
           出**另一个** Gist，链接码又只带 core 那个（相册永远对不上就是这么来的）。 */
        that._adoptGistId()
        that.status.lastPush = Date.now()
        that.status.error = ''
        if (that.status.mode === 'error') that.status.mode = 'synced'
        /* 合并过程可能带回了对方的数据 → 本地也变了，要持久化 + 通知 */
        that._persist()
        that._notify(r.merged ? 'remote' : 'push')
        that._albumRepaint()
        /* 过渡期兼容：老的单文件也写一份（尽力而为，失败不影响上面） */
        that._legacyPush()
        /* ★ 推完顺手把对方的并进来：刚发完消息的人应该马上看到对方的东西
           （以前靠"写之前必须先合并"顺带做到，现在各写各的文件，要显式补这一步） */
        return that._pullPeers().then(function () {
          if (that._drityAgain) {
            that._drityAgain = false
            that._schedulePush()
          }
          return r
        })
      } else if (r && r.conflict) {
        /* ★ 撞车（两个人几乎同时写）→ **必须重试**，不能就这么算了。
           原来的写法只留一句提示、不上传，那条悄悄话/心情就等于丢了
           （用户 2026-10-11 报的"我发她收不到"很可能就是撞在这一步）。 */
        that.status.error = '对方也在写，正在重试…'
        that.status.pending++
        that._retryCoreLater()
      } else if (r && r.gone) {
        /* ★ 写的时候 GitHub 说"没这个 Gist" → 云端 ID 配错了。
           以前这里**什么都不写**（status.error 一直是空字符串），用户完全看不出问题。 */
        that.status.mode = 'error'
        that.status.error = REMOTE_GONE_MSG
        that._notify('error')
      }
      if (that._drityAgain) {
        that._drityAgain = false
        that._schedulePush()
      }
      return r
    }).catch(function (e) {
      that._busy = false
      that.status.error = String(e && e.message ? e.message : e)
      that.status.mode = 'error'
      that._notify('error')
      return { ok: false, error: that.status.error }
    })
  }

  /** 撞车 / 被跳过之后隔一会儿重试（间隔带点随机，免得两台永远同时撞） */
  AppState.prototype._retryCoreLater = function () {
    var that = this
    if (this._coreRetryTimer) return
    var wait = 1500 + Math.floor(Math.random() * 2500)
    this._coreRetryTimer = setTimeout(function () {
      that._coreRetryTimer = null
      /* ★ 条件是"还有没传上去的东西"，不是 pending 计数：
         被 BUSY 跳过的那次不算 conflict，pending 是 0，但 _dirty 是 true。
         只看 pending 的话这种跳过就永远不补传了（原来就是这么丢的）。 */
      if (that._dirty || that.status.pending > 0) that.pushNow()
    }, wait)
  }

  AppState.prototype._pushSoon = function () {
    var that = this
    if (this._pushTimer) clearTimeout(this._pushTimer)
    this._pushTimer = setTimeout(function () {
      that._pushTimer = null
      that.pushNow()
    }, PUSH_DEBOUNCE_MS)
  }

  AppState.prototype._schedulePush = function () {
    this.status.pending++
    this._pushSoon()
  }

  /* ---------- 轮询 ---------- */

  /**
   * 开始轮询。
   * ⚠️ 页面隐藏时不轮询，回到前台立刻拉一次 ——
   *    GitHub 免费额度是 5000 次/小时，无脑轮询会打满。
   */
  AppState.prototype.startPolling = function () {
    var that = this
    if (!this.sync || this._timer) return
    /* core 每一次；相册**每第 3 次**（照片变化慢、payload 大，没必要那么勤） */
    var tick = 0
    this._timer = setInterval(function () {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      /* ★ 每一轮先看门狗：网络请求卡住会把锁永久留在 true，那样之后什么都不会再发生
         （不报错、界面上也看不出来）。这两台手机里只要有一台中过，就会一直"收不到/发不出"。 */
      var now = Date.now()
      if (that._busy && that._busySince && now - that._busySince > 25000) {
        that._busy = false
        that._busySince = 0
        that.status.error = '上一次上传卡住了（网络没回应），已自动重试'
      }
      if (that._pulling && that._pullingSince && now - that._pullingSince > 25000) that._pulling = false
      if (that._dirty) that.pushNow()      /* 还有没传上去的 → 补传 */
      that.pullNow()
      tick++
      if (that.albumSync && tick % 3 === 0) that.pullAlbumNow()
    }, this.pollMs)

    if (typeof document !== 'undefined' && !this._visHandler) {
      this._visHandler = function () {
        if (document.visibilityState === 'visible') {
          that.pullNow()
          if (that.albumSync) that.pullAlbumNow()
        }
      }
      document.addEventListener('visibilitychange', this._visHandler)
    }
  }

  AppState.prototype.stopPolling = function () {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    if (this._visHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visHandler)
      this._visHandler = null
    }
  }

  /** 对话页打开时用它调快轮询（5 秒），离开恢复 20 秒 */
  AppState.prototype.setFastPoll = function (on) {
    var want = on ? FAST_POLL_MS : DEFAULT_POLL_MS
    if (this._fast === !!on && this.pollMs === want) return
    this._fast = !!on
    this.pollMs = want
    if (this._timer) { clearInterval(this._timer); this._timer = null; this.startPolling() }
  }

  AppState.prototype.dispose = function () {
    this.stopPolling()
    if (this._pushTimer) { clearTimeout(this._pushTimer); this._pushTimer = null }
    if (this._albumPushTimer) { clearTimeout(this._albumPushTimer); this._albumPushTimer = null }
    if (this._albumRetryTimer) { clearTimeout(this._albumRetryTimer); this._albumRetryTimer = null }
    if (this._coreRetryTimer) { clearTimeout(this._coreRetryTimer); this._coreRetryTimer = null }
    this.listeners = []
  }

  /**
   * 给「设置 → 同步」用的自检信息：两台手机这个 ID 必须**一样**，
   * 不一样就说明两台各连了各自的云端（口令指纹一样也没用，还是互相看不到）。
   */
  AppState.prototype.gistIdOf = function (which) {
    if (which === 'album') {
      if (!this.albumSync) return ''
      return this.albumSync.gistId || (this.cfg && this.cfg.gistId) || ''
    }
    if (!this.sync) return ''
    return this.sync.gistId || (this.cfg && this.cfg.gistId) || ''
  }

  /** 一句话说清楚"现在到底通不通"（设置页直接用） */
  AppState.prototype.syncSummary = function () {
    var s = this.status
    var parts = []
    if (!s.configured) return '还没配对（数据只在你这台手机上）'
    parts.push(s.provider === 'github' ? 'GitHub 私有 Gist' : '本机两个窗口')
    var gid = this.gistIdOf()
    parts.push(gid ? '云端ID ' + gid.slice(0, 8) : '云端ID 未知')
    if (s.error) parts.push('⚠️ ' + s.error)
    else if (s.lastPush || s.lastPull) parts.push('正常')
    else parts.push('还没同步过')
    var a = s.album || {}
    parts.push('相册 ' + ((a.photos || 0)) + ' 张' + (a.error ? '（⚠️ ' + a.error + '）' : ''))
    return parts.join(' · ')
  }

  /** 一条数组里有多少条是"对方写的" */
  function countTheirs(arr, keyOf, myUid) {
    var all = arr || []
    var theirs = 0
    for (var i = 0; i < all.length; i++) {
      try { if (keyOf(all[i]) !== myUid) theirs++ } catch (e) { /* ignore */ }
    }
    return { total: all.length, theirs: theirs }
  }

  /**
   * 心情/日记是**两层**结构：{ '2026-05-20': { A: {...}, B: {...} } }
   * （不是数组！按数组数会得到 undefined —— 体检报告里就出现过"心情 undefined 条"）
   */
  function countMoodMap(map, myUid) {
    var total = 0
    var theirs = 0
    var days = map || {}
    for (var d in days) {
      if (!Object.prototype.hasOwnProperty.call(days, d)) continue
      var byUid = days[d] || {}
      for (var u in byUid) {
        if (!Object.prototype.hasOwnProperty.call(byUid, u)) continue
        total++
        if (u !== myUid) theirs++
      }
    }
    return { total: total, theirs: theirs, days: Object.keys(days).length }
  }

  /**
   * ★ 强制上传一把，并把**每一步的真实结果**原样报出来。
   *
   * 为什么单独做这个（用户 2026-10-11："有没有别的办法，他的版本号那些都是正确的"）：
   *   两台手机版本一致、云端ID一致、对方能看到我的数据，但我这边云端里**一条对方的都没有**。
   *   这时候最需要的是**让对面那台手机开口说话**：到底是网络、token、口令，还是被安全闸拦住。
   *   普通上传失败时只写一句 status.error（用户不翻设置根本看不到），
   *   这个函数把全过程写成一段人话返回，让对方截个图就行。
   */
  AppState.prototype.forcePush = function () {
    var that = this
    var out = []
    if (!this.sync) {
      return Promise.resolve('这台手机还没配对（没有云端配置），所以什么都传不上去。\n' +
        '去「设置 → 同步」配一下。')
    }
    var gid = (this.gistIdOf() || '')
    out.push('身份 ' + this.uid + ' · 云端ID ' + (gid ? gid.slice(0, 8) : '未知') +
      ' · 版本 ' + ((typeof window !== 'undefined' && window.APP_BUILD) ? window.APP_BUILD : '?'))
    /* 先把卡死的锁放开，不然只会得到一句 BUSY，什么也说明不了 */
    if (this._busy) { this._busy = false; out.push('· 之前有一次上传卡住了，已强制放开') }
    if (this._pulling) { this._pulling = false; out.push('· 之前有一次拉取卡住了，已强制放开') }
    this._dirty = true
    var pre = this._mySlice()
    out.push('要传上去的（我这一份）：悄悄话 ' + ((pre.whispers || []).length) + ' 条、心情 ' +
      (function () {
        var n = 0
        var m = pre.moods || {}
        for (var d in m) if (Object.prototype.hasOwnProperty.call(m, d)) n += Object.keys(m[d] || {}).length
        return n
      })() + ' 条、纪念日 ' + ((pre.anniv && pre.anniv.startKey) ? pre.anniv.startKey : '（本机没有）'))

    /* 第一步：确认能读云端（读不了就不写，避免把对方的数据覆盖掉）。
       现在云端有好几个文件，能读到**任何一个**都说明口令是对的。 */
    var readOne = function (src, label) {
      return src.pull().then(function (r) {
        if (!r || !r.found) return { ok: true, found: false, label: label }
        if (r.data) {
          try { mergeIntoLocal(that.state, r.data, { pushOff: that._pushOff }) } catch (e) { /* ignore */ }
        }
        return { ok: true, found: true, label: label, data: r.data || {} }
      }).catch(function (e) {
        return { ok: false, found: false, label: label, err: String(e && e.message ? e.message : e) }
      })
    }
    var sources = [{ sync: this.sync, label: '我这台的文件' }]
    var peers = this._peerSources()
    for (var si = 0; si < peers.length; si++) sources.push({ sync: peers[si].sync, label: peers[si].name })

    return Promise.all(sources.map(function (s) { return readOne(s.sync, s.label) })).then(function (rs) {
      var readable = 0
      var mineRead = null
      for (var i = 0; i < rs.length; i++) {
        if (rs[i].ok && rs[i].found) readable++
        if (i === 0) mineRead = rs[i]
        if (!rs[i].ok) out.push('· ' + rs[i].label + ' 读不到（' + rs[i].err + '）')
        else if (!rs[i].found) out.push('· ' + rs[i].label + ' 在云端还没有')
        else {
          var ws2 = (rs[i].data && rs[i].data.whispers) || []
          var th = 0
          for (var j = 0; j < ws2.length; j++) if (ws2[j].by !== that.uid) th++
          out.push('· ' + rs[i].label + ' 读到了：悄悄话 ' + ws2.length + ' 条（对方的 ' + th + ' 条）')
        }
      }
      if (!readable && mineRead && !mineRead.ok) {
        out.push('✗ 云端一个文件都读不开：' + (mineRead.err || ''))
        return out.join('\n')
      }
      out.push('✓ 口令是对的（云端能读开）')
      that._remoteOk = true
      that._persist()
      var myPayload = that._mySlice()
      return that.sync.pushWithMerge(myPayload, function (p, remote) {
        if (remote) mergeIntoLocal(that.state, remote, { pushOff: that._pushOff })
        return that._mySlice()
      }).then(function (pr) {
        if (pr && pr.ok) {
          that._dirty = false
          that.status.lastPush = Date.now()
          that.status.error = ''
          out.push('✓ 上传成功（我这一份）')
          that._legacyPush()
        } else if (pr && pr.conflict) {
          out.push('✗ 上传失败：撞车了（试了几次都没写进去）。等一会儿再点一次。')
        } else if (pr && pr.gone) {
          out.push('✗ 上传失败：云端的这个文件不见了（被删了？）→ 需要重新配对')
        } else {
          out.push('✗ 上传失败：' + JSON.stringify(pr))
        }
        return that.pullAlbumNow().then(function () {
          return that.pushAlbumNow().then(function (ar) {
            out.push('相册：' + ((ar && ar.ok) ? '✓ 也传上去了' :
              '✗ 没传上去（' + ((ar && (ar.reason || ar.error)) || '未知') + '）') +
              '，本机共 ' + that.albumPhotos().length + ' 张')
            out.push('结论：' + ((pr && pr.ok) ? '这台手机上传是通的 —— 那就是对方那台传不上去。'
              : '**这台手机自己就传不上去**，上面那句就是原因。'))
            return out.join('\n')
          })
        })
      })
    }).catch(function (e) {
      out.push('✗ 读/写云端出错：' + (e && e.message ? e.message : String(e)))
      out.push('结论：**这台手机连不上云端或解不开** —— 上面那句就是原因。')
      return out.join('\n')
    })
  }

  /**
   * ★ 同步体检：把"到底断在哪一段"用大白话讲清楚。
   *
   * 关键的一问是：**云端那份里，有没有对方写的东西**。
   *   · 云端有对方的数据，但我这边看不到 → 问题在本机（合并/显示）
   *   · 云端压根没有对方的数据         → 问题在对面手机（没传上去）
   * 不看这个就只能瞎猜。用户 2026-10-11 报"我看不到她的"时就是靠它定的向。
   */
  AppState.prototype.diagnose = function () {
    var that = this
    var out = []
    if (!this.sync) {
      return Promise.resolve('还没配对 —— 数据只在这台手机上。\n' +
        '去「设置 → 同步」配一下：一台点「我是第一个」，另一台粘贴链接码。')
    }
    var fmt = function (c) { return c.total + ' 条（其中对方的 ' + c.theirs + ' 条）' }
    out.push('版本 ' + ((typeof window !== 'undefined' && window.APP_BUILD) ? window.APP_BUILD : '?'))
    out.push('我 ' + this.uid + ' · 云端ID ' + ((this.gistIdOf() || '').slice(0, 8) || '未知'))
    /* 写入闸门的状态：如果一直"还没成功读到过云端"，那这台手机**一律不许写** ——
       界面上只有一个红字提示，用户不翻设置看不到，所以体检必须把它写出来。 */
    out.push('写入闸门：' + (this._remoteOk
      ? '已确认云端（可以写）'
      : '⚠️ 还没成功读到过云端 → **这台手机现在什么都不许上传**（防止把对方数据覆盖掉）') +
      (this._busy ? ' · ⚠️ 上传锁卡着' : '') +
      (this._pulling ? ' · 正在拉取' : ''))
    var localW = countTheirs(this.state.whispers, function (w) { return w.by }, this.uid)
    var localM = countMoodMap(this.state.moods, this.uid)
    out.push('本机：悄悄话 ' + fmt(localW) + '；心情 ' + fmt(localM))
    out.push('文件：我这台 ' + (this.sync && this.sync.providerName ? coreFileFor(splitUid(this.uid) || 'x') : '—') +
      '；对方那台 ' + (this._peerSeen ? '已经用上新格式了 ✓' : '还没看到（对方可能还在旧版本）'))

    return Promise.all(function () {
      /* ★ 「一人一个文件」之后，云端不是一个文件了：
         我这份、对方那份、过渡期的老文件 —— 体检必须**全都读一遍**再统计，
         只看我这一个文件的话永远只会看到"没有对方的数据"（那是假的）。 */
      var srcs = [{ sync: that.sync, label: '我的文件' }]
      var peers = that._peerSources()
      for (var i = 0; i < peers.length; i++) srcs.push({ sync: peers[i].sync, label: peers[i].name })
      return srcs.map(function (s) {
        return s.sync.pull().then(function (r) { return { label: s.label, r: r } })
          .catch(function (e) {
            return { label: s.label, r: null, err: String(e && e.message ? e.message : e) }
          })
      })
    }()).then(function (list) {
      var cloudW = { total: 0, theirs: 0 }
      var cloudM = { total: 0, theirs: 0 }
      var cloudAnniv = '无'
      var annivAt = -1
      var anyFound = false
      var noSecret = false
      var gone = []
      for (var i = 0; i < list.length; i++) {
        var it = list[i]
        var r = it.r
        if (r && r.reason === 'NO_SECRET') noSecret = true
        if (!r || !r.found) { gone.push(it.label); continue }
        anyFound = true
        var d = r.data || {}
        var w = countTheirs(d.whispers, function (x) { return x.by }, that.uid)
        var m = countMoodMap(d.moods, that.uid)
        cloudW.total += w.total; cloudW.theirs += w.theirs
        cloudM.total += m.total; cloudM.theirs += m.theirs
        if (d.anniv && d.anniv.startKey && (d.anniv.updatedAt || 0) > annivAt) {
          annivAt = d.anniv.updatedAt || 0
          cloudAnniv = d.anniv.startKey + '（' +
            (d.anniv.updatedBy === that.uid ? '我改的' : '对方改的') + '）'
        }
        /* ★ 既然已经读到云端了，顺手把对方的东西并进本机 ——
           这样"体检"不只是看看，还顺手把界面刷对了。 */
        try {
          if (mergeIntoLocal(that.state, d, { pushOff: that._pushOff })) {
            that._persist()
            that._notify('remote')
          }
        } catch (e) { /* 并失败不影响报告 */ }
      }
      if (!anyFound) {
        out.push('云端：' + (noSecret ? '⚠️ 口令没配好' : '还没有数据'))
      } else {
        out.push('云端：悄悄话 ' + fmt(cloudW) + '；心情 ' + fmt(cloudM))
        out.push('云端纪念日：' + cloudAnniv)
        if (gone.length) out.push('（云端上还没有的：' + gone.join('、') + '）')
      }
      var afterW = countTheirs(that.state.whispers, function (w) { return w.by }, that.uid)
      var afterM = countMoodMap(that.state.moods, that.uid)
      if (afterW.theirs > localW.theirs || afterM.theirs > localM.theirs) {
        out.push('刚拉下来：悄悄话 +' + (afterW.theirs - localW.theirs) +
          ' 条、心情 +' + (afterM.theirs - localM.theirs) + ' 条（界面应该已经更新了）')
      }
      return that.pullAlbumNow().then(function () {
        var alb = that.status.album || {}
        out.push('相册：本机 ' + that.albumPhotos().length + ' 张' +
          (alb.error ? '；⚠️ ' + alb.error : '；上传/拉取正常'))
        /* ---- 结论 ---- */
        var verdict
        if (cloudW.theirs > 0 || cloudM.theirs > 0) {
          verdict = '云端**有**对方的数据 → 对方那边是好的（她传上来了）。' +
            ((afterW.theirs > 0 || afterM.theirs > 0)
              ? '本机也收到了，两边通道是通的。'
              : '但本机一条都没收到 → 这台机器的解密/合并有问题，把这页截图发我。')
        } else if (!anyFound) {
          verdict = '云端还是空的 → 两台都没成功上传过。' +
            (that.status.error ? '本机上传报错：' + that.status.error + '。' : '') +
            '也可能两台各自连了不同的云端 —— 核对上面的「云端ID」两台是否相同。'
        } else if (cloudW.theirs === 0 && cloudM.theirs === 0 &&
                   (afterW.theirs > 0 || afterM.theirs > 0 || that._dirty)) {
          verdict = '云端现在只有我自己的东西，但本机有对方的（或本机还有没传上去的）→ ' +
            '正在双向补传。等 20 秒再点一次体检；如果一直这样，让对方在自己手机上点「⬆️ 强制上传」并截图。'
        } else {
          verdict = '云端**没有**对方的数据 → 是对方手机没传上来（不是你这台的问题）。' +
            '让**对方在自己手机上**点「⬆️ 强制上传」，它会直接说出为什么传不上去，截图发你。'
        }
        out.push('结论：' + verdict)
        return out.join('\n')
      })
    }).catch(function (e) {
      out.push('读云端出错：' + (e && e.message ? e.message : e))
      return out.join('\n')
    })
  }

  var api = {
    AppState: AppState,
    emptyState: emptyState,
    mergeIntoLocal: mergeIntoLocal,
    DEFAULT_POLL_MS: DEFAULT_POLL_MS,
    FAST_POLL_MS: FAST_POLL_MS,
    PUSH_DEBOUNCE_MS: PUSH_DEBOUNCE_MS
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  /* ⚠️ 用 window 判断，不要用 root：Node 里顶层 this 是 module.exports 而不是 global。 */
  if (typeof window !== 'undefined') window.AppState = api
})(typeof self !== 'undefined' ? self : this)
