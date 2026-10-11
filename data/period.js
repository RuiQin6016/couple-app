/**
 * 例假模块 · 数据模型与预测逻辑
 *
 * 同时兼容 Node（小程序端 / 测试）、微信小程序、浏览器（预览页），
 * 写法照 quotes.js / anniversary.js：末尾 module.exports + window 双写。
 *
 * 设计要点（对应交接文档 §4 / §5）：
 *   1. 每日记录按日期键存，键 = 'YYYY-MM-DD'
 *   2. 预测依赖的是「经期开始日」，不是「哪天打过卡」——
 *      某天出血、且前一天不出血，这天即一次经期开始日（见 detectStarts）
 *   3. 平均周期优先用历史记录算出的实际平均，设置里的 28 天只是兜底
 *   4. 周期异常（< 21 或 > 35 天）不硬算，给出确认提示
 *   5. 日期运算一律复用 anniversary.js 的 parseDate / toKey / daysBetween
 *   6. 不做排卵期 / 易孕期断言（精度不足以支撑避孕备孕，误导性强）
 */

/* ============ 常量与选项表 ============ */

/** 月经量：少 / 中 / 多 / 无 */
var FLOW_OPTIONS = [
  { key: 'little', label: '少' },
  { key: 'medium', label: '中' },
  { key: 'heavy',  label: '多' },
  { key: 'none',   label: '无' }
]

/** 症状（多选）：参考图 8 项 + 常见补充项 */
var SYMPTOM_OPTIONS = [
  { key: 'cramp',      label: '腹痛' },
  { key: 'backache',   label: '腰酸' },
  { key: 'headache',   label: '头痛' },
  { key: 'breast',     label: '乳房胀' },
  { key: 'nausea',     label: '恶心' },
  { key: 'fatigue',    label: '疲劳' },
  { key: 'bloating',   label: '腹胀' },
  { key: 'insomnia',   label: '失眠' },
  // ↓ 补充项
  { key: 'appetite',   label: '食欲变化' },
  { key: 'loose',      label: '腹泻' },
  { key: 'acne',       label: '长痘' }
]

/** 情绪（多选，带 emoji）：参考图 6 项 + 常见补充项 */
var MOOD_OPTIONS = [
  { key: 'happy',      label: '开心',  emoji: '😄' },
  { key: 'calm',       label: '平静',  emoji: '😌' },
  { key: 'low',        label: '低落',  emoji: '😔' },
  { key: 'irritable',  label: '烦躁',  emoji: '😫' },
  { key: 'tired',      label: '疲惫',  emoji: '😪' },
  { key: 'unwell',     label: '不舒服', emoji: '🤢' },
  // ↓ 补充项
  { key: 'expect',     label: '期待',  emoji: '😊' },
  { key: 'meh',        label: '无所谓', emoji: '😐' }
]

/** 设置默认值 */
var DEFAULT_SETTINGS = { cycleLength: 28, periodLength: 7 }

/** 医学上常用的正常周期参考范围，超出就提示确认 */
var CYCLE_MIN = 21
var CYCLE_MAX = 35

/** 算平均时最多取最近几次间隔，避免半年前的异常值一直拖着不走 */
var AVG_MAX_INTERVALS = 6

/** 参考资料中最多展示多少个月的日历 */
var CAL_MONTHS = 6

/** 出血的 flow 值（'none' 不算出血） */
var BLEEDING = ['little', 'medium', 'heavy']

/* ============ 基础工具 ============ */

function hasBleeding(flow) {
  return BLEEDING.indexOf(flow) >= 0
}

