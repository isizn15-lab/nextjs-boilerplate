const INCLUDE_LABEL = 'report:include';
const EXCLUDE_LABEL = 'report:exclude';

function filterGithubRecords(commits, issues) {
  const selectedIssues = issues.filter(issue => {
    if (issue.pull_request) return false;
    const labels = (issue.labels || []).map(label => String(typeof label === 'string' ? label : label.name).toLowerCase());
    return labels.includes(INCLUDE_LABEL) && !labels.includes(EXCLUDE_LABEL);
  });
  const selectedCommits = commits.filter(commit => /^\[report\]\s+/i.test(commit.commit?.message || ''));
  const lines = [
    ...selectedCommits.map(commit => `- commit: ${commit.commit.message.split('\n')[0]}`),
    ...selectedIssues.map(issue => `- issue #${issue.number} (${issue.state}): ${issue.title}`)
  ];
  return {
    text: lines.length ? lines.join('\n') : '오늘 보고서 대상 GitHub 업무 기록이 없습니다. (report:include 이슈 / [report] 커밋만 반영)',
    count: selectedCommits.length + selectedIssues.length,
    reportIssues: selectedIssues.map(issue => ({ number: issue.number, title: issue.title, state: issue.state })),
    filter: {
      mode: 'explicit-work-only',
      includedIssues: selectedIssues.length,
      excludedIssues: issues.filter(issue => !issue.pull_request).length - selectedIssues.length,
      includedCommits: selectedCommits.length,
      excludedCommits: commits.length - selectedCommits.length
    }
  };
}

async function collectGithubWork({ token, repo, since, fetchImpl = fetch }) {
  if (!token || !repo) return { text: '(GitHub 미설정)', count: 0 };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { text: '(GitHub 저장소 설정 오류)', count: 0 };
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function readPages(kind) {
    const records = [];
    // 끝까지 조회하지 못하면 부분 결과로 보고서를 만들지 않습니다.
    for (let page = 1; page <= 20; page++) {
      const url = new URL(`https://api.github.com/repos/${repo}/${kind}`);
      url.searchParams.set('since', since);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      if (kind === 'issues') url.searchParams.set('state', 'all');
      const response = await fetchImpl(url.toString(), { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`${kind} HTTP ${response.status}`);
      const items = await response.json();
      if (!Array.isArray(items)) throw new Error(`${kind} 응답 형식 오류`);
      records.push(...items);
      if (items.length < 100) return records;
    }
    throw new Error(`${kind} 조회 한도 초과`);
  }
  try {
    const [commits, issues] = await Promise.all([readPages('commits'), readPages('issues')]);
    return filterGithubRecords(commits, issues);
  } catch (error) {
    console.error('[GitHub 업무 수집 실패]', error.message);
    return { text: '(GitHub 조회 실패)', count: 0 };
  }
}

function finalizeGithubReport(report, github) {
  // 표시 명칭만 변경합니다. 저장소·수집 출처 식별자는 변경하지 않습니다.
  function rename(value) {
    if (typeof value === 'string') return value
      .replace(/\bGitHub\s+issue\b/gi, '이슈로그')
      .replace(/\[[^\]\n]*GitHub[^\]\n]*\]/gi, tag => tag.replace(/GitHub/gi, '이슈로그'));
    if (Array.isArray(value)) return value.map(rename);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rename(item)]));
    return value;
  }
  const result = rename(report);
  for (const issue of github.reportIssues || []) {
    const number = Number(issue.number);
    if (!Number.isSafeInteger(number) || number < 1 || !issue.title) continue;
    const title = String(issue.title).replace(/[\r\n]+/g, ' ').trim();
    const displayTitle = rename(title);
    const reference = new RegExp(`#${number}(?!\\d)`);
    const covered = ['tasks', 'results', 'issues'].some(key =>
      String(result[key] || '').split('\n').some(line => reference.test(line) && line.includes(displayTitle)));
    if (covered) continue;
    const key = issue.state === 'closed' ? 'results' : 'issues';
    const existing = String(result[key] || '').trim();
    const empty = /^(특이사항 없음|확인된 내용 없음|없음)[.!]?$/.test(existing);
    const line = `[이슈로그 #${number} · 등록 상태: ${issue.state === 'closed' ? '종료' : '열림'}] ${displayTitle}`;
    result[key] = [empty ? '' : existing, line].filter(Boolean).join('\n');
  }
  return result;
}

module.exports = { collectGithubWork, filterGithubRecords, finalizeGithubReport, INCLUDE_LABEL, EXCLUDE_LABEL };
