const STATUS_LABELS = {
  Z: "暂存",
  A: "已创建",
  B: "审核中",
  C: "已审核",
  D: "重新审核",
};

function text(value) {
  return String(value == null ? "" : value).trim();
}

function number(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value).replaceAll(",", "").replace(/[^0-9+\-.eE]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstNumber(row, keys) {
  for (const key of keys) {
    if (row[key] != null && row[key] !== "" && Number.isFinite(Number(String(row[key]).replaceAll(",", "")))) {
      return number(row[key]);
    }
  }
  return 0;
}

function round(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}

function dateOnly(value) {
  const match = text(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function monthOf(value) {
  const date = dateOnly(value);
  return date ? date.slice(0, 7) : "未知月份";
}

function supplierParts(row) {
  const code = text(row["供应商编码"] || row["往来单位编码"] || row["结算供应商编码"]);
  const name = text(row["供应商"] || row["往来单位"] || row["结算供应商"]);
  return { code, name, key: code || (name ? `name:${name}` : "") };
}

function materialParts(row) {
  return {
    code: text(row["物料编码"]),
    name: text(row["物料名称"]),
  };
}

function signedInvoiceAmount(row) {
  const amount = firstNumber(row, ["采购发票金额(本位币)", "采购发票金额", "采购发票价税合计"]);
  return text(row["红蓝字"]) === "1" && amount > 0 ? -amount : amount;
}

function amountFromPurchase(row, seenBills) {
  const line = firstNumber(row, ["明细价税合计(本位币)", "明细价税合计", "明细金额(本位币)", "明细金额"]);
  if (line || row["明细价税合计(本位币)"] === 0 || row["明细价税合计"] === 0) return line;
  const bill = text(row["采购订单号"]);
  if (bill && seenBills.has(bill)) return 0;
  if (bill) seenBills.add(bill);
  return firstNumber(row, ["订单价税合计(本位币)", "订单价税合计"]);
}

function amountFromPayable(row, seenBills) {
  const line = firstNumber(row, ["应付明细价税合计(本位币)", "应付明细价税合计"]);
  if (line || row["应付明细价税合计(本位币)"] === 0 || row["应付明细价税合计"] === 0) return line;
  const bill = text(row["应付单号"]);
  if (bill && seenBills.has(bill)) return 0;
  if (bill) seenBills.add(bill);
  return firstNumber(row, ["应付价税合计(本位币)", "应付价税合计"]);
}

function uniqueHeaderAmount(row, seenBills, billKey, keys) {
  const bill = text(row[billKey]);
  if (bill && seenBills.has(bill)) return 0;
  if (bill) seenBills.add(bill);
  return firstNumber(row, keys);
}

function createSupplier(parts) {
  return {
    供应商编码: parts.code,
    供应商: parts.name || parts.code,
    orderBills: new Set(),
    orderAmount: 0,
    returnAmount: 0,
    payableAmount: 0,
    uninvoiceAmount: 0,
    invoiceAmount: 0,
    paidAmount: 0,
    orderedQty: 0,
    poInboundQty: 0,
    poReturnQty: 0,
    receivedQty: 0,
    inboundQty: 0,
    returnQty: 0,
    receiveBills: new Set(),
    inboundBills: new Set(),
    returnBills: new Set(),
    payableBills: new Set(),
    paymentBills: new Set(),
    invoiceBills: new Set(),
    statusCounts: new Map(),
    lastOrderDate: "",
    earliestOrderDate: "",
    materials: new Map(),
    monthly: new Map(),
    pricePoints: [],
    deliveryDates: [],
    details: [],
  };
}

function ensureSupplier(map, row) {
  const parts = supplierParts(row);
  if (!parts.key) return null;
  let supplier = map.get(parts.key);
  if (!supplier) {
    supplier = createSupplier(parts);
    map.set(parts.key, supplier);
  } else {
    if (!supplier["供应商编码"] && parts.code) supplier["供应商编码"] = parts.code;
    if ((!supplier["供应商"] || supplier["供应商"] === supplier["供应商编码"]) && parts.name) supplier["供应商"] = parts.name;
  }
  return supplier;
}

function ensureMaterial(supplier, row) {
  const parts = materialParts(row);
  const key = parts.code || (parts.name ? `name:${parts.name}` : "未知物料");
  let material = supplier.materials.get(key);
  if (!material) {
    material = { 物料编码: parts.code, 物料名称: parts.name || parts.code || "未知物料", orderedQty: 0, orderAmount: 0, inboundQty: 0, returnQty: 0, prices: [] };
    supplier.materials.set(key, material);
  }
  return material;
}

function ensureMonth(supplier, month) {
  let value = supplier.monthly.get(month);
  if (!value) {
    value = { 月份: month, 订单金额: 0, 入库金额: 0, 付款金额: 0, 采购订单数: 0, 入库数量: 0 };
    supplier.monthly.set(month, value);
  }
  return value;
}

function addStatus(supplier, status) {
  const label = STATUS_LABELS[text(status)] || text(status) || "未知";
  supplier.statusCounts.set(label, (supplier.statusCounts.get(label) || 0) + 1);
}

function updateDateRange(supplier, date) {
  if (!date) return;
  if (!supplier.lastOrderDate || date > supplier.lastOrderDate) supplier.lastOrderDate = date;
  if (!supplier.earliestOrderDate || date < supplier.earliestOrderDate) supplier.earliestOrderDate = date;
}

function addPurchaseRows(map, rows) {
  const seenHeaderBills = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const supplier = ensureSupplier(map, row);
    if (!supplier) continue;
    const bill = text(row["采购订单号"]);
    const date = dateOnly(row["采购日期"]);
    const amount = amountFromPurchase(row, seenHeaderBills);
    const orderedQty = firstNumber(row, ["采购基本数量", "采购数量"]);
    const inboundQty = firstNumber(row, ["累计入库数量(基本)", "累计入库数量"]);
    const returnQty = firstNumber(row, ["累计退料数量(基本)", "累计退料数量"]);
    const material = ensureMaterial(supplier, row);
    const month = ensureMonth(supplier, monthOf(row["采购日期"]));
    if (bill) supplier.orderBills.add(bill);
    addStatus(supplier, row["审核状态"]);
    updateDateRange(supplier, date);
    supplier.orderAmount = round(supplier.orderAmount + amount);
    supplier.orderedQty = round(supplier.orderedQty + orderedQty);
    supplier.poInboundQty = round(supplier.poInboundQty + inboundQty);
    supplier.poReturnQty = round(supplier.poReturnQty + returnQty);
    month.订单金额 = round(month.订单金额 + amount);
    if (bill && !supplier.details.some((item) => item["采购订单号"] === bill)) {
      supplier.details.push({
        采购订单号: bill,
        采购日期: date,
        采购组织: text(row["采购组织"]),
        订单金额: amount,
        采购数量: orderedQty,
        入库数量: inboundQty,
        退料数量: returnQty,
        最晚交货日期: dateOnly(row["最晚交货日期"] || row["交货日期"]),
        审核状态: STATUS_LABELS[text(row["审核状态"])] || text(row["审核状态"]),
        关闭状态: text(row["关闭状态"]),
      });
    }
    material.orderedQty = round(material.orderedQty + orderedQty);
    material.orderAmount = round(material.orderAmount + amount);
    material.poInboundQty = round((material.poInboundQty || 0) + inboundQty);
    material.poReturnQty = round((material.poReturnQty || 0) + returnQty);
    const unitPrice = firstNumber(row, ["含税单价"]);
    if (unitPrice) {
      material.prices.push({ date, value: unitPrice });
      supplier.pricePoints.push({ material: material["物料编码"] || material["物料名称"], date, value: unitPrice });
    }
    const deliveryDate = dateOnly(row["最晚交货日期"] || row["交货日期"]);
    if (deliveryDate) supplier.deliveryDates.push({ date: deliveryDate, openQty: Math.max(orderedQty - inboundQty, 0), amount });
  }
}

function addReceiveRows(map, rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const supplier = ensureSupplier(map, row);
    if (!supplier) continue;
    const qty = firstNumber(row, ["收料基本数量", "采购基本数量", "实到数量"]);
    const bill = text(row["收料单号"]);
    const date = dateOnly(row["收料日期"]);
    supplier.receivedQty = round(supplier.receivedQty + qty);
    if (bill) supplier.receiveBills.add(bill);
    const material = ensureMaterial(supplier, row);
    material.receivedQty = round((material.receivedQty || 0) + qty);
    const month = ensureMonth(supplier, monthOf(row["收料日期"]));
    month.入库数量 = round(month.入库数量 + qty);
    updateDateRange(supplier, date);
  }
}

function addInboundRows(map, rows) {
  const seenBills = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const supplier = ensureSupplier(map, row);
    if (!supplier) continue;
    const qty = firstNumber(row, ["入库基本数量", "库存基本数量", "实收数量"]);
    const amount = uniqueHeaderAmount(row, seenBills, "入库单号", ["入库价税合计(本位币)", "入库价税合计", "入库金额(本位币)", "入库金额"]);
    const bill = text(row["入库单号"]);
    const month = ensureMonth(supplier, monthOf(row["入库日期"]));
    supplier.inboundQty = round(supplier.inboundQty + qty);
    if (bill) supplier.inboundBills.add(bill);
    month.入库金额 = round(month.入库金额 + amount);
    month.入库数量 = round(month.入库数量 + qty);
    const material = ensureMaterial(supplier, row);
    material.inboundQty = round(material.inboundQty + qty);
  }
}