/** 日期加天数，返回 Date 或 null。用 Date 构造器做进位，跨月跨年自动正确 */
function addDays(dateKey, n) {
  var d = parseKey(dateKey)
  if (!d) return null
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

/** 展示用：2026年6月3日 */
function formatDateCN(dateKey) {
  var d = parseKey(dateKey)
  if (!d) return ''
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

/** 展示用：6月3日 */
function formatMD(dateKey) {
  var d = parseKey(dateKey)
  if (!d) return ''
  return (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

/**
 * 日期解析 / 格式化：优先用 anniversary.js 的实现（已过 8 项断言测试，含闰日跨年），
 * 它没加载时退化为本地实现，保证本文件单独 require 也能跑测试。
 */
function parseKey(dateKey) {
  if (typeof Anniversary !== 'undefined' && Anniversary.parseDate) {
    return Anniversary.parseDate(dateKey)
  }
  if (dateKey instanceof Date) {
    if (isNaN(dateKey.getTime())) return null
    return new Date(dateKey.getFullYear(), dateKey.getMonth(), dateKey.getDate())
  }
  if (typeof dateKey !== 'string') return null
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateKey.trim())
  if (!m) return null
  var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  var dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}

function keyOf(d) {
  if (typeof Anniversary !== 'undefined' && Anniversary.toKey) return Anniversary.toKey(d)
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
}

function diffDays(aKey, bKey) {
  if (typeof Anniversary !== 'undefined' && Anniversary.daysBetween) {
    var a = parseKey(aKey), b = parseKey(bKey)
    if (!a || !b) return null
    return Anniversary.daysBetween(a, b)
  }
  var x = parseKey(aKey), y = parseKey(bKey)
  if (!x || !y) return null
  return Math.round((y.getTime() - x.getTime()) / 86400000)
}

/** 今天（本地时区）的日期键。_todayOverride 只给测试/预览用 */
var _todayOverride = null

function todayKey(now) {
  if (now) return keyOf(parseKey(now))
  if (_todayOverride) return _todayOverride
  return keyOf(parseKey(new Date()))
}

/**
 * 强制指定"今天"，传 null 恢复系统时间。
 * 只给测试与预览用（生产代码不要调）。
 */
function setToday(dateKey) {
  if (dateKey === null || dateKey === undefined) { _todayOverride = null; return null }
  var d = parseKey(dateKey)
  _todayOverride = d ? keyOf(d) : null
  return _todayOverride
}

function getTodayOverride() { return _todayOverride }

/* ============ 选项表查询 ============ */

function findOption(list, key) {
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === key) return list[i]
  }
  return null
}

function flowLabel(key) {
  var o = findOption(FLOW_OPTIONS, key)
  return o ? o.label : ''
}

function symptomLabel(key) {
  var o = findOption(SYMPTOM_OPTIONS, key)
  return o ? o.label : ''
}

function moodOption(key) {
  return findOption(MOOD_OPTIONS, key)
}

/** 把 key 数组翻译成中文标签数组，未知 key 直接丢掉 */
function labelsOf(list, keys) {
  var out = []
  if (!keys || !keys.length) return out
  for (var i = 0; i < keys.length; i++) {
    var o = findOption(list, keys[i])
    if (o) out.push(o.label)
  }
  return out
}

/** 情绪带 emoji：😫 烦躁 */
function moodText(key) {
  var o = moodOption(key)
  if (!o) return ''
  return o.emoji + ' ' + o.label
}

/* ============ 记录 / 设置的规范化与读写 ============ */

/** 只保留选项表里认得的 key，去重，顺序按选项表 */
function cleanKeys(list, keys) {
  if (!keys) return []
  var input = keys instanceof Array ? keys : [keys]
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (input.indexOf(list[i].key) >= 0) out.push(list[i].key)
  }
  return out
}

/**
 * 补齐一条每日记录的字段，非法输入返回 null。
 * @param {string} dateKey 'YYYY-MM-DD'
 * @param {object} data 任意子集
 */
function normalizeLog(dateKey, data) {
  if (!parseKey(dateKey)) return null
  var d = data || {}
  var flow = findOption(FLOW_OPTIONS, d.flow) ? d.flow : ''
  return {
    dateKey: dateKey,
    flow: flow,
    symptoms: cleanKeys(SYMPTOM_OPTIONS, d.symptoms),
    moods: cleanKeys(MOOD_OPTIONS, d.moods),
    note: typeof d.note === 'string' ? d.note.slice(0, 200) : '',
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
    updatedBy: typeof d.updatedBy === 'string' ? d.updatedBy : ''
  }
}

