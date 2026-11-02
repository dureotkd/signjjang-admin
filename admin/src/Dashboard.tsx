import { useEffect, useId, useRef, useState } from 'react';
import './dashboard.css';

export type DashboardData = {
  metrics: {
    users: number;
    activeUsers: number;
    newUsers: number;
    contracts: number;
    contractAmount: number;
    schedules: number;
    pendingInquiries: number;
    unpaidAmount: number;
  };
  series: { date: string; users: number; contracts: number; amount: number }[];
  contractStatuses: { status: string; count: number }[];
  equipmentCategories: { category: string; count: number }[];
  recentContracts: {
    id: string | number;
    type?: string;
    status?: string;
    progress?: string;
    siteName?: string;
    companyName?: string;
    fullName?: string;
    userName?: string;
    fee?: number;
    startDate?: string;
    createdAt?: string;
  }[];
  recentInquiries: {
    id: string | number;
    title: string;
    content?: string;
    companyName?: string;
    fullName?: string;
    userName?: string;
    createdAt?: string;
    answeredAt?: string | null;
    answered?: boolean;
  }[];
};

type DashboardProps = {
  data: DashboardData | null;
  loading: boolean;
  onNavigate: (resource: string, filter?: string) => void;
  from: string;
  to: string;
  onDateChange: (from: string, to: string) => void;
};