function addReturnRows(map, rows) {
  const seenBills = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const supplier = ensureSupplier(map, row);
    if (!supplier) continue;
    const qty = firstNumber(row, ["退料基本数量", "实退数量", "退料数量"]);
    const amount = uniqueHeaderAmount(row, seenBills, "退料单号", ["退料价税合计(本位币)", "退料价税合计", "退料金额(本位币)", "退料金额"]);
    const bill = text(row["退料单号"]);
    supplier.returnQty = round(supplier.returnQty + qty);
    supplier.returnAmount = round(supplier.returnAmount + amount);
    if (bill) supplier.returnBills.add(bill);
    const material = ensureMaterial(supplier, row);
    material.returnQty = round(material.returnQty + qty);
  }
}

function addPayableRows(map, rows) {
  const seenHeaderBills = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const supplier = ensureSupplier(map, row);
    if (!supplier) continue;
    supplier.payableAmount = round(supplier.payableAmount + amountFromPayable(row, seenHeaderBills));
    supplier.uninvoiceAmount = round(supplier.uninvoiceAmount + firstNumber(row, ["未开票核销金额"]));
    const bill = text(row["应付单号"]);
    if (bill) supplier.payableBills.add(bill);
  }
}

function addPaymentRows(map, rows) {
  const seenBills = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const supplier = ensureSupplier(map, row);
    if (!supplier) continue;
    const amount = uniqueHeaderAmount(row, seenBills, "付款单号", ["实付金额(本位币)", "实付金额", "付款金额(本位币)", "付款金额"]);
    supplier.paidAmount = round(supplier.paidAmount + amount);
    const bill = text(row["付款单号"]);
    if (bill) supplier.paymentBills.add(bill);
    const month = ensureMonth(supplier, monthOf(row["付款日期"]));
    month.付款金额 = round(month.付款金额 + amount);
  }
}

