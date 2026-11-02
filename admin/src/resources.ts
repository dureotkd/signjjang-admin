export type Field = { key: string; label: string; type?: 'text' | 'email' | 'number' | 'date' | 'datetime-local' | 'textarea' | 'select' | 'checkbox' | 'lines'; options?: [string, string][]; required?: boolean; max?: number };
export type Column = { key: string; label: string; kind?: 'date' | 'money' | 'status' | 'person' | 'number' };
export type Resource = { id: string; label: string; group: string; icon: string; columns: Column[]; fields: Field[]; filters?: [string, string][]; create?: boolean; delete?: boolean; dates?: boolean };
export const workStatuses: [string, string][] = [['scheduled', '작업 예정'], ['inProgress', '작업 중'], ['ended', '작업 완료'], ['unpaid', '미수금'], ['settled', '수금 완료']];
export const contractStatuses: [string, string][] = [['draft', '임시 저장'], ['saved', '작성 완료'], ['completed', '서명 완료']];
export const statusLabels: Record<string, string> = Object.fromEntries([
  ...workStatuses, ...contractStatuses, ['active', '활성'], ['inactive', '정지'], ['withdrawn', '탈퇴'], ['sent', '발송 완료'], ['failed', '발송 실패'], ['queued', '발송 대기'], ['answered', '답변 완료'], ['pending', '답변 대기'], ['published', '게시 중'], ['scheduledNotice', '예약'],
]);

