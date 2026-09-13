import { chromium } from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 无 root 环境下为 Chromium 补齐运行时库（见 README：apt 下载解压到 /tmp/chromelibs）
const localLibs = ["/tmp/chromelibs/root/usr/lib/aarch64-linux-gnu", "/tmp/chromelibs/root/lib/aarch64-linux-gnu"].filter(existsSync);
if (localLibs.length) {
  process.env.LD_LIBRARY_PATH = [...localLibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const filePath = path.join(root, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const pageErrors = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
async function expectText(locator, needle, label) {
  const text = await locator.textContent();
  expect((text || "").includes(needle), `${label}：期望包含「${needle}」，实际「${(text || "").trim()}」`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (error) => pageErrors.push(error.message));

const msg = () => page.locator("#workshopMsg").textContent();
const orderCard = (code) => page.locator(`[data-order-code="${code}"]`);
const stageOf = (code) => orderCard(code).locator('[data-role="stage"]').textContent();
const stationOccupant = (stage) => page.locator(`.station[data-stage="${stage}"] .station-occupant`).textContent();
const materialStock = (id) => page.locator(`.material-row[data-material="${id}"] [data-role="stock"]`).textContent();
const reportText = (id) => page.locator(`#${id}`).textContent();

async function createOrderFor(segmentCode) {
  await page.locator(`[data-segment-code="${segmentCode}"] [data-action="create-order"]`).click();
}
async function advance(code) {
  await orderCard(code).locator('[data-action="advance"]').click();
}
async function failReviewTo(code, returnStage) {
  await orderCard(code).locator('select[data-role="return-stage"]').selectOption(returnStage);
  await orderCard(code).locator('[data-action="fail-review"]').click();
}
async function adjustMaterial(id, action, times) {
  for (let i = 0; i < times; i += 1) {
    await page.locator(`.material-row[data-material="${id}"] [data-action="${action}"]`).click();
  }
}

await page.goto(baseUrl, { waitUntil: "load" });

// ---------- 场景 1：正常修复 + 借出阻断归档 ----------
console.log("场景 1：正常修复流程（评估→清洗→接片→复检→归档）与借出阻断");
await check("对受损片段 A-006 建工单 WO-0001，进入评估台", async () => {
  await createOrderFor("A-006");
  expect(await stageOf("WO-0001") === "评估", "WO-0001 应在评估");
  await expectText(page.locator('.station[data-stage="评估"]'), "WO-0001", "评估台占用");
});
await check("逐站推进并复检通过，耗材按库存扣减", async () => {
  await advance("WO-0001");
  await advance("WO-0001");
  await advance("WO-0001");
  expect(await stageOf("WO-0001") === "复检", "应在复检");
  await orderCard("WO-0001").locator('[data-action="pass-review"]').click();
  expect(await stageOf("WO-0001") === "归档", "应在归档");
  expect((await materialStock("glove")) === "7副", `手套应为7副，实际${await materialStock("glove")}`);
  expect((await materialStock("clean")) === "4瓶", `清洗液应为4瓶，实际${await materialStock("clean")}`);
  expect((await materialStock("tape")) === "4卷", `胶带应为4卷，实际${await materialStock("tape")}`);
});
await check("片段借出中不能归档", async () => {
  await page.selectOption("#loanSegment", { label: "A-006" });
  await page.fill("#loanBorrower", "放映一组");
  await page.locator('#loanForm button[type="submit"]').click();
  await orderCard("WO-0001").locator('[data-action="archive"]').click();
  await expectText(page.locator("#workshopMsg"), "借出中", "归档拦截提示");
  await expectText(orderCard("WO-0001"), "在修", "工单仍在修");
});
await check("归还后归档成功", async () => {
  await page.locator('[data-action="return-loan"]').click();
  await orderCard("WO-0001").locator('[data-action="archive"]').click();
  await expectText(orderCard("WO-0001"), "已归档", "工单状态");
  expect((await materialStock("sleeve")) === "4个", `保护套应为4个，实际${await materialStock("sleeve")}`);
  expect((await materialStock("label")) === "4张", `标签应为4张，实际${await materialStock("label")}`);
  expect(!(await reportText("reportPending")).includes("WO-0001"), "待修清单不应含 WO-0001");
});

// ---------- 场景 2：工位冲突 ----------
console.log("场景 2：工位冲突（建单与推进都被拦截）");
await check("评估台被占用时新建工单被拦截", async () => {
  await createOrderFor("A-012");
  expect(await stageOf("WO-0002") === "评估", "WO-0002 应在评估");
  await page.fill("#codeInput", "B-001");
  await page.selectOption("#damageInput", "齿孔破损");
  await page.locator('#segmentForm button[type="submit"]').click();
  await createOrderFor("B-001");
  await expectText(page.locator("#workshopMsg"), "工位冲突", "建单拦截提示");
  expect((await page.locator('[data-order-code="WO-0003"]').count()) === 0, "不应生成 WO-0003");
});
await check("目标工位被占用时推进被拦截", async () => {
  await advance("WO-0002"); // → 清洗
  await createOrderFor("B-001"); // WO-0003 → 评估
  expect(await stageOf("WO-0003") === "评估", "WO-0003 应在评估");
  await advance("WO-0002"); // → 接片
  await advance("WO-0003"); // → 清洗
  await advance("WO-0003"); // 接片被 WO-0002 占用 → 拦截
  await expectText(page.locator("#workshopMsg"), "工位冲突", "推进拦截提示");
  expect(await stageOf("WO-0003") === "清洗", "WO-0003 应仍在清洗");
});

// ---------- 场景 3：耗材不足 + 取消回冲 ----------
console.log("场景 3：耗材不足拦截与取消工单回冲");
await check("清洗液不足时完成清洗被拦截", async () => {
  await adjustMaterial("clean", "mat-minus", 3); // 3 → 0
  expect((await materialStock("clean")) === "0瓶", "清洗液应为0");
  await advance("WO-0002"); // 接片 → 复检（用胶带）
  expect(await stageOf("WO-0002") === "复检", "WO-0002 应在复检");
  await advance("WO-0003"); // 清洗需要清洗液 → 拦截
  await expectText(page.locator("#workshopMsg"), "耗材不足", "耗材拦截提示");
  expect(await stageOf("WO-0003") === "清洗", "WO-0003 应仍在清洗");
});
await check("取消工单回冲已领用耗材", async () => {
  const gloveBefore = await materialStock("glove");
  await orderCard("WO-0003").locator('[data-action="cancel"]').click();
  await expectText(orderCard("WO-0003"), "已取消", "工单状态");
  await expectText(page.locator("#workshopMsg"), "回冲", "回冲提示");
  expect((await materialStock("glove")) === "5副", `手套应回冲为5副（之前${gloveBefore}），实际${await materialStock("glove")}`);
});

// ---------- 场景 4：复检退回、返工累计与自动隔离 ----------
console.log("场景 4：复检退回（回冲耗材）与返工超上限自动隔离");
await check("复检未过退回清洗，回冲清洗与接片耗材", async () => {
  await failReviewTo("WO-0002", "清洗");
  expect(await stageOf("WO-0002") === "清洗", "WO-0002 应退回清洗");
  await expectText(orderCard("WO-0002").locator('[data-role="rework"]'), "返工 1/2", "返工计数");
  expect((await materialStock("clean")) === "1瓶", `清洗液应回冲为1瓶，实际${await materialStock("clean")}`);
  expect((await materialStock("tape")) === "4卷", `胶带应回冲为4卷，实际${await materialStock("tape")}`);
  await expectText(page.locator("#reportRework"), "WO-0002", "返工清单");
});
await check("第二次退回接片，只回冲接片耗材", async () => {
  await advance("WO-0002"); // 清洗 → 接片
  await advance("WO-0002"); // 接片 → 复检
  await failReviewTo("WO-0002", "接片");
  expect(await stageOf("WO-0002") === "接片", "WO-0002 应退回应片");
  await expectText(orderCard("WO-0002").locator('[data-role="rework"]'), "返工 2/2", "返工计数");
  expect((await materialStock("tape")) === "4卷", `胶带应回冲为4卷，实际${await materialStock("tape")}`);
  expect((await materialStock("clean")) === "0瓶", `清洗液应为0瓶，实际${await materialStock("clean")}`);
});
await check("第三次复检未过，返工超上限自动隔离", async () => {
  await advance("WO-0002"); // 接片 → 复检
  await failReviewTo("WO-0002", "清洗");
  await expectText(orderCard("WO-0002"), "已隔离", "工单状态");
  await expectText(page.locator("#workshopMsg"), "自动隔离", "隔离提示");
  await expectText(page.locator("#reportQuarantine"), "WO-0002", "隔离清单");
  expect((await page.locator("#quarantineCount").textContent()) === "1", "隔离工单数应为1");
  expect((await stationOccupant("复检")).trim() === "空闲", "复检灯应空闲");
});

// ---------- 场景 5：离线工单合并与逐项裁决 ----------
console.log("场景 5：离线工单合并（记录去重 + 损坏结论逐项裁决）");
await check("生成两张离线副本并制造结论冲突", async () => {
  await createOrderFor("A-006"); // WO-0004 → 评估
  await advance("WO-0004"); // → 清洗
  await orderCard("WO-0004").locator('[data-action="copy-offline"]').click(); // WO-0005
  await orderCard("WO-0004").locator('[data-action="copy-offline"]').click(); // WO-0006
  await expectText(orderCard("WO-0005"), "离线", "WO-0005 离线标记");
  await expectText(orderCard("WO-0006"), "离线", "WO-0006 离线标记");
  await orderCard("WO-0005").locator('select[data-role="finding-item"]').selectOption("片基");
  await orderCard("WO-0005").locator('select[data-role="finding-conclusion"]').selectOption("严重");
  await orderCard("WO-0005").locator('[data-action="add-finding"]').click();
  await orderCard("WO-0006").locator('select[data-role="finding-item"]').selectOption("片基");
  await orderCard("WO-0006").locator('select[data-role="finding-conclusion"]').selectOption("轻微");
  await orderCard("WO-0006").locator('[data-action="add-finding"]').click();
  await expectText(orderCard("WO-0005"), "片基·严重", "WO-0005 结论");
  await expectText(orderCard("WO-0006"), "片基·轻微", "WO-0006 结论");
});
await check("离线工单推进不占工位，预检列出冲突且必须逐项裁决", async () => {
  await advance("WO-0005"); // 离线：清洗 → 接片
  expect(await stageOf("WO-0005") === "接片", "WO-0005 应在接片");
  await page.selectOption("#mergeA", { label: "WO-0005｜A-006｜接片" });
  await page.selectOption("#mergeB", { label: "WO-0006｜A-006｜清洗" });
  await page.click("#mergePreviewBtn");
  await expectText(page.locator("#mergePreview"), "待裁决冲突（1）", "冲突数量");
  await page.click("#mergeConfirmBtn");
  await expectText(page.locator("#workshopMsg"), "逐项裁决", "未裁决拦截");
});
await check("裁决后合并：记录去重、结论并集、源工单标记已合并", async () => {
  await page.locator('[data-conflict-item="片基"] input[value="b"]').check();
  await page.click("#mergeConfirmBtn");
  await expectText(page.locator("#workshopMsg"), "合并完成", "合并提示");
  expect(await stageOf("WO-0007") === "接片", "合并工单应并入接片");
  await expectText(orderCard("WO-0007"), "片基·轻微", "应采用 B 方结论");
  await expectText(orderCard("WO-0007"), "划痕·轻微", "应保留无冲突结论");
  const recordItems = await orderCard("WO-0007").locator(".order-records li").allTextContents();
  const createRecords = recordItems.filter((text) => text.includes("建单"));
  expect(createRecords.length === 1, `建单记录应去重为1条，实际${createRecords.length}（${recordItems.join("；")}）`);
  await expectText(orderCard("WO-0005"), "已合并", "源工单 A 状态");
  await expectText(orderCard("WO-0006"), "已合并", "源工单 B 状态");
  await expectText(page.locator("#reportPending"), "WO-0007｜A-006｜接片", "待修清单含合并工单");
  expect(!(await reportText("reportPending")).includes("WO-0005"), "待修清单不应含已合并工单");
  expect((await stationOccupant("接片")).includes("WO-0007"), "接片机应由 WO-0007 占用");
});

// ---------- 场景 6：耗材不足阻断归档 + 隔离导出 + 一致性 ----------
console.log("场景 6：归档约束、隔离导出与撤销/刷新/重开一致");
await check("归档耗材不足时不能归档", async () => {
  await advance("WO-0007"); // 接片 → 复检
  await orderCard("WO-0007").locator('[data-action="pass-review"]').click(); // → 归档
  await adjustMaterial("sleeve", "mat-minus", 4); // 保护套 4 → 0
  await orderCard("WO-0007").locator('[data-action="archive"]').click();
  await expectText(page.locator("#workshopMsg"), "耗材不足", "归档耗材拦截");
  await expectText(orderCard("WO-0007"), "在修", "工单仍在修");
  await adjustMaterial("sleeve", "mat-plus", 1);
  await orderCard("WO-0007").locator('[data-action="archive"]').click();
  await expectText(orderCard("WO-0007"), "已归档", "补货后归档成功");
});
await check("耗材清单账目与库存一致", async () => {
  const materials = await reportText("reportMaterials");
  const expected = [
    "清洗液｜库存0瓶｜累计消耗4｜累计回冲2",
    "接片胶带｜库存3卷｜累计消耗5｜累计回冲3",
    "修复手套｜库存3副｜累计消耗10｜累计回冲3",
    "归档保护套｜库存0个｜累计消耗2｜累计回冲0",
    "归档标签｜库存3张｜累计消耗2｜累计回冲0"
  ];
  for (const line of expected) expect(materials.includes(line), `耗材清单缺「${line}」，实际「${materials.trim()}」`);
});
await check("导出车间报表包含隔离/返工/待修/耗材", async () => {
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportReportBtn")]);
  const content = await readFile(await download.path(), "utf8");
  expect(content.includes("【隔离清单】\nWO-0002｜A-012｜返工3次"), "导出缺隔离清单");
  expect(content.includes("【返工清单】\nWO-0002｜A-012｜返工3次｜已隔离"), "导出缺返工清单");
  expect(content.includes("WO-0004｜A-006｜清洗"), "导出缺待修工单");
  expect(content.includes("清洗液｜库存0瓶｜累计消耗4｜累计回冲2"), "导出缺耗材账目");
});
await check("撤销归档后待修清单回滚，刷新与重开后报表一致", async () => {
  await page.click("#undoBtn"); // 撤销归档
  await expectText(page.locator("#reportPending"), "WO-0007｜A-006｜归档", "撤销后待修含 WO-0007");
  const snapshot = {
    pending: await reportText("reportPending"),
    quarantine: await reportText("reportQuarantine"),
    rework: await reportText("reportRework"),
    materials: await reportText("reportMaterials")
  };
  await page.reload({ waitUntil: "load" }); // 刷新
  for (const [key, value] of Object.entries(snapshot)) {
    const id = `report${key[0].toUpperCase()}${key.slice(1)}`;
    expect((await reportText(id)) === value, `刷新后${id}不一致`);
  }
  await page.click("#undoBtn"); // 撤销补货
  await page.reload({ waitUntil: "load" }); // 重开
  await expectText(page.locator("#reportQuarantine"), "WO-0002", "重开后隔离清单仍在");
  expect((await page.locator("#quarantineCount").textContent()) === "1", "重开后隔离数仍为1");
});

await browser.close();
server.close();

if (pageErrors.length) {
  failures += pageErrors.length;
  console.error(`\n页面脚本错误 ${pageErrors.length} 起：\n${pageErrors.join("\n")}`);
}
console.log(failures === 0 ? "\n全部场景通过 ✅" : `\n${failures} 项断言失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
