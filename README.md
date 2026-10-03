# 星海抽卡 · Starfall Gacha

一个零依赖的浏览器抽卡小游戏。单个静态页面，双击就能玩，也可以直接部署到 GitHub Pages。

## 在线试玩

**https://jujishou.github.io/jujishou/**

由 GitHub Pages 托管，HTTPS 已强制开启。

## 功能

- **单抽 / 十连**：结果卡片 3D 翻牌，逐张错开亮起，支持空格键单抽
- **概率**：SSR 0.6% / SR 5.1% / R 94.3%
- **双保底**：90 抽必出 SSR，10 抽必出 SR —— 十连永远至少一张紫色
- **18 个角色**：4 SSR / 6 SR / 8 R，用 emoji 当立绘，不依赖任何图片资源
- **演出**：SSR 出货屏幕爆闪 + 金色呼吸流光；音效由 WebAudio 实时合成，无需音频文件，可静音
- **本地存档**：抽卡记录、出金率、保底进度存进 localStorage，刷新不丢；可一键重置

## 本地运行

无需构建、无需安装依赖。

```bash
# 方式一：直接打开
open index.html          # macOS
xdg-open index.html      # Linux

# 方式二：起个静态服务器（可选）
python3 -m http.server 8000
# 然后访问 http://localhost:8000
```

## 文件结构

```
.
├── index.html   # 页面结构
├── style.css    # 样式与动画
└── app.js       # 卡池、概率保底、渲染、音效、存档
```

## 概率说明

| 稀有度 | 基础概率 | 保底 |
| --- | --- | --- |
| SSR | 0.6% | 90 抽必出 |
| SR | 5.1% | 10 抽必出 |
| R | 94.3% | — |

因为硬保底的存在，**长期综合出金率约为 1.41%**，高于 0.6% 的基础概率（约 71 抽一张 SSR）。页面统计面板里的「出金率」显示的是实际滚出来的值。

## 部署到 GitHub Pages

本仓库已经部署在 **https://jujishou.github.io/jujishou/**。

自己重新部署的话：

1. 把仓库推到 GitHub（公开仓库，私有仓库的 Pages 需要 Pro）
2. 仓库 `Settings` → `Pages`
3. `Source` 选 `Deploy from a branch`，分支选 `main`，目录选 `/ (root)`
4. 等一两分钟即可访问

页面里的 `style.css` 和 `app.js` 都是相对路径引用，所以放在 `用户名.github.io/仓库名/` 这种子路径下也能正常工作（已实测验证）。

## 说明

仅供娱乐，没有任何真实消费和充值。卡池角色均为虚构。
