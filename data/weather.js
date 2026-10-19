/**
 * ⚠️⚠️ 2026-10-19 严重修复：整个文件必须包在 IIFE 里。
 *
 * 原来这个文件的顶层写着 `var CONFIG = { provider: 'amap' ... }`，**没有 IIFE 包裹**。
 * 而 data/shared-data.js 和 data/points.js 也在顶层各自写了 `var CONFIG`。
 * 三者都在**全局作用域**，按加载顺序互相覆盖：
 *
 *   weather.js(第7)  →  CONFIG.provider = 'amap'
 *   shared-data.js(第8) →  var CONFIG = { provider:'local' }   ← 把上面的覆盖了
 *   points.js(第10)  →  var CONFIG = { provider:'local' }   ← 又覆盖一次
 *
 * 于是 weather.js **内部**读到的 CONFIG.provider 是 'local'（不是它自己写的 'amap'），
 * 分支 `if (CONFIG.provider === 'amap' && AMAP.key)` 永远不成立 →
 * 每次都被拿去喂 mockWithCoord() → **首页永远是假天气**。
 * 这解释了「填了 key 也不生效」：key 存进去了、AMAP.key 也有值，
 * 但 provider 那个字段早就被别的文件改掉了。
 * （探针抓到决定性证据：外部读 window.Weather.CONFIG.provider='amap'，
 *   内部同一处读出来却是 'local'，明明是同一个对象 —— 因为 CONFIG 是全局的、
 *   被后来的文件整份替换过。）
 *
 * 包进 IIFE 之后，顶层的 var 都关在函数作用域里，
 * 外部仍然通过 window.Weather 用它（文件末尾照旧导出）。
 */
;(function (root) {
'use strict'

/**
 * 天气服务
 *
 * 设计要点：**按城市查询**，不是按人。
 *   两个人所在城市不同，就各自查各自的；同城则只查一次、共用结果。
 *   缓存按城市 + 日期存，所以同一天不会重复请求。
 *
 * 环境兼容：Node / 小程序 / 浏览器都能加载。
 * 目前 provider 是 mock（假期数据），接真实接口时只改 fetchByCity。
 *
 * 接真实接口要做的（以和风天气为例）：
 *   1. 去 dev.qweather.com 注册，拿免费 key
 *   2. 小程序后台「开发设置 → 服务器域名」把 https://devapi.qweather.com
 *      加进 request 合法域名（测试号可在开发者工具里勾「不校验合法域名」先跑通）
 *   3. 把下面 API 段填上，provider 改成 'qweather'
 */

/* ============ 图标/文案：和风天气的 icon code 归一化到 emoji ============ */
var ICON_MAP = {
  '100': '☀️',   // 晴
  '101': '⛅',   // 多云
  '102': '⛅',
  '103': '⛅',
  '104': '☁️',   // 阴
  '150': '🌙',   // 晴（夜）
  '151': '☁️',
  '153': '☁️',
  '300': '🌦️',  // 阵雨
  '301': '🌦️',
  '302': '⛈️',  // 雷阵雨
  '303': '⛈️',
  '304': '⛈️',
  '305': '🌧️',  // 小雨
  '306': '🌧️',
  '307': '🌧️',
  '308': '🌧️',
  '309': '🌧️',
  '310': '🌧️',
  '311': '🌧️',
  '312': '🌧️',
  '313': '🌧️',
  '314': '🌧️',
  '315': '🌧️',
  '316': '🌧️',
  '317': '🌧️',
  '318': '🌧️',
  '350': '🌧️',
  '351': '🌧️',
  '399': '🌧️',
  '400': '🌨️',  // 小雪
  '401': '🌨️',
  '402': '❄️',   // 大雪
  '403': '❄️',
  '404': '🌨️',
  '405': '🌨️',
  '406': '🌨️',
  '407': '🌨️',
  '408': '❄️',
  '409': '❄️',
  '410': '❄️',
  '456': '🌨️',
  '457': '🌨️',
  '499': '🌨️',
  '500': '🌫️',  // 雾
  '501': '🌫️',
  '502': '😷',   // 霾
  '503': '😷',
  '504': '😷',
  '507': '😷',
  '508': '😷',
  '509': '🌫️',
  '510': '🌫️',
  '511': '😷',
  '512': '😷',
  '513': '😷',
  '514': '🌫️',
  '515': '🌫️',
  '900': '🔥',   // 热
  '901': '🥶'    // 冷
}

function iconFor(code) {
  return ICON_MAP[String(code)] || '⛅'
}

/* ============ 缓存 ============ */
var memCache = {}
var CACHE_PREFIX = 'couple_weather_'

function todayKey() {
  var d = new Date()
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
}

/* 天气缓存的存储适配。
   ⚠️ 小程序里没有 localStorage —— 只写 localStorage 分支的话缓存永远不生效，
      表现是每次进页面都重新请求（白烧高德配额），而且不报错。
      wx 的 getStorageSync 直接存对象，浏览器的 localStorage 只能存字符串，这里统一。 */
function cacheGet(key) {
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      var v = wx.getStorageSync(key)
      if (v === '' || v === undefined || v === null) return null
      return (typeof v === 'string') ? JSON.parse(v) : v
    }
    if (typeof localStorage !== 'undefined') {
      var raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    }
  } catch (e) { /* 隐私模式 / 存储不可用 */ }
  return null
}

