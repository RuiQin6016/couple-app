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
   * @param {object} cfg { passphrase, salt, provider, gistId?, token? }
   * @returns {Promise<{link:string, code:string, passphrase:string, salt:string}>}
   */
  function createLink(cfg) {
    cfg = cfg || {}
    if (!cfg.passphrase) return Promise.reject(new Error('缺少口令'))
    if (!cfg.salt) return Promise.reject(new Error('缺少盐'))

    var code = randomToken(16)

    // 放进链接码的东西：够对方一次配置好，之后免输
    var payload = {
      v: 1,
      passphrase: cfg.passphrase,
      salt: cfg.salt,
      provider: cfg.provider || 'local',
      gistId: cfg.gistId || '',
      token: cfg.token || '',
      createdAt: Date.now()
    }

    return linkKeyFrom(code).then(function (keyBytes) {
      // 这里复用 E2E.encrypt，但密钥不是「口令派生」而是直接给的字节。
      // E2E.encrypt 的签名是按口令设计的，所以这里手动走一遍同样的算法 ——
      // 避免为了这个用例去改加密层的公共接口。
      return encryptWithKeyBytes(payload, keyBytes)
    }).then(function (env) {
      var link = PREFIX + '.' + code + '.' +
        b64urlEncode(new TextEncoder().encode(JSON.stringify(env)))
      return { link: link, code: code, passphrase: cfg.passphrase, salt: cfg.salt }
    })
  }

  /**
   * 用**给定密钥字节**加密（链接码专用）。
   * 与 E2E.encrypt 的区别：不经过 PBKDF2，直接把字节 import 成 AES-GCM 密钥。
   */
  function encryptWithKeyBytes(value, keyBytes) {
    var c = (typeof crypto !== 'undefined') ? crypto : (root && root.crypto)
    var st = c.subtle
    var enc = new TextEncoder()
    var iv = new Uint8Array(12)
    c.getRandomValues(iv)

    return st.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
      .then(function (key) {
        return st.encrypt({ name: 'AES-GCM', iv: iv },
          key, enc.encode(JSON.stringify(value === undefined ? null : value)))
      })
      .then(function (ct) {
        return {
          v: 1,
          alg: 'direct',
          iv: E2E.bytesToB64(iv),
          data: E2E.bytesToB64(new Uint8Array(ct))
        }
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
