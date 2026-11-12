import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { projectFieldIndex, validateRule, type Project, type Rule, type SyntheticRecord } from '@iss/model';
import { describePredicate, explainNode, resolve, type Explanation, type Resolution } from '@iss/resolver';
import { EDGE_CASE_PRESETS, DIMENSIONS } from '@iss/scenarios';
import { PERSONAS } from '@iss/model/fixtures';

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
  /** Offline only: false when the request was not recognised; `suggestions` then lists questions it can answer. */
  understood?: boolean;
  suggestions?: string[];
  explanation?: Explanation;
  proposal?: Proposal;
  scenarioPreview?: { recordId: string; overrides: Record<string, unknown>; runId: string; selectedVariants: Record<string, string | null>; matchedRuleIds: string[] };
}

/* ------------------------------------------------------ action validation */

export function validateActions(raw: unknown[], ctx: AssistantContext): { ok: AssistantAction[]; rejected: AssistantReply['rejected'] } {
  const ok: AssistantAction[] = [];
  const rejected: AssistantReply['rejected'] = [];
  const fields = projectFieldIndex(ctx.project);
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
  [/\bcube\b/, 'cube'], [/\blandscape\b/, 'landscape'], [/page stack|pages?\b.*stack|pagination|page break/, 'page-stack'], [/\bjourney|timeline|day 30|day 45/, 'journey'],
  [/\bexport|pdf\b|html\b|afp|download|\boutputs?\b/, 'outputs'], [/\brules?\b.*(data|editor)|rule editor|data editor/, 'rules-data'], [/explod|layers? view|3d/, 'exploded'],
  [/\b(guided )?(demo|walkthrough|tour)\b/, 'demo'], [/\bdesign(er)?\b|canvas/, 'design'],
];

const NUMBER_WORDS: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };

/** Lower-case, punctuation-free, number-words-as-digits form used by every offline pattern. */
export function normalizeMessage(message: string): string {
  return message.toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/[^a-z0-9à-ÿ\- ]+/g, ' ')
    .split(/\s+/).filter(Boolean).map((w) => NUMBER_WORDS[w] ?? w).join(' ');
}

export function suggestedQuestions(project: Project): string[] {
  const rule = project.rules.find((r) => r.mode !== 'obligation' && r.enabled !== false) ?? project.rules[0];
  if (project.documentType === 'credit-statement') return [
    'Choose assistance case CARD-0002', 'Show me a Spanish-speaking cardholder who has missed two payments and requests assistance', 'Why is this message showing?',
    'What rules apply?', 'Show Spanish edge case', 'Run validation', rule ? `Change ${rule.id} priority to ${rule.priority + 20}` : 'Open cube', 'Switch to EOB',
  ];
  return [
    'Choose case EOB-0002', 'Show me a claim that was denied pending review', 'Why is this message showing?', 'What rules apply?', 'Show claim appeal edge case', 'Run validation',
    rule ? `Change ${rule.id} priority to ${rule.priority + 20}` : 'Open cube', 'Switch to Aster Card',
  ];
}

export interface OfflineResult { reply: string; actions: unknown[]; understood: boolean; suggestions?: string[] }