function cacheSet(key, data) {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) {
      wx.setStorageSync(key, data)
      return
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(data))
    }
  } catch (e) { /* ignore */ }
}

function readCache(city) {
  var key = CACHE_PREFIX + city + '_' + todayKey()
  if (memCache[key]) return memCache[key]
  var parsed = cacheGet(key)
  if (parsed) { memCache[key] = parsed; return parsed }
  return null
}

function writeCache(city, data) {
  var key = CACHE_PREFIX + city + '_' + todayKey()
  memCache[key] = data
  cacheSet(key, data)
}

/* ============ 真实接口配置 ============ */
/**
 * 和风天气 2024 后的新规则（对接前必读）：
 *   1. 域名不再是公共的 devapi.qweather.com —— 原公共地址
 *      api/devapi/geoapi.qweather.com 从 2026 年起逐步停止服务。
 *      现在每个账号有专属 API Host，在「控制台 → 设置」查看，
 *      形如 h2a9cf3mhs.xy.qweatherapi.com
 *   2. 推荐用 API KEY（不要用 JWT）：JWT 需要在客户端用 Ed25519 私钥签名，
 *      而小程序里放私钥等于把私钥发给每个装了包的人，反而不安全。
 *      API KEY 有长期限制（2027-01-01 起限制每日请求量），两人自用足够。
 *   3. API KEY 可用两种方式传递，本文件两种都支持：
 *      - 请求参数  ?key=xxx
 *      - 请求标头  X-QW-Api-Key: xxx
 *      注意不要同时使用多种认证方式，会认证失败。
 */
/* ============================================================
   ⚠️⚠️ API key / 专属 API Host 一律**不写进代码**
   ------------------------------------------------------------
   这个仓库是公开的（GitHub Pages 托管，见 README）。key 填在代码里
   等于把 key 送给所有能看到仓库的人 —— 别人可以刷你的额度。

   所以 key 存在**用户本机**（浏览器 localStorage / 小程序 wx storage），
   在 App 的「设置」里填一次即可，之后一直生效。
   （2026-10-10 实测：原来写死的那个高德 key 是活的，能拉到真实天气，
     所以它确实是个真 key，必须从代码里拿掉。）

   和风的「专属 API Host」同理：它本身也是身份认证的一部分，不公开。
   ============================================================ */
var LS_AMAP_KEY = 'couple_amap_key'
var LS_QW_HOST = 'couple_qweather_host'
var LS_QW_KEY = 'couple_qweather_key'

/** 读一个字符串设置（不 JSON 化，key 就是裸字符串） */
function keyGet(name) {
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      var v = wx.getStorageSync(name)
      return (v === '' || v === undefined || v === null) ? '' : String(v)
    }
    if (typeof localStorage !== 'undefined') return localStorage.getItem(name) || ''
  } catch (e) { /* 隐私模式 */ }
  return ''
}

function keySet(name, val) {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) { wx.setStorageSync(name, val); return true }
    if (typeof localStorage !== 'undefined') { localStorage.setItem(name, val); return true }
  } catch (e) { /* 额度满 / 隐私模式 */ }
  return false
}

