# 胶片修复车间台

一个纯前端本地应用，在原有「胶片分镜条核对台」基础上扩成修复车间：整理纸质放映胶片片段、拖拽调整放映顺序、统计总时长、筛选颜色偏移并生成试映前破损提醒；受损片段可建修复工单，按工序推进并产出车间报表。

直接打开 `index.html` 即可使用，也可以在本目录启动静态服务访问。

## 修复车间

- **工单流转**：受损片段可建工单，按 评估 → 清洗 → 接片 → 复检 → 归档 推进；每个工位同时只能有一张工单，工位被占用时建单/推进/退回都会被拦下。
- **耗材库存**：完成每道工序按库存扣减耗材（评估/复检用手套，清洗用清洗液与手套，接片用胶带，归档用保护套与标签）；耗材不足时不能推进，也不能归档。库存可手动补货/核减。
- **归档约束**：复检未通过、耗材不足或片段借出中，都不能归档。
- **复检退回**：复检未过可退回评估/清洗/接片任一工序，返工计数 +1，并回冲待重做工序已领用的耗材；取消工单则回冲全部耗材。返工超过上限（2 次）自动隔离。
- **耗材台账所有权**：每笔台账记录实际领用的工单（origin）。离线副本继承的台账只读展示（标记「继承」），取消或退回时只回冲本单实际新增且未退的部分；合并时共享来源的台账按条目去重、分支新增的账目转归合并单，同一笔消耗全车间最多退款一次。
- **旧数据迁移**：升级前没有 origin 的台账，载入时按台账条目标识跨工单比对——共享记录归最早实际领用的工单（已合并的顺延给合并单），副本独有的记录仍归副本；旧版合并单被拼接重生成的台账按合并记录找到来源工单重建去重。迁移只补登归属，不改库存数字。
- **离线工单合并**：工单可生成离线副本（不占工位）；两张同一片段的离线工单可合并——工序记录按内容去重，损坏结论冲突需逐项裁决后才可并入。
- **车间报表**：实时生成待修、隔离、返工、耗材四类清单，可导出文本；所有操作可撤销，状态持久化在 localStorage，撤销、刷新、重开后报表保持一致。

## 端到端测试

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

测试用 Playwright 驱动真实 Chromium，走通正常修复归档、工位冲突、耗材不足、复检退回与自动隔离、借出阻断归档、离线合并裁决、隔离导出，以及撤销/刷新/重开后报表一致。

无 root 权限的环境（无法 `playwright install --with-deps`）可手动补齐 Chromium 运行时库：

```bash
mkdir -p /tmp/apt/lists/partial /tmp/chromelibs/debs
apt-get -o Dir::State::Lists=/tmp/apt/lists -o Dir::Cache=/tmp/apt/cache update
cd /tmp/chromelibs/debs
apt-get -o Dir::State::Lists=/tmp/apt/lists -o Dir::Cache=/tmp/apt/cache download \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libasound2 libatk1.0-0 \
  libatspi2.0-0 libdbus-1-3 libdrm2 libgbm1 libnspr4 libnss3 libwayland-server0 libxi6 libxkbcommon0
for f in *.deb; do dpkg-deb -x "$f" /tmp/chromelibs/root; done
```

e2e 脚本会自动把 `/tmp/chromelibs/root` 加入 `LD_LIBRARY_PATH`。
