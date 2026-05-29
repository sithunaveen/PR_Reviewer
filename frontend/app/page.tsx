'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Shield, Zap, Code2, GitMerge, AlertTriangle, CheckCircle,
  XCircle, Clock, ChevronDown, ChevronRight, Lock, Activity,
  ExternalLink, Play, RotateCcw, Info, Star
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

type AgentStatus = 'idle' | 'running' | 'complete' | 'error'
type Verdict = 'approve' | 'request_changes' | 'needs_discussion' | 'blocked'

interface AgentState {
  name: string
  label: string
  role: string
  status: AgentStatus
  tokens: string
  result: Record<string, unknown> | null
  durationMs: number
  color: string
  colorHex: string
  icon: React.ReactNode
  cssClass: string
}

interface WorkflowState {
  status: 'idle' | 'fetching' | 'reviewing' | 'sod_check' | 'synthesizing' | 'complete' | 'error'
  prMetadata: Record<string, unknown> | null
  sodVerified: boolean
  finalVerdict: Record<string, unknown> | null
  error: string | null
  agents: Record<string, AgentState>
  stages: string[]
  currentStage: string | null
}

// ── Constants ──────────────────────────────────────────────────────────────

const AGENT_CONFIG: Record<string, Omit<AgentState, 'status' | 'tokens' | 'result' | 'durationMs'>> = {
  'security-auditor': {
    name: 'security-auditor',
    label: 'Security Auditor',
    role: 'reviewer',
    color: 'text-red-400',
    colorHex: '#f85149',
    icon: <Shield size={16} />,
    cssClass: 'agent-security',
  },
  'performance-reviewer': {
    name: 'performance-reviewer',
    label: 'Performance Reviewer',
    role: 'reviewer',
    color: 'text-orange-400',
    colorHex: '#f0883e',
    icon: <Zap size={16} />,
    cssClass: 'agent-performance',
  },
  'quality-checker': {
    name: 'quality-checker',
    label: 'Quality Checker',
    role: 'reviewer',
    color: 'text-blue-400',
    colorHex: '#4f8ef7',
    icon: <Code2 size={16} />,
    cssClass: 'agent-quality',
  },
  'review-synthesizer': {
    name: 'review-synthesizer',
    label: 'Review Synthesizer',
    role: 'synthesizer',
    color: 'text-purple-400',
    colorHex: '#a371f7',
    icon: <GitMerge size={16} />,
    cssClass: 'agent-synthesizer',
  },
}

const INITIAL_AGENTS: Record<string, AgentState> = Object.fromEntries(
  Object.entries(AGENT_CONFIG).map(([k, v]) => [k, {
    ...v, status: 'idle', tokens: '', result: null, durationMs: 0
  }])
)

const INITIAL_STATE: WorkflowState = {
  status: 'idle',
  prMetadata: null,
  sodVerified: false,
  finalVerdict: null,
  error: null,
  agents: INITIAL_AGENTS,
  stages: [],
  currentStage: null,
}

// ── Helper Components ──────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  const config: Record<string, { color: string; bg: string }> = {
    critical: { color: 'text-red-300', bg: 'bg-red-950/60 border-red-800/50' },
    high:     { color: 'text-orange-300', bg: 'bg-orange-950/60 border-orange-800/50' },
    medium:   { color: 'text-yellow-300', bg: 'bg-yellow-950/60 border-yellow-800/50' },
    low:      { color: 'text-blue-300', bg: 'bg-blue-950/60 border-blue-800/50' },
    clean:    { color: 'text-green-300', bg: 'bg-green-950/60 border-green-800/50' },
    info:     { color: 'text-gray-300', bg: 'bg-gray-900/60 border-gray-700/50' },
  }
  const c = config[severity?.toLowerCase()] || config.info
  return (
    <span className={`text-xs font-mono font-semibold px-2 py-0.5 rounded border ${c.color} ${c.bg} uppercase tracking-wider`}>
      {severity || 'unknown'}
    </span>
  )
}

