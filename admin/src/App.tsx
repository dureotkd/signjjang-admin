import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BookUser, CalendarDays, ChevronRight, CircleHelp, FileText, FolderOpen, LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Megaphone, Menu, MessageSquare, RefreshCw, Send, ShieldCheck, Truck, Users, Wallet, X } from 'lucide-react';
import { api, ApiError, readSession, saveSession, type AdminSession } from './api';
import Dashboard, { type DashboardData } from './Dashboard';
import ResourcePage, { useDialogFocus } from './ResourcePage';
import { resources, workStatuses } from './resources';

const icons: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number }>> = { users: Users, file: FileText, calendar: CalendarDays, truck: Truck, folder: FolderOpen, contacts: BookUser, message: MessageSquare, megaphone: Megaphone, send: Send, wallet: Wallet, shield: ShieldCheck };
const getRoute = () => {
  const value = location.hash.slice(1).split('?')[0];
  return resources.some(r => r.id === value) ? value : 'dashboard';
};
const getRouteStatus = () => new URLSearchParams(location.hash.split('?')[1] || '').get('status') || '';
const getRouteParam = (name: string) => new URLSearchParams(location.hash.split('?')[1] || '').get(name) || '';
const todayKorea = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const initialRange = () => {
  const to = todayKorea();
  const from = new Date(`${to}T12:00:00+09:00`);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: from.toISOString().slice(0, 10), to };
};

function Brand({ light = false }: { light?: boolean }) {
  return <div className={`brand ${light ? 'brand-light' : ''}`}><span className="brand-symbol"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m8 20 7-12 5 8 4-6M8 25h16" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span>싸인짱<small>ADMIN</small></span></div>;
}

