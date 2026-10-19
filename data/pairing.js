/**
 * 配对链接码（免输密码的核心）
 * ============================================================
 * 要解决的问题：两个人要在两台设备上用**同一个口令**做端到端加密，
 *   但「手抄一个口令、还要抄对」体验很差，而且口令不该明文发在微信里。
 *
 * 做法：生成一段**一次性链接码**，里面装好「口令 + 盐 + Gist 地址」，
 *   用链接码自带的密钥加密。你把它发给她，她粘一次 —— 之后两边都免输。
 *
 * 链接码结构：
 *   CPL1.<code>.<payload>
 *     code    = 随机 16 字节 → 链接密钥 = SHA-256('couple-link-v1:' + code)
 *     payload = E2E.encrypt({passphrase, salt, provider…}, 链接密钥)
 *
 * ⚠️ 为什么用 SHA-256(code) 当密钥而不是直接拿 code 当密钥：
 *    code 是 base64 文本，直接当口令喂给 PBKDF2 也能用，但
 *    **随机码的熵已经足够（128 位），不需要慢哈希**；
 *    用 SHA-256 是把「文本」规整成固定长度密钥，避免编码差异导致两端算出不同结果。
 *    这里防的不是暴力破解（随机码猜不出来），而是**编码不一致**。
 *
 * ⚠️ 安全性说明（诚实交代）：
 *    链接码本身**不额外保护口令**——拿到链接码的人就能解出口令。
 *    所以链接码要当成「邀请函」对待：发给自己人，用完就作废。
 *    这和「发一个临时密码」是同一级别的安全性，但好在：
 *    口令不在聊天里出现明文，而且链接码是随机的、不可推测。
 *
 * ⚠️ 微信里发链接码的坑：`+` `/` `=` 在某些输入法/复制场景会被吃掉或转义，
 *    所以这里统一用 **base64url**（`-` `_`，无 `=` 填充），更耐复制。
 */