const owner: Column = { key: 'fullName', label: '회원', kind: 'person' };
export const resources: Resource[] = [
  { id: 'users', label: '회원 관리', group: '운영', icon: 'users', dates: true,
    columns: [{ key: 'fullName', label: '회원', kind: 'person' }, { key: 'companyName', label: '상호명' }, { key: 'phone', label: '연락처' }, { key: 'status', label: '상태', kind: 'status' }, { key: 'createdAt', label: '가입일', kind: 'date' }],
    filters: [['active', '활성'], ['inactive', '정지'], ['withdrawn', '탈퇴']],
    fields: [{ key: 'fullName', label: '이름', required: true, max: 60 }, { key: 'companyName', label: '상호명', required: true, max: 100 }, { key: 'phone', label: '연락처', required: true, max: 20 }, { key: 'email', label: '이메일', type: 'email', max: 190 }, { key: 'status', label: '회원 상태', type: 'select', options: [['active', '활성'], ['inactive', '정지']] }],
  },
  { id: 'contracts', label: '계약서 관리', group: '운영', icon: 'file', dates: true, delete: true,
    columns: [{ key: 'siteName', label: '현장명' }, owner, { key: 'type', label: '계약서 종류' }, { key: 'fee', label: '계약 금액', kind: 'money' }, { key: 'status', label: '계약 상태', kind: 'status' }, { key: 'progress', label: '작업 상태', kind: 'status' }, { key: 'startDate', label: '작업일', kind: 'date' }],
    filters: contractStatuses,
    fields: [{ key: 'type', label: '계약서 종류', type: 'select', options: ['건설기계사용확인서', '건설기계사용청구서', '장비임대사용계약서', '작업확인서'].map(s => [s, s]) }, { key: 'status', label: '계약 상태', type: 'select', options: contractStatuses }, { key: 'siteName', label: '현장명', max: 200 }, { key: 'siteAddress', label: '현장 주소', max: 500 }, { key: 'startDate', label: '작업일', type: 'date', required: true }, { key: 'fee', label: '계약 금액 (원)', type: 'number', required: true }, { key: 'orderer', label: '발주처', max: 100 }, { key: 'orderPhone', label: '발주처 연락처', max: 30 }, { key: 'workContent', label: '작업 내용', type: 'textarea', max: 10000 }, { key: 'memo', label: '메모', type: 'textarea', max: 10000 }],
  },
  { id: 'schedules', label: '일정 관리', group: '운영', icon: 'calendar', dates: true, delete: true,
    columns: [{ key: 'date', label: '작업일', kind: 'date' }, { key: 'siteName', label: '현장명' }, owner, { key: 'equipment', label: '장비' }, { key: 'fee', label: '작업 금액', kind: 'money' }, { key: 'status', label: '작업 상태', kind: 'status' }, { key: 'settlement', label: '수금 상태', kind: 'status' }],
    filters: workStatuses,
    fields: [{ key: 'status', label: '작업 상태', type: 'select', options: workStatuses }],
  },
  { id: 'equipments', label: '장비 관리', group: '운영', icon: 'truck', delete: true,
    columns: [{ key: 'category', label: '장비 종류' }, { key: 'tonnage', label: '규격' }, { key: 'vehicleNo', label: '차량 번호' }, owner, { key: 'companyName', label: '상호명' }, { key: 'createdAt', label: '등록일', kind: 'date' }],
    fields: [{ key: 'category', label: '장비 종류', required: true, max: 50 }, { key: 'tonnage', label: '규격', max: 50 }, { key: 'vehicleNo', label: '차량 번호', max: 30 }],
  },
  { id: 'documents', label: '서류 관리', group: '운영', icon: 'folder', delete: true, dates: true,
    columns: [{ key: 'label', label: '서류명' }, { key: 'documentType', label: '서류 종류' }, owner, { key: 'originalName', label: '파일명' }, { key: 'expiresOn', label: '만료일', kind: 'date' }, { key: 'createdAt', label: '등록일', kind: 'date' }],
    fields: [{ key: 'label', label: '서류명', required: true, max: 100 }, { key: 'documentType', label: '서류 종류', required: true, max: 80 }, { key: 'expiresOn', label: '만료일', type: 'date' }],
  },
  { id: 'alliances', label: '연락처 관리', group: '운영', icon: 'contacts', delete: true,
    columns: [{ key: 'tradeName', label: '상호명' }, { key: 'contactName', label: '담당자' }, { key: 'phone', label: '연락처' }, owner, { key: 'createdAt', label: '등록일', kind: 'date' }],
    fields: [{ key: 'tradeName', label: '상호명', required: true, max: 100 }, { key: 'contactName', label: '담당자', required: true, max: 60 }, { key: 'phone', label: '연락처', required: true, max: 20 }],
  },
  { id: 'inquiries', label: '1:1 문의', group: '고객지원', icon: 'message', dates: true,
    columns: [{ key: 'title', label: '문의 제목' }, owner, { key: 'status', label: '답변 상태', kind: 'status' }, { key: 'createdAt', label: '접수일', kind: 'date' }],
    filters: [['pending', '답변 대기'], ['answered', '답변 완료']],
    fields: [{ key: 'answer', label: '답변', type: 'textarea', required: true, max: 10000 }],
  },
  { id: 'notices', label: '공지사항', group: '고객지원', icon: 'megaphone', create: true, delete: true, dates: true,
    columns: [{ key: 'title', label: '제목' }, { key: 'slug', label: '고유 주소' }, { key: 'publishedAt', label: '게시일', kind: 'date' }, { key: 'updatedAt', label: '수정일', kind: 'date' }],
    fields: [{ key: 'title', label: '제목', required: true, max: 200 }, { key: 'slug', label: '고유 주소', required: true, max: 120 }, { key: 'body', label: '내용', type: 'textarea', required: true, max: 50000 }, { key: 'publishedAt', label: '게시 시각', type: 'datetime-local', required: true }],
  },
  { id: 'deliveries', label: '문자 발송 이력', group: '기록', icon: 'send', dates: true,
    columns: [{ key: 'contractId', label: '계약서 번호' }, owner, { key: 'recipientPhone', label: '수신 번호' }, { key: 'recipientType', label: '수신 구분' }, { key: 'status', label: '발송 상태', kind: 'status' }, { key: 'createdAt', label: '발송일', kind: 'date' }],
    filters: [['sent', '발송 완료'], ['failed', '발송 실패'], ['queued', '발송 대기']], fields: [],
  },
  { id: 'plans', label: '요금제 관리', group: '설정', icon: 'wallet',
    columns: [{ key: 'name', label: '요금제' }, { key: 'price', label: '이용 금액', kind: 'money' }, { key: 'billingPeriod', label: '결제 주기' }, { key: 'active', label: '노출 상태', kind: 'status' }],
    fields: [{ key: 'name', label: '요금제명', required: true, max: 80 }, { key: 'price', label: '이용 금액 (원)', type: 'number', required: true }, { key: 'billingPeriod', label: '결제 주기', type: 'select', options: [['monthly', '월간'], ['yearly', '연간']] }, { key: 'features', label: '제공 기능 (줄바꿈으로 구분)', type: 'lines', required: true }, { key: 'active', label: '앱에 노출', type: 'checkbox' }],
  },
  { id: 'terms', label: '약관 관리', group: '설정', icon: 'shield',
    columns: [{ key: 'title', label: '약관명' }, { key: 'version', label: '버전' }, { key: 'effectiveOn', label: '시행일', kind: 'date' }, { key: 'updatedAt', label: '수정일', kind: 'date' }],
    fields: [{ key: 'title', label: '약관명', required: true, max: 150 }, { key: 'version', label: '버전', required: true, max: 30 }, { key: 'effectiveOn', label: '시행일', type: 'date', required: true }, { key: 'body', label: '내용', type: 'textarea', required: true, max: 50000 }],
  },
];

export function displayValue(row: Record<string, unknown>, key: string): unknown {
  if (key === 'fullName') return row.fullName || row.userName || row.ownerName || '—';
  if (key === 'status' && row.answeredAt !== undefined && row.status === undefined) return row.answeredAt ? 'answered' : 'pending';
  if (key === 'billingPeriod') return row[key] === 'yearly' ? '연간' : '월간';
  return row[key];
}
