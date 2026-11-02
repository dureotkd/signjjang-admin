import { test as base, expect, type Page, type TestInfo } from '@playwright/test';

// Every API request is fulfilled in the browser. These tests never connect to MySQL,
// send a message, or read/write production records.
type Row = Record<string, unknown>;
type RequestRecord = { method: string; path: string; query: URLSearchParams; body: Row | null };
type MockApi = {
  expired: boolean;
  records: Record<string, Row[]>;
  requests: RequestRecord[];
  series: { date: string; users: number; contracts: number; amount: number }[];
  unexpected: string[];
};
const admin = { username: 'admin', name: '테스트 관리자' };
const password = 'SyntheticBrowserPassword2026!';
const token = 'qa-isolated-admin-token';
const createdAt = '2026-10-28T00:30:00.000Z';
const owner = { userId: '1', fullName: '테스트회원01', companyName: 'QA 장비', userPhone: '01000000001', createdAt };
const labels = [
  ['users', '회원 관리'], ['contracts', '계약서 관리'], ['schedules', '일정 관리'],
  ['equipments', '장비 관리'], ['documents', '서류 관리'], ['alliances', '연락처 관리'],
  ['inquiries', '1:1 문의'], ['notices', '공지사항'], ['deliveries', '문자 발송 이력'],
  ['plans', '요금제 관리'], ['terms', '약관 관리'],
] as const;

function fixtureRecords(): Record<string, Row[]> {
  return {
    users: Array.from({ length: 21 }, (_, index) => ({ id: String(index + 1), fullName: `테스트회원${String(index + 1).padStart(2, '0')}`, companyName: 'QA 장비', phone: `010${String(index + 1).padStart(8, '0')}`, email: `qa${index + 1}@example.test`, status: (index + 1) % 3 ? 'active' : 'inactive', createdAt, lastLoginAt: createdAt })),
    contracts: [{ ...owner, id: '101', type: '건설기계사용확인서', status: 'completed', progress: 'ended', siteName: 'QA 테스트 현장', siteAddress: '테스트 현장 주소', startDate: '2026-10-28', fee: 450000, orderer: 'QA 발주처', orderPhone: '', workContent: '격리된 브라우저 검증', memo: '' }],
    schedules: [{ ...owner, id: '201', contractId: '101', date: '2026-10-28', status: 'ended', settlement: '미수금', siteName: 'QA 테스트 현장', equipment: '지게차', fee: 450000 }],
    equipments: [{ ...owner, id: '301', category: '지게차', tonnage: '5톤', vehicleNo: '테스트차량' }],
    documents: [{ ...owner, id: '401', label: 'QA 사업자등록증', documentType: 'business_registration', originalName: 'qa-document.pdf', mimeType: 'application/pdf', expiresOn: '2027-10-28' }],
    alliances: [{ ...owner, id: '501', tradeName: 'QA 협력업체', contactName: '테스트담당자', phone: '01000000999' }],
    inquiries: [{ ...owner, id: '601', title: '장비 서류 문의', content: '격리된 테스트 문의 내용입니다.', answer: '', answered: false, answeredAt: null }, { ...owner, id: '602', title: '기존 답변 문의', content: '이미 처리한 QA 문의', answer: '처리 완료', answered: true, answeredAt: createdAt }],
    notices: [{ id: '701', slug: 'qa-notice', title: 'QA 운영 공지', body: '격리된 테스트 공지입니다.', publishedAt: createdAt, updatedAt: createdAt, createdAt }],
    deliveries: [{ ...owner, id: '801', contractId: '101', recipientType: 'orderer', recipientPhone: '01000000999', status: 'sent', providerMessageId: 'qa-provider-id' }],
    plans: [{ id: 'basic-monthly', name: 'BASIC', price: 99000, currency: 'KRW', billingPeriod: 'monthly', features: ['계약서 관리', '일정 관리'], active: true, updatedAt: createdAt }],
    terms: [{ id: 'service', slug: 'service', title: '서비스 이용약관', body: '격리된 QA 약관', version: '1.0', effectiveOn: '2026-10-28', updatedAt: createdAt }],
  };
}

const allowedStatuses: Record<string, string[]> = {
  users: ['active', 'inactive', 'withdrawn'], contracts: ['draft', 'saved', 'completed'],
  schedules: ['scheduled', 'inProgress', 'ended', 'unpaid', 'settled'],
  inquiries: ['pending', 'answered'], deliveries: ['queued', 'sent', 'failed'], plans: ['active', 'inactive'],
};

