---
name: qmd-info-retrieval
description: qmd 搜索工具的使用技巧，包括查找集合路径、写文件流程、搜索语法
---

# qmd 信息检索技巧

## 核心命令

| 命令 | 作用 |
|------|------|
| `qmd collection list` | 列出所有集合（名称+路径+文件数） |
| `qmd collection show <集合>` | 快速查看集合路径（替代 find） |
| `qmd ls [集合[/路径]]` | 列出集合内文件 |
| `qmd search <集合> "<关键词>"` | BM25 关键词搜索（无 LLM，零成本） |
| `qmd query <集合> "<语义>"` | 混合搜索+重排（需要 embed） |
| `qmd vsearch <集合> "<词>"` | 纯向量相似度 |
| `qmd get <文件>[:行数]` | 读取单个文件 |
| `qmd update` | 更新所有集合索引（写文件后必跑） |
| `qmd embed [集合]` | 更新向量嵌入（写文件后选跑） |

## 集合一览（截至 2026-04）

| 集合名 | 路径 | 文件数 |
|--------|------|--------|
| obsidianMyNotes | iCloud/.../obsidianMyNotes/ | 4105 |
| meeting | iCloud/.../meeting/ | 291 |
| ai-center | /Users/onepisya/code/ai-center/ | 21 |
| skills-index | /Users/onepisya/github-knowledge/skills-index/ | 95965 |
| openclaw-workspace | ~/.openclaw/workspace/ | 220 |

## 写文件到集合的标准流程

1. `qmd collection show <集合>` 确认路径
2. 写入文件
3. `qmd update` 更新索引（更新所有集合）
4. `qmd embed [集合]` 生成向量（可选，语义搜索需要）
5. `qmd search <集合> "<关键词>"` 验证

## 搜索模式选择

- **关键词搜索** → 用 `qmd search`（BM25，无 API 成本）
- **语义搜索** → 用 `qmd query`（需要先 embed）
- **找文件路径** → `qmd ls <集合> | grep 关键词`
- **读文件内容** → `qmd get <文件路径>`

## 常见任务

```bash
# 搜索关键词
qmd search ai-center "自我进化"

# 语义查询
qmd query obsidianMyNotes "他的自我反思模式" -n 5

# 查看集合内文件
qmd ls ai-center

# 读取文件
qmd get ai-center/AI-Agent自我进化研究.md
qmd get ai-center/AI-Agent自我进化研究.md:1-20  # 只读前20行
```
