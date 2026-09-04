const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHistoryContext,
  normalizeTracking,
  selectPreviousDailyReports
} = require('../lib/report-history');

test('같은 날짜의 여러 실행은 최신 보고서 한 건만 비교한다', () => {
  const history = [
    { ranAt: '2026-09-03T12:00:00Z', report: { issues: '최신 이슈', actionGuide: { nextSteps: '최신 계획' } } },
    { ranAt: '2026-09-03T09:00:00Z', report: { issues: '이전 이슈', actionGuide: { nextSteps: '이전 계획' } } },
    { ranAt: '2026-09-02T09:00:00Z', report: { issues: '2일 이슈', nextPlans: '2일 계획' } }
  ];

  const selected = selectPreviousDailyReports(history, '2026-09-04T09:00:00Z');
  assert.equal(selected.length, 2);
  assert.equal(selected[0].report.issues, '최신 이슈');
});

test('직전 보고서의 다음 단계와 날짜를 AI 비교 문맥에 포함한다', () => {
  const context = buildHistoryContext([
    { ranAt: '2026-09-03T09:00:00Z', report: { tasks: '작업', results: '결과', issues: '이슈', actionGuide: { nextSteps: '로그 확인' } } }
  ], '2026-09-04T09:00:00Z');

  assert.equal(context.previousDate, '2026-09-03');
  assert.equal(context.previousPlan, '로그 확인');
  assert.match(context.text, /다음 단계: 로그 확인/);
});

test('완료는 100%, 부분 완료는 50% 가중치로 진행률을 계산한다', () => {
  const tracking = normalizeTracking({
    repeatIssues: [{ issue: '배치 메모리 증가', consecutiveDays: 3, source: 'Notion' }],
    previousPlanProgress: {
      summary: '일부 진행',
      comparisons: [
        { plan: 'A', status: 'completed', evidence: '완료 기록' },
        { plan: 'B', status: 'partial', evidence: '검토 중' }
      ]
    }
  }, { hasPreviousPlan: true, previousDate: '2026-09-03', previousPlan: 'A\nB', previousReportCount: 2 });

  assert.equal(tracking.repeatIssues[0].consecutiveDays, 3);
  assert.equal(tracking.previousPlanProgress.rate, 75);
  assert.equal(tracking.previousPlanProgress.completed, 1);
  assert.equal(tracking.previousPlanProgress.partial, 1);
});

test('이력이 없으면 AI가 반복 이슈나 완료율을 만들어도 표시하지 않는다', () => {
  const context = buildHistoryContext([], '2026-09-04T09:00:00Z');
  const tracking = normalizeTracking({
    repeatIssues: [{ issue: '가짜 반복', consecutiveDays: 9, source: 'Slack' }],
    previousPlanProgress: { comparisons: [{ plan: '가짜 계획', status: 'completed', evidence: '없음' }] }
  }, context);
  assert.deepEqual(tracking.repeatIssues, []);
  assert.equal(tracking.previousPlanProgress.hasPreviousPlan, false);
  assert.equal(tracking.previousPlanProgress.rate, 0);
});

test('현재 날짜 재실행과 미래 기록을 제외하며 근거 없는 진행은 확인 불가 처리한다', () => {
  const context = buildHistoryContext([
    { ranAt: '2026-09-04T08:00:00Z', report: { nextPlans: '오늘 계획' } },
    { ranAt: '2026-09-05T08:00:00Z', report: { nextPlans: '미래 계획' } },
    { ranAt: '2026-09-03T08:00:00Z', report: { nextPlans: '어제 계획' } }
  ], '2026-09-04T09:00:00Z');
  assert.equal(context.previousPlan, '어제 계획');
  const tracking = normalizeTracking({}, context);
  assert.equal(tracking.previousPlanProgress.comparisons[0].status, 'uncertain');
  assert.equal(tracking.previousPlanProgress.rate, 0);
});