function addInvoiceRows(map, rows) {
  const seenBills = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const supplier = ensureSupplier(map, row);
    if (!supplier) continue;
    supplier.invoiceAmount = round(supplier.invoiceAmount + uniqueHeaderAmount({ ...row, "采购发票金额(本位币)": signedInvoiceAmount(row) }, seenBills, "采购发票号", ["采购发票金额(本位币)", "采购发票金额"]));
    const bill = text(row["采购发票号"]);
    if (bill) supplier.invoiceBills.add(bill);
  }
}

function addQualityRows(map, rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const supplier = ensureSupplier(map, row);
    if (!supplier) continue;
    supplier.qualityInspectQty = round((supplier.qualityInspectQty || 0) + firstNumber(row, ["检验基本数量", "检验数量"]));
    supplier.qualityQualifiedQty = round((supplier.qualityQualifiedQty || 0) + firstNumber(row, ["合格基本数量", "合格数"]));
    supplier.qualityUnqualifiedQty = round((supplier.qualityUnqualifiedQty || 0) + firstNumber(row, ["不合格基本数量", "不合格数", "拒收基本数量", "拒收数"]));
  }
}

function priceChange(material) {
  const points = material.prices.filter((point) => point.value).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (points.length < 2) return 0;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  return first ? round((last / first - 1) * 100) : 0;
}

