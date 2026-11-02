import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, ChevronRight, ExternalLink, FileSearch, LoaderCircle, Plus, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { api, ApiError, exportCsv, openDocument, type PageResult, type Row } from './api';
import { displayValue, statusLabels, workStatuses, type Column, type Field, type Resource } from './resources';

export const str = (value: unknown) => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const dateLabel = (value: unknown) => {
  if (!value) return '—';
  const date = new Date(str(value));
  return Number.isNaN(date.getTime()) ? str(value) : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
};
const numberLabel = (value: unknown) => Number(value || 0).toLocaleString('ko-KR');
export function Badge({ value }: { value: unknown }) {
  const key = typeof value === 'boolean' ? (value ? 'active' : 'inactive') : str(value);
  const label = typeof value === 'boolean' ? (value ? '노출' : '숨김') : statusLabels[key] || key || '—';
  return <span className={`badge badge-${key.replace(/[^a-zA-Z]/g, '')}`}><span />{label}</span>;
}

function Cell({ row, column }: { row: Row; column: Column }) {
  const value = displayValue(row, column.key);
  if (column.kind === 'status') return <Badge value={value} />;
  if (column.kind === 'money') return <span className="table-amount">{numberLabel(value)}<small> 원</small></span>;
  if (column.kind === 'date') return <span className="table-date">{dateLabel(value)}</span>;
  if (column.kind === 'person') return <span className="table-person"><span className="mini-avatar">{str(value).slice(0, 1)}</span>{str(value)}</span>;
  return <span className="cell-text" title={str(value)}>{str(value) || '—'}</span>;
}

export function useDialogFocus(ref: React.RefObject<HTMLDivElement | null>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';
    const first = node?.querySelector<HTMLElement>(selector);
    first?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab') {
        const elements = [...(node?.querySelectorAll<HTMLElement>(selector) || [])].filter(el => el.getClientRects().length);
        const firstEl = elements[0], lastEl = elements.at(-1);
        if (event.shiftKey && document.activeElement === firstEl) { event.preventDefault(); lastEl?.focus(); }
        else if (!event.shiftKey && document.activeElement === lastEl) { event.preventDefault(); firstEl?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', keydown); document.body.style.overflow = overflow; before?.isConnected && before.focus(); };
  }, [ref]);
}

