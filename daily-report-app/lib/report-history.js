function dateKey(value, timeZone = 'Asia/Seoul') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getNextSteps(report = {}) {
  const value = report.actionGuide?.nextSteps || report.nextPlans || '';
  const text = typeof value === 'string' ? value.trim() : '';
  return /^(\[[^\]]*\]\s*)?(확인된 내용 없음|특이사항 없음|없음)[.!]?$/.test(text) ? '' : text;
}

function selectPreviousDailyReports(history, currentRanAt, timeZone = 'Asia/Seoul', limit = 7) {
  const currentKey = dateKey(currentRanAt, timeZone);
  const seenDates = new Set();

  return (Array.isArray(history) ? history : [])
    .filter(entry => entry && !entry.error && entry.report && entry.ranAt)
    .sort((a, b) => new Date(b.ranAt) - new Date(a.ranAt))
    .filter(entry => {
      const key = dateKey(entry.ranAt, timeZone);
      if (!key || key >= currentKey || seenDates.has(key)) return false;
      seenDates.add(key);
      return true;
    })
    .slice(0, limit);
}

function compact(value, maxLength = 1800) {
  const text = String(value || '확인된 내용 없음').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function buildHistoryContext(history, currentRanAt, timeZone = 'Asia/Seoul') {
  const previousReports = selectPreviousDailyReports(history, currentRanAt, timeZone);
  const previous = previousReports[0] || null;
  const previousPlan = previous ? getNextSteps(previous.report) : '';

  const text = previousReports.length
    ? previousReports.map(entry => {
      const report = entry.report || {};
      return [
        `[${dateKey(entry.ranAt, timeZone)} 보고서]`,
        `수행 업무: ${compact(report.tasks)}`,
        `주요 결과: ${compact(report.results)}`,
        `이슈: ${compact(report.issues)}`,
        `다음 단계: ${compact(getNextSteps(report))}`
      ].join('\n');
    }).join('\n\n')
    : '비교할 이전 날짜의 보고서가 없습니다.';

  return {
    text,
    previousReportCount: previousReports.length,
    previousDate: previous ? dateKey(previous.ranAt, timeZone) : '',
    previousPlan,
    previousPlans: previousPlan.split(/\n+/).map(value => value.trim()).filter(Boolean).slice(0, 5),
    hasPreviousPlan: Boolean(previousPlan)
  };
}

function normalizeTracking(rawTracking, historyContext) {
  const raw = rawTracking && typeof rawTracking === 'object' ? rawTracking : {};
  const maxRepeatDays = Math.min(8, (historyContext.previousReportCount || 0) + 1);
  const repeatIssues = maxRepeatDays >= 2 && Array.isArray(raw.repeatIssues)
    ? raw.repeatIssues
      .filter(item => item && Number(item.consecutiveDays) >= 2 && item.issue)
      .slice(0, 5)
      .map(item => ({
        issue: String(item.issue).replace(/^\[[^\]]+\]\s*/, '').trim(),
        consecutiveDays: Math.min(maxRepeatDays, Math.max(2, Math.round(Number(item.consecutiveDays)))),
        source: String(item.source || '출처 확인 필요').replace(/[\[\]]/g, '').trim()
      }))
    : [];

  const rawProgress = raw.previousPlanProgress || {};
  const plans = historyContext.hasPreviousPlan
    ? (historyContext.previousPlans || historyContext.previousPlan.split(/\n+/).filter(Boolean)).slice(0, 5)
    : [];
  const comparisons = plans.map(plan => {
    const item = Array.isArray(rawProgress.comparisons)
      ? rawProgress.comparisons.find(value => value?.plan?.trim() === plan.trim())
      : null;
    return {
      plan,
      status: ['completed', 'partial', 'not_started', 'uncertain'].includes(item?.status) ? item.status : 'uncertain',
      evidence: String(item?.evidence || '오늘 기록에서 실행 여부를 확인할 근거가 부족합니다.').trim()
    };
  });

  const completed = comparisons.filter(item => item.status === 'completed').length;
  const partial = comparisons.filter(item => item.status === 'partial').length;
  const notStarted = comparisons.filter(item => item.status === 'not_started').length;
  const uncertain = comparisons.filter(item => item.status === 'uncertain').length;
  const total = comparisons.length;
  const rate = total ? Math.round(((completed + partial * 0.5) / total) * 100) : 0;

  return {
    repeatIssues,
    previousPlanProgress: {
      hasPreviousPlan: historyContext.hasPreviousPlan,
      previousDate: historyContext.previousDate,
      previousPlan: historyContext.previousPlan,
      total,
      completed,
      partial,
      rate,
      summary: historyContext.hasPreviousPlan
        ? `${total}개 계획 중 완료 ${completed}개 · 부분 진행 ${partial}개 · 미착수 ${notStarted}개 · 확인 불가 ${uncertain}개`
        : '비교할 전일 계획이 없습니다.',
      comparisons
    }
  };
}

module.exports = {
  buildHistoryContext,
  dateKey,
  getNextSteps,
  normalizeTracking,
  selectPreviousDailyReports
};
