const { normalizeSiteCoordinates, withSiteCoordinates } = require('./site-location');

const koreanToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

// Any unfinished work expires with the date. Explicit completion remains
// separate from collection, including when the document is edited later.
const statusForDate = (status, date, today = koreanToday()) => (
  ['scheduled', 'inProgress'].includes(status) && date < today ? 'ended' : status
);

function contractWorkDate(contract) {
  const date = contract.documentDate;
  const timestamp = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? Date.parse(`${date}T00:00:00Z`) : NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date
    ? date : contract.startDate;
}

function isContractPaid(contract, schedules) {
  return schedules.length
    ? schedules.some((schedule) => schedule.status === 'settled' || schedule.settlement === '정산완료')
    : contract.progress === 'settled';
}

function scheduleStateForUpdate(current, requested, { preserveSettlement = false, today = koreanToday() } = {}) {
  // Older clients use these status values as collection actions. They must
  // never complete future work or reopen already completed work.
  const collectionAction = ['settled', 'unpaid'].includes(requested.status);
  const currentWorkStatus = ['settled', 'unpaid'].includes(current.status) ? 'ended' : current.status;
  const status = collectionAction ? currentWorkStatus : requested.status;
  const settlement = collectionAction
    ? (requested.status === 'settled' ? '정산완료' : '미수금')
    : (preserveSettlement ? current.settlement : requested.settlement);
  return { status: statusForDate(status, current.date, today), settlement };
}

function scheduleFromContract(contract, existing, today = koreanToday()) {
  const date = contractWorkDate(contract);
  const status = statusForDate(existing?.status ?? contract.progress ?? 'scheduled', date, today);
  return withSiteCoordinates({
    ...existing,
    contractId: String(contract.id),
    date,
    equipment: contract.equipment ?? '',
    fee: contract.fee,
    note: contract.workContent || contract.memo || '',
    orderer: contract.orderer ?? '',
    orderPhone: contract.orderPhone ?? '',
    settlement: existing?.settlement ?? (status === 'settled' ? '정산완료' : '미수금'),
    siteAddress: contract.siteAddress ?? '',
    siteName: contract.siteName ?? '',
    sitePhone: contract.sitePhone ?? '',
    status,
    tenant: contract.tenant ?? '',
    vehicleNo: contract.vehicleNo ?? '',
    weather: existing?.weather ?? '',
    workContent: contract.workContent ?? '',
    workTime: contract.workTime ?? '',
    usagePeriods: contract.usagePeriods ?? [],
    usageHours: contract.usageHours ?? '',
    hourWork: contract.hourWork ?? '',
    nightWork: contract.nightWork ?? '',
  }, normalizeSiteCoordinates(contract));
}

module.exports = { contractWorkDate, isContractPaid, koreanToday, scheduleFromContract, scheduleStateForUpdate, statusForDate };
