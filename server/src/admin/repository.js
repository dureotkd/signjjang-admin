const { AppError } = require('../errors');
const { AppRepository } = require('../repositories/app.repository');
const { koreanToday } = require('../workflow');
const { listPlans } = require('./plans');

const owner = 'u.full_name, u.company_name, u.phone AS user_phone';
const resources = Object.freeze({
  users: { table: 'users', alias: 't', select: 't.id,t.phone,t.full_name,t.company_name,t.email,t.status,t.business_registration_no,t.referral_code,t.created_at,t.last_login_at,t.deleted_at', search: ['t.full_name', 't.company_name', 't.phone', 't.email'], status: 't.status' },
  contracts: { table: 'contracts', select: `t.id,t.user_id,t.type,t.status,t.progress,t.start_date,t.fee,t.payload,t.created_at,t.updated_at,${owner}`, search: ['u.full_name', 'u.company_name', "JSON_UNQUOTE(JSON_EXTRACT(t.payload,'$.siteName'))", "JSON_UNQUOTE(JSON_EXTRACT(t.payload,'$.orderer'))"], status: 't.status' },
  schedules: { table: 'schedules', select: `t.id,t.user_id,t.contract_id,t.work_date,t.status,t.settlement,t.fee,t.payload,t.created_at,${owner}`, search: ['u.full_name', 'u.company_name', "JSON_UNQUOTE(JSON_EXTRACT(t.payload,'$.siteName'))"], status: 't.status', date: 't.work_date' },
  equipments: { table: 'user_equipments', select: `t.id,t.user_id,t.category,t.specification,t.vehicle_no,t.created_at,${owner}`, search: ['u.full_name', 'u.company_name', 't.category', 't.vehicle_no'] },
  documents: { table: 'user_documents', select: `t.id,t.user_id,t.document_type,t.label,t.original_name,t.mime_type,t.expires_on,t.created_at,${owner}`, search: ['u.full_name', 'u.company_name', 't.label', 't.document_type'] },
  inquiries: { table: 'inquiries', select: `t.id,t.user_id,t.title,t.content,t.answer,t.answered_at,t.created_at,${owner}`, search: ['u.full_name', 'u.company_name', 't.title', 't.content'] },
  notices: { table: 'notices', select: 't.id,t.slug,t.title,t.body,t.published_at,t.created_at,t.updated_at', search: ['t.title', 't.body'] },
  terms: { table: 'terms_content', key: 'slug', select: 't.slug,t.title,t.body,t.version,t.effective_on,t.updated_at', search: ['t.title', 't.body'], date: 't.updated_at' },
  deliveries: { table: 'contract_deliveries', select: `t.id,t.contract_id,t.user_id,t.recipient_type,t.recipient_phone,t.status,t.provider_message_id,t.created_at,${owner}`, search: ['u.full_name', 'u.company_name', 't.recipient_phone'], status: 't.status' },
  alliances: { table: 'alliances', select: `t.id,t.user_id,t.trade_name,t.contact_name,t.phone,t.created_at,${owner}`, search: ['u.full_name', 'u.company_name', 't.trade_name', 't.contact_name', 't.phone'] },
});

function descriptor(resource) {
  const definition = Object.hasOwn(resources, resource) ? resources[resource] : null;
  if (!definition) throw new AppError(404, 'ADMIN_RESOURCE_NOT_FOUND', '관리 항목을 찾을 수 없습니다.');
  return definition;
}

function decodeJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function toItem(row) {
  const item = { ...decodeJson(row.payload) };
  for (const [key, value] of Object.entries(row)) {
    if (key === 'payload') continue;
    const camel = key.replace(/_([a-z])/g, (_all, letter) => letter.toUpperCase());
    item[camel] = value instanceof Date ? value.toISOString() : value;
  }
  for (const key of ['id', 'userId', 'contractId']) if (item[key] != null) item[key] = String(item[key]);
  if (item.slug && !item.id) item.id = item.slug;
  if (item.fee != null) item.fee = Number(item.fee);
  if (item.fullName) item.userName = item.fullName;
  if (item.workDate) item.date = String(item.workDate).slice(0, 10);
  if (item.startDate) item.startDate = String(item.startDate).slice(0, 10);
  if (item.expiresOn) item.expiresOn = String(item.expiresOn).slice(0, 10);
  if (item.effectiveOn) item.effectiveOn = String(item.effectiveOn).slice(0, 10);
  if ('specification' in item) item.tonnage = item.specification ?? '';
  if ('answeredAt' in item) item.answered = Boolean(item.answeredAt);
  return item;
}

const join = (definition) => definition.select.includes('u.full_name') ? ' JOIN users u ON u.id = t.user_id' : '';
const escapedSearch = (value) => `%${value.replace(/[!%_]/g, (character) => `!${character}`)}%`;

function filters(definition, query) {
  const clauses = [];
  const parameters = [];
  if (query.q) {
    clauses.push(`(${definition.search.map((column) => `${column} LIKE ? ESCAPE '!'`).join(' OR ')})`);
    parameters.push(...definition.search.map(() => escapedSearch(query.q)));
  }
  if (query.status) {
    if (definition.status) { clauses.push(`${definition.status} = ?`); parameters.push(query.status); }
    else if (definition.table === 'inquiries') clauses.push(`t.answered_at IS ${query.status === 'answered' ? 'NOT ' : ''}NULL`);
  }
  if (query.progress && definition.table === 'contracts') { clauses.push('t.progress = ?'); parameters.push(query.progress); }
  const date = definition.date || 't.created_at';
  if (query.from) { clauses.push(`${date} >= ?`); parameters.push(query.from); }
  if (query.to) { clauses.push(`${date} < DATE_ADD(?, INTERVAL 1 DAY)`); parameters.push(query.to); }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', parameters };
}

const notFound = () => new AppError(404, 'ADMIN_RECORD_NOT_FOUND', '항목을 찾을 수 없습니다.');

class AdminRepository {
  constructor(pool, appService) {
    this.pool = pool;
    this.appRepository = new AppRepository(pool);
    this.appService = appService;
  }