var CONFIG = {
  provider: 'amap',        // 'mock' | 'amap' | 'qweather'
  /** 和风备用配置（暂未启用）。注意要填专属 API Host，不是 devapi.qweather.com */
  host: '',                // ← 空：运行时从本机存储读（见 loadKeys）
  key: '',                 // ← 空：同上（不要在这里填 key）
  keyMode: 'param'         // 'param'（?key=）| 'header'（X-QW-Api-Key）
}

/**
 * 启动时把本机存的 key 读回来。
 * 读不到也不影响页面：fetchByCoords 会退回示例数据（见下面的 provider 分支），
 * 首页不会空着 —— 只是天气不是真的。
 */
/* ★ 最近一次真实接口失败的**原因**（界面用来告诉用户为什么还是示例数据） */
var lastError = ''

function loadKeys() {
  CONFIG.host = keyGet(LS_QW_HOST) || ''
  CONFIG.key = keyGet(LS_QW_KEY) || ''
  AMAP.key = keyGet(LS_AMAP_KEY) || ''
  return { amap: !!AMAP.key, qweather: !!(CONFIG.key && CONFIG.host) }
}

/** 设置里保存高德 key（存本机，不进代码仓库） */
function setAmapKey(k) {
  AMAP.key = String(k == null ? '' : k).trim()
  keySet(LS_AMAP_KEY, AMAP.key)
  return AMAP.key
}

/** 设置里保存和风 host + key */
function setQweather(cfg) {
  cfg = cfg || {}
  if (cfg.host !== undefined) { CONFIG.host = String(cfg.host || '').trim(); keySet(LS_QW_HOST, CONFIG.host) }
  if (cfg.key !== undefined) { CONFIG.key = String(cfg.key || '').trim(); keySet(LS_QW_KEY, CONFIG.key) }
  return { host: CONFIG.host, key: CONFIG.key }
}

function hasAmapKey() { return !!AMAP.key }
function hasQweather() { return !!(CONFIG.key && CONFIG.host) }

function hostReady() {
  return !!(CONFIG.host && CONFIG.key)
}

function baseUrl() {
  var h = CONFIG.host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return 'https://' + h
}

/**
 * 和风天气的认证参数/标头。
 * 两种方式任选其一：参数 key=xxx，或标头 X-QW-Api-Key: xxx。
 * 同时使用多种认证方式会导致认证失败，所以这里严格二选一。
 */
function authQuery() {
  return CONFIG.keyMode === 'param' ? { key: CONFIG.key } : {}
}

function authHeader() {
  return CONFIG.keyMode === 'header' ? { 'X-QW-Api-Key': CONFIG.key } : {}
}

/** 按城市名查天气。 */
function fetchByCity(city) {
  var cached = readCache(city)
  if (cached) return Promise.resolve(cached)

  if (CONFIG.provider === 'qweather' && hostReady()) {
    return realFetch(city).then(function (d) {
      writeCache(city, d)
      return d
    }).catch(function () {
      // 接口失败时退回假数据，别让首页空着
      return mockFetch(city).then(function (d) {
        d.stale = true
        return d
      })
    })
  }

  return mockFetch(city).then(function (d) {
    writeCache(city, d)
    return d
  })
}

/** 和风天气：城市名 → location id → 实况 + 今日预报 */
function realFetch(city) {
  return new Promise(function (resolve, reject) {
    /* ⚠️ 和风这条路目前**只在小程序里能用**（整个 realFetch / resolveById 都基于 wx.request）。
       网页版填了和风 key 也会一路失败退回假数据。
       现在至少让它**说出来**，而不是静默： */
    if (typeof wx === 'undefined' || !wx.request) {
      return reject(new Error('网页版暂时只支持高德（和风要走 wx.request，浏览器里用不了）'))
    }
    wx.request({
      url: baseUrl() + '/geo/v2/city/lookup',
      data: Object.assign({ location: city, number: 1 }, authQuery()),
      header: authHeader(),
      success: function (res) {
        var loc = res.data && res.data.location && res.data.location[0]
        if (!loc) return reject(new Error('找不到城市: ' + city))
        resolveById(loc.id, city, loc.lat, loc.lon).then(resolve).catch(reject)
      },
      fail: reject
    })
  })
}

