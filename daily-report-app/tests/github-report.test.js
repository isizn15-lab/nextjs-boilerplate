const test = require('node:test');
const assert = require('node:assert/strict');
const { filterGithubRecords, collectGithubWork } = require('../lib/github-report');
const issue = (number, labels, extra = {}) => ({ number, labels, state: 'open', title: `이슈 ${number}`, ...extra });

test('업무 이슈 2개만 포함하고 비업무 이슈 3개를 제거한다', () => {
  const result = filterGithubRecords([], [issue(1, ['report:include']), issue(2, [{ name: 'report:include' }]), issue(3, ['report:exclude']), issue(4, ['report:exclude']), issue(5, ['report:exclude'])]);
  assert.equal(result.count, 2);
  assert.equal(result.filter.excludedIssues, 3);
  for (const n of [3, 4, 5]) assert.ok(!result.text.includes(`이슈 ${n}`));
});
test('제외 라벨 우선, 미분류와 PR 제외, 완료 업무는 포함', () => {
  const result = filterGithubRecords([], [issue(1, ['report:include','report:exclude']), issue(2, []), issue(3, ['report:include'], {pull_request: {}}), issue(4, ['report:include'], {state:'closed'})]);
  assert.equal(result.count, 1);
  assert.match(result.text, /#4 \(closed\)/);
});
test('커밋은 첫 줄의 명시적인 report 표시만 허용한다', () => {
  const result = filterGithubRecords(['[report] 업무 수정', '개인 메모', '다른 작업\n[report] 본문 표시'].map(message => ({commit:{message}})), []);
  assert.equal(result.count, 1);
  assert.equal(result.filter.excludedCommits, 2);
  assert.ok(!result.text.includes('개인 메모'));
});
test('전부 제외되면 count=0이며 제외 내용은 출력하지 않는다', () => {
  const result = filterGithubRecords([], [issue(1, ['report:exclude'], {title:'개인 정보 메모'})]);
  assert.equal(result.count, 0);
  assert.ok(!result.text.includes('개인 정보'));
});
test('페이지 뒤에 있는 포함 이슈까지 수집한다', async () => {
  const result = await collectGithubWork({token:'test',repo:'owner/repo',since:'2026-09-04T00:00:00Z',fetchImpl:async url=>({ok:true,json:async()=>url.includes('/commits')?[]:new URL(url).searchParams.get('page')==='1'?Array.from({length:100},(_,i)=>issue(i,[])):[issue(101,['report:include'])]})});
  assert.equal(result.count, 1);
  assert.match(result.text, /#101/);
});
