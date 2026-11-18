import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export interface SubagentMetrics {
	parentSessionId: string;
	childSessionId: string;
	agentId: string;
	role: string;
	calls: number;
	compacted: boolean;
	contextPercent: number | null;
	contextTokens: number | null;
	contextWindow: number | null;
	shouldRotate: boolean;
	rotateReasons: string[];
	updatedAt: string;
}

const CUSTOM_ENTRY_TYPE = "pilot-metrics";
const BATCH_MARKER = "[PILOT-BATCH]";

// In-memory cache keyed by `${parentSessionId}::${agentId}`
const metricsStore = new Map<string, SubagentMetrics>();
// Track counted message keys per child session to prevent duplicate counting within a batch
const countedMessageKeys = new Map<string, Set<string>>();

function computeRotation(
	calls: number,
	compacted: boolean,
	contextPercent: number | null,
	contextTokens: number | null,
): { shouldRotate: boolean; rotateReasons: string[] } {
	const rotateReasons: string[] = [];
	if (calls >= 5) {
		rotateReasons.push("calls_reached_5");
	}
	if (compacted) {
		rotateReasons.push("compacted_once");
	}
	if (contextPercent !== null && contextPercent > 40) {
		rotateReasons.push("context_percent_exceeded_40");
	}
	if (contextTokens !== null && contextTokens > 400_000) {
		rotateReasons.push("context_tokens_exceeded_400k");
	}
	return {
		shouldRotate: rotateReasons.length > 0,
		rotateReasons,
	};
}

function resolveRootSessionStem(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (ctx.agent.kind === "main") {
		if (sessionFile && sessionFile.endsWith(".jsonl")) {
			return path.resolve(sessionFile.slice(0, -".jsonl".length));
		}
		return ctx.agent.id || "Main";
	}
	const parentSession = ctx.sessionManager.getHeader()?.parentSession;
	if (typeof parentSession === "string" && parentSession.endsWith(".jsonl")) {
		return path.resolve(parentSession.slice(0, -".jsonl".length));
	}
	if (sessionFile && sessionFile.endsWith(".jsonl")) {
		const parentDir = path.resolve(path.dirname(sessionFile));
		const tmpRoot = path.resolve(os.tmpdir());
		if (!parentDir.toLowerCase().startsWith(tmpRoot.toLowerCase())) {
			return parentDir;
		}
	}
	return ctx.agent.parentId ?? "Main";
}

function extractMessageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const msg = message as Record<string, unknown>;
	const parts: string[] = [];
	if (typeof msg.details === "object" && msg.details !== null) {
		const detailsMsg = (msg.details as Record<string, unknown>).message;
		if (typeof detailsMsg === "string") {
			parts.push(detailsMsg);
		}
	}
	const content = msg.content;
	if (typeof content === "string") {
		parts.push(content);
	} else if (Array.isArray(content)) {
		for (const item of content) {
			if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
				parts.push((item as Record<string, unknown>).text as string);
			}
		}
	}
	return parts.join("\n");
}

function readMetricsFromTranscriptFile(
	transcriptPath: string,
	fallbackParentSessionId: string,
): SubagentMetrics | null {
	try {
		const raw = fs.readFileSync(transcriptPath, "utf-8");
		const lines = raw.split(/\r?\n/);
		let latestMetrics: SubagentMetrics | null = null;
		let hasCompactionEntry = false;

		for (const line of lines) {
			if (!line.trim()) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (record.type === "compaction") {
				hasCompactionEntry = true;
			}
			if (record.type === "custom" && record.customType === CUSTOM_ENTRY_TYPE && record.data) {
				latestMetrics = record.data as SubagentMetrics;
			}
		}

		if (latestMetrics) {
			const compacted = Boolean(latestMetrics.compacted || hasCompactionEntry);
			const { shouldRotate, rotateReasons } = computeRotation(
				latestMetrics.calls,
				compacted,
				latestMetrics.contextPercent ?? null,
				latestMetrics.contextTokens ?? null,
			);
			return {
				...latestMetrics,
				parentSessionId: latestMetrics.parentSessionId || fallbackParentSessionId,
				compacted,
				shouldRotate,
				rotateReasons,
			};
		}
		return null;
	} catch {
		return null;
	}
}

