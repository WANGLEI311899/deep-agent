import fs from 'fs/promises'
import path from 'path'
import OpenAI from 'openai'
import type { RagQueryResult, WorkspaceRagService } from './workspace-rag.js'

export interface RagEvaluationCase {
  id?: string
  query: string
  expectedSources: string[]
  expectedAnswerKeywords?: string[]
}

export interface RetrievalMetrics {
  hitRate: number
  reciprocalRank: number
  precisionAtK: number
  recallAtK: number
}

export interface LlmQualityScores {
  relevance: number
  faithfulness: number
  citationQuality: number
  reason: string
}

export interface RagEvaluationItem extends RetrievalMetrics {
  id: string
  query: string
  expectedSources: string[]
  retrievedSources: string[]
  answer?: string
  keywordCoverage?: number
  llmScores?: LlmQualityScores
  error?: string
}

export interface RagEvaluationReport {
  generatedAt: string
  workspacePath: string
  caseCount: number
  passedCases: number
  aggregate: RetrievalMetrics & {
    keywordCoverage?: number
    relevance?: number
    faithfulness?: number
    citationQuality?: number
  }
  items: RagEvaluationItem[]
}

function normalizeSource(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

function sourceMatches(retrieved: string, expected: string): boolean {
  const actual = normalizeSource(retrieved)
  const wanted = normalizeSource(expected)
  return actual === wanted || actual.endsWith(`/${wanted}`)
}

/** 纯函数指标便于在 CI 中稳定回归，不依赖 LLM 的随机评分。 */
export function calculateRetrievalMetrics(
  retrievedSources: string[],
  expectedSources: string[],
): RetrievalMetrics {
  if (!expectedSources.length) {
    return { hitRate: 0, reciprocalRank: 0, precisionAtK: 0, recallAtK: 0 }
  }
  const relevantRanks = retrievedSources
    .map((source, index) =>
      expectedSources.some((expected) => sourceMatches(source, expected))
        ? index + 1
        : 0,
    )
    .filter(Boolean)
  const matchedExpected = expectedSources.filter((expected) =>
    retrievedSources.some((source) => sourceMatches(source, expected)),
  )
  return {
    hitRate: relevantRanks.length ? 1 : 0,
    reciprocalRank: relevantRanks.length ? 1 / Math.min(...relevantRanks) : 0,
    precisionAtK: retrievedSources.length
      ? relevantRanks.length / retrievedSources.length
      : 0,
    recallAtK: matchedExpected.length / expectedSources.length,
  }
}

function average(values: number[]): number | undefined {
  if (!values.length) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function keywordCoverage(answer: string, keywords: string[] | undefined): number | undefined {
  if (!keywords?.length) return undefined
  const normalized = answer.toLowerCase()
  return keywords.filter((keyword) => normalized.includes(keyword.toLowerCase())).length / keywords.length
}

class OptionalRagLlmEvaluator {
  private readonly client: OpenAI
  private readonly model: string

  constructor() {
    this.model = process.env.RAG_EVAL_MODEL?.trim() || process.env.DEEPSEEK_MODEL || 'deepseek-chat'
    this.client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      timeout: 90_000,
      maxRetries: 2,
    })
  }

  async generateAndJudge(query: string, result: RagQueryResult): Promise<{
    answer: string
    scores: LlmQualityScores
  }> {
    const context = result.sources
      .map((source, index) => `[${index + 1}] ${source.path}\n${source.content}`)
      .join('\n\n')
    const generated = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: '你是严格的 RAG 回答器。只能依据给定资料回答；每个关键结论都用 [来源: 文件路径] 标注。资料不足时明确说明。',
        },
        { role: 'user', content: `问题：${query}\n\n资料：\n${context}` },
      ],
    })
    const answer = generated.choices[0]?.message.content?.trim() || ''
    const judged = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: '你是 RAG 评测器。输出 JSON：relevance、faithfulness、citationQuality 均为 0 到 1；reason 为简短中文说明。faithfulness 只判断回答是否被资料支持。',
        },
        {
          role: 'user',
          content: `问题：${query}\n\n资料：\n${context}\n\n回答：\n${answer}`,
        },
      ],
    })
    const raw = JSON.parse(judged.choices[0]?.message.content || '{}') as Partial<LlmQualityScores>
    const bounded = (value: unknown) => Math.max(0, Math.min(1, Number(value) || 0))
    return {
      answer,
      scores: {
        relevance: bounded(raw.relevance),
        faithfulness: bounded(raw.faithfulness),
        citationQuality: bounded(raw.citationQuality),
        reason: String(raw.reason || ''),
      },
    }
  }
}

/**
 * 执行一组 RAG 回归用例。默认只测检索；开启 RAG_EVAL_LLM_ENABLED 后再产生答案并做 LLM 评分。
 */