function Login({ onLogin, notice }: { onLogin: (session: AdminSession) => void; notice: string }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const session = await api<AdminSession>('/auth/login', undefined, { method: 'POST', body: JSON.stringify({ password }) }); saveSession(session); onLogin(session); }
    catch (error) { setError(error instanceof Error ? error.message : '로그인하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  return <main className="login-layout"><aside className="login-art"><Brand light /><div className="login-art-center"><span className="login-kicker">SIGNJJANG WORKSPACE</span><h1>관리자<br />워크스페이스</h1><div className="login-art-grid" aria-hidden="true"><div className="art-mini-card"><Users size={22} /><span>회원</span><div className="art-placeholder" /></div><div className="art-mini-card"><FileText size={22} /><span>계약서</span><div className="art-placeholder" /></div><div className="art-graph"><span>OVERVIEW</span><svg viewBox="0 0 380 130" fill="none"><defs><linearGradient id="login-area" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#94c9b4" stopOpacity=".25" /><stop offset="1" stopColor="#94c9b4" stopOpacity="0" /></linearGradient></defs><path d="M0 110 35 95 75 100 110 65 145 78 180 42 220 58 255 25 295 42 335 17 380 8V130H0Z" fill="url(#login-area)" /><path d="m0 110 35-15 40 5 35-35 35 13 35-36 40 16 35-33 40 17 40-25 45-9" stroke="#9ccab7" strokeWidth="2.5" /></svg></div></div></div><span className="login-art-footer">싸인짱 관리자</span></aside><section className="login-form-side"><div className="login-mobile-brand"><Brand /></div><form className="login-form" onSubmit={event => void submit(event)}><div className="login-lock"><LockKeyhole size={24} strokeWidth={1.5} /></div><span className="eyebrow">ADMIN CONSOLE</span><h2>관리자 로그인</h2>{notice && <div className="inline-message" role="status">{notice}</div>}<label className="form-field"><span>비밀번호</span><input type="password" autoFocus autoComplete="current-password" name="password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={200} placeholder="비밀번호 입력" /></label>{error && <div className="error-message" role="alert">{error}</div>}<button className="button primary login-submit" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" /> : null}로그인<ChevronRight size={17} /></button><span className="login-private"><ShieldCheck size={14} />관리자 전용</span></form><span className="login-copyright">© {new Date().getFullYear()} SIGNJJANG</span></section></main>;
}

export default function App() {
  const [session, setSession] = useState<AdminSession | null>(readSession);
  const [checking, setChecking] = useState(() => !!readSession());
  const [sessionError, setSessionError] = useState('');
  const [notice, setNotice] = useState('');
  const [route, setRoute] = useState(getRoute);
  const [initialStatus, setInitialStatus] = useState(getRouteStatus);
  const [initialProgress, setInitialProgress] = useState(() => getRouteParam('progress'));
  const [initialId, setInitialId] = useState(() => getRouteParam('id'));
  const [sidebar, setSidebar] = useState(false);
  const [range, setRange] = useState(initialRange);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [help, setHelp] = useState(false);
  const token = session?.accessToken;
  const logout = useCallback((expired = false) => { saveSession(null); setSession(null); setData(null); setChecking(false); setSessionError(''); setNotice(expired ? '로그인이 만료되었습니다. 다시 로그인해 주세요.' : ''); }, []);
  const unauthorized = useCallback(() => logout(true), [logout]);
  const navigate = useCallback((value: string, filter = '') => {
    const isId = /^\d+$/.test(filter);
    const isProgress = value === 'contracts' && workStatuses.some(([status]) => status === filter);
    setInitialId(isId ? filter : ''); setInitialProgress(isProgress ? filter : ''); setInitialStatus(isId || isProgress ? '' : filter); setRoute(value);
    location.hash = `${value}${filter ? `?${isId ? 'id' : isProgress ? 'progress' : 'status'}=${encodeURIComponent(filter)}` : ''}`;
    setSidebar(false); window.scrollTo({ top: 0 });
  }, []);
  useEffect(() => { const handler = () => { setRoute(getRoute()); setInitialStatus(getRouteStatus()); setInitialProgress(getRouteParam('progress')); setInitialId(getRouteParam('id')); setSidebar(false); }; window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  // A verified session is required before mounting any administration screen.
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setChecking(true); setSessionError('');
    api<{ admin: AdminSession['admin'] }>('/auth/session', token, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setSession(current => current ? { ...current, admin: result.admin } : null); setChecking(false);
    }).catch(error => { if (controller.signal.aborted) return; if (error instanceof ApiError && error.status === 401) unauthorized(); else { setChecking(false); setSessionError(error instanceof Error ? error.message : '로그인을 확인하지 못했습니다.'); } });
    return () => controller.abort();
  }, [token, unauthorized]);
  const active = resources.find(resource => resource.id === route);
  useEffect(() => {
    if (!token || checking || sessionError) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    api<DashboardData>(`/dashboard?${new URLSearchParams(range)}`, token, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setData(result); }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) unauthorized(); else setError(error instanceof Error ? error.message : '통계를 불러오지 못했습니다.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, checking, sessionError, range, refresh, unauthorized]);
  useEffect(() => { if (!sidebar) return; const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSidebar(false); }; document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape); }, [sidebar]);
  useEffect(() => { document.title = `${active?.label || '대시보드'} · 싸인짱 관리자`; }, [active]);

  if (!session) return <Login notice={notice} onLogin={value => { setChecking(true); setSession(value); setNotice(''); }} />;
  if (checking) return <div className="app-loading" role="status"><Brand /><LoaderCircle className="spin" size={24} /><span>로그인 확인 중</span></div>;
  if (sessionError) return <div className="app-loading"><Brand /><p role="alert">{sessionError}</p><button className="button secondary" onClick={() => logout()}>로그인 화면으로</button></div>;

  return <div className="admin-layout">
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>본문 바로가기</a>
    {sidebar && <button className="sidebar-backdrop" aria-label="메뉴 닫기" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? 'sidebar-open' : ''}`}><div className="sidebar-brand"><Brand /><button className="icon-button mobile-close" aria-label="메뉴 닫기" onClick={() => setSidebar(false)}><X size={20} /></button></div><nav aria-label="관리 메뉴"><div className="nav-group"><span className="nav-group-title">워크스페이스</span><button className={`nav-link ${route === 'dashboard' ? 'nav-active' : ''}`} aria-current={route === 'dashboard' ? 'page' : undefined} onClick={() => navigate('dashboard')}><LayoutDashboard size={18} strokeWidth={1.7} /><span>대시보드</span></button></div>{['운영', '고객지원', '기록', '설정'].map(group => <div className="nav-group" key={group}><span className="nav-group-title">{group}</span>{resources.filter(resource => resource.group === group).map(resource => { const Icon = icons[resource.icon] || FileText; return <button key={resource.id} className={`nav-link ${route === resource.id ? 'nav-active' : ''}`} aria-current={route === resource.id ? 'page' : undefined} onClick={() => navigate(resource.id)}><Icon size={18} strokeWidth={1.7} /><span>{resource.label}</span>{resource.id === 'inquiries' && !!data?.metrics.pendingInquiries && <span className="nav-count">{data.metrics.pendingInquiries}</span>}</button>; })}</div>)}</nav><div className="sidebar-bottom"><button className="nav-link" onClick={() => setHelp(true)}><CircleHelp size={18} strokeWidth={1.7} /><span>이용 안내</span><ChevronRight size={15} /></button><div className="workspace-card"><span className="workspace-icon"><ShieldCheck size={19} /></span><span>관리자 워크스페이스<small>ADMIN WORKSPACE</small></span></div></div></aside>
    <div className="main-layout"><header className="topbar"><div className="topbar-left"><button className="icon-button menu-toggle" aria-label="메뉴 열기" onClick={() => setSidebar(true)}><Menu size={21} /></button><span className="breadcrumb-home">워크스페이스</span><ChevronRight size={14} /><span>{active?.label || '대시보드'}</span></div><div className="topbar-right"><span className="topbar-date">{new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())}</span><button className="icon-button" onClick={() => setRefresh(v => v + 1)} aria-label="새로고침"><RefreshCw size={17} className={loading ? 'spin' : ''} /></button><button className="icon-button notification-button" aria-label={`미답변 문의 ${data?.metrics.pendingInquiries ?? 0}건`} onClick={() => navigate('inquiries', 'pending')}><Bell size={18} />{!!data?.metrics.pendingInquiries && <i />}</button><span className="topbar-divider" /><div className="admin-person"><span className="admin-avatar">{session.admin.name?.slice(0, 1) || '관'}</span><span>{session.admin.name || '관리자'}<small>Administrator</small></span></div><button className="icon-button logout-button" aria-label="로그아웃" title="로그아웃" onClick={() => logout()}><LogOut size={17} /></button></div></header>
      <main id="main-content" className="main-content" tabIndex={-1}>{route === 'dashboard' ? <>{error && <div className="list-error" role="alert"><span>{error}</span><button className="text-button" onClick={() => setRefresh(v => v + 1)}>다시 시도</button></div>}<Dashboard data={error ? null : data} loading={loading} onNavigate={navigate} from={range.from} to={range.to} onDateChange={(from, to) => setRange({ from, to })} /></> : active ? <ResourcePage key={`${route}-${initialStatus}-${initialProgress}-${initialId}`} resource={active} token={session.accessToken} refreshKey={refresh} initialStatus={initialStatus} initialProgress={initialProgress} initialId={initialId} onUnauthorized={unauthorized} onChanged={() => setRefresh(v => v + 1)} /> : null}</main>
    </div>
    {help && <HelpDialog close={() => setHelp(false)} />}
  </div>;
}

function HelpDialog({ close }: { close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, close);
  return <div className="modal-backdrop help-backdrop" onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="help-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="help-heading"><h2 id="help-title">이용 안내</h2><button className="icon-button" aria-label="닫기" onClick={close}><X size={20} /></button></div><dl><div><dt>통계</dt><dd>조회 기간의 가입·계약 추이와 계약 금액을 확인합니다.</dd></div><div><dt>목록 관리</dt><dd>검색과 필터로 항목을 찾고, 우측 화살표로 상세 정보를 엽니다.</dd></div><div><dt>내보내기</dt><dd>현재 조회 중인 페이지를 CSV 파일로 저장합니다.</dd></div><div><dt>회원 상태</dt><dd>정지한 회원은 앱의 데이터에 접근할 수 없습니다.</dd></div></dl></div></div>;
}
