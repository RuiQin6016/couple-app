/**
 * 每日一言 · 统一入口
 *
 * 数据分三个文件维护：
 *   quotes-classic.js   历代诗词（先秦至清）
 *   quotes-classic2.js  古典补遗（词曲、传奇、小说）
 *   quotes-modern.js    现代名家与广为流传的句子
 *
 * 用法（小程序端直接 require 本文件即可）：
 *   var q = require('../../data/quotes.js')
 *   var today = q.todayQuote()   // { index, text, source, author, dateKey, dateLabel }
 *
 * 来源说明：古代作品为公有领域；现代部分只收广为流传的短句并标注出处，
 * 属合理引用。刻意未采用「一言 hitokoto」语句库——该库为 AGPL 授权，
 * 官方 README 明确说明除超链接调用外，使用即需开源整个项目。
 */

/* eslint-disable */
// 统一入口。同时兼容两种运行环境：
//   Node / 小程序  → require('./quotes.js')
//   浏览器         → <script src="data/quotes.js"> 之后用 window.Quotes
// 这样预览页和真机共用同一份语料，不会走偏。
var CLASSIC, CLASSIC2, MODERN, NOT_LOVE

if (typeof module !== 'undefined' && module.exports) {
  CLASSIC = require('./quotes-classic.js').CLASSIC
  CLASSIC2 = require('./quotes-classic2.js').CLASSIC2
  MODERN = require('./quotes-modern.js').MODERN
  NOT_LOVE = require('./quotes-tags.js').NOT_LOVE
} else if (typeof window !== 'undefined') {
  // 浏览器：需要在 HTML 里先引上面几个文件
  CLASSIC = window.__Q_CLASSIC__ || []
  CLASSIC2 = window.__Q_CLASSIC2__ || []
  MODERN = window.__Q_MODERN__ || []
  NOT_LOVE = window.__Q_TAGS__ || []
}

/** 非情话句的查找表（不用 Set，兼容性更好） */
var NOT_LOVE_MAP = {}
for (var t = 0; t < NOT_LOVE.length; t++) NOT_LOVE_MAP[NOT_LOVE[t]] = 1

/**
 * 合并并按正文去重。
 * @param {boolean} includeAll true 时连非情话句一起返回（默认 false）
 */
function buildAll(includeAll) {
  var seen = {}
  var out = []
  var groups = [CLASSIC, CLASSIC2, MODERN]
  for (var g = 0; g < groups.length; g++) {
    for (var i = 0; i < groups[g].length; i++) {
      var item = groups[g][i]
      var text = item[0]
      if (!text || seen[text]) continue
      if (!includeAll && NOT_LOVE_MAP[text]) continue
      seen[text] = 1
      out.push({ text: text, source: item[1], author: item[2] })
    }
  }
  return out
}

/**
 * 按句子内容算的确定性哈希。
 * 用内容而非下标做种子，这样往库里增删句子时，
 * 已有句子的相对顺序不会整体错位。
 */
function hashText(s) {
  var h = 5381
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return h >>> 0
}

/**
 * 确定性洗牌：结果只取决于句子内容，每次运行/每台设备都一致。
 *
 * 为什么需要：语料是按「诗经 → 唐诗 → 宋词 → 现代」分文件顺序放的，
 * 直接顺序轮换会让同一位作者连续霸屏好几天（实测连续 7 天都是沈从文）。
 * 洗一遍把不同来源打散。
 */
function shuffleByHash(list) {
  var arr = list.slice()
  for (var i = arr.length - 1; i > 0; i--) {
    var j = hashText(arr[i].text) % (i + 1)
    var tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

/** 首页轮换只用情话 */
var ALL = shuffleByHash(buildAll(false))
/** 全量（含非情话），备用，同样洗过 */
var ALL_WITH_OTHER = shuffleByHash(buildAll(true))

/**
 * 取今天的句子。同一天永远返回同一句。
 * @param {Date} [date] 不传则用当前时间
 */
function todayQuote(date) {
  var d = date instanceof Date ? date : new Date()
  // 用本地日期算天数，避免时区把"今天"算错
  var dayNumber = Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000
  )
  var n = ALL.length
  var index = ((dayNumber % n) + n) % n

  var week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  var dateKey = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')

  var q = ALL[index]
  return {
    index: index,
    total: n,
    text: q.text,
    source: q.source,
    author: q.author,
    dateKey: dateKey,
    dateLabel: (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' + week
  }
}

/** 按序号取（调试/预览用） */
function byIndex(i) {
  var n = ALL.length
  return ALL[((i % n) + n) % n]
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ALL: ALL,
    ALL_WITH_OTHER: ALL_WITH_OTHER,
    todayQuote: todayQuote,
    byIndex: byIndex
  }
}
if (typeof window !== 'undefined') {
  window.Quotes = {
    ALL: ALL,
    ALL_WITH_OTHER: ALL_WITH_OTHER,
    todayQuote: todayQuote,
    byIndex: byIndex
  }
}
