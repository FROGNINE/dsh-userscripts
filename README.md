# B站 · 自动网页全屏 / 最高画质 / 视频二倍速 / 屏蔽小橙车弹窗

一个用户脚本，同时管好 B站直播和视频两类页面。

| 页面 | 自动做的事 |
| --- | --- |
| 直播间 `live.bilibili.com` | 网页全屏 · 切到最高画质 · 清掉小橙车（购物车）提示框 |
| 视频页 `www.bilibili.com/video/…` | 网页全屏 · 二倍速 |

站内切换直播间、切换视频 / 换分P / 换集时都会自动重新应用，不用手动刷新。

支持的页面：`live.bilibili.com`、`/video/`、`/list/`、`/bangumi/play/`、`/medialist/play/`、`/festival/`

## 安装

**[从 Greasy Fork 安装](https://greasyfork.org/zh-CN/scripts)**（推荐，可自动更新）

或直接用本仓库的文件：

1. 先装脚本管理器：[脚本猫 ScriptCat](https://microsoftedge.microsoft.com/addons/detail/scriptcat/liilgpjgabokdklappibcjfablkpcexlc) 或 [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
2. 装脚本：打开 [`bilibili-live-helper.user.js`](bilibili-live-helper.user.js) 后点 Raw，脚本管理器会拦截并弹出安装页

> 装之前已经打开的 B站页面需要**刷新一次**才会加载脚本。

## 可调参数

用文本编辑器打开脚本，改文件顶部的 `CFG`：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `webFullscreen` | `true` | 网页全屏总开关（直播 + 视频） |
| `maxQuality` | `true` | 直播间自动最高画质 |
| `killCartTip` | `true` | 清小橙车提示框 |
| `videoWebFullscreen` | `true` | 视频页自动网页全屏 |
| `videoPlaybackRate` | `2` | 视频页倍速，`0` = 不自动改 |
| `respectUserExit` | `true` | 你手动退出全屏后不抢回来 |
| `pollInterval` | `2500` | 轮询间隔（毫秒） |

## 已知行为（不是 bug）

- **画质**：B站会记住每个直播间上次的画质。如果本来就是最高档，脚本不会去点画质面板，避免打断你；只有真的不是最高档时才切换。
- **全屏**：手动退出后不再抢回来；但换视频 / 换直播间会重新进一次。
- **音量 / 弹幕**：脚本不碰，保持你自己的设置。

## 实现要点

B站直播页和视频页是两套完全不同的播放器，脚本按 hostname 和路径分流：

- **直播（`bilibili-live-player`，Svelte）**
  - 网页全屏：进入后 `<body>` 带 `player-full-win`
  - 画质：`window.livePlayer.getPlayerInfo()` 拿当前档位，`switchQuality()` 切换。实测这版对外 API 静默无效，所以主力是「派发 `mouseenter` 唤出画质面板 → 点档位」。面板只认 `mouseenter`，`pointerenter` 不行。
  - 「自动」是假档位（`qn = -1`），必须过滤掉，否则会点到自动。
- **视频（`bpx` 播放器）**
  - 网页全屏：点 `.bpx-player-ctrl-web`，进入后 `<body>` 带 `webscreen-fix`
  - 倍速：`window.player.setPlaybackRate(2)`，失败兜底改 `<video>.playbackRate`，设完回读校验

## 隐私

`@grant none`，不使用任何 GM_* 权限，不发起网络请求，不读取账号信息。纯本地 DOM 操作。

## License

[MIT](LICENSE)
