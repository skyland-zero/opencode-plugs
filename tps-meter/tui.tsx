/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"

/**
 * TPS meter for OpenCode V2.
 *
 * Shows a live tokens-per-second gauge, time-to-first-token (τ), a sparkline of
 * recent responses, and session averages in the prompt footer. Subagent sessions
 * are folded into the parent's readout.
 */

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
const HBLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]
const GAUGE_LEN = 11
const GAUGE_FLOOR = 40
const TRACK = "·"

const WINDOW_MS = 60_000
const SPARK_LEN = 12
const ALLTIME_CAP = 500
const MIN_DECODE_MS = 200
const MAX_PLAUSIBLE_TPS = 1_000
const FAST = 50
const MED = 20
const TTFT_FAST_MS = 1_000
const TTFT_MED_MS = 3_000
const TICK_MS = 200
const MAX_EXECUTION_ANCHOR_MS = 120_000

type Sample = { tps: number; at: number }

type Series = {
  samples: Sample[]
  spark: number[]
  sparkMax: number
  ttftSum: number
  ttftCount: number
  merged: number
}

type Live = {
  sessionID: string
  startedAt: number
  firstTokenAt: number
  streamEndAt: number
  chars: number
  tokens: number
  lastAt: number
}

type Segment = { text: string; fg: RGBA }

type Options = {
  mergeAgents: boolean
  mergeStats: boolean
  sparkline: boolean
  gauge: boolean
  compact: boolean
  slot: "status" | "footer"
  windowMs: number
  sparkLength: number
  fast: number
  medium: number
  minDecodeMs: number
  maxTps: number
  ttftFastMs: number
  ttftMedMs: number
  animate: boolean
}

function readOptions(input: Readonly<Record<string, unknown>>): Options {
  const bool = (key: string, fallback: boolean) =>
    typeof input[key] === "boolean" ? input[key] : fallback
  const num = (key: string, fallback: number) =>
    typeof input[key] === "number" && Number.isFinite(input[key]) ? input[key] : fallback
  return {
    mergeAgents: bool("mergeAgents", true),
    mergeStats: bool("mergeStats", true),
    sparkline: bool("sparkline", true),
    gauge: bool("gauge", true),
    compact: bool("compact", false),
    slot: input.slot === "footer" ? "footer" : "status",
    windowMs: Math.max(1_000, num("windowMs", WINDOW_MS)),
    sparkLength: Math.max(1, Math.min(32, Math.floor(num("sparkLength", SPARK_LEN)))),
    fast: Math.max(1, num("fast", FAST)),
    medium: Math.max(1, num("medium", MED)),
    minDecodeMs: Math.max(0, num("minDecodeMs", MIN_DECODE_MS)),
    maxTps: Math.max(1, num("maxTps", MAX_PLAUSIBLE_TPS)),
    ttftFastMs: Math.max(1, num("ttftFastMs", TTFT_FAST_MS)),
    ttftMedMs: Math.max(1, num("ttftMedMs", TTFT_MED_MS)),
    animate: bool("animate", true),
  }
}

function fmt(value: number): string {
  if (value < 10) return value.toFixed(1)
  return Math.round(value).toString()
}