export async function evaluateRag(
  service: WorkspaceRagService,
  workspacePath: string,
  cases: RagEvaluationCase[],
): Promise<RagEvaluationReport> {
  const useLlm = ['1', 'true', 'yes', 'on'].includes(
    (process.env.RAG_EVAL_LLM_ENABLED || '').toLowerCase(),
  )
  const llmEvaluator = useLlm ? new OptionalRagLlmEvaluator() : null
  const items: RagEvaluationItem[] = []

  for (const [index, testCase] of cases.entries()) {
    try {
      const result = await service.query(testCase.query)
      const retrievedSources = result.sources.map((source) => source.path)
      const item: RagEvaluationItem = {
        id: testCase.id || `case-${index + 1}`,
        query: testCase.query,
        expectedSources: testCase.expectedSources,
        retrievedSources,
        ...calculateRetrievalMetrics(retrievedSources, testCase.expectedSources),
      }
      if (llmEvaluator) {
        const evaluated = await llmEvaluator.generateAndJudge(testCase.query, result)
        item.answer = evaluated.answer
        item.keywordCoverage = keywordCoverage(evaluated.answer, testCase.expectedAnswerKeywords)
        item.llmScores = evaluated.scores
      }
      items.push(item)
    } catch (error) {
      items.push({
        id: testCase.id || `case-${index + 1}`,
        query: testCase.query,
        expectedSources: testCase.expectedSources,
        retrievedSources: [],
        hitRate: 0,
        reciprocalRank: 0,
        precisionAtK: 0,
        recallAtK: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const requiredAverage = (key: keyof RetrievalMetrics) =>
    average(items.map((item) => item[key])) ?? 0
  return {
    generatedAt: new Date().toISOString(),
    workspacePath: path.resolve(workspacePath),
    caseCount: items.length,
    passedCases: items.filter((item) => item.hitRate > 0 && !item.error).length,
    aggregate: {
      hitRate: requiredAverage('hitRate'),
      reciprocalRank: requiredAverage('reciprocalRank'),
      precisionAtK: requiredAverage('precisionAtK'),
      recallAtK: requiredAverage('recallAtK'),
      keywordCoverage: average(items.flatMap((item) => item.keywordCoverage === undefined ? [] : [item.keywordCoverage])),
      relevance: average(items.flatMap((item) => item.llmScores ? [item.llmScores.relevance] : [])),
      faithfulness: average(items.flatMap((item) => item.llmScores ? [item.llmScores.faithfulness] : [])),
      citationQuality: average(items.flatMap((item) => item.llmScores ? [item.llmScores.citationQuality] : [])),
    },
    items,
  }
}

export async function loadEvaluationCases(filePath: string): Promise<RagEvaluationCase[]> {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('RAG 评测集必须是 JSON 数组。')
  const cases = parsed.filter(
    (item): item is RagEvaluationCase =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as RagEvaluationCase).query === 'string' &&
      Array.isArray((item as RagEvaluationCase).expectedSources),
  )
  if (!cases.length) throw new Error('RAG 评测集没有有效用例。')
  return cases
}

export async function writeEvaluationReport(
  report: RagEvaluationReport,
  outputDir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await fs.mkdir(outputDir, { recursive: true })
  const stamp = report.generatedAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const jsonPath = path.join(outputDir, `rag-eval-${stamp}.json`)
  const markdownPath = path.join(outputDir, `rag-eval-${stamp}.md`)
  const percent = (value: number | undefined) =>
    value === undefined ? '未启用' : `${(value * 100).toFixed(1)}%`
  const rows = report.items.map((item) =>
    `| ${item.id} | ${item.hitRate ? '通过' : '未通过'} | ${percent(item.reciprocalRank)} | ${percent(item.recallAtK)} | ${item.error || item.retrievedSources.join('<br>')} |`,
  )
  const markdown = `# RAG 质量评测报告

- 生成时间：${report.generatedAt}
- 工作区：${report.workspacePath}
- 用例：${report.passedCases}/${report.caseCount} 命中
- Hit Rate：${percent(report.aggregate.hitRate)}
- MRR：${percent(report.aggregate.reciprocalRank)}
- Precision@K：${percent(report.aggregate.precisionAtK)}
- Recall@K：${percent(report.aggregate.recallAtK)}
- 答案关键词覆盖：${percent(report.aggregate.keywordCoverage)}
- 回答相关性：${percent(report.aggregate.relevance)}
- 忠实度：${percent(report.aggregate.faithfulness)}
- 引用质量：${percent(report.aggregate.citationQuality)}

| 用例 | 结果 | MRR | Recall@K | 检索来源 / 错误 |
| --- | --- | ---: | ---: | --- |
${rows.join('\n')}
`
  await Promise.all([
    fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8'),
    fs.writeFile(markdownPath, markdown, 'utf8'),
  ])
  return { jsonPath, markdownPath }
}

