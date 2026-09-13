const storageKey = "zfl17-film-strip-desk";

const fallbackThumbs = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];

// 修复车间常量
const STAGES = ["评估", "清洗", "接片", "复检", "归档"];
const STATIONS = { 评估: "评估台", 清洗: "清洗槽", 接片: "接片机", 复检: "复检灯", 归档: "归档架" };
const STAGE_COSTS = {
  评估: [{ material: "glove", qty: 1 }],
  清洗: [{ material: "clean", qty: 1 }, { material: "glove", qty: 1 }],
  接片: [{ material: "tape", qty: 1 }],
  复检: [{ material: "glove", qty: 1 }],
  归档: [{ material: "sleeve", qty: 1 }, { material: "label", qty: 1 }]
};
const REWORK_LIMIT = 2;
const DAMAGE_ITEMS = ["划痕", "齿孔", "片基", "接片", "声带", "颜色"];
const CONCLUSIONS = ["轻微", "中度", "严重", "无法修复", "已修复"];
const DAMAGE_TO_FINDING = {
  轻微划痕: { item: "划痕", conclusion: "轻微" },
  齿孔破损: { item: "齿孔", conclusion: "中度" },
  接片松动: { item: "接片", conclusion: "中度" },
  需跳过: { item: "片基", conclusion: "严重" }
};
const STATUS_LABELS = { active: "在修", archived: "已归档", cancelled: "已取消", quarantined: "已隔离", merged: "已合并" };
const HISTORY_LIMIT = 40;

const defaultState = {
  reelTitle: "春日试映A卷",
  segments: [
    {
      id: crypto.randomUUID(),
      code: "A-001",
      duration: 18,
      shift: "正常",
      damage: "完好",
      note: "开场街景，节奏平稳，适合保留原顺序。",
      thumb: ""
    },
    {
      id: crypto.randomUUID(),
      code: "A-006",
      duration: 9,
      shift: "偏红",
      damage: "轻微划痕",
      note: "人物近景左侧有划痕，试映时留意是否明显。",
      thumb: ""
    },
    {
      id: crypto.randomUUID(),
      code: "A-012",
      duration: 14,
      shift: "褪色",
      damage: "接片松动",
      note: "接片位置靠近段尾，放映前建议重新压平。",
      thumb: ""
    }
  ],
  materials: [
    { id: "clean", name: "清洗液", unit: "瓶", stock: 5, consumed: 0, refunded: 0 },
    { id: "tape", name: "接片胶带", unit: "卷", stock: 5, consumed: 0, refunded: 0 },
    { id: "glove", name: "修复手套", unit: "副", stock: 10, consumed: 0, refunded: 0 },
    { id: "sleeve", name: "归档保护套", unit: "个", stock: 5, consumed: 0, refunded: 0 },
    { id: "label", name: "归档标签", unit: "张", stock: 5, consumed: 0, refunded: 0 }
  ],
  workOrders: [],
  loans: [],
  log: [],
  orderSeq: 1,
  history: []
};

let state = loadState();
let draggedId = null;
let mergePlan = null;

const els = {
  reelTitle: document.querySelector("#reelTitle"),
  colorFilter: document.querySelector("#colorFilter"),
  searchInput: document.querySelector("#searchInput"),
  segmentForm: document.querySelector("#segmentForm"),
  codeInput: document.querySelector("#codeInput"),
  durationInput: document.querySelector("#durationInput"),
  shiftInput: document.querySelector("#shiftInput"),
  damageInput: document.querySelector("#damageInput"),
  thumbInput: document.querySelector("#thumbInput"),
  noteInput: document.querySelector("#noteInput"),
  segmentList: document.querySelector("#segmentList"),
  warningList: document.querySelector("#warningList"),
  totalDuration: document.querySelector("#totalDuration"),
  damageCount: document.querySelector("#damageCount"),
  segmentCount: document.querySelector("#segmentCount"),
  activeOrderCount: document.querySelector("#activeOrderCount"),
  quarantineCount: document.querySelector("#quarantineCount"),
  exportBtn: document.querySelector("#exportBtn"),
  exportReportBtn: document.querySelector("#exportReportBtn"),
  undoBtn: document.querySelector("#undoBtn"),
  workshopMsg: document.querySelector("#workshopMsg"),
  stationBoard: document.querySelector("#stationBoard"),
  orderList: document.querySelector("#orderList"),
  materialList: document.querySelector("#materialList"),
  loanForm: document.querySelector("#loanForm"),
  loanSegment: document.querySelector("#loanSegment"),
  loanBorrower: document.querySelector("#loanBorrower"),
  loanList: document.querySelector("#loanList"),
  mergeA: document.querySelector("#mergeA"),
  mergeB: document.querySelector("#mergeB"),
  mergePreviewBtn: document.querySelector("#mergePreviewBtn"),
  mergePreview: document.querySelector("#mergePreview"),
  logList: document.querySelector("#logList"),
  reportPending: document.querySelector("#reportPending"),
  reportQuarantine: document.querySelector("#reportQuarantine"),
  reportRework: document.querySelector("#reportRework"),
  reportMaterials: document.querySelector("#reportMaterials")
};

// ---------- 状态与持久化 ----------

function loadState() {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return migrate(structuredClone(defaultState));
  try {
    const parsed = JSON.parse(saved);
    return migrate({ ...structuredClone(defaultState), ...parsed, history: parsed.history || [] });
  } catch {
    return migrate(structuredClone(defaultState));
  }
}

