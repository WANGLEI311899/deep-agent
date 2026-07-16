/**
 * Skill 加载器
 * 扫描 .deepagent/skills 目录，读取所有 .skill.md 文件并解析成结构化数据
 * Agent 启动时调用，把解析结果拼入 System Prompt
 */

import fs from 'fs'
import path from 'path'

// Skill 数据结构
export interface Skill {
  name: string // 技能名称（# 标题）
  fileName: string // 文件名（poem-joke.skill.md）
  description: string // 触发条件（## Description 内容）
  script: string // 执行步骤（## Script 内容）
  examples?: string // 示例（## Examples 内容，可选）
  references?: string // 参考资料（## References 内容，可选）
  raw: string // 完整原始文件内容
}

/**
 * 解析单个 .skill.md 文件
 * 按 ## 章节切割，提取各部分内容
 */
function parseSkillFile(filePath: string): Skill {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n')

  // 提取技能名称（文件里的第一个 # 标题）
  const nameMatch = lines.find((l) => l.startsWith('# '))
  const name = nameMatch
    ? nameMatch.replace('# ', '').trim()
    : path.basename(filePath, '.skill.md')

  // 按 ## 章节分割，构建章节内容映射
  const sections: Record<string, string> = {}
  let currentSection = ''
  let currentContent: string[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // 遇到新章节：先保存上一个章节的内容
      if (currentSection) {
        sections[currentSection] = currentContent.join('\n').trim()
      }
      // 开始新章节
      currentSection = line.replace('## ', '').trim()
      currentContent = []
    } else if (!line.startsWith('# ')) {
      // 不是 # 标题行，就是当前章节的内容
      currentContent.push(line)
    }
  }
  // 保存最后一个章节
  if (currentSection) {
    sections[currentSection] = currentContent.join('\n').trim()
  }

  return {
    name,
    fileName: path.basename(filePath),
    description: sections['Description'] || '',
    script: sections['Script'] || '',
    examples: sections['Examples'],
    references: sections['References'],
    raw,
  }
}

/**
 * 加载指定目录下所有 .skill.md 文件
 * 返回解析后的 Skill 数组
 */
export function loadSkills(skillsDir: string): Skill[] {
  const resolvedDir = path.resolve(skillsDir)

  // 目录不存在时给出警告，不直接报错（允许没有 Skill 运行）
  if (!fs.existsSync(resolvedDir)) {
    console.warn(`[SkillLoader] 目录不存在：${resolvedDir}`)
    return []
  }

  const files = fs.readdirSync(resolvedDir)
  const skillFiles = files.filter((f) => f.endsWith('.skill.md'))

  if (skillFiles.length === 0) {
    console.warn(`[SkillLoader] 未找到任何 .skill.md 文件：${resolvedDir}`)
    return []
  }

  const skills = skillFiles.map((file) => {
    const filePath = path.join(resolvedDir, file)
    const skill = parseSkillFile(filePath)
    console.log(`[SkillLoader] 已加载技能：${skill.name} (${file})`)
    return skill
  })

  return skills
}

/**
 * 把 Skill 列表格式化成注入 System Prompt 的文字
 * DeepSeek 读到这段文字，就知道什么时候触发哪个 Skill
 */
export function buildSkillsPrompt(skills: Skill[]): string {
  if (skills.length === 0) return ''

  const skillDescriptions = skills
    .map((skill, index) => {
      // 每个 Skill 的描述块
      let desc = `${index + 1}. **${skill.name}**\n   触发条件：${skill.description}`

      // 如果有示例，取第一个示例展示给模型
      if (skill.examples) {
        const firstExample = skill.examples.split('\n').slice(0, 3).join('\n')
        desc += `\n   示例：\n   ${firstExample}`
      }

      return desc
    })
    .join('\n\n')

  return `
## 你具备以下专项技能（Skill）

${skillDescriptions}

当用户的输入符合某个技能的触发条件时，请主动调用该技能的 Script 中的执行逻辑来处理任务。
如果输入同时符合多个技能，选择最匹配的那个。
`
}