function supplierRisk(supplier, dateTo) {
  const flags = [];
  const ordered = supplier.orderedQty;
  const openQty = Math.max(ordered - supplier.inboundQty, 0);
  const returnRate = ordered ? supplier.returnQty / ordered : 0;
  const priceRisks = [...supplier.materials.values()].filter((material) => priceChange(material) >= 10);
  const overdue = supplier.deliveryDates.filter((item) => item.date && item.date < dateTo && item.openQty > 0);
  if (overdue.length) flags.push(`交付逾期 ${overdue.length} 项`);
  if (returnRate >= 0.05 && supplier.returnQty > 0) flags.push(`退料率 ${(returnRate * 100).toFixed(1)}%`);
  if (priceRisks.length) flags.push(`${priceRisks.length} 项物料涨价 ≥10%`);
  if (supplier.qualityUnqualifiedQty > 0) flags.push(`质检不合格 ${supplier.qualityUnqualifiedQty}`);
  if (!flags.length && openQty > 0) flags.push("订单仍有未入库数量");
  const level = flags.length >= 2 ? "高" : (flags.length ? "中" : "低");
  return { level, flags, openQty };
}

function publicSupplierRow(supplier, totalOrderAmount, dateTo) {
  const risk = supplierRisk(supplier, dateTo);
  const orderAmount = round(supplier.orderAmount);
  const netAmount = round(orderAmount - supplier.returnAmount);
  const orderedQty = round(supplier.orderedQty);
  const inboundQty = round(supplier.inboundQty);
  const paidAmount = round(supplier.paidAmount);
  const qualityInspectQty = number(supplier.qualityInspectQty);
  const qualityQualifiedQty = number(supplier.qualityQualifiedQty);
  const prices = [...supplier.materials.values()].flatMap((material) => material.prices);
  const averagePrice = orderedQty ? round(orderAmount / orderedQty) : (prices.length ? round(prices.reduce((sum, item) => sum + item.value, 0) / prices.length) : 0);
  const changes = [...supplier.materials.values()].map(priceChange).filter((value) => value);
  const priceTrend = changes.length ? round(changes.reduce((sum, value) => sum + value, 0) / changes.length) : 0;
  return {
    "供应商编码": supplier["供应商编码"],
    "供应商": supplier["供应商"],
    "采购订单数": supplier.orderBills.size,
    "订单金额": orderAmount,
    "采购金额占比": totalOrderAmount > 0 ? round(orderAmount / totalOrderAmount * 100) : 0,
    "净采购金额": netAmount,
    "采购数量": orderedQty,
    "到货数量": round(supplier.receivedQty),
    "入库数量": inboundQty,
    "入库率": orderedQty ? round(inboundQty / orderedQty * 100) : 0,
    "退料数量": round(supplier.returnQty),
    "退料金额": round(supplier.returnAmount),
    "应付金额": round(supplier.payableAmount),
    "未开票金额": round(supplier.uninvoiceAmount),
    "采购发票金额": round(supplier.invoiceAmount),
    "已付款金额": paidAmount,
    "付款覆盖率": supplier.payableAmount ? round(paidAmount / supplier.payableAmount * 100) : 0,
    "平均含税单价": averagePrice,
    "价格变化": priceTrend,
    "最晚交货日": supplier.deliveryDates.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]?.date || "",
    "逾期未入库数量": round(risk.openQty),
    "质量合格率": qualityInspectQty ? round(qualityQualifiedQty / qualityInspectQty * 100) : null,
    "风险等级": risk.level,
    "风险提示": risk.flags.join("；"),
  };
}