const test = base.extend<{ mockApi: MockApi }>({
  mockApi: [async ({ page }, use) => {
    const mock: MockApi = { expired: false, records: fixtureRecords(), requests: [], series: [], unexpected: [] };
    const failedFonts: string[] = [];
    page.on('response', response => {
      if (/\.(?:woff2?|ttf|otf)(?:\?|$)/i.test(response.url()) && (response.status() >= 400 || response.headers()['content-type']?.includes('text/html'))) failedFonts.push(`${response.status()} ${response.url()}`);
    });
    await page.route('**/*', route => {
      if (['fetch', 'xhr'].includes(route.request().resourceType())) {
        mock.unexpected.push(`${route.request().method()} ${route.request().url()}`);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.replace(/^\/api\/admin/, '');
      const method = request.method();
      const body = request.postData() ? request.postDataJSON() as Row : null;
      mock.requests.push({ method, path, query: url.searchParams, body });
      const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      const error = (message: string, status: number) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message } }) });
      if (!url.pathname.startsWith('/api/admin/')) { mock.unexpected.push(`${method} ${url.pathname}`); return error('격리된 테스트에서 허용하지 않은 API', 404); }
      if (path === '/auth/login' && method === 'POST') {
        if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'password')) return error('비밀번호만 입력해 주세요.', 400);
        if (body.password !== password) return error('비밀번호를 확인해 주세요.', 401);
        return send({ accessToken: token, admin });
      }
      if (mock.expired || request.headers().authorization !== `Bearer ${token}`) return error('관리자 로그인이 필요합니다.', 401);
      if (path === '/auth/session') return send({ admin });
      if (path === '/dashboard') {
        const from = url.searchParams.get('from') || '2026-10-03';
        const to = url.searchParams.get('to') || '2026-11-01';
        mock.series = [];
        for (let time = Date.parse(`${from}T00:00:00Z`), index = 0; time <= Date.parse(`${to}T00:00:00Z`); time += 86400000, index++) {
          mock.series.push({ date: new Date(time).toISOString().slice(0, 10), users: index % 4, contracts: (index % 3) + 2, amount: ((index % 3) + 2) * 450000 });
        }
        return send({ from, to, today: to, metrics: { users: 21, activeUsers: 14, newUsers: 7, contracts: 1, contractAmount: 450000, schedules: 1, pendingInquiries: mock.records.inquiries.filter(row => !row.answeredAt).length, unpaidAmount: 450000 }, series: mock.series, contractStatuses: [{ status: 'ended', count: 1 }], equipmentCategories: [{ category: '지게차', count: 1 }], recentContracts: mock.records.contracts, recentInquiries: mock.records.inquiries.filter(row => !row.answeredAt) });
      }
      const [, resource, id] = path.split('/');
      const records = mock.records[resource];
      if (!records) { mock.unexpected.push(`${method} ${path}`); return error('관리 항목을 찾을 수 없습니다.', 404); }
      if (method === 'GET' && !id) {
        const pageNumber = Number(url.searchParams.get('page') || 1);
        const limit = Number(url.searchParams.get('limit') || 20);
        const query = url.searchParams.get('q')?.toLowerCase() || '';
        const status = url.searchParams.get('status');
        const progress = url.searchParams.get('progress');
        if (status && !allowedStatuses[resource]?.includes(status)) return error('상태 필터를 확인해 주세요.', 400);
        if (progress && (resource !== 'contracts' || !allowedStatuses.schedules.includes(progress))) return error('작업 상태 필터를 확인해 주세요.', 400);
        const items = records.filter(row => !query || Object.values(row).join(' ').toLowerCase().includes(query)).filter(row => {
          if (!status) return true;
          if (resource === 'inquiries') return (row.answeredAt ? 'answered' : 'pending') === status;
          if (resource === 'plans') return (row.active ? 'active' : 'inactive') === status;
          return row.status === status;
        }).filter(row => !progress || row.progress === progress);
        return send({ items: items.slice((pageNumber - 1) * limit, pageNumber * limit), total: items.length, page: pageNumber, limit });
      }
      const row = records.find(item => String(item.id || item.slug) === id);
      if (method === 'GET' && row) return send(row);
      if (method === 'PATCH' && row) {
        Object.assign(row, body);
        if (resource === 'inquiries') Object.assign(row, { answeredAt: body?.answer ? createdAt : null, answered: Boolean(body?.answer) });
        return send(row);
      }
      if (method === 'POST' && resource === 'notices' && body) {
        const newRow = { ...body, id: '702', createdAt, updatedAt: createdAt };
        records.unshift(newRow);
        return send(newRow, 201);
      }
      mock.unexpected.push(`${method} ${path}`);
      return error('항목을 찾을 수 없습니다.', 404);
    });
    await use(mock);
    expect(mock.unexpected, '모든 API는 격리된 fixture로 처리되어야 합니다').toEqual([]);
    expect(failedFonts, '관리자 폰트 자산은 정상적으로 로드되어야 합니다').toEqual([]);
  }, { auto: true }],
});

