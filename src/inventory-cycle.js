const EPSILON = 0.000001;

const INVENTORY_CYCLE_COLUMNS = [
  "库存阶段",
  "销售子项目编码",
  "销售子项目名称",
  "仓库",
  "物料编码",
  "物料名称",
  "批号",
  "当前库存数量",
  "收料入库日期",
  "发货日期",
  "客户签收日期",
  "公司仓库龄",
  "项目仓库龄",
  "客户仓待签收",
  "总库存周期",
  "状态",
  "收料入库单",
  "销售发货单",
  "客户签收单",
];

function stringValue(value) {
  return String(value == null ? "" : value).trim();
}

function dateValue(value) {
  const text = stringValue(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function quantityValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundQuantity(value) {
  return Math.round((value + Number.EPSILON) * 1000000) / 1000000;
}

function normalized(value) {
  return stringValue(value).toUpperCase();
}

function warehouseStage(name) {
  const value = stringValue(name);
  if (value.startsWith("项目仓-")) return "项目仓";
  if (value.startsWith("客户仓-")) return "客户仓";
  if (value.startsWith("公司仓-") || value.startsWith("公司总仓-")) return "公司仓";
  return "其他仓库";
}

function warehouseHasProject(info) {
  return Boolean(info?.projectNumber || info?.subprojectNumber);
}

function daysBetween(from, to) {
  if (!from || !to) return null;
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  return Math.max(0, Math.floor((end - start) / 86400000));
}

function warehouseInfo(row) {
  const warehouseNumber = stringValue(row["仓库编码"] || row["编码"] || row["FNumber"]);
  const warehouseName = stringValue(row["仓库名称"] || row["名称"] || row["FName"]);
  return {
    warehouseNumber,
    warehouseName,
    stage: warehouseStage(warehouseName),
    projectNumber: stringValue(row["销售项目编码"]),
    projectName: stringValue(row["销售项目名称"]),
    subprojectNumber: stringValue(row["销售子项目编码"]),
    subprojectName: stringValue(row["销售子项目名称"]),
  };
}

function matchesWarehouse(info, args) {
  const scope = stringValue(args.warehouseScope || "all");
  if (info.stage === "项目仓" || info.stage === "客户仓") {
    if (!warehouseHasProject(info)) return false;
  } else if (info.stage !== "公司仓") return false;
  if (scope === "project" && info.stage !== "项目仓") return false;
  if (scope === "customer" && info.stage !== "客户仓") return false;
  if (scope === "company" && info.stage !== "公司仓") return false;
  if (args.warehouseName && !info.warehouseName.includes(stringValue(args.warehouseName))) return false;
  if (args.subprojectNumber) {
    const needle = normalized(args.subprojectNumber);
    if (!normalized(info.subprojectNumber).includes(needle) && !normalized(info.subprojectName).includes(needle)) return false;
  }
  return true;
}

function resolveWarehouse(warehouseMap, number, name = "") {
  const candidates = warehouseMap.get(stringValue(number)) || [];
  const exactName = candidates.find((warehouse) => !name || warehouse.warehouseName === stringValue(name));
  return exactName || candidates[0] || null;
}

function currentInventoryInfo(row, warehouseMap) {
  const warehouseNumber = stringValue(row["仓库编码"]);
  const warehouse = resolveWarehouse(warehouseMap, warehouseNumber, row["仓库"]);
  if (!warehouse) return null;
  return {
    warehouse,
    materialNumber: stringValue(row["物料编码"]),
    materialName: stringValue(row["物料名称"]),
    lot: stringValue(row["批号"]),
    quantity: quantityValue(row["基本库存数量"]),
    projectNumber: stringValue(row["项目编号"]),
  };
}

function materialMatches(row, args) {
  if (args.materialNumber && normalized(row.materialNumber) !== normalized(args.materialNumber)) return false;
  if (args.materialName && !row.materialName.includes(stringValue(args.materialName))) return false;
  return true;
}

function lineMatch(line, target, options = {}) {
  if (line.warehouseNumber && target.warehouseNumber && line.warehouseNumber !== target.warehouseNumber) return false;
  const lineWarehouseName = line.warehouse?.warehouseName || line.warehouseName;
  if (lineWarehouseName && target.warehouseName && lineWarehouseName !== target.warehouseName) return false;
  if (line.materialNumber && target.materialNumber && normalized(line.materialNumber) !== normalized(target.materialNumber)) return false;
  if (target.lot && line.lot && normalized(line.lot) !== normalized(target.lot)) return false;
  if (target.lot && !line.lot && options.requireLot) return false;
  if (target.subprojectNumber && line.subprojectNumber && normalized(line.subprojectNumber) !== normalized(target.subprojectNumber)) return false;
  return true;
}

function makeReceiptLayers(rows, warehouseMap, args, asOfDate) {
  return rows.map((row, index) => {
    const warehouseNumber = stringValue(row["仓库编码"]);
    const warehouse = resolveWarehouse(warehouseMap, warehouseNumber, row["仓库"]);
    const date = dateValue(row["日期"]);
    const quantity = quantityValue(row["基本入库数量"]);
    return {
      id: `receipt-${index}`,
      warehouseNumber,
      warehouse,
      materialNumber: stringValue(row["物料编码"]),
      materialName: stringValue(row["物料名称"]),
      lot: stringValue(row["批号"]),
      subprojectNumber: stringValue(row["销售子项目编码"]) || warehouse?.subprojectNumber || "",
      subprojectName: stringValue(row["销售子项目名称"]) || warehouse?.subprojectName || "",
      date,
      quantity,
      remaining: quantity,
      billNumber: stringValue(row["单据编号"]),
      sourceBillNumber: stringValue(row["源单编号"]),
      projectNumber: stringValue(row["项目编号"]),
      companyEntryDate: date,
      projectEntryDate: warehouse?.stage === "项目仓" ? date : "",
      customerEntryDate: warehouse?.stage === "客户仓" ? date : "",
      invalidDate: !date || date > asOfDate,
      _source: "收料入库",
    };
  }).filter((layer) => ["公司仓", "项目仓", "客户仓"].includes(layer.warehouse?.stage)
    && (layer.warehouse.stage === "公司仓" || warehouseHasProject(layer.warehouse))
    && layer.quantity > EPSILON
    && !layer.invalidDate
    && materialMatches(layer, args));
}

function makeTransferLines(rows, warehouseMap, args, asOfDate) {
  return rows.map((row, index) => {
    const sourceWarehouseNumber = stringValue(row["调出仓库编码"]);
    const destinationWarehouseNumber = stringValue(row["调入仓库编码"]);
    const sourceWarehouse = resolveWarehouse(warehouseMap, sourceWarehouseNumber, row["调出仓库"]);
    const destinationWarehouse = resolveWarehouse(warehouseMap, destinationWarehouseNumber, row["调入仓库"]);
    const date = dateValue(row["日期"]);
    const quantity = quantityValue(row["调拨基本数量"]);
    return {
      id: `transfer-${index}`,
      billNumber: stringValue(row["单据编号"]),
      sourceBillNumber: stringValue(row["源单编号"]),
      date,
      businessDate: dateValue(row["入库日期"]),
      sourceWarehouseNumber,
      sourceWarehouse,
      sourceWarehouseName: stringValue(row["调出仓库"]),
      destinationWarehouseNumber,
      destinationWarehouse,
      destinationWarehouseName: stringValue(row["调入仓库"]),
      materialNumber: stringValue(row["物料编码"]),
      materialName: stringValue(row["物料名称"]),
      sourceLot: stringValue(row["调出批号"]),
      destinationLot: stringValue(row["调入批号"]) || stringValue(row["调出批号"]),
      quantity,
      subprojectNumber: stringValue(row["销售子项目编码"]),
      subprojectName: stringValue(row["销售子项目名称"]),
      invalidDate: !date || date > asOfDate,
    };
  }).filter((line) => ["公司仓", "项目仓", "客户仓"].includes(line.sourceWarehouse?.stage)
    && ["公司仓", "项目仓", "客户仓"].includes(line.destinationWarehouse?.stage)
    && (line.sourceWarehouse?.stage === "公司仓" || warehouseHasProject(line.sourceWarehouse))
    && (line.destinationWarehouse?.stage === "公司仓" || warehouseHasProject(line.destinationWarehouse))
    && line.quantity > EPSILON
    && !line.invalidDate
    && materialMatches(line, args));
}

function makeSignoffLines(rows, warehouseMap, args, asOfDate) {
  return rows.map((row, index) => {
    const warehouseNumber = stringValue(row["仓库编码"]);
    const warehouse = resolveWarehouse(warehouseMap, warehouseNumber, row["仓库"]);
    const date = dateValue(row["日期"]);
    return {
      id: `signoff-${index}`,
      billNumber: stringValue(row["单据编号"]),
      sourceBillNumber: stringValue(row["源单编号"]),
      date,
      warehouseNumber,
      warehouse,
      warehouseName: stringValue(row["仓库"]),
      materialNumber: stringValue(row["物料编码"]),
      materialName: stringValue(row["物料名称"]),
      lot: stringValue(row["批号"]),
      quantity: quantityValue(row["签收基本数量"]),
      subprojectNumber: stringValue(row["销售子项目编码"]),
      subprojectName: stringValue(row["销售子项目名称"]),
      invalidDate: !date || date > asOfDate,
    };
  }).filter((line) => line.quantity > EPSILON && !line.invalidDate && materialMatches(line, args));
}

function candidateLayers(layers, target, dateField) {
  return layers
    .filter((layer) => layer.remaining > EPSILON && lineMatch(layer, target) && (!target.sourceBillNumber || layer.sourceBillNumber === target.sourceBillNumber))
    .sort((left, right) => String(left[dateField] || "9999-99-99").localeCompare(String(right[dateField] || "9999-99-99")) || left.id.localeCompare(right.id));
}

function allocate(layers, target, quantity, dateField, onTake) {
  let remaining = quantity;
  for (const layer of candidateLayers(layers, target, dateField)) {
    if (remaining <= EPSILON) break;
    const taken = Math.min(layer.remaining, remaining);
    if (taken <= EPSILON) continue;
    layer.remaining = roundQuantity(layer.remaining - taken);
    remaining = roundQuantity(remaining - taken);
    onTake(layer, taken);
  }
  return remaining;
}

function layerRow(layer, quantity, asOfDate) {
  const isProject = layer.stage === "项目仓";
  const companyAge = layer.stage === "公司仓" ? daysBetween(layer.companyEntryDate || layer.inboundDate, asOfDate) : null;
  const projectAge = layer.stage === "项目仓"
    ? daysBetween(layer.projectEntryDate || layer.inboundDate, asOfDate)
    : (layer.stage === "客户仓" ? daysBetween(layer.projectEntryDate || layer.inboundDate, layer.customerEntryDate || layer.transferDate) : null);
  const customerAge = layer.stage === "客户仓" ? daysBetween(layer.customerEntryDate || layer.transferDate, asOfDate) : null;
  const totalAge = daysBetween(layer.inboundDate, asOfDate);
  const missingInbound = !layer.inboundDate;
  const status = missingInbound
    ? "未匹配收料入库单"
    : (layer.stage === "公司仓" ? "公司仓库存" : (isProject ? "项目仓待发货" : "客户仓待签收"));
  return {
    "库存阶段": layer.stage,
    "销售子项目编码": layer.subprojectNumber,
    "销售子项目名称": layer.subprojectName,
    "仓库": layer.warehouse?.warehouseName || "",
    "物料编码": layer.materialNumber,
    "物料名称": layer.materialName,
    "批号": layer.lot,
    "当前库存数量": roundQuantity(quantity),
    "收料入库日期": layer.inboundDate,
    "发货日期": layer.transferDate || "",
    "客户签收日期": "",
    "公司仓库龄": companyAge,
    "项目仓库龄": projectAge,
    "客户仓待签收": customerAge,
    "总库存周期": totalAge,
    "状态": status,
    "收料入库单": layer.inboundBillNumber,
    "销售发货单": layer.transferBillNumber || "",
    "客户签收单": "",
  };
}

function currentRowLayer(row, warehouse, stage, quantity) {
  return {
    stage,
    warehouse,
    materialNumber: row.materialNumber,
    materialName: row.materialName,
    lot: row.lot,
    subprojectNumber: warehouse.subprojectNumber,
    subprojectName: warehouse.subprojectName,
    inboundDate: "",
    transferDate: "",
    inboundBillNumber: "",
    transferBillNumber: "",
    companyEntryDate: "",
    projectEntryDate: "",
    customerEntryDate: "",
    remaining: quantity,
  };
}

function currentLayerMatches(layer, row) {
  if (layer.warehouseNumber !== row.warehouse.warehouseNumber) return false;
  if (layer.warehouse?.warehouseName && row.warehouse.warehouseName && layer.warehouse.warehouseName !== row.warehouse.warehouseName) return false;
  if (normalized(layer.materialNumber) !== normalized(row.materialNumber)) return false;
  if (row.lot && normalized(layer.lot) !== normalized(row.lot)) return false;
  if (row.warehouse.subprojectNumber && layer.subprojectNumber && normalized(layer.subprojectNumber) !== normalized(row.warehouse.subprojectNumber)) return false;
  return true;
}

function buildCurrentRows(currentRows, layers, asOfDate, stage) {
  const available = layers.map((layer) => ({ ...layer, reportRemaining: layer.remaining }));
  const output = [];
  for (const current of currentRows) {
    let remaining = current.quantity;
    if (remaining <= EPSILON) continue;
    const candidates = available.filter((layer) => layer.reportRemaining > EPSILON && currentLayerMatches(layer, current) && layer.stage === stage)
      .sort((left, right) => String(right.inboundDate || right.transferDate || "0000-00-00").localeCompare(String(left.inboundDate || left.transferDate || "0000-00-00")));
    for (const layer of candidates) {
      if (remaining <= EPSILON) break;
      const taken = Math.min(layer.reportRemaining, remaining);
      layer.reportRemaining = roundQuantity(layer.reportRemaining - taken);
      remaining = roundQuantity(remaining - taken);
      output.push(layerRow(layer, taken, asOfDate));
    }
    if (remaining > EPSILON) {
      const unmatched = currentRowLayer(current, current.warehouse, stage, remaining);
      const row = layerRow(unmatched, remaining, asOfDate);
      row["状态"] = "库存与单据链路未完全匹配";
      output.push(row);
    }
  }
  return output;
}

function buildInventoryCycleResult({ warehouseRows, inventoryRows, inboundRows, transferRows, signoffRows, asOfDate, args = {}, limit = 200 }) {
  const allWarehouses = warehouseRows.map(warehouseInfo).filter((warehouse) => ["公司仓", "项目仓", "客户仓"].includes(warehouse.stage)
    && (warehouse.stage === "公司仓" || warehouseHasProject(warehouse)));
  const warehouses = allWarehouses.filter((warehouse) => matchesWarehouse(warehouse, args));
  const warehouseMap = new Map();
  for (const warehouse of allWarehouses) {
    const candidates = warehouseMap.get(warehouse.warehouseNumber) || [];
    candidates.push(warehouse);
    warehouseMap.set(warehouse.warehouseNumber, candidates);
  }
  const selectedWarehouseKeys = new Set(warehouses.map((warehouse) => `${warehouse.warehouseNumber}|${warehouse.warehouseName}`));
  const currentRows = inventoryRows.map((row) => currentInventoryInfo(row, warehouseMap))
    .filter((row) => row && selectedWarehouseKeys.has(`${row.warehouse.warehouseNumber}|${row.warehouse.warehouseName}`))
    .filter((row) => materialMatches(row, args));
  const inboundLayers = makeReceiptLayers(inboundRows, warehouseMap, args, asOfDate);
  const transfers = makeTransferLines(transferRows, warehouseMap, args, asOfDate).sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
  const signoffs = makeSignoffLines(signoffRows, warehouseMap, args, asOfDate).sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
  const stockLayers = inboundLayers.map((layer) => ({
    ...layer,
    stage: layer.warehouse.stage,
    inboundDate: layer.date,
    inboundBillNumber: layer.billNumber,
    transferDate: "",
    transferBillNumber: "",
    remaining: layer.quantity,
  }));

  for (const transfer of transfers) {
    const target = {
      warehouseNumber: transfer.sourceWarehouseNumber,
      warehouseName: transfer.sourceWarehouseName,
      materialNumber: transfer.materialNumber,
      lot: transfer.sourceLot,
      subprojectNumber: transfer.subprojectNumber || transfer.sourceWarehouse?.subprojectNumber || "",
    };
    let remaining = allocate(stockLayers, target, transfer.quantity, "inboundDate", (sourceLayer, taken) => {
      const destinationStage = transfer.destinationWarehouse.stage;
      stockLayers.push({
        ...sourceLayer,
        id: `${transfer.id}-${sourceLayer.id}`,
        stage: destinationStage,
        warehouseNumber: transfer.destinationWarehouseNumber,
        warehouse: transfer.destinationWarehouse,
        warehouseName: transfer.destinationWarehouseName,
        lot: transfer.destinationLot,
        transferDate: transfer.date,
        transferBillNumber: transfer.billNumber,
        sourceBillNumber: transfer.sourceBillNumber,
        companyEntryDate: destinationStage === "公司仓" ? transfer.date : sourceLayer.companyEntryDate,
        projectEntryDate: destinationStage === "项目仓" ? transfer.date : sourceLayer.projectEntryDate,
        customerEntryDate: destinationStage === "客户仓" ? transfer.date : sourceLayer.customerEntryDate,
        remaining: taken,
      });
    });
    if (remaining > EPSILON) {
      const destinationStage = transfer.destinationWarehouse.stage;
      stockLayers.push({
        id: `${transfer.id}-unmatched`,
        stage: destinationStage,
        warehouseNumber: transfer.destinationWarehouseNumber,
        warehouse: transfer.destinationWarehouse,
        warehouseName: transfer.destinationWarehouseName,
        materialNumber: transfer.materialNumber,
        materialName: transfer.materialName,
        lot: transfer.destinationLot,
        subprojectNumber: transfer.subprojectNumber || transfer.destinationWarehouse?.subprojectNumber || "",
        subprojectName: transfer.subprojectName || transfer.destinationWarehouse?.subprojectName || "",
        inboundDate: "",
        inboundBillNumber: "",
        transferDate: transfer.date,
        transferBillNumber: transfer.billNumber,
        sourceBillNumber: transfer.sourceBillNumber,
        companyEntryDate: destinationStage === "公司仓" ? transfer.date : "",
        projectEntryDate: destinationStage === "项目仓" ? transfer.date : "",
        customerEntryDate: destinationStage === "客户仓" ? transfer.date : "",
        remaining,
      });
    }
  }

  const signoffMatched = new Set();
  for (const signoff of signoffs) {
    const target = {
      warehouseNumber: signoff.warehouseNumber,
      warehouseName: signoff.warehouseName,
      materialNumber: signoff.materialNumber,
      lot: signoff.lot,
      subprojectNumber: signoff.subprojectNumber,
      sourceBillNumber: signoff.sourceBillNumber,
    };
    const remaining = allocate(stockLayers, target, signoff.quantity, "transferDate", (layer) => { signoffMatched.add(layer.id); });
    if (remaining > EPSILON && signoff.sourceBillNumber) {
      allocate(stockLayers, { ...target, warehouseNumber: "", warehouseName: "" }, remaining, "transferDate", (layer) => { signoffMatched.add(layer.id); });
    }
  }

  const companyCurrent = currentRows.filter((row) => row.warehouse.stage === "公司仓");
  const projectCurrent = currentRows.filter((row) => row.warehouse.stage === "项目仓");
  const customerCurrent = currentRows.filter((row) => row.warehouse.stage === "客户仓");
  const scope = stringValue(args.warehouseScope || "all");
  const rows = [
    ...(["all", "company"].includes(scope) ? buildCurrentRows(companyCurrent, stockLayers, asOfDate, "公司仓") : []),
    ...(["all", "project"].includes(scope) ? buildCurrentRows(projectCurrent, stockLayers, asOfDate, "项目仓") : []),
    ...(["all", "customer"].includes(scope) ? buildCurrentRows(customerCurrent, stockLayers, asOfDate, "客户仓") : []),
  ].filter((row) => {
    const threshold = Number(args.minimumDays || 0);
    return !threshold || (Number.isFinite(Number(row["总库存周期"])) && Number(row["总库存周期"]) >= threshold);
  }).sort((left, right) => (Number(right["总库存周期"]) || -1) - (Number(left["总库存周期"]) || -1) || (Number(right["当前库存数量"]) || 0) - (Number(left["当前库存数量"]) || 0));

  const projectResultRows = rows.filter((row) => row["库存阶段"] === "项目仓");
  const customerResultRows = rows.filter((row) => row["库存阶段"] === "客户仓");
  const sum = (items) => roundQuantity(items.reduce((total, row) => total + (Number(row["当前库存数量"]) || 0), 0));
  const oldestDays = rows.reduce((max, row) => Math.max(max, Number(row["总库存周期"]) || 0), 0);
  const unmatchedCount = rows.filter((row) => /未匹配/.test(row["状态"])).length;
  const statistics = {
    type: "inventory_cycle",
    asOfDate,
    currentRowCount: currentRows.length,
    rowCount: rows.length,
    totalQuantity: sum(rows),
    companyQuantity: sum(rows.filter((row) => row["库存阶段"] === "公司仓")),
    projectQuantity: sum(projectResultRows),
    customerQuantity: sum(customerResultRows),
    companyRowCount: rows.filter((row) => row["库存阶段"] === "公司仓").length,
    projectRowCount: projectResultRows.length,
    customerRowCount: customerResultRows.length,
    oldestDays,
    unmatchedCount,
    signoffSourceCount: signoffs.length,
    signoffMatchedCount: signoffMatched.size,
  };
  const quantityText = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(statistics.totalQuantity);
  const summary = rows.length
    ? `截至 ${asOfDate}，公司仓、项目仓与客户仓共有 ${quantityText} 个基本单位库存，公司仓 ${statistics.companyRowCount} 条，项目仓 ${projectResultRows.length} 条，客户仓待签收 ${customerResultRows.length} 条${unmatchedCount ? `，另有 ${unmatchedCount} 条单据链路未完全匹配` : ""}。`
    : `截至 ${asOfDate}，没有找到符合条件的公司仓、项目仓或客户仓库存。`;
  return {
    tool: "inventory_cycle",
    label: "库存周期",
    query: { ...args, asOfDate },
    columns: INVENTORY_CYCLE_COLUMNS,
    rows: rows.slice(0, limit),
    count: rows.length,
    truncated: rows.length > limit,
    statistics,
    summary,
  };
}

module.exports = { INVENTORY_CYCLE_COLUMNS, buildInventoryCycleResult, daysBetween, warehouseStage };
