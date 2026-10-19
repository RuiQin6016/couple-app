/**
 * 端到端加密（E2E）
 * ============================================================
 * 目的：数据在**手机上就加密好**才发出去。这样即使存在 GitHub（或任何别人的服务器）上，
 *      对方也只能看到一堆密文 —— 连服务器管理员都看不到内容。
 *
 * 算法选择（都是标准原语，**不要自己造加密算法**）：
 *   · 密钥派生：PBKDF2-SHA256，迭代 200000 次，16 字节随机 salt
 *   · 加密：AES-256-GCM，每次写入用**新的随机 IV**
 *   · 认证：GCM 自带（篡改会导致解密直接失败，而不是解出乱码）
 *
 * 为什么用 GCM 而不是 CBC：GCM 是**带认证**的加密。如果有人改了服务器上的密文，
 * 解密会**报错**，我们能发现；CBC 则会解出一堆垃圾数据，可能静默写坏本地状态。
 *
 * ⚠️ 三条铁律（改这个文件必须守住）：
 *   1. **同一个密钥 + 同一个 IV 绝对不能重复使用**（GCM 下会直接泄露密钥流）。
 *      这里每次 encrypt 都生成新 IV，已满足。
 *   2. **密钥不写进代码、不写进 APK**。由用户手输一次，存本地。
 *   3. 密文里**不能出现明文片段**（测试会检查这一条）。
 *
 * 兼容性：用 Web Crypto（`crypto.subtle`）。
 *   · 浏览器 / Node 15+ 都有
 *   · 微信小程序**没有**（所以小程序端跑不了端到端加密 —— 这也是换掉小程序的一个副作用）
 *   拿不到 Web Crypto 时抛明确错误，不静默降级成不加密（那样最危险）。
 */

