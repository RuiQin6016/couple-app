// 积分商城 · 商品数据与价格格式化
//
// 为什么单独一个文件：这段数据原来内联在 prototype/index.html 里，
// 小程序端要移植就得再抄一份 —— 而商城价格是最需要两人商量着改的东西，
// 抄两份必然走偏。抽到这里，两个端 require 同一份。
//
// 约定：
//   price 写成**字符串**，小数原样保留（'52.0' / '5.2' / '13.14' / '0'）
//   icon  + tile 决定缩略图：小程序端用 assets/mall/<icon>-<tile>.png，
//         原型端用内联 SVG 符号 #g-ic-<icon>（两边同一套图形，见下）
//   **同一个 id 出现在两个分类里 = 同一件商品**（比如"打语音"在线上陪伴和每日必点各出现一次），
//     兑换车里算同一行，数量共享
//
// 缩略图的 PNG 是**从原型的 SVG 图标渲染出来的**（不是另画一套）：
//   node tools/gen-mall-icons.js     ← 改了图标或配色后重跑
//   生成 assets/mall/<icon>-<tile>.png（288×288 透明底，实测 16 张共 129KB）

var MALL = [
  {
    cat: '线上陪伴',
    items: [
      { id: 'call',  name: '视频通话',       sub: '想聊多久聊多久',     price: '52.0',  icon: 'call',  tile: 't-pink' },
      { id: 'voice', name: '打语音',         sub: '要听见声音那种',     price: '52.0',  icon: 'voice', tile: 't-blue' },
      { id: 'game',  name: '叫对方打游戏',   sub: '陪打一局，不许摆烂', price: '52.0',  icon: 'game',  tile: 't-lilac' },
      { id: 'stay',  name: '想让对方陪自己', sub: '陪着我待一会儿',     price: '5.2',   icon: 'hug',   tile: 't-rose' },
      { id: 'sleep', name: '一起睡觉',       sub: '连麦睡到天亮',       price: '52.0',  icon: 'moon',  tile: 't-lilac' }
    ]
  },
  {
    cat: '每日必点',
    items: [
      { id: 'stay',  name: '陪陪我', sub: '就是"想让对方陪自己"', price: '5.2',  icon: 'hug',   tile: 't-rose' },
      { id: 'voice', name: '打语音', sub: '线上陪伴里那道，同一件', price: '52.0', icon: 'voice', tile: 't-blue' },
      { id: 'chat',  name: '聊天',   sub: '文字也行，聊够为止',    price: '5.2',  icon: 'chat',  tile: 't-pink' }
    ]
  },
  {
    cat: '投喂',
    items: [
      { id: 'treat-me', name: '我请宝宝',       sub: '我请客，不扣积分', price: '0',     icon: 'meal',  tile: 't-warm' },
      { id: 'treat-ta', name: '宝宝请我',       sub: 'TA 请客',          price: '13.14', icon: 'cake',  tile: 't-rose' },
      { id: 'snack-me', name: '我请宝宝吃零食', sub: '我买，不扣积分',   price: '0',     icon: 'snack', tile: 't-lilac' },
      { id: 'buy-me',   name: '我给宝宝买东西', sub: '我买，不扣积分',   price: '0',     icon: 'gift',  tile: 't-pink' },
      { id: 'snack-ta', name: '宝宝请我吃零食', sub: 'TA 买',            price: '13.14', icon: 'snack', tile: 't-rose' },
      { id: 'buy-ta',   name: '宝宝给我买东西', sub: 'TA 买',            price: '13.14', icon: 'gift',  tile: 't-rose' }
    ]
  },
  {
    cat: '亲密',
    items: [
      { id: 'together', name: '一起弄（懂的都懂）', sub: '不解释', price: '520', icon: 'kiss', tile: 't-rose' }
    ]
  },
  {
    cat: '终极大奖',
    items: [
      { id: 'meet', name: '见面（时间待定）', sub: '双方各付 5,200 积分', price: '5200', icon: 'medal', tile: 't-lilac' }
    ]
  }
]

/** 缩略图路径：icon + tile → assets/mall/<icon>-<tile>.png
    （tile 在数据里写 t-pink，令牌是 --tile-pink-bg，文件名用 pink） */
function iconSrc(icon, tile) {
  return '/assets/mall/' + icon + '-' + String(tile).replace(/^t-/, '') + '.png'
}

/** 千分位：12100 → 12,100，小数也认（10386.86 → 10,386.86） */
function fmt(n) {
  var v = (typeof n === 'number') ? Math.round(n * 100) / 100 : n
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 商品价按原文显示：'52.0' → 52.0，'5200' → 5,200（小数位不丢） */
function fmtPrice(p) {
  var s = String(p)
  var dot = s.indexOf('.')
  var head = dot >= 0 ? s.slice(0, dot) : s
  var tail = dot >= 0 ? s.slice(dot) : ''
  return fmt(head) + tail
}

/** 取某个分类的商品，并补好展示用字段（模板里不做计算）
    counts 可选：{ 商品id: 数量 }，会把已选数量带进 item.count，
    这样 WXML 里只写 {{item.count}}，不用在模板里做动态 key 取值
    （小程序 WXML 的表达式解析器比 JS 弱，复杂表达式容易编译不过） */
function itemsOf(catIndex, counts) {
  var g = MALL[catIndex]
  if (!g) return []
  var c = counts || {}
  return g.items.map(function (it) {
    return {
      id: it.id,
      name: it.name,
      sub: it.sub,
      tile: it.tile,
      icon: it.icon,
      iconSrc: iconSrc(it.icon, it.tile),
      count: c[it.id] || 0,
      priceText: fmtPrice(it.price),
      price: parseFloat(it.price) || 0
    }
  })
}

/** 左栏分类项：带 on 标记，模板里就不用写 activeCat === index 这种比较 */
function catList(activeIndex) {
  return MALL.map(function (g, i) {
    return { name: g.cat, on: i === (activeIndex || 0) }
  })
}

function catNames() {
  return MALL.map(function (g) { return g.cat })
}

/** 全部商品的 id → 商品（用来算兑换车总额） */
function priceMap() {
  var m = {}
  MALL.forEach(function (g) {
    g.items.forEach(function (it) { m[it.id] = parseFloat(it.price) || 0 })
  })
  return m
}

var api = {
  MALL: MALL,
  fmt: fmt,
  fmtPrice: fmtPrice,
  iconSrc: iconSrc,
  itemsOf: itemsOf,
  catList: catList,
  catNames: catNames,
  priceMap: priceMap
}

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.Mall = api