function inputValue(field: Field, row: Row) {
  const value = row[field.key];
  if (field.type === 'checkbox') return value == null ? true : Boolean(value);
  if (field.type === 'lines') return Array.isArray(value) ? value.join('\n') : str(value);
  if (field.type === 'datetime-local') {
    const date = value ? new Date(str(value)) : new Date();
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  if (field.type === 'date') return str(value).slice(0, 10);
  return value ?? field.options?.[0]?.[0] ?? '';
}

function Editor({ resource, row, token, onClose, onSaved, onUnauthorized }: { resource: Resource; row: Row; token: string; onClose: () => void; onSaved: (message: string) => void; onUnauthorized: () => void }) {
  const isNew = !row.id && !row.slug;
  const ref = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Row>(() => Object.fromEntries(resource.fields.map(f => [f.key, inputValue(f, row)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState('');
  const previewRef = useRef('');
  const withdrawn = resource.id === 'users' && row.status === 'withdrawn';
  useDialogFocus(ref, () => { if (!busy) onClose(); });
  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }, []);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true); setError('');
    try { await operation(); onSaved(success); }
    catch (error) { if (error instanceof ApiError && error.status === 401) onUnauthorized(); else setError(error instanceof Error ? error.message : '처리하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const body: Row = {};
    for (const field of resource.fields) {
      const value = values[field.key];
      body[field.key] = field.type === 'number' ? Number(value) : field.type === 'lines' ? str(value).split('\n').map(s => s.trim()).filter(Boolean) : field.type === 'datetime-local' ? new Date(str(value)).toISOString() : field.type === 'date' && !value ? null : value;
    }
    const id = row.id ?? row.slug;
    void run(() => api(`/${resource.id}${isNew ? '' : `/${encodeURIComponent(str(id))}`}`, token, { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(body) }), isNew ? '등록했습니다.' : '저장했습니다.');
  };
  const showFile = async () => {
    setBusy(true); setError('');
    try { const url = await openDocument(str(row.id), token); if (previewRef.current) URL.revokeObjectURL(previewRef.current); previewRef.current = url; setPreview(url); }
    catch (error) { if (error instanceof ApiError && error.status === 401) onUnauthorized(); else setError(error instanceof Error ? error.message : '파일을 열지 못했습니다.'); }
    finally { setBusy(false); }
  };

  const contextFields = [
    ['회원', row.fullName || row.userName], ['상호명', row.companyName], ['등록일', row.createdAt && dateLabel(row.createdAt)],
    ...(resource.id === 'schedules' ? [['현장명', row.siteName], ['작업일', dateLabel(row.date)], ['작업 금액', `${numberLabel(row.fee)} 원`], ['수금 상태', row.settlement], ['연결된 계약서', row.contractId]] : []),
    ...(resource.id === 'deliveries' ? [['계약서 번호', row.contractId], ['수신 번호', row.recipientPhone], ['발송 상태', statusLabels[str(row.status)]], ['발송 ID', row.providerMessageId]] : []),
    ...(resource.id === 'users' ? [['최근 로그인', row.lastLoginAt && dateLabel(row.lastLoginAt)], ['사업자 등록번호', row.businessRegistrationNo], ['추천 코드', row.referralCode]] : []),
  ].filter(([, value]) => value);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="detail-drawer" ref={ref} role="dialog" aria-modal="true" aria-labelledby="editor-title">
      <header className="drawer-header"><div><span className="eyebrow">{isNew ? '새 항목' : `상세 정보${row.id ? ` · #${row.id}` : ''}`}</span><h2 id="editor-title">{resource.label}{isNew ? ' 등록' : ''}</h2></div><button className="icon-button" type="button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={21} /></button></header>
      <form onSubmit={save} className="drawer-form">
        <div className="drawer-body">
          {contextFields.length > 0 && <dl className="detail-context">{contextFields.map(([label, value]) => <div key={str(label)}><dt>{str(label)}</dt><dd>{str(value)}</dd></div>)}</dl>}
          {resource.id === 'inquiries' && <section className="inquiry-content"><span className="eyebrow">문의 내용</span><h3>{str(row.title)}</h3><p>{str(row.content)}</p></section>}
          {resource.id === 'documents' && <><button type="button" className="button secondary full-width" onClick={() => void showFile()} disabled={busy}><ExternalLink size={16} />파일 미리보기</button>{preview && <iframe className="document-preview" title="서류 미리보기" src={preview} sandbox="allow-same-origin" />}</>}
          {withdrawn ? <div className="inline-message">탈퇴한 회원의 정보입니다.</div> : resource.fields.map(field => <label className={`form-field ${field.type === 'checkbox' ? 'checkbox-field' : ''}`} key={field.key}>
            <span>{field.label}{field.required && <i aria-label="필수"> *</i>}</span>
            {field.type === 'textarea' || field.type === 'lines' ? <textarea name={field.key} rows={field.key === 'body' ? 15 : field.key === 'answer' ? 9 : 4} required={field.required} maxLength={field.max} value={str(values[field.key])} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))} /> : field.type === 'select' ? <select name={field.key} value={str(values[field.key])} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))}>{field.options?.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : field.type === 'checkbox' ? <input type="checkbox" name={field.key} checked={Boolean(values[field.key])} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.checked }))} /> : <input name={field.key} type={field.type || 'text'} min={field.type === 'number' ? 0 : undefined} max={field.type === 'number' ? Number.MAX_SAFE_INTEGER : undefined} step={field.type === 'number' ? 1 : undefined} maxLength={field.max} required={field.required} value={str(values[field.key])} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))} />}
          </label>)}
          {error && <div className="error-message" role="alert">{error}</div>}
          {confirmDelete && <div className="delete-confirm" role="alert"><strong>이 항목을 삭제하시겠습니까?</strong><p>삭제한 데이터는 복구할 수 없습니다.</p><div><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>취소</button><button type="button" className="button danger" disabled={busy} onClick={() => void run(() => api(`/${resource.id}/${encodeURIComponent(str(row.id ?? row.slug))}`, token, { method: 'DELETE' }), '삭제했습니다.')}>삭제</button></div></div>}
        </div>
        <footer className="drawer-footer">{resource.delete && !isNew && <button className="icon-button delete-action" type="button" aria-label="항목 삭제" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={18} /></button>}<button className="button secondary" type="button" disabled={busy} onClick={onClose}>닫기</button>{resource.fields.length > 0 && !withdrawn && <button type="submit" className="button primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{isNew ? '등록' : '저장'}</button>}</footer>
      </form>
    </div>
  </div>;
}

