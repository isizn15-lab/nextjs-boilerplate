require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildHistoryContext, normalizeTracking } = require('./lib/report-history');
const { collectGithubWork, finalizeGithubReport } = require('./lib/github-report');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = IS_VERCEL ? path.join(os.tmpdir(), 'daily-report-app') : path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LEGACY_LAST_FILE = path.join(__dirname, 'data', 'last-report.json');
const LEGACY_HISTORY_FILE = path.join(__dirname, 'data', 'history.json');
const HISTORY_LIMIT = 30;
const DISPLAY_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Seoul';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function startOfTodayISO() {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  // Asia/Seoul is UTC+9 with no daylight-saving time.
  if (DISPLAY_TIMEZONE === 'Asia/Seoul') return new Date(`${date}T00:00:00+09:00`).toISOString();

  const localMidnight = new Date(`${date}T00:00:00`);
  return localMidnight.toISOString();
}

function readLocalState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch {
      return { last: null, history: [] };
    }
  }

  // 기존 버전의 JSON 파일을 한 번만 호환해서 읽습니다.
  let last = null;
  let history = [];
  try {
    if (fs.existsSync(LEGACY_LAST_FILE)) last = JSON.parse(fs.readFileSync(LEGACY_LAST_FILE, 'utf-8'));
    if (fs.existsSync(LEGACY_HISTORY_FILE)) history = JSON.parse(fs.readFileSync(LEGACY_HISTORY_FILE, 'utf-8'));
  } catch {
    // 손상된 기존 파일은 빈 상태로 시작합니다.
  }
  return { last, history: Array.isArray(history) ? history : [] };
}

async function readBlobState() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { get } = await import('@vercel/blob');
    const result = await get('daily-report/state.json', { access: 'private' });
    if (!result || result.statusCode !== 200) return null;
    return JSON.parse(await new Response(result.stream).text());
  } catch (err) {
    console.warn('[Blob 읽기 실패]', err.message);
    return null;
  }
}

async function loadState() {
  if (IS_VERCEL && process.env.BLOB_READ_WRITE_TOKEN) {
    return (await readBlobState()) || { last: null, history: [] };
  }
  return readLocalState();
}

async function saveState(state) {
  const normalized = {
    last: state.last || null,
    history: Array.isArray(state.history) ? state.history.slice(0, HISTORY_LIMIT) : []
  };

  if (IS_VERCEL && process.env.BLOB_READ_WRITE_TOKEN) {
    const { put } = await import('@vercel/blob');
    await put('daily-report/state.json', JSON.stringify(normalized), {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/json'
    });
    return;
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(normalized, null, 2));
}

// ---------- 수집 함수 (서버에 저장된 토큰 사용) ----------

async function collectGithub() {
  return collectGithubWork({ token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPO, since: startOfTodayISO() });
}

async function collectNotion() {
  const token = process.env.NOTION_TOKEN;
  if (!token) return { text: '(Notion 미설정)', count: 0 };

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };

  const response = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 50
    })
  });

  if (!response.ok) {
    console.error('[Notion 실패] status:', response.status);
    console.error('[Notion 실패] body:', await response.text());
    return { text: '(Notion 조회 실패)', count: 0 };
  }

  const data = await response.json();
  const todayStart = new Date(startOfTodayISO());

  const pages = (data.results || [])
    .filter(page => page.object === 'page' && new Date(page.last_edited_time) >= todayStart);

  const items = [];
  for (const page of pages) {
    const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
    const title = titleProp?.title?.map(t => t.plain_text).join('') || '(제목 없음)';
    const propertyText = extractNotionPropertyText(page.properties || {});
    let bodyText = '';

    try {
      bodyText = await fetchNotionBlockText(page.id, headers);
    } catch (err) {
      console.warn(`[Notion 본문 조회 실패] page: ${page.id}, error: ${err.message}`);
    }

    const details = [propertyText, bodyText].filter(Boolean).join('\n').slice(0, 3000);
    const editedTime = new Intl.DateTimeFormat('ko-KR', {
      timeZone: DISPLAY_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(page.last_edited_time));
    items.push(`- ${title} (수정: ${editedTime})${details ? `\n  내용: ${details.replace(/\n/g, '\n  ')}` : ''}`);
  }

  return {
    text: items.length ? items.join('\n') : '오늘 수정된 Notion 문서가 없습니다.',
    count: items.length
  };
}