function StatusDot({ status }: { status: AgentStatus }) {
  const config = {
    idle:     'bg-gray-600',
    running:  'bg-blue-400 animate-pulse',
    complete: 'bg-green-400',
    error:    'bg-red-400',
  }
  return <span className={`inline-block w-2 h-2 rounded-full ${config[status]}`} />
}

function ScoreRing({ score }: { score: number }) {
  const color = score >= 80 ? '#34d058' : score >= 60 ? '#f0883e' : '#f85149'
  const r = 28, c = 32, circ = 2 * Math.PI * r
  const dash = (score / 100) * circ
  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width="64" height="64" viewBox="0 0 64 64">
        <circle cx={c} cy={c} r={r} fill="none" stroke="#2a2a3a" strokeWidth="4" />
        <circle
          cx={c} cy={c} r={r} fill="none"
          stroke={color} strokeWidth="4"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeLinecap="round"
          transform="rotate(-90 32 32)"
          style={{ transition: 'stroke-dasharray 1s ease' }}
        />
      </svg>
      <span className="absolute text-sm font-bold font-mono" style={{ color }}>{score}</span>
    </div>
  )
}

function SODDiagram({ verified }: { verified: boolean }) {
  return (
    <div className="border border-[#2a2a3a] rounded-xl p-4 bg-[#111118]">
      <div className="flex items-center gap-2 mb-3">
        <Lock size={14} className="text-purple-400" />
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Segregation of Duties
        </span>
        {verified && (
          <span className="ml-auto text-xs text-green-400 flex items-center gap-1">
            <CheckCircle size={12} /> Verified
          </span>
        )}
      </div>
      <div className="flex items-center justify-center gap-3 text-xs">
        <div className="flex flex-col items-center gap-1">
          <div className="flex gap-1">
            {['security-auditor', 'performance-reviewer', 'quality-checker'].map(a => (
              <div key={a} className="w-6 h-6 rounded bg-[#1e1e2e] border border-[#2a2a3a] flex items-center justify-center">
                {a === 'security-auditor' ? <Shield size={10} className="text-red-400" /> :
                 a === 'performance-reviewer' ? <Zap size={10} className="text-orange-400" /> :
                 <Code2 size={10} className="text-blue-400" />}
              </div>
            ))}
          </div>
          <span className="text-[10px] text-gray-500 font-mono">reviewer ×3</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <div className={`text-[10px] px-2 py-0.5 rounded border font-mono ${verified ? 'text-green-400 border-green-900/50 bg-green-950/30' : 'text-yellow-400 border-yellow-900/50 bg-yellow-950/30'}`}>
            ≠ conflict
          </div>
        </div>
        <div className="flex flex-col items-center gap-1">
          <div className="w-6 h-6 rounded bg-[#1e1e2e] border border-[#2a2a3a] flex items-center justify-center">
            <GitMerge size={10} className="text-purple-400" />
          </div>
          <span className="text-[10px] text-gray-500 font-mono">synthesizer</span>
        </div>
      </div>
    </div>
  )
}

// ── Agent Card ─────────────────────────────────────────────────────────────