export default function ResourcePage({ resource, token, refreshKey, initialStatus, initialProgress, initialId, onUnauthorized, onChanged }: { resource: Resource; token: string; refreshKey: number; initialStatus?: string; initialProgress?: string; initialId?: string; onUnauthorized: () => void; onChanged: () => void }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(initialStatus || '');
  const [progress, setProgress] = useState(initialProgress || '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(15);
  const [data, setData] = useState<PageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<Row | null>(null);
  const [toast, setToast] = useState('');
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setPage(1); }, 280); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(page), limit: String(limit), q: search, ...(status ? { status } : {}), ...(progress ? { progress } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
    api<PageResult>(`/${resource.id}?${params}`, token, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setData(result); if (page > 1 && !result.items.length && result.total > 0) setPage(Math.ceil(result.total / limit)); }
    }).catch(error => { if (controller.signal.aborted) return; if (error instanceof ApiError && error.status === 401) unauthorizedRef.current(); else setError(error instanceof Error ? error.message : '목록을 불러오지 못했습니다.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [resource.id, token, page, limit, search, status, progress, from, to, refreshKey, reload]);
  useEffect(() => () => { detailRequest.current += 1; }, []);

  const openDetail = async (row: Row) => {
    const id = str(row.id ?? row.slug);
    const request = ++detailRequest.current;
    setDetailLoading(id); setError('');
    try { const detail = await api<Row>(`/${resource.id}/${encodeURIComponent(id)}`, token); if (request === detailRequest.current) setEditing(detail); }
    catch (error) { if (request !== detailRequest.current) return; if (error instanceof ApiError && error.status === 401) onUnauthorized(); else setError(error instanceof Error ? error.message : '상세 정보를 불러오지 못했습니다.'); }
    finally { if (request === detailRequest.current) setDetailLoading(null); }
  };
  useEffect(() => { if (initialId) void openDetail({ id: initialId }); }, [initialId]);
  const rows = data?.items || [];
  const total = data?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const clearFilters = () => { setQuery(''); setSearch(''); setStatus(''); setProgress(''); setFrom(''); setTo(''); setPage(1); };
  const hasFilters = query || status || progress || from || to;
  const exportRows = () => {
    const items = rows.map(row => Object.fromEntries(resource.columns.map(column => [column.key, column.kind === 'status' ? statusLabels[str(displayValue(row, column.key))] || displayValue(row, column.key) : displayValue(row, column.key)])));
    exportCsv(`싸인짱_${resource.label}_${page}페이지`, resource.columns, items);
    setToast('현재 페이지를 내보냈습니다.');
  };

  return <div className="resource-page">
    <div className="page-title-row"><div><span className="eyebrow">{resource.group}</span><h1>{resource.label}</h1></div><div className="title-actions"><button className="button secondary" disabled={loading || !!error || rows.length === 0} onClick={exportRows}><ArrowDownToLine size={16} /><span>현재 페이지 내보내기</span></button>{resource.create && <button className="button primary" onClick={() => setEditing({})}><Plus size={17} />공지 등록</button>}</div></div>
    <section className="resource-panel" aria-label={resource.label}>
      <div className="resource-tabs"><button className={!status ? 'active' : ''} onClick={() => { setStatus(''); setPage(1); }}>전체{!loading && !status && <span>{numberLabel(total)}</span>}</button>{resource.filters?.map(([value, label]) => <button className={status === value ? 'active' : ''} key={value} onClick={() => { setStatus(value); setPage(1); }}>{label}</button>)}</div>
      <div className="table-toolbar"><label className="search-field"><Search size={17} /><input aria-label="목록 검색" value={query} onChange={e => setQuery(e.target.value)} placeholder="검색어 입력" />{query && <button aria-label="검색어 지우기" onClick={() => setQuery('')}><X size={14} /></button>}</label><div className="toolbar-filters">{resource.id === 'contracts' && <select className="progress-filter" aria-label="작업 상태 필터" value={progress} onChange={event => { setProgress(event.target.value); setPage(1); }}><option value="">전체 작업 상태</option>{workStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}{resource.dates && <div className="date-range"><SlidersHorizontal size={15} /><input type="date" aria-label="조회 시작일" value={from} max={to || '9999-12-31'} onChange={e => { setFrom(e.target.value); setPage(1); }} /><span>–</span><input type="date" aria-label="조회 종료일" value={to} min={from} onChange={e => { setTo(e.target.value); setPage(1); }} /></div>}{hasFilters && <button className="text-button" onClick={clearFilters}>초기화</button>}</div></div>
      {error && <div className="list-error" role="alert"><span>{error}</span><button className="text-button" onClick={() => setReload(v => v + 1)}>다시 시도</button></div>}
      <div className="table-scroll"><table className="data-table"><thead><tr><th className="id-column">번호</th>{resource.columns.map(column => <th key={column.key} className={column.kind === 'money' ? 'align-right' : ''}>{column.label}</th>)}<th><span className="sr-only">상세 보기</span></th></tr></thead><tbody>
        {loading ? Array.from({ length: 7 }, (_, index) => <tr key={index} aria-hidden="true"><td><div className="skeleton short" /></td>{resource.columns.map(column => <td key={column.key}><div className="skeleton" /></td>)}<td /></tr>) : !error && rows.map(row => <tr key={str(row.id ?? row.slug)}><td className="id-column">{str(row.id ?? row.slug)}</td>{resource.columns.map(column => <td key={column.key} className={column.kind === 'money' ? 'align-right' : ''}><Cell row={row} column={column} /></td>)}<td><button className="row-open" aria-label={`${str(row.title || row.fullName || row.siteName || row.name || row.label || row.id || row.slug)} 상세 보기`} onClick={() => void openDetail(row)} disabled={detailLoading !== null}>{detailLoading === str(row.id ?? row.slug) ? <LoaderCircle size={16} className="spin" /> : <ChevronRight size={17} />}</button></td></tr>)}
      </tbody></table></div>
      {!loading && !error && !rows.length && <div className="empty-state"><span><FileSearch size={28} strokeWidth={1.4} /></span><strong>{hasFilters ? '검색 결과가 없습니다' : '등록된 항목이 없습니다'}</strong>{hasFilters && <button className="text-button" onClick={clearFilters}>필터 초기화</button>}</div>}
      <div className="table-footer"><div className="table-summary">총 <strong>{numberLabel(total)}</strong>개{total > 0 && <span> · {(page - 1) * limit + 1}–{Math.min(page * limit, total)}</span>}</div><div className="pagination"><label><span className="sr-only">페이지당 항목</span><select value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}><option value={15}>15개씩</option><option value={30}>30개씩</option><option value={50}>50개씩</option></select></label><button className="icon-button" aria-label="이전 페이지" disabled={loading || page <= 1} onClick={() => setPage(v => v - 1)}><ArrowLeft size={16} /></button><span>{page} <span>/ {pageCount}</span></span><button className="icon-button" aria-label="다음 페이지" disabled={loading || page >= pageCount} onClick={() => setPage(v => v + 1)}><ArrowRight size={16} /></button></div></div>
    </section>
    {editing && <Editor key={`${resource.id}-${str(editing.id ?? editing.slug)}`} resource={resource} row={editing} token={token} onClose={() => setEditing(null)} onUnauthorized={onUnauthorized} onSaved={message => { setEditing(null); setToast(message); setReload(v => v + 1); onChanged(); }} />}
    {toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}
  </div>;
}
