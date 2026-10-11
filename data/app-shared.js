/**
 * 把「两人的共享数据」接到加密同步上（一个很小的适配层）
 * ============================================================
 * 背景（这是用户真实报的 bug，2026-10-11）：
 *   纪念日「对方改了，我这边看不到」、相册「两台手机不同步」——
 *   因为这两样东西走的是 data/shared-data.js / data/album.js 的
 *   localStorage + `storage` 事件。**那只在同一台电脑的两个窗口之间生效**
 *   （同一台设备共享一个 localStorage）。两台手机各有各的 localStorage，
 *   中间没有任何通道，所以永远同步不了。
 *
 *   只有散步在 data/app-state.js 里的那几样（心情 / 日记 / 悄悄话）
 *   走了私有 Gist 的加密同步，所以那几样两台手机是真通的。
 *
 * 本文件做的事：**不动任何一个模块的代码**，只在启动时把它们的读写
 * 接到 AppState 上（AppState 已经是唯一那份会加密同步的状态）：
 *
 *   纪念日 / 小猪 / 例假  → SharedData.attachApp(app)   （provider 切到 'app'）
 *   相册                  → Album.setStore({readAll, writeAll})
 *
 * ⚠️ 两个都**保留了 localStorage 的退路**：
 *    - appState 还没从云端拉回来（刚打开那几秒）→ 先显示本机旧值，别闪空白
 *    - 完全没配对时 AppState 里也有数据，一样能读能写
 *
 * 加载顺序：必须在 app-state.js 之后、各页面脚本 init 之前。
 */

/* global SharedData, Album */
;(function (root) {
  'use strict'

  function attachShared(app) {
    var SD = root.SharedData
    if (!SD || !app || !app.state) return false
    if (typeof SD.attachApp === 'function') {
      SD.attachApp(app)
      return true
    }
    return false
  }

  function attachAlbum(app) {
    var A = root.Album
    if (!A || !app) return false
    if (app.attachAlbum) return app.attachAlbum(A)
    if (typeof A.setStore === 'function') {
      return A.setStore({
        readAll: function () { return app.albumPhotos() },
        writeAll: function (arr) { return app.setAlbumPhotos(arr) }
      })
    }
    return false
  }

  function attach(app) {
    var ok = { shared: false, album: false }
    try { ok.shared = attachShared(app) } catch (e) { console.error('[app-shared] 共享层挂载失败', e) }
    try { ok.album = attachAlbum(app) } catch (e) { console.error('[app-shared] 相册挂载失败', e) }
    return ok
  }

  var api = { attach: attach, attachShared: attachShared, attachAlbum: attachAlbum }
  root.AppShared = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof self !== 'undefined' ? self : this)