function fmtMs(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`
  return `${(ms / 1_000).toFixed(1)}s`
}

function newSeries(): Series {
  return { samples: [], spark: [], sparkMax: 0, ttftSum: 0, ttftCount: 0, merged: 0 }
}

function resetSeries(series: Series): void {
  series.samples.length = 0
  series.spark.length = 0
  series.sparkMax = 0
  series.ttftSum = 0
  series.ttftCount = 0
  series.merged = 0
}

function seriesMean(series: Series): number {
  if (series.samples.length === 0) return 0
  return series.samples.reduce((total, sample) => total + sample.tps, 0) / series.samples.length
}

function seriesP95(series: Series): number {
  if (series.samples.length === 0) return 0
  const values = series.samples.map((sample) => sample.tps).sort((left, right) => left - right)
  return values[Math.ceil(values.length * 0.95) - 1] ?? 0
}

function seriesAvg(series: Series, windowMs: number): number {
  const cutoff = Date.now() - windowMs
  let total = 0
  let count = 0
  for (const sample of series.samples) {
    if (sample.at < cutoff) continue
    total += sample.tps
    count++
  }
  return count === 0 ? seriesMean(series) : total / count
}

export default Plugin.define({
  id: "local.tps-meter",
  setup(context) {
    const options = readOptions(context.options)
    const [now, setNow] = createSignal(Date.now())
    const [version, setVersion] = createSignal(0)

    const seriesBySession = new Map<string, Series>()
    const liveBySession = new Map<string, Live>()
    const parents = new Map<string, string | undefined>()
    const executionAnchor = new Map<string, number>()
    const executionConsumed = new Set<string>()
    const lastEnded = new Map<string, number>()

    let timer: ReturnType<typeof setInterval> | undefined

    const bump = () => setVersion((value) => value + 1)

    const ensureTimer = () => {
      if (timer) return
      timer = setInterval(() => {
        const nowMs = Date.now()
        setNow(nowMs)
        let reaped = false
        for (const [sessionID, live] of liveBySession) {
          if (live.streamEndAt > 0) continue
          const limit = live.firstTokenAt === 0 ? 600_000 : 30_000
          if (nowMs - live.lastAt <= limit) continue
          liveBySession.delete(sessionID)
          lastEnded.set(sessionID, nowMs)
          reaped = true
        }
        if (!reaped) return
        bump()
        maybeStopTimer()
      }, TICK_MS)
    }

    const hasActiveLive = () => {
      for (const live of liveBySession.values()) {
        if (live.streamEndAt === 0) return true
      }
      return false
    }

    const maybeStopTimer = () => {
      if (!timer || hasActiveLive()) return
      clearInterval(timer)
      timer = undefined
    }

    const seriesFor = (sessionID: string) => {
      let series = seriesBySession.get(sessionID)
      if (!series) {
        series = newSeries()
        seriesBySession.set(sessionID, series)
      }
      return series
    }

    const parentOf = (sessionID: string) => {
      if (parents.has(sessionID)) return parents.get(sessionID)
      const info = context.data.session.get(sessionID)
      if (!info) return undefined
      parents.set(sessionID, info.parentID)
      return info.parentID
    }

    const ancestorsOf = (sessionID: string) => {
      const chain: string[] = []
      const seen = new Set<string>()
      let current: string | undefined = sessionID
      while (current && !seen.has(current)) {
        seen.add(current)
        chain.push(current)
        current = parentOf(current)
      }
      return chain
    }

    const pushTtft = (series: Series, ttftMs: number) => {
      series.ttftSum += ttftMs
      series.ttftCount++
    }

    const pushSample = (series: Series, tps: number) => {
      series.samples.push({ tps, at: Date.now() })
      if (series.samples.length > ALLTIME_CAP) series.samples.shift()
      series.spark.push(tps)
      if (series.spark.length > options.sparkLength) series.spark.shift()
      series.sparkMax = Math.max(tps, series.sparkMax * 0.99)
    }

    const settle = (
      sessionID: string,
      endedAt: number,
      tokens: { output: number; reasoning: number } | undefined,
    ) => {
      const end = endedAt > 0 ? endedAt : Date.now()
      lastEnded.set(sessionID, end)
      const live = liveBySession.get(sessionID)
      if (!live) return
      liveBySession.delete(sessionID)

      const firstTokenAt = live.firstTokenAt
      const ttft = firstTokenAt > 0 ? Math.max(0, firstTokenAt - live.startedAt) : 0
      const reported = tokens ? (tokens.output ?? 0) + (tokens.reasoning ?? 0) : 0
      const count = reported > 0 ? reported : live.tokens
      const decodeEnd = live.streamEndAt > 0 ? live.streamEndAt : end
      const decodeMs = firstTokenAt > 0 ? Math.max(0, decodeEnd - firstTokenAt) : 0
      const raw = count > 0 && decodeMs > 0 ? count / (decodeMs / 1_000) : 0
      const tps = decodeMs >= options.minDecodeMs && raw <= options.maxTps ? raw : 0

      const chain = options.mergeStats ? ancestorsOf(sessionID) : [sessionID]
      for (const [index, id] of chain.entries()) {
        const series = seriesFor(id)
        if (ttft > 0) pushTtft(series, ttft)
        if (tps > 0) pushSample(series, tps)
        if (index > 0 && (ttft > 0 || tps > 0)) series.merged++
      }
    }

    const clearLive = (sessionID: string) => {
      if (liveBySession.delete(sessionID)) lastEnded.set(sessionID, Date.now())
    }

    const liveFamily = (sessionID: string) => {
      const active = [...liveBySession.values()].filter((live) => live.streamEndAt === 0)
      if (!options.mergeAgents) return active.filter((live) => live.sessionID === sessionID)
      return active.filter((live) => ancestorsOf(live.sessionID).includes(sessionID))
    }

    const rateOf = (live: Live, nowMs: number) => {
      if (live.firstTokenAt === 0 || live.tokens <= 0) return 0
      const elapsed = (nowMs - live.firstTokenAt) / 1_000
      if (elapsed <= 0.3) return 0
      return live.tokens / elapsed
    }

    const ttftOf = (live: Live, nowMs: number) =>
      live.firstTokenAt > 0 ? Math.max(0, live.firstTokenAt - live.startedAt) : Math.max(0, nowMs - live.startedAt)

    const speedColor = (tps: number) => {
      if (tps >= options.fast) return context.theme.text.feedback.success.base
      if (tps >= options.medium) return context.theme.text.feedback.warning.base
      return context.theme.text.feedback.error.base
    }

    const ttftColor = (ms: number) => {
      if (ms < options.ttftFastMs) return context.theme.text.feedback.success.base
      if (ms < options.ttftMedMs) return context.theme.text.feedback.warning.base
      return context.theme.text.feedback.error.base
    }

    const gaugeSegments = (tps: number, scale: number): Segment[] => {
      const fraction = scale > 0 ? Math.max(0, Math.min(1, tps / scale)) : 0
      const eighths = Math.round(fraction * GAUGE_LEN * 8)
      const full = Math.floor(eighths / 8)
      const remainder = eighths % 8
      const partial = full < GAUGE_LEN && remainder > 0 ? HBLOCKS[remainder] : ""
      const fill = "█".repeat(full) + partial
      const used = full + (partial ? 1 : 0)
      const track = TRACK.repeat(Math.max(0, GAUGE_LEN - used))
      return [
        { text: "▕", fg: context.theme.text.muted },
        { text: fill, fg: speedColor(tps) },
        { text: track + "▏", fg: context.theme.text.muted },
        { text: " ", fg: context.theme.text.muted },
      ]
    }

    const sparkSegments = (series: Series): Segment[] => {
      if (!options.sparkline || series.spark.length === 0) return []
      const values = series.spark
      const padding = Math.max(0, options.sparkLength - values.length)
      const segments: Segment[] = []
      if (padding > 0) segments.push({ text: TRACK.repeat(padding), fg: context.theme.text.muted })
      let min = Infinity
      let max = 0
      for (const value of values) {
        if (value < min) min = value
        if (value > max) max = value
      }
      const range = max - min
      for (const value of values) {
        const normalized =
          range < 1e-6
            ? max > 0
              ? 4
              : 0
            : Math.min(7, Math.max(0, Math.round(((value - min) / range) * 7)))
        segments.push({ text: BLOCKS[normalized] ?? "▁", fg: speedColor(value) })
      }
      segments.push({ text: " ", fg: context.theme.text.muted })
      return segments
    }

    const finalSegments = (series: Series, width: number): Segment[] => {
      const muted = context.theme.text.muted
      const avg = seriesAvg(series, options.windowMs)
      const mean = seriesMean(series)
      const p95 = seriesP95(series)
      const ttftMean = series.ttftCount > 0 ? series.ttftSum / series.ttftCount : 0
      const segments: Segment[] = []

      if (series.samples.length === 0) {
        if (ttftMean <= 0) return []
        if (series.merged > 0) segments.push({ text: "Σ ", fg: muted })
        segments.push({ text: "τ", fg: muted })
        segments.push({ text: fmtMs(ttftMean), fg: ttftColor(ttftMean) })
        return segments
      }

      const roomy = !options.compact && width >= 100
      const medium = !options.compact && width >= 70
      if (roomy) segments.push(...sparkSegments(series))
      if (series.merged > 0) segments.push({ text: "Σ ", fg: muted })
      segments.push({ text: fmt(avg), fg: speedColor(avg) })
      segments.push({ text: " tps", fg: muted })
      if (medium) {
        segments.push({ text: " · ", fg: muted })
        segments.push({ text: "μ ", fg: muted })
        segments.push({ text: fmt(mean), fg: speedColor(mean) })
      }
      if (roomy) {
        segments.push({ text: " · ", fg: muted })
        segments.push({ text: "p95 ", fg: muted })
        segments.push({ text: fmt(p95), fg: speedColor(p95) })
      }
      if (ttftMean > 0 && width >= 55) {
        segments.push({ text: " · τ", fg: muted })
        segments.push({ text: fmtMs(ttftMean), fg: ttftColor(ttftMean) })
      }
      return segments
    }

    const buildView = (sessionID: string, width: number) => {
      const series = seriesBySession.get(sessionID)
      const lives = liveFamily(sessionID)
      const own = lives.find((live) => live.sessionID === sessionID)
      const others = lives.filter((live) => live.sessionID !== sessionID)
      const nowMs = now()

      if (lives.length > 0) {
        const ownRate = own ? rateOf(own, nowMs) : 0
        const agentRates = others.map((live) => rateOf(live, nowMs))
        const agentSum = agentRates.reduce((total, rate) => total + rate, 0)
        const total = ownRate + agentSum
        const agentCount = others.length
        const merged = agentCount > 0 || (series?.merged ?? 0) > 0
        const ttft = own
          ? ttftOf(own, nowMs)
          : lives.reduce((max, live) => Math.max(max, ttftOf(live, nowMs)), 0)
        const muted = context.theme.text.muted
        const segments: Segment[] = []

        if (options.animate) {
          segments.push({
            text: SPIN[Math.floor(nowMs / TICK_MS) % SPIN.length] ?? "⠋",
            fg: context.theme.hue.accent[500],
          })
          segments.push({ text: " ", fg: muted })
        }

        if (options.gauge && width >= 60) {
          const scale = Math.max(GAUGE_FLOOR, series?.sparkMax ?? 0, total)
          segments.push(...gaugeSegments(total, scale))
        }

        if (total <= 0 && ttft > 0) {
          if (merged && agentCount > 0) segments.push({ text: "Σ ", fg: muted })
          segments.push({ text: "τ", fg: muted })
          segments.push({ text: fmtMs(ttft), fg: ttftColor(ttft) })
          if (agentCount > 0) segments.push({ text: ` · ${agentCount}a`, fg: muted })
        } else {
          if (merged && agentCount > 0) segments.push({ text: "Σ ", fg: muted })
          segments.push({ text: fmt(total), fg: speedColor(total) })
          segments.push({ text: " tps", fg: muted })
          if (agentCount > 0) segments.push({ text: ` · ${agentCount}a`, fg: muted })
          if (ttft > 0) {
            segments.push({ text: " · τ", fg: muted })
            segments.push({ text: fmtMs(ttft), fg: ttftColor(ttft) })
          }
        }
        return segments
      }

      if (!series) return []
      return finalSegments(series, width)
    }

    const summary = (sessionID: string) => {
      const series = seriesBySession.get(sessionID)
      if (!series || (series.samples.length === 0 && series.ttftCount === 0)) return "No samples yet"
      const parts: string[] = []
      if (series.samples.length > 0) {
        parts.push(`avg ${fmt(seriesAvg(series, options.windowMs))} tps`)
        parts.push(`μ ${fmt(seriesMean(series))} tps`)
        parts.push(`p95 ${fmt(seriesP95(series))} tps`)
        parts.push(`${series.samples.length} samples`)
      }
      if (series.ttftCount > 0) parts.push(`τ ${fmtMs(series.ttftSum / series.ttftCount)}`)
      return parts.join(" · ")
    }

    const currentSession = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const stop = context.data.listen(({ details }) => {
      switch (details.type) {
        case "session.created": {
          parents.set(details.data.sessionID, details.data.parentID)
          break
        }
        case "session.deleted": {
          const sessionID = details.data.sessionID
          parents.delete(sessionID)
          seriesBySession.delete(sessionID)
          clearLive(sessionID)
          lastEnded.delete(sessionID)
          maybeStopTimer()
          bump()
          break
        }
        case "session.execution.started": {
          const sessionID = details.data.sessionID
          executionAnchor.set(sessionID, details.created > 0 ? details.created : Date.now())
          executionConsumed.delete(sessionID)
          break
        }
        case "session.step.started": {
          const sessionID = details.data.sessionID
          const started =
            typeof details.data.started === "number" && details.data.started > 0
              ? details.data.started
              : details.created
          const anchor = executionAnchor.get(sessionID)
          const useAnchor =
            anchor !== undefined &&
            !executionConsumed.has(sessionID) &&
            anchor <= started &&
            started - anchor <= MAX_EXECUTION_ANCHOR_MS
          liveBySession.set(sessionID, {
            sessionID,
            startedAt: useAnchor ? anchor : started,
            firstTokenAt: 0,
            streamEndAt: 0,
            chars: 0,
            tokens: 0,
            lastAt: details.created > 0 ? details.created : started,
          })
          executionConsumed.add(sessionID)
          lastEnded.delete(sessionID)
          ensureTimer()
          bump()
          break
        }
        case "session.text.delta":
        case "session.reasoning.delta":
        case "session.tool.input.delta": {
          const sessionID = details.data.sessionID
          const delta = details.data.delta
          if (!delta) break
          const created = details.created > 0 ? details.created : Date.now()
          let live = liveBySession.get(sessionID)
          if (!live) {
            if (created <= (lastEnded.get(sessionID) ?? 0)) break
            live = {
              sessionID,
              startedAt: created,
              firstTokenAt: created,
              streamEndAt: 0,
              chars: 0,
              tokens: 0,
              lastAt: created,
            }
            liveBySession.set(sessionID, live)
          }
          if (live.firstTokenAt === 0) live.firstTokenAt = created
          live.chars += delta.length
          live.tokens = Math.ceil(live.chars / 4)
          live.lastAt = created
          ensureTimer()
          break
        }
        case "session.step.streamed": {
          const live = liveBySession.get(details.data.sessionID)
          if (!live) break
          live.streamEndAt = details.created > 0 ? details.created : Date.now()
          maybeStopTimer()
          bump()
          break
        }
        case "session.step.ended": {
          settle(details.data.sessionID, details.created, details.data.tokens)
          maybeStopTimer()
          bump()
          break
        }
        case "session.step.failed": {
          settle(details.data.sessionID, details.created, details.data.tokens)
          maybeStopTimer()
          bump()
          break
        }
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted": {
          const sessionID = details.data.sessionID
          executionAnchor.delete(sessionID)
          executionConsumed.delete(sessionID)
          clearLive(sessionID)
          maybeStopTimer()
          bump()
          break
        }
        case "session.idle": {
          const sessionID = details.data.sessionID
          executionAnchor.delete(sessionID)
          executionConsumed.delete(sessionID)
          clearLive(sessionID)
          maybeStopTimer()
          bump()
          break
        }
      }
    })

    function Meter(props: { readonly sessionID?: string }) {
      const dimensions = useTerminalDimensions()
      const view = createMemo(() => {
        version()
        now()
        if (!props.sessionID) return []
        return buildView(props.sessionID, dimensions().width)
      })
      const maxWidth = () => Math.max(16, Math.floor(dimensions().width * 0.55))

      return (
        <Show when={view().length > 0}>
          <box flexDirection="row" flexShrink={1} minWidth={0} maxWidth={maxWidth()}>
            <text wrapMode="none" truncate>
              {view().map((segment) => (
                <span style={{ fg: segment.fg }}>{segment.text}</span>
              ))}
            </text>
          </box>
        </Show>
      )
    }

    const render = (input: { readonly sessionID?: string }) => <Meter sessionID={input.sessionID} />
    const offSlot =
      options.slot === "footer"
        ? context.ui.slot({ append: "prompt.footer", render })
        : context.ui.slot({ append: "prompt.footer.status", render })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "tps.status",
          title: "TPS meter",
          description: "Show or reset tokens-per-second statistics",
          group: "TPS",
          palette: true,
          slash: { name: "tps", arguments: true },
          run(input) {
            const sessionID = currentSession()
            if (!sessionID) {
              context.ui.toast.show({ message: "Open a session first", variant: "warning" })
              return
            }
            if (input?.trim().toLowerCase() === "reset") {
              const series = seriesBySession.get(sessionID)
              if (series) resetSeries(series)
              bump()
              context.ui.toast.show({ message: "TPS meter reset", variant: "success" })
              return
            }
            context.ui.toast.show({ title: "TPS meter", message: summary(sessionID) })
          },
        },
      ],
    }))

    return () => {
      offSlot()
      stop()
      if (timer) clearInterval(timer)
      timer = undefined
      seriesBySession.clear()
      liveBySession.clear()
      parents.clear()
      executionAnchor.clear()
      executionConsumed.clear()
      lastEnded.clear()
    }
  },
})
