// 샘플 데이터만 OpenAI에 보내는 통합 점검입니다. Slack 게시와 이력 저장은 하지 않습니다.
const assert = require('node:assert/strict');
const { generateReportWithGPT } = require('../server');
const { buildHistoryContext } = require('../lib/report-history');

async function main() {
  const history = [
    { ranAt: '2026-09-03T09:00:00Z', report: { issues: '[Notion] 야간 배치 메모리 3배 증가, 원인 미확인', actionGuide: { nextSteps: '[Notion] 로그 파싱 전후 두 지점에 메모리 측정을 추가하고 결과 비교' } } },
    { ranAt: '2026-09-02T09:00:00Z', report: { issues: '[Notion] 야간 배치 메모리 3배 증가, 미해결', nextPlans: '[Notion] 메모리 원인 조사' } }
  ];
  const context = buildHistoryContext(history, '2026-09-04T09:00:00Z');
  const empty = { count: 0, text: '오늘 기록 없음' };
  const notion = {
    count: 1,
    text: '[2026-09-04 업무] 야간 배치의 메모리 3배 증가 현상은 오늘도 미해결이다. 어제 계획한 로그 파싱 전후 메모리 측정 중 파싱 전 측정 코드만 추가했다. 파싱 후 측정과 결과 비교는 아직 진행하지 못했다.'
  };
  const report = await generateReportWithGPT(empty, notion, empty, 'detailed', context);
  assert.ok(report.tracking.repeatIssues.some(item => item.consecutiveDays === 3), '3일째 반복 이슈가 탐지되어야 합니다.');
  assert.ok(report.tracking.previousPlanProgress.comparisons.some(item => item.status === 'partial'), '전일 계획의 부분 진행이 탐지되어야 합니다.');
  console.log(JSON.stringify(report.tracking, null, 2));
  console.log('실제 AI 샘플 점검 통과 (Slack 게시 없음, 이력 저장 없음)');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
