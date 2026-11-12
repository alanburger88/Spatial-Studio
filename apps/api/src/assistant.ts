import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { fieldIndex, validateRule, type Project, type Rule, type SyntheticRecord } from '@iss/model';
import { describePredicate, explainNode, resolve, type Explanation, type Resolution } from '@iss/resolver';
import { EDGE_CASE_PRESETS, DIMENSIONS } from '@iss/scenarios';

/* ------------------------------------------------------- typed allowlist */

const VIEWS = ['design', 'exploded', 'cube', 'landscape', 'page-stack', 'rules-data', 'journey', 'validate', 'outputs', 'demo', 'assistant'] as const;
const scalar = z.union([z.string().max(200), z.number().int(), z.boolean(), z.null()]);

export const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('select_scenario'), recordId: z.string().regex(/^(CARD|EOB)-\d{4}$/), overrides: z.record(z.string(), z.any()).optional() }).strict(),
  z.object({ action: z.literal('set_scenario_fields'), fields: z.record(z.string().regex(/^[a-zA-Z.]+$/), scalar) }).strict(),
  z.object({ action: z.literal('navigate_view'), view: z.enum(VIEWS), nodeId: z.string().optional() }).strict(),
  z.object({ action: z.literal('open_project'), projectId: z.enum(['aster-card-demo', 'harborcare-demo']) }).strict(),
  z.object({ action: z.literal('set_cube_axes'), axes: z.array(z.enum(DIMENSIONS.map((d) => d.id) as [string, ...string[]])).length(3) }).strict(),
  z.object({ action: z.literal('focus_component'), nodeId: z.string().max(64), view: z.enum(VIEWS).optional() }).strict(),
  z.object({ action: z.literal('explain_resolution'), nodeId: z.string().max(64) }).strict(),
  z.object({ action: z.literal('run_validation'), checks: z.array(z.enum(['rules', 'bindings', 'pagination', 'parity', 'accessibility'])).optional() }).strict(),
  z.object({ action: z.literal('compare_scenarios'), recordIds: z.array(z.string().regex(/^(CARD|EOB)-\d{4}$/)).length(2) }).strict(),
  z.object({ action: z.literal('generate_edge_case'), preset: z.enum(EDGE_CASE_PRESETS.map((p) => p.id) as [string, ...string[]]) }).strict(),
  z.object({ action: z.literal('propose_rule_edit'), ruleId: z.string().regex(/^R\d{2,3}$/), patch: z.object({ priority: z.number().int().min(0).max(10000).optional(), enabled: z.boolean().optional(), when: z.any().optional() }).strict() }).strict(),
  z.object({ action: z.literal('propose_content_edit'), contentPartId: z.string().max(64), locale: z.enum(['en-US', 'es-US']), text: z.string().max(600) }).strict(),
]);
export type AssistantAction = z.infer<typeof ActionSchema>;

export interface AssistantContext {
  project: Project;
  records: SyntheticRecord[];
  recordId: string;
  overrides: Record<string, unknown>;
  journeyCursor: number | null;
  selectedNodeId?: string | null;
}

export interface Proposal {
  proposalId: string;
  kind: 'rule' | 'content';
  status: 'approval_required';
  mutationApplied: false;
  targetId: string;
  before: unknown;
  after: unknown;
  validations: string[];
  impact: { evaluated: number; changed: number; sample: Array<{ recordId: string; before: string | null; after: string | null }> };
  command: { type: 'UPSERT_RULE'; rule: Rule } | { type: 'UPSERT_CONTENT_PART'; part: any };
  provenance: string;
  baseModelVersion: number;
}

export interface AssistantReply {
  mode: 'external' | 'offline';
  providerStatus: string;
  requestId: string;
  response: string;
  actions: AssistantAction[];
  rejected: Array<{ action: unknown; reason: string }>;
  explanation?: Explanation;
  proposal?: Proposal;
  scenarioPreview?: { recordId: string; overrides: Record<string, unknown>; runId: string; selectedVariants: Record<string, string | null>; matchedRuleIds: string[] };
}

