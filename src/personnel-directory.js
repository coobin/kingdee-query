const { normalizeIdentifier } = require("./access-control");

const PAGE_SIZE = 500;
const MAX_ROWS = 10000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function id(value) {
  return Number(value) > 0 ? String(value) : "";
}

function label(value) {
  return String(value || "").normalize("NFKC").trim();
}

async function fetchAll(kingdee, username, { formId, fields, orderField, filter }) {
  const rows = [];
  for (let start = 0; start <= MAX_ROWS; start += PAGE_SIZE) {
    const page = await kingdee.executeBillQuery(username, {
      FormId: formId,
      FieldKeys: fields.join(","),
      FilterString: filter,
      OrderString: `${orderField} ASC`,
      TopRowCount: 0,
      StartRow: start,
      Limit: PAGE_SIZE,
    });
    if (start === MAX_ROWS && page.length) {
      throw Object.assign(new Error("人员目录超过读取上限，请缩小范围后再配置。"), { statusCode: 503 });
    }
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
  return rows;
}

function buildPersonnelDirectory(userRows, departmentRows, employeeRows) {
  const departments = departmentRows.map((row) => ({
    id: id(row[0]),
    number: label(row[1]),
    name: label(row[2]),
    fullName: label(row[3]),
    parentId: id(row[4]),
    organizationId: id(row[5]),
    organizationName: label(row[6]),
  })).filter((department) => department.id && department.name);
  const departmentById = new Map(departments.map((department) => [department.id, department]));
  for (const department of departments) {
    const parent = departmentById.get(department.parentId);
    if (!parent || parent.organizationId !== department.organizationId) department.parentId = "";
  }

  const organizations = [...new Map(departments.map((department) => [department.organizationId || "unknown", {
    id: department.organizationId || "unknown",
    name: department.organizationName || "未指定组织",
  }])).values()].sort((left, right) => collator.compare(left.name, right.name));
  departments.sort((left, right) => collator.compare(left.name, right.name));

  const employeesByNumber = new Map();
  const employeesByName = new Map();
  for (const row of employeeRows) {
    for (const number of new Set([normalizeIdentifier(row[1]), normalizeIdentifier(row[2])].filter(Boolean))) {
      if (!employeesByNumber.has(number)) employeesByNumber.set(number, []);
      employeesByNumber.get(number).push(row);
    }
    const name = normalizeIdentifier(row[3]);
    if (name) {
      if (!employeesByName.has(name)) employeesByName.set(name, []);
      employeesByName.get(name).push(row);
    }
  }

  const nameCounts = new Map();
  for (const row of userRows) {
    const name = normalizeIdentifier(row[2]);
    if (name) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }

  let ambiguousUsers = 0;
  const people = [];
  for (const row of userRows) {
    const personId = id(row[0]);
    const username = label(row[2]);
    const account = label(row[1]);
    if (!personId || !username) continue;
    if (nameCounts.get(normalizeIdentifier(username)) !== 1) {
      ambiguousUsers++;
      continue;
    }

    const byAccount = employeesByNumber.get(normalizeIdentifier(account)) || [];
    let matchingEmployees = [];
    if (byAccount.length) {
      if (byAccount.every((employee) => normalizeIdentifier(employee[3]) === normalizeIdentifier(username))) {
        matchingEmployees = byAccount;
      }
    } else {
      const byName = employeesByName.get(normalizeIdentifier(username)) || [];
      const employeeNumbers = new Set(byName.map((employee) => normalizeIdentifier(employee[1] || employee[2])).filter(Boolean));
      if (employeeNumbers.size === 1) matchingEmployees = byName;
    }
    const departmentIds = [...new Set(matchingEmployees.map((employee) => id(employee[4])).filter((departmentId) => departmentById.has(departmentId)))];
    people.push({ id: personId, username, account, departmentIds });
  }
  people.sort((left, right) => collator.compare(left.username, right.username) || collator.compare(left.account, right.account));

  return {
    organizations,
    departments,
    people,
    unassignedCount: people.filter((person) => !person.departmentIds.length).length,
    ambiguousUsers,
    updatedAt: new Date().toISOString(),
  };
}

class PersonnelDirectory {
  constructor(kingdee, { cacheTtlMs = CACHE_TTL_MS } = {}) {
    this.kingdee = kingdee;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
  }

  async get(username, { refresh = false } = {}) {
    const account = label(username);
    if (!account) throw Object.assign(new Error("请先为当前超级管理员填写金蝶账号，再选择模块人员。"), { statusCode: 400 });
    const key = normalizeIdentifier(account);
    const cached = this.cache.get(key);
    if (!refresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;
    if (cached?.promise) return cached.promise;
    const promise = this.load(account).then((value) => {
      this.cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
      return value;
    }).catch((error) => {
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, { promise });
    return promise;
  }

  async load(username) {
    await this.kingdee.login(username);
    const [users, departments, employees] = await Promise.all([
      fetchAll(this.kingdee, username, {
        formId: "SEC_User", fields: ["FUSERID", "FUSERACCOUNT", "FNAME"], orderField: "FUSERID", filter: "FForbidStatus='A'",
      }),
      fetchAll(this.kingdee, username, {
        formId: "BD_Department", fields: ["FDEPTID", "FNumber", "FName", "FFullName", "FParentID", "FUseOrgId", "FUseOrgId.FName"],
        orderField: "FDEPTID", filter: "FForbidStatus='A' AND FDocumentStatus='C'",
      }),
      fetchAll(this.kingdee, username, {
        formId: "BD_Empinfo", fields: ["FID", "FNumber", "FStaffNumber", "FName", "FPostDept"],
        orderField: "FID", filter: "FForbidStatus='A' AND FDocumentStatus='C'",
      }),
    ]);
    return buildPersonnelDirectory(users, departments, employees);
  }
}

module.exports = { PersonnelDirectory, buildPersonnelDirectory };