/** 和风天气按经纬度查询。注意 location 格式是「经度,纬度」，别写反。 */
function realFetchByCoords(lat, lon) {
  return new Promise(function (resolve, reject) {
    if (typeof wx === 'undefined' || !wx.request) {
      return reject(new Error('当前环境不支持 wx.request'))
    }
    var loc = lon.toFixed(4) + ',' + lat.toFixed(4)
    // 反查城市名，拿不到也不影响出温度
    wx.request({
      url: baseUrl() + '/geo/v2/city/lookup',
      data: Object.assign({ location: loc, number: 1 }, authQuery()),
      header: authHeader(),
      success: function (res) {
        var item = res.data && res.data.location && res.data.location[0]
        var cityName = item ? item.name : ''
        resolveById(loc, cityName, lat, lon).then(resolve).catch(reject)
      },
      fail: function () {
        // 反查失败也继续取天气，只是没有城市名
        resolveById(loc, '', lat, lon).then(resolve).catch(reject)
      }
    })
  })
}

/** 用 location（id 或 经纬度）取实况 + 今日预报，拼成统一结构 */
function resolveById(location, cityName, lat, lon) {
  var meta = { location: location, key: CONFIG.key }
  return new Promise(function (resolve, reject) {
    wx.request({
      url: baseUrl() + '/v7/weather/now',
      data: Object.assign({}, meta, authQuery()),
      header: authHeader(),
      success: function (r1) {
        wx.request({
          url: baseUrl() + '/v7/weather/3d',
          data: Object.assign({}, meta, authQuery()),
          header: authHeader(),
          success: function (r2) {
            var now = (r1.data && r1.data.now) || {}
            var day = (r2.data && r2.data.daily && r2.data.daily[0]) || {}
            resolve({
              city: cityName,
              icon: iconFor(now.icon),
              temp: parseInt(now.temp, 10),
              desc: now.text || '',
              high: parseInt(day.tempMax, 10),
              low: parseInt(day.tempMin, 10),
              lat: lat,
              lon: lon,
              updatedAt: Date.now()
            })
          },
          fail: reject
        })
      },
      fail: reject
    })
  })
}

/* ============ 假数据：接真实接口前先用它把界面跑通 ============ */
var MOCK_BY_CITY = {
  '南宁': { icon: '☀️', temp: 32, desc: '晴', high: 33, low: 24 },
  '深圳': { icon: '☀️', temp: 31, desc: '晴', high: 32, low: 26 },
  '杭州': { icon: '🌧️', temp: 19, desc: '小雨', high: 20, low: 16 },
  '北京': { icon: '☀️', temp: 25, desc: '晴', high: 27, low: 14 },
  '上海': { icon: '⛅', temp: 23, desc: '多云', high: 25, low: 19 },
  '成都': { icon: '☁️', temp: 21, desc: '阴', high: 23, low: 17 },
  '广州': { icon: '🌦️', temp: 30, desc: '阵雨', high: 32, low: 26 },
  '西安': { icon: '☀️', temp: 25, desc: '晴', high: 28, low: 15 },
  '武汉': { icon: '🌧️', temp: 22, desc: '中雨', high: 24, low: 18 },
  '南京': { icon: '⛅', temp: 24, desc: '多云', high: 26, low: 18 },
  '重庆': { icon: '☁️', temp: 26, desc: '阴', high: 28, low: 20 }
}

function mockFetch(city) {
  var base = MOCK_BY_CITY[city] || {
    icon: '⛅', temp: 22, desc: '多云', high: 24, low: 18
  }
  return Promise.resolve({
    city: city,
    icon: base.icon,
    temp: base.temp,
    desc: base.desc,
    high: base.high,
    low: base.low,
    updatedAt: Date.now()
  })
}

/**
 * 按经纬度查天气 —— 首选路径，不需要用户选城市。
 *
 * 手机能直接给经纬度（小程序 wx.getLocation / 浏览器 navigator.geolocation），
 * 而和风、高德等天气接口都支持用 location=经度,纬度 直接查，
 * 返回结果里还带城市名。所以用户一次都不用选城市。
 *
 * 注意：读不到「手机自带天气 App」的数据 —— 系统天气是系统应用，
 * 没有任何对外接口。它自己的数据也是从气象服务商拿的，
 * 我们直接问同一个来源，反而更新（系统那个可能是上次定位的缓存）。
 *
 * @param {number} lat 纬度
 * @param {number} lon 经度
 * @returns {Promise<{city,icon,temp,desc,high,low,lat,lon,updatedAt}>}
 */
