require('dotenv').config({ path: '.env.local' });
require('dotenv').config({ path: '.env' });

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPO;

function fail(message) {
  console.error(`GitHub 연결 실패: ${message}`);
  process.exitCode = 1;
}

async function githubRequest(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'daily-report-app-connection-check'
    }
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.json()).message || '';
    } catch {
      detail = await response.text();
    }
    throw new Error(`HTTP ${response.status}${detail ? ` · ${detail}` : ''}`);
  }

  return response;
}

async function main() {
  if (!token || /여기에|YOUR_|CHANGE_ME/i.test(token)) {
    return fail('GITHUB_TOKEN이 설정되지 않았습니다. .env 또는 .env.local을 확인하세요.');
  }

  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo) || /owner\/repo/i.test(repo)) {
    return fail('GITHUB_REPO를 owner/repository 형식으로 설정하세요.');
  }

  try {
    const repoResponse = await githubRequest(`/repos/${encodeURIComponent(repo.split('/')[0])}/${encodeURIComponent(repo.split('/')[1])}`);
    const repository = await repoResponse.json();
    await Promise.all([
      githubRequest(`/repos/${repository.full_name}/commits?per_page=1`),
      githubRequest(`/repos/${repository.full_name}/issues?state=all&per_page=1`)
    ]);

    console.log('GitHub 연결 성공');
    console.log(`저장소: ${repository.full_name}`);
    console.log(`공개 범위: ${repository.private ? 'Private' : 'Public'}`);
    console.log('검증 항목: 저장소 / 커밋 / 이슈 읽기');
  } catch (error) {
    fail(`${error.message}\n토큰의 대상 저장소 선택과 Contents·Issues 읽기 권한을 확인하세요.`);
  }
}

main();