const number = (value: number | undefined) => value == null ? '—' : new Intl.NumberFormat('ko-KR').format(value);
const amountLabel = (value: number | undefined) => {
  if (value == null || value < 100000000) return number(value);
  const divisor = value >= 1000000000000 ? 1000000000000 : 100000000;
  return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(value / divisor)}${divisor === 1000000000000 ? '조' : '억'}`;
};
const dateLabel = (date?: string) => date ? date.slice(0, 10).replaceAll('-', '.') : '—';
const shortDate = (date: string) => `${Number(date.slice(5, 7))}.${Number(date.slice(8, 10))}`;
const statuses: Record<string, { label: string; color: string }> = {
  scheduled: { label: '작업 예정', color: '#a2c9bc' },
  inProgress: { label: '진행 중', color: '#25876b' },
  ended: { label: '작업 완료', color: '#5c7791' },
  unpaid: { label: '미수금', color: '#dea964' },
  settled: { label: '수금 완료', color: '#d9e3df' },
};

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
    contracts: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>,
    amount: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m7 10 2 5 3-5 3 5 2-5M6 12h12" /></>,
    inquiries: <><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" /><path d="M8 11h8M8 15h4" /></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></>,
    arrow: <><path d="M7 17 17 7M7 7h10v10" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    empty: <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 8h8M8 12h5M8 16h3" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.contracts}</svg>;
}

function Empty({ label }: { label: string }) {
  return <div className="dash-empty"><span><Icon name="empty" size={25} /></span><p>{label}</p></div>;
}

function StatCard({ label, value, exactValue, unit, detail, icon, onClick, loading, warm }: {
  label: string; value: string; exactValue?: string; unit?: string; detail: React.ReactNode; icon: string; onClick: () => void; loading: boolean; warm?: boolean;
}) {
  return <button className={`dash-stat${warm ? ' dash-stat-warm' : ''}`} onClick={onClick} title={`${label} ${exactValue ?? value}${unit ?? ''}`}>
    <div className="dash-stat-top"><span>{label}</span><span className="dash-stat-icon"><Icon name={icon} /></span></div>
    <div className={`dash-stat-value${loading ? ' dash-skeleton' : ''}`}>
      {loading ? '\u00a0' : <>{value}<span>{unit}</span></>}
    </div>
    <div className="dash-stat-bottom"><span>{loading ? '\u00a0' : detail}</span><Icon name="arrow" size={16} /></div>
  </button>;
}

type ChartMetric = 'contracts' | 'users' | 'amount';

function TrendChart({ series, loading }: { series: DashboardData['series']; loading: boolean }) {
  const [metric, setMetric] = useState<ChartMetric>('contracts');
  const [active, setActive] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [renderWidth, setRenderWidth] = useState(760);
  useEffect(() => {
    const node = chartRef.current;
    if (!node) return;
    const measure = () => {
      const style = getComputedStyle(node);
      setRenderWidth(Math.max(200, node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, series.length]);
  const gradientId = useId().replaceAll(':', '');
  const values = series.map((point) => Number(point[metric]) || 0);
  const rawMax = Math.max(...values, 0);
  const step = rawMax <= 4 ? 1 : 10 ** Math.floor(Math.log10(rawMax / 4));
  const max = Math.max(4, Math.ceil(rawMax / (step * 4)) * step * 4);
  const width = renderWidth, height = 240, left = 52, right = 16, top = 20, bottom = 35;
  const chartWidth = width - left - right, chartHeight = height - top - bottom;
  const x = (index: number) => left + (series.length > 1 ? index / (series.length - 1) : 0.5) * chartWidth;
  const y = (value: number) => top + chartHeight - value / max * chartHeight;
  const line = values.map((value, index) => `${index ? 'L' : 'M'} ${x(index)} ${y(value)}`).join(' ');
  const area = values.length ? `${line} L ${x(values.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z` : '';
  const ticks = [...new Set([0, Math.floor((series.length - 1) * .25), Math.floor((series.length - 1) * .5), Math.floor((series.length - 1) * .75), series.length - 1])].filter((index) => index >= 0);
  const axisLabel = (value: number) => metric === 'amount' && value >= 100000000 ? `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value / 100000000)}억` : metric === 'amount' && value >= 10000 ? `${number(Math.round(value / 10000))}만` : value >= 1000 ? `${number(Math.round(value / 1000))}천` : number(value);
  const activeIndex = active == null ? null : Math.min(active, series.length - 1);
  const selected = activeIndex == null ? null : series[activeIndex];
  const total = values.reduce((sum, value) => sum + value, 0);
  return <section className="dash-panel dash-trend">
    <div className="dash-panel-heading"><div><h2>서비스 이용 추이</h2><div className="dash-chart-total">{loading ? '—' : number(total)}<span>{metric === 'amount' ? '원' : metric === 'users' ? '명' : '건'}</span></div></div>
      <div className="dash-segments" aria-label="차트 지표">{([['contracts', '계약'], ['users', '신규 회원'], ['amount', '계약 금액']] as const).map(([key, label]) => <button key={key} className={metric === key ? 'dash-selected' : ''} aria-pressed={metric === key} onClick={() => { setMetric(key); setActive(null); }}>{label}</button>)}</div>
    </div>
    {loading ? <div className="dash-chart-skeleton dash-skeleton" /> : !series.length ? <Empty label="선택한 기간의 데이터가 없습니다" /> : <div className="dash-chart-wrap" ref={chartRef}>
      <svg className="dash-line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric === 'contracts' ? '일별 계약 건수' : metric === 'users' ? '일별 신규 회원 수' : '일별 계약 금액'} 차트`} onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const svgX = (event.clientX - bounds.left) / bounds.width * width;
        setActive(Math.max(0, Math.min(series.length - 1, Math.round((svgX - left) / chartWidth * (series.length - 1)))));
      }} onMouseLeave={() => setActive(null)}>
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#25876b" stopOpacity=".13" /><stop offset="100%" stopColor="#25876b" stopOpacity="0" /></linearGradient></defs>
        {[0, 1, 2, 3, 4].map((tick) => <g key={tick}><line x1={left} x2={width - right} y1={y(max * tick / 4)} y2={y(max * tick / 4)} stroke="#edf0ee" strokeDasharray={tick ? '4 5' : undefined} /><text x={left - 12} y={y(max * tick / 4) + 4} textAnchor="end" className="dash-axis">{axisLabel(max * tick / 4)}</text></g>)}
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke="#25876b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {series.length === 1 && <circle cx={x(0)} cy={y(values[0])} r="4" fill="#25876b" />}
        {ticks.map((index) => <text key={index} x={x(index)} y={height - 9} textAnchor="middle" className="dash-axis">{shortDate(series[index].date)}</text>)}
        {activeIndex != null && selected && <g><line x1={x(activeIndex)} x2={x(activeIndex)} y1={top} y2={y(0)} stroke="#a9bdb4" strokeDasharray="4 4" /><circle cx={x(activeIndex)} cy={y(values[activeIndex])} r="5" fill="#25876b" stroke="white" strokeWidth="2.5" /></g>}
      </svg>
      {selected && activeIndex != null && <div className="dash-chart-tooltip" style={{ left: `${Math.max(15, Math.min(85, x(activeIndex) / width * 100))}%` }}><span>{dateLabel(selected.date)}</span><strong>{number(selected[metric])}{metric === 'amount' ? '원' : metric === 'users' ? '명' : '건'}</strong></div>}
    </div>}
    <div className="dash-chart-foot"><span className="dash-dot" />{metric === 'contracts' ? '일별 계약 건수' : metric === 'users' ? '일별 신규 가입 회원' : '일별 계약 금액'}<span className="dash-chart-period">선택 기간 기준</span></div>
  </section>;
}