async function login(page: Page) {
  await page.goto('./');
  await expect(page.getByRole('textbox', { name: '아이디', exact: true })).toHaveCount(0);
  await page.getByLabel('비밀번호', { exact: true }).fill(password);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('heading', { name: '대시보드', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '일별 계약 건수 차트' })).toBeVisible();
}

async function navigate(page: Page, label: string) {
  await page.getByRole('navigation', { name: '관리 메뉴' }).getByRole('button', { name: label, exact: label !== '1:1 문의' }).click();
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
  await info.attach(name, { path: info.outputPath(`${name}.png`), contentType: 'image/png' });
}

test('login protects administration screens and reports invalid credentials', async ({ page, mockApi }, info) => {
  await page.goto('./#users');
  await expect(page.getByRole('heading', { name: '관리자 로그인' })).toBeVisible();
  expect(mockApi.requests.filter(request => request.method === 'GET')).toHaveLength(0);
  await expect(page.getByRole('textbox', { name: '아이디', exact: true })).toHaveCount(0);
  await capture(page, info, 'login-desktop');
  await page.getByLabel('비밀번호', { exact: true }).fill('incorrect-test-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('비밀번호를 확인해 주세요.');
  expect(mockApi.requests.find(request => request.method === 'POST' && request.path === '/auth/login')?.body).toEqual({ password: 'incorrect-test-password' });
  await expect(page.getByRole('navigation', { name: '관리 메뉴' })).toHaveCount(0);
});

test('dashboard displays actual response totals and switches chart metrics', async ({ page, mockApi }, info) => {
  await login(page);
  await expect(page.getByTitle('전체 회원 21명', { exact: true })).toBeVisible();
  await expect(page.getByTitle('계약 금액 450,000원', { exact: true })).toBeVisible();
  await expect(page.locator('.dash-chart-total')).toHaveText(`${mockApi.series.reduce((sum, item) => sum + item.contracts, 0).toLocaleString('ko-KR')}건`);
  await page.locator('.dash-segments').getByRole('button', { name: '신규 회원', exact: true }).click();
  await expect(page.getByRole('img', { name: '일별 신규 회원 수 차트' })).toBeVisible();
  await expect(page.locator('.dash-chart-total')).toHaveText(`${mockApi.series.reduce((sum, item) => sum + item.users, 0).toLocaleString('ko-KR')}명`);
  await page.locator('.dash-segments').getByRole('button', { name: '계약 금액', exact: true }).click();
  await expect(page.getByRole('img', { name: '일별 계약 금액 차트' })).toBeVisible();
  await expect(page.locator('.dash-chart-total')).toHaveText(`${mockApi.series.reduce((sum, item) => sum + item.amount, 0).toLocaleString('ko-KR')}원`);
  await capture(page, info, 'dashboard-desktop');
  await page.getByRole('button', { name: '최근 7일', exact: true }).click();
  await expect.poll(() => mockApi.series.length).toBe(7);
  await page.getByRole('row', { name: 'QA 테스트 현장 상세 보기' }).click();
  await expect(page.getByRole('dialog', { name: '계약서 관리', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).first().click();
  await navigate(page, '대시보드');
  await page.locator('.dash-legend').getByRole('button', { name: /작업 완료/ }).click();
  await expect(page.getByLabel('작업 상태 필터', { exact: true })).toHaveValue('ended');
  await expect(page.getByRole('button', { name: '테스트회원01 상세 보기' })).toBeVisible();
  await expect.poll(() => mockApi.requests.some(request => request.path === '/contracts' && request.query.get('progress') === 'ended')).toBe(true);
});

test('notification opens pending inquiries and a saved answer updates the list', async ({ page, mockApi }) => {
  await login(page);
  await page.getByRole('button', { name: '미답변 문의 1건', exact: true }).click();
  await expect(page.getByRole('heading', { name: '1:1 문의', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '장비 서류 문의 상세 보기' })).toBeVisible();
  await expect.poll(() => mockApi.requests.some(request => request.path === '/inquiries' && request.query.get('status') === 'pending')).toBe(true);
  await expect(page.getByText('기존 답변 문의', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '장비 서류 문의 상세 보기' }).click();
  const dialog = page.getByRole('dialog', { name: '1:1 문의', exact: true });
  await expect(dialog.getByText('격리된 테스트 문의 내용입니다.')).toBeVisible();
  await dialog.getByLabel('답변', { exact: false }).fill('서류 등록을 확인했습니다.');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('저장했습니다.', { exact: true })).toBeVisible();
  expect(mockApi.requests.find(request => request.method === 'PATCH' && request.path === '/inquiries/601')?.body).toEqual({ answer: '서류 등록을 확인했습니다.' });
  await expect(page.getByText('검색 결과가 없습니다', { exact: true })).toBeVisible();
});

test('member lists paginate, filter and search without retaining an old page', async ({ page, mockApi }) => {
  await login(page);
  await navigate(page, '회원 관리');
  await expect(page.getByRole('button', { name: '테스트회원01 상세 보기', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await expect(page.getByRole('button', { name: '테스트회원16 상세 보기', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '테스트회원01 상세 보기', exact: true })).toHaveCount(0);
  await page.locator('.resource-tabs').getByRole('button', { name: '활성', exact: true }).click();
  await page.getByRole('textbox', { name: '목록 검색' }).fill('테스트회원20');
  await expect(page.getByRole('button', { name: '테스트회원20 상세 보기', exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect.poll(() => mockApi.requests.some(request => request.path === '/users' && request.query.get('q') === '테스트회원20' && request.query.get('status') === 'active' && request.query.get('page') === '1')).toBe(true);
  await page.getByRole('textbox', { name: '목록 검색' }).fill('존재하지않는테스트회원');
  await expect(page.getByText('검색 결과가 없습니다', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '필터 초기화', exact: true }).click();
  await expect(page.getByRole('button', { name: '테스트회원01 상세 보기', exact: true })).toBeVisible();
});

test('notice creation submits editable content and shows the new record', async ({ page, mockApi }) => {
  await login(page);
  await navigate(page, '공지사항');
  await page.getByRole('button', { name: '공지 등록', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '공지사항 등록', exact: true });
  await dialog.getByLabel('제목', { exact: false }).fill('브라우저 QA 새 공지');
  await dialog.getByLabel('고유 주소', { exact: false }).fill('browser-qa-notice');
  await dialog.getByLabel('내용', { exact: false }).fill('격리된 브라우저 검증으로 등록한 내용입니다.');
  await dialog.getByLabel('게시 시각', { exact: false }).fill('2026-11-01T10:30');
  await dialog.getByRole('button', { name: '등록', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '브라우저 QA 새 공지 상세 보기' })).toBeVisible();
  const submitted = mockApi.requests.find(request => request.method === 'POST' && request.path === '/notices')?.body;
  expect(submitted).toMatchObject({ title: '브라우저 QA 새 공지', slug: 'browser-qa-notice', body: '격리된 브라우저 검증으로 등록한 내용입니다.', publishedAt: '2026-11-01T01:30:00.000Z' });
});

test('expired authentication removes protected content and stored session', async ({ page, mockApi }) => {
  await login(page);
  mockApi.expired = true;
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('heading', { name: '관리자 로그인' })).toBeVisible();
  await expect(page.getByText('로그인이 만료되었습니다. 다시 로그인해 주세요.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '관리 메뉴' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('signjjang.admin.session'))).toBeNull();
  await page.reload();
  await expect(page.getByRole('heading', { name: '관리자 로그인' })).toBeVisible();
});

test('mobile navigation works and tables do not make the page overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await capture(page, info, 'dashboard-mobile');
  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  await navigate(page, '서류 관리');
  await expect(page.getByText('QA 사업자등록증', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await page.locator('.row-open').first().click();
  await expect(page.getByRole('dialog', { name: '서류 관리', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test('every management resource opens its authenticated list and detail', async ({ page, mockApi }) => {
  test.setTimeout(60_000);
  await login(page);
  for (const [resource, label] of labels) {
    await test.step(label, async () => {
      await navigate(page, label);
      await expect(page.locator('.row-open').first()).toBeVisible();
      await page.locator('.row-open').first().click();
      const dialog = page.getByRole('dialog', { name: label, exact: true });
      await expect(dialog).toBeVisible();
      expect(mockApi.requests.some(request => request.method === 'GET' && request.path === `/${resource}`)).toBe(true);
      expect(mockApi.requests.some(request => request.method === 'GET' && request.path.startsWith(`/${resource}/`))).toBe(true);
      await dialog.getByRole('button', { name: '닫기', exact: true }).first().click();
      await expect(dialog).toHaveCount(0);
    });
  }
});
