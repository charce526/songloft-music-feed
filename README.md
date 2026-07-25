# 抖歌 songloft-music-feed

抖歌是一款面向 [Songloft](https://github.com/songloft-org/songloft) 的沉浸式本地音乐发现插件。它将本地音乐库整理成类似信息流的上下滑动播放界面，并根据播放、喜欢、不喜欢、收藏和跳过等行为持续学习，帮助用户重新发现自己的音乐收藏。

> 本插件由 AI 生成。欢迎通过 GitHub Issues 反馈使用中遇到的问题与改进建议。

## 关于 Songloft

[Songloft](https://github.com/songloft-org/songloft) 是本插件所依赖的音乐服务项目。本插件基于 Songloft 提供的插件能力开发，是独立维护的扩展项目，并非 Songloft 主程序的内置组件。

- 上游项目：[songloft-org/songloft](https://github.com/songloft-org/songloft)
- 插件 SDK：[songloft-org/plugin-toolchain](https://github.com/songloft-org/plugin-toolchain)
- 最低兼容版本：Songloft v2.11.0

## 功能亮点

### 沉浸式播放

- 大封面、背景虚化、歌词、进度条和右侧快捷按钮组成完整播放界面
- 支持上下滑动切歌，适配 PC 与移动端使用
- 支持播放、暂停、喜欢、不喜欢、用户收藏和播放进度展示

### 本地推荐

- 基于播放行为、长期兴趣和本次探索偏好生成推荐队列
- 综合歌手、专辑、流派、年代、语种、风格、来源类型、格式、时长和目录等多维特征
- 加入近期去重、探索比例和多样性约束，减少重复推荐和单一类型过度集中

### 收藏与反馈

- 喜欢、不喜欢和跳过会即时影响本次推荐队列
- 用户收藏状态与 Songloft 内置收藏歌单同步
- 支持重置插件内偏好数据，让推荐模型重新开始学习

### 历史统计

- 记录真实播放行为，展示常听歌手、类别和播放记录
- 偏好数据保存在 Songloft 插件本地存储中，不依赖外部服务器

## 安装

1. 下载最新版本：[songloft-music-feed-v1.4.5.jsplugin.zip](https://github.com/charce526/songloft-music-feed/releases/latest/download/songloft-music-feed-v1.4.5.jsplugin.zip)。
2. 打开 Songloft 插件管理页面。
3. 上传安装包并启用“抖歌”。

## 插件源

可以通过本仓库的插件源文件订阅：

```text
https://raw.githubusercontent.com/charce526/songloft-music-feed/main/registry.json
```

## 插件信息

| 项目 | 内容 |
| --- | --- |
| 插件名称 | 抖歌 |
| 包名 | `songloft-music-feed` |
| 当前版本 | `1.4.5` |
| 作者 | `charce526` |
| 许可证 | `Apache-2.0` |
| 最低宿主版本 | `2.11.0` |

## 本地构建

```bash
npm install
npm test
npm run build
npm run validate
```

构建后的插件安装包位于 `Release/` 目录。

## 许可证

本项目采用 [Apache License 2.0](./LICENSE) 开源许可证。Songloft 本身的授权与使用条款请以上游项目为准。
