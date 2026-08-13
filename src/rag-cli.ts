import 'dotenv/config'
import path from 'path'
import { WorkspaceStore } from './workspace-store.js'
import { getWorkspaceRagService } from './rag/workspace-rag.js'
import {
  evaluateRag,
  loadEvaluationCases,
  writeEvaluationReport,
} from './rag/evaluation.js'

async function main(): Promise<void> {
  const command = process.argv[2] || 'status'
  const configuredWorkspace = new WorkspaceStore().getActivePath()
  const workspacePath = path.resolve(process.argv[3] || configuredWorkspace)
  const service = getWorkspaceRagService(workspacePath)

  if (command === 'status') {
    console.log(JSON.stringify(await service.status(), null, 2))
    return
  }
  if (command === 'index') {
    const count = await service.rebuild()
    console.log(`RAG 索引完成：${count} 个文件（${workspacePath}）`)
    return
  }
  if (command === 'evaluate') {
    const datasetPath = path.resolve(
      process.argv[4] || path.join(process.cwd(), '.deepcodex/rag-eval.json'),
    )
    const cases = await loadEvaluationCases(datasetPath)
    const report = await evaluateRag(service, workspacePath, cases)
    const files = await writeEvaluationReport(
      report,
      path.join(process.cwd(), '.deepcodex/rag-evaluations'),
    )
    console.log(JSON.stringify({ aggregate: report.aggregate, files }, null, 2))
    return
  }
  throw new Error('未知命令。可用：status、index、evaluate。')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