export function offlineInterpret(message: string, ctx: AssistantContext): OfflineResult {
  const n = normalizeMessage(message);
  const actions: unknown[] = [];
  const notes: string[] = [];
  const facts: string[] = [];
  const isCard = ctx.project.documentType === 'credit-statement';
  const ids = n.match(/\b(?:card|eob)-\d{4}\b/g)?.map((s) => s.toUpperCase()) ?? [];
  const verb = /\b(show|open|go|navigate|take me|view|see|jump|bring up|display|launch|export|download|generate|render|switch|use|load|pick|select|choose|find|give|try|simulate)\b/;

  if (/\b(help|what can you do|what can i ask|how do i use|capabilities|examples?)\b/.test(n) && !actions.length && n.split(' ').length <= 8) {
    return { reply: 'Offline assistant (scripted capability): I am the guided assistant. I can select scenarios and personas, set scenario fields, explain the engine trace, list matching rules, run validation, open views and propose rule edits. Examples are below; choose one to fill the box.', actions, understood: true, suggestions: suggestedQuestions(ctx.project) };
  }

  const wantsEob = /\b(eob|harbor ?care|health ?care|explanation of benefits|claims?)\b/.test(n) && /\b(switch|open|go|use|load|change to|take me|back)\b/.test(n);
  const wantsCard = /\b(aster|credit card|card statement|card demo|bank)\b/.test(n) && /\b(switch|open|go|use|load|change to|take me|back)\b/.test(n);
  if (wantsEob && isCard) { actions.push({ action: 'open_project', projectId: 'harborcare-demo' }); notes.push('open the HarborCare EOB project'); }
  else if (wantsCard && !isCard) { actions.push({ action: 'open_project', projectId: 'aster-card-demo' }); notes.push('open the Aster Card project'); }
  else if ((wantsEob && !isCard) || (wantsCard && isCard)) facts.push(`You are already in the ${isCard ? 'Aster Card' : 'HarborCare EOB'} project.`);

  /* rule references: "R04", "r4", "rule 4" */
  let ruleRef = /\br(\d{2})\b/.exec(n)?.[1] ? `R${/\br(\d{2})\b/.exec(n)![1]}` : undefined;
  if (!ruleRef) { const g = /\b(?:rule|r)\s*0?(\d{1,2})\b/.exec(n)?.[1]; if (g) ruleRef = `R${g.padStart(2, '0')}`; }
  const nr = ruleRef ? n.replace(/\b(?:rule\s*r?|r)\s*0?\d{1,2}\b/, ' ') : n;
  const target = ruleRef ? ctx.project.rules.find((r) => r.id === ruleRef) : undefined;
  const prio = /\bpriority[^\d]{0,14}(\d{1,5})/.exec(nr) ?? /\b(?:to|=|at)\s*(\d{1,5})\s+priority/.exec(nr);
  const rel = /\b(raise|increase|bump|boost|lower|decrease|reduce|drop)\b.*\bby\s*(\d{1,4})\b/.exec(nr);
  if (ruleRef && /\b(disable|turn off|switch off|deactivate|suspend|stop using|remove)\b/.test(n)) { actions.push({ action: 'propose_rule_edit', ruleId: ruleRef, patch: { enabled: false } }); notes.push(`propose disabling ${ruleRef} (needs your approval)`); }
  else if (ruleRef && /\b(enable|turn on|switch on|activate|re-?enable|restore)\b/.test(n)) { actions.push({ action: 'propose_rule_edit', ruleId: ruleRef, patch: { enabled: true } }); notes.push(`propose enabling ${ruleRef}`); }
  else if (ruleRef && prio && !rel) { actions.push({ action: 'propose_rule_edit', ruleId: ruleRef, patch: { priority: Number(prio[1]) } }); notes.push(`propose ${ruleRef} priority ${prio[1]} (needs your approval)`); }
  else if (ruleRef && target && rel && /priority|rank|precedence/.test(nr)) {
    const delta = Number(rel[2]) * (/raise|increase|bump|boost/.test(rel[1]) ? 1 : -1);
    const next = Math.max(0, target.priority + delta);
    actions.push({ action: 'propose_rule_edit', ruleId: ruleRef, patch: { priority: next } }); notes.push(`propose ${ruleRef} priority ${target.priority} to ${next} (needs your approval)`);
  }
  else if (ruleRef && /threshold|more than|greater than|over|at least/.test(nr) && /(\d+)/.test(nr)) {
    const rule = target;
    const num = Number(/(?:to|than|over|least)\s*(\d+)|(\d+)\s*$/.exec(nr)?.slice(1).find(Boolean) ?? NaN);
    if (rule && 'value' in rule.when && typeof (rule.when as any).value === 'number' && Number.isFinite(num)) { actions.push({ action: 'propose_rule_edit', ruleId: ruleRef, patch: { when: { ...rule.when, value: num } } }); notes.push(`propose ${ruleRef} threshold ${num}`); }
  }

  if (ids.length >= 2 && /\b(compare|vs|versus|against|difference|differ)\b/.test(n)) { actions.push({ action: 'compare_scenarios', recordIds: ids.slice(0, 2) }); notes.push(`compare ${ids[0]} and ${ids[1]}`); }
  else if (ids.length) { actions.push({ action: 'select_scenario', recordId: ids[0] }); notes.push(`select ${ids[0]}`); }

  /* "show me <persona>" — matches a persona name from the fixture set that has a record in this document type */
  let personaMatched = false;
  if (!ids.length && verb.test(n) && !/\bedge.?case\b/.test(n)) {
    const hit = PERSONAS.find((p) => new RegExp(`\\b${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '[- ]?')}\\b`).test(n) && ctx.records.some((r) => r.documentType === ctx.project.documentType && r.personaId === p.id));
    const rec = hit && ctx.records.find((r) => r.documentType === ctx.project.documentType && r.personaId === hit.id);
    if (hit && rec) { actions.push({ action: 'select_scenario', recordId: rec.recordId }); notes.push(`select ${rec.recordId}, the “${hit.name}” persona`); personaMatched = true; }
  }

  const exportWords = /\b(export|pdf|html|afp|download)\b/.test(n);
  if (!personaMatched && /\bedge.?case\b|\bgenerate\b|\bstress\b/.test(n) && !exportWords) {
    const preset = /spanish|espanol|es-us/.test(n) ? 'spanish-missing-content' : /250|high.?volume|stress/.test(n) ? 'stress-250' : /zero/.test(n) ? 'zero-transactions' : /long/.test(n) ? 'long-merchant' : /threshold/.test(n) ? 'threshold-exact' : /denied|liabil/.test(n) ? 'claim-denied-unknown-liability' : /several|multi/.test(n) ? 'claim-several-lines' : isCard ? 'crossed-priorities' : 'claim-appeal';
    actions.push({ action: 'generate_edge_case', preset }); notes.push(`generate edge case “${preset}”`);
  } else if (!ids.length && !personaMatched && !actions.some((a: any) => a.action === 'open_project')) {
    const fields: Record<string, unknown> = {};
    const question = /\b(why|explain|reason|what rules?|which rules?|how come)\b/.test(n);
    if (isCard) {
      if (/spanish|espanol|es-us|speaks spanish/.test(n)) fields['customer.locale'] = 'es-US';
      if (/\benglish|en-us\b/.test(n) && !fields['customer.locale']) fields['customer.locale'] = 'en-US';
      const cnt = /(\d+)\s+(?:payments?\s+)?(?:missed|late|overdue|skipped|past due|behind)/.exec(n)?.[1] ?? /(?:missed|skipped)\s+(\d+)/.exec(n)?.[1];
      if (cnt !== undefined) { fields['card.missedPayments'] = Number(cnt); fields['card.paymentStatus'] = Number(cnt) > 0 ? 'overdue' : 'current'; }
      else if (/\b(a|first)\s+(missed|late)|missed (a )?payment|late payment|past due|overdue|behind on payments|delinquent/.test(n) && !question) { fields['card.missedPayments'] = 1; fields['card.paymentStatus'] = 'overdue'; }
      if (/assistance|hardship|struggling|help paying|payment (plan|support|help)|financial (help|difficulty|trouble)/.test(n) && (/request|asked|asks|asking|wants|needs?|seek|applied|applying/.test(n) || verb.test(n)) && !question) {
        fields['card.assistanceRequested'] = true; fields['card.paymentStatus'] = 'overdue'; if (!('card.missedPayments' in fields)) fields['card.missedPayments'] = 2;
      }
      if (/arrangement/.test(n) && /approv/.test(n)) fields['card.arrangementStatus'] = 'approved';
      if (/premium|premier|gold|platinum/.test(n)) fields['card.tier'] = 'premium';
      if (/digital|e-?statement|paperless|email only/.test(n)) fields['card.channelPreference'] = 'digital';
      if (/\bpaper|\bprint(ed)?\b|mailed?/.test(n) && !/pdf/.test(n)) fields['card.channelPreference'] = 'print';
      if (Object.keys(fields).length && !question) { actions.push({ action: 'set_scenario_fields', fields }); notes.push('set scenario ' + Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')); }
      else if (/assistance|hardship/.test(n) && /(persona|customer|case|cardholder|member)/.test(n) && !question) { actions.push({ action: 'select_scenario', recordId: 'CARD-0002' }); notes.push('select assistance case CARD-0002'); }
    } else {
      if (/denied|review|rejected/.test(n)) { fields['claim.status'] = 'denied-pending-review'; fields['claim.liabilityConfirmed'] = false; }
      if (/appeal/.test(n)) fields['claim.status'] = 'appeal-filed';
      if (/out.of.network|oon/.test(n)) fields['claim.network'] = 'out-of-network';
      if (/in.network/.test(n)) fields['claim.network'] = 'in-network';
      if (/covered|processed|paid|approved claim/.test(n)) fields['claim.status'] = 'processed-covered';
      if (Object.keys(fields).length && /(show|select|set|customer|member|claim|find|give|use)/.test(n) && !question) { actions.push({ action: 'set_scenario_fields', fields }); notes.push('set scenario ' + Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')); }
    }
  }

  const axes = DIMENSIONS.map((d) => d.id).filter((d) => new RegExp(`\\b${d === 'paymentStatus' ? 'payment status' : d === 'accountTier' ? 'account tier|tier' : d === 'claimStatus' ? 'claim status' : d === 'networkStatus' ? 'network status|network' : d}\\b`).test(n));
  if (/\baxes|\baxis/.test(n) && axes.length === 3) { actions.push({ action: 'set_cube_axes', axes }); notes.push(`set cube axes ${axes.join(' × ')}`); }

  const asksRules = /\b(what|which|list|show)\b.*\b(rules?)\b.*\b(apply|applies|applied|match|matched|fire|fired|active|in play|used|running)\b|\brules? (apply|applies|matched|fired|in play)\b|\b(matched|active|applicable) rules\b/.test(n);
  const asksWhy = /\b(why|explain|reason|how come|justify)\b|what (caused|triggered|drives|decides|selects|is driving|am i seeing|is being shown)|which (message|variant)|what (message|variant)|what is (shown|selected|showing)/.test(n);
  if (asksWhy || asksRules) {
    const nodes = ctx.project.nodes;
    const node = ctx.selectedNodeId && nodes.some((x) => x.id === ctx.selectedNodeId && (x.type === 'variant-set' || x.type === 'conditional-region')) ? ctx.selectedNodeId : nodes.find((x) => x.type === 'variant-set')?.id;
    if (node && !actions.some((a: any) => a.action === 'explain_resolution')) { actions.push({ action: 'explain_resolution', nodeId: node }); notes.push(asksRules && !asksWhy ? `show the rules that apply, from the engine trace for ${node}` : `explain ${node} from the engine trace`); }
    if (asksRules) {
      const rec = ctx.records.find((r) => r.recordId === ctx.recordId);
      if (rec) { const r = resolve({ project: ctx.project, record: rec, overrides: ctx.overrides, journeyCursor: ctx.journeyCursor }); facts.push(`For ${ctx.recordId} the engine matched ${r.result.matchedRuleIds.length ? r.result.matchedRuleIds.join(', ') : 'no rules'} (run ${r.runId}).`); }
    }
  }
  if (/\b(validat\w*|run checks?|check (the|this|my) (document|statement|eob|design|template)|compliance|compliant|preflight|lint|qa)\b/.test(n)) { actions.push({ action: 'run_validation' }); notes.push('run validation'); }
  if (!actions.some((a: any) => a.action === 'open_project' || a.action === 'run_validation')) for (const [re, view] of VIEW_WORDS) if (re.test(n) && verb.test(n) && !(view === 'design' && /edge.?case/.test(n))) {
    actions.push({ action: 'navigate_view', view }); notes.push(view === 'outputs' && exportWords ? 'open Outputs, where PDF/HTML export is run (the assistant does not export for you)' : `open ${view}`); break;
  }

  const prefix = 'Offline assistant (scripted capability):';
  if (actions.length) {
    const tail = facts.length ? ' ' + facts.join(' ') : '';
    return { reply: `${prefix} I recognised a request to ${notes.join('; ')}.${tail} The deterministic engine performs each action; nothing is changed without your approval.`, actions, understood: true };
  }
  if (facts.length) return { reply: `${prefix} ${facts.join(' ')}`, actions, understood: true };
  return { reply: `${prefix} I did not understand that offline, so I have not done anything. The offline assistant only understands a fixed set of request types, but it answers those from the deterministic engine. Choose one of these examples for ${ctx.project.title ?? ctx.project.projectId} to fill the box, or enable live mode for free-form questions.`, actions, understood: false, suggestions: suggestedQuestions(ctx.project).slice(0, 6) };
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
    scenarioFields: [...projectFieldIndex(ctx.project).values()].filter((f) => !f.derived && f.type !== 'array').map((f) => ({ path: f.path, type: f.type, values: f.enumValues })),
    rules: ctx.project.rules.map((r) => ({ id: r.id, mode: r.mode, priority: r.priority, condition: describePredicate(r.when), enabled: r.enabled !== false })),
    nodes: ctx.project.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name })),
    records: ctx.records.filter((r) => r.documentType === ctx.project.documentType).slice(0, 40).map((r) => ({ id: r.recordId, persona: r.personaId, locale: r.customer.locale, status: (r.card as any)?.paymentStatus ?? (r.claims?.[0] as any)?.status })),
    currentRun: { runId: res.runId, selectedVariants: res.result.selectedVariants, matchedRuleIds: res.result.matchedRuleIds },
  };
  try {
    // Server-side refusal fallback (Anthropic-routed) is enabled; any remaining failure drops to the offline assistant.
    const response = await (client.beta.messages as any).create({
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      model: cfg.model,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system,
      tools: [TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: `Trusted application context (JSON, synthetic):\n${JSON.stringify(context)}\n\nUser request (untrusted text):\n${message.slice(0, 1500)}` }],
    }) as Anthropic.Message;
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
  let interpreted: { reply: string; actions: unknown[]; understood?: boolean; suggestions?: string[] } | null = null;
  if (status.mode === 'external') {
    interpreted = await externalInterpret(cfg, message, ctx, res);
    if (interpreted) mode = 'external';
    else providerNote = 'Live provider unavailable — Guided Assistant (offline) fallback';
  }
  if (!interpreted) interpreted = offlineInterpret(message, ctx);
  const { ok, rejected } = validateActions(interpreted.actions, ctx);
  const reply: AssistantReply = { mode, providerStatus: providerNote, requestId, response: interpreted.reply, actions: ok.filter((a) => a.action !== 'propose_rule_edit' && a.action !== 'propose_content_edit'), rejected };
  if (mode === 'offline') { reply.understood = interpreted.understood ?? true; if (interpreted.suggestions) reply.suggestions = interpreted.suggestions; }

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