/* ------------------------------------------------------ action validation */

export function validateActions(raw: unknown[], ctx: AssistantContext): { ok: AssistantAction[]; rejected: AssistantReply['rejected'] } {
  const ok: AssistantAction[] = [];
  const rejected: AssistantReply['rejected'] = [];
  const fields = fieldIndex(ctx.project.documentType);
  const nodeIds = new Set(ctx.project.nodes.map((n) => n.id));
  for (const a of raw.slice(0, 6)) {
    const parsed = ActionSchema.safeParse(a);
    if (!parsed.success) { rejected.push({ action: a, reason: 'Not an allowlisted, schema-valid action: ' + parsed.error.issues[0]?.message }); continue; }
    const act = parsed.data;
    if (act.action === 'select_scenario' && !ctx.records.some((r) => r.recordId === act.recordId)) { rejected.push({ action: a, reason: `Unknown synthetic record ${act.recordId}` }); continue; }
    if ((act.action === 'focus_component' || act.action === 'explain_resolution') && !nodeIds.has(act.nodeId)) { rejected.push({ action: a, reason: `Node ${act.nodeId} does not exist in ${ctx.project.projectId}` }); continue; }
    if (act.action === 'set_scenario_fields') {
      const bad = Object.entries(act.fields).find(([p, v]) => { const f = fields.get(p); if (!f || f.derived || f.type === 'array') return true; if (f.type === 'enum') return !f.enumValues!.includes(String(v)); if (f.type === 'bool') return typeof v !== 'boolean'; if (['int', 'cents', 'points'].includes(f.type)) return !Number.isInteger(v); return false; });
      if (bad) { rejected.push({ action: a, reason: `Field ${bad[0]}=${JSON.stringify(bad[1])} is not an allowlisted, type-valid scenario field` }); continue; }
    }
    if (act.action === 'propose_rule_edit' && !ctx.project.rules.some((r) => r.id === act.ruleId)) { rejected.push({ action: a, reason: `Unknown rule ${act.ruleId}` }); continue; }
    if (act.action === 'propose_content_edit' && !ctx.project.contentParts.some((c) => c.id === act.contentPartId)) { rejected.push({ action: a, reason: `Unknown content part ${act.contentPartId}` }); continue; }
    if (act.action === 'generate_edge_case' && EDGE_CASE_PRESETS.find((p) => p.id === act.preset)?.documentType !== ctx.project.documentType) { rejected.push({ action: a, reason: `${act.preset} does not apply to ${ctx.project.documentType}` }); continue; }
    ok.push(act);
  }
  return { ok, rejected };
}

function fieldsToOverrides(fields: Record<string, unknown>): Record<string, unknown> {
  const out: any = {};
  for (const [path, v] of Object.entries(fields)) {
    const parts = path.split('.');
    let t = out;
    for (const p of parts.slice(0, -1)) t = t[p] ??= {};
    t[parts[parts.length - 1]] = v;
  }
  return out;
}

function mergeDeep(a: any, b: any): any {
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeDeep(out[k], v) : v;
  return out;
}

/* ---------------------------------------------------------- offline parser */

const VIEW_WORDS: Array<[RegExp, (typeof VIEWS)[number]]> = [
  [/\bcube\b/i, 'cube'], [/\blandscape\b/i, 'landscape'], [/page stack|pages?\b.*stack|pagination/i, 'page-stack'], [/\bjourney|timeline|day 30|day 45/i, 'journey'],
  [/\bexport|pdf\b|html\b|afp/i, 'outputs'], [/\brules?\b.*(data|editor)|rule editor/i, 'rules-data'], [/explod/i, 'exploded'], [/\bdesign(er)?\b/i, 'design'],
];