function Distribution({ data, loading, onNavigate }: { data: DashboardData | null; loading: boolean; onNavigate: DashboardProps['onNavigate'] }) {
  const [tab, setTab] = useState<'contracts' | 'equipments'>('contracts');
  const items = tab === 'contracts' ? (data?.contractStatuses ?? []).map((item) => ({ key: item.status, label: statuses[item.status]?.label ?? item.status, count: Number(item.count), color: statuses[item.status]?.color ?? '#9eaca7' })) : (data?.equipmentCategories ?? []).map((item, index) => ({ key: item.category, label: item.category, count: Number(item.count), color: ['#25876b', '#a2c9bc', '#5c7791', '#dea964', '#d9e3df'][index % 5] }));
  const total = items.reduce((sum, item) => sum + item.count, 0);
  let offset = 0;
  return <section className="dash-panel dash-distribution">
    <div className="dash-panel-heading"><h2>{tab === 'contracts' ? '계약 진행 현황' : '장비 현황'}</h2><button className="dash-icon-button" aria-label={tab === 'contracts' ? '계약 관리로 이동' : '장비 관리로 이동'} onClick={() => onNavigate(tab)}><Icon name="arrow" size={17} /></button></div>
    <div className="dash-distribution-tabs"><button className={tab === 'contracts' ? 'dash-tab-active' : ''} onClick={() => setTab('contracts')}>계약</button><button className={tab === 'equipments' ? 'dash-tab-active' : ''} onClick={() => setTab('equipments')}>장비</button></div>
    <div className="dash-donut-wrap"><svg viewBox="0 0 180 180" className="dash-donut" role="img" aria-label={`${tab === 'contracts' ? '계약 진행 상태별' : '장비 종류별'} 비중`}>
      <circle cx="90" cy="90" r="65" fill="none" stroke="#f0f3f1" strokeWidth="19" />
      {!loading && items.map((item) => {
        const fraction = total ? item.count / total : 0;
        const gap = fraction > .025 && items.filter((item) => item.count > 0).length > 1 ? .008 : 0;
        const segment = <circle key={item.key} cx="90" cy="90" r="65" fill="none" stroke={item.color} strokeWidth="19" pathLength="1" strokeDasharray={`${Math.max(0, fraction - gap)} 1`} strokeDashoffset={-offset} transform="rotate(-90 90 90)" />;
        offset += fraction;
        return item.count > 0 ? segment : null;
      })}
      <text x="90" y="87" textAnchor="middle" className="dash-donut-value">{loading || !data ? '—' : number(total)}</text><text x="90" y="110" textAnchor="middle" className="dash-donut-label">{tab === 'contracts' ? '전체 계약' : '등록 장비'}</text>
    </svg></div>
    <div className="dash-legend">{items.length ? items.map((item) => <button key={item.key} onClick={() => onNavigate(tab, tab === 'contracts' ? item.key : undefined)}><span className="dash-legend-label"><span className="dash-dot" style={{ background: item.color }} />{item.label}</span><strong>{number(item.count)}<span>{total ? Math.round(item.count / total * 100) : 0}%</span></strong></button>) : <p className="dash-no-distribution">{loading ? '불러오는 중' : '등록된 데이터가 없습니다'}</p>}</div>
  </section>;
}

