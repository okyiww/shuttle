---
name: jira-sprint-progress-summary
description: 当需要汇总指定 Jira 项目当前 Sprint 内各成员工作项、状态、进度和风险时使用此 skill。
---

## 适用场景

- 用户希望了解某个 Jira 项目当前 Sprint 的整体进展。
- 用户要求按负责人归纳本 Sprint 内每个人正在做什么，并以表格展示。
- 用户需要快速识别已完成、审查中、进行中、未开始及可能停滞的工作项。
- 用户希望获得 Sprint 完成率、逾期情况、高优先级事项和需要跟进的风险项。

## 从 0 到 1 的步骤

1. **确认目标范围**
   - 从用户表达中提取项目标识，例如项目 Key `AI`。
   - 默认理解“当前 sprint”为该项目 Scrum Board 的 active sprint。
   - 若项目可能对应多个 Board，先向用户确认，或在结果中明确所使用的 Board。

2. **获取 Atlassian 站点资源**
   - 调用资源发现接口获取可访问的 Jira Cloud ID。
   - 确认 Jira 具备读取权限。

3. **发现合适的 Jira 查询工具**
   - 优先使用能够一次性返回 Board、当前 Sprint 和 Sprint Issues 的工具。
   - 推荐能力：`getJiraBoardSprintData`。
   - 查询参数至少包括：
     - `cloudId`
     - `projectKeyOrId`
     - `includeIssues: true`

4. **解析当前 Sprint 基础信息**
   - 提取并记录：
     - Sprint 名称与 ID
     - Sprint 状态
     - 开始时间、结束时间
     - Sprint Goal（如有）
     - 所属 Board 名称
   - 用当前日期与结束时间比较：
     - 当前日期晚于结束时间且 Sprint 仍为 active，标记为“已超期/已过结束日期”。
     - 避免直接断言“延期”，除非 Jira 数据明确显示延期或用户确认。

5. **整理 Issue 明细**
   - 对 Sprint 内每个 Issue 提取：
     - Key
     - Summary
     - Assignee
     - Status
     - Priority
     - Updated 时间
     - 估算、剩余工时、完成百分比或 Story Points（若字段存在）
     - 风险标记、阻塞标记或依赖信息（若工具返回）
   - 为未分配负责人的 Issue 单列为“未分配”，不要遗漏。

6. **计算整体完成度**
   - 明确采用的口径，并保持前后一致：
     - **按 Issue 数量**：`已完成事项数 / Sprint 总事项数`
     - 如数据完整，也可补充 **按 Story Points** 的完成度。
   - “已完成”应依据 Jira 的完成状态类别或 Board 返回的 done/progress 分类，不要仅凭状态名称猜测。
   - 同时统计各状态数量，例如：已完成、审查中、进行中、待确认、打开/未开始。

7. **按负责人聚合工作项**
   - 按 Assignee 分组，将同一人的多个事项放在相邻行。
   - 每项给出简短的“进度归纳”，例如：
     - `已完成`
     - `待验收`
     - `开发/需求确认中`
     - `未开始`
     - `存在阻塞，待外部输入`
   - 若 Jira 没有实际进度字段，不要编造完成百分比；使用状态和更新时间描述事实。

8. **识别风险与关注项**
   - 建议采用可解释的规则：
     - Sprint 已到期但 Issue 未完成。
     - 高优先级 Issue 仍处于 Open/To Do。
     - Issue 长时间未更新，例如 7 天或以上。
     - Issue 被系统直接标记为 at-risk、blocked 或存在阻塞依赖。
     - 状态长期停留在需求确认、待开发等早期阶段。
   - 风险措辞应体现证据强度：
     - 有明确阻塞字段：`存在阻塞`
     - 仅长期未更新：`存在停滞风险`
     - 仅因状态未完成：`建议关注`

9. **输出面向管理决策的表格**
   - 先给一句总体概览：Sprint 名称、周期、是否超期、总事项数、完成事项数、完成率。
   - 使用以下结构输出主表：

   | 负责人 | 工作项（Jira） | 当前状态 | 进度归纳 | 风险/关注点 |
   |---|---|---|---|---|

   - 工作项使用可点击的 Jira 链接，链接格式：
     - `https://<site>.atlassian.net/browse/<ISSUE-KEY>`
   - 表格后增加“风险总结”，按优先级列出最需要跟进的事项和建议动作。

10. **给出审慎、可执行的结论**
    - 结论应聚焦：
      - 当前完成率与 Sprint 到期关系。
      - 最紧急的未开始或高优事项。
      - 长期无更新的事项。
      - 建议在当天同步的内容：实际完成度、阻塞项、剩余交付时间、是否需要拆分或移出 Sprint。

## 踩坑与规避

- **不要把“Requirement Confirmed”误判为开发已完成**
  - 该状态通常表示需求已确认，不等于已开发、已测试或可交付。
  - 表述为“待开发/进行中”前，应尽量结合状态类别、子任务、工时或更新记录判断。

- **不要把审查中直接算作完成**
  - Review、Code Review、UAT、待验收等状态通常仍未完成。
  - 完成率应以 Jira 的 Done 类别或明确完成状态为准。

- **不要仅凭更新时间断言任务停滞**
  - 长时间未更新只能说明“存在停滞风险”或“建议确认”，不能证明没有实际推进。
  - 明确使用阈值，如“超过 7 天未更新”，并在结论中说明这是风险信号。

- **注意 Sprint 日期与时区**
  - Jira 返回的时间通常为 ISO 8601 UTC 时间。
  - 面向业务用户展示日期时应转换为其工作时区，至少避免因 UTC 跨日导致 Sprint 起止日期错误。

- **不要遗漏未分配事项**
  - 未分配 Issue 是 Sprint 交付风险的重要来源，应单列负责人为“未分配”。

- **不要混淆项目、Board 和 Sprint**
  - 一个项目可能关联多个 Board；同名 Sprint 也可能存在。
  - 输出中说明使用的 Board 和已解析到的 Sprint 名称，必要时附 Sprint ID。

- **完成率要声明计算口径**
  - 按事项数和按 Story Points 得出的结果可能差异很大。
  - 没有完整估算数据时，优先采用按事项数的完成率，并明确说明。

- **避免将“当前已过 Sprint 结束日期”写成确定的流程违规**
  - Active Sprint 超过计划结束日期可能由管理员尚未关闭、时区差异或计划调整造成。
  - 应描述事实，例如“当前日期已晚于计划结束时间，Sprint 仍处于 Active”。

- **不要虚构风险数量或系统标记**
  - 只有工具返回明确风险字段时，才能说“系统标记为风险项”。
  - 否则使用自定义规则产生的“风险项”，并说明判定依据。

## 关联资源

- Atlassian Jira Cloud 资源发现：`getAccessibleAtlassianResources`
- Jira 工具发现：`discover`
- 当前 Board/Sprint/Issue 综合查询：`getJiraBoardSprintData`
- Sprint 列表与 Sprint ID 查询：`listJiraBoardSprints`
- Jira Board 查询：`listJiraBoards`
- Jira Issue 链接格式：`https://<site>.atlassian.net/browse/<ISSUE-KEY>`