function detailForSupplier(supplier, dateTo) {
  const risk = supplierRisk(supplier, dateTo);
  const materials = [...supplier.materials.values()].map((material) => ({
    "物料编码": material["物料编码"],
    "物料名称": material["物料名称"],
    "采购数量": round(material.orderedQty),
    "订单金额": round(material.orderAmount),
    "入库数量": round(material.inboundQty),
    "退料数量": round(material.returnQty),
    "平均含税单价": material.orderedQty ? round(material.orderAmount / material.orderedQty) : 0,
    "价格变化": priceChange(material),
  })).sort((a, b) => b["订单金额"] - a["订单金额"]);
  const monthly = [...supplier.monthly.values()].sort((a, b) => String(a.月份).localeCompare(String(b.月份))).map((row) => ({ ...row }));
  const exceptions = risk.flags.map((flag) => ({ 类型: "供应商风险", 描述: flag }));
  return {
    "供应商编码": supplier["供应商编码"],
    "供应商": supplier["供应商"],
    kpis: {
      订单金额: round(supplier.orderAmount),
      净采购金额: round(supplier.orderAmount - supplier.returnAmount),
      采购订单数: supplier.orderBills.size,
      采购数量: round(supplier.orderedQty),
      入库数量: round(supplier.inboundQty),
      退料数量: round(supplier.returnQty),
      退料金额: round(supplier.returnAmount),
      应付金额: round(supplier.payableAmount),
      未开票金额: round(supplier.uninvoiceAmount),
      采购发票金额: round(supplier.invoiceAmount),
      已付款金额: round(supplier.paidAmount),
      逾期未入库数量: round(risk.openQty),
      质量合格率: supplier.qualityInspectQty ? round(supplier.qualityQualifiedQty / supplier.qualityInspectQty * 100) : null,
      风险等级: risk.level,
    },
    monthly,
    materials,
    orders: supplier.details.sort((a, b) => String(b["采购日期"]).localeCompare(String(a["采购日期"]))).slice(0, 200),
    exceptions,
  };
}

