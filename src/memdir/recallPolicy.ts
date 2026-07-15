import type { Message } from 'src/types/message.js'
import { getUserMessageText } from 'src/utils/messages.js'

export type RecallPolicy = 'SYNC_RECALL' | 'ASYNC_RECALL' | 'SKIP_RECALL'

export type RecallPolicyResult = {
  policy: RecallPolicy
  reason: string
  timedOut?: boolean
}

const RECALL_POLICIES = new Set<RecallPolicy>([
  'SYNC_RECALL',
  'ASYNC_RECALL',
  'SKIP_RECALL',
])

const SKIP_RECALL_PATTERNS: RegExp[] = [
  /(?:不要|别|不用|不必|无需|不要再|别再)(?:参考|查看|读取|使用|调用|依赖|考虑|管|看)?(?:我)?(?:之前|以前|历史|过往|记忆|memory|memories|偏好)/i,
  /(?:忽略|无视|跳过)(?:我)?(?:之前|以前|历史|过往|记忆|memory|memories|偏好)/i,
  /(?:不要|别|不用|不必|无需).{0,12}(?:历史|记忆|memory|memories)/i,
  /\b(?:ignore|skip|disregard)\b.{0,40}\b(?:previous|prior|past|old|historical|memory|memories|preferences?|context)\b/i,
  /\b(?:do not|don't|dont|without|no need to)\b.{0,40}\b(?:use|reference|consult|read|recall|remember|consider|rely on)\b.{0,40}\b(?:previous|prior|past|old|historical|memory|memories|preferences?|context)\b/i,
  /\bforget\b.{0,40}\b(?:previous|prior|past|old|historical|memory|memories|preferences?|context)\b/i,
]

const SYNC_RECALL_PATTERNS: RegExp[] = [
  /(?:你)?还记得(?:我)?(?:之前|以前|上次|上回|过去)?(?:说|提|讲|要求|偏好|约定|决定)?/i,
  /(?:之前|以前|上次|上回|过去)(?:我)?(?:说过|提过|讲过|要求过|约定过|决定过|那个|那套|方案|偏好|设置)/i,
  /(?:按|照|沿用|继续|基于)(?:我)?(?:之前|以前|上次|上回|过去)(?:的|那个|那套)?/i,
  /\b(?:do you )?remember\b.{0,60}\b(?:previously|earlier|last time|before|i said|i told you|my preference|we decided)\b/i,
  /\b(?:previously|earlier|last time|before)\b.{0,60}\b(?:i|we|you)\b.{0,30}\b(?:said|mentioned|discussed|decided|used|agreed|preferred)\b/i,
  /\b(?:as before|same as last time|continue from last time|based on my previous|based on what i said before)\b/i,
]

const DEFAULT_RECALL_POLICY_TIMEOUT_MS = 250

function isRecallPolicy(value: unknown): value is RecallPolicy {
  return typeof value === 'string' && RECALL_POLICIES.has(value as RecallPolicy)
}

function asyncRecall(reason: string, timedOut?: boolean): RecallPolicyResult {
  return timedOut
    ? { policy: 'ASYNC_RECALL', reason, timedOut: true }
    : { policy: 'ASYNC_RECALL', reason }
}

function getLatestRealUserText(messages: readonly Message[]): string | null {
  const message = messages.findLast(
    m =>
      m.type === 'user' &&
      !m.isMeta &&
      !m.isCompactSummary &&
      m.toolUseResult === undefined,
  )
  return message ? getUserMessageText(message) : null
}

export function decideRecallPolicyForText(text: string): RecallPolicyResult {
  const normalized = text.trim()
  if (!normalized) {
    return asyncRecall('empty_user_message')
  }

  if (SKIP_RECALL_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { policy: 'SKIP_RECALL', reason: 'explicit_skip_recall' }
  }

  if (SYNC_RECALL_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { policy: 'SYNC_RECALL', reason: 'explicit_history_reference' }
  }

  return asyncRecall('default_async_recall')
}

export function normalizeRecallPolicyResult(
  result: unknown,
): RecallPolicyResult {
  if (
    typeof result === 'object' &&
    result !== null &&
    isRecallPolicy((result as RecallPolicyResult).policy) &&
    typeof (result as RecallPolicyResult).reason === 'string'
  ) {
    return result as RecallPolicyResult
  }

  return asyncRecall('invalid_gate_output')
}

export async function resolveRecallPolicyGate(
  candidate: Promise<unknown>,
  options: { timeoutMs?: number } = {},
): Promise<RecallPolicyResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_RECALL_POLICY_TIMEOUT_MS
    const timeout = new Promise<RecallPolicyResult>(resolve => {
      timeoutId = setTimeout(() => {
        resolve(asyncRecall('gate_timeout', true))
      }, timeoutMs)
    })

    return await Promise.race([
      candidate.then(normalizeRecallPolicyResult),
      timeout,
    ])
  } catch {
    return asyncRecall('gate_error')
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }
}

export async function decideRecallPolicy(args: {
  messages: readonly Message[]
  signal: AbortSignal
}): Promise<RecallPolicyResult> {
  try {
    if (args.signal.aborted) {
      return asyncRecall('gate_aborted')
    }

    const userText = getLatestRealUserText(args.messages)
    if (userText === null) {
      return asyncRecall('no_user_message')
    }

    return await resolveRecallPolicyGate(
      Promise.resolve(decideRecallPolicyForText(userText)),
    )
  } catch {
    return asyncRecall('gate_error')
  }
}