/** 一条记录是否算「有内容」，空记录不入库 */
function isLogEmpty(log) {
  if (!log) return true
  return !log.flow && !log.symptoms.length && !log.moods.length && !log.note
}

function normalizeSettings(data) {
  var d = data || {}
  var cyc = parseInt(d.cycleLength, 10)
  var per = parseInt(d.periodLength, 10)
  if (!(cyc >= 15 && cyc <= 60)) cyc = DEFAULT_SETTINGS.cycleLength
  if (!(per >= 1 && per <= 15)) per = DEFAULT_SETTINGS.periodLength
  return {
    cycleLength: cyc,
    periodLength: per,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
    updatedBy: typeof d.updatedBy === 'string' ? d.updatedBy : ''
  }
}

/** 共享层是否可用（单独跑 Node 测试时没有 SharedData） */
function shared() {
  if (typeof SharedData !== 'undefined' && SharedData) return SharedData
  if (typeof window !== 'undefined' && window.SharedData) return window.SharedData
  return null
}

/**
 * 存一天的记录；全空的记录 = 删除。
 * @returns {object|null} 存进去的记录，删除时返回 null
 */
function saveLog(dateKey, data, uid) {
  var log = normalizeLog(dateKey, data)
  if (!log) return null
  log.updatedAt = Date.now()
  log.updatedBy = uid || ''
  var s = shared()
  if (!s) return log // 还没接共享层：调用方可自行落本地
  if (isLogEmpty(log)) { s.removePeriodLog(dateKey); return null }
  s.setPeriodLog(uid, dateKey, log)
  return log
}

/** 读一天的记录，没有则返回一条空白模板（方便直接绑到表单） */
function loadLog(dateKey) {
  var s = shared()
  var raw = s ? s.getPeriodLog(dateKey) : null
  return normalizeLog(dateKey, raw || {}) || normalizeLog(dateKey, {})
}

function saveSettings(data, uid) {
  var st = normalizeSettings(data)
  st.updatedAt = Date.now()
  st.updatedBy = uid || ''
  var s = shared()
  if (s) s.setPeriodSettings(st)
  return st
}

function loadSettings() {
  var s = shared()
  var raw = s ? s.getPeriodSettings() : null
  return normalizeSettings(raw || {})
}

/** 取全部记录（已规范化、按日期升序），格式为 { 'YYYY-MM-DD': log } */
function loadLogs() {
  var s = shared()
  var all = s ? s.getPeriodLogs() : {}
  var out = {}
  var keys = Object.keys(all || {})
  for (var i = 0; i < keys.length; i++) {
    var log = normalizeLog(keys[i], all[keys[i]])
    if (log && !isLogEmpty(log)) out[keys[i]] = log
  }
  return out
}

/* ============ 经期开始日识别（预测的基础） ============ */

/**
 * 某天出血，且前一天没出血 → 这天是一次经期开始日。
 * 只看出血与否，不看量多量少；「无」和没记录都算不出血。
 *
 * @param {object} logs { 'YYYY-MM-DD': log }
 * @returns {string[]} 升序的开始日键
 */
function detectStarts(logs) {
  var keys = Object.keys(logs || {}).sort()
  var starts = []
  for (var i = 0; i < keys.length; i++) {
    var log = logs[keys[i]]
    if (!log || !hasBleeding(log.flow)) continue
    var prevKey = keyOf(addDays(keys[i], -1))
    var prev = logs[prevKey]
    if (prev && hasBleeding(prev.flow)) continue // 连着出血 = 同一次经期
    starts.push(keys[i])
  }
  return starts
}

/**
 * 用实际记录算平均周期。
 *
 * @param {string[]} starts detectStarts 的结果，必须升序
 * @returns {{average:number|null, intervals:number[], used:number[], state:string, sampleCount:number}}
 *   state: 'none' 不足两次 | 'ok' 正常 | 'abnormal' 超出 21~35
 */