// 旧数据迁移：为没有 origin 的台账补登归属。
// 同一台账标识（条目 id）出现在多张工单时，归最早实际领用的工单；
// 已合并工单拥有的账目顺延给合并单；旧版合并单的拼接台账按来源工单重建去重。
function migrate(target) {
  const orders = target.workOrders || [];
  const byCode = new Map(orders.map((order) => [order.code, order]));

  const parseMergeSources = (order) => {
    const record = (order.records || []).find((item) => item.action === "合并");
    const match = record ? /由\s*(.+?)\s*＋\s*(.+?)\s*合并/.exec(record.detail || "") : null;
    return match ? [match[1], match[2]] : null;
  };

  // 合并血缘：分支工单 → 合并单
  const mergeFlow = new Map();
  orders.forEach((order) => {
    const sources = parseMergeSources(order);
    if (!sources) return;
    sources.forEach((code) => {
      if (byCode.has(code)) mergeFlow.set(code, order);
    });
  });

  // 旧版合并单的台账是拼接后重新生成 id 的：按两张来源工单的台账去重重建，
  // 合并后本单新领的（与来源账目对不上的）保留为本单所有
  orders.forEach((order) => {
    const ledger = order.ledger || [];
    if (!ledger.length || ledger.some((entry) => entry.origin)) return;
    const sources = parseMergeSources(order);
    if (!sources) return;
    const [sourceA, sourceB] = sources.map((code) => byCode.get(code));
    if (!sourceA || !sourceB) return;
    const union = [];
    const seen = new Set();
    [...(sourceA.ledger || []), ...(sourceB.ledger || [])].forEach((entry) => {
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      union.push(entry);
    });
    const rebuilt = [...union];
    ledger.forEach((entry) => {
      const duplicated = union.some(
        (item) => item.stage === entry.stage && item.materialId === entry.materialId && item.qty === entry.qty
      );
      if (!duplicated) rebuilt.push(entry);
    });
    order.ledger = rebuilt;
  });

  // 全局归属：同一台账标识出现在多张工单时，归最早实际领用的工单；已合并的顺延给合并单
  const entryHolders = new Map();
  orders.forEach((order) => {
    (order.ledger || []).forEach((entry) => {
      if (!entryHolders.has(entry.id)) entryHolders.set(entry.id, []);
      entryHolders.get(entry.id).push(order);
    });
  });
  const resolveOwner = (candidates) => {
    const sorted = candidates
      .slice()
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.code.localeCompare(b.code));
    let owner = sorted[0];
    const visited = new Set();
    while (owner && owner.status === "merged" && mergeFlow.has(owner.code) && !visited.has(owner.code)) {
      visited.add(owner.code);
      owner = mergeFlow.get(owner.code);
    }
    return owner || sorted[0];
  };
  orders.forEach((order) => {
    (order.ledger || []).forEach((entry) => {
      if (entry.origin) return;
      entry.origin = resolveOwner(entryHolders.get(entry.id) || [order]).id;
    });
  });
  return target;
}

function saveState() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // 存储超限时不阻断操作
  }
}

function pushHistory() {
  const snapshot = { ...state, history: [] };
  state.history.push(JSON.stringify(snapshot));
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
}

function undo() {
  if (!state.history.length) {
    showMsg("没有可撤销的操作。", "error");
    return;
  }
  const snapshot = state.history.pop();
  const history = state.history;
  state = migrate({ ...JSON.parse(snapshot), history });
  renderAll();
  showMsg("已撤销上一步操作。", "ok");
}

function now() {
  return new Date().toISOString();
}

function logAction(text) {
  state.log.unshift({ at: now(), text });
  if (state.log.length > 80) state.log.length = 80;
}

function showMsg(text, kind) {
  els.workshopMsg.textContent = text;
  els.workshopMsg.dataset.kind = kind || "info";
}

// ---------- 查询助手 ----------

function findSegment(id) {
  return state.segments.find((item) => item.id === id);
}

function findOrder(id) {
  return state.workOrders.find((item) => item.id === id);
}

function findMaterial(id) {
  return state.materials.find((item) => item.id === id);
}

function segmentCode(segmentId) {
  const seg = findSegment(segmentId);
  return seg ? seg.code : "片段已删除";
}

function stationOccupant(stage) {
  return state.workOrders.find(
    (order) => order.status === "active" && order.source === "online" && order.stage === stage
  );
}

function activeLoanFor(segmentId) {
  return state.loans.find((loan) => loan.segmentId === segmentId && !loan.returned);
}

function materialName(id) {
  const material = findMaterial(id);
  return material ? material.name : id;
}

// ---------- 耗材 ----------

function checkMaterials(costs) {
  const shortages = costs
    .map((cost) => {
      const material = findMaterial(cost.material);
      if (!material || material.stock < cost.qty) {
        return `${material ? material.name : cost.material}不足（需${cost.qty}）`;
      }
      return null;
    })
    .filter(Boolean);
  return shortages.length ? shortages.join("、") : null;
}

function deductMaterials(order, costs, stage) {
  costs.forEach((cost) => {
    const material = findMaterial(cost.material);
    material.stock -= cost.qty;
    material.consumed += cost.qty;
    order.ledger.push({
      id: crypto.randomUUID(),
      origin: order.id,
      stage,
      materialId: cost.material,
      qty: cost.qty,
      refunded: false
    });
  });
}

// 只回冲本单实际领用（origin 是本单）且未退的条目；继承自其他工单的台账不在此退款
function refundStages(order, fromStage) {
  const fromIndex = STAGES.indexOf(fromStage);
  const refunded = [];
  order.ledger.forEach((entry) => {
    if (entry.refunded || entry.origin !== order.id) return;
    if (STAGES.indexOf(entry.stage) < fromIndex) return;
    const material = findMaterial(entry.materialId);
    material.stock += entry.qty;
    material.refunded += entry.qty;
    entry.refunded = true;
    refunded.push(`${material.name}×${entry.qty}`);
  });
  return refunded;
}

function refundAll(order) {
  return refundStages(order, STAGES[0]);
}

// ---------- 工单 ----------

function nextOrderCode() {
  const code = `WO-${String(state.orderSeq).padStart(4, "0")}`;
  state.orderSeq += 1;
  return code;
}

function addRecord(order, stage, action, detail) {
  order.records.push({ id: crypto.randomUUID(), stage, action, detail: detail || "", at: now() });
}