function fetchByCoords(lat, lon) {
  var near = nearestMockCity(lat, lon)
  var cacheKey = 'coord_' + lat.toFixed(2) + '_' + lon.toFixed(2)
  var cached = readCache(cacheKey)
  /* ★★ 缓存的**假数据**不许挡住真请求（2026-10-19「填了 key 不生效」的第三个原因）。
     踩到的链条：
       ① 一开始没配 key → 拉到的假数据（stale:true）被 writeCache 存了一整天；
       ② 用户随后在设置里填了 key 并点保存 → clearCache() 清了**内存**缓存，
          但用户如果没点保存就直接刷新（或者别的路径没走到 clearCache），
       ③ 或者缓存是「按坐标 + 日期」存的，另一个窗口/另一次进入时命中旧的那份；
       → 于是 `readCache` 一命中就直接 return，**新 key 压根没机会被用上**。
     现在：只要这份缓存是 stale（示例数据）、而我们现在**有** key 了，
     就当作没有缓存，重新去问一次真接口。 */
  var haveRealSource = (CONFIG.provider === 'amap' && !!AMAP.key) ||
    (CONFIG.provider === 'qweather' && hostReady())
  /* ★★ 判断要**不依赖缓存里的字段**。
     原来写的是「cached.stale && haveRealSource 就不吃缓存」——
     实测漏了：缓存里那份假数据**不一定带 stale 字段**（老版本存的、或者别的路径写的），
     于是 `cached.stale` 是 undefined → 条件不成立 → 又命中缓存 → 新 key 永远用不上。
     （用探针抓到：条件全满足、手动请求 200 OK，但走模块时 fetch 一次都没发出、ms=0。）
     现在反过来：**只要现在有真数据源，就一律不吃缓存** ——
     缓存的意义只是"省一次请求"，而有 key 的人在意的是"看到真天气"，后者优先。
     代价：配了 key 之后每次进首页会真请求一次（高德免费额度 5000 次/月，够用）。 */
  if (cached && !haveRealSource) return Promise.resolve(cached)

  // 高德：一次请求直出城市名 + 天气，无需反查
  if (CONFIG.provider === 'amap' && AMAP.key) {
    return amapFetchByCoords(lat, lon).then(function (d) {
      lastError = ''
      writeCache(cacheKey, d)
      return d
    }).catch(function (e) {
      /* ★★ 失败**不能静默**（2026-10-19 用户报「填了 key 不生效」的第二个原因）：
         原来这里是一句空的 catch → 悄悄退回假数据，用户完全看不出哪里错了。
         现在把真实原因挂到 lastError，界面可以显示出来。
         ⚠️ 而且**不要把失败结果写进缓存** —— 否则一次网络抖动会被缓存一整天，
         用户会觉得"明天还是假数据"。 */
      lastError = '高德请求失败：' + String((e && e.message) || e)
      return mockWithCoord(near.city, lat, lon, cacheKey, { noCache: true })
    })
  }

  if (CONFIG.provider === 'qweather' && hostReady()) {
    return realFetchByCoords(lat, lon).then(function (d) {
      writeCache(cacheKey, d)
      return d
    }).catch(function (e) {
      lastError = '和风请求失败：' + String((e && e.message) || e)
      return mockWithCoord(near.city, lat, lon, cacheKey, { noCache: true })
    })
  }

  return mockWithCoord(near.city, lat, lon, cacheKey, { noCache: true })
}

/** 接口不可用时退回示例数据，别让首页空着。
 *  @param {object} [opts] `{noCache:true}` = 不要把这一份写进缓存（失败别被缓存住） */
function mockWithCoord(city, lat, lon, cacheKey, opts) {
  return mockFetch(city).then(function (d) {
    d.city = city
    d.lat = lat
    d.lon = lon
    d.stale = true
    if (lastError) d.reason = lastError
    if (!(opts && opts.noCache)) writeCache(cacheKey, d)
    return d
  })
}

/**
 * 拿到当前设备的经纬度。
 * 小程序用 wx.getLocation，浏览器用 navigator.geolocation。
 * 两者都拿不到时返回 null，调用方应退回"用默认城市"的老路径。
 */