function computeAverageCycle(starts) {
  var list = (starts || []).slice().sort()
  var intervals = []
  for (var i = 1; i < list.length; i++) {
    var gap = diffDays(list[i - 1], list[i])
    if (gap && gap > 0) intervals.push(gap)
  }
  var used = intervals.slice(-AVG_MAX_INTERVALS)
  if (!used.length) {
    return { average: null, intervals: intervals, used: [], state: 'none', sampleCount: 0 }
  }
  var sum = 0
  for (var j = 0; j < used.length; j++) sum += used[j]
  var avg = Math.round(sum / used.length)
  return {
    average: avg,
    intervals: intervals,
    used: used,
    state: (avg < CYCLE_MIN || avg > CYCLE_MAX) ? 'abnormal' : 'ok',
    sampleCount: used.length
  }
}

/* ============ 预测 ============ */

/**
 * 主预测。
 *
 * @param {object} logs 每日记录
 * @param {object} settings { cycleLength, periodLength }
 * @param {string|Date} [now] 今天，便于测试与预览
 * @returns {object} 见下方 return，字段都做了兜底，UI 可直接用
 */
function computePrediction(logs, settings, now) {
  var st = normalizeSettings(settings)
  var all = logs || {}
  var today = todayKey(now)
  var starts = detectStarts(all)
  var avg = computeAverageCycle(starts)

  // 周期取值的优先级：历史实际平均 → 设置值
  var cycleSource = 'setting'
  var cycleDays = st.cycleLength
  if (avg.average) { cycleDays = avg.average; cycleSource = 'history' }

  // 按出血记录算出「今天是经期第几天」
  var dayOfPeriod = 0
  var bleedingToday = hasBleeding((all[today] || {}).flow)
  if (bleedingToday) {
    var cursor = today
    for (var guard = 0; guard < 30; guard++) {
      dayOfPeriod++
      var prevKey = keyOf(addDays(cursor, -1))
      var prev = all[prevKey]
      if (prev && hasBleeding(prev.flow)) cursor = prevKey
      else break
    }
  }

  var base = {
    today: today,
    starts: starts,
    startCount: starts.length,
    lastStart: starts.length ? starts[starts.length - 1] : '',
    lastStartLabel: starts.length ? formatDateCN(starts[starts.length - 1]) : '',
    averageCycle: avg.average,
    cycleIntervals: avg.intervals,
    cycleUsed: avg.used,
    cycleSampleCount: avg.sampleCount,
    cycleState: avg.state,          // 'none' | 'ok' | 'abnormal'
    cycleDays: cycleDays,
    cycleSource: cycleSource,       // 'history' | 'setting'
    periodLength: st.periodLength,
    dayOfPeriod: dayOfPeriod,
    bleedingToday: bleedingToday,
    /** 周期异常时不该硬显示天数，由 UI 拿这个标记改成提示 */
    needsConfirm: avg.state === 'abnormal',
    lowSample: starts.length < 2
  }

  if (!starts.length) {
    return Object.assign(base, {
      ready: false,
      reason: 'no-record',        // 一次都没记
      nextStart: '',
      daysToNext: null
    })
  }

  var next = addDays(base.lastStart, cycleDays)
  var nextKey = keyOf(next)
  var daysToNext = diffDays(today, nextKey)

  // 每个周期窗口内的经期结束日（含前后各留一点，方便日历上色）
  var windowEnd = keyOf(addDays(nextKey, st.periodLength - 1))

  return Object.assign(base, {
    ready: true,
    nextStart: nextKey,
    nextStartLabel: formatDateCN(nextKey),
    nextStartMD: formatMD(nextKey),
    nextEnd: windowEnd,
    daysToNext: daysToNext,
    isOverdue: daysToNext < 0,
    isToday: daysToNext === 0,
    // 早于今天的预测（已经该来了却没记录）不当作"还有 N 天"
    overdueDays: daysToNext < 0 ? -daysToNext : 0
  })
}

/**
 * 逐天标注每个日期属于什么状态，供日历上色。
 *
 * @returns {object} { 'YYYY-MM-DD': 'period' | 'predicted' | 'pms' }
 *   period    已记录的经期日（真实数据）
 *   predicted 预测的经期日（推算，视觉上必须和真实数据区分开）
 *   pms       经期前 3 天，用于提示注意休息
 */