  async list(resource, query) {
    if (!Number.isSafeInteger(query.page) || query.page < 1 || query.page > 100000 || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new AppError(400, 'INVALID_PAGINATION', '페이지 범위를 확인해 주세요.');
    }
    if (resource === 'plans') {
      let items = await listPlans(this.pool, { includeInactive: true });
      if (query.q) items = items.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query.q.toLowerCase()));
      if (query.status) items = items.filter((item) => item.active === (query.status === 'active'));
      return { items: items.slice((query.page - 1) * query.limit, query.page * query.limit), total: items.length, page: query.page, limit: query.limit };
    }
    const definition = descriptor(resource);
    const where = filters(definition, query);
    const source = `FROM ${definition.table} t${join(definition)}${where.sql}`;
    const [[counts], [rows]] = await Promise.all([
      this.pool.execute(`SELECT COUNT(*) AS total ${source}`, where.parameters),
      this.pool.execute(`SELECT ${definition.select} ${source} ORDER BY t.${definition.key || 'id'} DESC LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`, where.parameters),
    ]);
    return { items: rows.map(toItem), total: Number(counts[0]?.total ?? 0), page: query.page, limit: query.limit };
  }

  async get(resource, id) {
    if (resource === 'plans') {
      const plan = (await listPlans(this.pool, { includeInactive: true })).find((item) => item.id === id);
      if (!plan) throw notFound();
      return plan;
    }
    const definition = descriptor(resource);
    const [rows] = await this.pool.execute(`SELECT ${definition.select} FROM ${definition.table} t${join(definition)} WHERE t.${definition.key || 'id'} = ? LIMIT 1`, [id]);
    if (!rows[0]) throw notFound();
    return toItem(rows[0]);
  }

  async patch(resource, id, patch) {
    const existing = await this.get(resource, id);
    if (resource === 'contracts') {
      const contract = await this.appRepository.getContract(existing.userId, id);
      const incoming = { ...contract, ...patch };
      // Coordinates were not edited in this form. Let AppService retain them
      // only when the address still matches, rather than treating old values
      // copied from the record as explicitly supplied coordinates.
      delete incoming.siteLatitude;
      delete incoming.siteLongitude;
      const updated = await this.appService.updateContract(existing.userId, id, incoming);
      if (!updated) throw notFound();
      return this.get(resource, id);
    }
    if (resource === 'schedules') {
      const schedule = await this.appRepository.getSchedule(existing.userId, id);
      const updated = await this.appRepository.updateSchedule(existing.userId, id, { ...schedule, ...patch }, { statusOnly: true });
      if (!updated) throw notFound();
      return this.get(resource, id);
    }
    if (resource === 'users' && (existing.deletedAt || existing.status === 'withdrawn')) throw new AppError(409, 'ACCOUNT_WITHDRAWN', '탈퇴한 회원은 변경할 수 없습니다.');
    const columns = {
      users: { fullName: 'full_name', companyName: 'company_name', phone: 'phone', email: 'email', status: 'status' },
      equipments: { category: 'category', tonnage: 'specification', vehicleNo: 'vehicle_no' },
      documents: { label: 'label', documentType: 'document_type', expiresOn: 'expires_on' },
      inquiries: { answer: 'answer' },
      notices: { slug: 'slug', title: 'title', body: 'body', publishedAt: 'published_at' },
      terms: { title: 'title', body: 'body', version: 'version', effectiveOn: 'effective_on' },
      plans: { name: 'name', price: 'price', currency: 'currency', billingPeriod: 'billing_period', features: 'features', active: 'active' },
      alliances: { tradeName: 'trade_name', contactName: 'contact_name', phone: 'phone' },
    };
    const allowed = columns[resource];
    if (!allowed) throw new AppError(405, 'ADMIN_READ_ONLY', '조회 전용 항목입니다.');
    const entries = Object.entries(patch).filter(([key]) => Object.hasOwn(allowed, key));
    const assignments = entries.map(([key]) => `${allowed[key]} = ?`);
    const parameters = entries.map(([key, value]) => {
      if (key === 'features') return JSON.stringify(value);
      if (key === 'active') return value ? 1 : 0;
      if (key === 'publishedAt') return new Date(value);
      if (key === 'email' || key === 'expiresOn') return value || null;
      return value;
    });
    if (resource === 'inquiries') assignments.push("answered_at = CASE WHEN TRIM(?) = '' THEN NULL ELSE NOW(3) END"), parameters.push(patch.answer);
    const table = resource === 'plans' ? 'membership_plans' : descriptor(resource).table;
    const key = resource === 'plans' ? 'id' : descriptor(resource).key || 'id';
    await this.pool.execute(`UPDATE ${table} SET ${assignments.join(', ')}, updated_at = NOW(3) WHERE ${key} = ?`, [...parameters, id]);
    return this.get(resource, id);
  }

  async createNotice(notice) {
    const [result] = await this.pool.execute('INSERT INTO notices (slug,title,body,published_at) VALUES (?,?,?,?)', [notice.slug, notice.title, notice.body, new Date(notice.publishedAt)]);
    return this.get('notices', String(result.insertId));
  }

  async remove(resource, id) {
    const existing = await this.get(resource, id);
    if (resource === 'contracts') {
      if (!await this.appRepository.deleteContract(existing.userId, id)) throw notFound();
    } else if (resource === 'schedules') {
      if (!await this.appRepository.deleteSchedule(existing.userId, id)) throw notFound();
    } else if (resource === 'documents') {
      const [users] = await this.pool.execute('SELECT profile_image_url FROM users WHERE id = ?', [existing.userId]);
      if (users[0]?.profile_image_url === `/api/documents/${id}/file`) throw new AppError(409, 'PROFILE_IMAGE_IN_USE', '프로필 이미지로 사용 중인 파일입니다.');
      // Retain the physical file; it may be referenced by another record or retained for an audit.
      await this.pool.execute('DELETE FROM user_documents WHERE id = ?', [id]);
    } else {
      if (!['notices', 'equipments', 'alliances'].includes(resource)) throw new AppError(405, 'ADMIN_DELETE_NOT_ALLOWED', '삭제할 수 없는 항목입니다.');
      await this.pool.execute(`DELETE FROM ${descriptor(resource).table} WHERE id = ?`, [id]);
    }
    return { id, deleted: true };
  }

  async documentFile(id) {
    const [rows] = await this.pool.execute('SELECT file_url,mime_type,original_name FROM user_documents WHERE id = ? LIMIT 1', [id]);
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  async dashboard({ from, to }) {
    const scalar = async (sql, parameters = []) => {
      const [rows] = await this.pool.execute(sql, parameters);
      return rows[0] || {};
    };
    const period = [from, to];
    const [users, contracts, schedules, pending, unpaid, userSeries, contractSeries, statuses, categories, recentContracts, recentInquiries] = await Promise.all([
      scalar("SELECT COUNT(*) AS users, SUM(status = 'active' AND deleted_at IS NULL) AS activeUsers, SUM(created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)) AS newUsers FROM users", period),
      scalar('SELECT COUNT(*) AS contracts, COALESCE(SUM(fee),0) AS contractAmount FROM contracts WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)', period),
      scalar('SELECT COUNT(*) AS schedules FROM schedules WHERE work_date >= ? AND work_date <= ?', period),
      scalar('SELECT COUNT(*) AS pendingInquiries FROM inquiries WHERE answered_at IS NULL'),
      scalar("SELECT COALESCE(SUM(fee),0) AS unpaidAmount FROM schedules WHERE settlement = '미수금'"),
      this.pool.execute("SELECT DATE_FORMAT(created_at,'%Y-%m-%d') AS date,COUNT(*) AS users FROM users WHERE created_at >= ? AND created_at < DATE_ADD(?,INTERVAL 1 DAY) GROUP BY date ORDER BY date", period),
      this.pool.execute("SELECT DATE_FORMAT(created_at,'%Y-%m-%d') AS date,COUNT(*) AS contracts,COALESCE(SUM(fee),0) AS amount FROM contracts WHERE created_at >= ? AND created_at < DATE_ADD(?,INTERVAL 1 DAY) GROUP BY date ORDER BY date", period),
      this.pool.execute('SELECT progress AS status,COUNT(*) AS count FROM contracts WHERE created_at >= ? AND created_at < DATE_ADD(?,INTERVAL 1 DAY) GROUP BY progress', period),
      this.pool.execute('SELECT category,COUNT(*) AS count FROM user_equipments GROUP BY category ORDER BY count DESC'),
      this.list('contracts', { page: 1, limit: 5 }),
      this.list('inquiries', { page: 1, limit: 4, status: 'pending' }),
    ]);
    const series = new Map();
    for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += 86400000) {
      const date = new Date(time).toISOString().slice(0, 10);
      series.set(date, { date, users: 0, contracts: 0, amount: 0 });
    }
    for (const row of userSeries[0]) if (series.has(row.date)) series.get(row.date).users = Number(row.users);
    for (const row of contractSeries[0]) if (series.has(row.date)) Object.assign(series.get(row.date), { contracts: Number(row.contracts), amount: Number(row.amount) });
    const metrics = Object.fromEntries(Object.entries({ ...users, ...contracts, ...schedules, ...pending, ...unpaid }).map(([key, value]) => [key, Number(value || 0)]));
    return {
      from, to, today: koreanToday(), metrics, series: [...series.values()],
      contractStatuses: statuses[0].map((row) => ({ status: row.status, count: Number(row.count) })),
      equipmentCategories: categories[0].map((row) => ({ category: row.category, count: Number(row.count) })),
      recentContracts: recentContracts.items, recentInquiries: recentInquiries.items,
    };
  }
}

module.exports = { AdminRepository, resources, toItem };
