const test = require('node:test');
const assert = require('node:assert/strict');
const { generateReportWithGPT } = require('../server');
const { buildHistoryContext } = require('../lib/report-history');

test('보고서 생성 요청에 이력을 포함하고 분석 결과를 계산·보존한다', async () => {
  const context = buildHistoryContext([
    { ranAt: '2026-09-03T09:00:00Z', report: { issues: '[Notion] 배치 메모리 증가', actionGuide: { nextSteps: '[Notion] 로그 파싱 구간 메모리 측정' } } },
    { ranAt: '2026-09-02T09:00:00Z', report: { issues: '[Notion] 배치 메모리 증가', nextPlans: '원인 확인' } }
  ], '2026-09-04T09:00:00Z');
  const fakeReport = {
    tasks: '[Notion] 메모리 측정 코드 일부 추가',
    results: '[Notion] 로그 파싱 전 측정 완료',
    issues: '[Notion] 배치 메모리 증가 원인 미확인',
    actionGuide: {
      topPriority: { source: 'Notion', level: '우선순위 높음', summary: '측정 완료', evidence: '일부 구간만 측정됨' },
      hiddenRisks: { source: 'Notion', type: '운영 리스크', summary: '배치 지연 가능성', evidence: '메모리 증가' },
      nextSteps: [{ source: 'Notion', target: 'topPriority', action: '로그 파싱 후 측정 추가' }]
    },
    tracking: {
      repeatIssues: [{ issue: '배치 메모리 증가', consecutiveDays: 3, source: 'Notion' }],
      previousPlanProgress: { summary: '측정 작업 일부 진행', comparisons: [{ plan: '[Notion] 로그 파싱 구간 메모리 측정', status: 'partial', evidence: '[Notion] 로그 파싱 전 측정 완료' }] }
    }
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.match(body.messages[1].content, /2026-09-03 보고서/);
    assert.match(body.messages[0].content, /uncertain/);
    assert.ok(body.response_format.json_schema.schema.required.includes('tracking'));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(fakeReport) } }] }) };
  };
  try {
    const empty = { count: 0, text: '없음' };
    const report = await generateReportWithGPT(empty, { count: 1, text: '메모리 측정 코드 일부 추가' }, empty, 'detailed', context);
    assert.equal(report.tracking.repeatIssues[0].consecutiveDays, 3);
    assert.equal(report.tracking.previousPlanProgress.rate, 50);
    assert.equal(report.actionGuide.nextSteps, '[Notion] 로그 파싱 후 측정 추가');
  } finally {
    global.fetch = originalFetch;
  }
});
