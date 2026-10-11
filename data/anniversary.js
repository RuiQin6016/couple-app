/**
 * 纪念日计算
 *
 * 同时兼容 Node（小程序端）与浏览器（预览页），避免两处逻辑走偏。
 *
 * 支持两件事：
 *   1. 恋爱总天数 + 年/月/日拆解
 *   2. 下一个周年纪念日的倒计时与进度
 */

/** 解析 'YYYY-MM-DD' 或 Date，返回当天 0 点的 Date；非法返回 null */
function parseDate(input) {
  if (input instanceof Date) {
    if (isNaN(input.getTime())) return null
    return new Date(input.getFullYear(), input.getMonth(), input.getDate())
  }
  if (typeof input !== 'string') return null
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input.trim())
  if (!m) return null
  var y = parseInt(m[1], 10)
  var mo = parseInt(m[2], 10)
  var d = parseInt(m[3], 10)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  var dt = new Date(y, mo - 1, d)
  // 排除 2 月 31 日这类会被自动进位的非法日期
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}

function toKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
}

/** 整天天数差（忽略时间，避免小时数把结果算歪） */
function daysBetween(a, b) {
  var ms = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime() -
    new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  return Math.round(ms / 86400000)
}

/**
 * 年/月/日拆解。
 * 规则：先按"年 + 月"逐级进位，月份不足时向年借位。
 * 例：2026-05-20 → 2026-06-19 记为 0年0月30天（因为还没满一个月）
 */
function breakdown(from, to) {
  var y = to.getFullYear() - from.getFullYear()
  var mo = to.getMonth() - from.getMonth()
  var d = to.getDate() - from.getDate()

  if (d < 0) {
    mo--
    // 借上一个月的天数
    var prevMonth = new Date(to.getFullYear(), to.getMonth(), 0)
    d += prevMonth.getDate()
  }
  if (mo < 0) {
    y--
    mo += 12
  }
  return { years: y, months: mo, days: d }
}

/**
 * 主计算。
 * @param {string|Date} startInput 恋爱开始日
 * @param {string|Date} [todayInput] 今天（默认取当前时间，便于测试与预览）
 */
function compute(startInput, todayInput) {
  var start = parseDate(startInput)
  if (!start) return null

  var today = parseDate(todayInput) || parseDate(new Date())
  var totalDays = daysBetween(start, today)

  // 开始日在未来：没有可算的，直接返回零值。
  // 之前会让它继续走倒计时逻辑，显示成"0周年 还有1天 进度99%"，很怪。
  if (totalDays < 0) {
    return {
      startKey: toKey(start),
      startLabel: start.getFullYear() + '年' + (start.getMonth() + 1) + '月' + start.getDate() + '日',
      notStarted: true,
      totalDays: totalDays,
      years: 0, months: 0, days: 0,
      nextDateKey: '', nextDateLabel: '',
      nextYears: 0, nextYearsLabel: '',
      daysToNext: 0,
      isToday: false,
      progress: 0,
      progressPercent: 0
    }
  }

  var bd = breakdown(start, today)

  // 下一个周年：找到今年/明年的纪念日里第一个 >= 今天的
  var nextYear = today.getFullYear()
  var next = safeAnniversary(start, nextYear)
  if (daysBetween(today, next) < 0) {
    next = safeAnniversary(start, nextYear + 1)
  }
  var daysToNext = daysBetween(today, next)
  var nextYears = next.getFullYear() - start.getFullYear()

  // 进度：上一个周年 → 下一个周年 之间走了多少
  var prev = safeAnniversary(start, next.getFullYear() - 1)
  var span = daysBetween(prev, next)
  var passed = daysBetween(prev, today)
  var progress = span > 0 ? Math.max(0, Math.min(1, passed / span)) : 0

  var nextDateKey = toKey(next)
  var onAnniversaryToday = nextDateKey === toKey(today)

  // 周年称呼 = 下一个纪念日的届数 = next 的年份 − 开始日年份。
  // 这一个公式同时覆盖三种情况，不要再拿 bd.years 或 nextYears 混着算：
  //   2023-05-20 起，下一个是 2027-05-20 → 4周年（不管今天已过几年）
  //   2025-05-20 起，今天正是 2026-05-20 → next 就是今天 → 一周年
  //   2024-02-29 起，非闰年提前到 2026-02-28 → next 的年份是 2026 → 两周年
  var yearsCounted = next.getFullYear() - start.getFullYear()
  if (yearsCounted < 1) yearsCounted = 1
  var yearsLabel = yearsCounted === 1 ? '一周年' :
    (yearsCounted === 2 ? '两周年' : yearsCounted + '周年')

  // 进度上限压到 99%：否则纪念日前一天显示 100%，第二天又掉回 4%，
  // 看起来像 bug。真正到纪念日当天才显示 100%。
  var percent = Math.round(progress * 100)
  if (!onAnniversaryToday && percent > 99) percent = 99
  if (onAnniversaryToday) percent = 100

  return {
    startKey: toKey(start),
    todayKey: toKey(today),
    startLabel: start.getFullYear() + '年' + (start.getMonth() + 1) + '月' + start.getDate() + '日',
    notStarted: false,
    totalDays: totalDays,
    years: bd.years,
    months: bd.months,
    days: bd.days,
    nextDateKey: nextDateKey,
    nextDateLabel: (next.getMonth() + 1) + '月' + next.getDate() + '日',
    nextYears: nextYears,
    nextYearsLabel: yearsLabel,
    daysToNext: daysToNext,
    /** 今天就是纪念日 */
    isToday: onAnniversaryToday,
    progress: progress,
    progressPercent: percent
  }
}

/** 处理 2 月 29 日：非闰年回退到 2 月 28 日 */
function safeAnniversary(start, year) {
  var mo = start.getMonth()
  var d = start.getDate()
  var dt = new Date(year, mo, d)
  if (dt.getMonth() !== mo) dt = new Date(year, mo + 1, 0) // 该月最后一天
  return dt
}

var api = {
  parseDate: parseDate,
  toKey: toKey,
  daysBetween: daysBetween,
  breakdown: breakdown,
  compute: compute
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api
}
if (typeof window !== 'undefined') {
  window.Anniversary = api
}
