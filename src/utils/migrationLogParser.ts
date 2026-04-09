import { MigrationLogEvent, MigrationMilestone, MappingCardState } from '../store/migrationStore'

const ARROW = '\u{2192}' // →
const TABLE_START_RE = /^\[(\d+)\/(\d+)\]\s+Starting:\s+(.+)$/
const TABLE_COMPLETE_RE = /^\[(\d+)\/(\d+)\]\s+Completed:\s+(.+?)\s+—\s+written=(\d+)\s+failed=(\d+)$/
const TABLE_FAILED_RE = /^\[(\d+)\/(\d+)\]\s+Failed:\s+(.+?)\s+—\s+(.+)$/
const PIPELINE_START_RE = /^Pipeline started: job_id=(\d+)$/
const PIPELINE_FINISH_RE = /^Pipeline (FINISHED|PARTIAL_FAILED|FAILED):\s+rows_written=(\d+)\s+rows_failed=(\d+)\s+elapsed=([\d.]+)s$/
const TABLE_MAPPINGS_RE = /^Pipeline started:\s+(\d+)\s+table mapping\(s\)$/

interface ParseResult {
  milestones: MigrationMilestone[]
  cards: MappingCardState[]
}

export function parseMilestones(logs: MigrationLogEvent[]): ParseResult {
  const cardMap = new Map<string, MappingCardState>()
  const milestones: MigrationMilestone[] = []
  let totalMappings = 0

  for (const log of logs) {
    const { message, timestamp } = log

    // Pipeline start
    const psMatch = message.match(PIPELINE_START_RE)
    if (psMatch) {
      milestones.push({
        id: 'pipeline_start',
        type: 'pipeline_start',
        label: 'Pipeline started',
        status: 'running',
        timestamp,
      })
      continue
    }

    // Total mappings count
    const tmMatch = message.match(TABLE_MAPPINGS_RE)
    if (tmMatch) {
      totalMappings = parseInt(tmMatch[1], 10)
      continue
    }

    // Table start
    const tsMatch = message.match(TABLE_START_RE)
    if (tsMatch) {
      const idx = parseInt(tsMatch[1], 10)
      const total = parseInt(tsMatch[2], 10)
      const label = tsMatch[3] // "src→tgt"
      const parts = label.split(ARROW)
      const sourceTable = parts[0]?.trim() ?? label
      const targetTable = parts[1]?.trim() ?? ''

      milestones.push({
        id: `table_start:${label}`,
        type: 'table_start',
        label,
        status: 'running',
        timestamp,
        mappingIndex: idx,
        totalMappings: total,
      })

      cardMap.set(label, {
        sourceTable,
        targetTable,
        status: 'running',
        rowsWritten: 0,
        rowsFailed: 0,
        startedAt: timestamp,
        mappingIndex: idx,
        totalMappings: total,
      })
      continue
    }

    // Table complete
    const tcMatch = message.match(TABLE_COMPLETE_RE)
    if (tcMatch) {
      const label = tcMatch[3]
      const rowsWritten = parseInt(tcMatch[4], 10)
      const rowsFailed = parseInt(tcMatch[5], 10)

      milestones.push({
        id: `table_complete:${label}`,
        type: 'table_complete',
        label,
        status: 'success',
        timestamp,
        rowsWritten,
        rowsFailed,
        mappingIndex: parseInt(tcMatch[1], 10),
        totalMappings: parseInt(tcMatch[2], 10),
      })

      const card = cardMap.get(label)
      if (card) {
        card.status = 'success'
        card.rowsWritten = rowsWritten
        card.rowsFailed = rowsFailed
        card.finishedAt = timestamp
      }
      continue
    }

    // Table failed
    const tfMatch = message.match(TABLE_FAILED_RE)
    if (tfMatch) {
      const label = tfMatch[3]
      const error = tfMatch[4]

      milestones.push({
        id: `table_failed:${label}`,
        type: 'table_failed',
        label,
        status: 'failed',
        timestamp,
        error,
        mappingIndex: parseInt(tfMatch[1], 10),
        totalMappings: parseInt(tfMatch[2], 10),
      })

      const card = cardMap.get(label)
      if (card) {
        card.status = 'failed'
        card.error = error
        card.finishedAt = timestamp
      }
      continue
    }

    // Pipeline finish
    const pfMatch = message.match(PIPELINE_FINISH_RE)
    if (pfMatch) {
      const status = pfMatch[1] === 'FINISHED' ? 'success' : 'failed'
      const rowsWritten = parseInt(pfMatch[2], 10)
      const rowsFailed = parseInt(pfMatch[3], 10)
      const elapsedSec = parseFloat(pfMatch[4])

      milestones.push({
        id: 'pipeline_finish',
        type: 'pipeline_finish',
        label: status === 'success' ? 'Pipeline finished' : `Pipeline ${pfMatch[1]}`,
        status,
        timestamp,
        rowsWritten,
        rowsFailed,
        elapsedMs: elapsedSec * 1000,
      })

      // Mark the pipeline_start milestone as success/failed
      const startM = milestones.find(m => m.type === 'pipeline_start')
      if (startM) startM.status = status

      continue
    }
  }

  // Mark remaining running table milestones as 'pending' if no pipeline has started yet
  const hasPipelineStart = milestones.some(m => m.type === 'pipeline_start')
  const hasPipelineFinish = milestones.some(m => m.type === 'pipeline_finish')

  if (hasPipelineStart && !hasPipelineFinish) {
    // Find the currently running table (last table_start without a complete/failed)
    const completedLabels = new Set<string>()
    for (const m of milestones) {
      if (m.type === 'table_complete' || m.type === 'table_failed') {
        completedLabels.add(m.label)
      }
    }
    for (const m of milestones) {
      if (m.type === 'table_start' && m.status === 'running' && !completedLabels.has(m.label)) {
        // This is the currently running table — keep as 'running'
      } else if (m.type === 'table_start' && m.status === 'running' && completedLabels.has(m.label)) {
        m.status = 'success'
      }
    }

    // Mark tables that haven't started yet as 'pending'
    for (const [label, card] of cardMap) {
      if (!completedLabels.has(label) && card.status === 'running') {
        // Check if this table has a table_start milestone
        const hasStart = milestones.some(m => m.type === 'table_start' && m.label === label)
        if (!hasStart) {
          card.status = 'pending'
        }
      }
    }
  }

  // Compute elapsedMs for cards
  for (const card of cardMap.values()) {
    if (card.startedAt && card.finishedAt) {
      card.elapsedMs = new Date(card.finishedAt).getTime() - new Date(card.startedAt).getTime()
    }
  }

  // Add pending cards for tables that haven't started yet
  if (totalMappings > 0 && cardMap.size < totalMappings) {
    const startedLabels = new Set(cardMap.keys())
    for (let i = 1; i <= totalMappings; i++) {
      if (!startedLabels.has(`placeholder_${i}`)) {
        // We don't know the table names yet for pending ones, skip
      }
    }
  }

  const cards = [...cardMap.values()].sort((a, b) => a.mappingIndex - b.mappingIndex)

  return { milestones, cards }
}