function exportSeries(data: DashboardData, from: string, to: string) {
  const csvCell = (value: string | number) => {
    const text = String(value);
    const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const content = '\uFEFF날짜,신규 회원,계약 건수,계약 금액\r\n' + data.series.map((item) => [item.date, item.users, item.contracts, item.amount].map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8;' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `싸인짱_통계_${from}_${to}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Dashboard({ data, loading, onNavigate, from, to, onDateChange }: DashboardProps) {
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  useEffect(() => { setDraftFrom(from); setDraftTo(to); }, [from, to]);
  const dateRangeError = (start: string, end: string) => {
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!validDate(start) || !validDate(end)) return '시작일과 종료일을 선택해 주세요';
    const duration = Date.parse(end) - Date.parse(start);
    if (duration < 0) return '종료일은 시작일 이후로 선택해 주세요';
    if (duration > 365 * 86400000) return '최대 366일까지 조회할 수 있습니다';
    return '';
  };
  const dateError = dateRangeError(draftFrom, draftTo);
  const updateDate = (field: 'from' | 'to', value: string) => {
    const start = field === 'from' ? value : draftFrom;
    const end = field === 'to' ? value : draftTo;
    setDraftFrom(start); setDraftTo(end);
    if (!dateRangeError(start, end)) onDateChange(start, end);
  };
  const metrics = data?.metrics;
  const contracts = data?.recentContracts ?? [];
  const inquiries = data?.recentInquiries ?? [];
  const selectedDays = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 : 0;
  const choosePeriod = (days: number) => {
    const end = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const start = new Date(`${end}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - days + 1);
    const beginning = start.toISOString().slice(0, 10);
    setDraftFrom(beginning); setDraftTo(end);
    onDateChange(beginning, end);
  };
  return <div className="dash-root" aria-busy={loading}>
    <div className="dash-heading"><div><p className="dash-eyebrow">OVERVIEW</p><h1>대시보드<span className="dash-heading-dot" /></h1></div><button className="dash-export" disabled={!data || loading} onClick={() => data && exportSeries(data, from, to)}><Icon name="download" size={16} />통계 내보내기</button></div>
    <div className="dash-filter-row"><div className="dash-periods">{[7, 30, 90].map((days) => <button key={days} className={selectedDays === days && !dateError ? 'dash-period-active' : ''} aria-pressed={selectedDays === days && !dateError} onClick={() => choosePeriod(days)}>최근 {days}일</button>)}</div><div className="dash-date-group"><div className="dash-dates"><Icon name="calendar" size={16} /><input type="date" aria-label="통계 시작일" aria-invalid={Boolean(dateError)} aria-describedby={dateError ? 'dash-date-error' : undefined} value={draftFrom} max={draftTo || undefined} onChange={(event) => updateDate('from', event.target.value)} /><span>—</span><input type="date" aria-label="통계 종료일" aria-invalid={Boolean(dateError)} aria-describedby={dateError ? 'dash-date-error' : undefined} value={draftTo} min={draftFrom || undefined} onChange={(event) => updateDate('to', event.target.value)} /></div>{dateError && <p id="dash-date-error" className="dash-date-error" role="status">{dateError}</p>}</div></div>
    <div className="dash-stats">
      <StatCard label="전체 회원" value={number(metrics?.users)} unit="명" detail={<>신규 가입 <strong>{number(metrics?.newUsers)}명</strong></>} icon="users" onClick={() => onNavigate('users')} loading={loading && !data} />
      <StatCard label="계약 건수" value={number(metrics?.contracts)} unit="건" detail={<>등록 일정 <strong>{number(metrics?.schedules)}건</strong></>} icon="contracts" onClick={() => onNavigate('contracts')} loading={loading && !data} />
      <StatCard label="계약 금액" value={amountLabel(metrics?.contractAmount)} exactValue={number(metrics?.contractAmount)} unit="원" detail={<>미수금 <strong>{number(metrics?.unpaidAmount)}원</strong></>} icon="amount" onClick={() => onNavigate('contracts')} loading={loading && !data} />
      <StatCard label="미답변 문의" value={number(metrics?.pendingInquiries)} unit="건" detail={<>문의함 확인하기</>} icon="inquiries" onClick={() => onNavigate('inquiries', 'pending')} loading={loading && !data} warm />
    </div>
    <div className="dash-charts"><TrendChart series={data?.series ?? []} loading={loading && !data} /><Distribution data={data} loading={loading && !data} onNavigate={onNavigate} /></div>
    <div className="dash-bottom-grid">
      <section className="dash-panel dash-recent-contracts"><div className="dash-panel-heading"><h2>최근 계약</h2><button className="dash-view-all" onClick={() => onNavigate('contracts')}>전체 보기<Icon name="chevron" size={13} /></button></div>
        <div className="dash-table-scroll"><table className="dash-table"><thead><tr><th>계약 / 현장</th><th>회원</th><th>계약 금액</th><th>진행 상태</th></tr></thead><tbody>{contracts.slice(0, 5).map((contract) => <tr key={contract.id} onClick={() => onNavigate('contracts', String(contract.id))} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') onNavigate('contracts', String(contract.id)); }} aria-label={`${contract.siteName || contract.type || '계약'} 상세 보기`}><td><strong>{contract.siteName || contract.type || '계약서'}</strong><span>{contract.type || `#${contract.id}`}<i>·</i>{dateLabel(contract.startDate || contract.createdAt)}</span></td><td><span className="dash-owner">{contract.fullName || contract.userName || '—'}</span><span>{contract.companyName || '—'}</span></td><td className="dash-money">{number(contract.fee)}<span>원</span></td><td><span className={`dash-status dash-status-${contract.progress || 'scheduled'}`}>{statuses[contract.progress || '']?.label || contract.progress || '—'}</span></td></tr>)}</tbody></table></div>
        {!contracts.length && <Empty label={loading ? '계약을 불러오는 중입니다' : '등록된 계약이 없습니다'} />}
      </section>
      <section className="dash-panel dash-inquiries"><div className="dash-panel-heading"><h2>최근 문의{metrics?.pendingInquiries ? <span className="dash-count">{number(metrics.pendingInquiries)}</span> : null}</h2><button className="dash-view-all" onClick={() => onNavigate('inquiries')}>전체 보기<Icon name="chevron" size={13} /></button></div>
        <div className="dash-inquiry-list">{inquiries.slice(0, 4).map((inquiry) => <button key={inquiry.id} className="dash-inquiry" onClick={() => onNavigate('inquiries', String(inquiry.id))}><span className={`dash-inquiry-state${inquiry.answeredAt || inquiry.answered ? ' dash-answered' : ''}`}>{inquiry.answeredAt || inquiry.answered ? '답변 완료' : '답변 대기'}</span><strong>{inquiry.title}</strong><span className="dash-inquiry-meta">{inquiry.fullName || inquiry.userName || inquiry.companyName || '회원'}<i>·</i>{dateLabel(inquiry.createdAt)}</span><span className="dash-inquiry-arrow"><Icon name="chevron" size={15} /></span></button>)}</div>
        {!inquiries.length && <Empty label={loading ? '문의를 불러오는 중입니다' : '접수된 문의가 없습니다'} />}
      </section>
    </div>
    <div className="dash-footer"><span>조회 기간 {dateLabel(from)} — {dateLabel(to)}</span><span>{data ? `활성 회원 ${number(metrics?.activeUsers)}명` : '통계 조회 대기'}</span></div>
  </div>;
}
