# 验证记录

## 2026-11-20：地点 → 故事 → 照片重构

在独立的 Edge `tests/places-v3-profile` 配置目录中执行，未访问用户日常浏览器照片数据。

已验证：

- 模型：旧版 v1/v2 迁移、地点隔离、照片外键、故事封面归属、重复编号、非法日期、新地点保留。
- 真实浏览器：西安爱心默认可用；编辑故事不提前解锁；路线行驶中无青蛙，到站保存后仅对应地点出现一个青蛙。
- 地点故事：多故事卡片、上下排序、修改所属地点、不复制照片、详情返回同地点列表。
- 多图编辑：多选上传、追加、删除、替换、封面、顺序、照片说明均保存；损坏图片不覆盖现有内容。
- 持久化：完整刷新保留已解锁地点和新增地点；模拟写入失败不误解锁且可以重试。
- 迁移：直接将 v1 写入专用测试数据库后重新加载，验证 v3 照片内容逐项保留，且存在 `before-v3-migration` 原始副本。
- 分享：导出的独立 HTML 在独立文档启动、隐藏编辑入口、保留故事归属、可继续完成路线；重载该文档恢复接收人的进度，原编辑页不被修改。
- 交互与布局：390px 视口通过 CDP 真实鼠标按下/移动/松开完成西安→济南拖拽；检查手机地图、地点故事列表、照片详情截图。桌面和手机无横向溢出。未用真实手机硬件测试。
- 本地服务：PowerShell 服务可加载 `model.js`；浏览器空闲连接超时后仍可继续响应请求。
- 导出资源：`gift-sources.js` 的 HTML、CSS、模型、业务脚本与源码逐项一致。

蛋糕工作台升级参考了公开项目 [ascodeasice/three-js-birthday-cake](https://github.com/ascodeasice/three-js-birthday-cake) 的阶段式庆祝节奏和 [VIDAKHOSHPEY22/3D-Birthday-Cake](https://github.com/VIDAKHOSHPEY22/3D-Birthday-Cake) 的触摸备用思路；本项目采用自有 CSS 立体蛋糕，不复制源码，不申请麦克风权限。蛋糕验证入口为 `tests/cake-flow.js`：路线抵达沈阳后，验证拖动奶油、三次裱花、输入愿望并让文字浮在蛋糕后的背景、三次插蜡烛，最后才展示许愿。由于当前测试浏览器可能保留旧的 Chrome DevTools 页面，执行前确认 CDP 页面 URL 为 `http://127.0.0.1:4173/index.html`。

可复用验证文件：`tests/model-tests.cjs`（Node 可直接运行）、`tests/place-flow.js`、`tests/reload-check.js`、`tests/failure-check.js`、`tests/migration-seed.js`、`tests/migration-check.js`、`tests/drag-flow.ps1`。浏览器脚本通过 `tests/inspect.ps1 -ExpressionFile ...` 在专用 CDP 端口 9333 执行。

这些测试会导入夹具并修改专用测试数据库，只能使用隔离配置目录。`reload-check.js` 应在 `place-flow.js` 后、`drag-flow.ps1` 前执行（期望此时仅广元解锁）；`migration-seed.js` 后刷新，再执行 `migration-check.js`，随后刷新恢复之前夹具。

以下为旧版历史记录；`test-runner.html` 和旧 `backup-check.js` 针对 v1 平铺结构，已由上述 v3 测试替代。

## 2026-11-14：原始版本

2026-11-14，Windows / Microsoft Edge 157，无界面真实浏览器。

已通过：个性化设置保存、图片选择与压缩保存、故事安全文本渲染、故事编辑、IndexedDB 实际内容检查、独立 HTML 导出、导出内容在独立文档中启动与显示照片、分享模式隐藏编辑入口、删除保存、空状态恢复、生日许愿交互。刷新到首页后设置仍然保留。

另通过：JSON 备份包含设置、无效 JSON 不覆盖现有内容、有效备份恢复。已查看页面截图。分享页测试使用独立 srcdoc 文档加载导出内容，未依赖外部 CSS/JS；尚未逐一测试不同手机聊天软件对 HTML 附件的打开方式。

`test-runner.html` 是集成测试入口，会修改**测试浏览器**中的本站数据，只应在独立测试配置目录运行，不要在存有真实回忆的浏览器中打开。`tests/inspect.ps1` 用于读取专用 Edge 调试实例结果和截图，`tests/backup-check.js` 验证备份。测试配置目录已加入 .gitignore。

注意：Edge 的 `--virtual-time-budget` 会使计时器先于 IndexedDB 初始化结束，因此最终集成验证使用真实时钟和独立测试浏览器，而非加速时钟结果。

## 2026-11-25：圣诞氛围回归检查

- 构建脚本 `build.ps1` 执行成功，分享资源已重新生成。
- PowerShell 本地服务返回 `index.html` HTTP 200；页面包含圣诞树、礼盒、圣诞老人、壁炉、飘雪层，以及冬日蛋糕互动节点。
- 代码检查确认装饰层使用 `pointer-events: none`；移动端将主要内容层级置于装饰之上。
- 建议在 Edge/Chrome 中分别以桌面宽度和 360px 左右移动宽度打开 `http://127.0.0.1:4173/index.html`，手动确认地图拖动、青蛙点击、故事照片和蛋糕制作无遮挡。