;(function (root) {
  'use strict'

  var PBKDF2_ITER = 200000     // 迭代次数。调高更安全但更慢（这台机器上约几百毫秒）
  var SALT_BYTES = 16
  var IV_BYTES = 12            // GCM 标准用 12 字节
  var KEY_BITS = 256

  /** 拿 Web Crypto；拿不到就抛错（**绝不静默不加密**） */
  function subtle() {
    var c = (typeof crypto !== 'undefined') ? crypto : (root && root.crypto)
    if (!c || !c.subtle) {
      throw new Error('这个环境没有 Web Crypto，无法加密。' +
        '（浏览器需 https 或 localhost；微信小程序不支持端到端加密）')
    }
    return c.subtle
  }

  function u8(len) {
    var a = new Uint8Array(len)
    var c = (typeof crypto !== 'undefined') ? crypto : (root && root.crypto)
    if (c && c.getRandomValues) c.getRandomValues(a)
    else throw new Error('拿不到安全随机数（getRandomValues），无法生成密钥/IV')
    return a
  }

  /* ============ base64（不用 btoa：它对非 ASCII 会炸，我们二进制安全地做） ============ */

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

  function bytesToB64(bytes) {
    var out = ''
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i]
      var b1 = bytes[i + 1]
      var b2 = bytes[i + 2]
      out += B64[b0 >> 2]
      out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)]
      out += (b1 === undefined) ? '=' : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)]
      out += (b2 === undefined) ? '=' : B64[b2 & 63]
    }
    return out
  }

  function b64ToBytes(s) {
    var clean = String(s).replace(/[^A-Za-z0-9+/]/g, '')
    var len = clean.length
    var bytes = []
    for (var i = 0; i < len; i += 4) {
      var c0 = B64.indexOf(clean[i])
      var c1 = B64.indexOf(clean[i + 1])
      var c2 = B64.indexOf(clean[i + 2])
      var c3 = B64.indexOf(clean[i + 3])
      bytes.push((c0 << 2) | (c1 >> 4))
      if (c2 >= 0) bytes.push(((c1 & 15) << 4) | (c2 >> 2))
      if (c3 >= 0) bytes.push(((c2 & 3) << 6) | c3)
    }
    return new Uint8Array(bytes)
  }

  /* ============ 密钥派生 ============ */

  /**
   * 从口令派生**原始密钥字节**（不是 CryptoKey）。
   * 用途：链接码的一次性密钥 —— 需要同样的字节在另一端能复现，
   *       而且这个密钥**只用来加密链接码本身**，不碰业务数据。
   *
   * ⚠️ 这个密钥**只能用于非数据用途**（比如加密一次性链接码）。
   *    业务数据一律走 deriveKey 得到的 CryptoKey（AES-GCM）。
   *
   * @returns {Promise<Uint8Array>} 32 字节
   */
  function deriveRawKey(passphrase, salt, iterations) {
    if (typeof passphrase !== 'string' || !passphrase) {
      return Promise.reject(new Error('口令不能为空'))
    }
    var st = subtle()
    var enc = new TextEncoder()
    return st.importKey('raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveBits'])
      .then(function (baseKey) {
        return st.deriveBits(
          {
            name: 'PBKDF2',
            salt: salt,
            iterations: iterations || PBKDF2_ITER,
            hash: 'SHA-256'
          },
          baseKey, KEY_BITS
        )
      })
      .then(function (bits) { return new Uint8Array(bits) })
  }

  /**
   * 从「口令」派生出 AES 密钥。
   * @param {string} passphrase 你们俩约定的口令（手输，不写进代码）
   * @param {Uint8Array} salt 盐。同一对情侣必须用**同一个 salt**，否则派生出的密钥不同、解不开
   * @returns {Promise<CryptoKey>}
   */
  function deriveKey(passphrase, salt) {
    if (typeof passphrase !== 'string' || !passphrase) {
      return Promise.reject(new Error('口令不能为空'))
    }
    var st = subtle()
    var enc = new TextEncoder()
    return st.importKey('raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey'])
      .then(function (baseKey) {
        return st.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
          baseKey,
          { name: 'AES-GCM', length: KEY_BITS },
          false,
          ['encrypt', 'decrypt']
        )
      })
  }

  /* ============ 加密 / 解密 ============ */

  /**
   * 加密任意 JSON 可序列化的值。
   * @returns {Promise<{v:number, salt:string, iv:string, data:string}>}
   *   v    格式版本（以后换算法要能认出来）
   *   salt 盐（base64）。**放密文里是安全的** —— 没有口令，盐本身没用
   *   iv   本次的随机 IV（base64）。每次加密都不同，这是 GCM 的安全前提
   *   data 密文（base64）
   */
  function encrypt(value, passphrase, saltBytes) {
    var st = subtle()
    var enc = new TextEncoder()
    var salt = saltBytes || u8(SALT_BYTES)
    var iv = u8(IV_BYTES)                     // ⚠️ 每次都必须新生成
    var plain = enc.encode(JSON.stringify(value === undefined ? null : value))

    return deriveKey(passphrase, salt).then(function (key) {
      return st.encrypt({ name: 'AES-GCM', iv: iv }, key, plain)
    }).then(function (cipherBuf) {
      return {
        v: 1,
        salt: bytesToB64(salt),
        iv: bytesToB64(iv),
        data: bytesToB64(new Uint8Array(cipherBuf))
      }
    })
  }

  /**
   * 解密。
   * @returns {Promise<any>} 明文值
   * @throws 口令错 / 密文被改 / 格式坏 —— 一律抛错，**不要**返回 null 让人以为「没数据」
   */
  function decrypt(envelope, passphrase) {
    if (!envelope || typeof envelope !== 'object') {
      return Promise.reject(new Error('密文格式不对（不是对象）'))
    }
    if (envelope.v !== 1) {
      return Promise.reject(new Error('不认识的密文版本：' + envelope.v))
    }
    if (!envelope.salt || !envelope.iv || !envelope.data) {
      return Promise.reject(new Error('密文缺字段（salt/iv/data）'))
    }

    var st = subtle()
    var dec = new TextDecoder()
    var salt = b64ToBytes(envelope.salt)
    var iv = b64ToBytes(envelope.iv)
    var data = b64ToBytes(envelope.data)

    return deriveKey(passphrase, salt).then(function (key) {
      // GCM 的认证在这里起作用：被改过 / 口令不对 → 这一步直接 reject
      return st.decrypt({ name: 'AES-GCM', iv: iv }, key, data)
    }).then(function (plainBuf) {
      var text = dec.decode(new Uint8Array(plainBuf))
      try {
        return JSON.parse(text)
      } catch (e) {
        throw new Error('解密成功但内容不是合法 JSON（数据可能损坏）')
      }
    }).catch(function (e) {
      // 把 WebCrypto 那句没人看得懂的报错换成能懂的。
      // ⚠️ 难点在于**各家实现给的错误不一样**，实测：
      //   Chrome  : Error, message 含 "The operation failed for an operation-specific reason"
      //   Node    : DOMException, name === 'OperationError'，message 同样是上面那句
      //   Safari  : message 含 "The operation failed for an operation-specific reason"
      // 所以不能只匹配 message 文本（最初就是这么漏的），要把 name 一起看。
      var msg = (e && e.message) || String(e)
      var name = (e && e.name) || ''
      var isAuthFail = name === 'OperationError' ||
        /decrypt|BAD_DECRYPT|operation-specific|operation failed|无法解密/i.test(msg)
      if (isAuthFail) {
        throw new Error('解密失败：口令不对，或者数据被改动过')
      }
      throw e
    })
  }

  /** 生成一个新的盐（第一次配对时用一次，之后两人共用同一个） */
  function newSalt() {
    return bytesToB64(u8(SALT_BYTES))
  }

  /**
   * 从口令算一个「指纹」，用途：让两个人确认自己输的口令一致
   * （口令不一致 → 指纹不同 → 当场就能发现，而不是等同步失败才发现）
   * ⚠️ 指纹用独立的 salt，和加密用的 salt 不同，避免任何交叉复用。
   */
  function fingerprint(passphrase) {
    var st = subtle()
    var enc = new TextEncoder()
    var fixedSalt = enc.encode('couple-e2e-fingerprint-v1')   // 固定盐：只用来比对，不用于加密
    return st.importKey('raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveBits'])
      .then(function (baseKey) {
        return st.deriveBits(
          { name: 'PBKDF2', salt: fixedSalt, iterations: 10000, hash: 'SHA-256' },
          baseKey, 128
        )
      })
      .then(function (bits) {
        var b = new Uint8Array(bits)
        // 取前 6 字节转成 12 位十六进制，够人眼比对
        var s = ''
        for (var i = 0; i < 6; i++) s += ('0' + b[i].toString(16)).slice(-2)
        return s.toUpperCase().replace(/(.{4})(?=.)/g, '$1-')   // 形如 A1B2-C3D4-E5F6
      })
  }

  var api = {
    PBKDF2_ITER: PBKDF2_ITER,
    encrypt: encrypt,
    decrypt: decrypt,
    newSalt: newSalt,
    fingerprint: fingerprint,
    deriveRawKey: deriveRawKey,
    bytesToB64: bytesToB64,
    b64ToBytes: b64ToBytes,
    isSupported: function () {
      try { subtle(); return true } catch (e) { return false }
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.E2E = api
})(typeof self !== 'undefined' ? self : this)