export function offlineInterpret(message: string, ctx: AssistantContext): { reply: string; actions: unknown[] } {
  const m = message.trim();
  const actions: unknown[] = [];
  const notes: string[] = [];
  const isCard = ctx.project.documentType === 'credit-statement';
  const ids = m.match(/\b(CARD|EOB)-\d{4}\b/gi)?.map((s) => s.toUpperCase()) ?? [];

  if (/\b(eob|harbor ?care|health ?care|explanation of benefits)\b/i.test(m) && isCard && /switch|open|go|show/i.test(m)) { actions.push({ action: 'open_project', projectId: 'harborcare-demo' }); notes.push('open the HarborCare EOB project'); }
  if (/\b(aster|credit card|card statement|bank)\b/i.test(m) && !isCard && /switch|open|go|back/i.test(m)) { actions.push({ action: 'open_project', projectId: 'aster-card-demo' }); notes.push('open the Aster Card project'); }

  const ruleRef = /\b(R\d{2})\b/i.exec(m)?.[1]?.toUpperCase();
  const prio = /priority\s*(?:to|=|of)?\s*(\d{1,5})/i.exec(m);
  if (ruleRef && /(disable|turn off|switch off)/i.test(m)) { actions.push({ action: 'propose_rule_edit', ruleId: ruleRef, patch: { enabled: false } }); notes.push(`propose disabling ${ruleRef} (needs your approval)`); }
  else if (ruleRef && /(enable|turn on)/i.test(m)) { actions.push({ action: 'propose_rule_edit', ruleId: ruleRef, patch: { enabled: true } }); notes.push(`propose enabling ${ruleRef}`); }
  else if (ruleRef && prio) { actions.push({ action: 'propose_rule_edit', ruleId: ruleRef, patch: { priority: Number(prio[1]) } }); notes.push(`propose ${ruleRef} priority ${prio[1]} (needs your approval)`); }
  else if (ruleRef && /threshold|more than|greater than|over/i.test(m) && /(\d+)/.test(m.replace(ruleRef, ''))) {
    const rule = ctx.project.rules.find((r) => r.id === ruleRef);
    const n = Number(/(\d+)\s*$|(?:to|than|over)\s*(\d+)/i.exec(m.replace(ruleRef, ''))?.slice(1).find(Boolean) ?? NaN);
    if (rule && 'value' in rule.when && typeof (rule.when as any).value === 'number' && Number.isFinite(n)) { actions.push({ action: 'propose_rule_edit', ruleId: ruleRef, patch: { when: { ...rule.when, value: n } } }); notes.push(`propose ${ruleRef} threshold ${n}`); }
  }

  if (ids.length >= 2 && /compare/i.test(m)) { actions.push({ action: 'compare_scenarios', recordIds: ids.slice(0, 2) }); notes.push(`compare ${ids[0]} and ${ids[1]}`); }
  else if (ids.length) { actions.push({ action: 'select_scenario', recordId: ids[0] }); notes.push(`select ${ids[0]}`); }

  if (/edge case|generate/i.test(m)) {
    const preset = /spanish/i.test(m) ? 'spanish-missing-content' : /250|high.?volume|stress/i.test(m) ? 'stress-250' : /zero/i.test(m) ? 'zero-transactions' : /long/i.test(m) ? 'long-merchant' : /threshold/i.test(m) ? 'threshold-exact' : /denied|liabil/i.test(m) ? 'claim-denied-unknown-liability' : /several|multi/i.test(m) ? 'claim-several-lines' : isCard ? 'crossed-priorities' : 'claim-appeal';
    actions.push({ action: 'generate_edge_case', preset }); notes.push(`generate edge case “${preset}”`);
  } else if (isCard && !ids.length) {
    const fields: Record<string, unknown> = {};
    if (/spanish|español|es-US/i.test(m)) fields['customer.locale'] = 'es-US';
    if (/(two|2)\s+missed|missed\s+(two|2)/i.test(m)) { fields['card.missedPayments'] = 2; fields['card.paymentStatus'] = 'overdue'; }
    else if (/(one|1|a|first)\s+missed|missed\s+(one|1|a)\s+payment/i.test(m)) { fields['card.missedPayments'] = 1; fields['card.paymentStatus'] = 'overdue'; }
    if (/assistance|hardship|help paying/i.test(m) && /request|asked|wants|need/i.test(m)) { fields['card.assistanceRequested'] = true; fields['card.paymentStatus'] = 'overdue'; if (!('card.missedPayments' in fields)) fields['card.missedPayments'] = 2; }
    if (/arrangement/i.test(m) && /approv/i.test(m)) fields['card.arrangementStatus'] = 'approved';
    if (/premium|premier/i.test(m)) fields['card.tier'] = 'premium';
    if (/digital/i.test(m)) fields['card.channelPreference'] = 'digital';
    if (/paper|print/i.test(m) && !/pdf/i.test(m)) fields['card.channelPreference'] = 'print';
    if (Object.keys(fields).length) { actions.push({ action: 'set_scenario_fields', fields }); notes.push('set scenario ' + Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')); }
    else if (/assistance/i.test(m) && /(persona|customer|case|cardholder|select|choose|show)/i.test(m)) { actions.push({ action: 'select_scenario', recordId: 'CARD-0002' }); notes.push('select assistance case CARD-0002'); }
  } else if (!isCard && !ids.length) {
    const fields: Record<string, unknown> = {};
    if (/denied|review/i.test(m)) { fields['claim.status'] = 'denied-pending-review'; fields['claim.liabilityConfirmed'] = false; }
    if (/appeal/i.test(m)) fields['claim.status'] = 'appeal-filed';
    if (/out.of.network/i.test(m)) fields['claim.network'] = 'out-of-network';
    if (/covered|processed/i.test(m)) fields['claim.status'] = 'processed-covered';
    if (Object.keys(fields).length && /(show|select|set|customer|member|claim)/i.test(m) && !/why|explain/i.test(m)) { actions.push({ action: 'set_scenario_fields', fields }); notes.push('set scenario ' + Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')); }
  }

  const axes = DIMENSIONS.map((d) => d.id).filter((d) => new RegExp(`\\b${d === 'journey' ? 'journey' : d === 'output' ? 'output' : d === 'language' ? 'language' : d === 'persona' ? 'persona' : d}\\b`, 'i').test(m));
  if (/axes|axis/i.test(m) && axes.length === 3) { actions.push({ action: 'set_cube_axes', axes }); notes.push(`set cube axes ${axes.join(' × ')}`); }

  if (/\b(why|explain|reason)\b/i.test(m)) {
    const node = ctx.selectedNodeId && ctx.project.nodes.some((n) => n.id === ctx.selectedNodeId && (n.type === 'variant-set' || n.type === 'conditional-region')) ? ctx.selectedNodeId : ctx.project.nodes.find((n) => n.type === 'variant-set')?.id;
    if (node) { actions.push({ action: 'explain_resolution', nodeId: node }); notes.push(`explain ${node} from the engine trace`); }
  }
  if (/\b(validat|run checks|check (the|this) document)/i.test(m)) { actions.push({ action: 'run_validation' }); notes.push('run validation'); }
  if (!actions.some((a: any) => a.action === 'open_project')) for (const [re, view] of VIEW_WORDS) if (re.test(m) && /\b(open|show|go|navigate|take me|view)\b/i.test(m)) { actions.push({ action: 'navigate_view', view }); notes.push(`open ${view}`); break; }

  const reply = actions.length
    ? `Offline assistant (scripted capability): I recognised a request to ${notes.join('; ')}. The deterministic engine performs each action; nothing is changed without your approval.`
    : 'Offline assistant (scripted capability): I could not map that to a supported command. Try: “choose assistance case CARD-0002”, “explain the selected variant”, “show Spanish edge case”, “switch to EOB”, “run validation”, “open cube”, or “change R04 priority to 420”.';
  return { reply, actions };
}

/* ------------------------------------------------------- live provider */

export interface ProviderConfig { provider: string; model: string; apiKey?: string; baseUrl?: string; timeoutMs: number }

export function providerConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  return {
    provider: (env.AI_PROVIDER ?? 'offline').toLowerCase(),
    model: env.AI_MODEL || 'claude-opus-5-5',
    apiKey: env.AI_API_KEY || env.ANTHROPIC_API_KEY,
    baseUrl: env.AI_API_BASE_URL || undefined,
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 20000),
  };
}

export function providerStatus(cfg: ProviderConfig): { mode: 'external' | 'offline'; label: string; model?: string } {
  const live = (cfg.provider === 'anthropic' || cfg.provider === 'external') && !!cfg.apiKey;
  return live ? { mode: 'external', label: 'Live AI (server-side adapter)', model: cfg.model } : { mode: 'offline', label: 'Guided Assistant (offline)' };
}

const TOOL: Anthropic.Tool = {
  name: 'submit_actions',
  description: 'Return the allowlisted, typed actions that fulfil the user request plus a short reply. Never invent rule reasons; explanations are produced by the deterministic engine from explain_resolution.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reply', 'actions'],
    properties: {
      reply: { type: 'string', description: 'One or two sentences for the user. Do not assert why a variant appears; request explain_resolution instead.' },
      actions: { type: 'array', maxItems: 6, items: { type: 'object', description: 'One allowlisted action object, e.g. {"action":"select_scenario","recordId":"CARD-0002"}' } },
    },
  },
};