function plainText(richText) {
  return Array.isArray(richText) ? richText.map(item => item.plain_text || '').join('').trim() : '';
}

function extractNotionPropertyText(properties) {
  const values = [];

  for (const [name, property] of Object.entries(properties)) {
    if (!property || property.type === 'title') continue;
    let value = '';

    if (property.type === 'rich_text') value = plainText(property.rich_text);
    else if (property.type === 'select' || property.type === 'status') value = property[property.type]?.name || '';
    else if (property.type === 'multi_select') value = (property.multi_select || []).map(item => item.name).join(', ');
    else if (property.type === 'date') value = property.date?.start || '';
    else if (property.type === 'number' && property.number !== null) value = String(property.number);
    else if (property.type === 'checkbox') value = property.checkbox ? '예' : '아니오';
    else if (property.type === 'url' || property.type === 'email' || property.type === 'phone_number') value = property[property.type] || '';

    if (value) values.push(`${name}: ${value}`);
  }

  return values.join('\n');
}

function extractNotionBlockText(block) {
  const value = block?.[block.type] || {};
  if (Array.isArray(value.rich_text)) return plainText(value.rich_text);
  if (block.type === 'child_page' || block.type === 'child_database') return value.title || '';
  if (block.type === 'table_row') {
    return (value.cells || []).map(cell => plainText(cell)).filter(Boolean).join(' | ');
  }
  return '';
}

async function fetchNotionBlockText(blockId, headers, depth = 0, remaining = { chars: 3000 }) {
  if (depth > 2 || remaining.chars <= 0) return '';

  const lines = [];
  let cursor = null;
  let pageCount = 0;

  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (cursor) query.set('start_cursor', cursor);
    const response = await fetch(`https://api.notion.com/v1/blocks/${blockId}/children?${query}`, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    for (const block of data.results || []) {
      const text = extractNotionBlockText(block);
      if (text) {
        const clipped = text.slice(0, remaining.chars);
        lines.push(clipped);
        remaining.chars -= clipped.length;
      }
      if (block.has_children && remaining.chars > 0) {
        const childText = await fetchNotionBlockText(block.id, headers, depth + 1, remaining);
        if (childText) lines.push(childText);
      }
      if (remaining.chars <= 0) break;
    }

    cursor = data.has_more ? data.next_cursor : null;
    pageCount++;
  } while (cursor && pageCount < 3 && remaining.chars > 0);

  return lines.join('\n');
}