function aggregateSupplierPurchase({ purchaseRows = [], receiveRows = [], inboundRows = [], returnRows = [], payableRows = [], paymentRows = [], invoiceRows = [], qualityRows = [], dateFrom, dateTo, sourceStatus = [], selectedSupplierNumber = "" }) {
  const map = new Map();
  addPurchaseRows(map, purchaseRows);
  addReceiveRows(map, receiveRows);
  addInboundRows(map, inboundRows);
  addReturnRows(map, returnRows);
  addPayableRows(map, payableRows);
  addPaymentRows(map, paymentRows);
  addInvoiceRows(map, invoiceRows);
  addQualityRows(map, qualityRows);
  const inboundAvailable = sourceStatus.find((source) => source.id === "inbound")?.available === true;
  const returnAvailable = sourceStatus.find((source) => source.id === "returns")?.available === true;
  for (const supplier of map.values()) {
    if (!inboundAvailable) supplier.inboundQty = supplier.poInboundQty;
    if (!returnAvailable) supplier.returnQty = supplier.poReturnQty;
    for (const material of supplier.materials.values()) {
      if (!inboundAvailable) material.inboundQty = material.poInboundQty || 0;
      if (!returnAvailable) material.returnQty = material.poReturnQty || 0;
    }
  }
  const totalOrderAmount = [...map.values()].reduce((sum, supplier) => sum + supplier.orderAmount, 0);
  const rows = [...map.values()].map((supplier) => publicSupplierRow(supplier, totalOrderAmount, dateTo)).sort((a, b) => b["订单金额"] - a["订单金额"] || String(a["供应商编码"]).localeCompare(String(b["供应商编码"]), "zh-CN", { numeric: true }));
  const top5Amount = rows.slice(0, 5).reduce((sum, row) => sum + row["订单金额"], 0);
  const qualityAvailable = sourceStatus.find((source) => source.id === "quality")?.available === true;
  const statistics = {
    type: "supplier_purchase_analysis",
    dateFrom,
    dateTo,
    supplierCount: rows.length,
    orderCount: rows.reduce((sum, row) => sum + row["采购订单数"], 0),
    totalOrderAmount: round(totalOrderAmount),
    totalNetPurchaseAmount: round(rows.reduce((sum, row) => sum + row["净采购金额"], 0)),
    totalOrderedQty: round(rows.reduce((sum, row) => sum + row["采购数量"], 0)),
    totalReceivedQty: round(rows.reduce((sum, row) => sum + row["到货数量"], 0)),
    totalInboundQty: round(rows.reduce((sum, row) => sum + row["入库数量"], 0)),
    totalReturnQty: round(rows.reduce((sum, row) => sum + row["退料数量"], 0)),
    totalReturnAmount: round(rows.reduce((sum, row) => sum + row["退料金额"], 0)),
    totalPayableAmount: round(rows.reduce((sum, row) => sum + row["应付金额"], 0)),
    totalUninvoiceAmount: round(rows.reduce((sum, row) => sum + row["未开票金额"], 0)),
    totalInvoiceAmount: round(rows.reduce((sum, row) => sum + row["采购发票金额"], 0)),
    totalPaidAmount: round(rows.reduce((sum, row) => sum + row["已付款金额"], 0)),
    top5Concentration: totalOrderAmount ? round(top5Amount / totalOrderAmount * 100) : 0,
    overdueSupplierCount: rows.filter((row) => row["逾期未入库数量"] > 0).length,
    highRiskSupplierCount: rows.filter((row) => row["风险等级"] === "高").length,
    qualityAvailable,
    qualityCoverage: qualityAvailable ? "已读取质检单" : "质量管理模块未购买或不可访问",
    sourceStatus,
  };
  const selected = text(selectedSupplierNumber);
  const selectedSupplier = selected
    ? [...map.values()].find((supplier) => supplier["供应商编码"] === selected || supplier["供应商"] === selected)
    : null;
  const summary = rows.length
    ? `${dateFrom} 至 ${dateTo} 共 ${rows.length} 家供应商，采购订单金额 ¥${totalOrderAmount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}；前五家供应商金额占比 ${statistics.top5Concentration.toFixed(2)}%。${statistics.qualityAvailable ? "质检指标已纳入。" : "质检模块当前不可用，其他采购、收货、入库、应付、发票和付款指标仍可用。"}`
    : `${dateFrom} 至 ${dateTo} 没有找到可汇总的供应商采购单据。`;
  return {
    rows,
    statistics,
    partial: sourceStatus.some((source) => !source.available),
    sourceStatus,
    details: selectedSupplier ? detailForSupplier(selectedSupplier, dateTo) : null,
    summary,
  };
}

module.exports = {
  aggregateSupplierPurchase,
  supplierParts,
  dateOnly,
  number,
  round,
};