function createOrder(segmentId, source) {
  const segment = findSegment(segmentId);
  if (!segment) return;
  if (segment.damage === "完好") {
    showMsg(`片段 ${segment.code} 完好，无需建工单。`, "error");
    return;
  }
  if (source === "online") {
    const existing = state.workOrders.find((order) => order.segmentId === segmentId && order.status === "active");
    if (existing) {
      showMsg(`片段 ${segment.code} 已有进行中的工单 ${existing.code}。`, "error");
      return;
    }
    const occupant = stationOccupant("评估");
    if (occupant) {
      showMsg(`工位冲突：评估台被 ${occupant.code} 占用，无法接收新工单。`, "error");
      return;
    }
  }
  pushHistory();
  const finding = DAMAGE_TO_FINDING[segment.damage];
  const order = {
    id: crypto.randomUUID(),
    code: nextOrderCode(),
    segmentId,
    source,
    stage: "评估",
    status: "active",
    reviewPassed: false,
    reworkCount: 0,
    findings: finding ? [{ ...finding }] : [],
    records: [],
    ledger: [],
    createdAt: now()
  };
  addRecord(order, "评估", "建单", source === "offline" ? "离线建立" : "车间建单");
  state.workOrders.push(order);
  logAction(`${order.code} 建单（${segment.code}，${source === "offline" ? "离线" : "车间"}）`);
  renderAll();
  showMsg(`${order.code} 已建立，进入评估台。`, "ok");
}

function copyOffline(orderId) {
  const source = findOrder(orderId);
  if (!source || source.status !== "active") return;
  pushHistory();
  const copy = structuredClone(source);
  copy.id = crypto.randomUUID();
  copy.code = nextOrderCode();
  copy.source = "offline";
  copy.createdAt = now();
  addRecord(copy, copy.stage, "转离线", `由 ${source.code} 生成离线副本`);
  state.workOrders.push(copy);
  logAction(`${copy.code} 由 ${source.code} 生成离线副本`);
  renderAll();
  showMsg(`${copy.code} 已生成（离线，不占用工位）。`, "ok");
}

function advanceOrder(orderId) {
  const order = findOrder(orderId);
  if (!order || order.status !== "active") return;
  const stage = order.stage;
  if (stage === "复检" || stage === "归档") return;
  const shortage = checkMaterials(STAGE_COSTS[stage]);
  if (shortage) {
    showMsg(`耗材不足：${shortage}，无法完成${stage}。`, "error");
    return;
  }
  const next = STAGES[STAGES.indexOf(stage) + 1];
  if (order.source === "online") {
    const occupant = stationOccupant(next);
    if (occupant) {
      showMsg(`工位冲突：${STATIONS[next]}被 ${occupant.code} 占用，${order.code} 无法推进。`, "error");
      return;
    }
  }
  pushHistory();
  deductMaterials(order, STAGE_COSTS[stage], stage);
  addRecord(order, stage, "完成", `推进到${next}`);
  order.stage = next;
  logAction(`${order.code} 完成${stage}，推进到${next}`);
  renderAll();
  showMsg(`${order.code} 已推进到${next}。`, "ok");
}

function passReview(orderId) {
  const order = findOrder(orderId);
  if (!order || order.status !== "active" || order.stage !== "复检") return;
  const shortage = checkMaterials(STAGE_COSTS["复检"]);
  if (shortage) {
    showMsg(`耗材不足：${shortage}，无法完成复检。`, "error");
    return;
  }
  if (order.source === "online") {
    const occupant = stationOccupant("归档");
    if (occupant) {
      showMsg(`工位冲突：归档架被 ${occupant.code} 占用，${order.code} 无法推进。`, "error");
      return;
    }
  }
  pushHistory();
  order.reviewPassed = true;
  deductMaterials(order, STAGE_COSTS["复检"], "复检");
  addRecord(order, "复检", "复检通过", "推进到归档");
  order.stage = "归档";
  logAction(`${order.code} 复检通过，推进到归档`);
  renderAll();
  showMsg(`${order.code} 复检通过，进入归档架。`, "ok");
}

function failReview(orderId, returnStage) {
  const order = findOrder(orderId);
  if (!order || order.status !== "active" || order.stage !== "复检") return;
  if (!STAGES.slice(0, 3).includes(returnStage)) return;
  const newRework = order.reworkCount + 1;
  const willQuarantine = newRework > REWORK_LIMIT;
  if (!willQuarantine && order.source === "online") {
    const occupant = stationOccupant(returnStage);
    if (occupant) {
      showMsg(`工位冲突：${STATIONS[returnStage]}被 ${occupant.code} 占用，无法退回。`, "error");
      return;
    }
  }
  pushHistory();
  order.reviewPassed = false;
  order.reworkCount = newRework;
  const refunded = refundStages(order, returnStage);
  const refundText = refunded.length ? `，回冲${refunded.join("、")}` : "";
  if (willQuarantine) {
    order.status = "quarantined";
    addRecord(order, "复检", "复检未过", `返工${newRework}次超过上限${REWORK_LIMIT}，自动隔离${refundText}`);
    logAction(`${order.code} 复检未过，返工${newRework}次超过上限，自动隔离${refundText}`);
    renderAll();
    showMsg(`${order.code} 返工超过上限，已自动隔离${refundText}。`, "error");
    return;
  }
  order.stage = returnStage;
  addRecord(order, "复检", "复检未过", `退回${returnStage}，返工第${newRework}次${refundText}`);
  logAction(`${order.code} 复检未过，退回${returnStage}（返工${newRework}次）${refundText}`);
  renderAll();
  showMsg(`${order.code} 已退回${returnStage}${refundText}。`, "ok");
}

