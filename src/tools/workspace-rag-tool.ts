import type { AgentTool } from '../tool-registry.js'
import {
  getWorkspaceRagService,
  type RagQueryResult,
} from '../rag/workspace-rag.js'

interface WorkspaceRagInput {
  query: string
}

/** 仅对明确要求参考工作区、文档或知识库的消息启用 RAG，避免无关查询产生 embedding 成本。 */
export function extractWorkspaceRagQuery(message: string): WorkspaceRagInput | null {
  const patterns = [
    /(?:根据|查询|搜索|检索|参考)(?:当前)?(?:工作区(?:资料|文档)?|知识库|本地文档|项目文档|资料)[，,:：\s]*(.+)/i,
    /(?:工作区|知识库|本地文档|项目文档|资料)(?:里|中|内)?(?:有没有|是否|关于|提到|怎么说)[，,:：\s]*(.+)/i,
    /(?:ask|search|query)\s+(?:the\s+)?(?:workspace|knowledge\s*base|documents?)[:：\s]+(.+)/i,
  ]
  for (const pattern of patterns) {
    const match = message.match(pattern)
    const query = (match?.[1] || message).trim().replace(/[？?！!。.]+$/g, '')
    if (match && query.length >= 2) return { query }
  }
  return null
}

export function createWorkspaceRagTool(
  getWorkspacePath: () => string,
): AgentTool<WorkspaceRagInput, RagQueryResult> {
  return {
    name: 'workspace_rag_search',
    description: '检索当前工作区知识库并返回带来源的相关文档片段',
    riskLevel: 'low',
    timeoutMs: 120_000,
    match: extractWorkspaceRagQuery,
    execute(input) {
      return getWorkspaceRagService(getWorkspacePath()).query(input.query)
    },
    toPrompt(output) {
      if (!output.sources.length) return '工作区知识库没有检索到相关内容。'
      const sources = output.sources
        .map(
          (source, index) =>
            `#### [${index + 1}] ${source.path}\n相关度：${source.score.toFixed(4)}\n${source.content}`,
        )
        .join('\n\n')
      return [
        `知识库工作区：${output.workspacePath}`,
        `已索引文件数：${output.indexedFiles}`,
        '回答时只依据以下片段，并在相关陈述后使用 `[来源: 文件路径]` 标注出处。',
        sources,
      ].join('\n\n')
    },
  }
}