function locate() {
  // 小程序
  if (typeof wx !== 'undefined' && wx.getLocation) {
    return new Promise(function (resolve) {
      wx.getLocation({
        type: 'wgs84',
        success: function (r) { resolve({ lat: r.latitude, lon: r.longitude }) },
        fail: function () { resolve(null) }
      })
    })
  }
  // 浏览器
  if (typeof navigator !== 'undefined' && navigator.geolocation) {
    return new Promise(function (resolve) {
      var done = false
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(null) }
      }, 8000)
      navigator.geolocation.getCurrentPosition(
        function (p) {
          if (done) return
          done = true; clearTimeout(timer)
          resolve({ lat: p.coords.latitude, lon: p.coords.longitude })
        },
        function () {
          if (done) return
          done = true; clearTimeout(timer)
          resolve(null)
        },
        { timeout: 7000, maximumAge: 600000 }
      )
    })
  }
  return Promise.resolve(null)
}

/**
 * 高德地图天气 —— 备选 provider
 *
 * 注意：高德天气接口不收经纬度，只收 adcode（城市编码），所以是两步：
 *   1) /v3/geocode/regeo?location=经度,纬度   → 拿 addressComponent.adcode
 *   2) /v3/weather/weatherInfo?city=adcode    → 拿天气，响应里自带城市名
 *
 * 一个已知坑：直辖市（北京/上海/天津/重庆）在 regeo 里的
 * addressComponent.city 是**空数组**，城市名在 province 里。
 * 所以城市名一律从第 2 步的 lives[0].city 取，不要用 regeo 的 city。
 *
 * 配额（个人认证开发者，来自高德官方定价页）：
 *   天气查询 5,000 次/月（免费，限注册后 1 年）
 *   逆地理编码 150,000 次/月
 *   两人自用一天 2~4 次请求，用不到配额的千分之一。
 *
 * 申请：https://console.amap.com/dev/key/app
 *   → 创建应用 → 添加 Key → 服务平台必须选【Web服务】（不是 JS API）
 */
var AMAP = {
  /* ⚠️ 不在这里填 key（仓库公开）—— 运行时由 loadKeys() 从本机存储读 */
  key: '',
  host: 'restapi.amap.com'
}

/* ⚠️ 必须在 AMAP 定义**之后**才调用：loadKeys 会写 AMAP.key，
   放在前面会拿到 undefined（var 只是声明提升，赋值还没执行）。 */
loadKeys()

/** 高德天气描述 → emoji（描述值见官方「天气对照表」） */
function amapIcon(desc) {
  if (!desc) return '⛅'
  if (desc.indexOf('雷') >= 0) return '⛈️'
  if (desc.indexOf('雪') >= 0) return '🌨️'
  if (desc.indexOf('雨') >= 0) return '🌧️'
  if (desc.indexOf('雾') >= 0 || desc.indexOf('霾') >= 0) return '🌫️'
  if (desc.indexOf('沙') >= 0 || desc.indexOf('尘') >= 0) return '🌫️'
  if (desc.indexOf('阴') >= 0) return '☁️'
  if (desc.indexOf('多云') >= 0 || desc.indexOf('少云') >= 0) return '⛅'
  if (desc.indexOf('晴') >= 0) return '☀️'
  if (desc.indexOf('风') >= 0) return '💨'
  return '⛅'
}

/** 统一封装 wx.request 成 Promise */
/**
 * 发一个 GET 请求（**网页版和小程序都能用**）。
 *
 * ★★ 2026-10-19 修：原来这里只走 `wx.request`（微信小程序专用 API），
 *    于是**网页版永远拿不到真实天气**，而且一声不响：
 *
 *      if (typeof wx === 'undefined' || !wx.request) {
 *        return reject(new Error('当前环境不支持 wx.request'))   ← 浏览器里必然抛
 *      }
 *
 *    外面 `fetchByCoords` 的 `.catch` 会把任何失败**静默退回假数据**（还打上
 *    stale:true），所以用户看到的仍是「32°C 晴」——「填了 key 不生效」就是这个。
 *    实测证据：填完 key 后 `hasAmapKey()=true` 但 `stale` 仍是 `true`、
 *    `source` 是 null（没走到 amap 成功分支）。
 *
 *    现在：有 fetch 就用 fetch（浏览器/PWA），没有再用 wx.request（小程序）。
 */