function archiveOrder(orderId) {
  const order = findOrder(orderId);
  if (!order || order.status !== "active" || order.stage !== "归档") return;
  if (!order.reviewPassed) {
    showMsg(`${order.code} 复检未通过，不能归档。`, "error");
    return;
  }
  const loan = activeLoanFor(order.segmentId);
  if (loan) {
    showMsg(`片段 ${segmentCode(order.segmentId)} 借出中（${loan.borrower}），不能归档。`, "error");
    return;
  }
  const shortage = checkMaterials(STAGE_COSTS["归档"]);
  if (shortage) {
    showMsg(`耗材不足：${shortage}，不能归档。`, "error");
    return;
  }
  pushHistory();
  deductMaterials(order, STAGE_COSTS["归档"], "归档");
  addRecord(order, "归档", "归档完成", "");
  order.status = "archived";
  logAction(`${order.code} 归档完成`);
  renderAll();
  showMsg(`${order.code} 已归档。`, "ok");
}

function cancelOrder(orderId) {
  const order = findOrder(orderId);
  if (!order || order.status !== "active") return;
  pushHistory();
  const refunded = refundAll(order);
  const refundText = refunded.length ? `，回冲${refunded.join("、")}` : "";
  addRecord(order, order.stage, "取消", `工单取消${refundText}`);
  order.status = "cancelled";
  logAction(`${order.code} 取消${refundText}`);
  renderAll();
  showMsg(`${order.code} 已取消${refundText}。`, "ok");
}

function addFinding(orderId, item, conclusion) {
  const order = findOrder(orderId);
  if (!order || order.status !== "active") return;
  if (!DAMAGE_ITEMS.includes(item) || !CONCLUSIONS.includes(conclusion)) return;
  pushHistory();
  const existing = order.findings.find((finding) => finding.item === item);
  if (existing) {
    existing.conclusion = conclusion;
  } else {
    order.findings.push({ item, conclusion });
  }
  logAction(`${order.code} 损坏结论：${item}＝${conclusion}`);
  renderAll();
}

function removeFinding(orderId, index) {
  const order = findOrder(orderId);
  if (!order || order.status !== "active") return;
  if (index < 0 || index >= order.findings.length) return;
  pushHistory();
  const [removed] = order.findings.splice(index, 1);
  logAction(`${order.code} 移除损坏结论：${removed.item}`);
  renderAll();
}

// ---------- 耗材库存调整 ----------

function adjustMaterial(materialId, delta) {
  const material = findMaterial(materialId);
  if (!material) return;
  if (delta < 0 && material.stock <= 0) {
    showMsg(`${material.name} 库存已为 0。`, "error");
    return;
  }
  pushHistory();
  material.stock += delta;
  logAction(`${material.name} 库存${delta > 0 ? "补货" : "核减"}为 ${material.stock}${material.unit}`);
  renderAll();
}

// ---------- 借出 ----------

function lendSegment(segmentId, borrower) {
  const segment = findSegment(segmentId);
  if (!segment || !borrower) return;
  if (activeLoanFor(segmentId)) {
    showMsg(`片段 ${segment.code} 已在借出中。`, "error");
    return;
  }
  pushHistory();
  state.loans.push({ id: crypto.randomUUID(), segmentId, borrower, at: now(), returned: false });
  logAction(`片段 ${segment.code} 借出给 ${borrower}`);
  renderAll();
  showMsg(`片段 ${segment.code} 已登记借出。`, "ok");
}

function returnLoan(loanId) {
  const loan = state.loans.find((item) => item.id === loanId);
  if (!loan || loan.returned) return;
  pushHistory();
  loan.returned = true;
  logAction(`片段 ${segmentCode(loan.segmentId)} 已归还`);
  renderAll();
  showMsg(`片段 ${segmentCode(loan.segmentId)} 已归还。`, "ok");
}

// ---------- 离线工单合并 ----------