async function collectSlack() {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;
  if (!token || !channel) return { text: '(Slack 미설정)', count: 0 };

  const oldest = (new Date(startOfTodayISO()).getTime() / 1000).toString();
  const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&oldest=${oldest}&limit=50`;

  const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const data = await response.json();
  if (!data.ok) {
    console.error('[Slack 실패] error:', data.error);
    return { text: '(Slack 조회 실패)', count: 0 };
  }

  const messages = (data.messages || [])
    .filter(m => m.type === 'message' && m.text)
    .reverse()
    .map(m => `- ${m.text}`);

  return {
    text: messages.length ? messages.join('\n') : '오늘 채널 메시지가 없습니다.',
    count: messages.length
  };
}

// ---------- GPT로 보고서 생성 ----------

async function generateReportWithGPT(github, notion, slack, reportType, historyContext) {
  const detailLevel = reportType === 'summary'
    ? '팀장/관리자가 보는 요약 보고서입니다. 각 항목을 1~2문장으로 간결하게, 진행 상황과 임팩트 중심으로 작성하세요.'
    : '실무자가 보는 상세 보고서입니다. 각 항목을 구체적인 작업 단위로 세분화하고, 관련 파일/기능/이슈 번호가 있다면 포함하세요.';

  const systemPrompt = `당신은 AI 솔루션 개발기업의 일일 업무 보고서를 작성하는 어시스턴트입니다.
GitHub, Notion, Slack에서 자동 수집된 원시 기록을 분석해 "수행 업무", "주요 결과", "이슈 및 문제점", "실행 제안" 네 가지 항목으로 분류·요약합니다.
${detailLevel}
출처별 필수 반영 규칙:
- count가 1 이상인 모든 출처는 해당 출처의 구체적인 사실을 최종 보고서 전체에서 최소 1개 이상 반드시 반영하세요.
- 각 줄의 맨 앞에 [GitHub], [Notion], [Slack] 중 근거가 된 출처 태그를 붙이세요.
- 같은 사실이 여러 출처에 있으면 [Notion/Slack]처럼 함께 표기하세요.
- 제목뿐 아니라 Notion의 "내용"도 우선적으로 검토하고, 다른 출처에 없는 Notion 고유 기록을 누락하지 마세요.
- 업무와 직접 관련이 없어 보이는 기록도 삭제하지 말고 [Notion] 확인 기록으로 간단히 남기세요.
실행 제안 작성 규칙:
- topPriority는 AI가 지금 가장 먼저 처리해야 할 행동 하나만 선정해 정확히 3줄로 쓰세요: [출처 · 우선순위 높음/보통], 한 줄 행동, 근거: 구체적인 수치나 상태.
- hiddenRisks는 현재 드러난 장애의 반복이 아니라 놓치기 쉬운 위험 하나만 선정해 정확히 3줄로 쓰세요: [출처 · 품질/운영/일정/의존성 리스크], 한 줄 위험, 근거: 관찰된 사실과 그 사실에서 추론한 가능성.
- topPriority와 hiddenRisks의 한 줄 결론은 짧고 단정하게 쓰되, 위험을 확정 사실처럼 과장하지 마세요.
- nextSteps에는 일반적인 향후 계획을 옮겨 적지 말고, topPriority를 해결하거나 hiddenRisks를 낮추기 위해 지금 바로 할 행동 하나만 작성하세요.
- nextSteps의 행동은 담당자가 바로 실행할 수 있을 정도로 구체화하세요.
- 사실과 제안을 구분하고, 근거 없는 위험이나 확정되지 않은 사실을 만들지 마세요.
- 제안할 근거가 없으면 해당 값에 "확인된 내용 없음"이라고 쓰세요.
이력 분석 규칙:
- 이전 보고서는 날짜별 최신 성공 기록만 제공되며 최신순입니다. 같은 날의 재실행을 여러 날로 계산하지 마세요.
- repeatIssues에는 오늘도 미해결 상태인 동일·유사 이슈가 직전 보고서부터 연속으로 언급된 경우만 넣으세요. 오늘을 1일로 포함하고, 중간 보고서에서 사라지거나 해결됐으면 연속 계산을 멈추세요. 2일 이상인 항목만 최대 5개 작성합니다.
- 단순히 같은 주제라는 이유로 다른 문제를 묶지 말고, 완료·해결됐다는 근거가 있는 이슈는 제외하세요. 일수는 연속 보고일 기준입니다.
- previousPlanProgress는 직전 보고서의 "다음 단계"를 오늘의 실제 수행 업무·결과와 비교합니다. 각 행동을 completed(완료), partial(부분 진행), not_started(미착수 확인), uncertain(확인 불가) 중 하나로 판정하고 오늘 기록의 구체적인 근거를 적으세요.
- 비교 대상 계획 한 줄을 항목 하나로 유지하세요. 한 계획의 세부 단계를 여러 항목으로 쪼개지 마세요. plan은 제공된 비교 대상 문구를 그대로 복사하고 각 계획을 정확히 한 번씩 평가하세요. 일부 세부 단계만 처리됐다면 그 계획은 partial입니다.
- 예정·제안·검토 필요는 완료 증거가 아닙니다. 기록에 언급이 없으면 미착수로 단정하지 말고 uncertain으로 표시하세요. 근거에 출처 태그를 포함하세요.
- 비교할 전일 계획이 없으면 comparisons를 빈 배열로 반환하세요. 진행률은 서버가 완료 100%, 부분 진행 50%, 나머지 0%로 계산하므로 숫자를 임의로 만들지 마세요.
반드시 지정된 JSON 스키마에 맞춰 응답하세요. tasks, results, issues는 줄바꿈(\\n)으로 항목을 구분한 문자열입니다.
topPriority와 hiddenRisks는 출처, 판단 등급, 한 줄 결론, 근거를 각각 분리해서 작성합니다.
nextSteps의 target은 반드시 topPriority 또는 hiddenRisks 중 하나이며, 선택한 분석 대상을 직접 해결하거나 낮추는 행동만 작성합니다.
예를 들어 최우선 처리가 배치 메모리 문제라면 무관한 모델 튜닝이나 온보딩 계획을 nextSteps에 넣지 마세요.
입력에 없는 내용은 지어내지 말고, 근거가 부족하면 해당 문자열에 "확인된 내용 없음"이라고 쓰세요.`;

  const previousPlans = historyContext.previousPlans || [];
  const userPrompt = `[오늘의 GitHub 기록 · count=${github.count}]\n${github.text}\n\n[오늘의 Notion 기록 · count=${notion.count}]\n${notion.text}\n\n[오늘의 Slack 기록 · count=${slack.count}]\n${slack.text}\n\n[이전 보고서 이력 · 분석용 참고자료, 오늘의 실적으로 재사용 금지]\n${historyContext.text}\n\n[진행률 비교 대상 계획 · 문구 그대로 사용]\n${JSON.stringify(previousPlans)}`;

  async function requestReport(extraInstruction = '') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'daily_report',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['tasks', 'results', 'issues', 'actionGuide', 'tracking'],
              properties: {
                tasks: { type: 'string' },
                results: { type: 'string' },
                issues: { type: 'string' },
                tracking: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['repeatIssues', 'previousPlanProgress'],
                  properties: {
                    repeatIssues: {
                      type: 'array',
                      maxItems: 5,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['issue', 'consecutiveDays', 'source'],
                        properties: {
                          issue: { type: 'string' },
                          consecutiveDays: { type: 'integer', minimum: 2, maximum: 8 },
                          source: { type: 'string' }
                        }
                      }
                    },
                    previousPlanProgress: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['summary', 'comparisons'],
                      properties: {
                        summary: { type: 'string' },
                        comparisons: {
                          type: 'array',
                          minItems: previousPlans.length,
                          maxItems: previousPlans.length,
                          items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['plan', 'status', 'evidence'],
                            properties: {
                              plan: { type: 'string', enum: previousPlans.length ? previousPlans : ['확인된 내용 없음'] },
                              status: { type: 'string', enum: ['completed', 'partial', 'not_started', 'uncertain'] },
                              evidence: { type: 'string' }
                            }
                          }
                        }
                      }
                    }
                  }
                },
                actionGuide: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['topPriority', 'hiddenRisks', 'nextSteps'],
                  properties: {
                    topPriority: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['source', 'level', 'summary', 'evidence'],
                      properties: {
                        source: { type: 'string' },
                        level: { type: 'string', enum: ['우선순위 높음', '우선순위 보통'] },
                        summary: { type: 'string' },
                        evidence: { type: 'string' }
                      }
                    },
                    hiddenRisks: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['source', 'type', 'summary', 'evidence'],
                      properties: {
                        source: { type: 'string' },
                        type: { type: 'string', enum: ['품질 리스크', '운영 리스크', '일정 리스크', '의존성 리스크'] },
                        summary: { type: 'string' },
                        evidence: { type: 'string' }
                      }
                    },
                    nextSteps: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 1,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['source', 'target', 'action'],
                        properties: {
                          source: { type: 'string' },
                          target: { type: 'string', enum: ['topPriority', 'hiddenRisks'] },
                          action: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `${userPrompt}${extraInstruction}` }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API 오류: ${errText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI 응답에서 내용을 찾을 수 없습니다.');
    return JSON.parse(content);
  }

  let report = await requestReport();
  const requiredSources = [
    ['GitHub', github.count],
    ['Notion', notion.count],
    ['Slack', slack.count]
  ].filter(([, count]) => count > 0).map(([name]) => name);
  const combined = [report.tasks, report.results, report.issues].filter(value => typeof value === 'string').join('\n');
  const missingSources = requiredSources.filter(source => !combined.includes(`[${source}`) && !combined.includes(`/${source}]`));
  const topPriority = report.actionGuide?.topPriority;
  const hiddenRisks = report.actionGuide?.hiddenRisks;
  const nextSteps = report.actionGuide?.nextSteps;
  const missingActionFields = [
    !topPriority?.source || !topPriority?.level || !topPriority?.summary || !topPriority?.evidence ? 'topPriority' : '',
    !hiddenRisks?.source || !hiddenRisks?.type || !hiddenRisks?.summary || !hiddenRisks?.evidence ? 'hiddenRisks' : '',
    !Array.isArray(nextSteps) || !nextSteps.length ? 'nextSteps' : ''
  ].filter(Boolean);

  if (missingSources.length || missingActionFields.length) {
    const reasons = [
      missingSources.length ? `${missingSources.join(', ')} 출처 누락` : '',
      missingActionFields.length ? `actionGuide.${missingActionFields.join(', actionGuide.')} 누락` : ''
    ].filter(Boolean).join(', ');
    report = await requestReport(`\n\n[재작성 지시]\n이전 응답에 ${reasons} 문제가 있습니다. 모든 출처의 고유 사실을 포함하고, nextSteps에는 두 분석 결과에 직접 연결된 행동만 작성해 전체 보고서를 다시 작성하세요.`);
  }

  const rawGuide = report.actionGuide || {};
  const cleanSource = value => String(value || '출처 확인 필요').replace(/[\[\]]/g, '').trim();
  const formatAnalysis = (value, labelKey) => {
    if (typeof value === 'string') return value;
    if (!value) return '확인된 내용 없음';
    return `[${cleanSource(value.source)} · ${value[labelKey]}]\n${value.summary}\n\n근거: ${value.evidence}`;
  };
  const formattedSteps = Array.isArray(rawGuide.nextSteps)
    ? rawGuide.nextSteps.slice(0, 1).map(step => `[${cleanSource(step.source)}] ${step.action}`).join('\n')
    : rawGuide.nextSteps;
  report.actionGuide = {
    topPriority: formatAnalysis(rawGuide.topPriority, 'level'),
    hiddenRisks: formatAnalysis(rawGuide.hiddenRisks, 'type'),
    nextSteps: formattedSteps || report.nextPlans || '확인된 내용 없음'
  };
  report.tracking = normalizeTracking(report.tracking, historyContext);

  return finalizeGithubReport(report, github);
}

// ---------- Slack에 자동 게시 ----------

async function postToSlack(report, dateStr, typeLabel) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;
  if (!token || !channel) return { posted: false, reason: 'Slack 미설정' };

  const actionGuide = report.actionGuide || {
    topPriority: '확인된 내용 없음',
    hiddenRisks: '확인된 내용 없음',
    nextSteps: report.nextPlans || '확인된 내용 없음'
  };
  const tracking = report.tracking || {};
  const progress = tracking.previousPlanProgress;
  const statusLabels = { completed: '완료', partial: '부분 진행', not_started: '미착수', uncertain: '확인 불가' };
  const repeatText = tracking.repeatIssues?.length
    ? tracking.repeatIssues.map(item => `• *${item.consecutiveDays}일째 미해결* [${item.source}] ${item.issue}`).join('\n')
    : '2일 이상 연속된 미해결 이슈 없음';
  const progressText = progress?.hasPreviousPlan
    ? `${progress.rate}% · 비교일 ${progress.previousDate}\n${progress.summary}\n${progress.comparisons.map(item => `• ${statusLabels[item.status]}: ${item.plan}\n  근거: ${item.evidence}`).join('\n')}`
    : '비교할 전일 계획이 없습니다.';

  const text = [
    `*일일 업무 보고서 (${dateStr} · ${typeLabel})*`,
    '',
    `*1. 수행 업무*\n${report.tasks}`,
    `*2. 주요 결과*\n${report.results}`,
    `*3. 이슈 및 문제점*\n${report.issues}`,
    `*반복 이슈 탐지 · 연속 보고일 기준*\n${repeatText}`,
    `*어제 계획 대비 진행률*\n${progressText}`,
    `*4. 실행 제안*`,
    `*최우선 처리 · AI 분석*\n${actionGuide.topPriority}`,
    `*놓치기 쉬운 리스크 · AI 분석*\n${actionGuide.hiddenRisks}`,
    `*다음 단계 제안 · 분석 결과에 따른 실행 순서*\n${actionGuide.nextSteps}`
  ].join('\n\n');

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text })
  });

  const data = await response.json();
  return { posted: data.ok, reason: data.ok ? null : data.error };
}

// ---------- 전체 파이프라인 ----------

async function runDailyReport(trigger = 'schedule') {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] 일일 보고서 자동 실행 시작 (trigger: ${trigger})`);

  try {
    const state = await loadState();
    const historyContext = buildHistoryContext(state.history, startedAt, DISPLAY_TIMEZONE);
    const [github, notion, slack] = await Promise.all([
      collectGithub(), collectNotion(), collectSlack()
    ]);

    const reportType = process.env.REPORT_TYPE || 'detailed';
    const report = await generateReportWithGPT(github, notion, slack, reportType, historyContext);

    const dateStr = new Intl.DateTimeFormat('ko-KR', {
      timeZone: DISPLAY_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date()).replace(/\s/g, '');
    const typeLabel = reportType === 'summary' ? '관리자용 요약' : '실무자용 상세';

    const slackResult = await postToSlack(report, dateStr, typeLabel);

    const entry = {
      ranAt: startedAt,
      trigger,
      dateStr,
      typeLabel,
      sources: { github, notion, slack },
      report,
      slackPosted: slackResult.posted,
      slackError: slackResult.reason
    };

    state.last = entry;
    state.history = [entry, ...(state.history || [])];
    await saveState(state);
    console.log(`[${startedAt}] 완료. Slack 게시: ${slackResult.posted ? '성공' : '실패(' + slackResult.reason + ')'}`);
    return entry;
  } catch (err) {
    const entry = { ranAt: startedAt, trigger, error: err.message };
    try {
      const state = await loadState();
      state.last = entry;
      state.history = [entry, ...(state.history || [])];
      await saveState(state);
    } catch (storageErr) {
      console.error(`[${startedAt}] 저장 실패:`, storageErr.message);
    }
    console.error(`[${startedAt}] 실패:`, err.message);
    return entry;
  }
}