function httpGetJson(url, params) {
  /* 拼查询串（高德的 key / location 都走 query） */
  var qs = []
  var q = params || {}
  for (var k in q) {
    if (!Object.prototype.hasOwnProperty.call(q, k)) continue
    if (q[k] === undefined || q[k] === null) continue
    qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(q[k]))
  }
  var full = url + (qs.length ? ('?' + qs.join('&')) : '')

  /* ① 浏览器 / PWA：用 fetch */
  if (typeof fetch === 'function') {
    return fetch(full, { method: 'GET' }).then(function (r) {
      return r.text().then(function (t) {
        var d = null
        try { d = JSON.parse(t) } catch (e) { d = null }
        if (!d) throw new Error('高德返回的不是 JSON：' + String(t).slice(0, 120))
        /* 高德约定：status==='1' 才算成功 */
        if (d.status !== '1') {
          throw new Error('高德错误: ' + (d.info || d.infocode || 'unknown'))
        }
        return d
      })
    })
  }

  /* ② 微信小程序：用 wx.request */
  if (typeof wx !== 'undefined' && wx.request) {
    return new Promise(function (resolve, reject) {
      wx.request({
        url: url,
        data: params,
        success: function (res) {
          var d = res.data || {}
          if (d.status !== '1') {
            return reject(new Error('高德错误: ' + (d.info || d.infocode || 'unknown')))
          }
          resolve(d)
        },
        fail: reject
      })
    })
  }

  return Promise.reject(new Error('这个环境既没有 fetch 也没有 wx.request'))
}

function amapGet(path, data) {
  if (!AMAP.key) return Promise.reject(new Error('高德 key 未配置'))
  return httpGetJson('https://' + AMAP.host + path, data)
}

/** 把「南宁市」「深圳市」这类规范成「南宁」「深圳」，显示用 */
function shortCityName(name) {
  if (!name || typeof name !== 'string') return ''
  return name.replace(/(市|地区|盟|自治州|自治县|特别行政区)$/, '')
}

/** 经纬度 → adcode + 城市显示名
 *
 * 关于城市名取哪个（实测过三个城市）：
 *   南宁(22.82,108.37) → regeo.city=南宁市   weather.city=青秀区
 *   深圳(22.54,114.06) → regeo.city=深圳市   weather.city=福田区
 *   北京(39.90,116.41) → regeo.city=空数组   weather.city=东城区  province=北京市
 * 天气接口返回的是**区级**名字，不适合当城市名显示；
 * 所以城市名取 regeo，直辖市再用 province 兜底。
 * adcode 仍然用区级的（更精确），只是显示名换成市级。
 */
function amapRegeo(lat, lon) {
  return amapGet('/v3/geocode/regeo', {
    key: AMAP.key,
    location: lon.toFixed(6) + ',' + lat.toFixed(6),
    extensions: 'base',
    output: 'JSON'
  }).then(function (d) {
    var ac = (d.regeocode && d.regeocode.addressComponent) || {}
    var adcode = ac.adcode || ''
    if (!adcode) throw new Error('逆地理编码没返回 adcode')

    // 直辖市（北京/上海/天津/重庆）的 city 是空数组，此时用 province
    var cityName = ''
    if (typeof ac.city === 'string' && ac.city) cityName = ac.city
    else if (ac.province) cityName = ac.province

    return {
      adcode: adcode,
      city: shortCityName(cityName),
      district: typeof ac.district === 'string' ? ac.district : ''
    }
  })
}

/** adcode → 实况天气 */
function amapWeatherByAdcode(adcode, lat, lon) {
  return amapGet('/v3/weather/weatherInfo', {
    key: AMAP.key,
    city: adcode,
    extensions: 'base',
    output: 'JSON'
  }).then(function (d) {
    var live = (d.lives && d.lives[0]) || {}
    if (!live.weather) throw new Error('高德没返回实况数据')
    return {
      city: live.city || '',
      icon: amapIcon(live.weather),
      temp: parseInt(live.temperature, 10),
      desc: live.weather,
      high: NaN,          // base 不含预报；要高温低温得再查 extensions=all
      low: NaN,
      humidity: live.humidity,
      wind: (live.winddirection || '') + '风 ' + (live.windpower || '') + '级',
      reportTime: live.reporttime || '',
      lat: lat,
      lon: lon,
      updatedAt: Date.now(),
      source: 'amap'
    }
  })
}