function scanPersistedSubagentMetrics(rootStem: string): SubagentMetrics[] {
	const results = new Map<string, SubagentMetrics>();
	try {
		if (fs.existsSync(rootStem) && fs.statSync(rootStem).isDirectory()) {
			const entries = fs.readdirSync(rootStem, { withFileTypes: true });
			for (const entry of entries) {
				if (
					!entry.isFile() ||
					!entry.name.endsWith(".jsonl") ||
					entry.name.includes(".bak") ||
					entry.name.startsWith("__advisor")
				) {
					continue;
				}
				const filePath = path.join(rootStem, entry.name);
				const parsed = readMetricsFromTranscriptFile(filePath, rootStem);
				if (parsed) {
					results.set(`${rootStem}::${parsed.agentId}`, parsed);
				}
			}
		}
	} catch {
		// Ignore directory scan errors when no subagent transcripts exist yet
	}

	for (const [key, mem] of metricsStore.entries()) {
		if (mem.parentSessionId === rootStem) {
			const existing = results.get(key);
			if (!existing || mem.updatedAt >= existing.updatedAt || mem.calls >= existing.calls) {
				results.set(key, mem);
			}
		}
	}
	return Array.from(results.values());
}

export default function pilotSessionMetricsExtension(pi: ExtensionAPI): void {
	function isTrackedSubagent(ctx: ExtensionContext): boolean {
		return ctx.agent.kind === "sub" && ctx.agent.name !== "advisor" && !ctx.agent.id.includes("/advisor");
	}

	function loadOrInitMetrics(ctx: ExtensionContext): SubagentMetrics {
		const parentSessionId = resolveRootSessionStem(ctx);
		const agentId = ctx.agent.id;
		const key = `${parentSessionId}::${agentId}`;
		const cached = metricsStore.get(key);
		if (cached) {
			return cached;
		}

		let restored: SubagentMetrics | null = null;
		let hasCompaction = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "compaction") {
				hasCompaction = true;
			}
			if (entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE && entry.data) {
				restored = entry.data as SubagentMetrics;
			}
		}

		const calls = restored?.calls ?? 0;
		const compacted = Boolean(restored?.compacted || hasCompaction);
		const contextPercent = restored?.contextPercent ?? null;
		const contextTokens = restored?.contextTokens ?? null;
		const contextWindow = restored?.contextWindow ?? null;
		const { shouldRotate, rotateReasons } = computeRotation(calls, compacted, contextPercent, contextTokens);

		const initial: SubagentMetrics = {
			parentSessionId,
			childSessionId: ctx.sessionManager.getSessionId(),
			agentId,
			role: ctx.agent.name || "sub",
			calls,
			compacted,
			contextPercent,
			contextTokens,
			contextWindow,
			shouldRotate,
			rotateReasons,
			updatedAt: restored?.updatedAt ?? new Date().toISOString(),
		};
		metricsStore.set(key, initial);
		return initial;
	}

	function refreshUsageAndPersist(
		ctx: ExtensionContext,
		mutator?: (current: SubagentMetrics) => void,
	): SubagentMetrics {
		const current = loadOrInitMetrics(ctx);
		if (mutator) {
			mutator(current);
		}

		const usage = ctx.getContextUsage();
		// Every sample replaces capacity state: a model switch must not retain
		// the previous model's window, and unknown capacity is not 0% usage.
		current.contextTokens =
			usage && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? Math.round(usage.tokens) : null;
		current.contextWindow =
			usage && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
				? Math.round(usage.contextWindow)
				: null;
		current.contextPercent =
			current.contextTokens !== null && current.contextWindow !== null
				? Number(((current.contextTokens / current.contextWindow) * 100).toFixed(2))
				: null;

		const { shouldRotate, rotateReasons } = computeRotation(
			current.calls,
			current.compacted,
			current.contextPercent,
			current.contextTokens,
		);
		current.shouldRotate = shouldRotate;
		current.rotateReasons = rotateReasons;
		current.updatedAt = new Date().toISOString();

		const key = `${current.parentSessionId}::${current.agentId}`;
		metricsStore.set(key, { ...current });
		pi.appendEntry(CUSTOM_ENTRY_TYPE, { ...current });
		return current;
	}

	function recordBatchIfEligible(
		ctx: ExtensionContext,
		messageKey: string,
		text: string,
		isInitialPrompt: boolean,
	): void {
		if (!isTrackedSubagent(ctx)) return;
		const current = loadOrInitMetrics(ctx);
		const isExplicitBatch = text.includes(BATCH_MARKER);
		const isFirstCall = current.calls === 0 && isInitialPrompt;
		if (!isExplicitBatch && !isFirstCall) {
			return;
		}

		const sessionKey = `${current.parentSessionId}::${current.agentId}`;
		let seen = countedMessageKeys.get(sessionKey);
		if (!seen) {
			seen = new Set<string>();
			countedMessageKeys.set(sessionKey, seen);
		}
		if (seen.has(messageKey)) {
			return;
		}
		seen.add(messageKey);

		refreshUsageAndPersist(ctx, m => {
			m.calls += 1;
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (!isTrackedSubagent(ctx)) return;
		loadOrInitMetrics(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		if (!isTrackedSubagent(ctx)) return;
		const msg = event.message as unknown as Record<string, unknown>;
		const role = msg?.role;
		if (role !== "user" && role !== "custom") return;
		const text = extractMessageText(msg);
		if (!text.trim()) return;
		const current = loadOrInitMetrics(ctx);
		const ts = typeof msg.timestamp === "number" ? String(msg.timestamp) : text.trim().slice(0, 120);
		const key = `msg:${role}:${ts}:${text.trim().slice(0, 120)}`;
		recordBatchIfEligible(ctx, key, text, current.calls === 0 && role === "user");
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!isTrackedSubagent(ctx)) return;
		refreshUsageAndPersist(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!isTrackedSubagent(ctx)) return;
		refreshUsageAndPersist(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!isTrackedSubagent(ctx)) return;
		refreshUsageAndPersist(ctx, m => {
			m.compacted = true;
		});
	});

	pi.on("auto_compaction_end", (event, ctx) => {
		if (!isTrackedSubagent(ctx)) return;
		if (event.aborted || event.skipped || event.errorMessage || !event.result) {
			return;
		}
		refreshUsageAndPersist(ctx, m => {
			m.compacted = true;
		});
	});

	const { Type } = pi.typebox;
	pi.registerTool({
		name: "pilot_session_status",
		label: "Pilot Session Status",
		description:
			"Read subagent session metrics (calls, compacted, contextPercent, contextTokens, shouldRotate, rotateReasons) for the current main session, including parked/unawakened subagents.",
		parameters: Type.Object({
			agentId: Type.Optional(
				Type.String({
					description: "Optional subagent ID (e.g. '0-Implementer' or '1-Reviewer') to filter.",
				}),
			),
			childSessionId: Type.Optional(
				Type.String({
					description: "Optional child session UUID to filter.",
				}),
			),
			role: Type.Optional(
				Type.String({
					description: "Optional subagent role ('implementer' or 'reviewer') to filter.",
				}),
			),
		}),
		approval: "read",
		loadMode: "essential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const rootStem = resolveRootSessionStem(ctx);
			const allMetrics = scanPersistedSubagentMetrics(rootStem);
			const filtered = allMetrics.filter(item => {
				if (params.agentId && item.agentId.toLowerCase() !== params.agentId.toLowerCase()) {
					return false;
				}
				if (params.childSessionId && item.childSessionId !== params.childSessionId) {
					return false;
				}
				if (params.role && item.role.toLowerCase() !== params.role.toLowerCase()) {
					return false;
				}
				return true;
			});

			const payload = {
				parentSessionId: rootStem,
				count: filtered.length,
				subagents: filtered,
			};
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(payload, null, 2),
					},
				],
				details: payload,
			};
		},
	});
}
