const test = require('node:test');
const assert = require('node:assert/strict');
const { filterGithubRecords, finalizeGithubReport } = require('../lib/github-report');
const github = filterGithubRecords([], [
  {number:5,title:'홈페이지 오류 대응',state:'open',labels:['report:include']},
  {number:6,title:'신청 중복 방지',state:'open',labels:['report:include']},
  {number:7,title:'개인 점심 메뉴',state:'open',labels:['report:exclude']}
]);
test('AI가 이슈 하나를 누락해도 승인 이슈 모두 반영하고 표시 명칭 변경', () => {
  const result = finalizeGithubReport({tasks:'GitHub issue #5 - 홈페이지 오류 대응',results:'없음',issues:'특이사항 없음',actionGuide:{nextSteps:'[GitHub/Notion] 검증'}},github);
  assert.match(result.tasks,/이슈로그 #5/);
  assert.match(result.issues,/#6.*신청 중복 방지/);
  assert.ok(!JSON.stringify(result).includes('GitHub'));
  assert.ok(!JSON.stringify(result).includes('개인 점심'));
  assert.equal(result.actionGuide.nextSteps,'[이슈로그/Notion] 검증');
  assert.deepEqual(finalizeGithubReport(result,github),result);
});
test('단순 번호 언급만으로 반영 완료로 처리하지 않으며 종료는 완료로 단정하지 않음', () => {
  const result = finalizeGithubReport({tasks:'GitHub issue #5 확인',results:'없음',issues:'없음'}, {reportIssues:[{number:5,title:'원인 검증',state:'closed'}]});
  assert.match(result.results,/이슈로그 #5 · 등록 상태: 종료.*원인 검증/);
});
test('제외 이슈는 필수 반영 목록에도 들어가지 않는다', () => {
  assert.deepEqual(github.reportIssues.map(issue=>issue.number),[5,6]);
});