// ---------- 스케줄 등록 ----------
// 기본값: 평일 오후 6시 (서버 시간대 기준). REPORT_SCHEDULE 로 cron 표현식 직접 지정 가능.
const schedule = process.env.REPORT_SCHEDULE || '0 18 * * 1-5';
if (!IS_VERCEL && require.main === module && cron.validate(schedule)) {
  cron.schedule(schedule, () => runDailyReport('schedule'), { timezone: DISPLAY_TIMEZONE });
  console.log(`자동 실행 스케줄 등록됨: "${schedule}"`);
} else if (!IS_VERCEL && require.main === module) {
  console.warn(`REPORT_SCHEDULE 값이 올바른 cron 표현식이 아닙니다: "${schedule}"`);
}

// ---------- API ----------

app.get('/api/last-report', async (req, res) => {
  const state = await loadState();
  res.json(state.last || { empty: true });
});

app.get('/api/history', async (req, res) => {
  const state = await loadState();
  res.json(state.history || []);
});

app.get('/api/schedule', (req, res) => {
  res.json({
    schedule: IS_VERCEL ? '평일 18:00' : schedule,
    timezone: DISPLAY_TIMEZONE,
    storage: IS_VERCEL ? (process.env.BLOB_READ_WRITE_TOKEN ? 'Vercel Blob' : '임시 저장소') : '로컬 JSON'
  });
});

app.post('/api/run-now', async (req, res) => {
  const entry = await runDailyReport('manual');
  res.json(entry);
});

app.get('/api/cron', async (req, res) => {
  if (!process.env.CRON_SECRET || req.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const entry = await runDailyReport('schedule');
  res.json(entry);
});

function startLocalServer(port = Number(PORT)) {
  const server = app.listen(port, () => {
    console.log(`서버 실행 중: http://localhost:${port}`);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && port < Number(PORT) + 10) {
      const nextPort = port + 1;
      console.warn(`${port}번 포트가 사용 중입니다. ${nextPort}번 포트로 다시 시도합니다.`);
      startLocalServer(nextPort);
      return;
    }
    throw err;
  });
}

if (require.main === module) startLocalServer();

module.exports = app;
module.exports.generateReportWithGPT = generateReportWithGPT;