/**
 * Server-side Claude adapter. Sends only synthetic, allowlisted context; output is untrusted and
 * re-validated by `validateActions`. Any failure returns null so the caller falls back offline.
 */
export async function externalInterpret(cfg: ProviderConfig, message: string, ctx: AssistantContext, res: Resolution): Promise<{ reply: string; actions: unknown[] } | null> {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, timeout: cfg.timeoutMs, maxRetries: 1 });
  const system = [
    'You are the InfoSlips Spatial Studio assistant. You translate a designer request into allowlisted typed actions by calling submit_actions exactly once.',
    'Allowed actions: select_scenario{recordId,overrides?}, set_scenario_fields{fields: {path: value}}, navigate_view{view}, open_project{projectId}, set_cube_axes{axes[3]}, focus_component{nodeId,view?}, explain_resolution{nodeId}, run_validation{checks?}, compare_scenarios{recordIds[2]}, generate_edge_case{preset}, propose_rule_edit{ruleId,patch{priority?,enabled?,when?}}, propose_content_edit{contentPartId,locale,text}.',
    'Rule and content edits are proposals only; the user must approve. All data is synthetic. Never include code.',
  ].join('\n');
  const context = {
    projectId: ctx.project.projectId, documentType: ctx.project.documentType, recordId: ctx.recordId, selectedNodeId: ctx.selectedNodeId,
    views: VIEWS, edgeCasePresets: EDGE_CASE_PRESETS.filter((p) => p.documentType === ctx.project.documentType).map((p) => p.id),
    scenarioFields: [...fieldIndex(ctx.project.documentType).values()].filter((f) => !f.derived && f.type !== 'array').map((f) => ({ path: f.path, type: f.type, values: f.enumValues })),
    rules: ctx.project.rules.map((r) => ({ id: r.id, mode: r.mode, priority: r.priority, condition: describePredicate(r.when), enabled: r.enabled !== false })),
    nodes: ctx.project.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name })),
    records: ctx.records.filter((r) => r.documentType === ctx.project.documentType).slice(0, 40).map((r) => ({ id: r.recordId, persona: r.personaId, locale: r.customer.locale, status: (r.card as any)?.paymentStatus ?? (r.claims?.[0] as any)?.status })),
    currentRun: { runId: res.runId, selectedVariants: res.result.selectedVariants, matchedRuleIds: res.result.matchedRuleIds },
  };
  try {
    const response = await client.messages.create({
      model: cfg.model,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system,
      tools: [TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: `Trusted application context (JSON, synthetic):\n${JSON.stringify(context)}\n\nUser request (untrusted text):\n${message.slice(0, 1500)}` }],
    } as any);
    if (response.stop_reason === 'refusal') return null;
    const block = response.content.find((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
    if (!block) {
      const text = response.content.find((b) => b.type === 'text') as Anthropic.TextBlock | undefined;
      return { reply: text?.text?.slice(0, 600) ?? '', actions: [] };
    }
    const input = block.input as { reply?: unknown; actions?: unknown };
    return { reply: typeof input.reply === 'string' ? input.reply.slice(0, 600) : '', actions: Array.isArray(input.actions) ? input.actions : [] };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- orchestration */

let seq = 0;

export function buildProposal(act: Extract<AssistantAction, { action: 'propose_rule_edit' | 'propose_content_edit' }>, ctx: AssistantContext, provenance: string): Proposal | { error: string } {
  const id = `prop-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  if (act.action === 'propose_rule_edit') {
    const rule = ctx.project.rules.find((r) => r.id === act.ruleId)!;
    const after: Rule = { ...rule, ...(act.patch.priority !== undefined ? { priority: act.patch.priority } : {}), ...(act.patch.enabled !== undefined ? { enabled: act.patch.enabled } : {}), ...(act.patch.when ? { when: act.patch.when } : {}) };
    if (rule.mode === 'obligation' && after.enabled === false) return { error: `${rule.id} enforces mandatory content and cannot be disabled — not even by an assistant suggestion.` };
    const validations = validateRule(after, ctx.project);
    if (validations.length) return { error: 'Proposed rule is invalid: ' + validations.join(' ') };
    const afterProject: Project = { ...ctx.project, rules: ctx.project.rules.map((r) => (r.id === rule.id ? after : r)) };
    const pvs = ctx.project.nodes.find((n) => n.type === 'variant-set')?.id;
    const recs = ctx.records.filter((r) => r.documentType === ctx.project.documentType);
    const sample: Proposal['impact']['sample'] = [];
    let changed = 0;
    for (const r of recs) {
      const b = resolve({ project: ctx.project, record: r });
      const a = resolve({ project: afterProject, record: r });
      const bv = pvs ? b.result.selectedVariants[pvs] : null, av = pvs ? a.result.selectedVariants[pvs] : null;
      if (bv !== av || b.result.diagnostics.length !== a.result.diagnostics.length) { changed++; if (sample.length < 6) sample.push({ recordId: r.recordId, before: bv, after: av }); }
    }
    return { proposalId: id, kind: 'rule', status: 'approval_required', mutationApplied: false, targetId: rule.id, before: { priority: rule.priority, enabled: rule.enabled !== false, when: describePredicate(rule.when) }, after: { priority: after.priority, enabled: after.enabled !== false, when: describePredicate(after.when) }, validations: ['Schema and type validation passed', 'Mandatory obligations unaffected'], impact: { evaluated: recs.length, changed, sample }, command: { type: 'UPSERT_RULE', rule: after }, provenance, baseModelVersion: ctx.project.modelVersion };
  }
  const part = ctx.project.contentParts.find((c) => c.id === act.contentPartId)!;
  const protectedPart = part.type === 'disclosure' || ctx.project.nodes.some((n) => n.type === 'disclosure' && n.contentPartId === part.id);
  if (protectedPart) return { error: `${part.id} is approved disclosure text; the assistant cannot propose edits to mandatory disclosures.` };
  if (/<\s*\/?\s*[a-z]/i.test(act.text)) return { error: 'Raw HTML is not allowed in content.' };
  const afterPart = { ...part, approvedLocales: { ...part.approvedLocales, [act.locale]: act.text } };
  return { proposalId: id, kind: 'content', status: 'approval_required', mutationApplied: false, targetId: part.id, before: part.approvedLocales[act.locale] ?? null, after: act.text, validations: ['Sanitized: no markup', act.locale !== 'en-US' ? 'Translation must be reviewed by an approver — not machine-authorised legal text' : 'Wording change'], impact: { evaluated: 0, changed: 0, sample: [] }, command: { type: 'UPSERT_CONTENT_PART', part: afterPart }, provenance, baseModelVersion: ctx.project.modelVersion };
}

export async function handleMessage(message: string, ctx: AssistantContext, cfg: ProviderConfig): Promise<AssistantReply> {
  const requestId = `ai-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  const record = ctx.records.find((r) => r.recordId === ctx.recordId)!;
  const res = resolve({ project: ctx.project, record, overrides: ctx.overrides, journeyCursor: ctx.journeyCursor });
  const status = providerStatus(cfg);
  let mode: 'external' | 'offline' = 'offline';
  let providerNote = status.label;
  let interpreted: { reply: string; actions: unknown[] } | null = null;
  if (status.mode === 'external') {
    interpreted = await externalInterpret(cfg, message, ctx, res);
    if (interpreted) mode = 'external';
    else providerNote = 'Live provider unavailable — Guided Assistant (offline) fallback';
  }
  if (!interpreted) interpreted = offlineInterpret(message, ctx);
  const { ok, rejected } = validateActions(interpreted.actions, ctx);
  const reply: AssistantReply = { mode, providerStatus: providerNote, requestId, response: interpreted.reply, actions: ok.filter((a) => a.action !== 'propose_rule_edit' && a.action !== 'propose_content_edit'), rejected };

  // Scenario preview: resolved by the deterministic engine (non-mutating).
  let previewOverrides: Record<string, unknown> | null = null;
  let previewRecord = ctx.recordId;
  for (const a of ok) {
    if (a.action === 'select_scenario') { previewRecord = a.recordId; previewOverrides = a.overrides ?? {}; }
    if (a.action === 'set_scenario_fields') previewOverrides = mergeDeep(previewOverrides ?? ctx.overrides, fieldsToOverrides(a.fields));
  }
  if (previewOverrides && ctx.records.find((r) => r.recordId === previewRecord)?.documentType === ctx.project.documentType) {
    const pr = resolve({ project: ctx.project, record: ctx.records.find((r) => r.recordId === previewRecord)!, overrides: previewOverrides });
    reply.scenarioPreview = { recordId: previewRecord, overrides: previewOverrides, runId: pr.runId, selectedVariants: pr.result.selectedVariants, matchedRuleIds: pr.result.matchedRuleIds };
  }
  const explain = ok.find((a) => a.action === 'explain_resolution') as Extract<AssistantAction, { action: 'explain_resolution' }> | undefined;
  if (explain) {
    const target = reply.scenarioPreview ? resolve({ project: ctx.project, record: ctx.records.find((r) => r.recordId === reply.scenarioPreview!.recordId)!, overrides: reply.scenarioPreview.overrides }) : res;
    reply.explanation = explainNode(target, explain.nodeId);
  }
  const prop = ok.find((a) => a.action === 'propose_rule_edit' || a.action === 'propose_content_edit') as Extract<AssistantAction, { action: 'propose_rule_edit' | 'propose_content_edit' }> | undefined;
  if (prop) {
    const p = buildProposal(prop, ctx, mode === 'external' ? 'Assistant suggestion (live AI); evaluated by deterministic engine; awaiting user approval.' : 'Assistant suggestion (offline scripted); evaluated by deterministic engine; awaiting user approval.');
    if ('error' in p) reply.rejected.push({ action: prop, reason: p.error });
    else reply.proposal = p;
  }
  return reply;
}