function markCalendar(logs, prediction, fromKey, toKey2) {
  var marks = {}
  var all = logs || {}
  var keys = Object.keys(all)
  for (var i = 0; i < keys.length; i++) {
    if (hasBleeding(all[keys[i]].flow)) marks[keys[i]] = 'period'
  }

  var p = prediction
  if (p && p.ready && p.nextStart) {
    var len = p.periodLength || 7
    for (var k = 0; k < len; k++) {
      var dk = keyOf(addDays(p.nextStart, k))
      if (!marks[dk]) marks[dk] = 'predicted'
    }
    // 预测日前后留 3 天 PMS 提示，已被真实/预测覆盖的不改
    for (var b = 1; b <= 3; b++) {
      var back = keyOf(addDays(p.nextStart, -b))
      if (!marks[back]) marks[back] = 'pms'
    }
  }

  if (fromKey && toKey2) {
    var out = {}
    for (var key in marks) {
      if (key >= fromKey && key <= toKey2) out[key] = marks[key]
    }
    return out
  }
  return marks
}

/**
 * 给日历用：从某月开始的 months 个月，每天的状态。
 * 只用于渲染，不做任何医学判断。
 */
function buildCalendar(monthKey, logs, prediction, months) {
  var d = parseKey(monthKey + '-01')
  if (!d) return []
  var n = months || 1
  var out = []
  for (var i = 0; i < n; i++) {
    var y = d.getFullYear()
    var mo = d.getMonth() + i
    var first = new Date(y, mo, 1)
    var daysInMonth = new Date(y, mo + 1, 0).getDate()
    var fromKey = keyOf(first)
    var toKey2 = keyOf(new Date(y, mo, daysInMonth))
    var marks = markCalendar(logs, prediction, fromKey, toKey2)
    var days = []
    for (var day = 1; day <= daysInMonth; day++) {
      var k = keyOf(new Date(y, mo, day))
      days.push({
        key: k,
        day: day,
        mark: marks[k] || '',
        isToday: k === (prediction && prediction.today)
      })
    }
    // 每月 1 号是周几，用于首行留白（0=周日）
    out.push({
      monthKey: first.getFullYear() + '-' + String(first.getMonth() + 1).padStart(2, '0'),
      label: (first.getMonth() + 1) + '月',
      year: first.getFullYear(),
      firstWeekday: first.getDay(),
      days: days
    })
  }
  return out
}

/* ============ 给 UI 的一句话结论 ============ */

/**
 * 把预测翻译成一句人话 + 一个状态色。
 * @returns {{tone:string, text:string, sub:string}}
 *   tone: 'idle' 无数据 | 'active' 经期中 | 'soon' 快到了 | 'overdue' 推迟
 *         | 'today' 就是今天 | 'waiting' 等待更多数据 | 'abnormal' 周期异常
 */
function summaryOf(prediction) {
  var p = prediction
  if (!p || !p.ready) {
    return {
      tone: 'idle',
      text: '还没有记录',
      sub: '记满 2 次经期后，会自动按你的实际周期校准预测'
    }
  }

  if (p.needsConfirm) {
    return {
      tone: 'abnormal',
      text: '周期看起来不太规律',
      sub: '算出的平均周期是 ' + p.cycleDays + ' 天，超出 21~35 天。' +
           '如果最近作息或身体有变化，可以先手动把「平均周期天数」改成平时的值'
    }
  }

  if (p.bleedingToday) {
    return {
      tone: 'active',
      text: '经期第 ' + p.dayOfPeriod + ' 天',
      sub: '多喝温水，注意保暖，别熬夜'
    }
  }

  var tail = p.lowSample ? '记录满 2 次后会按你的实际周期自动校准' : ''

  if (p.isToday) {
    return { tone: 'today', text: '预计今天来', sub: tail || '提前备好卫生用品和热水袋' }
  }
  if (p.isOverdue) {
    return {
      tone: 'overdue',
      text: '比预计晚了 ' + p.overdueDays + ' 天',
      sub: '预测只是按平均周期推算，推迟几天很常见；不用紧张，持续异常再就医'
    }
  }
  if (p.daysToNext <= 3) {
    return { tone: 'soon', text: '还有 ' + p.daysToNext + ' 天', sub: tail || '这几天可能会有点不舒服，提前放松一点' }
  }
  return {
    tone: 'waiting',
    text: '还有 ' + p.daysToNext + ' 天',
    sub: tail || ('预计 ' + p.nextStartMD + ' 开始')
  }
}