function buildMergePlan(orderA, orderB) {
  const seen = new Set();
  const records = [];
  [...orderA.records, ...orderB.records]
    .slice()
    .sort((a, b) => a.at.localeCompare(b.at))
    .forEach((record) => {
      const sig = `${record.stage}|${record.action}|${record.at}|${record.detail}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      records.push({ ...record, id: crypto.randomUUID() });
    });

  const findings = [];
  const conflicts = [];
  const items = [...new Set([...orderA.findings, ...orderB.findings].map((finding) => finding.item))];
  items.forEach((item) => {
    const inA = orderA.findings.find((finding) => finding.item === item);
    const inB = orderB.findings.find((finding) => finding.item === item);
    if (inA && inB && inA.conclusion !== inB.conclusion) {
      conflicts.push({ item, a: inA.conclusion, b: inB.conclusion });
    } else {
      findings.push({ item, conclusion: (inA || inB).conclusion });
    }
  });

  const further = STAGES.indexOf(orderA.stage) >= STAGES.indexOf(orderB.stage) ? orderA : orderB;
  // 台账按条目 id 去重：两个分支从同一来源继承的条目是同一笔物理消耗，只保留一笔
  const seenLedger = new Set();
  const ledger = [];
  [...orderA.ledger, ...orderB.ledger].forEach((entry) => {
    if (seenLedger.has(entry.id)) return;
    seenLedger.add(entry.id);
    ledger.push({ ...entry });
  });
  return {
    aId: orderA.id,
    bId: orderB.id,
    segmentId: orderA.segmentId,
    stage: further.stage,
    reviewPassed: further.reviewPassed,
    reworkCount: Math.max(orderA.reworkCount, orderB.reworkCount),
    records,
    findings,
    conflicts,
    ledger
  };
}

function previewMerge() {
  const orderA = findOrder(els.mergeA.value);
  const orderB = findOrder(els.mergeB.value);
  mergePlan = null;
  if (!orderA || !orderB || orderA.id === orderB.id) {
    els.mergePreview.innerHTML = `<p class="empty">请选择两张不同的离线工单。</p>`;
    return;
  }
  if (orderA.source !== "offline" || orderB.source !== "offline" || orderA.status !== "active" || orderB.status !== "active") {
    els.mergePreview.innerHTML = `<p class="empty">只能合并进行中的离线工单。</p>`;
    return;
  }
  if (orderA.segmentId !== orderB.segmentId) {
    els.mergePreview.innerHTML = `<p class="empty">两张工单的片段不同，不能合并。</p>`;
    return;
  }
  mergePlan = buildMergePlan(orderA, orderB);
  renderMergePreview(orderA, orderB, mergePlan);
}

function renderMergePreview(orderA, orderB, plan) {
  const conflictHtml = plan.conflicts.length
    ? plan.conflicts
        .map(
          (conflict) => `
        <div class="conflict-item" data-conflict-item="${escapeHtml(conflict.item)}">
          <strong>${escapeHtml(conflict.item)}</strong>
          <label><input type="radio" name="conflict-${escapeHtml(conflict.item)}" value="a" /> A：${escapeHtml(conflict.a)}</label>
          <label><input type="radio" name="conflict-${escapeHtml(conflict.item)}" value="b" /> B：${escapeHtml(conflict.b)}</label>
        </div>`
        )
        .join("")
    : `<p class="empty">损坏结论无冲突。</p>`;
  const findingsHtml = plan.findings.length
    ? plan.findings.map((finding) => `<span class="tag">${escapeHtml(finding.item)}·${escapeHtml(finding.conclusion)}</span>`).join("")
    : `<span class="empty">无共同结论。</span>`;
  els.mergePreview.innerHTML = `
    <div class="merge-summary">
      <p>合并 ${orderA.code} ＋ ${orderB.code} → 片段 ${escapeHtml(segmentCode(plan.segmentId))}，工序记录去重后 ${plan.records.length} 条，并入${escapeHtml(plan.stage)}工位。</p>
      <div class="tag-row">${findingsHtml}</div>
      <h3>待裁决冲突（${plan.conflicts.length}）</h3>
      ${conflictHtml}
      <button id="mergeConfirmBtn" type="button" class="primary">确认合并</button>
    </div>
  `;
}

function confirmMerge() {
  if (!mergePlan) return;
  const plan = mergePlan;
  const adjudicated = [];
  for (const conflict of plan.conflicts) {
    const picked = els.mergePreview.querySelector(`input[name="conflict-${conflict.item}"]:checked`);
    if (!picked) {
      showMsg(`损坏结论冲突需逐项裁决：「${conflict.item}」尚未选择。`, "error");
      return;
    }
    adjudicated.push({ item: conflict.item, conclusion: picked.value === "a" ? conflict.a : conflict.b });
  }
  const occupant = stationOccupant(plan.stage);
  if (occupant) {
    showMsg(`工位冲突：${STATIONS[plan.stage]}被 ${occupant.code} 占用，无法并入。`, "error");
    return;
  }
  const orderA = findOrder(plan.aId);
  const orderB = findOrder(plan.bId);
  if (!orderA || !orderB || orderA.status !== "active" || orderB.status !== "active") {
    showMsg("待合并的工单状态已变化，请重新预检。", "error");
    return;
  }
  pushHistory();
  const mergedId = crypto.randomUUID();
  const merged = {
    id: mergedId,
    code: nextOrderCode(),
    segmentId: plan.segmentId,
    source: "online",
    stage: plan.stage,
    status: "active",
    reviewPassed: plan.reviewPassed,
    reworkCount: plan.reworkCount,
    findings: [...plan.findings, ...adjudicated],
    records: plan.records,
    // 分支新增的账目随合并转归本单；共享来源（第三方工单）的账目仍归原工单退款
    ledger: plan.ledger.map((entry) => ({
      ...entry,
      origin: entry.origin === plan.aId || entry.origin === plan.bId ? mergedId : entry.origin
    })),
    createdAt: now()
  };
  addRecord(merged, merged.stage, "合并", `由 ${orderA.code} ＋ ${orderB.code} 合并`);
  orderA.status = "merged";
  orderB.status = "merged";
  state.workOrders.push(merged);
  mergePlan = null;
  logAction(`${merged.code} 由 ${orderA.code} ＋ ${orderB.code} 合并（记录去重后 ${merged.records.length} 条）`);
  renderAll();
  showMsg(`${merged.code} 合并完成，进入${merged.stage}工位。`, "ok");
}

// ---------- 报表 ----------

function buildReport() {
  const pending = state.workOrders
    .filter((order) => order.status === "active")
    .map((order) => `${order.code}｜${segmentCode(order.segmentId)}｜${order.stage}｜${order.source === "offline" ? "离线" : "在修"}`);
  const quarantine = state.workOrders
    .filter((order) => order.status === "quarantined")
    .map((order) => `${order.code}｜${segmentCode(order.segmentId)}｜返工${order.reworkCount}次`);
  const rework = state.workOrders
    .filter((order) => order.reworkCount > 0 && order.status !== "merged")
    .map((order) => `${order.code}｜${segmentCode(order.segmentId)}｜返工${order.reworkCount}次｜${STATUS_LABELS[order.status]}`);
  const materials = state.materials.map(
    (material) => `${material.name}｜库存${material.stock}${material.unit}｜累计消耗${material.consumed}｜累计回冲${material.refunded}`
  );
  return { pending, quarantine, rework, materials };
}

function exportReport() {
  const report = buildReport();
  const lines = [
    `胶片卷：${state.reelTitle || "未命名胶片卷"}`,
    `导出时间：${new Date().toLocaleString("zh-CN")}`,
    "",
    "【待修清单】",
    ...(report.pending.length ? report.pending : ["（空）"]),
    "",
    "【隔离清单】",
    ...(report.quarantine.length ? report.quarantine : ["（空）"]),
    "",
    "【返工清单】",
    ...(report.rework.length ? report.rework : ["（空）"]),
    "",
    "【耗材清单】",
    ...report.materials
  ];
  downloadText(lines.join("\n"), `${state.reelTitle || "film-reel"}-workshop-report.txt`);
  showMsg("车间报表已导出。", "ok");
}

// ---------- 渲染 ----------

function renderStats() {
  const total = state.segments.reduce((sum, item) => sum + Number(item.duration), 0);
  const damaged = state.segments.filter((item) => item.damage !== "完好").length;
  els.totalDuration.textContent = formatDuration(total);
  els.damageCount.textContent = damaged;
  els.segmentCount.textContent = state.segments.length;
  els.activeOrderCount.textContent = state.workOrders.filter((order) => order.status === "active").length;
  els.quarantineCount.textContent = state.workOrders.filter((order) => order.status === "quarantined").length;
}

function getFilteredSegments() {
  const color = els.colorFilter.value;
  const keyword = els.searchInput.value.trim();
  return state.segments.filter((item) => {
    const matchesColor = color === "all" || item.shift === color;
    const matchesKeyword = !keyword || `${item.code}${item.note}${item.damage}`.includes(keyword);
    return matchesColor && matchesKeyword;
  });
}

function renderList() {
  const segments = getFilteredSegments();
  els.segmentList.innerHTML =
    segments
      .map((item, index) => {
        const realIndex = state.segments.findIndex((segment) => segment.id === item.id);
        const hasDamage = item.damage !== "完好";
        const loan = activeLoanFor(item.id);
        const activeOrder = state.workOrders.find((order) => order.segmentId === item.id && order.status === "active");
        return `
          <article class="segment-card" draggable="true" data-id="${item.id}" data-segment-code="${escapeHtml(item.code)}">
            <div class="thumb">
              ${
                item.thumb
                  ? `<img src="${item.thumb}" alt="${escapeHtml(item.code)}缩略图" />`
                  : `<div class="film-placeholder" style="background:${fallbackThumbs[realIndex % fallbackThumbs.length]}">${escapeHtml(item.code)}</div>`
              }
            </div>
            <div class="segment-main">
              <div class="segment-title">
                <strong>${realIndex + 1}. ${escapeHtml(item.code)}</strong>
                <span>${formatDuration(item.duration)}</span>
                ${loan ? `<span class="tag loan">借出中·${escapeHtml(loan.borrower)}</span>` : ""}
              </div>
              <div class="tag-row">
                <span class="tag">${escapeHtml(item.shift)}</span>
                <span class="tag ${hasDamage ? "damage" : "ok"}">${escapeHtml(item.damage)}</span>
                ${activeOrder ? `<span class="tag stage">${activeOrder.code}·${activeOrder.stage}</span>` : ""}
              </div>
              <p class="segment-note">${escapeHtml(item.note || "没有备注。")}</p>
            </div>
            <div class="segment-actions">
              <button type="button" title="上移" data-action="move-up" data-id="${item.id}">↑</button>
              <button type="button" title="下移" data-action="move-down" data-id="${item.id}">↓</button>
              ${
                hasDamage
                  ? `<button type="button" title="建工单" data-action="create-order" data-id="${item.id}">修</button>`
                  : ""
              }
              <button type="button" title="删除" data-action="delete" data-id="${item.id}">×</button>
            </div>
          </article>
        `;
      })
      .join("") || `<p class="empty">没有符合筛选的片段。</p>`;
}

function renderWarnings() {
  const warnings = state.segments.filter((item) => item.damage !== "完好" || item.shift !== "正常");
  els.warningList.innerHTML =
    warnings
      .map((item) => {
        const index = state.segments.findIndex((segment) => segment.id === item.id) + 1;
        const reasons = [item.shift !== "正常" ? item.shift : "", item.damage !== "完好" ? item.damage : ""].filter(Boolean).join(" · ");
        return `
          <div class="warning-item">
            <strong>${index}. ${escapeHtml(item.code)}</strong>
            <span>${escapeHtml(reasons)}${item.note ? `：${escapeHtml(item.note)}` : ""}</span>
          </div>
        `;
      })
      .join("") || `<p class="empty">当前清单没有颜色偏移或破损提醒。</p>`;
}

function renderStations() {
  els.stationBoard.innerHTML = STAGES.map((stage) => {
    const occupant = stationOccupant(stage);
    return `
      <div class="station ${occupant ? "occupied" : "free"}" data-stage="${stage}">
        <span class="station-name">${STATIONS[stage]}</span>
        <span class="station-stage">${stage}</span>
        <strong class="station-occupant">${
          occupant ? `${occupant.code}｜${escapeHtml(segmentCode(occupant.segmentId))}` : "空闲"
        }</strong>
      </div>
    `;
  }).join("");
}

function ledgerSummary(order) {
  if (!order.ledger.length) return "尚未领用耗材";
  const grouped = new Map();
  order.ledger.forEach((entry) => {
    const inherited = Boolean(entry.origin) && entry.origin !== order.id;
    const key = `${entry.materialId}:${entry.refunded}:${inherited}`;
    grouped.set(key, (grouped.get(key) || 0) + entry.qty);
  });
  return [...grouped.entries()]
    .map(([key, qty]) => {
      const [materialId, refunded, inherited] = key.split(":");
      const marks = [refunded === "true" ? "已回冲" : "", inherited === "true" ? "继承" : ""].filter(Boolean);
      return `${materialName(materialId)}×${qty}${marks.length ? `（${marks.join("·")}）` : ""}`;
    })
    .join("、");
}

function renderOrders() {
  const rank = { active: 0, quarantined: 1, archived: 2, cancelled: 3, merged: 4 };
  const orders = state.workOrders.slice().sort((a, b) => rank[a.status] - rank[b.status] || a.code.localeCompare(b.code));
  els.orderList.innerHTML =
    orders
      .map((order) => {
        const isActive = order.status === "active";
        const findingsHtml = order.findings.length
          ? order.findings
              .map(
                (finding, index) => `
              <span class="tag finding">
                ${escapeHtml(finding.item)}·${escapeHtml(finding.conclusion)}
                ${isActive ? `<button type="button" class="mini" data-action="remove-finding" data-id="${order.id}" data-index="${index}" title="移除结论">×</button>` : ""}
              </span>`
              )
              .join("")
          : `<span class="empty">暂无损坏结论。</span>`;
        const findingEditor = isActive
          ? `
          <div class="finding-editor">
            <select data-role="finding-item" data-id="${order.id}">
              ${DAMAGE_ITEMS.map((item) => `<option value="${item}">${item}</option>`).join("")}
            </select>
            <select data-role="finding-conclusion" data-id="${order.id}">
              ${CONCLUSIONS.map((item) => `<option value="${item}">${item}</option>`).join("")}
            </select>
            <button type="button" data-action="add-finding" data-id="${order.id}">添加结论</button>
          </div>`
          : "";
        const recordsHtml = order.records
          .slice()
          .sort((a, b) => a.at.localeCompare(b.at))
          .map(
            (record) =>
              `<li>${formatTime(record.at)}｜${escapeHtml(record.stage)}｜${escapeHtml(record.action)}${record.detail ? `｜${escapeHtml(record.detail)}` : ""}</li>`
          )
          .join("");
        let actionsHtml = "";
        if (isActive) {
          if (order.stage === "复检") {
            actionsHtml = `
              <button type="button" class="primary" data-action="pass-review" data-id="${order.id}">复检通过</button>
              <select data-role="return-stage" data-id="${order.id}">
                <option value="清洗">退回清洗</option>
                <option value="接片">退回接片</option>
                <option value="评估">退回评估</option>
              </select>
              <button type="button" data-action="fail-review" data-id="${order.id}">复检未过·退回</button>
              <button type="button" data-action="copy-offline" data-id="${order.id}">生成离线副本</button>
              <button type="button" class="danger" data-action="cancel" data-id="${order.id}">取消工单</button>`;
          } else if (order.stage === "归档") {
            actionsHtml = `
              <button type="button" class="primary" data-action="archive" data-id="${order.id}">归档</button>
              <button type="button" data-action="copy-offline" data-id="${order.id}">生成离线副本</button>
              <button type="button" class="danger" data-action="cancel" data-id="${order.id}">取消工单</button>`;
          } else {
            actionsHtml = `
              <button type="button" class="primary" data-action="advance" data-id="${order.id}">完成${order.stage}·推进</button>
              <button type="button" data-action="copy-offline" data-id="${order.id}">生成离线副本</button>
              <button type="button" class="danger" data-action="cancel" data-id="${order.id}">取消工单</button>`;
          }
        }
        return `
          <article class="order-card status-${order.status}" data-order-code="${order.code}">
            <div class="order-head">
              <strong>${order.code}</strong>
              <span class="tag">${escapeHtml(segmentCode(order.segmentId))}</span>
              ${order.source === "offline" ? `<span class="tag offline">离线</span>` : ""}
              <span class="tag stage" data-role="stage">${order.stage}</span>
              <span class="tag status-${order.status}">${STATUS_LABELS[order.status]}</span>
              <span class="rework" data-role="rework">返工 ${order.reworkCount}/${REWORK_LIMIT}</span>
              ${order.reviewPassed ? `<span class="tag ok">复检已通过</span>` : ""}
            </div>
            <div class="order-findings">
              <span class="field-label">损坏结论</span>
              <div class="tag-row">${findingsHtml}</div>
              ${findingEditor}
            </div>
            <p class="order-ledger"><span class="field-label">耗材台账</span>${escapeHtml(ledgerSummary(order))}</p>
            <ol class="order-records">${recordsHtml}</ol>
            <div class="order-actions">${actionsHtml}</div>
          </article>
        `;
      })
      .join("") || `<p class="empty">还没有工单。在放映顺序里对受损片段点「修」即可建单。</p>`;
}

function renderMaterials() {
  els.materialList.innerHTML = state.materials
    .map(
      (material) => `
      <div class="material-row" data-material="${material.id}">
        <div>
          <strong>${material.name}</strong>
          <span class="material-stock" data-role="stock">${material.stock}${material.unit}</span>
        </div>
        <div class="material-actions">
          <button type="button" data-action="mat-minus" data-id="${material.id}" title="核减">−</button>
          <button type="button" data-action="mat-plus" data-id="${material.id}" title="补货">＋</button>
        </div>
      </div>`
    )
    .join("");
}

function renderLoans() {
  const currentValue = els.loanSegment.value;
  els.loanSegment.innerHTML = state.segments
    .map((segment) => `<option value="${segment.id}">${escapeHtml(segment.code)}${activeLoanFor(segment.id) ? "（借出中）" : ""}</option>`)
    .join("");
  if (state.segments.some((segment) => segment.id === currentValue)) els.loanSegment.value = currentValue;
  const activeLoans = state.loans.filter((loan) => !loan.returned);
  els.loanList.innerHTML =
    activeLoans
      .map(
        (loan) => `
        <div class="loan-row">
          <span>${escapeHtml(segmentCode(loan.segmentId))} → ${escapeHtml(loan.borrower)}（${formatTime(loan.at)}）</span>
          <button type="button" data-action="return-loan" data-id="${loan.id}">归还</button>
        </div>`
      )
      .join("") || `<p class="empty">当前没有借出的片段。</p>`;
}

function renderMergeSelects() {
  const offlineOrders = state.workOrders.filter((order) => order.source === "offline" && order.status === "active");
  const options = offlineOrders
    .map((order) => `<option value="${order.id}">${order.code}｜${escapeHtml(segmentCode(order.segmentId))}｜${order.stage}</option>`)
    .join("");
  const valueA = els.mergeA.value;
  const valueB = els.mergeB.value;
  els.mergeA.innerHTML = options;
  els.mergeB.innerHTML = options;
  if (offlineOrders.some((order) => order.id === valueA)) els.mergeA.value = valueA;
  if (offlineOrders.some((order) => order.id === valueB)) els.mergeB.value = valueB;
  mergePlan = null;
  els.mergePreview.innerHTML = offlineOrders.length
    ? `<p class="empty">选择两张同一片段的离线工单后预检。</p>`
    : `<p class="empty">暂无离线工单，可在工单上点「生成离线副本」。</p>`;
}

function renderLog() {
  els.logList.innerHTML =
    state.log.map((entry) => `<div class="log-row">${formatTime(entry.at)}｜${escapeHtml(entry.text)}</div>`).join("") ||
    `<p class="empty">暂无操作。</p>`;
}

function renderReports() {
  const report = buildReport();
  const fill = (el, lines) => {
    el.innerHTML = lines.length ? lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("") : `<li class="empty">（空）</li>`;
  };
  fill(els.reportPending, report.pending);
  fill(els.reportQuarantine, report.quarantine);
  fill(els.reportRework, report.rework);
  fill(els.reportMaterials, report.materials);
}

function renderAll() {
  saveState();
  els.reelTitle.value = state.reelTitle;
  els.undoBtn.disabled = !state.history.length;
  renderStats();
  renderList();
  renderWarnings();
  renderStations();
  renderOrders();
  renderMaterials();
  renderLoans();
  renderMergeSelects();
  renderLog();
  renderReports();
}

// ---------- 工具 ----------

function formatDuration(seconds) {
  const value = Number(seconds) || 0;
  const minutes = Math.floor(value / 60);
  const rest = String(value % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- 核对台原有动作 ----------

async function addSegment(event) {
  event.preventDefault();
  const thumb = await readFileAsDataUrl(els.thumbInput.files[0]);
  pushHistory();
  state.segments.push({
    id: crypto.randomUUID(),
    code: els.codeInput.value.trim(),
    duration: Number(els.durationInput.value),
    shift: els.shiftInput.value,
    damage: els.damageInput.value,
    note: els.noteInput.value.trim(),
    thumb
  });
  els.segmentForm.reset();
  els.durationInput.value = 12;
  renderAll();
}

function moveSegment(id, direction) {
  const index = state.segments.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= state.segments.length) return;
  pushHistory();
  const [item] = state.segments.splice(index, 1);
  state.segments.splice(target, 0, item);
  renderAll();
}

function deleteSegment(id) {
  const segment = findSegment(id);
  if (!segment) return;
  const activeOrder = state.workOrders.find((order) => order.segmentId === id && order.status === "active");
  if (activeOrder) {
    showMsg(`片段 ${segment.code} 有进行中的工单 ${activeOrder.code}，不能删除。`, "error");
    return;
  }
  pushHistory();
  state.segments = state.segments.filter((item) => item.id !== id);
  renderAll();
}

function exportList() {
  const lines = [
    `胶片卷：${state.reelTitle || "未命名胶片卷"}`,
    `总时长：${formatDuration(state.segments.reduce((sum, item) => sum + Number(item.duration), 0))}`,
    "",
    ...state.segments.map((item, index) => `${index + 1}. ${item.code}｜${formatDuration(item.duration)}｜${item.shift}｜${item.damage}｜${item.note || "无备注"}`)
  ];
  downloadText(lines.join("\n"), `${state.reelTitle || "film-reel"}-checklist.txt`);
}

// ---------- 事件绑定 ----------

els.reelTitle.addEventListener("input", () => {
  state.reelTitle = els.reelTitle.value;
  saveState();
});
els.colorFilter.addEventListener("change", renderList);
els.searchInput.addEventListener("input", renderList);
els.segmentForm.addEventListener("submit", addSegment);
els.exportBtn.addEventListener("click", exportList);
els.exportReportBtn.addEventListener("click", exportReport);
els.undoBtn.addEventListener("click", undo);
els.mergePreviewBtn.addEventListener("click", previewMerge);

els.mergePreview.addEventListener("click", (event) => {
  if (event.target.closest("#mergeConfirmBtn")) confirmMerge();
});

els.segmentList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "move-up") moveSegment(id, -1);
  if (action === "move-down") moveSegment(id, 1);
  if (action === "delete") deleteSegment(id);
  if (action === "create-order") createOrder(id, "online");
});

els.orderList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "advance") advanceOrder(id);
  if (action === "pass-review") passReview(id);
  if (action === "fail-review") {
    const select = els.orderList.querySelector(`select[data-role="return-stage"][data-id="${id}"]`);
    failReview(id, select ? select.value : "清洗");
  }
  if (action === "archive") archiveOrder(id);
  if (action === "cancel") cancelOrder(id);
  if (action === "copy-offline") copyOffline(id);
  if (action === "add-finding") {
    const item = els.orderList.querySelector(`select[data-role="finding-item"][data-id="${id}"]`).value;
    const conclusion = els.orderList.querySelector(`select[data-role="finding-conclusion"][data-id="${id}"]`).value;
    addFinding(id, item, conclusion);
  }
  if (action === "remove-finding") removeFinding(id, Number(button.dataset.index));
});

els.materialList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "mat-minus") adjustMaterial(button.dataset.id, -1);
  if (button.dataset.action === "mat-plus") adjustMaterial(button.dataset.id, 1);
});

els.loanForm.addEventListener("submit", (event) => {
  event.preventDefault();
  lendSegment(els.loanSegment.value, els.loanBorrower.value.trim());
  els.loanBorrower.value = "";
});

els.loanList.addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="return-loan"]');
  if (button) returnLoan(button.dataset.id);
});

els.segmentList.addEventListener("dragstart", (event) => {
  const card = event.target.closest("[data-id]");
  if (!card) return;
  draggedId = card.dataset.id;
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
});

els.segmentList.addEventListener("dragend", (event) => {
  event.target.closest("[data-id]")?.classList.remove("dragging");
  draggedId = null;
});

els.segmentList.addEventListener("dragover", (event) => {
  const card = event.target.closest("[data-id]");
  if (!card || !draggedId || card.dataset.id === draggedId) return;
  event.preventDefault();
  const fromIndex = state.segments.findIndex((item) => item.id === draggedId);
  const toIndex = state.segments.findIndex((item) => item.id === card.dataset.id);
  if (fromIndex < 0 || toIndex < 0) return;
  const [item] = state.segments.splice(fromIndex, 1);
  state.segments.splice(toIndex, 0, item);
  renderAll();
});

renderAll();