/** 组合：经纬度 → 天气（两步） */
function amapFetchByCoords(lat, lon) {
  return amapRegeo(lat, lon).then(function (r) {
    return amapWeatherByAdcode(r.adcode, lat, lon).then(function (w) {
      // 城市名以 regeo 的市级名为准（天气接口返回的是区级名）
      if (r.city) w.city = r.city
      w.district = r.district
      w.adcode = r.adcode
      return w
    })
  })
}

/* 离线/无 key 时用：找最近的示例城市 */
var MOCK_COORDS = [
  { city: '北京', lat: 39.90, lon: 116.41 },
  { city: '上海', lat: 31.23, lon: 121.47 },
  { city: '广州', lat: 23.13, lon: 113.26 },
  { city: '深圳', lat: 22.54, lon: 114.06 },
  { city: '南宁', lat: 22.82, lon: 108.37 },
  { city: '杭州', lat: 30.27, lon: 120.16 },
  { city: '南京', lat: 32.06, lon: 118.80 },
  { city: '武汉', lat: 30.59, lon: 114.31 },
  { city: '成都', lat: 30.57, lon: 104.07 },
  { city: '重庆', lat: 29.56, lon: 106.55 },
  { city: '西安', lat: 34.34, lon: 108.94 }
]

/** 粗略球面距离（km），只用来找最近城市、判断同城，不需要高精度 */
function distanceKm(lat1, lon1, lat2, lon2) {
  var R = 6371
  var toRad = Math.PI / 180
  var dLat = (lat2 - lat1) * toRad
  var dLon = (lon2 - lon1) * toRad
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function nearestMockCity(lat, lon) {
  var best = null
  var bestD = Infinity
  for (var i = 0; i < MOCK_COORDS.length; i++) {
    var c = MOCK_COORDS[i]
    var d = distanceKm(lat, lon, c.lat, c.lon)
    if (d < bestD) { bestD = d; best = { city: c.city, km: d } }
  }
  return best || { city: '杭州', km: 0 }
}

var api = {
  CONFIG: CONFIG,
  AMAP: AMAP,
  iconFor: iconFor,
  amapIcon: amapIcon,
  fetchByCity: fetchByCity,
  fetchByCoords: fetchByCoords,
  locate: locate,
  distanceKm: distanceKm,
  nearestMockCity: nearestMockCity,
  todayKey: todayKey,
  /** key 读写（存在本机，不进代码仓库）：设置面板用它 */
  loadKeys: loadKeys,
  hasAmapKeyNow: function () { return !!AMAP.key },
  lastWeatherError: function () { return lastError || '' },
  setAmapKey: setAmapKey,
  setQweather: setQweather,
  hasAmapKey: hasAmapKey,
  hasQweather: hasQweather,
  /** 测试用：清缓存 */
  /* 清缓存。⚠️ memCache 只是一半：真正会造成「换了 Key 还显示旧天气」的是
     **本机存储里的那一份**，两处都清掉，否则用户在设置里改完 Key 看不到变化。 */
  clearCache: function () {
    lastError = ''
    memCache = {}
    try {
      if (typeof wx !== 'undefined' && wx.getStorageInfoSync) {
        var ks = (wx.getStorageInfoSync() || {}).keys || []
        for (var i = 0; i < ks.length; i++) {
          if (ks[i].indexOf(CACHE_PREFIX) === 0 && wx.removeStorageSync) wx.removeStorageSync(ks[i])
        }
        return
      }
      if (typeof localStorage !== 'undefined') {
        var del = []
        for (var j = 0; j < localStorage.length; j++) {
          var k = localStorage.key(j)
          if (k && k.indexOf(CACHE_PREFIX) === 0) del.push(k)
        }
        for (var m = 0; m < del.length; m++) localStorage.removeItem(del[m])
      }
    } catch (e) { /* 隐私模式 / 存储不可用，忽略 */ }
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.Weather = api

})(typeof self !== 'undefined' ? self : this)