function AgentCard({ agent, expanded, onToggle }: {
  agent: AgentState
  expanded: boolean
  onToggle: () => void
}) {
  const findings = agent.result?.findings as unknown[] | undefined
  const severity = agent.result?.severity as string | undefined
  const score = agent.result?.score as number | undefined

  return (
    <div
      className={`rounded-xl border border-[#2a2a3a] ${agent.cssClass} bg-[#0f0f18] transition-all duration-300 ${
        agent.status === 'running' ? 'border-opacity-50' : ''
      }`}
    >
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={onToggle}
      >
        <StatusDot status={agent.status} />
        <span className={`${agent.color}`}>{agent.icon}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-200">{agent.label}</span>
            <span className="text-[10px] font-mono text-gray-600 bg-[#1e1e2e] px-1.5 py-0.5 rounded">
              {agent.role}
            </span>
          </div>
          <span className="text-xs font-mono text-gray-500">{agent.name}</span>
        </div>

        {agent.status === 'complete' && severity && (
          <SeverityBadge severity={severity} />
        )}
        {agent.status === 'complete' && score !== undefined && (
          <span className="text-xs font-mono text-gray-400">{score}/100</span>
        )}
        {agent.durationMs > 0 && (
          <span className="text-[10px] font-mono text-gray-600 flex items-center gap-1">
            <Clock size={10} />{(agent.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {agent.status === 'complete' && (
          expanded ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />
        )}
      </div>

      {/* Streaming / Results */}
      {agent.status === 'running' && (
        <div className="px-4 pb-3">
          <div className="bg-[#0a0a12] rounded-lg p-3 max-h-32 overflow-y-auto">
            <pre className={`text-xs font-mono text-gray-400 whitespace-pre-wrap leading-relaxed ${!agent.tokens ? 'streaming-cursor' : ''}`}>
              {agent.tokens || ' '}
              {agent.tokens && <span className="streaming-cursor" />}
            </pre>
          </div>
        </div>
      )}

      {/* Expanded results */}
      {agent.status === 'complete' && expanded && agent.result && (
        <div className="px-4 pb-4 border-t border-[#1e1e2e]">
          <div className="mt-3 space-y-2">
            {findings && findings.length > 0 ? (
              findings.slice(0, 5).map((f: unknown, i: number) => {
                const finding = f as Record<string, unknown>
                return (
                  <div key={i} className="bg-[#0f0f1a] rounded-lg p-3 border border-[#1e1e28]">
                    <div className="flex items-start gap-2">
                      <SeverityBadge severity={finding.severity as string} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-300 font-medium">{finding.category as string}</div>
                        <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">{finding.description as string}</div>
                        {finding.file && (
                          <div className="text-[10px] font-mono text-gray-600 mt-1">
                            {finding.file as string}{finding.line_range ? `:${finding.line_range}` : ''}
                          </div>
                        )}
                        {finding.recommendation && (
                          <div className="text-[10px] text-green-500/80 mt-1.5 italic">
                            → {finding.recommendation as string}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            ) : (
              <div className="flex items-center gap-2 text-xs text-green-400">
                <CheckCircle size={12} />
                <span>No findings — all clear</span>
              </div>
            )}
            {findings && findings.length > 5 && (
              <div className="text-xs text-gray-600 text-center">
                +{findings.length - 5} more findings in full report
              </div>
            )}
            {agent.result.summary && (
              <div className="text-xs text-gray-400 italic mt-2 pt-2 border-t border-[#1e1e2e]">
                {agent.result.summary as string}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Verdict Card ───────────────────────────────────────────────────────────

function VerdictCard({ verdict }: { verdict: Record<string, unknown> }) {
  const v = (verdict.verdict as Verdict) || 'needs_discussion'
  const score = verdict.overall_score as number || 0
  const badge = verdict.badge as string || '—'
  const summary = verdict.summary as string || ''
  const actionItems = (verdict.action_items as unknown[]) || []
  const breakdown = verdict.breakdown as Record<string, Record<string, unknown>> || {}
  const positives = (verdict.positive_highlights as string[]) || []

  const verdictConfig: Record<Verdict, { border: string; title: string; icon: React.ReactNode }> = {
    approve: { border: 'verdict-approve', title: 'Approved', icon: <CheckCircle size={20} className="text-green-400" /> },
    request_changes: { border: 'verdict-request_changes', title: 'Changes Requested', icon: <AlertTriangle size={20} className="text-orange-400" /> },
    needs_discussion: { border: 'verdict-needs_discussion', title: 'Needs Discussion', icon: <Info size={20} className="text-blue-400" /> },
    blocked: { border: 'verdict-blocked', title: 'Blocked', icon: <XCircle size={20} className="text-red-400" /> },
  }

  const vc = verdictConfig[v] || verdictConfig.needs_discussion

  return (
    <div className={`rounded-2xl border-2 p-6 ${vc.border} animate-slide-up`}>
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          {vc.icon}
          <div>
            <div className="text-lg font-bold text-gray-100">{vc.title}</div>
            <div className="text-xs font-mono text-gray-500">{badge}</div>
          </div>
        </div>
        <ScoreRing score={score} />
      </div>

      <p className="text-sm text-gray-300 leading-relaxed mb-6 max-h-48 overflow-y-auto whitespace-pre-wrap">{summary}</p>

      {/* Score breakdown */}
      {Object.keys(breakdown).length > 0 && (
        <div className="mb-6">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Score Breakdown</div>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(breakdown).map(([dim, data]) => (
              <div key={dim} className="bg-[#0a0a12] rounded-lg p-2.5 border border-[#1e1e2e] text-center">
                <div className="text-xs font-mono text-gray-400 capitalize mb-1">{dim}</div>
                <div className="text-lg font-bold font-mono text-gray-200">{data.score as number}</div>
                <SeverityBadge severity={data.severity as string} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action items */}
      {actionItems.length > 0 && (
        <div className="mb-5">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Action Items</div>
          <div className="space-y-2">
            {actionItems.map((item: unknown, i: number) => {
              const ai = item as Record<string, unknown>
              return (
                <div key={i} className="flex items-start gap-2.5 text-xs">
                  <span className={`mt-0.5 font-mono font-bold text-[10px] px-1.5 py-0.5 rounded ${
                    ai.priority === 'required'
                      ? 'bg-red-950/50 text-red-400 border border-red-900/50'
                      : 'bg-gray-900/50 text-gray-400 border border-gray-800/50'
                  }`}>
                    {(ai.priority as string)?.toUpperCase() || 'SUGGESTED'}
                  </span>
                  <span className="text-gray-300 leading-relaxed">{ai.description as string}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Positive highlights */}
      {positives.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Highlights</div>
          <div className="space-y-1">
            {positives.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-green-400">
                <Star size={10} fill="currentColor" />
                <span>{p}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 pt-4 border-t border-[#2a2a3a] flex items-center gap-2 text-[10px] text-gray-600 font-mono">
        <Lock size={10} className="text-purple-500" />
        SOD verified — reviewer agents structurally separated from synthesizer
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function PRReviewerPage() {
  const [prUrl, setPrUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [githubToken, setGithubToken] = useState('')
  const [workflow, setWorkflow] = useState<WorkflowState>(INITIAL_STATE)
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set())
  const [showConfig, setShowConfig] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)

  const toggleAgent = (name: string) => {
    setExpandedAgents(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  const reset = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    setWorkflow(INITIAL_STATE)
    setExpandedAgents(new Set())
  }

  const handleEvent = useCallback((eventData: Record<string, unknown>) => {
    const type = eventData.type as string

    setWorkflow(prev => {
      const next = { ...prev, agents: { ...prev.agents } }

      switch (type) {
        case 'workflow_start':
          next.status = 'fetching'
          next.stages = eventData.stages as string[] || []
          break

        case 'stage_start': {
          const stage = eventData.stage as string
          next.currentStage = stage
          if (stage === 'review_parallel') next.status = 'reviewing'
          else if (stage === 'synthesize') next.status = 'synthesizing'
          break
        }

        case 'fetch_complete':
          next.prMetadata = eventData.metadata as Record<string, unknown>
          break

        case 'agent_start': {
          const agentName = eventData.agent as string
          if (next.agents[agentName]) {
            next.agents[agentName] = { ...next.agents[agentName], status: 'running', tokens: '' }
          }
          break
        }

        case 'token': {
          const agentName = eventData.agent as string
          if (next.agents[agentName]) {
            next.agents[agentName] = {
              ...next.agents[agentName],
              tokens: next.agents[agentName].tokens + (eventData.text as string || '')
            }
          }
          break
        }

        case 'agent_complete': {
          const agentName = eventData.agent as string
          if (next.agents[agentName]) {
            next.agents[agentName] = {
              ...next.agents[agentName],
              status: 'complete',
              result: eventData.result as Record<string, unknown>,
              durationMs: eventData.duration_ms as number || 0,
            }
          }
          break
        }

        case 'agent_error': {
          const agentName = eventData.agent as string
          if (next.agents[agentName]) {
            next.agents[agentName] = { ...next.agents[agentName], status: 'error' }
          }
          break
        }

        case 'sod_checkpoint':
          next.sodVerified = eventData.verified as boolean || false
          next.status = 'sod_check'
          break

        case 'workflow_complete':
          next.status = 'complete'
          // Capture verdict from workflow_complete as fallback
          if (eventData.verdict && !next.finalVerdict) {
            next.finalVerdict = {
              verdict: eventData.verdict,
              overall_score: eventData.overall_score || 0,
              badge: eventData.badge || '',
              summary: 'Review complete. Expand the Review Synthesizer card to see full details.',
              action_items: [],
              breakdown: {},
              positive_highlights: [],
            } as Record<string, unknown>
          }
          break

        case 'workflow_error':
          next.status = 'error'
          next.error = eventData.error as string || 'Unknown error'
          break
      }

      // Capture final verdict from synthesizer agent_complete
      if (type === 'agent_complete' && eventData.agent === 'review-synthesizer') {
        const result = eventData.result as Record<string, unknown>
        if (result && result.verdict) {
          // Clean JSON parsed — use directly
          next.finalVerdict = result
        } else if (result && result.raw) {
          // JSON parse failed — build a display object from raw text
          next.finalVerdict = {
            verdict: 'needs_discussion',
            overall_score: 50,
            badge: '💬 REVIEW COMPLETE',
            summary: result.raw as string,
            action_items: [],
            breakdown: {},
            positive_highlights: [],
          }
        } else if (result) {
          next.finalVerdict = result
        }
      }

      return next
    })
  }, [])

  const startReview = async () => {
    if (!prUrl.trim()) return
    reset()

    setWorkflow(prev => ({ ...prev, status: 'fetching' }))

    try {
      // Create the job
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pr_url: prUrl,
          gemini_api_key: apiKey || undefined,
          github_token: githubToken || undefined,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Failed to start review')
      }

      const { job_id } = await res.json()

      // Open SSE stream
      const es = new EventSource(`/api/stream/${job_id}`)
      eventSourceRef.current = es

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          handleEvent(data)
          if (data.type === 'workflow_complete' || data.type === 'workflow_error') {
            es.close()
          }
        } catch (err) {
          console.error('Parse error:', err)
        }
      }

      es.onerror = () => {
        es.close()
        setWorkflow(prev => ({
          ...prev,
          status: 'error',
          error: 'Connection to backend lost. Is the FastAPI server running?'
        }))
      }

    } catch (err) {
      setWorkflow(prev => ({
        ...prev,
        status: 'error',
        error: (err as Error).message
      }))
    }
  }

  const isRunning = ['fetching', 'reviewing', 'sod_check', 'synthesizing'].includes(workflow.status)
  const meta = workflow.prMetadata as Record<string, unknown> | null

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-gray-100">
      {/* Header */}
      <header className="border-b border-[#1e1e2e] bg-[#0a0a0f]/90 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center">
              <Shield size={16} className="text-white" />
            </div>
            <div>
              <div className="font-bold text-gray-100 leading-none">PR Reviewer</div>
              <div className="text-[10px] font-mono text-gray-500">powered by GitAgent × Lyzr</div>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              gitagent spec v0.1.0
            </span>
            <span className="flex items-center gap-1.5">
              <Lock size={10} className="text-purple-400" />
              SOD enforced
            </span>
            <a
              href="https://github.com/open-gitagent/gitagent"
              target="_blank"
              className="flex items-center gap-1 hover:text-gray-300 transition-colors"
            >
              <ExternalLink size={12} />
              GitAgent
            </a>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* ── Left: Input & Config ──────────────────────────────────── */}
          <div className="lg:col-span-1 space-y-4">

            {/* Hero text */}
            <div className="mb-6">
              <h1 className="text-2xl font-bold mb-2">
                <span className="gradient-text">Multi-Agent</span>{' '}
                <span className="text-gray-200">PR Review</span>
              </h1>
              <p className="text-sm text-gray-400 leading-relaxed">
                4 specialized GitAgents review your PR with strict Segregation of Duties.
                Reviewers never approve. The synthesizer never codes.
              </p>
            </div>

            {/* PR URL input */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                GitHub PR URL
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={prUrl}
                  onChange={e => setPrUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !isRunning && startReview()}
                  placeholder="https://github.com/owner/repo/pull/42"
                  className="flex-1 bg-[#111118] border border-[#2a2a3a] rounded-lg px-3 py-2.5 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                  disabled={isRunning}
                />
              </div>
            </div>

            {/* Config toggle */}
            <button
              onClick={() => setShowConfig(!showConfig)}
              className="text-xs text-gray-500 hover:text-gray-400 flex items-center gap-1 transition-colors"
            >
              {showConfig ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              API Keys (optional for public repos)
            </button>

            {showConfig && (
              <div className="space-y-2 animate-fade-in">
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="Gemini API key — free at aistudio.google.com"
                  className="w-full bg-[#111118] border border-[#2a2a3a] rounded-lg px-3 py-2 text-xs font-mono text-gray-300 placeholder-gray-600 focus:outline-none focus:border-purple-500/50 transition-colors"
                />
                <input
                  type="password"
                  value={githubToken}
                  onChange={e => setGithubToken(e.target.value)}
                  placeholder="GitHub token (for private repos)"
                  className="w-full bg-[#111118] border border-[#2a2a3a] rounded-lg px-3 py-2 text-xs font-mono text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                />
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-2">
              <button
                onClick={startReview}
                disabled={isRunning || !prUrl.trim()}
                className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg px-4 py-2.5 text-sm font-semibold text-white flex items-center justify-center gap-2 transition-all"
              >
                {isRunning ? (
                  <>
                    <Activity size={14} className="animate-pulse" />
                    Reviewing...
                  </>
                ) : (
                  <>
                    <Play size={14} />
                    Start Review
                  </>
                )}
              </button>
              {workflow.status !== 'idle' && (
                <button
                  onClick={reset}
                  disabled={isRunning}
                  className="px-3 py-2.5 border border-[#2a2a3a] rounded-lg hover:border-[#3a3a4a] text-gray-400 hover:text-gray-300 disabled:opacity-40 transition-colors"
                >
                  <RotateCcw size={14} />
                </button>
              )}
            </div>

            {/* SOD Diagram */}
            <SODDiagram verified={workflow.sodVerified} />

            {/* Stage progress */}
            {workflow.status !== 'idle' && (
              <div className="border border-[#2a2a3a] rounded-xl p-4 bg-[#111118]">
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Workflow Stages
                </div>
                <div className="space-y-2">
                  {[
                    { id: 'fetch', label: 'Fetch PR Diff', stages: ['fetching'] },
                    { id: 'review', label: 'Parallel Review ×3', stages: ['reviewing'] },
                    { id: 'sod', label: 'SOD Checkpoint', stages: ['sod_check'] },
                    { id: 'synthesize', label: 'Synthesize Verdict', stages: ['synthesizing'] },
                    { id: 'done', label: 'Complete', stages: ['complete'] },
                  ].map((stage, i) => {
                    const isActive = stage.stages.includes(workflow.status)
                    const isDone = (['fetch','review','sod','synthesize'].indexOf(stage.id) <
                      ['fetching','reviewing','sod_check','synthesizing','complete','error'].indexOf(workflow.status))
                      || (stage.id === 'done' && workflow.status === 'complete')
                    return (
                      <div key={stage.id} className="flex items-center gap-2.5">
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border ${
                          isDone ? 'border-green-600 bg-green-950/50 text-green-400' :
                          isActive ? 'border-blue-500 bg-blue-950/50 text-blue-400 animate-pulse' :
                          'border-[#2a2a3a] bg-transparent text-gray-600'
                        }`}>
                          {isDone ? '✓' : i + 1}
                        </div>
                        <span className={`text-xs ${isDone || isActive ? 'text-gray-300' : 'text-gray-600'}`}>
                          {stage.label}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* PR Metadata */}
            {meta && (
              <div className="border border-[#2a2a3a] rounded-xl p-4 bg-[#111118] animate-slide-up">
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Pull Request
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="font-medium text-gray-200 leading-snug">{meta.title as string}</div>
                  <div className="font-mono text-gray-500">{meta.repo_full_name as string} #{meta.number as number}</div>
                  <div className="text-gray-500">by @{meta.author as string}</div>
                  <div className="flex gap-3 pt-1">
                    <span className="text-green-400">+{meta.additions as number}</span>
                    <span className="text-red-400">-{meta.deletions as number}</span>
                    <span className="text-gray-500">{meta.changed_files as number} files</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Right: Agent Workflow ─────────────────────────────────── */}
          <div className="lg:col-span-2 space-y-4">

            {/* Error */}
            {workflow.status === 'error' && workflow.error && (
              <div className="border border-red-900/50 bg-red-950/20 rounded-xl p-4 flex items-start gap-3">
                <XCircle size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="text-sm font-semibold text-red-300 mb-1">Review Failed</div>
                  <div className="text-xs text-red-400/80 font-mono">{workflow.error}</div>
                </div>
              </div>
            )}

            {/* Idle state */}
            {workflow.status === 'idle' && (
              <div className="border border-dashed border-[#2a2a3a] rounded-2xl p-12 text-center">
                <div className="text-4xl mb-4">🔍</div>
                <div className="text-lg font-semibold text-gray-300 mb-2">
                  Ready to review
                </div>
                <div className="text-sm text-gray-500 max-w-sm mx-auto leading-relaxed">
                  Enter a GitHub PR URL to start a multi-agent review. Three specialist agents
                  will analyze the diff in parallel, then a separate synthesizer will issue the verdict.
                </div>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {Object.values(AGENT_CONFIG).map(a => (
                    <div key={a.name} className="flex items-center gap-1.5 text-xs bg-[#111118] border border-[#2a2a3a] px-2.5 py-1.5 rounded-lg">
                      <span className={a.color}>{a.icon}</span>
                      <span className="text-gray-400">{a.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Agent cards - reviewers */}
            {workflow.status !== 'idle' && (
              <>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                  <Activity size={12} />
                  Reviewer Agents
                  <span className="text-[10px] text-gray-600 font-mono normal-case">running in parallel</span>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  {['security-auditor', 'performance-reviewer', 'quality-checker'].map(name => (
                    <AgentCard
                      key={name}
                      agent={workflow.agents[name]}
                      expanded={expandedAgents.has(name)}
                      onToggle={() => toggleAgent(name)}
                    />
                  ))}
                </div>

                {/* SOD Checkpoint Banner */}
                {(workflow.sodVerified || ['synthesizing', 'complete'].includes(workflow.status)) && (
                  <div className="flex items-center gap-3 bg-purple-950/20 border border-purple-900/30 rounded-xl px-4 py-3 animate-fade-in">
                    <Lock size={14} className="text-purple-400 flex-shrink-0" />
                    <div className="text-xs text-purple-300">
                      <span className="font-semibold">SOD Checkpoint passed</span>
                      <span className="text-purple-500"> — reviewer agents completed independently. Synthesizer receives reports only, never the raw diff.</span>
                    </div>
                    <CheckCircle size={14} className="text-green-400 ml-auto flex-shrink-0" />
                  </div>
                )}

                {/* Synthesizer */}
                {['synthesizing', 'complete'].includes(workflow.status) && (
                  <>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                      <GitMerge size={12} />
                      Synthesizer Agent
                      <span className="text-[10px] text-gray-600 font-mono normal-case">final verdict</span>
                    </div>
                    <AgentCard
                      agent={workflow.agents['review-synthesizer']}
                      expanded={expandedAgents.has('review-synthesizer')}
                      onToggle={() => toggleAgent('review-synthesizer')}
                    />
                  </>
                )}

                {/* Final Verdict */}
                {workflow.status === 'complete' && workflow.finalVerdict && (
                  <>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                      <CheckCircle size={12} />
                      Final Verdict
                    </div>
                    <VerdictCard verdict={workflow.finalVerdict} />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