;(function (root) {
  'use strict'

  var E2E = (typeof require !== 'undefined')
    ? require('./e2e-crypto.js')
    : root.E2E

  var PREFIX = 'CPL1'

  /* ============ base64url（比标准 base64 更耐复制粘贴） ============ */

  function b64urlEncode(bytes) {
    return E2E.bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function b64urlDecode(s) {
    var t = String(s).replace(/-/g, '+').replace(/_/g, '/')
    while (t.length % 4) t += '='
    return E2E.b64ToBytes(t)
  }

  /* ============ 链接密钥：从随机 code 派生 ============ */

  /**
   * 链接密钥 = SHA-256('couple-link-v1:' + code)
   * 用固定前缀做域分隔，避免这个哈希被复用到别处。
   */
  function linkKeyFrom(code) {
    function subtle() {
      var c = (typeof crypto !== 'undefined') ? crypto : (root && root.crypto)
      if (!c || !c.subtle) throw new Error('这个环境没有 Web Crypto')
      return c.subtle
    }
    var st = subtle()
    var enc = new TextEncoder()
    return st.digest('SHA-256', enc.encode('couple-link-v1:' + code))
      .then(function (buf) { return new Uint8Array(buf) })
  }

  /** 随机令牌（用于 code：16 字节 = 128 位熵） */
  function randomToken(bytes) {
    var a = new Uint8Array(bytes || 16)
    var c = (typeof crypto !== 'undefined') ? crypto : (root && root.crypto)
    if (!c || !c.getRandomValues) throw new Error('拿不到安全随机数')
    c.getRandomValues(a)
    return b64urlEncode(a)
  }

  /* ============ 生成链接码 ============ */

  /**
   * @param {object} cfg { passphrase, salt, provider, gistId?, token?, stable? }
   * @returns {Promise<{link:string, code:string, passphrase:string, salt:string}>}
   *
   * ★ `stable: true` —— **同一个配对永远生成同一张链接码**。
   *
   *   为什么要有（2026-10-19 用户原话：「那个云端的码一直变，根本固定不下来」）：
   *   以前每次调用都 `randomToken(16)` 现掷一个 code，于是：
   *     · 点两次「我是第一个」→ 两张看起来完全不同的码，用户不知道哪张才是对的；
   *     · 他发出去那张、和她手里那张对不上，谁也不知道该信哪个；
   *     · 更糟的是每次点还会顺带新建云端 / 换口令（那段已单独修好）。
   *   现在 code 改成**从配对内容算出来的**：口令 + 盐 + 云端 ID 一样 → 码就一模一样。
   *   点一百次都得到同一张码；只要配对没变，码就永远不变。
   *
   *   ⚠️ 这不降低安全性：code 只用来给链接码**本身**加密（防止聊天软件里被直接看懂），
   *      真正的保密强度来自 passphrase（24 字节随机）+ AES-GCM，和 code 无关。
   */
  function createLink(cfg) {
    cfg = cfg || {}
    if (!cfg.passphrase) return Promise.reject(new Error('缺少口令'))
    if (!cfg.salt) return Promise.reject(new Error('缺少盐'))

    var stable = !!cfg.stable
    var payload = {
      v: 1,
      passphrase: cfg.passphrase,
      salt: cfg.salt,
      provider: cfg.provider || 'local',
      gistId: cfg.gistId || '',
      token: cfg.token || '',
      /* ⚠️ createdAt 也参与加密，所以 stable 模式下**不能写 Date.now()** ——
         否则同一组配对每次算出来的码都不一样（实测踩到：code 相同但整张码不同）。
         stable 模式给个固定值；它只是"这张码哪来的"的备注，不参与任何判断。 */
      createdAt: stable ? 0 : Date.now()
    }

    return Promise.resolve().then(function () {
      if (!stable) return randomToken(16)
      /* 从配对内容派生一个确定的 code（同一组配对 → 同一个 code） */
      var seed = 'couple-link-code-v1:' +
        String(cfg.provider || 'local') + '|' +
        String(cfg.passphrase) + '|' +
        String(cfg.salt) + '|' +
        String(cfg.gistId || '')
      var enc = new TextEncoder()
      var c = (typeof crypto !== 'undefined') ? crypto : (root && root.crypto)
      if (!c || !c.subtle) throw new Error('这个环境没有 Web Crypto')
      return c.subtle.digest('SHA-256', enc.encode(seed)).then(function (buf) {
        return b64urlEncode(new Uint8Array(buf).slice(0, 16))
      })
    }).then(function (code) {
      return linkKeyFrom(code).then(function (keyBytes) {
        /* 这里复用 E2E.encrypt，但密钥不是「口令派生」而是直接给的字节。
           E2E.encrypt 的签名是按口令设计的，所以这里手动走一遍同样的算法 ——
           避免为了这个用例去改加密层的公共接口。 */
        return encryptWithKeyBytes(payload, keyBytes, { deterministic: stable })
      }).then(function (env) {
        var link = PREFIX + '.' + code + '.' +
          b64urlEncode(new TextEncoder().encode(JSON.stringify(env)))
        return { link: link, code: code, passphrase: cfg.passphrase, salt: cfg.salt }
      })
    })
  }

  /**
   * 用**给定密钥字节**加密（链接码专用）。
   * 与 E2E.encrypt 的区别：不经过 PBKDF2，直接把字节 import 成 AES-GCM 密钥。
   *
   * @param {object} [opts] `{ deterministic: true }` = IV 由内容派生（同一份内容 → 同一张码）
   *
   * ⚠️ 为什么 stable 模式要确定性 IV（2026-10-19 实测两次才对）：
   *   一开始只把 code 做成确定的，码还是每次不同 —— 因为 AES-GCM 每次都要一个**随机 IV**，
   *   而 IV 是明文写在信封里的。再一看 `payload.createdAt: Date.now()` 也在参与加密。
   *   两处都得固定，整张码才真的逐字节相同。
   *
   *   安全性：这里唯一的风险是"同一密钥 + 同一 IV 加密不同明文"会泄露信息。
   *   但我们只在 `stable` 且**明文由密钥本身决定**时用它（payload 里全部是配对字段，
   *   而密钥 = SHA-256(那些字段)）。同一把密钥只可能对应同一份内容，
   *   所以不存在"同 key 同 nonce 加密两份不同明文"的情况。
   *   真正的保密强度仍然来自 passphrase（24 字节随机）+ AES-GCM 认证。
   */
  function encryptWithKeyBytes(value, keyBytes, opts) {
    var c = (typeof crypto !== 'undefined') ? crypto : (root && root.crypto)
    var st = c.subtle
    var enc = new TextEncoder()
    var deterministic = !!(opts && opts.deterministic)

    var ivPromise
    if (deterministic) {
      /* IV = SHA-256(明文) 的前 12 字节 —— 只依赖内容，所以完全可复现 */
      ivPromise = st.digest('SHA-256', enc.encode(JSON.stringify(value === undefined ? null : value)))
        .then(function (buf) { return new Uint8Array(buf).slice(0, 12) })
    } else {
      var iv = new Uint8Array(12)
      c.getRandomValues(iv)
      ivPromise = Promise.resolve(iv)
    }

    return ivPromise.then(function (iv2) {
      return st.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
        .then(function (key) {
          return st.encrypt({ name: 'AES-GCM', iv: iv2 },
            key, enc.encode(JSON.stringify(value === undefined ? null : value)))
        })
        .then(function (ct) {
          return {
            v: 1,
            alg: 'direct',
            iv: E2E.bytesToB64(iv2),
            data: E2E.bytesToB64(new Uint8Array(ct))
          }
        })
    })
  }

  /** 对应的解密（链接码专用） */
  function decryptWithKeyBytes(env, keyBytes) {
    var c = (typeof crypto !== 'undefined') ? crypto : (root && root.crypto)
    var st = c.subtle
    var dec = new TextDecoder()
    var iv = E2E.b64ToBytes(env.iv)
    var data = E2E.b64ToBytes(env.data)

    return st.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
      .then(function (key) {
        return st.decrypt({ name: 'AES-GCM', iv: iv }, key, data)
      })
      .then(function (buf) { return JSON.parse(dec.decode(new Uint8Array(buf))) })
      .catch(function (e) {
        var msg = (e && e.message) || String(e)
        if ((e && e.name === 'OperationError') || /operation-specific|operation failed/i.test(msg)) {
          throw new Error('链接码无效或已被破坏')
        }
        throw e
      })
  }

  /* ============ 解析链接码 ============ */

  /**
   * @param {string} link 形如 CPL1.<code>.<payload>
   * @returns {Promise<{passphrase, salt, provider, gistId, token, createdAt}>}
   * @throws 格式不对 / 被篡改 时给出人话错误
   */
  function parseLink(link) {
    var raw = String(link || '').trim()

    // 耐脏：允许用户粘贴时带上空格/换行/引号
    raw = raw.replace(/[\s"'`]/g, '')

    var parts = raw.split('.')
    if (parts.length !== 3) {
      return Promise.reject(new Error('链接码格式不对（应该是 3 段，用点分隔）'))
    }
    if (parts[0].toUpperCase() !== PREFIX) {
      return Promise.reject(new Error('这不是本 App 的链接码（应以 ' + PREFIX + ' 开头）'))
    }

    var code = parts[1]
    var env = null
    try {
      env = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[2])))
    } catch (e) {
      return Promise.reject(new Error('链接码内容损坏（不是合法的数据）'))
    }
    if (!env || !env.iv || !env.data) {
      return Promise.reject(new Error('链接码内容缺字段'))
    }

    return linkKeyFrom(code).then(function (keyBytes) {
      return decryptWithKeyBytes(env, keyBytes)
    }).then(function (payload) {
      if (!payload || !payload.passphrase || !payload.salt) {
        throw new Error('链接码里没有口令/盐（可能不是这个 App 生成的）')
      }
      return payload
    })
  }

  /** 判断一段文本看起来像不像链接码（UI 上用来提前提示） */
  function looksLikeLink(s) {
    return /^CPL1\./.test(String(s || '').replace(/[\s"'`]/g, ''))
  }

  var api = {
    PREFIX: PREFIX,
    createLink: createLink,
    parseLink: parseLink,
    looksLikeLink: looksLikeLink,
    b64urlEncode: b64urlEncode,
    b64urlDecode: b64urlDecode,
    randomToken: randomToken
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.CoupleLink = api
})(typeof self !== 'undefined' ? self : this)