/* ============ 经期护理指南（文案自写，不抄参考图） ============ */

var CARE_GUIDE = [
  {
    key: 'diet',
    icon: '🍽',
    title: '饮食',
    lines: [
      '多喝温水，少量多次比一次灌一大杯舒服',
      '瘦肉、蛋、深绿叶菜补一补铁，别空腹喝浓咖啡和冰饮',
      '想吃甜的可以吃，但别拿甜食顶一顿正餐'
    ]
  },
  {
    key: 'warm',
    icon: '🧣',
    title: '保暖',
    lines: [
      '肚子和后腰别受凉，热水袋隔着衣服敷十几分钟就够',
      '洗完头尽快吹干，别湿着头发吹冷风',
      '空调房里搭一件薄外套，比硬扛着强'
    ]
  },
  {
    key: 'move',
    icon: '🚶',
    title: '运动',
    lines: [
      '散步、拉伸、温和瑜伽这类轻活动，反而能缓解坠胀感',
      '量大的前一两天别硬练，跑跳和卷腹先放一放',
      '不舒服就休息，没有必须完成的任务量'
    ]
  },
  {
    key: 'mood',
    icon: '💗',
    title: '情绪',
    lines: [
      '这几天容易烦躁、掉眼泪，是激素在波动，不是矫情',
      '想说的话直接说出来，让对方知道你需要的是陪伴还是安静',
      '睡够比什么都管用，熬夜会把情绪放大一倍'
    ]
  },
  {
    key: 'tips',
    icon: '📌',
    title: '注意事项',
    lines: [
      '卫生巾、棉条勤换，量少也别超过 4~6 小时',
      '量突然大到一两小时就浸透、或痛到影响正常生活，请去医院',
      '连续几个月周期都乱、或经期超过 10 天，建议挂号查一下'
    ]
  }
]

/** 免责声明：护理指南卡底部必须有这一行 */
var CARE_DISCLAIMER = '仅供参考，不构成医疗建议，身体不适请就医'

/**
 * 预测口径说明。UI 上必须和真实数据分开显示，
 * 不做排卵期 / 易孕期断言。
 */
var PREDICT_NOTE = '预测按平均周期估算，只作提醒用，不可用于避孕或备孕决策'

/* ============ 导出 ============ */

var api = {
  // 选项表
  FLOW_OPTIONS: FLOW_OPTIONS,
  SYMPTOM_OPTIONS: SYMPTOM_OPTIONS,
  MOOD_OPTIONS: MOOD_OPTIONS,
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  CYCLE_MIN: CYCLE_MIN,
  CYCLE_MAX: CYCLE_MAX,
  CARE_GUIDE: CARE_GUIDE,
  CARE_DISCLAIMER: CARE_DISCLAIMER,
  PREDICT_NOTE: PREDICT_NOTE,

  // 工具
  addDays: addDays,
  formatDateCN: formatDateCN,
  formatMD: formatMD,
  todayKey: todayKey,
  setToday: setToday,
  getTodayOverride: getTodayOverride,
  hasBleeding: hasBleeding,
  flowLabel: flowLabel,
  symptomLabel: symptomLabel,
  moodText: moodText,
  labelsOf: labelsOf,
  findOption: findOption,

  // 记录 / 设置
  normalizeLog: normalizeLog,
  normalizeSettings: normalizeSettings,
  isLogEmpty: isLogEmpty,
  saveLog: saveLog,
  loadLog: loadLog,
  loadLogs: loadLogs,
  saveSettings: saveSettings,
  loadSettings: loadSettings,

  // 预测
  detectStarts: detectStarts,
  computeAverageCycle: computeAverageCycle,
  computePrediction: computePrediction,
  markCalendar: markCalendar,
  buildCalendar: buildCalendar,
  summaryOf: summaryOf
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api
}
if (typeof window !== 'undefined') {
  window.Period = api
}
